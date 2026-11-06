import { enabled, CFG, auth, db, storage } from "./fb-core.js";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, GoogleAuthProvider, signInWithPopup, sendEmailVerification, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const naira = n => "₦" + Math.round(Number(n) || 0).toLocaleString("en-NG");
const STATUSES = ["Processing", "Shipped", "Out for Delivery", "Delivered", "Cancelled"];
const S = { tab: "overview", products: [], categories: [], orders: [], users: [], pq: "", pcat: "all", ofilter: "all", cq: "", unsubs: [] };
const toDate = v => v && v.toDate ? v.toDate() : (v ? new Date(v) : null);
const fmt = d => d ? d.toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
const toast = (m, t = "ok") => { const e = document.createElement("div"); e.className = "toast " + t; e.textContent = m; $("#toasts").appendChild(e); setTimeout(() => e.remove(), 3800); };
const isAdminUser = u => u && u.emailVerified && u.email && u.email.toLowerCase() === String(CFG.adminEmail).toLowerCase();

/* ---------- gate ---------- */
function gate(html) { $("#app").hidden = true; $("#gate").hidden = false; $("#gate").innerHTML = `<div class="gate-box">${html}</div>`; }
function showSetup() { gate(`<h1>Setup needed</h1><p>Fill in <b>firebase-config.js</b> with your Firebase project settings, then reload. See SETUP.md.</p>`); }
function showLogin(err = "") {
  gate(`<h1><i class="fas fa-gem"></i> Admin sign in</h1><p>Authorised administrators only.</p>
  <label>Email</label><input id="lE" type="email" autocomplete="username"><label>Password</label><input id="lP" type="password" autocomplete="current-password">
  <p class="sm" style="color:var(--bad);min-height:18px;margin:10px 0">${esc(err)}</p>
  <button class="btn w" data-act="login">Sign in</button>
  <button class="btn ghost w" style="margin-top:10px" data-act="google"><i class="fab fa-google"></i> Continue with Google</button>
  <p class="sm mut" style="margin-top:14px;text-align:center"><a href="#" data-act="reset" style="color:var(--p2)">Forgot password?</a></p>`);
}
function showDenied(u) {
  gate(`<h1>No admin access</h1><p>${esc(u.email)} ${u.emailVerified ? "is not the admin account." : "is not verified yet. Check your inbox for the verification email, then sign in again."}</p>
  ${u.emailVerified ? "" : `<button class="btn w" data-act="resend">Resend verification email</button>`}
  <button class="btn ghost w" style="margin-top:10px" data-act="signout">Sign out</button>`);
}

/* ---------- data ---------- */
function startData() {
  stopData();
  const sub = (name, key, mapper) => S.unsubs.push(onSnapshot(collection(db, name), s => { S[key] = s.docs.map(d => mapper ? mapper(d) : d.data()); render(); }, e => toast("Cannot read " + name + ": " + e.code, "err")));
  sub("products", "products"); sub("categories", "categories");
  sub("orders", "orders", d => ({ ...d.data(), id: d.id }));
  sub("users", "users", d => ({ ...d.data(), uid: d.id }));
}
function stopData() { S.unsubs.forEach(f => f()); S.unsubs = []; }

/* ---------- views ---------- */
const orderStatusBadge = s => `<span class="badge ${s === "Delivered" ? "ok" : s === "Cancelled" ? "bad" : s === "Pending Payment" ? "warn" : ""}">${esc(s)}</span>`;
const payBadge = s => `<span class="badge ${s === "Paid" ? "ok" : s === "Unpaid" ? "warn" : ""}">${esc(s)}</span>`;
const realOrders = () => S.orders.filter(o => o.status !== "Pending Payment").sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0));

