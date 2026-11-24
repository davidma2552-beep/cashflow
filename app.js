import { firebaseConfig } from "./firebase-config.js";

const FB_VER = "10.12.2";
const DEMO = !firebaseConfig.apiKey || firebaseConfig.apiKey === "REPLACE_ME";

// ---------- Backends ----------
// Both backends expose the same interface so the UI doesn't care which one is active.

async function createFirebaseBackend() {
  const base = `https://www.gstatic.com/firebasejs/${FB_VER}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const A = await import(`${base}/firebase-auth.js`);
  const F = await import(`${base}/firebase-firestore.js`);

  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const txCol = (uid) => F.collection(db, "users", uid, "transactions");
  const userDoc = (uid) => F.doc(db, "users", uid);

  return {
    onAuth: (cb) => A.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email || u.displayName } : null)),
    signInGoogle: () => A.signInWithPopup(auth, new A.GoogleAuthProvider()),
    signIn: (e, p) => A.signInWithEmailAndPassword(auth, e, p),
    signUp: (e, p) => A.createUserWithEmailAndPassword(auth, e, p),
    reset: (e) => A.sendPasswordResetEmail(auth, e),
    signOut: () => A.signOut(auth),
    watchTransactions(uid, cb) {
      return F.onSnapshot(txCol(uid), (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), !snap.metadata.fromCache));
    },
    watchSettings(uid, cb) {
      return F.onSnapshot(userDoc(uid), (d) => cb(d.exists() ? d.data() : {}, !d.metadata.fromCache));
    },
    async addTransactions(uid, list) {
      const batch = F.writeBatch(db);
      for (const t of list) batch.set(F.doc(txCol(uid)), { ...t, createdAt: Date.now() });
      await batch.commit();
    },
    removeTransaction: (uid, id) => F.deleteDoc(F.doc(db, "users", uid, "transactions", id)),
    updateTransaction: (uid, id, data) => F.updateDoc(F.doc(db, "users", uid, "transactions", id), data),
    async renameCategory(uid, from, to) {
      const snap = await F.getDocs(F.query(txCol(uid), F.where("category", "==", from)));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = F.writeBatch(db);
        snap.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, { category: to }));
        await batch.commit();
      }
    },
    saveSettings: (uid, s) => F.setDoc(userDoc(uid), s, { merge: true }),
  };
}

function createDemoBackend() {
  const KEY = "cashflow-demo";
  const listeners = { auth: [], tx: [], settings: [] };
  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  };
  const write = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  let state = read();
  state.users ||= {};
  const userData = (uid) => (state.users[uid] ||= { tx: [], settings: {} });
  const emitData = (uid) => {
    const u = userData(uid);
    listeners.tx.forEach((cb) => cb([...u.tx]));
    listeners.settings.forEach((cb) => cb({ ...u.settings }));
  };
  const setUser = (user) => {
    state.current = user;
    write(state);
    listeners.auth.forEach((cb) => cb(user));
  };
  const login = (email) => setUser({ uid: email.toLowerCase(), email });

  return {
    onAuth(cb) { listeners.auth.push(cb); setTimeout(() => cb(state.current || null)); return () => {}; },
    signInGoogle: async () => login("demo@example.com"),
    signIn: async (e) => login(e),
    signUp: async (e) => login(e),
    reset: async () => {},
    signOut: async () => setUser(null),
    watchTransactions(uid, cb) {
      listeners.tx = [cb];
      setTimeout(() => cb([...userData(uid).tx], true));
      return () => { listeners.tx = []; };
    },
    watchSettings(uid, cb) {
      listeners.settings = [cb];
      setTimeout(() => cb({ ...userData(uid).settings }, true));
      return () => { listeners.settings = []; };
    },
    async addTransactions(uid, list) {
      const u = userData(uid);
      for (const t of list) u.tx.push({ ...t, id: crypto.randomUUID(), createdAt: Date.now() });
      write(state); emitData(uid);
    },
    async removeTransaction(uid, id) {
      const u = userData(uid);
      u.tx = u.tx.filter((t) => t.id !== id);
      write(state); emitData(uid);
    },
    async updateTransaction(uid, id, data) {
      const u = userData(uid);
      u.tx = u.tx.map((t) => (t.id === id ? { ...t, ...data } : t));
      write(state); emitData(uid);
    },
    async renameCategory(uid, from, to) {
      userData(uid).tx.forEach((t) => { if (t.category === from) t.category = to; });
      write(state); emitData(uid);
    },
    async saveSettings(uid, s) {
      Object.assign(userData(uid).settings, s);
      write(state); emitData(uid);
    },
  };
}

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("he-IL", { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n) => money.format(n);
const moneyShort = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtShort = (n) => moneyShort.format(n);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (y, m) => `${y}-${pad(m + 1)}`; // m is 0-based
const todayStr = () => ymd(new Date());
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nowTime = () => hm(new Date());
// Older transactions have no time field: fall back to when they were created
const txTime = (t) => t.time || (t.createdAt ? hm(new Date(t.createdAt)) : "");
const byDateTime = (a, b) => a.date.localeCompare(b.date) || txTime(a).localeCompare(txTime(b)) || (a.createdAt || 0) - (b.createdAt || 0);
const signed = (t) => (t.type === "income" ? 1 : -1) * Number(t.amount || 0);
const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const target = new Date(y, m - 1 + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, last));
  return ymd(target);
}

const AUTH_ERRORS = {
  "auth/invalid-credential": "אימייל או סיסמה שגויים",
  "auth/wrong-password": "סיסמה שגויה",
  "auth/user-not-found": "המשתמש לא קיים, אפשר להירשם",
  "auth/email-already-in-use": "האימייל כבר רשום, נסו להתחבר",
  "auth/weak-password": "הסיסמה צריכה להכיל לפחות 6 תווים",
  "auth/invalid-email": "כתובת אימייל לא תקינה",
  "auth/popup-closed-by-user": "חלון ההתחברות נסגר",
  "auth/unauthorized-domain": "הדומיין הזה לא מאושר ב-Firebase (Authentication → Settings → Authorized domains)",
  "auth/too-many-requests": "יותר מדי ניסיונות, נסו שוב בעוד כמה דקות",
};
const authMsg = (e) => AUTH_ERRORS[e?.code] || e?.message || "שגיאה";

// ---------- State ----------
let backend;
let user = null;
let txs = [];
let settings = {};
let unsub = [];
let viewY, viewM; // the viewed period, named by the month it starts in
let viewInit = false;

// ---------- Periods ----------
// Each user picks the day of the month their money resets. A period runs from that day
// until the day before it in the next month; months shorter than the reset day reset on their last day.
const resetDay = () => Math.min(31, Math.max(1, Math.floor(Number(settings.resetDay)) || 1));
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
const periodStart = (y, m) => new Date(y, m, Math.min(resetDay(), daysIn(y, m)));
function periodRange(y, m) {
  const next = new Date(y, m + 1, 1);
  const end = periodStart(next.getFullYear(), next.getMonth());
  end.setDate(end.getDate() - 1);
  return [periodStart(y, m), end];
}
function periodOf(dateStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  if (d >= periodStart(y, mo - 1).getDate()) return monthKey(y, mo - 1);
  const p = new Date(y, mo - 2, 1);
  return monthKey(p.getFullYear(), p.getMonth());
}
function goToCurrentPeriod() {
  const [y, m] = periodOf(todayStr()).split("-").map(Number);
  viewY = y; viewM = m - 1;
}
goToCurrentPeriod();
const viewKey = () => monthKey(viewY, viewM);
const rangeOfKey = (key) => { const [y, m] = key.split("-").map(Number); return periodRange(y, m - 1); };
// Changes are stored with the date they take effect, so they stay put even if the reset day changes later.
const effectiveDate = (key) => ymd(rangeOfKey(key)[0]);
const asDate = (s) => (s && s.length === 7 ? s + "-01" : s);
const dm = (d) => `${d.getDate()}.${d.getMonth() + 1}`;

// ---------- Categories ----------
// Three kinds: income, "fixed" (a monthly deduction that comes off automatically), and "expense" (personal, entered by hand).
// What a new user starts with: four personal-expense categories, and an empty fixed-deductions list.
const DEFAULT_CATS = ["שכירות", "סופר", "רכב", "אחר"].map((name) => ({ name, kind: "expense" }));
const DEDUCT_HINT = "כאן מוסיפים הורדות שיורדות כל חודש בסכום קבוע, כמו שכירות, סלולר, ביטוח, הלוואה או מנויים.";
const KINDS = {
  income: { label: "הכנסה", group: "💰 הכנסות", cls: "pos" },
  fixed: { label: "הורדה חודשית", group: "🔁 הורדות חודשיות", cls: "neg" },
  expense: { label: "הוצאה אישית", group: "🛒 הוצאות אישיות", cls: "neg" },
};
// ----- Category icons: picked automatically from the name, or chosen by the user -----
const ICON_RULES = [
  ["🏠", ["שכירות", "שכר דירה", "דירה", "משכנתא", "ועד בית", "ארנונה"]],
  ["🛒", ["סופר", "מכולת", "קניות", "שופרסל", "רמי לוי"]],
  ["🍔", ["מזון", "אוכל", "מסעד", "משלוח", "וולט"]],
  ["☕", ["קפה"]],
  ["⛽", ["דלק"]],
  ["🚗", ["רכב", "אוטו", "מכונית", "טסט", "חניה"]],
  ["🚌", ["תחבורה", "אוטובוס", "רכבת", "מונית", "רב קו"]],
  ["🎉", ["בילוי", "יציאות", "מסיבה", "הופעה"]],
  ["📱", ["סלולר", "טלפון", "פלאפון"]],
  ["🌐", ["אינטרנט", "ראוטר"]],
  ["📺", ["טלוויזיה", "נטפליקס", "סטרימינג", "yes", "hot"]],
  ["🎵", ["ספוטיפיי", "מוזיקה", "ציוד", "הפקה", "אולפן"]],
  ["🔁", ["מנוי"]],
  ["🛡️", ["ביטוח"]],
  ["💡", ["חשמל", "חשבונות"]],
  ["💧", ["מים"]],
  ["🔥", ["גז"]],
  ["🏦", ["הלוואה", "בנק", "עמלה", "ריבית"]],
  ["💳", ["אשראי", "כרטיס"]],
  ["💊", ["תרופ", "בריאות", "רופא", "קופת חולים"]],
  ["🏋️", ["חדר כושר", "כושר", "ספורט"]],
  ["👕", ["ביגוד", "בגדים", "נעליים", "קניות אונליין"]],
  ["✂️", ["ספר", "תספורת", "מספרה", "קוסמטיקה"]],
  ["🎓", ["לימוד", "קורס", "שכר לימוד", "אוניברסיטה"]],
  ["🐶", ["כלב", "חתול", "חיות", "וטרינר"]],
  ["✈️", ["טיסה", "חופשה", "חו״ל", "חול", "נסיעה"]],
  ["🎁", ["מתנה", "מתנות"]],
  ["👶", ["ילד", "גן", "תינוק"]],
  ["🚬", ["סיגריות", "עישון"]],
  ["💰", ["משכורת", "הכנסה", "חיסכון", "חסכון"]],
  ["⚡", ["לא צפוי"]],
  ["📦", ["אחר", "שונות", "כללי"]],
];
const ICON_CHOICES = ["🛒", "🏠", "🚗", "⛽", "🍔", "☕", "🎉", "📱", "🌐", "📺", "🎵", "🛡️", "💡", "💧", "🏦", "💳", "💊", "🏋️", "👕", "✂️", "🎓", "🐶", "✈️", "🎁", "👶", "🚌", "🔁", "💰", "📦"];
function autoIcon(name) {
  const n = String(name || "").toLowerCase();
  for (const [icon, words] of ICON_RULES) if (words.some((w) => n.includes(w.toLowerCase()))) return icon;
  return "🏷️";
}
const catIcon = (c) => (c && c.icon) || autoIcon(c && c.name);
// Icon for a transaction's category name (the category may have been deleted)
const iconForName = (name) => catIcon(getCategories().find((c) => c.name === name) || { name });
function iconPicker(c) {
  const cur = c.icon || "";
  const auto = autoIcon(c.name);
  return `<fieldset class="icon-pick"><legend>אייקון</legend>
    <label title="אוטומטי לפי השם"><input type="radio" name="icon" value="" ${cur ? "" : "checked"} /><span>${auto}<small>אוטו׳</small></span></label>
    ${ICON_CHOICES.map((i) => `<label><input type="radio" name="icon" value="${i}" ${cur === i ? "checked" : ""} /><span>${i}</span></label>`).join("")}
  </fieldset>`;
}
const kindOf = (c) => (KINDS[c.kind] ? c.kind : "expense");
const isFixed = (c) => c.kind === "fixed";
const hasFixedAmount = (c) => c.kind === "income" || c.kind === "fixed";
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
let editingCat = null;
const isIncome = (c) => c.kind === "income";

// Month totals the user typed in themselves; they replace the calculated totals for that month only.
// Income typed into the top box carries over to later months until the user changes it (or returns to automatic).
function manualFor(key) {
  const all = settings.manualTotals || {};
  const own = { ...(all[key] || {}) };
  if (own.income === undefined) {
    const earlier = Object.keys(all).filter((k) => k < key && all[k] && all[k].income !== undefined).sort().pop();
    if (earlier) own.income = all[earlier].income;
  }
  return own;
}
const isNum = (v) => typeof v === "number" && isFinite(v);
let editingStat = null;
const STAT_LABELS = { income: "הכנסות החודש", deduct: "הורדות חודשיות קבועות", expense: "הוצאות החודש" };
const STAT_CLS = { income: "pos", deduct: "neg", expense: "neg" };

// ----- Deductions drawer: tick off each fixed deduction once it has come out this month -----
let drawerOpen = false;
let editingTx = null;
try { drawerOpen = localStorage.getItem("cashflow-drawer") === "1"; } catch {}
const paidFor = (key) => (settings.paid || {})[key] || {};
// When a deduction was ticked as paid: "YYYY-MM-DD HH:MM" (older ticks were just `true`)
const paidAt = (key, id) => { const v = paidFor(key)[id]; return typeof v === "string" ? v : null; };
// Auto-marking (a switch in the deductions list): a deduction with a day counts as paid once that day has come,
// unless the user unticked it by hand. Nothing is written; it's worked out each time.
const autoPaidOn = () => !!settings.autoPaid;
function isAutoPaid(key, c) {
  const v = paidFor(key)[c.id];
  if (!autoPaidOn() || (v !== undefined && v !== null)) return false;
  const on = deductDate(c, key);
  return !!on && on <= todayStr();
}
const isPaid = (key, c) => { const v = paidFor(key)[c.id]; return v === false ? false : !!v || isAutoPaid(key, c); };

let editingDeduct = null;
// Optional day of the month a fixed deduction comes out (1-31)
const dayOk = (v) => { const n = parseInt(v, 10); return n >= 1 && n <= 31 ? n : null; };
// The actual date of that day inside the viewed period (the period may span two calendar months)
function deductDate(c, key) {
  const day = dayOk(c.day);
  if (!day) return null;
  const [start] = rangeOfKey(key);
  let d = new Date(start.getFullYear(), start.getMonth(), Math.min(day, daysIn(start.getFullYear(), start.getMonth())));
  if (d < start) { const n = new Date(start.getFullYear(), start.getMonth() + 1, 1); d = new Date(n.getFullYear(), n.getMonth(), Math.min(day, daysIn(n.getFullYear(), n.getMonth()))); }
  return ymd(d);
}
const dayLabel = (c) => (dayOk(c.day) ? `יורד ב-${dayOk(c.day)} לחודש` : "");
function drawerHTML(key) {
  // Deductions with a day come first, in the order they come out during the month; those without a day go last
  const items = getCategories().filter((c) => isFixed(c) && activeIn(c, key))
    .map((c, i) => ({ c, i, on: deductDate(c, key) }))
    .sort((a, b) => (a.on && b.on ? a.on.localeCompare(b.on) || a.i - b.i : a.on ? -1 : b.on ? 1 : a.i - b.i))
    .map((x) => x.c);
  const done = items.filter((c) => isPaid(key, c));
  const total = items.reduce((s, c) => s + fixedAmount(c, key), 0);
  const pending = items.filter((c) => !isPaid(key, c)).reduce((s, c) => s + fixedAmount(c, key), 0);
  const rows = items.map((c) => {
    const id = esc(c.id);
    const amt = fixedAmount(c, key);
    if (editingDeduct === c.id) {
      return `<form class="d-edit" data-dform="${id}">
        <input name="name" maxlength="40" required value="${esc(c.name)}" aria-label="שם ההורדה" />
        <input name="amount" type="number" min="0" step="0.01" inputmode="decimal" value="${amt || ""}" placeholder="סכום ₪" aria-label="סכום חודשי" />
        <input name="day" type="number" min="1" max="31" step="1" inputmode="numeric" value="${dayOk(c.day) || ""}" placeholder="יום ההורדה בחודש (לא חובה)" aria-label="יום ההורדה בחודש, לא חובה" />
        ${iconPicker(c)}
        <div class="d-edit-actions">
          <button type="submit" class="btn btn-primary btn-sm">שמירה</button>
          <button type="button" class="btn btn-ghost btn-sm" data-dcancel>ביטול</button>
          <button type="button" class="btn btn-ghost btn-sm danger" data-ddel="${id}">מחיקה</button>
        </div>
      </form>`;
    }
    const ok = isPaid(key, c);
    const auto = isAutoPaid(key, c);
    return `<div class="d-row ${ok ? "done" : ""}">
      <label class="d-check">
        <input type="checkbox" data-paid="${id}" ${ok ? "checked" : ""} aria-label="${esc(c.name)} ירד" />
        <span class="d-name"><span class="cat-ico" aria-hidden="true">${catIcon(c)}</span>${esc(c.name)}${ok ? ` <span class="d-ok">✓ ירד${auto ? " אוטומטית" : ""}</span>` : ""}</span>
      </label>
      <span class="d-amt"><span class="d-amt-v">${amt > 0 ? fmt(amt) : `<span class="muted">ללא סכום</span>`}</span>${dayLabel(c) ? `<small class="d-day">${dayLabel(c)}</small>` : ""}</span>
      <button type="button" class="icon-btn d-edit-btn" data-dedit="${id}" title="עריכה או מחיקה" aria-label="עריכת ${esc(c.name)}">✎</button>
    </div>`;
  }).join("");
  return `<div class="drawer">
    <div class="drawer-sum muted">${items.length ? `ירדו ${done.length} מתוך ${items.length}${pending > 0 ? ` · עוד צפוי לרדת ${fmt(pending)}` : ""}` : `<span class="d-hint">${DEDUCT_HINT}</span>`}</div>
    <label class="auto-switch">
      <span class="auto-text"><b>סימון אוטומטי</b><small>הורדות עם תאריך יסומנו "ירד" לבד כשמגיע היום שלהן</small></span>
      <input type="checkbox" role="switch" data-autopaid ${autoPaidOn() ? "checked" : ""} aria-label="סימון אוטומטי של הורדות עם תאריך" />
      <span class="switch" aria-hidden="true"></span>
    </label>
    <div class="d-list">${rows}</div>
    ${items.length ? `<div class="d-total"><span>סה״כ</span><b>${fmt(total)}</b></div>` : ""}
    <form id="drawer-add" class="drawer-add">
      <input name="name" maxlength="40" required placeholder="הורדה חדשה, למשל סלולר" aria-label="שם ההורדה" />
      <div class="drawer-add-row">
        <input name="amount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="סכום ₪" aria-label="סכום חודשי" />
        <button type="submit" class="btn btn-primary btn-sm">+ הוספה</button>
      </div>
      <input name="day" type="number" min="1" max="31" step="1" inputmode="numeric" placeholder="יום ההורדה בחודש (לא חובה)" aria-label="יום ההורדה בחודש, לא חובה" />
    </form>
    <p class="muted hint">הסכומים קבועים לכל החודשים עד שתשנו אותם (✎). הסימון "ירד" מתאפס ביום האיפוס.</p>
  </div>`;
}

// The deductions total is exactly the sum of the user's list; everything else that went out is an expense.
// A total the user typed in replaces the calculated income or expenses.
function periodTotals(key, periodTx) {
  const sum = (list) => list.reduce((s, t) => s + Number(t.amount), 0);
  const auto = {
    baseIncome: fixedItems(key, "income").reduce((s, x) => s + x.amount, 0),
    incomeTx: sum(periodTx.filter((t) => t.type === "income")),
    deduct: fixedItems(key, "fixed").reduce((s, x) => s + x.amount, 0),
    // What actually went out: deductions ticked as paid plus every expense entered
    paidDeduct: getCategories().filter((c) => isFixed(c) && activeIn(c, key) && isPaid(key, c)).reduce((s, c) => s + fixedAmount(c, key), 0),
    personal: sum(periodTx.filter((t) => t.type === "expense")),
  };
  auto.expense = auto.paidDeduct + auto.personal;
  const man = manualFor(key);
  const pick = (k) => (isNum(man[k]) ? man[k] : auto[k]);
  // Planned outflow for the chart: every deduction (paid or not) plus expenses entered
  const planned = auto.deduct + auto.personal;
  // The typed-in monthly income is the base; income entered as transactions this month is always added on top.
  auto.income = auto.baseIncome + auto.incomeTx;
  const baseIncome = isNum(man.income) ? man.income : auto.baseIncome;
  return { auto, man, baseIncome, income: baseIncome + auto.incomeTx, deduct: auto.deduct, expense: auto.expense, planned };
}

function statHTML(kind, value, auto, manual, note = "", editValue = value) {
  const label = STAT_LABELS[kind];
  if (editingStat === kind) {
    return `<div class="stat-label">${label}</div>
      <form class="stat-edit" data-stat-form="${kind}">
        <input name="v" type="number" step="0.01" min="0" inputmode="decimal" value="${manual ? editValue : ""}" placeholder="${auto}" aria-label="${label}" />
        <div class="row gap">
          <button type="submit" class="btn btn-primary btn-sm">שמירה</button>
          ${manual ? `<button type="button" class="btn btn-ghost btn-sm" data-stat-auto="${kind}">חישוב אוטומטי</button>` : ""}
          <button type="button" class="btn btn-ghost btn-sm" data-stat-cancel>ביטול</button>
        </div>
      </form>
      <div class="stat-note">החישוב האוטומטי: ${fmt(auto)}</div>`;
  }
  return `<div class="stat-label row between"><span>${label}</span><button class="icon-btn edit-stat" data-stat-edit="${kind}" title="הזנה ידנית" aria-label="הזנה ידנית של ${label}">✎</button></div>
    <button class="stat-value as-btn ${STAT_CLS[kind]}" data-stat-edit="${kind}" title="לחצו כדי להזין סכום">${fmt(value)}</button>
    <div class="stat-note">${manual ? `<span class="tag manual">הוזן ידנית</span>` : (kind === "income" ? "לחצו כדי להזין את ההכנסה החודשית" : "לחצו להזנה ידנית")}</div>${note}`;
}
const UNPLANNED = "לא צפוי";

// Categories live in the user's settings doc and carry over to every period.
// Until the user edits them, show defaults (unsaved).
function getCategories() {
  if (Array.isArray(settings.categories)) return settings.categories;
  return DEFAULT_CATS.map((c) => ({ id: "default-" + c.name, budget: 0, amounts: [], ...c }));
}
// A deleted category stays visible in the periods before it was deleted, so past months don't change.
// A fixed deduction counts only from the period it was added in, so months before it don't show it.
const fixedStart = (c) => (c.amounts || []).map((h) => asDate(h.from)).sort()[0];
const activeIn = (c, key) => (!c.deletedFrom || effectiveDate(key) < asDate(c.deletedFrom))
  && !(c.kind === "fixed" && fixedStart(c) && fixedStart(c) > ymd(rangeOfKey(key)[1]));
const liveCategories = () => getCategories().filter((c) => !c.deletedFrom);

// Fixed monthly income: a history of {from: date, amount}. Each period uses the latest change made on or before its last day.
function fixedAmount(c, key) {
  // Fixed deductions: one amount for every month, exactly as the user set it.
  if (c.kind === "fixed") { const h = (c.amounts || [])[c.amounts.length - 1]; return h ? Number(h.amount) || 0 : 0; }
  const last = ymd(rangeOfKey(key)[1]);
  let amount = 0;
  [...(c.amounts || [])].map((h) => ({ ...h, from: asDate(h.from) })).sort((x, y) => x.from.localeCompare(y.from))
    .forEach((h) => { if (h.from <= last) amount = Number(h.amount) || 0; });
  return amount;
}
// Fixed amounts for a period: kind "income" (fixed income) or "fixed" (monthly deductions)
const fixedItems = (key, kind) => getCategories()
  .filter((c) => c.kind === kind && activeIn(c, key))
  .map((c) => ({ c, amount: fixedAmount(c, key) }))
  .filter((x) => x.amount > 0);
// A fixed deduction has a single amount that applies to every month, until the user changes it.
function setFixedAmount(c, amount) {
  if (!(amount > 0)) return [];
  const first = (c.amounts || []).map((h) => asDate(h.from)).sort()[0];
  return [{ from: first || effectiveDate(viewKey()), amount }];
}
function withAmountFrom(c, key, amount) {
  if (fixedAmount(c, key) === amount) return c.amounts || [];
  const from = effectiveDate(key);
  return [...(c.amounts || []).filter((h) => asDate(h.from) !== from), { from, amount }];
}

// ----- Bringing existing users up to the current defaults -----
// Users who saved their categories before the defaults changed still hold the old default list.
// Once per user: drop old defaults they never touched (not renamed, no amount or budget, no transactions,
// never ticked), and add the new defaults they don't have. Anything the user added or edited stays as it is.
const DEFAULTS_VERSION = 2;
// Every default category ever shipped, with the kinds it shipped as
const OLD_DEFAULTS = { "משכורת": ["income"], "שכירות": ["expense", "fixed"], "חשבונות": ["expense", "fixed"], "מזון": ["expense"], "רכב": ["expense"], "בילויים": ["expense"], "אחר": ["expense"] };
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
function untouchedOldDefault(c) {
  const kinds = OLD_DEFAULTS[c.name];
  if (!kinds || c.id !== "default-" + c.name || c.deletedFrom) return false;
  if (!kinds.includes(c.kind || "expense")) return false;
  if (Number(c.budget) > 0 || (c.amounts || []).some((h) => Number(h.amount) > 0)) return false;
  if (txs.some((t) => t.category === c.name)) return false;
  if (Object.values(settings.paid || {}).some((m) => m && m[c.id])) return false;
  return true;
}
function migratedCategories(cats) {
  const out = [];
  const replaced = new Set();
  for (const c of cats) {
    if (!untouchedOldDefault(c)) { out.push(c); continue; }
    const isNewDefault = DEFAULT_CATS.some((d) => d.name === c.name);
    if (isNewDefault && kindOf(c) === "expense") out.push(c); // already matches the new defaults
    else if (isNewDefault) { replaced.add(c.name); out.push({ id: "default2-" + c.name, name: c.name, kind: "expense", budget: 0, amounts: [] }); }
    // otherwise an unused old default: dropped
  }
  // New defaults that were never part of the old list (סופר): add unless the user already has one by that name
  const added = DEFAULT_CATS.filter((d) => !OLD_DEFAULTS[d.name] && !out.some((c) => !c.deletedFrom && sameName(c.name, d.name)))
    .map((d) => ({ id: "default2-" + d.name, name: d.name, kind: "expense", budget: 0, amounts: [] }));
  if (added.length) {
    // Place it in the new defaults' order: after the last live personal-expense category that comes before it there
    for (const a of added) {
      const before = DEFAULT_CATS.slice(0, DEFAULT_CATS.findIndex((d) => d.name === a.name)).map((d) => d.name);
      let at = -1;
      out.forEach((c, i) => { if (!c.deletedFrom && kindOf(c) === "expense" && before.includes(c.name)) at = i; });
      if (at < 0) at = out.findIndex((c) => !c.deletedFrom && kindOf(c) === "expense") - 1;
      out.splice(at < 0 ? out.length : at + 1, 0, a);
    }
  }
  return out;
}
let migrating = false;
async function migrateDefaults(ready) {
  if (!user || migrating || !ready.tx || !ready.settings) return;
  if ((Number(settings.defaultsVersion) || 0) >= DEFAULTS_VERSION) return;
  migrating = true;
  const uid = user.uid;
  try {
    // Users who never saved categories already see the current defaults
    if (Array.isArray(settings.categories)) await saveCategories(migratedCategories(settings.categories));
    if (user && user.uid === uid) await backend.saveSettings(uid, { defaultsVersion: DEFAULTS_VERSION });
  } catch (e) { console.warn("defaults update skipped", e); }
  migrating = false;
}

const saveCategories = (cats) =>
  backend.saveSettings(user.uid, {
    categories: cats.map((c) => {
      const kind = kindOf(c);
      const out = { id: c.id, name: c.name, kind, budget: kind === "expense" ? Number(c.budget) || 0 : 0, amounts: kind === "expense" ? [] : (c.amounts || []) };
      if (c.deletedFrom) out.deletedFrom = c.deletedFrom;
      if (c.icon) out.icon = c.icon;
      if (kind === "fixed" && dayOk(c.day)) out.day = dayOk(c.day);
      return out;
    }),
  });

// ---------- Render ----------
function render() {
  const key = viewKey();
  const [start, end] = periodRange(viewY, viewM);
  $("month-label").textContent = `${HE_MONTHS[viewM]} ${viewY}`;
  $("period-range").textContent = `${dm(start)} עד ${dm(end)}`;
  if (document.activeElement !== $("reset-day")) $("reset-day").value = String(resetDay());

  const sorted = [...txs].sort(byDateTime);
  const periodTx = sorted.filter((t) => periodOf(t.date) === key);
  const fixed = fixedItems(key, "income");
  const deductions = fixedItems(key, "fixed");
  const tot = periodTotals(key, periodTx);
  const { income, deduct, man } = tot;
  const expense = tot.expense; // what has gone out so far: ticked deductions + expenses entered
  const left = income - expense;

  const afterDeduct = deduct > 0
    ? `<div class="after-deduct">אחרי ההורדות הקבועות: <b class="${income - deduct < 0 ? "neg" : ""}">${fmt(income - deduct)}</b></div>`
    : "";
  const incomeBreakdown = tot.auto.incomeTx > 0
    ? `<div class="stat-note">${fmt(tot.baseIncome)} חודשית + <b class="pos">${fmt(tot.auto.incomeTx)}</b> הכנסות נוספות</div>`
    : "";
  $("stat-income").innerHTML = statHTML("income", income, tot.auto.baseIncome, isNum(man.income), incomeBreakdown + afterDeduct, tot.baseIncome);
  const fixedCats = getCategories().filter((c) => isFixed(c) && activeIn(c, key));
  const paidCount = fixedCats.filter((c) => isPaid(key, c)).length;
  const drawerBtn = `<button type="button" class="drawer-toggle ${drawerOpen ? "open" : ""}" data-drawer aria-expanded="${drawerOpen}">
      ${fixedCats.length ? `סומנו ${paidCount}/${fixedCats.length} · ` : ""}${drawerOpen ? "סגירת הרשימה ▴" : fixedCats.length ? "פתיחת הרשימה ▾" : "+ הוספת הורדות ▾"}</button>`;
  // How much of the list has come out so far (the ticked items)
  const paidSum = fixedCats.filter((c) => isPaid(key, c)).reduce((s, c) => s + fixedAmount(c, key), 0);
  const paidPct = deduct > 0 ? Math.min(100, (paidSum / deduct) * 100) : 0;
  $("stat-deduct").innerHTML = `<div class="stat-label">${STAT_LABELS.deduct}</div>
    <button class="stat-value as-btn total" data-drawer title="פתיחת הרשימה">${fmt(deduct)}</button>
    ${fixedCats.length ? `<div class="paid-meter" role="progressbar" aria-valuemin="0" aria-valuemax="${deduct}" aria-valuenow="${paidSum}" aria-label="ירד ${fmt(paidSum)} מתוך ${fmt(deduct)}">
      <div class="paid-fill ${paidSum >= deduct && deduct > 0 ? "full" : ""}" style="width:${paidPct}%"></div>
    </div>
    <div class="paid-text">ירד <b>${fmt(paidSum)}</b> מתוך <b>${fmt(deduct)}</b></div>` : drawerOpen ? "" : `<div class="d-hint">אפשר להוסיף הורדות קבועות כמו שכירות, סלולר, ביטוח וכו׳</div>`}
    ${drawerBtn}${drawerOpen ? drawerHTML(key) : ""}`;
  const showDrawer = drawerOpen;
  $("stat-deduct").classList.toggle("with-drawer", showDrawer);
  $("stat-deduct").parentElement.classList.toggle("drawer-open", showDrawer);
  $("stat-income").classList.toggle("editing", editingStat === "income");
  $("s-close").textContent = fmt(left);
  $("s-close").className = "stat-value " + (left < 0 ? "neg" : "");
  // Show the calculation: income minus what has actually gone out (ticked deductions + expenses)
  const pendingDeduct = Math.max(0, deduct - tot.auto.paidDeduct);
  const hasData = income > 0 || expense > 0;
  $("s-close-note").innerHTML = hasData
    ? `${fmt(income)} הכנסות − ${fmt(expense)} שירדו בפועל`
      + (pendingDeduct > 0 ? `<br>אחרי שיירדו עוד ${fmt(pendingDeduct)} בהורדות: <b>${fmt(left - pendingDeduct)}</b>` : "")
    : `עוד אין הכנסות בחודש הזה. לחצו על "הכנסות החודש" כדי להזין את ההכנסה החודשית.`;

  // How much of this period's income was spent: a bar inside the "left this month" card
  const pct = income > 0 ? (expense / income) * 100 : expense > 0 ? 100 : 0;
  $("usage-pct").innerHTML = income > 0 ? `הוצאתם <bdi dir="ltr">${Math.round(pct)}%</bdi> מההכנסה` : "";
  $("usage-bar").parentElement.classList.toggle("hidden", !hasData);
  $("usage-bar").style.width = Math.min(100, pct) + "%";
  $("usage-bar").className = expense > income ? "over" : pct >= 85 ? "warn" : "";

  // Month's transactions as a list, newest first: icon, category, "נרשם ב־time · date · description", amount
  const today = todayStr();
  const dotted = (ds) => { const [y, m, d] = ds.split("-"); return `${d}.${m}.${y}`; };
  const startStr = ymd(start);
  const items = [];
  // The monthly income: the typed-in amount if there is one, otherwise fixed income categories
  const incomeRows = isNum(man.income) ? (man.income > 0 ? [{ c: { name: "הכנסה חודשית" }, amount: man.income }] : []) : fixed;
  incomeRows.forEach(({ c, amount }) => items.push({ sort: startStr + " 00:00", html: `
    <div class="tx-item fixed-in">
      <div class="tx-icon">${catIcon(c)}</div>
      <div class="tx-main"><div class="tx-title">${esc(c.name)}</div><div class="tx-sub">הכנסה חודשית · ${dotted(startStr)}</div></div>
      <div class="tx-side"><div class="tx-amt pos">+${fmtShort(amount)}</div></div>
    </div>` }));
  // Fixed deductions: shown with their status; they only count once ticked as paid
  deductions.forEach(({ c, amount }) => {
    const paidNow = isPaid(key, c);
    // Only deductions that have come out appear in the month's transactions
    if (!paidNow) return;
    const autoNow = isAutoPaid(key, c);
    const on = deductDate(c, key); // the day it comes out, if the user set one
    // Without a day: once ticked, it sits in the list on the date and time it was marked as paid
    const ticked = !on && paidNow ? paidAt(key, c.id) : null;
    const tickedLabel = ticked ? ` · ${ticked.length > 10 ? `נרשם ב־${ticked.slice(11)} · ` : "סומן ב־"}${dotted(ticked.slice(0, 10))}` : "";
    const tickedSort = ticked ? (ticked.length > 10 ? ticked : ticked + " 00:01") : null;
    items.push({ sort: tickedSort || ((on || startStr) + " 00:01"), html: `
    <div class="tx-item ${paidNow ? "" : "pending"}">
      <div class="tx-icon">${catIcon(c)}</div>
      <div class="tx-main"><div class="tx-title">${esc(c.name)}</div><div class="tx-sub">הורדה קבועה${on ? ` · יורד ב-${on.split("-").slice(1).reverse().map(Number).join(".")}` : ""}${tickedLabel} · ${paidNow ? `<span class="d-ok">✓ ירד${autoNow ? " אוטומטית" : ""}</span>` : "ממתין לסימון"}</div></div>
      <div class="tx-side"><div class="tx-amt neg">−${fmtShort(amount)}</div></div>
    </div>` });
  });
  const catOptions = (t) => {
    const names = [...new Set([
      ...(t.type === "income" ? ["הכנסה"] : getCategories().filter((c) => kindOf(c) !== "income" && activeIn(c, key)).map((c) => c.name)),
      UNPLANNED, t.category,
    ])];
    return names.map((n) => `<option value="${esc(n)}" ${n === t.category ? "selected" : ""}>${esc(n)}</option>`).join("");
  };
  periodTx.forEach((t) => {
    const time = txTime(t);
    const sort = t.date + " " + (time || "00:02") + " " + String(t.createdAt || 0).padStart(15, "0");
    if (editingTx === t.id) {
      items.push({ sort, html: `
      <div class="tx-item editing">
        <form class="tx-edit" data-txform="${esc(t.id)}">
          <label>תאריך<input name="date" type="date" required value="${esc(t.date)}" /></label>
          <label>שעה<input name="time" type="time" value="${esc(time)}" /></label>
          <label class="grow">תיאור<input name="desc" maxlength="100" value="${esc(t.description || "")}" placeholder="ללא תיאור" /></label>
          <label>קטגוריה<select name="category">${catOptions(t)}</select></label>
          <label>סכום (₪)<input name="amount" type="number" step="0.01" min="0.01" required inputmode="decimal" value="${Number(t.amount)}" /></label>
          <div class="tx-edit-actions">
            <button type="submit" class="btn btn-primary btn-sm">שמירה</button>
            <button type="button" class="btn btn-ghost btn-sm" data-txcancel>ביטול</button>
            <button type="button" class="btn btn-ghost btn-sm danger" data-del="${esc(t.id)}">מחיקה</button>
          </div>
        </form>
      </div>` });
      return;
    }
    const inc = t.type === "income";
    const sub = [time ? `נרשם ב־${time}` : "", dotted(t.date), t.description ? esc(t.description) : ""].filter(Boolean).join(" · ");
    items.push({ sort, html: `
    <div class="tx-item ${t.date > today ? "future" : ""}" data-txedit="${esc(t.id)}" role="button" tabindex="0" aria-label="עריכת ${esc(t.category)} ${fmtShort(Number(t.amount))}">
      <div class="tx-icon">${iconForName(t.category)}</div>
      <div class="tx-main"><div class="tx-title">${esc(t.category)}</div><div class="tx-sub">${sub}</div></div>
      <div class="tx-side"><div class="tx-amt ${inc ? "pos" : "neg"}">${inc ? "+" : "−"}${fmtShort(Number(t.amount))}</div><div class="tx-hint">✎</div></div>
    </div>` });
  });
  items.sort((x, y) => (x.sort < y.sort ? 1 : x.sort > y.sort ? -1 : 0));
  $("tx-body").innerHTML = items.map((x) => x.html).join("");
  $("empty").classList.toggle("hidden", items.length > 0);

  renderCategories(periodTx, key);

  const unplanned = periodTx.filter((t) => t.category === UNPLANNED && t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
  $("unplanned-sum").textContent = unplanned > 0 ? `החודש: ${fmt(unplanned)}` : "";
  renderBreakdown(periodTx, key);
  renderSavings(sorted, key);
  renderCompare(sorted, key);
  renderChart(sorted);
}

// ----- Where the money went this month: one bar per category, largest first -----
function renderBreakdown(periodTx, key) {
  const by = {};
  periodTx.filter((t) => t.type === "expense").forEach((t) => { by[t.category] = (by[t.category] || 0) + Number(t.amount); });
  const rows = Object.entries(by).map(([name, amount]) => ({ name, icon: iconForName(name), amount }));
  // Fixed deductions that have come out this month, as one row
  const paidDeduct = getCategories().filter((c) => isFixed(c) && activeIn(c, key) && isPaid(key, c)).reduce((s, c) => s + fixedAmount(c, key), 0);
  if (paidDeduct > 0) rows.push({ name: "הורדות קבועות", icon: "🔁", amount: paidDeduct });
  rows.sort((a, b) => b.amount - a.amount);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  $("breakdown-total").textContent = total > 0 ? `סה״כ ${fmt(total)}` : "";
  if (!total) { $("breakdown").innerHTML = `<p class="muted center chart-empty">כשתוסיפו הוצאות החודש, תראו כאן על מה הלך הכסף.</p>`; return; }
  const max = rows[0].amount;
  $("breakdown").innerHTML = rows.map((r) => {
    const pct = Math.round((r.amount / total) * 100);
    return `<div class="bd-row">
      <div class="bd-name"><span aria-hidden="true">${r.icon}</span>${esc(r.name)}</div>
      <div class="bd-track"><div class="bd-fill" style="width:${(r.amount / max) * 100}%"></div></div>
      <div class="bd-amt"><b>${fmt(r.amount)}</b><span class="muted"><bdi dir="ltr">${pct}%</bdi></span></div>
    </div>`;
  }).join("");
}

// ----- Where can I save? Advice only: it reads the month's numbers and never changes anything -----
let savingsOpen = false;
const fmtR = (n) => fmtShort(Math.round(n)); // whole shekels in advice
function savingsTips(sorted, key) {
  const tips = [];
  const sum = (l) => l.reduce((s, t) => s + Number(t.amount), 0);
  const round10 = (n) => Math.max(10, Math.round(n / 10) * 10);
  const periodTx = sorted.filter((t) => periodOf(t.date) === key);
  const exp = periodTx.filter((t) => t.type === "expense");
  const byCat = {};
  exp.forEach((t) => (byCat[t.category] ||= []).push(t));
  const cats = getCategories().filter((c) => activeIn(c, key));
  const today = todayStr();
  const [start, end] = rangeOfKey(key);
  const inProgress = periodOf(today) === key;
  const daysLeft = inProgress ? Math.round((end - new Date(today)) / 86400000) + 1 : 0;

  // Up to three previous months, for "more than usual"
  const [y, m] = key.split("-").map(Number);
  const prevMonths = [1, 2, 3].map((i) => { const d = new Date(y, m - 1 - i, 1); return monthKey(d.getFullYear(), d.getMonth()); })
    .map((k) => { const o = {}; sorted.filter((t) => t.type === "expense" && periodOf(t.date) === k).forEach((t) => { o[t.category] = (o[t.category] || 0) + Number(t.amount); }); return o; })
    .filter((o) => Object.keys(o).length);

  const perCat = {}; // the biggest saving per category, so nothing is counted twice
  const add = (tip) => {
    tips.push(tip);
    if (tip.save > 0 && tip.cat) perCat[tip.cat] = Math.max(perCat[tip.cat] || 0, tip.save);
  };

  // 1. Personal-expense categories: over budget, close to it, above usual, no budget yet
  cats.filter((c) => kindOf(c) === "expense").forEach((c) => {
    const spent = sum(byCat[c.name] || []);
    const budget = Number(c.budget) || 0;
    const icon = catIcon(c);
    if (budget > 0 && spent > budget) {
      add({ kind: "warn", cat: c.name, save: spent - budget, title: `${icon} ${c.name}: חריגה של ${fmtR(spent - budget)}`,
        text: `הוצאתם ${fmtR(spent)} מתוך תקציב של ${fmtR(budget)}. עמידה בתקציב בחודש הבא תחסוך ${fmtR(spent - budget)}.` });
    } else if (budget > 0 && inProgress && spent >= budget * 0.85) {
      add({ kind: "warn", cat: c.name, save: 0, title: `${icon} ${c.name}: קרוב לסוף התקציב`,
        text: `נשארו ${fmtR(budget - spent)} ל${daysLeft} הימים שנותרו בחודש. כדאי להאט כאן עד יום האיפוס.` });
    }
    if (prevMonths.length && spent > 0) {
      const avg = prevMonths.reduce((s, o) => s + (o[c.name] || 0), 0) / prevMonths.length;
      if (avg > 0 && spent > avg * 1.15 && spent - avg >= 50) {
        add({ kind: "idea", cat: c.name, save: spent - avg, title: `${icon} ${c.name}: יותר מהרגיל`,
          text: `בממוצע אתם מוציאים כאן ${fmtR(avg)} בחודש, והחודש ${fmtR(spent)}. חזרה לממוצע תחסוך כ-${fmtR(spent - avg)}.` });
      }
    }
    if (!budget && spent >= 300) {
      const target = round10(spent * 0.9);
      add({ kind: "idea", cat: c.name, save: spent - target, title: `${icon} ${c.name}: אין תקציב`,
        text: `הוצאתם כאן ${fmtR(spent)} בלי תקציב. קביעת תקציב של כ-${fmtR(target)} (לוחצים ✎ בכרטיס) יכולה לחסוך כ-${fmtR(spent - target)} בחודש.` });
    }
    const small = (byCat[c.name] || []).filter((t) => Number(t.amount) <= 50);
    if (small.length >= 5) {
      const s = sum(small);
      add({ kind: "idea", cat: c.name, save: s * 0.3, title: `${icon} ${c.name}: הרבה קניות קטנות`,
        text: `${small.length} קניות של עד ₪50, ביחד ${fmtR(s)}. קניות קטנות מצטברות; צמצום בשליש יחסוך כ-${fmtR(s * 0.3)}.` });
    }
  });

  // 2. Unexpected expenses
  const personal = sum(exp);
  const unplanned = sum(byCat[UNPLANNED] || []);
  if (unplanned > 0 && personal > 0 && unplanned / personal >= 0.05) {
    add({ kind: "idea", cat: null, save: 0, title: `⚡ הוצאות לא צפויות: ${fmtR(unplanned)}`,
      text: `${Math.round((unplanned / personal) * 100)}% מההוצאות החודש לא היו מתוכננות. כדאי לשים בצד כל חודש סכום קבוע למקרים כאלה, כדי שלא יפתיעו.` });
  }

  // 3. Fixed deductions: subscriptions to review, services worth comparing
  const fixedList = cats.filter((c) => isFixed(c)).map((c) => ({ c, amount: fixedAmount(c, key) })).filter((x) => x.amount > 0);
  fixedList.forEach(({ c, amount }) => {
    const n = c.name;
    if (/מנוי|נטפליקס|ספוטיפיי|סטרימינג|דיסני|יוטיוב|אפל|אמזון|כושר|netflix|spotify|disney|youtube|apple|prime/i.test(n)) {
      add({ kind: "idea", cat: "fixed:" + n, save: amount, title: `${catIcon(c)} ${n}: בדקו אם אתם משתמשים`,
        text: `${fmtR(amount)} בחודש, ${fmtR(amount * 12)} בשנה. אם לא משתמשים בזה הרבה, ביטול או הקפאה יחסכו את כל הסכום.` });
    } else if (/ביטוח|סלולר|פלאפון|טלפון|אינטרנט|טלוויזיה|כבלים|חשמל|גז/.test(n)) {
      add({ kind: "idea", cat: "fixed:" + n, save: amount * 0.15, title: `${catIcon(c)} ${n}: שווה להשוות מחירים`,
        text: `משלמים ${fmtR(amount)} בחודש. הרבה פעמים אפשר לקבל הנחה בשיחה עם החברה או אצל מתחרה; הוזלה של 15% חוסכת כ-${fmtR(amount * 0.15)} בחודש, ${fmtR(amount * 0.15 * 12)} בשנה.` });
    }
  });

  // 4. The big picture: share of fixed deductions, how much is left
  const tot = periodTotals(key, periodTx);
  const deductTotal = fixedList.reduce((s, x) => s + x.amount, 0);
  if (tot.income > 0 && deductTotal / tot.income > 0.5) {
    add({ kind: "warn", cat: null, save: 0, title: `🔁 ההורדות הקבועות הן ${Math.round((deductTotal / tot.income) * 100)}% מההכנסה`,
      text: `יותר מחצי מההכנסה יורד אוטומטית. כדאי לעבור על הרשימה ולבדוק מה אפשר להוזיל או לבטל.` });
  }
  if (tot.income > 0) {
    const leftAfterAll = tot.income - deductTotal - personal;
    const rate = leftAfterAll / tot.income;
    if (leftAfterAll < 0) {
      add({ kind: "warn", cat: null, save: 0, title: `🚨 החודש יוצא יותר ממה שנכנס`,
        text: `אחרי כל ההורדות וההוצאות חסרים ${fmtR(-leftAfterAll)}. ההצעות למעלה יכולות לעזור לסגור את הפער.` });
    } else if (rate < 0.1) {
      add({ kind: "idea", cat: null, save: 0, title: `🐷 נשאר רק ${Math.round(rate * 100)}% מההכנסה`,
        text: `נסו לשים בצד כבר בתחילת החודש לפחות 10% מההכנסה (${fmtR(tot.income * 0.1)}), כדי שהחיסכון לא יהיה "מה שנשאר".` });
    } else {
      add({ kind: "good", cat: null, save: 0, title: `🌟 נשאר ${Math.round(rate * 100)}% מההכנסה`,
        text: `אחרי כל ההורדות וההוצאות צפוי להישאר ${fmtR(leftAfterAll)}. כדאי להעביר חלק מזה לחיסכון עוד לפני שהוא מתבזבז.` });
    }
  }
  const potential = Object.values(perCat).reduce((s, v) => s + v, 0);
  return { tips, potential, hasData: exp.length > 0 || deductTotal > 0, monthDone: !inProgress && effectiveDate(key) <= today, daysLeft };
}

function renderSavings(sorted, key) {
  const btn = $("save-btn"), panel = $("save-panel");
  if (!btn) return;
  const r = savingsTips(sorted, key);
  // At the end of the month (last 3 days, or a month that's over) the summary is highlighted
  const ready = r.hasData && (r.monthDone || (r.daysLeft > 0 && r.daysLeft <= 3));
  btn.innerHTML = `💡 ${ready ? "סיכום החודש: " : ""}איפה אפשר לחסוך?${ready ? ` <span class="save-ready">מוכן</span>` : ""}`;
  btn.setAttribute("aria-expanded", String(savingsOpen));
  panel.classList.toggle("hidden", !savingsOpen);
  if (!savingsOpen) return;
  if (!r.hasData) {
    panel.innerHTML = `<p class="muted">עוד אין מספיק נתונים החודש. אחרי שתזינו הוצאות והורדות קבועות, יופיעו כאן הצעות לחיסכון.</p>`;
    return;
  }
  const order = { warn: 0, idea: 1, good: 2 };
  const tips = [...r.tips].sort((a, b) => order[a.kind] - order[b.kind] || b.save - a.save);
  panel.innerHTML = `
    ${r.potential >= 1 ? `<div class="save-sum">פוטנציאל חיסכון משוער: <b>כ-${fmtR(r.potential)} בחודש</b> <span class="muted">(כ-${fmtR(Math.round(r.potential) * 12)} בשנה)</span></div>` : ""}
    <div class="save-list">${tips.map((t) => `
      <div class="save-tip ${t.kind}">
        <div class="save-title">${t.title}</div>
        <div class="save-text">${t.text}</div>
        ${t.save >= 1 ? `<div class="save-amt">חיסכון אפשרי: כ-${fmtR(t.save)} בחודש</div>` : ""}
      </div>`).join("") || `<p class="muted">לא מצאתי מקומות בולטים לחיסכון החודש. כל הכבוד! 🎉</p>`}</div>
    <p class="save-note">💬 אלה הצעות בלבד, לפי הנתונים שהזנתם. שום דבר באתר לא משתנה עד שתחליטו לשנות בעצמכם.</p>`;
}

// ----- Personal expenses compared with the previous month -----
// For the month in progress, compare up to the same day of the previous month, so a half month isn't set against a whole one.
function renderCompare(sorted, key) {
  const [y, m] = key.split("-").map(Number);
  const p = new Date(y, m - 2, 1);
  const prevKey = monthKey(p.getFullYear(), p.getMonth());
  const spend = (list) => list.filter((t) => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
  const prevTx = sorted.filter((t) => periodOf(t.date) === prevKey);
  const curTx = sorted.filter((t) => periodOf(t.date) === key);
  if (!prevTx.some((t) => t.type === "expense")) { $("s-compare").innerHTML = ""; return; }
  // A month that hasn't started yet has nothing to compare
  if (effectiveDate(key) > todayStr()) { $("s-compare").innerHTML = ""; return; }
  const inProgress = periodOf(todayStr()) === key;
  // At the very start of a month (nothing spent yet) "less than last month" would mislead
  if (inProgress && !curTx.some((t) => t.type === "expense")) { $("s-compare").innerHTML = ""; return; }
  let prev = spend(prevTx), cur = spend(curTx), when = "מבחודש שעבר";
  if (inProgress) {
    const [start] = rangeOfKey(key), [pStart] = rangeOfKey(prevKey);
    const days = Math.round((new Date(todayStr()) - new Date(ymd(start))) / 86400000);
    const cutoff = new Date(pStart); cutoff.setDate(cutoff.getDate() + days);
    prev = spend(prevTx.filter((t) => t.date <= ymd(cutoff)));
    cur = spend(curTx.filter((t) => t.date <= todayStr()));
    when = "מאשר עד אותו יום בחודש שעבר";
  }
  const diff = Math.round((cur - prev) * 100) / 100;
  $("s-compare").innerHTML = Math.abs(diff) < 1
    ? `הוצאות משתנות: בערך כמו ${inProgress ? "עד אותו יום בחודש שעבר" : "בחודש שעבר"}`
    : `הוצאות משתנות: <b class="${diff > 0 ? "neg" : "pos"}">${diff > 0 ? "▲" : "▼"} ${fmt(Math.abs(diff))} ${diff > 0 ? "יותר" : "פחות"}</b> ${when}`;
}

function renderCategories(periodTx, key) {
  const cats = getCategories().filter((c) => activeIn(c, key));
  const sumBy = { income: {}, expense: {} };
  periodTx.forEach((t) => { const m = sumBy[t.type]; if (m) m[t.category] = (m[t.category] || 0) + Number(t.amount); });

  let totBudget = 0, totSpent = 0;

  const tile = (c) => {
    const kind = kindOf(c);
    const income = kind === "income";
    const id = esc(c.id);

    if (editingCat === c.id) {
      const amountField = (show) => `<div class="edit-fixed ${show ? "" : "hidden"}">
          <label><span class="fixed-label">${income ? "סכום קבוע כל חודש (₪)" : "סכום שיורד כל חודש (₪)"}</span><input name="fixed" type="number" min="0" step="0.01" inputmode="decimal" value="${fixedAmount(c, key) || ""}" placeholder="ללא סכום קבוע" /></label>
          <p class="muted hint">${income ? "השינוי חל מהחודש הזה והלאה. חודשים קודמים לא משתנים." : "הסכום חל על כל החודשים, עד שתשנו אותו."}</p>
        </div>`;
      const budgetField = (show) => `<label class="edit-budget ${show ? "" : "hidden"}">תקציב חודשי (₪)<input name="budget" type="number" min="0" step="1" inputmode="decimal" value="${Number(c.budget) || ""}" placeholder="ללא תקציב" /></label>`;
      const kindField = income ? "" : `<label>סוג<select name="kind" data-kind-switch>
          <option value="expense" selected>הוצאה אישית (משתנה)</option>
          <option value="fixed">העברה להורדות החודשיות הקבועות</option>
        </select></label>`;
      return `<div class="tile editing">
        <form class="tile-edit" data-editform="${id}">
          <label>שם<input name="name" maxlength="40" required value="${esc(c.name)}" /></label>
          ${iconPicker(c)}
          ${kindField}
          ${amountField(kind !== "expense")}
          ${income ? "" : budgetField(kind === "expense")}
          <div class="row gap">
            <button type="submit" class="btn btn-primary btn-sm grow">שמירה</button>
            <button type="button" class="btn btn-ghost btn-sm" data-cancel>ביטול</button>
            <button type="button" class="btn btn-ghost btn-sm danger" data-delcat="${id}">מחיקה</button>
          </div>
        </form>
      </div>`;
    }

    const addBtn = `<button type="button" class="btn btn-sm tile-add" data-qadd="${esc(c.name)}" aria-label="הוספת הוצאה ב${esc(c.name)}">+ הוצאה</button>`;
    const head = `<div class="tile-head"><strong><span class="cat-ico" aria-hidden="true">${catIcon(c)}</span>${esc(c.name)}</strong><button class="icon-btn" data-edit="${id}" title="עריכה" aria-label="עריכת ${esc(c.name)}">✎</button></div>`;
    const verb = income ? "הכנסה" : "הוצאה";
    const descPh = income ? "תיאור (למשל בונוס)" : kind === "fixed" ? "תיאור (למשל חיוב נוסף)" : "תיאור ההוצאה";
    const form = `<form class="quick" data-quick="${id}">
        <input name="desc" maxlength="100" placeholder="${descPh}" aria-label="תיאור ה${verb} (לא חובה)" />
        <div class="quick-row">
          <input name="amount" type="number" step="0.01" min="0.01" required inputmode="decimal" placeholder="סכום ₪" aria-label="סכום ה${verb} ב${esc(c.name)}" />
          <button type="submit" class="btn btn-primary btn-sm">+ ${verb}</button>
        </div>
      </form>`;

    if (kind !== "expense") {
      const fixedAmt = fixedAmount(c, key);
      const extra = (income ? sumBy.income : sumBy.expense)[c.name] || 0;
      const what = income ? "נכנס כל חודש" : "יורד כל חודש";
      const extraNote = income ? `נוסף החודש: ${fmt(extra)}` : `חיובים נוספים החודש: ${fmt(extra)} (נספרים בהוצאות)`;
      const status = fixedAmt > 0
        ? `<span class="${income ? "pos" : ""}">${what}: <b>${fmt(fixedAmt)}</b></span>${extra ? `<span class="muted"> · ${extraNote}</span>` : ""}`
        : `<span class="muted">אין סכום קבוע. לחצו ✎ כדי להגדיר</span>`;
      return `<div class="tile ${income ? "income" : "deduct"}">${head}
        <div class="tile-nums"><span class="num-big ${income ? "pos" : ""}">${fmt(income ? fixedAmt + extra : fixedAmt)}</span></div>
        <div class="tile-status">${status}</div>${form}</div>`;
    }

    const spent = sumBy.expense[c.name] || 0;
    const budget = Number(c.budget) || 0;
    if (budget > 0) { totBudget += budget; totSpent += spent; }
    const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
    const remaining = budget - spent;
    const level = budget > 0 && spent > budget ? "over" : pct >= 85 ? "warn" : "";
    const status = budget > 0
      ? (remaining >= 0 ? `<span>נשאר <b>${fmt(remaining)}</b></span>` : `<span class="neg">⚠️ עברתם את התקציב</span>`)
      : `<span class="muted">ללא תקציב</span>`;
    return `<div class="tile compact ${level}" data-qadd="${esc(c.name)}">${head}
      <div class="tile-nums"><span class="num-big">${fmt(spent)}</span>${budget > 0 ? `<span class="muted">מתוך ${fmt(budget)}</span>` : ""}${level === "over" ? `<span class="over-badge">חרגתם ב-${fmt(-remaining)}</span>` : ""}</div>
      ${budget > 0 ? `<div class="cat-bar"><div class="${level}" style="width:${pct}%"></div></div>` : ""}
      <div class="tile-status">${status}</div>${addBtn}</div>`;
  };

  // One section per kind, each with its own subtotal
  const groupTotal = (kind, list) => list.reduce((s, c) => {
    if (kind === "expense") return s + (sumBy.expense[c.name] || 0);
    return s + fixedAmount(c, key) + (kind === "income" ? sumBy.income[c.name] || 0 : 0);
  }, 0);
  // Fixed deductions live in their own list under "הורדות חודשיות קבועות", not here.
  // Income is entered in the top box; this section holds personal expenses only.
  $("cat-tiles").innerHTML = ["expense"].map((kind) => {
    const list = cats.filter((c) => kindOf(c) === kind);
    if (!list.length) return "";
    return `<div class="cat-group">
      <div class="group-head"><h4>${KINDS[kind].group}</h4><span class="${KINDS[kind].cls}">${fmt(groupTotal(kind, list))}</span></div>
      <div class="tiles">${list.map(tile).join("")}</div>
    </div>`;
  }).join("") || `<p class="muted">אין קטגוריות עדיין. הוסיפו את הראשונה למטה.</p>`;

  $("budget-total").innerHTML = totBudget > 0 ? `הוצאתם ${fmt(totSpent)} מתוך תקציב של ${fmt(totBudget)}` : "";
}

// Date for a transaction entered from a category card: today if viewing the current period,
// otherwise the first day of the viewed period.
function quickDate() {
  return periodOf(todayStr()) === viewKey() ? todayStr() : ymd(periodStart(viewY, viewM));
}

// ----- Quick add (floating + button): amount, category, optional description -----
let quickCat = null;
function quickChoices() {
  const cats = getCategories().filter((c) => kindOf(c) === "expense" && activeIn(c, viewKey()));
  return [...cats.map((c) => ({ name: c.name, icon: catIcon(c), type: "expense" })),
    { name: UNPLANNED, icon: "⚡", type: "expense" }, { name: "הכנסה", icon: "💰", type: "income" }];
}
function renderQuickCats() {
  const list = quickChoices();
  if (!list.some((x) => x.name === quickCat)) quickCat = list[0].name;
  $("qa-cats").innerHTML = list.map((x) => `<button type="button" class="qa-chip ${x.name === quickCat ? "on" : ""} ${x.type === "income" ? "inc" : ""}" data-qcat="${esc(x.name)}" aria-pressed="${x.name === quickCat}">
    <span aria-hidden="true">${x.icon}</span>${esc(x.name)}</button>`).join("");
}
function openQuick(open, cat) {
  $("qa-sheet").classList.toggle("hidden", !open);
  $("qa-fab").classList.toggle("hidden", open);
  document.body.classList.toggle("sheet-open", open);
  if (open) { $("qa-form").reset(); if (cat) quickCat = cat; renderQuickCats(); setTimeout(() => $("qa-amount").focus(), 50); }
}

let toastTimer;
function toast(msg, isError, action) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error-toast" : "");
  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "toast-action"; b.textContent = action.label;
    b.onclick = () => { t.classList.add("hidden"); action.run(); };
    t.append(" ", b);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), action ? 6000 : 2800);
}

// Two-step confirmation without native dialogs (they can be blocked in embedded pages).
function confirmClick(btn, label, action) {
  if (btn.dataset.armed) { action(); return; }
  btn.dataset.armed = "1";
  const orig = btn.textContent;
  btn.textContent = label;
  btn.classList.add("armed");
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = orig; btn.classList.remove("armed"); } }, 3000);
}

function renderChart(sorted) {
  // 12 months: 5 before the viewed month, the viewed month, and 6 after
  const months = [];
  for (let i = -5; i <= 6; i++) {
    const d = new Date(viewY, viewM + i, 1);
    const key = monthKey(d.getFullYear(), d.getMonth());
    const t = periodTotals(key, sorted.filter((x) => periodOf(x.date) === key));
    months.push({ key, label: HE_MONTHS[d.getMonth()].slice(0, 3) + "׳" + String(d.getFullYear()).slice(2), inc: t.income, out: t.planned });
  }
  for (const m of months) {
    m.bal = m.inc - m.out;
  }

  // Nothing to show yet: a short note instead of an empty chart
  const empty = months.every((m) => !m.inc && !m.out);
  $("chart-legend").classList.toggle("hidden", empty);
  if (empty) { $("chart").innerHTML = `<p class="muted center chart-empty">הגרף יופיע אחרי שתזינו הכנסה או תוסיפו הוצאות.</p>`; return; }
  const W = Math.max(320, Math.round($("chart").clientWidth) || 640), H = W < 500 ? 220 : 260, L = 48, R = 8, T = 12, B = 28;
  const vals = months.flatMap((m) => [m.inc, m.out, m.bal]);
  let hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
  if (hi === lo) hi = lo + 1;
  const y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const slot = (W - L - R) / months.length;
  const bw = Math.min(14, slot / 3);
  const cx = (i) => L + slot * i + slot / 2;

  const ticks = 4;
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const v = lo + (hi - lo) * i / ticks;
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)" />`;
    grid += `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${compact.format(v)}</text>`;
  }
  const zero = y(0);
  const bars = months.map((m, i) => {
    const sel = i === 5;
    return `
      <rect x="${cx(i) - bw - 1}" y="${y(m.inc)}" width="${bw}" height="${Math.max(0, zero - y(m.inc))}" rx="2" fill="var(--in-bar)"><title>${m.label}: הכנסות ${fmt(m.inc)}</title></rect>
      <rect x="${cx(i) + 1}" y="${y(m.out)}" width="${bw}" height="${Math.max(0, zero - y(m.out))}" rx="2" fill="var(--out-bar)"><title>${m.label}: הוצאות ${fmt(m.out)}</title></rect>
      <text x="${cx(i)}" y="${H - 8}" text-anchor="middle" style="${sel ? "font-weight:700;fill:var(--text)" : ""}">${slot < 40 && !sel && (i - 5) % 2 ? "" : m.label}</text>`;
  }).join("");
  const line = months.map((m, i) => `${i ? "L" : "M"}${cx(i)},${y(m.bal)}`).join(" ");
  const dots = months.map((m, i) => `<circle cx="${cx(i)}" cy="${y(m.bal)}" r="3" fill="var(--bal)"><title>${m.label}: נשאר ${fmt(m.bal)}</title></circle>`).join("");

  $("chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" direction="ltr" role="img" aria-label="תרשים תזרים">
    ${grid}
    <rect x="${L + slot * 5}" y="${T}" width="${slot}" height="${H - T - B}" fill="var(--primary)" opacity=".06" />
    ${bars}
    <line x1="${L}" x2="${W - R}" y1="${zero}" y2="${zero}" stroke="var(--muted)" stroke-width=".8" />
    <path d="${line}" fill="none" stroke="var(--bal)" stroke-width="2" />
    ${dots}
  </svg>`;
}

// ---------- Auth UI ----------
function showView(signedIn) {
  $("loading").classList.add("hidden");
  $("auth-view").classList.toggle("hidden", signedIn);
  $("app-view").classList.toggle("hidden", !signedIn);
  $("qa-fab").classList.toggle("hidden", !signedIn);
  if (!signedIn) { $("qa-sheet").classList.add("hidden"); document.body.classList.remove("sheet-open"); }
}

function onUser(u) {
  unsub.forEach((f) => f && f());
  unsub = [];
  user = u;
  txs = [];
  settings = {};
  if (!u) { showView(false); return; }
  $("user-email").textContent = u.email || "";
  showView(true);
  render();
  // Wait until both the transactions and the settings have come from the server before updating defaults
  const ready = { tx: false, settings: false };
  unsub.push(backend.watchTransactions(u.uid, (list, fresh) => { txs = list; if (fresh) ready.tx = true; render(); migrateDefaults(ready); }));
  viewInit = false;
  unsub.push(backend.watchSettings(u.uid, (s, fresh) => {
    settings = s || {};
    if (fresh) ready.settings = true;
    if (!viewInit) { viewInit = true; goToCurrentPeriod(); }
    if (settings.theme && JSON.stringify(settings.theme) !== JSON.stringify(theme)) {
      theme = normalizeTheme({ ...theme, ...settings.theme });
      try { localStorage.setItem("cashflow-theme", JSON.stringify(theme)); } catch {}
      applyTheme();
    }
    render();
    migrateDefaults(ready);
  }));
}

function wireEvents() {
  const err = (e) => { $("auth-error").textContent = e ? authMsg(e) : ""; };

  $("google-btn").onclick = () => { err(); backend.signInGoogle().catch(err); };

  let mode = "login";
  $("email-form").querySelectorAll("button[type=submit]").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.mode; }));
  $("email-form").onsubmit = (e) => {
    e.preventDefault(); err();
    const em = $("email").value.trim(), pw = $("password").value;
    (mode === "signup" ? backend.signUp(em, pw) : backend.signIn(em, pw)).catch(err);
  };
  $("reset-btn").onclick = () => {
    const em = $("email").value.trim();
    if (!em) { $("auth-error").textContent = "הזינו אימייל ואז לחצו שוב"; return; }
    backend.reset(em).then(() => { $("auth-error").textContent = "נשלח מייל לאיפוס סיסמה"; }).catch(err);
  };
  $("logout-btn").onclick = () => backend.signOut();

  const shift = (n) => { editingStat = null; const d = new Date(viewY, viewM + n, 1); viewY = d.getFullYear(); viewM = d.getMonth(); render(); };
  $("prev-month").onclick = () => shift(-1);
  $("next-month").onclick = () => shift(1);
  $("today-btn").onclick = () => { goToCurrentPeriod(); render(); };

  $("reset-day").innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}${i === 30 ? " (או סוף החודש)" : ""}</option>`).join("");
  $("reset-day").onchange = async () => {
    const day = Number($("reset-day").value);
    try {
      await backend.saveSettings(user.uid, { resetDay: day });
      goToCurrentPeriod(); render();
      toast(`מעכשיו הכספים מתאפסים ב-${day} בכל חודש`);
    } catch (ex) { toast(ex.message, true); }
  };

  $("qa-fab").onclick = () => openQuick(true);
  $("qa-close").onclick = () => openQuick(false);
  $("qa-sheet").onclick = (e) => { if (e.target.id === "qa-sheet") openQuick(false); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("qa-sheet").classList.contains("hidden")) openQuick(false); });
  $("qa-cats").onclick = (e) => {
    const b = e.target.closest("[data-qcat]");
    if (!b) return;
    quickCat = b.dataset.qcat; renderQuickCats();
  };
  $("qa-form").onsubmit = async (e) => {
    e.preventDefault();
    const amount = Math.round(parseFloat($("qa-amount").value) * 100) / 100;
    const choice = quickChoices().find((x) => x.name === quickCat);
    if (!(amount > 0) || !choice) return;
    const btn = $("qa-form").querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await backend.addTransactions(user.uid, [{ type: choice.type, amount, description: $("qa-desc").value.trim(), category: choice.name, date: quickDate(), time: nowTime() }]);
      openQuick(false);
      toast(`נוספה ${choice.type === "income" ? "הכנסה" : "הוצאה"} של ${fmt(amount)} · ${choice.name}`);
    } catch (ex) { toast("שמירה נכשלה: " + ex.message, true); }
    btn.disabled = false;
  };

  $("tx-body").onclick = (e) => {
    if (e.target.closest(".tx-edit") && !e.target.closest("[data-txcancel],[data-del]")) return;
    const ed = e.target.closest("[data-txedit]");
    if (ed) { editingTx = ed.dataset.txedit; render(); document.querySelector(".tx-edit input[name=desc]")?.focus(); return; }
    if (e.target.closest("[data-txcancel]")) { editingTx = null; render(); return; }
    const btn = e.target.closest("[data-del]");
    if (!btn) return;
    confirmClick(btn, "למחוק?", async () => {
      const gone = txs.find((t) => t.id === btn.dataset.del);
      try {
        await backend.removeTransaction(user.uid, btn.dataset.del);
        editingTx = null; render();
        if (!gone) return;
        // Undo puts the same transaction back (with a new id)
        const { id, createdAt, ...data } = gone;
        toast("התנועה נמחקה", false, { label: "ביטול", run: () =>
          backend.addTransactions(user.uid, [data]).then(() => toast("התנועה הוחזרה")).catch((ex) => toast(ex.message, true)) });
      } catch (ex) { toast(ex.message, true); }
    });
  };


  // ----- Categories -----
  // Names must be unique within a kind; a fixed deduction may share a name with a personal-expense category
  const nameTaken = (name, exceptId, kind = "expense") =>
    liveCategories().some((c) => c.id !== exceptId && kindOf(c) === kind && c.name.trim().toLowerCase() === name.toLowerCase());

  const CAT_VALUE_PH = { income: "סכום קבוע כל חודש ₪ (לא חובה)", expense: "תקציב חודשי ₪ (לא חובה)" };
  $("cat-kind").onchange = () => { $("cat-budget").placeholder = CAT_VALUE_PH[$("cat-kind").value]; };
  $("cat-form").onsubmit = async (e) => {
    e.preventDefault();
    $("cat-error").textContent = "";
    const name = $("cat-name").value.trim();
    const kind = $("cat-kind").value;
    const value = Math.max(0, parseFloat($("cat-budget").value) || 0);
    if (!name) return;
    if (nameTaken(name)) { $("cat-error").textContent = "כבר יש קטגוריה בשם הזה"; return; }
    const cat = kind !== "expense"
      ? { id: newId(), name, kind, budget: 0, amounts: value > 0 ? [{ from: effectiveDate(viewKey()), amount: value }] : [] }
      : { id: newId(), name, kind, budget: value, amounts: [] };
    try {
      await saveCategories([...getCategories(), cat]);
      $("cat-name").value = ""; $("cat-budget").value = "";
      toast(`הקטגוריה "${name}" נוספה`);
    } catch (ex) { toast(ex.message, true); }
  };

  // ----- Typing the month's totals by hand -----
  const saveManual = async (kind, value) => {
    const all = JSON.parse(JSON.stringify(settings.manualTotals || {}));
    const key = viewKey();
    all[key] = { ...(all[key] || {}), [kind]: value };
    await backend.saveSettings(user.uid, { manualTotals: all });
  };
  $("stat-income").parentElement.addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-stat-edit]");
    if (ed) {
      editingStat = ed.dataset.statEdit; render();
      const inp = document.querySelector(`[data-stat-form="${editingStat}"] input`);
      if (inp) { inp.focus(); inp.select(); }
      return;
    }
    if (e.target.closest("[data-stat-cancel]")) { editingStat = null; render(); return; }
    const auto = e.target.closest("[data-stat-auto]");
    if (auto) {
      try { await saveManual(auto.dataset.statAuto, null); editingStat = null; render(); toast("חזרה לחישוב האוטומטי מהקטגוריות"); }
      catch (ex) { toast(ex.message, true); }
    }
  });
  $("stat-income").parentElement.addEventListener("submit", async (e) => {
    e.preventDefault();
    const kind = e.target.dataset.statForm;
    if (!kind) return;
    const raw = e.target.v.value.trim();
    const value = raw === "" ? null : Math.max(0, Math.round(parseFloat(raw) * 100) / 100);
    try {
      await saveManual(kind, isNum(value) ? value : null);
      editingStat = null; render();
      toast(isNum(value) ? `${STAT_LABELS[kind]}: ${fmt(value)}${kind === "income" ? " (גם בחודשים הבאים)" : ""}` : "חזרה לחישוב האוטומטי");
    } catch (ex) { toast(ex.message, true); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !(editingStat || editingDeduct || editingTx)) return;
    editingStat = null; editingDeduct = null; editingTx = null; render();
  });

  $("save-btn").onclick = () => { savingsOpen = !savingsOpen; render(); if (savingsOpen) $("save-panel").scrollIntoView({ behavior: "smooth", block: "nearest" }); };

  // ----- Deductions drawer -----
  const stats = $("stat-income").parentElement;
  stats.addEventListener("click", (e) => {
    const ed = e.target.closest("[data-dedit]");
    if (ed) {
      editingDeduct = ed.dataset.dedit; render();
      document.querySelector(`[data-dform="${CSS.escape(editingDeduct)}"] input`)?.focus();
      return;
    }
    if (e.target.closest("[data-dcancel]")) { editingDeduct = null; render(); return; }
    const del = e.target.closest("[data-ddel]");
    if (del) {
      confirmClick(del, "בטוח?", async () => {
        const cat = getCategories().find((c) => c.id === del.dataset.ddel);
        try {
          await saveCategories(getCategories().filter((c) => c.id !== del.dataset.ddel));
          editingDeduct = null; render();
          toast(`"${cat ? cat.name : ""}" נמחקה מהרשימה`);
        } catch (ex) { toast(ex.message, true); }
      });
      return;
    }
    if (!e.target.closest("[data-drawer]")) return;
    drawerOpen = !drawerOpen;
    try { localStorage.setItem("cashflow-drawer", drawerOpen ? "1" : "0"); } catch {}
    render();
  });
  stats.addEventListener("change", async (e) => {
    const sw = e.target.closest("[data-autopaid]");
    if (sw) {
      try {
        const patch = { autoPaid: sw.checked };
        if (sw.checked) {
          // Turning it on starts fresh: old "unticked by hand" marks on deductions with a day are cleared,
          // so they follow their day. Unticking one after the switch is on is still remembered.
          const withDay = new Set(getCategories().filter((c) => isFixed(c) && dayOk(c.day)).map((c) => c.id));
          const all = JSON.parse(JSON.stringify(settings.paid || {}));
          for (const k of Object.keys(all)) for (const id of Object.keys(all[k] || {})) if (all[k][id] === false && withDay.has(id)) all[k][id] = null; // null = "not decided by hand"
          patch.paid = all;
        }
        await backend.saveSettings(user.uid, patch);
        toast(sw.checked ? "סימון אוטומטי פועל: הורדות עם תאריך יסומנו לבד ביום שלהן" : "סימון אוטומטי כבוי");
      } catch (ex) { toast(ex.message, true); sw.checked = !sw.checked; }
      return;
    }
    const box = e.target.closest("[data-paid]");
    if (!box) return;
    const all = JSON.parse(JSON.stringify(settings.paid || {}));
    const key = viewKey();
    // Remember when it was ticked, so a deduction without a day shows up in the list on that date.
    // Ticking in a month that is over (or not started) dates it at that month's end (or start).
    let when = false;
    if (box.checked) {
      const [s, e] = rangeOfKey(key);
      const today = todayStr();
      when = today < ymd(s) ? ymd(s) : today > ymd(e) ? ymd(e) : today + " " + nowTime();
    }
    all[key] = { ...(all[key] || {}), [box.dataset.paid]: when };
    try { await backend.saveSettings(user.uid, { paid: all }); }
    catch (ex) { toast(ex.message, true); box.checked = !box.checked; }
  });
  stats.addEventListener("submit", async (e) => {
    const df = e.target.closest("[data-dform]");
    if (df) {
      e.preventDefault();
      const id = df.dataset.dform;
      const name = df.name.value.trim();
      const amount = Math.max(0, parseFloat(df.amount.value) || 0);
      if (!name) return;
      if (df.day.value && !dayOk(df.day.value)) { toast("יום ההורדה צריך להיות בין 1 ל-31", true); return; }
      if (nameTaken(name, id, "fixed")) { toast("כבר יש הורדה בשם הזה", true); return; }
      const old = getCategories().find((c) => c.id === id);
      try {
        await saveCategories(getCategories().map((c) => (c.id === id ? { ...c, name, icon: df.icon ? df.icon.value : c.icon, amounts: setFixedAmount(c, amount), day: dayOk(df.day.value) } : c)));
        editingDeduct = null; render();
        toast("נשמר");
      } catch (ex) { toast(ex.message, true); }
      return;
    }
    if (e.target.id !== "drawer-add") return;
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    const amount = Math.max(0, parseFloat(f.amount.value) || 0);
    if (!name) return;
    if (f.day.value && !dayOk(f.day.value)) { toast("יום ההורדה צריך להיות בין 1 ל-31", true); return; }
    if (nameTaken(name, null, "fixed")) { toast("כבר יש הורדה בשם הזה", true); return; }
    const cat = { id: newId(), name, kind: "fixed", budget: 0, amounts: amount > 0 ? [{ from: effectiveDate(viewKey()), amount }] : [], day: dayOk(f.day.value) };
    try {
      await saveCategories([...getCategories(), cat]);
      toast(`"${name}" נוספה להורדות הקבועות`);
      document.querySelector("#drawer-add input[name=name]")?.focus();
    } catch (ex) { toast(ex.message, true); }
  });

  // Income entered from the month's transactions card is added to the month's income
  $("tx-body").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".tx-item[data-txedit]")) { e.preventDefault(); e.target.click(); }
  });
  $("tx-body").addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-txform]");
    if (!f) return;
    e.preventDefault();
    const amount = Math.round(parseFloat(f.amount.value) * 100) / 100;
    if (!(amount > 0) || !f.date.value) return;
    const data = { date: f.date.value, time: f.time.value || nowTime(), description: f.desc.value.trim(), category: f.category.value, amount };
    try {
      await backend.updateTransaction(user.uid, f.dataset.txform, data);
      editingTx = null;
      // Follow the transaction if it moved to another month
      const [y, m] = periodOf(data.date).split("-").map(Number);
      viewY = y; viewM = m - 1; render();
      toast("התנועה עודכנה");
    } catch (ex) { toast("שמירה נכשלה: " + ex.message, true); }
  });

  $("tx-income-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const amount = Math.round(parseFloat(f.amount.value) * 100) / 100;
    if (!(amount > 0)) return;
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      await backend.addTransactions(user.uid, [{ type: "income", amount, description: f.desc.value.trim(), category: "הכנסה", date: quickDate(), time: nowTime() }]);
      f.reset();
      toast(`נוספה הכנסה של ${fmt(amount)} להכנסות החודש`);
    } catch (ex) { toast("שמירה נכשלה: " + ex.message, true); }
    finally { if (btn) btn.disabled = false; }
  };

  $("unplanned-form").onsubmit = async (e) => {
    e.preventDefault();
    const amount = Math.round(parseFloat($("un-amount").value) * 100) / 100;
    if (!(amount > 0)) return;
    const type = $("un-type").value;
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      await backend.addTransactions(user.uid, [{ type, amount, description: $("un-desc").value.trim(), category: UNPLANNED, date: quickDate(), time: nowTime() }]);
      $("un-amount").value = ""; $("un-desc").value = ""; $("un-type").value = "expense";
      toast(`נוספה ${type === "income" ? "הכנסה" : "הוצאה"} לא צפויה של ${fmt(amount)}`);
    } catch (ex) { toast("שמירה נכשלה: " + ex.message, true); }
    finally { if (btn) btn.disabled = false; }
  };

  $("cat-tiles").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const cats = getCategories();

    if (f.dataset.quick) {
      const cat = cats.find((c) => c.id === f.dataset.quick);
      const amount = Math.round(parseFloat(f.amount.value) * 100) / 100;
      if (!cat || !(amount > 0)) return;
      f.querySelector("button").disabled = true;
      try {
        const type = isIncome(cat) ? "income" : "expense";
        await backend.addTransactions(user.uid, [{ type, amount, description: f.desc.value.trim(), category: cat.name, date: quickDate(), time: nowTime() }]);
        toast(`נוספה ${type === "income" ? "הכנסה" : "הוצאה"} של ${fmt(amount)} ב${cat.name}`);
      } catch (ex) { toast("שמירה נכשלה: " + ex.message, true); f.querySelector("button").disabled = false; }
      return;
    }

    if (f.dataset.editform) {
      const id = f.dataset.editform;
      const name = f.name.value.trim();
      if (!name) return;
      if (nameTaken(name, id, f.kind ? f.kind.value : "expense")) { toast("כבר יש קטגוריה בשם הזה", true); return; }
      const old = cats.find((c) => c.id === id);
      const update = (c) => {
        const kind = f.kind ? f.kind.value : kindOf(c);
        c = { ...c, icon: f.icon ? f.icon.value : c.icon };
        const amount = f.fixed ? Math.max(0, parseFloat(f.fixed.value) || 0) : 0;
        if (kind === "fixed") return { ...c, name, kind, amounts: setFixedAmount(c, amount) };
        if (kind === "income") return { ...c, name, kind, amounts: withAmountFrom(c, viewKey(), amount) };
        return { ...c, name, kind, budget: Math.max(0, parseFloat(f.budget.value) || 0) };
      };
      try {
        await saveCategories(cats.map((c) => (c.id === id ? update(c) : c)));
        // Keep existing expenses attached to a renamed category
        if (old && old.name !== name && backend.renameCategory) await backend.renameCategory(user.uid, old.name, name);
        editingCat = null; render();
      } catch (ex) { toast(ex.message, true); }
    }
  });

  $("cat-tiles").addEventListener("change", (e) => {
    const sel = e.target.closest("[data-kind-switch]");
    if (!sel) return;
    const f = sel.form;
    f.querySelector(".edit-fixed").classList.toggle("hidden", sel.value === "expense");
    f.querySelector(".edit-budget").classList.toggle("hidden", sel.value !== "expense");
  });

  $("cat-tiles").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-edit]");
    if (edit) { editingCat = edit.dataset.edit; render(); $("cat-tiles").querySelector(".tile-edit input")?.focus(); return; }
    if (e.target.closest("[data-cancel]")) { editingCat = null; render(); return; }
    // Tapping a category card (or its + button) opens quick add with that category picked
    const qadd = e.target.closest("[data-qadd]");
    if (qadd && !e.target.closest(".tile-edit")) { openQuick(true, qadd.dataset.qadd); return; }
    const del = e.target.closest("[data-delcat]");
    if (del) {
      confirmClick(del, "בטוח?", async () => {
        try {
          // Keep the category in earlier periods if it has history there; otherwise remove it outright.
          const from = effectiveDate(viewKey());
          const cat = getCategories().find((c) => c.id === del.dataset.delcat);
          const hasHistory = cat && !isFixed(cat) && ((cat.amounts || []).some((h) => asDate(h.from) < from) || txs.some((t) => t.category === cat.name && t.date < from));
          const cats = hasHistory
            ? getCategories().map((c) => (c.id === cat.id ? { ...c, deletedFrom: from } : c))
            : getCategories().filter((c) => c.id !== del.dataset.delcat);
          await saveCategories(cats);
          editingCat = null; render();
          toast(hasHistory ? "הקטגוריה נמחקה מהחודש הזה והלאה. חודשים קודמים לא משתנים" : "הקטגוריה נמחקה");
        } catch (ex) { toast(ex.message, true); }
      });
    }
  });

  $("export-btn").onclick = () => {
    const rows = [["תאריך", "שעה", "סוג", "תיאור", "קטגוריה", "סכום"]];
    [...txs].sort(byDateTime).forEach((t) =>
      rows.push([t.date, txTime(t), t.type === "income" ? "הכנסה" : "הוצאה", t.description || "", t.category, signed(t)]));
    const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "cashflow.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
}


