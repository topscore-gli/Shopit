// Bridges Firebase (module) to the classic app.js through window.FB
import { enabled, CFG, auth, db, functions } from "./fb-core.js";
import { onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, sendEmailVerification, updateProfile, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { collection, doc, getDocs, setDoc, serverTimestamp, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const FB = { enabled, user: null, userListeners: [], unsubOrders: null };
window.FB = FB;
const iso = v => (v && v.toDate ? v.toDate().toISOString() : (typeof v === "string" ? v : new Date().toISOString()));
const friendly = e => {
  const c = (e && e.code) || "";
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return "Incorrect email or password.";
  if (/email-already-in-use/.test(c)) return "An account with this email already exists.";
  if (/weak-password/.test(c)) return "Password must be at least 8 characters.";
  if (/invalid-email/.test(c)) return "Please enter a valid email address.";
  if (/too-many-requests/.test(c)) return "Too many attempts. Please wait a moment and try again.";
  if (/popup-closed|cancelled-popup/.test(c)) return "Sign-in was cancelled.";
  if (/network/.test(c)) return "Network error. Check your connection.";
  return (e && e.message && !/firebase/i.test(e.message)) ? e.message : "Something went wrong. Please try again.";
};
FB.friendly = friendly;

if (!enabled) {
  FB.ready = Promise.resolve();
} else {
  FB.ready = new Promise(res => {
    onAuthStateChanged(auth, u => {
      FB.user = u;
      FB.userListeners.forEach(f => f(u));
      res();
    });
  });
  FB.onUser = f => { FB.userListeners.push(f); if (FB.user !== null) f(FB.user); };
  FB.signUp = async (name, email, pass) => {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(db, "users", cred.user.uid), { name, email, phone: "", createdAt: serverTimestamp(), lastLogin: serverTimestamp() });
    try { await sendEmailVerification(cred.user); } catch (_) {}
    return cred.user;
  };
  FB.signIn = async (email, pass) => { const c = await signInWithEmailAndPassword(auth, email, pass); touch(c.user); return c.user; };
  FB.google = async () => { const c = await signInWithPopup(auth, new GoogleAuthProvider()); await ensureUser(c.user); return c.user; };
  FB.reset = email => sendPasswordResetEmail(auth, email);
  FB.signOut = () => { if (FB.unsubOrders) { FB.unsubOrders(); FB.unsubOrders = null; } return signOut(auth); };
  async function ensureUser(u) {
    try { await setDoc(doc(db, "users", u.uid), { name: u.displayName || "", email: u.email || "", lastLogin: serverTimestamp(), createdAt: serverTimestamp() }, { merge: true }); } catch (_) {}
  }
  function touch(u) { setDoc(doc(db, "users", u.uid), { lastLogin: serverTimestamp() }, { merge: true }).catch(() => {}); }
  FB.updatePhone = (phone) => FB.user ? setDoc(doc(db, "users", FB.user.uid), { phone }, { merge: true }) : null;

  FB.loadCatalog = async () => {
    const [p, c] = await Promise.all([getDocs(collection(db, "products")), getDocs(collection(db, "categories"))]);
    return { products: p.docs.map(d => d.data()), categories: c.docs.map(d => d.data()) };
  };
  FB.watchCatalog = cb => {
    let P = null, C = null;
    const fire = () => { if (P && C) cb({ products: P, categories: C }); };
    const a = onSnapshot(collection(db, "products"), s => { P = s.docs.map(d => d.data()); fire(); }, () => {});
    const b = onSnapshot(collection(db, "categories"), s => { C = s.docs.map(d => d.data()); fire(); }, () => {});
    return () => { a(); b(); };
  };
  FB.watchMyOrders = cb => {
    if (FB.unsubOrders) FB.unsubOrders();
    if (!FB.user) { cb([]); return; }
    FB.unsubOrders = onSnapshot(query(collection(db, "orders"), where("uid", "==", FB.user.uid)), s => {
      const list = s.docs.map(d => { const o = d.data(); return { ...o, id: d.id, date: iso(o.createdAt), paidAt: o.paidAt ? iso(o.paidAt) : null }; })
        .filter(o => o.status !== "Pending Payment" || (Date.now() - new Date(o.date)) < 2 * 3600 * 1000)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      cb(list);
    }, () => cb([]));
  };
  const call = name => httpsCallable(functions, name);
  FB.createOrder = async payload => (await call("createOrder")(payload)).data;
  FB.verifyPayment = async orderId => (await call("verifyPayment")({ orderId })).data;
}