function vOverview() {
  const paid = S.orders.filter(o => o.paymentStatus === "Paid");
  const rev = paid.reduce((a, o) => a + (o.total || 0), 0);
  const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i)); return d; });
  const sums = days.map(d => paid.filter(o => { const x = toDate(o.paidAt || o.createdAt); return x && x >= d && x < new Date(d.getTime() + 864e5); }).reduce((a, o) => a + o.total, 0));
  const max = Math.max(...sums, 1);
  const low = S.products.filter(p => Number(p.stock) <= 5);
  const recent = realOrders().slice(0, 5);
  return `<div class="grid g4"><div class="stat"><small>Revenue (paid)</small><b>${naira(rev)}</b></div><div class="stat"><small>Orders</small><b>${realOrders().length}</b></div><div class="stat"><small>Customers</small><b>${S.users.length}</b></div><div class="stat"><small>Products</small><b>${S.products.length}</b></div></div>
  <h2>Last 7 days</h2><div class="card bars">${sums.map((v, i) => `<div><i style="height:${Math.max(4, (v / max) * 80)}px" title="${naira(v)}"></i>${days[i].toLocaleDateString("en-NG", { weekday: "short" })}</div>`).join("")}</div>
  <h2>Low stock (${low.length})</h2>${low.length ? low.map(p => `<div class="row"><img src="${esc(p.image)}" alt=""><div class="info"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.category)}</div></div><span class="badge bad">${Number(p.stock)} left</span></div>`).join("") : `<div class="card empty">All products are well stocked.</div>`}
  <h2>Recent orders</h2>${recent.length ? recent.map(orderRow).join("") : `<div class="card empty">No orders yet.</div>`}`;
}
const orderRow = o => `<div class="row"><div class="info"><div class="t">${esc(o.id)} · ${esc(o.customerName)}</div><div class="s">${fmt(toDate(o.createdAt))}</div></div><div style="text-align:right"><div class="price">${naira(o.total)}</div>${payBadge(o.paymentStatus)} ${orderStatusBadge(o.status)}</div></div>`;

function vProducts() {
  const cats = S.categories.map(c => c.name);
  const list = S.products.filter(p => (S.pcat === "all" || p.category === S.pcat) && (!S.pq || (p.name + " " + p.brand).toLowerCase().includes(S.pq.toLowerCase()))).sort((a, b) => (b.createdAt?.seconds || b.id) - (a.createdAt?.seconds || a.id));
  return `<div class="bar"><input id="pq" placeholder="Search products…" value="${esc(S.pq)}" style="flex:1;min-width:160px"><button class="btn" data-act="addp"><i class="fas fa-plus"></i> Add product</button></div>
  <div class="chips"><button data-pcat="all" class="${S.pcat === "all" ? "on" : ""}">All (${S.products.length})</button>${cats.map(c => `<button data-pcat="${esc(c)}" class="${S.pcat === c ? "on" : ""}">${esc(c)} (${S.products.filter(p => p.category === c).length})</button>`).join("")}</div>
  ${S.products.length === 0 ? `<div class="card empty">No products yet.<br><br><button class="btn" data-act="addp">Add your first product</button> <button class="btn ghost" data-act="seed">Import sample data</button></div>` : ""}
  ${list.map(p => `<div class="row"><img src="${esc(p.image)}" alt=""><div class="info"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.category)} · ${esc(p.brand || "—")} · stock ${Number(p.stock)}${p.isFlash ? " · ⚡ flash" : ""}</div><div class="price">${naira(p.price)}</div></div><div style="display:flex;flex-direction:column;gap:6px"><button class="btn ghost sm" data-act="editp" data-id="${p.id}"><i class="fas fa-pen"></i></button><button class="btn bad sm" data-act="delp" data-id="${p.id}"><i class="fas fa-trash"></i></button></div></div>`).join("")}`;
}