// ---------- Colors (per user) ----------
const THEME_MODES = [
  { id: "auto", label: "אוטומטי", sw: "linear-gradient(135deg,#f5f6f8 50%,#0f1218 50%)" },
  { id: "light", label: "בהיר", sw: "#f5f6f8" },
  { id: "dark", label: "כהה", sw: "#181c24" },
];
// Each color paints the whole site: background, boxes, borders and buttons
const ACCENTS = [
  { id: "none", label: "ללא צבע", c: "#2563eb", neutral: true },
  { id: "blue", label: "כחול", c: "#2563eb" }, { id: "sky", label: "תכלת", c: "#0284c7" }, { id: "teal", label: "טורקיז", c: "#0d9488" },
  { id: "green", label: "ירוק", c: "#16a34a" }, { id: "lime", label: "ליים", c: "#65a30d" }, { id: "amber", label: "צהוב", c: "#d97706" },
  { id: "orange", label: "כתום", c: "#ea580c" }, { id: "red", label: "אדום", c: "#dc2626" }, { id: "pink", label: "ורוד", c: "#db2777" },
  { id: "purple", label: "סגול", c: "#9333ea" }, { id: "indigo", label: "אינדיגו", c: "#4f46e5" }, { id: "brown", label: "חום", c: "#92400e" },
  { id: "olive", label: "זית", c: "#4d7c0f" }, { id: "wine", label: "בורדו", c: "#9f1239" }, { id: "slate", label: "אפור", c: "#64748b" },
];
// Ready-made themes: background, category cards in a matching shade, and buttons in a contrasting color
const PRESETS = [
  { id: "ocean", label: "אוקיינוס", dark: true, v: { bg: "#0b1f3a", card: "#12305a", tile: "#1b4278", border: "#24508c", text: "#eaf2ff", muted: "#9fb6d8", primary: "#22c55e", "primary-ink": "#04230f", pos: "#4ade80", neg: "#fb7185", bal: "#4ade80", "in-bar": "#34d399", "out-bar": "#fb7185" } },
  { id: "royal", label: "כחול מלכותי", dark: true, v: { bg: "#111a4a", card: "#1b2766", tile: "#26358a", border: "#33449e", text: "#eef1ff", muted: "#aab4e6", primary: "#22d3ee", "primary-ink": "#04222a", pos: "#4ade80", neg: "#fda4af", bal: "#22d3ee", "in-bar": "#34d399", "out-bar": "#fda4af" } },
  { id: "forest", label: "יער", dark: true, v: { bg: "#0d2419", card: "#143524", tile: "#1d4a33", border: "#27593f", text: "#ecf8f0", muted: "#9cc4ab", primary: "#f97316", "primary-ink": "#ffffff", pos: "#86efac", neg: "#fca5a5", bal: "#fdba74", "in-bar": "#4ade80", "out-bar": "#fb923c" } },
  { id: "sunset", label: "שקיעה", dark: true, v: { bg: "#2a0f2e", card: "#3b1740", tile: "#522057", border: "#64296a", text: "#fdf0fb", muted: "#d6a9d3", primary: "#fbbf24", "primary-ink": "#2a1700", pos: "#6ee7b7", neg: "#fb7185", bal: "#fbbf24", "in-bar": "#34d399", "out-bar": "#fb7185" } },
  { id: "coffee", label: "קפה", dark: true, v: { bg: "#24180f", card: "#33241a", tile: "#463224", border: "#58402e", text: "#f8efe6", muted: "#c9ae94", primary: "#e9b872", "primary-ink": "#2a1a08", pos: "#a3e635", neg: "#f87171", bal: "#e9b872", "in-bar": "#84cc16", "out-bar": "#f87171" } },
  { id: "midnight", label: "חצות", dark: true, v: { bg: "#050505", card: "#121212", tile: "#1d1d1d", border: "#2a2a2a", text: "#f2f2f2", muted: "#9a9a9a", primary: "#a3e635", "primary-ink": "#132000", pos: "#4ade80", neg: "#f87171", bal: "#a3e635", "in-bar": "#4ade80", "out-bar": "#f87171" } },
  { id: "sky", label: "שמיים", dark: false, v: { bg: "#dbeefe", card: "#f2f9ff", tile: "#c9e4fb", border: "#b3d4f1", text: "#0c2440", muted: "#4d6b8a", primary: "#f97316", "primary-ink": "#ffffff", pos: "#15803d", neg: "#c2410c", bal: "#2563eb", "in-bar": "#22a55a", "out-bar": "#f97316" } },
  { id: "lavender", label: "לבנדר", dark: false, v: { bg: "#ece7fd", card: "#f8f6ff", tile: "#ddd4fb", border: "#cbbef3", text: "#24164a", muted: "#6b5c96", primary: "#7c3aed", "primary-ink": "#ffffff", pos: "#15803d", neg: "#be123c", bal: "#7c3aed", "in-bar": "#22a55a", "out-bar": "#e11d48" } },
  { id: "mint", label: "מנטה", dark: false, v: { bg: "#d9f7e6", card: "#f2fdf6", tile: "#c3efd6", border: "#a8e0c1", text: "#0d2e1f", muted: "#4b7a62", primary: "#0f766e", "primary-ink": "#ffffff", pos: "#15803d", neg: "#c2410c", bal: "#0f766e", "in-bar": "#16a34a", "out-bar": "#ea580c" } },
  { id: "peach", label: "אפרסק", dark: false, v: { bg: "#ffe8dc", card: "#fff7f2", tile: "#ffd8c4", border: "#f6c3a8", text: "#3b1d10", muted: "#8a5e4a", primary: "#0e7490", "primary-ink": "#ffffff", pos: "#15803d", neg: "#be123c", bal: "#0e7490", "in-bar": "#16a34a", "out-bar": "#e11d48" } },
];
const PRESET_KEYS = ["bg", "card", "tile", "border", "text", "muted", "primary", "primary-ink", "pos", "neg", "bal", "in-bar", "out-bar"];
let theme = { mode: "dark", accent: "none", preset: null };
try { theme = { ...theme, ...JSON.parse(localStorage.getItem("cashflow-theme") || "{}") }; } catch {}
const darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
// Older choices: "night" was dark blue, "cream" was light amber, "slate" was gray
function normalizeTheme(t) {
  const out = { ...t };
  if (out.mode === "night") { out.mode = "dark"; if (!out.accent || out.accent === "none") out.accent = "blue"; }
  if (out.mode === "cream") { out.mode = "light"; if (!out.accent || out.accent === "none") out.accent = "amber"; }
  if (!THEME_MODES.some((m) => m.id === out.mode)) out.mode = "dark";
  if (!ACCENTS.some((a) => a.id === out.accent)) out.accent = "none";
  if (out.preset && !PRESETS.some((p) => p.id === out.preset)) out.preset = null;
  return out;
}
theme = normalizeTheme(theme);

