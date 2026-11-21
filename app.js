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
      return F.onSnapshot(txCol(uid), (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    },
    watchSettings(uid, cb) {
      return F.onSnapshot(userDoc(uid), (d) => cb(d.exists() ? d.data() : {}));
    },
    async addTransactions(uid, list) {
      const batch = F.writeBatch(db);
      for (const t of list) batch.set(F.doc(txCol(uid)), { ...t, createdAt: Date.now() });
      await batch.commit();
    },
    removeTransaction: (uid, id) => F.deleteDoc(F.doc(db, "users", uid, "transactions", id)),
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
      setTimeout(() => cb([...userData(uid).tx]));
      return () => { listeners.tx = []; };
    },
    watchSettings(uid, cb) {
      listeners.settings = [cb];
      setTimeout(() => cb({ ...userData(uid).settings }));
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
const now = new Date();
let viewY = now.getFullYear();
let viewM = now.getMonth();

// ---------- Render ----------
function render() {
  const key = monthKey(viewY, viewM);
  $("month-label").textContent = `${HE_MONTHS[viewM]} ${viewY}`;

  const opening = Number(settings.openingBalance || 0);
  const sorted = [...txs].sort(byDateTime);
  const before = sorted.filter((t) => t.date.slice(0, 7) < key).reduce((s, t) => s + signed(t), 0);
  const monthTx = sorted.filter((t) => t.date.slice(0, 7) === key);
  const income = monthTx.filter((t) => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);
  const expense = monthTx.filter((t) => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
  const open = opening + before;
  const close = open + income - expense;

  $("s-open").textContent = fmt(open);
  $("s-in").textContent = fmt(income);
  $("s-out").textContent = fmt(expense);
  $("s-close").textContent = fmt(close);
  $("s-close").className = "stat-value " + (close < 0 ? "neg" : "");
  $("s-open").className = "stat-value " + (open < 0 ? "neg" : "");

  // Table
  let bal = open;
  const today = todayStr();
  $("tx-body").innerHTML = monthTx.map((t) => {
    bal += signed(t);
    const [y, m, d] = t.date.split("-");
    return `<tr class="${t.date > today ? "future" : ""}">
      <td>${d}/${m}/${y.slice(2)}</td>
      <td class="time">${txTime(t) || `<span class="muted">—</span>`}</td>
      <td class="desc">${t.description ? esc(t.description) : `<span class="muted">—</span>`}</td>
      <td><span class="tag">${esc(t.category)}</span></td>
      <td class="num ${t.type === "income" ? "pos" : "neg"}">${t.type === "income" ? "+" : "−"}${fmt(Number(t.amount))}</td>
      <td class="num ${bal < 0 ? "neg" : ""}">${fmt(bal)}</td>
      <td><button class="icon-btn" data-del="${esc(t.id)}" title="מחיקה" aria-label="מחיקה">✕</button></td>
    </tr>`;
  }).join("");
  $("empty").classList.toggle("hidden", monthTx.length > 0);

  renderCategories(monthTx);

  if (document.activeElement !== $("opening")) $("opening").value = opening || "";

  renderChart(sorted, opening);
}


const DEFAULT_CATS = [
  { name: "משכורת", kind: "income" },
  ...["מזון", "שכירות", "חשבונות", "רכב", "בילויים", "אחר"].map((name) => ({ name, kind: "expense" })),
];
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
let editingCat = null;
const isIncome = (c) => c.kind === "income";

// Categories live in the user's settings doc. Until the user edits them, show defaults (unsaved).
function getCategories() {
  if (Array.isArray(settings.categories)) return settings.categories;
  return DEFAULT_CATS.map((c) => ({ id: "default-" + c.name, budget: 0, ...c }));
}
const saveCategories = (cats) =>
  backend.saveSettings(user.uid, {
    categories: cats.map(({ id, name, budget, kind }) => ({ id, name, kind: kind === "income" ? "income" : "expense", budget: kind === "income" ? 0 : Number(budget) || 0 })),
  });

function renderCategories(monthTx) {
  // Income categories first, then expenses
  const cats = [...getCategories()].sort((a, b) => Number(isIncome(b)) - Number(isIncome(a)));
  const sumBy = { income: {}, expense: {} };
  monthTx.forEach((t) => { const m = sumBy[t.type]; if (m) m[t.category] = (m[t.category] || 0) + Number(t.amount); });

  let totBudget = 0, totSpent = 0;
  $("cat-tiles").innerHTML = cats.map((c) => {
    const income = isIncome(c);
    const spent = sumBy[income ? "income" : "expense"][c.name] || 0;
    const budget = income ? 0 : Number(c.budget) || 0;
    const id = esc(c.id);
    if (budget > 0) { totBudget += budget; totSpent += spent; }

    if (editingCat === c.id) {
      return `<div class="tile editing">
        <form class="tile-edit" data-editform="${id}">
          <label>שם<input name="name" maxlength="40" required value="${esc(c.name)}" /></label>
          ${income ? "" : `<label>תקציב חודשי (₪)<input name="budget" type="number" min="0" step="1" inputmode="decimal" value="${budget || ""}" placeholder="ללא תקציב" /></label>`}
          <div class="row gap">
            <button type="submit" class="btn btn-primary btn-sm grow">שמירה</button>
            <button type="button" class="btn btn-ghost btn-sm" data-cancel>ביטול</button>
            <button type="button" class="btn btn-ghost btn-sm danger" data-delcat="${id}">מחיקה</button>
          </div>
        </form>
      </div>`;
    }

    const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
    const left = budget - spent;
    const level = budget > 0 && spent > budget ? "over" : pct >= 85 ? "warn" : "";
    const status = income
      ? `<span class="pos">התקבל החודש</span>`
      : budget > 0
        ? (left >= 0 ? `<span>נשאר <b>${fmt(left)}</b></span>` : `<span class="neg">חריגה של <b>${fmt(-left)}</b></span>`)
        : `<span class="muted">ללא תקציב</span>`;
    const verb = income ? "הכנסה" : "הוצאה";
    return `<div class="tile ${income ? "income" : level}">
      <div class="tile-head"><strong>${esc(c.name)}</strong><span class="kind ${income ? "pos" : "neg"}">${income ? "הכנסה" : "הוצאה"}</span><button class="icon-btn" data-edit="${id}" title="עריכה" aria-label="עריכת ${esc(c.name)}">✎</button></div>
      <div class="tile-nums"><span class="num-big ${income ? "pos" : ""}">${fmt(spent)}</span>${budget > 0 ? `<span class="muted">מתוך ${fmt(budget)}</span>` : ""}</div>
      ${budget > 0 ? `<div class="cat-bar"><div class="${level}" style="width:${pct}%"></div></div>` : ""}
      <div class="tile-status">${status}</div>
      <form class="quick" data-quick="${id}">
        <input name="desc" maxlength="100" placeholder="תיאור ה${verb}" aria-label="תיאור ה${verb} (לא חובה)" />
        <div class="quick-row">
          <input name="amount" type="number" step="0.01" min="0.01" required inputmode="decimal" placeholder="סכום ₪" aria-label="סכום ה${verb} ב${esc(c.name)}" />
          <button type="submit" class="btn btn-primary btn-sm">+ ${verb}</button>
        </div>
      </form>
    </div>`;
  }).join("") || `<p class="muted">אין קטגוריות עדיין. הוסיפו את הראשונה למטה.</p>`;

  $("budget-total").innerHTML = totBudget > 0 ? `הוצאתם ${fmt(totSpent)} מתוך תקציב של ${fmt(totBudget)}` : "";
}

// Date used for expenses entered from a category tile: today, or the 1st of the viewed month.
function quickDate() {
  const d = new Date();
  return d.getFullYear() === viewY && d.getMonth() === viewM ? ymd(d) : `${monthKey(viewY, viewM)}-01`;
}

let toastTimer;
function toast(msg, isError) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error-toast" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2800);
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

function renderChart(sorted, opening) {
  // 12 months: 5 before the viewed month, the viewed month, and 6 after
  const months = [];
  for (let i = -5; i <= 6; i++) {
    const d = new Date(viewY, viewM + i, 1);
    months.push({ key: monthKey(d.getFullYear(), d.getMonth()), label: HE_MONTHS[d.getMonth()].slice(0, 3) + "׳" + String(d.getFullYear()).slice(2), inc: 0, out: 0 });
  }
  const first = months[0].key;
  let bal = opening + sorted.filter((t) => t.date.slice(0, 7) < first).reduce((s, t) => s + signed(t), 0);
  const idx = Object.fromEntries(months.map((m, i) => [m.key, i]));
  for (const t of sorted) {
    const i = idx[t.date.slice(0, 7)];
    if (i === undefined) continue;
    if (t.type === "income") months[i].inc += Number(t.amount); else months[i].out += Number(t.amount);
  }
  for (const m of months) { bal += m.inc - m.out; m.bal = bal; }

  const W = Math.max(480, Math.round($("chart").clientWidth) || 640), H = 260, L = 48, R = 8, T = 12, B = 28;
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
      <text x="${cx(i)}" y="${H - 8}" text-anchor="middle" style="${sel ? "font-weight:700;fill:var(--text)" : ""}">${m.label}</text>`;
  }).join("");
  const line = months.map((m, i) => `${i ? "L" : "M"}${cx(i)},${y(m.bal)}`).join(" ");
  const dots = months.map((m, i) => `<circle cx="${cx(i)}" cy="${y(m.bal)}" r="3" fill="var(--bal)"><title>${m.label}: יתרה ${fmt(m.bal)}</title></circle>`).join("");

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
  unsub.push(backend.watchTransactions(u.uid, (list) => { txs = list; render(); }));
  unsub.push(backend.watchSettings(u.uid, (s) => { settings = s || {}; render(); }));
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

  const shift = (n) => { const d = new Date(viewY, viewM + n, 1); viewY = d.getFullYear(); viewM = d.getMonth(); render(); };
  $("prev-month").onclick = () => shift(-1);
  $("next-month").onclick = () => shift(1);
  $("today-btn").onclick = () => { const d = new Date(); viewY = d.getFullYear(); viewM = d.getMonth(); render(); };

  $("tx-body").onclick = (e) => {
    const btn = e.target.closest("[data-del]");
    if (!btn) return;
    confirmClick(btn, "למחוק?", () =>
      backend.removeTransaction(user.uid, btn.dataset.del).catch((ex) => toast(ex.message, true)));
  };

  $("opening").onchange = () => {
    const v = parseFloat($("opening").value) || 0;
    backend.saveSettings(user.uid, { openingBalance: v }).catch((ex) => toast(ex.message, true));
  };

  // ----- Categories -----
  const nameTaken = (name, exceptId) =>
    getCategories().some((c) => c.id !== exceptId && c.name.trim().toLowerCase() === name.toLowerCase());

  $("cat-kind").onchange = () => $("cat-budget").classList.toggle("hidden", $("cat-kind").value === "income");
  $("cat-form").onsubmit = async (e) => {
    e.preventDefault();
    $("cat-error").textContent = "";
    const name = $("cat-name").value.trim();
    const kind = $("cat-kind").value;
    const budget = kind === "income" ? 0 : Math.max(0, parseFloat($("cat-budget").value) || 0);
    if (!name) return;
    if (nameTaken(name)) { $("cat-error").textContent = "כבר יש קטגוריה בשם הזה"; return; }
    try {
      await saveCategories([...getCategories(), { id: newId(), name, kind, budget }]);
      $("cat-name").value = ""; $("cat-budget").value = "";
      toast(`הקטגוריה "${name}" נוספה`);
    } catch (ex) { toast(ex.message, true); }
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
      const budget = f.budget ? Math.max(0, parseFloat(f.budget.value) || 0) : 0;
      if (!name) return;
      if (nameTaken(name, id)) { toast("כבר יש קטגוריה בשם הזה", true); return; }
      const old = cats.find((c) => c.id === id);
      try {
        await saveCategories(cats.map((c) => (c.id === id ? { ...c, name, budget } : c)));
        // Keep existing expenses attached to a renamed category
        if (old && old.name !== name && backend.renameCategory) await backend.renameCategory(user.uid, old.name, name);
        editingCat = null; render();
      } catch (ex) { toast(ex.message, true); }
    }
  });

  $("cat-tiles").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-edit]");
    if (edit) { editingCat = edit.dataset.edit; render(); $("cat-tiles").querySelector(".tile-edit input")?.focus(); return; }
    if (e.target.closest("[data-cancel]")) { editingCat = null; render(); return; }
    const del = e.target.closest("[data-delcat]");
    if (del) {
      confirmClick(del, "בטוח?", async () => {
        try {
          await saveCategories(getCategories().filter((c) => c.id !== del.dataset.delcat));
          editingCat = null; render();
          toast("הקטגוריה נמחקה. ההוצאות שכבר נרשמו בה נשארות");
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
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => user && render(), 150); });
  backend.onAuth(onUser);
})();