function vOrders() {
  const all = S.ofilter === "abandoned" ? S.orders.filter(o => o.status === "Pending Payment") : realOrders().filter(o => S.ofilter === "all" || o.status === S.ofilter);
  const chips = ["all", ...STATUSES, "abandoned"];
  return `<div class="bar"><button class="btn ghost sm" data-act="csv"><i class="fas fa-file-csv"></i> Export CSV</button></div>
  <div class="chips">${chips.map(c => `<button data-of="${c}" class="${S.ofilter === c ? "on" : ""}">${c === "all" ? "All orders" : c === "abandoned" ? "Unpaid / abandoned" : c}</button>`).join("")}</div>
  ${all.length ? all.map(o => `<div class="card" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;gap:8px"><div><b>${esc(o.id)}</b><div class="s mut sm">${fmt(toDate(o.createdAt))}</div></div><div style="text-align:right"><div class="price">${naira(o.total)}</div>${payBadge(o.paymentStatus)}</div></div>
    <div class="kv"><span>Customer</span><span>${esc(o.customerName)}</span></div><div class="kv"><span>Phone</span><span><a style="color:var(--p2)" href="tel:${esc(o.customerPhone)}">${esc(o.customerPhone)}</a></span></div><div class="kv"><span>Email</span><span>${esc(o.customerEmail)}</span></div>
    <div class="kv"><span>Address</span><span style="text-align:right">${esc(o.address?.text)}</span></div><div class="kv"><span>Payment</span><span>${esc(o.paymentMethod)}${o.paystackRef ? " · " + esc(o.paystackRef) : ""}</span></div>
    ${o.stockIssue ? `<div class="kv"><span style="color:var(--warn)">⚠ Stock</span><span>Paid but stock ran short — check inventory</span></div>` : ""}
    <div style="margin:10px 0">${(o.items || []).map(i => `<div class="kv"><span>${esc(i.name)} ×${Number(i.qty)}${i.size ? " · " + esc(i.size) : ""}</span><span>${naira(i.price * i.qty)}</span></div>`).join("")}</div>
    ${o.status === "Pending Payment" ? `<span class="badge warn">Waiting for payment</span>` : `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><select data-ost="${esc(o.id)}" style="flex:1;min-width:150px">${STATUSES.map(s => `<option ${s === o.status ? "selected" : ""}>${s}</option>`).join("")}</select><button class="btn sm" data-act="setst" data-id="${esc(o.id)}">Update</button>${o.paymentMethod === "cod" && o.paymentStatus !== "Paid" ? `<button class="btn ghost sm" data-act="codpaid" data-id="${esc(o.id)}">Mark paid</button>` : ""}</div>`}
  </div>`).join("") : `<div class="card empty">No orders here.</div>`}`;
}

function custStats() {
  const m = new Map(S.users.map(u => [u.uid, { ...u, n: 0, spent: 0, last: null }]));
  S.orders.forEach(o => { const c = m.get(o.uid); if (!c || o.status === "Pending Payment") return; c.n++; if (o.paymentStatus === "Paid") c.spent += o.total || 0; const d = toDate(o.createdAt); if (d && (!c.last || d > c.last)) c.last = d; });
  return [...m.values()].sort((a, b) => b.spent - a.spent);
}
function vCustomers() {
  const list = custStats().filter(c => !S.cq || ((c.name || "") + (c.email || "") + (c.phone || "")).toLowerCase().includes(S.cq.toLowerCase()));
  return `<div class="bar"><input id="cq" placeholder="Search customers…" value="${esc(S.cq)}"></div>
  ${list.length ? list.map(c => `<div class="row" data-act="cust" data-id="${esc(c.uid)}" style="cursor:pointer"><div class="info"><div class="t">${esc(c.name || "Unnamed")}</div><div class="s">${esc(c.email)}${c.phone ? " · " + esc(c.phone) : ""}</div><div class="s">Joined ${fmt(toDate(c.createdAt))}</div></div><div style="text-align:right"><div class="price">${naira(c.spent)}</div><div class="s mut">${c.n} order${c.n === 1 ? "" : "s"}</div></div></div>`).join("") : `<div class="card empty">No customers yet.</div>`}`;
}
function vCategories() {
  return `<div class="card"><h3 style="margin:0 0 6px">Add category</h3><div class="two"><div><label>Name</label><input id="cn" maxlength="30" placeholder="e.g. Gaming"></div><div><label>Icon (Font Awesome)</label><input id="ci" value="fa-tag" maxlength="30"></div></div><button class="btn w" style="margin-top:14px" data-act="addc">Add category</button></div>
  <h2>Categories</h2>${S.categories.length ? S.categories.map(c => `<div class="row"><div class="info"><div class="t"><i class="fas ${esc(c.icon)}"></i> ${esc(c.name)}</div><div class="s">${S.products.filter(p => p.category === c.name).length} products</div></div><button class="btn bad sm" data-act="delc" data-id="${esc(c.id)}"><i class="fas fa-trash"></i></button></div>`).join("") : `<div class="card empty">No categories yet. <button class="btn ghost sm" data-act="seed">Import defaults + sample products</button></div>`}`;
}
function render() {
  if ($("#app").hidden) return;
  const v = { overview: vOverview, products: vProducts, orders: vOrders, customers: vCustomers, categories: vCategories }[S.tab]();
  const act = document.activeElement, keep = act && act.id, pos = act && act.selectionStart;
  $("#view").innerHTML = v;
  if (keep && $("#" + keep)) { const el = $("#" + keep); el.focus(); try { el.setSelectionRange(pos, pos); } catch (_) {} }
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === S.tab));
}

