/**
 * ShopNG secure backend.
 * - createOrder: prices/stock/totals are computed HERE from Firestore, never trusted from the browser.
 * - verifyPayment + paystackWebhook: payment is confirmed with Paystack's API using the SECRET key
 *   (stored as a Firebase secret) and the amount is checked against the server-computed total.
 */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const PAYSTACK_SECRET = defineSecret("PAYSTACK_SECRET");
const REGION = "us-central1"; // keep in sync with functionsRegion in firebase-config.js
const base = { region: REGION, maxInstances: 20 };

const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const feeFor = (subtotal) => ({
  delivery: subtotal > 50000 ? 0 : 2500,
  discount: subtotal > 100000 ? Math.round(subtotal * 0.05) : 0,
});

exports.createOrder = onCall({ ...base, enforceAppCheck: false }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in to place an order.");
  const d = req.data || {};
  const items = Array.isArray(d.items) ? d.items.slice(0, 30) : [];
  if (!items.length) throw new HttpsError("invalid-argument", "Your cart is empty.");
  const method = ["card", "transfer", "cod"].includes(d.paymentMethod) ? d.paymentMethod : null;
  if (!method) throw new HttpsError("invalid-argument", "Invalid payment method.");
  const name = clean(d.name, 80), phone = clean(d.phone, 20), email = clean(d.email, 120);
  if (name.length < 2) throw new HttpsError("invalid-argument", "Enter your full name.");
  if (!/^[+\d][\d\s\-()]{6,19}$/.test(phone)) throw new HttpsError("invalid-argument", "Enter a valid phone number.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError("invalid-argument", "Enter a valid email.");
  const address = { type: clean(d.address && d.address.type, 20) || "Home", text: clean(d.address && d.address.text, 300) };
  if (address.text.length < 5) throw new HttpsError("invalid-argument", "Choose a delivery address.");

  // merge duplicates, validate quantities
  const wanted = new Map();
  for (const it of items) {
    const id = Number(it.id), qty = Math.floor(Number(it.qty));
    if (!Number.isSafeInteger(id) || id <= 0 || !(qty >= 1 && qty <= 20)) throw new HttpsError("invalid-argument", "Invalid cart item.");
    const key = id + "|" + clean(it.color, 12) + "|" + clean(it.size, 12);
    const cur = wanted.get(key) || { id, qty: 0, color: clean(it.color, 12) || null, size: clean(it.size, 12) || null };
    cur.qty += qty; wanted.set(key, cur);
  }
  const lines = [...wanted.values()];
  const refs = [...new Set(lines.map(l => l.id))].map(id => db.collection("products").doc(String(id)));
  const snaps = await db.getAll(...refs);
  const prod = new Map(); snaps.forEach(s => { if (s.exists) prod.set(Number(s.id), s.data()); });

  let subtotal = 0; const out = [];
  for (const l of lines) {
    const p = prod.get(l.id);
    if (!p || p.active === false) throw new HttpsError("failed-precondition", "An item in your cart is no longer available.");
    const totalQty = lines.filter(x => x.id === l.id).reduce((a, x) => a + x.qty, 0);
    if (Number(p.stock) < totalQty) throw new HttpsError("failed-precondition", `Only ${Math.max(0, Number(p.stock))} left of ${p.name}.`);
    const price = Math.round(Number(p.price));
    if (!(price > 0)) throw new HttpsError("failed-precondition", "Invalid product price.");
    subtotal += price * l.qty;
    out.push({ id: l.id, name: String(p.name), price, image: String(p.image || ""), qty: l.qty, color: l.color, size: l.size });
  }
  const { delivery, discount } = feeFor(subtotal);
  const total = subtotal + delivery - discount;

  let orderId, ref;
  for (let i = 0; i < 5; i++) {
    orderId = "ORD-" + String(crypto.randomInt(10000000, 99999999));
    ref = db.collection("orders").doc(orderId);
    if (!(await ref.get()).exists) break;
  }
  const isCod = method === "cod";
  const reference = orderId + "-" + crypto.randomBytes(4).toString("hex");
  const order = {
    uid: req.auth.uid, items: out, subtotal, delivery, discount, total, amountKobo: total * 100,
    address, paymentMethod: method, customerName: name, customerPhone: phone, customerEmail: email,
    status: isCod ? "Processing" : "Pending Payment",
    paymentStatus: isCod ? "Pay on Delivery" : "Unpaid",
    paystackRef: isCod ? null : reference,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await ref.create(order);
  if (isCod) await decrementStock(out);
  await db.collection("users").doc(req.auth.uid).set({ name, phone, lastOrderAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { orderId, reference, amountKobo: total * 100, total, email, cod: isCod };
});

async function decrementStock(items) {
  const batch = db.batch();
  const agg = {}; items.forEach(i => { agg[i.id] = (agg[i.id] || 0) + i.qty; });
  Object.entries(agg).forEach(([id, q]) => batch.update(db.collection("products").doc(id), { stock: admin.firestore.FieldValue.increment(-q) }));
  await batch.commit().catch(() => {});
}

async function finalizePaid(orderId, tx) {
  const ref = db.collection("orders").doc(orderId);
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) throw new HttpsError("not-found", "Order not found.");
    const o = s.data();
    if (o.paymentStatus === "Paid") return;
    const ids = [...new Set(o.items.map(i => i.id))];
    const psnaps = await Promise.all(ids.map(id => t.get(db.collection("products").doc(String(id)))));
    let stockIssue = false;
    psnaps.forEach(ps => {
      if (!ps.exists) return;
      const q = o.items.filter(i => String(i.id) === ps.id).reduce((a, i) => a + i.qty, 0);
      const left = Number(ps.data().stock) - q;
      if (left < 0) stockIssue = true;
      t.update(ps.ref, { stock: Math.max(0, left) });
    });
    t.update(ref, {
      paymentStatus: "Paid", status: "Processing", stockIssue,
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      paystackTransactionId: String(tx.id), paymentChannel: String(tx.channel || ""),
    });
  });
}