function applyTheme() {
  const root = document.documentElement;
  PRESET_KEYS.forEach((k) => root.style.removeProperty("--" + k));
  delete root.dataset.preset;
  const preset = PRESETS.find((p) => p.id === theme.preset);
  if (preset) {
    root.dataset.theme = preset.dark ? "dark" : "light";
    root.dataset.preset = preset.id;
    delete root.dataset.tint; root.style.removeProperty("--tint");
    PRESET_KEYS.forEach((k) => root.style.setProperty("--" + k, preset.v[k]));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = preset.v.card;
    renderThemePicker();
    return;
  }
  const mode = theme.mode === "auto" ? (darkMq && darkMq.matches ? "dark" : "light") : theme.mode;
  root.dataset.theme = mode;
  const acc = ACCENTS.find((a) => a.id === theme.accent) || ACCENTS[0];
  if (acc.neutral) { delete root.dataset.tint; root.style.removeProperty("--tint"); root.style.removeProperty("--primary"); root.style.removeProperty("--bal"); }
  else { root.dataset.tint = acc.id; root.style.setProperty("--tint", acc.c); root.style.setProperty("--primary", acc.c); root.style.setProperty("--bal", acc.c); }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--card").trim() || "#181c24";
  renderThemePicker();
}
function renderThemePicker() {
  const modes = $("theme-modes"), accents = $("theme-accents");
  if (!modes) return;
  $("theme-presets").innerHTML = PRESETS.map((p) => `<button type="button" class="preset-btn ${theme.preset === p.id ? "on" : ""}" data-preset="${p.id}" aria-pressed="${theme.preset === p.id}">
      <span class="preset-sw" style="background:${p.v.bg};border-color:${p.v.border}">
        <span class="preset-tile" style="background:${p.v.tile}"></span><span class="preset-tile" style="background:${p.v.tile}"></span>
        <span class="preset-btnsw" style="background:${p.v.primary}"></span>
      </span><span class="acc-label">${p.label}</span></button>`).join("");
  modes.innerHTML = THEME_MODES.map((m) => `<button type="button" class="mode-btn ${!theme.preset && theme.mode === m.id ? "on" : ""}" data-mode="${m.id}" aria-pressed="${theme.mode === m.id}">
      <span class="mode-sw" style="background:${m.sw}"></span>${m.label}</button>`).join("");
  const dark = document.documentElement.dataset.theme === "dark";
  accents.innerHTML = ACCENTS.map((a) => {
    const bg = a.neutral ? (dark ? "#0f1218" : "#f5f6f8") : `color-mix(in srgb, ${a.c} ${dark ? 22 : 16}%, ${dark ? "#05070b" : "#ffffff"})`;
    return `<button type="button" class="acc-btn ${!theme.preset && theme.accent === a.id ? "on" : ""}" data-accent="${a.id}" style="--c:${a.c};--bgc:${bg}" aria-pressed="${theme.accent === a.id}">
      <span class="acc-sw"><span class="acc-dot"></span></span><span class="acc-label">${a.label}</span></button>`;
  }).join("");
}
function setTheme(patch) {
  theme = { ...theme, ...patch };
  try { localStorage.setItem("cashflow-theme", JSON.stringify(theme)); } catch {}
  applyTheme();
  // Saved to the account too, so the same colors follow the user to every device
  if (user && backend) backend.saveSettings(user.uid, { theme }).catch(() => {});
}
function wireTheme() {
  const btn = $("theme-btn"), pop = $("theme-pop");
  const close = () => { pop.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); };
  btn.onclick = (e) => { e.stopPropagation(); const open = pop.classList.toggle("hidden") === false; btn.setAttribute("aria-expanded", String(open)); };
  pop.onclick = (e) => {
    e.stopPropagation();
    const pr = e.target.closest("[data-preset]"); if (pr) setTheme({ preset: pr.dataset.preset });
    const m = e.target.closest("[data-mode]"); if (m) setTheme({ mode: m.dataset.mode, preset: null });
    const a = e.target.closest("[data-accent]"); if (a) setTheme({ accent: a.dataset.accent, preset: null });
  };
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  if (darkMq && darkMq.addEventListener) darkMq.addEventListener("change", () => theme.mode === "auto" && applyTheme());
}
applyTheme();