/* ---------- modal helpers ---------- */
const openSheet = html => { $("#sheet").innerHTML = html; $("#modal").hidden = false; };
const closeSheet = () => { $("#modal").hidden = true; $("#sheet").innerHTML = ""; };
let pendingFile = null;

function productForm(p) {
  p = p || {};
  const cats = S.categories.map(c => c.name);
  if (p.category && !cats.includes(p.category)) cats.push(p.category);
  openSheet(`<h3>${p.id ? "Edit product" : "Add product"}</h3><p class="mut sm" style="margin:0 0 8px">Choose a category, add a photo and set the price.</p>
  <div class="preview" id="prev" style="background-image:url('${esc(p.image || "")}')"></div>
  <input id="pf" type="file" accept="image/png,image/jpeg,image/webp"><label>…or image URL (https)</label><input id="pu" value="${esc(p.image || "")}" placeholder="https://…">
  <label>Product name</label><input id="pn" maxlength="120" value="${esc(p.name || "")}">
  <div class="two"><div><label>Category</label><select id="pc">${cats.length ? cats.map(c => `<option ${c === p.category ? "selected" : ""}>${esc(c)}</option>`).join("") : "<option value=''>Create a category first</option>"}</select></div><div><label>Brand</label><input id="pb" maxlength="40" value="${esc(p.brand || "")}"></div></div>
  <div class="two"><div><label>Price (₦)</label><input id="pp" type="number" min="1" inputmode="numeric" value="${p.price || ""}"></div><div><label>Old price (₦, optional)</label><input id="po" type="number" min="0" inputmode="numeric" value="${p.oldPrice || ""}"></div></div>
  <div class="two"><div><label>Stock</label><input id="ps" type="number" min="0" inputmode="numeric" value="${p.stock ?? 10}"></div><div><label>Flash sale?</label><select id="pfl"><option value="0">No</option><option value="1" ${p.isFlash ? "selected" : ""}>Yes ⚡</option></select></div></div>
  <label>Description</label><textarea id="pd" rows="3" maxlength="1000">${esc(p.description || "")}</textarea>
  <div class="two"><div><label>Colours (hex, comma separated)</label><input id="pcol" value="${esc((p.colors || []).join(", "))}" placeholder="#111111, #ffffff"></div><div><label>Sizes (comma separated)</label><input id="psz" value="${esc((p.sizes || []).join(", "))}" placeholder="S, M, L"></div></div>
  <div style="display:flex;gap:10px;margin-top:18px"><button class="btn ghost" style="flex:1" data-act="close">Cancel</button><button class="btn" style="flex:2" id="saveP" data-act="savep" data-id="${p.id || ""}">Save product</button></div>`);
  pendingFile = null;
}
async function compress(file) {
  const bmp = await createImageBitmap(file);
  const sc = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(b => r(b), "image/webp", 0.9));
}
async function saveProduct(idStr) {
  const v = id => $("#" + id).value.trim();
  const name = v("pn"), category = v("pc"), price = Math.round(Number(v("pp"))), old = Math.round(Number(v("po")) || 0), stock = Math.floor(Number(v("ps")));
  if (name.length < 2) return toast("Enter a product name", "err");
  if (!category) return toast("Choose a category", "err");
  if (!(price > 0)) return toast("Enter a valid price", "err");
  if (old && old < price) return toast("Old price must be higher than the price", "err");
  if (!(stock >= 0)) return toast("Enter stock quantity", "err");
  const colors = v("pcol").split(",").map(s => s.trim()).filter(s => /^#[0-9a-f]{3,8}$/i.test(s));
  const sizes = v("psz").split(",").map(s => s.trim()).filter(s => /^[A-Za-z0-9.\-\/ ]{1,12}$/.test(s));
  const btn = $("#saveP"); btn.disabled = true; btn.textContent = "Saving…";
  try {
    const id = idStr ? Number(idStr) : Date.now();
    let image = v("pu");
    const file = $("#pf").files[0];
    if (file) {
      if (file.size > 15 * 1024 * 1024) throw new Error("Image too large (max 15MB)");
      btn.textContent = "Uploading image…";
      const blob = await compress(file);
      const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg";
      const r = ref(storage, `products/${id}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      await uploadBytes(r, blob, { contentType: blob.type });
      image = await getDownloadURL(r);
    }
    if (!/^https:\/\//i.test(image)) throw new Error("Add a product photo or a valid https image URL");
    const prev = S.products.find(p => p.id === id) || {};
    await setDoc(doc(db, "products", String(id)), {
      id, name, category, brand: v("pb"), price, oldPrice: old || price, stock, image, description: v("pd"),
      colors, sizes, isFlash: v("pfl") === "1", active: true,
      rating: prev.rating || 4.5, reviews: prev.reviews || 0, createdAt: prev.createdAt || serverTimestamp(), updatedAt: serverTimestamp()
    });
    toast("Product saved ✔"); closeSheet();
  } catch (e) { toast(e.message || "Could not save", "err"); btn.disabled = false; btn.textContent = "Save product"; }
}
async function deleteProduct(id) {
  const p = S.products.find(x => String(x.id) === String(id)); if (!p) return;
  if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
  try { await deleteDoc(doc(db, "products", String(id))); if (/firebasestorage|appspot/.test(p.image || "")) { try { await deleteObject(ref(storage, p.image)); } catch (_) {} } toast("Deleted"); }
  catch (e) { toast("Delete failed: " + e.code, "err"); }
}
async function seed() {
  if (!confirm("Import default categories and sample products? Existing items with the same ID are overwritten.")) return;
  try {
    const cats = (typeof categories !== "undefined" ? categories : []).filter(c => c.id !== "all");
    const prods = typeof products !== "undefined" ? products : [];
    const ops = [...cats.map(c => [doc(db, "categories", c.id.toLowerCase()), { id: c.id.toLowerCase(), name: c.name, icon: c.icon }]), ...prods.map(p => [doc(db, "products", String(p.id)), { ...p, active: true, createdAt: serverTimestamp() }])];
    for (let i = 0; i < ops.length; i += 400) { const b = writeBatch(db); ops.slice(i, i + 400).forEach(([r, d]) => b.set(r, d)); await b.commit(); }
    toast("Sample data imported ✔");
  } catch (e) { toast("Import failed: " + e.code, "err"); }
}
function csv() {
  const q = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const rows = [["Order", "Date", "Customer", "Phone", "Email", "Total", "Payment", "Status", "Reference", "Items", "Address"]];
  realOrders().forEach(o => rows.push([o.id, fmt(toDate(o.createdAt)), o.customerName, o.customerPhone, o.customerEmail, o.total, o.paymentStatus, o.status, o.paystackRef || "", (o.items || []).map(i => `${i.name} x${i.qty}`).join("; "), o.address?.text]));
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(",")).join("\n")], { type: "text/csv" })); a.download = "orders.csv"; a.click();
}

/* ---------- events ---------- */
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act],[data-tab],[data-pcat],[data-of]"); if (!t) return;
  if (t.dataset.tab) { S.tab = t.dataset.tab; return render(); }
  if (t.dataset.pcat) { S.pcat = t.dataset.pcat; return render(); }
  if (t.dataset.of) { S.ofilter = t.dataset.of; return render(); }
  const id = t.dataset.id;
  switch (t.dataset.act) {
    case "login": try { await signInWithEmailAndPassword(auth, $("#lE").value.trim(), $("#lP").value); } catch (_) { showLogin("Incorrect email or password."); } break;
    case "google": try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (_) { showLogin("Google sign-in was cancelled."); } break;
    case "reset": e.preventDefault(); { const m = $("#lE").value.trim(); if (!m) return showLogin("Enter your email first."); try { await sendPasswordResetEmail(auth, m); showLogin("Reset link sent — check your email."); } catch (_) { showLogin("Could not send reset email."); } } break;
    case "resend": try { await sendEmailVerification(auth.currentUser); toast("Verification email sent"); } catch (_) { toast("Try again later", "err"); } break;
    case "signout": stopData(); await signOut(auth); break;
    case "addp": productForm(); break;
    case "editp": productForm(S.products.find(p => String(p.id) === id)); break;
    case "delp": deleteProduct(id); break;
    case "savep": saveProduct(id); break;
    case "close": closeSheet(); break;
    case "seed": seed(); break;
    case "csv": csv(); break;
    case "setst": { const s = document.querySelector(`[data-ost="${CSS.escape(id)}"]`).value; try { await updateDoc(doc(db, "orders", id), { status: s, updatedAt: serverTimestamp() }); toast("Order updated ✔"); } catch (x) { toast("Failed: " + x.code, "err"); } } break;
    case "codpaid": try { await updateDoc(doc(db, "orders", id), { paymentStatus: "Paid", updatedAt: serverTimestamp() }); toast("Marked as paid ✔"); } catch (x) { toast("Failed: " + x.code, "err"); } break;
    case "addc": {
      const name = $("#cn").value.trim(), icon = $("#ci").value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 \-]{1,29}$/.test(name)) return toast("Category name: letters, numbers, spaces and hyphens only (2–30 chars)", "err");
      if (!/^fa-[a-z0-9-]+$/.test(icon)) return toast("Icon must look like fa-tag", "err");
      const cid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      try { await setDoc(doc(db, "categories", cid), { id: cid, name, icon }); $("#cn").value = ""; toast("Category added ✔"); } catch (x) { toast("Failed: " + x.code, "err"); }
    } break;
    case "delc": { const c = S.categories.find(x => x.id === id); if (c && S.products.some(p => p.category === c.name)) return toast("Move or delete its products first", "err"); if (confirm("Delete this category?")) await deleteDoc(doc(db, "categories", id)); } break;
    case "cust": { const c = custStats().find(x => x.uid === id); const os = realOrders().filter(o => o.uid === id);
      openSheet(`<h3>${esc(c.name || "Customer")}</h3><p class="mut sm">${esc(c.email)}${c.phone ? " · " + esc(c.phone) : ""}</p><div class="kv"><span>Total spent</span><span class="price">${naira(c.spent)}</span></div><div class="kv"><span>Orders</span><span>${c.n}</span></div><div class="kv"><span>Last login</span><span>${fmt(toDate(c.lastLogin))}</span></div><h2>Purchases</h2>${os.length ? os.map(orderRow).join("") : `<div class="empty">No purchases yet.</div>`}<button class="btn ghost w" data-act="close" style="margin-top:12px">Close</button>`); } break;
  }
});
document.addEventListener("input", e => {
  if (e.target.id === "pq") { S.pq = e.target.value; render(); }
  if (e.target.id === "cq") { S.cq = e.target.value; render(); }
});
document.addEventListener("change", e => {
  if (e.target.id === "pf") { const f = e.target.files[0]; if (f) $("#prev").style.backgroundImage = `url('${URL.createObjectURL(f)}')`; }
  if (e.target.id === "pu" && /^https:\/\//i.test(e.target.value)) $("#prev").style.backgroundImage = `url('${e.target.value.replace(/'/g, "%27")}')`;
});
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeSheet(); });

/* ---------- boot ---------- */
if (!enabled) showSetup();
else onAuthStateChanged(auth, u => {
  if (!u) { stopData(); return showLogin(); }
  if (!isAdminUser(u)) { stopData(); return showDenied(u); }
  $("#gate").hidden = true; $("#app").hidden = false; $("#whoEmail").textContent = u.email;
  startData(); render();
});