async function paystackVerify(reference, secret) {
  const r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), {
    headers: { Authorization: "Bearer " + secret },
  });
  const j = await r.json().catch(() => ({}));
  return j && j.status ? j.data : null;
}

exports.verifyPayment = onCall({ ...base, secrets: [PAYSTACK_SECRET] }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  const orderId = clean(req.data && req.data.orderId, 30);
  const snap = await db.collection("orders").doc(orderId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
  const o = snap.data();
  if (o.uid !== req.auth.uid) throw new HttpsError("permission-denied", "Not your order.");
  if (o.paymentStatus === "Paid") return { paid: true };
  const tx = await paystackVerify(o.paystackRef, PAYSTACK_SECRET.value());
  if (tx && tx.status === "success" && tx.amount === o.amountKobo && tx.currency === "NGN" && tx.reference === o.paystackRef) {
    await finalizePaid(orderId, tx);
    return { paid: true };
  }
  return { paid: false, message: tx && tx.gateway_response ? String(tx.gateway_response) : "Payment not confirmed yet." };
});

// Set this URL as the webhook in your Paystack dashboard (Settings → API Keys & Webhooks)
exports.paystackWebhook = onRequest({ ...base, secrets: [PAYSTACK_SECRET], cors: false }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).send("no");
    const sig = String(req.headers["x-paystack-signature"] || "");
    const mac = crypto.createHmac("sha512", PAYSTACK_SECRET.value()).update(req.rawBody).digest("hex");
    const a = Buffer.from(mac), b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send("bad signature");
    const ev = req.body || {};
    if (ev.event === "charge.success" && ev.data && ev.data.reference) {
      const q = await db.collection("orders").where("paystackRef", "==", String(ev.data.reference)).limit(1).get();
      if (!q.empty) {
        const o = q.docs[0].data();
        const tx = await paystackVerify(ev.data.reference, PAYSTACK_SECRET.value());
        if (tx && tx.status === "success" && tx.amount === o.amountKobo && tx.currency === "NGN") await finalizePaid(q.docs[0].id, tx);
      }
    }
    return res.status(200).send("ok");
  } catch (e) { console.error(e); return res.status(500).send("error"); }
});