// ---------- Stay up to date ----------
// GitHub Pages lets browsers keep the page for up to 10 minutes. On open (and when the app comes back
// to the foreground) we fetch index.html fresh; if it points to a newer app.js, reload once onto it.
const MY_VERSION = new URL(import.meta.url).searchParams.get("v") || "";
async function checkForUpdate() {
  try {
    const res = await fetch(`./index.html?check=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const latest = ((await res.text()).match(/app\.js\?v=([\w.-]+)/) || [])[1];
    if (!latest || !MY_VERSION || latest === MY_VERSION) return;
    const key = "cashflow-reloaded-to";
    if (sessionStorage.getItem(key) === latest) return; // never loop
    sessionStorage.setItem(key, latest);
    const url = new URL(location.href);
    url.searchParams.set("v", latest);
    location.replace(url.toString());
  } catch {}
}
if (!DEMO) {
  checkForUpdate();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
}

// ---------- Boot ----------
(async () => {
  try {
    backend = DEMO ? createDemoBackend() : await createFirebaseBackend();
  } catch (e) {
    $("loading").textContent = "טעינת Firebase נכשלה: " + e.message;
    return;
  }
  if (DEMO) $("demo-banner").classList.remove("hidden");
  wireEvents();
  wireTheme();
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => user && render(), 150); });
  backend.onAuth(onUser);
})();
