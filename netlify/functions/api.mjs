import { getStore } from "@netlify/blobs";
import { randomUUID } from "crypto";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "00000";
const SNAP_PASSWORD = process.env.SNAP_PASSWORD ?? "00000";
const SHEET_URL_USERS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQUOmxLN_--OjkRvb543vpKK5wyL-zcNl67dfDlCPzN28tuBXD2IDEhyJxR8yKqC7CvcHGVj5tSPAD2/pub?gid=0&single=true&output=csv";

// ============================================================
// IN-MEMORY CACHE (module-level, survives warm Netlify instances)
// ============================================================
const _memCache = new Map();
const _CACHE_TTL = 5 * 60 * 1000;

const _CACHEABLE = new Set([
  "price-snapshot-current","price-snapshot-prev","price-snapshot-highest",
  "promo-excluded","company-location","maintenance","bblm-status","sync-meta",
  "users","bblm"
]);

function cacheGet(key) {
  const e = _memCache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) { _memCache.delete(key); return undefined; }
  return e.val;
}
function cacheSet(key, val) {
  _memCache.set(key, { val, exp: Date.now() + _CACHE_TTL });
}
function cacheInvalidate(key) {
  _memCache.delete(key);
  if (["price-snapshot-current","price-snapshot-highest","promo-excluded"].includes(key)) {
    _memCache.delete("__promo_etag");
  }
}

// ============================================================
// NETLIFY BLOBS helpers
// ============================================================
function getInventoryStore() {
  return getStore("inventory");
}

async function getJson(key, defaultValue) {
  if (_CACHEABLE.has(key)) {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
  }
  try {
    const store = getInventoryStore();
    const raw = await store.get(key);
    if (!raw) return defaultValue;
    const val = JSON.parse(raw);
    if (_CACHEABLE.has(key)) cacheSet(key, val);
    return val;
  } catch {
    return defaultValue;
  }
}

async function setJson(key, data) {
  cacheInvalidate(key);
  const store = getInventoryStore();
  await store.set(key, JSON.stringify(data));
  if (_CACHEABLE.has(key)) cacheSet(key, data);
}

async function deleteKey(key) {
  cacheInvalidate(key);
  const store = getInventoryStore();
  await store.delete(key);
}

// ============================================================
// SHEET USERS helper
// ============================================================
async function fetchSheetUsers() {
  const cacheKey = "__sheet_users";
  const cached = _memCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.val;
  try {
    const r = await fetch(SHEET_URL_USERS);
    const text = await r.text();
    const rows = text.trim().split("\n").map(l => l.split(",").map(c => c.trim().replace(/^"|"$/g,"")));
    if (!rows.length) return [];
    const header = rows[0].map(c => c.toLowerCase());
    const uIdx = header.indexOf("username"), pIdx = header.indexOf("password"),
          nIdx = header.indexOf("name"), sIdx = header.indexOf("status");
    const users = rows.slice(1).filter(r => r[uIdx]).map(r => ({
      username: r[uIdx] || "",
      password: r[pIdx] || "",
      namaLengkap: r[nIdx] || r[uIdx] || "",
      suspended: (r[sIdx]||"").toLowerCase() === "suspended" || (r[sIdx]||"").toLowerCase() === "nonaktif"
    }));
    _memCache.set(cacheKey, { val: users, exp: Date.now() + _CACHE_TTL });
    return users;
  } catch {
    return [];
  }
}

// ============================================================
// HELPERS: Response builders
// ============================================================
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra }
  });
}

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" }
  });
}

// ============================================================
// UPDATE HIGHEST SNAPSHOT helper
// ============================================================
async function updateHighestSnapshot(newPrices) {
  const existing = await getJson("price-snapshot-highest", { prices: {}, updatedAt: null });
  const highest = existing.prices || {};
  let updated = 0;
  for (const [barcode, price] of Object.entries(newPrices || {})) {
    const p = Number(price) || 0;
    if (p > 0 && (highest[barcode] == null || p > highest[barcode])) {
      highest[barcode] = p;
      updated++;
    }
  }
  if (updated > 0) {
    await setJson("price-snapshot-highest", { prices: highest, updatedAt: new Date().toISOString() });
  }
}

// ============================================================
// Haversine formula
// ============================================================
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*
            Math.sin(dLon/2)*Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req) {
  const method = req.method;

  if (method === "OPTIONS") {
    return new Response("", { status: 200, headers: CORS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/?api/, "") || "/";
  const query = Object.fromEntries(url.searchParams.entries());

  let body = {};
  if (method !== "GET" && method !== "HEAD") {
    try { body = await req.json(); } catch { /* ignore */ }
  }

  try {
    // GET /healthz
    if (path === "/healthz" && method === "GET") return json({ status: "ok" });

    // GET /bblm
    if (path === "/bblm" && method === "GET") {
      const bblmData = await getJson("bblm", { hasData: false, gradeNames: [], products: [], totalProducts: 0, updatedAt: null, updatedBy: "", sourceLabel: "" });
      if (bblmData.updatedAt) {
        const etag = '"' + bblmData.updatedAt + '"';
        if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: CORS });
        return json(bblmData, 200, { "Cache-Control": "public, max-age=1800, stale-while-revalidate=3600", "ETag": etag });
      }
      return json(bblmData);
    }

    // POST /bblm
    if (path === "/bblm" && method === "POST") {
      const { gradeNames, products, sourceLabel, updatedBy } = body;
      if (!Array.isArray(products)) return json({ success: false, message: "products must be an array" }, 400);
      const data = { hasData: true, gradeNames: Array.isArray(gradeNames) ? gradeNames : [], products, totalProducts: products.length, updatedAt: new Date().toISOString(), updatedBy: updatedBy ?? "unknown", sourceLabel: sourceLabel ?? "unknown" };
      await setJson("bblm", data);
      return json({ success: true, totalProducts: products.length });
    }

    // GET /bblm-status
    if (path === "/bblm-status" && method === "GET") {
      return json(await getJson("bblm-status", { status: "updating", updatedAt: null }));
    }

    // POST /bblm-status
    if (path === "/bblm-status" && method === "POST") {
      const { status, adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      if (status !== "updated" && status !== "updating") return json({ success: false, message: "status must be 'updated' or 'updating'" }, 400);
      const updatedAt = new Date().toISOString();
      await setJson("bblm-status", { status, updatedAt });
      return json({ success: true, status, updatedAt, message: status === "updated" ? "BBLM sudah di update" : "BBLM masih proses update" });
    }

    // GET /pwd-status
    if (path === "/pwd-status" && method === "GET") {
      return json(await getJson("pwd-status", {}));
    }

    // POST /pwd-status
    if (path === "/pwd-status" && method === "POST") {
      const { username, changedAt } = body;
      if (!username) return json({ success: false, message: "username is required" }, 400);
      const current = await getJson("pwd-status", {});
      current[username] = changedAt ?? new Date().toISOString();
      await setJson("pwd-status", current);
      return json({ success: true });
    }

    // GET /activity-log
    if (path === "/activity-log" && method === "GET") {
      const { adminPassword, limit, username } = query;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      let logs = await getJson("activity-logs", []);
      if (username) logs = logs.filter(l => l.username === username);
      return json({ success: true, logs: logs.slice(0, Math.min(parseInt(limit ?? "100", 10) || 100, 1000)) });
    }

    // DELETE /activity-log
    if (path === "/activity-log" && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      await setJson("activity-logs", []);
      return json({ success: true, message: "Semua log berhasil dihapus" });
    }

    // POST /activity-log
    if (path === "/activity-log" && method === "POST") {
      const { username, action, detail } = body;
      if (!username || !action) return json({ success: false, message: "username and action are required" }, 400);
      const logs = await getJson("activity-logs", []);
      logs.unshift({ username, action, detail: detail ?? "", createdAt: new Date().toISOString() });
      if (logs.length > 1000) logs.length = 1000;
      await setJson("activity-logs", logs);
      return json({ success: true });
    }

    // POST /login
    if (path === "/login" && method === "POST") {
      const { username, password } = body;
      if (!username || !password) return json({ success: false, message: "username dan password wajib diisi" }, 400);
      const uname = username.trim();
      const [sheetUsers, dbUsers] = await Promise.all([fetchSheetUsers(), getJson("users", [])]);
      const dbMap = {};
      dbUsers.forEach(u => { dbMap[u.username] = u; });
      let user = dbMap[uname];
      if (!user) {
        const su = sheetUsers.find(u => u.username === uname);
        if (su) user = su;
      }
      if (!user) return json({ success: false, notFound: true, message: "User tidak ditemukan" }, 404);
      if (user.password.trim() !== password.trim()) return json({ success: false, notFound: true, message: "Username atau password salah" }, 401);
      if (user.suspended) return json({ success: false, suspended: true, message: "Akun ditangguhkan oleh admin" }, 403);
      return json({ success: true, namaLengkap: user.namaLengkap || user.username });
    }

    // GET /users
    if (path === "/users" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const users = await getJson("users", []);
      return json({ success: true, users: users.map(u => ({ username: u.username, namaLengkap: u.namaLengkap || u.username, suspended: u.suspended ?? false, createdAt: u.createdAt ?? null })) });
    }

    // POST /users
    if (path === "/users" && method === "POST") {
      const { adminPassword, username, password, namaLengkap } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      if (!username || !password) return json({ success: false, message: "username dan password wajib diisi" }, 400);
      const users = await getJson("users", []);
      if (users.find(u => u.username === username.trim())) return json({ success: false, message: "Username sudah ada" }, 409);
      users.push({ username: username.trim(), password: password.trim(), namaLengkap: (namaLengkap || username).trim(), suspended: false, createdAt: new Date().toISOString() });
      await setJson("users", users);
      return json({ success: true });
    }

    // POST /users/import
    if (path === "/users/import" && method === "POST") {
      const { adminPassword, usersData } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      if (!Array.isArray(usersData)) return json({ success: false, message: "usersData must be array" }, 400);
      const existing = await getJson("users", []);
      const existingMap = {};
      existing.forEach(u => { existingMap[u.username] = true; });
      let added = 0;
      usersData.forEach(u => {
        if (u.username && u.password && !existingMap[u.username]) {
          existing.push({ username: u.username, password: u.password, namaLengkap: u.namaLengkap || u.username, suspended: false, createdAt: new Date().toISOString() });
          existingMap[u.username] = true;
          added++;
        }
      });
      await setJson("users", existing);
      return json({ success: true, added, total: existing.length });
    }

    // PATCH /users/:username
    const userPatchMatch = path.match(/^\/users\/([^/]+)$/);
    if (userPatchMatch && method === "PATCH") {
      const { adminPassword, namaLengkap, suspended, password } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const username = decodeURIComponent(userPatchMatch[1]);
      const users = await getJson("users", []);
      const idx = users.findIndex(u => u.username === username);
      if (idx === -1) return json({ success: false, message: "User tidak ditemukan" }, 404);
      if (namaLengkap !== undefined) users[idx].namaLengkap = namaLengkap.trim();
      if (suspended !== undefined) users[idx].suspended = suspended;
      if (password !== undefined && password !== "") users[idx].password = password.trim();
      await setJson("users", users);
      return json({ success: true });
    }

    // DELETE /users/:username
    const userDeleteMatch = path.match(/^\/users\/([^/]+)$/);
    if (userDeleteMatch && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const username = decodeURIComponent(userDeleteMatch[1]);
      let users = await getJson("users", []);
      const before = users.length;
      users = users.filter(u => u.username !== username);
      if (users.length === before) return json({ success: false, message: "User tidak ditemukan" }, 404);
      await setJson("users", users);
      return json({ success: true });
    }

    // GET /maintenance
    if (path === "/maintenance" && method === "GET") {
      return json(await getJson("maintenance", { active: false, message: "", updatedAt: null }));
    }

    // POST /maintenance
    if (path === "/maintenance" && method === "POST") {
      const { adminPassword, active, message } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const data = { active: !!active, message: message ?? "", updatedAt: new Date().toISOString() };
      await setJson("maintenance", data);
      return json({ success: true, ...data });
    }

    // GET /storage-info
    if (path === "/storage-info" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const keys = ["users","bblm","activity-logs","product-requests","maintenance","bblm-status","price-snapshot-current","price-snapshot-prev","price-snapshot-highest","promo-excluded","company-location","sync-meta"];
      const results = await Promise.all(keys.map(async k => {
        try {
          const store = getInventoryStore();
          const raw = await store.get(k);
          const bytes = raw ? new TextEncoder().encode(raw).length : 0;
          return { key: k, bytes, kb: (bytes/1024).toFixed(2) };
        } catch { return { key: k, bytes: 0, kb: "0.00" }; }
      }));
      const totalBytes = results.reduce((s,r)=>s+r.bytes,0);
      return json({ success: true, items: results, totalKB: (totalBytes/1024).toFixed(2), totalMB: (totalBytes/1024/1024).toFixed(4) });
    }

    // GET /backup
    if (path === "/backup" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const [users, bblm, logs, requests, maintenance, bblmStatus, priceSnapCurrent, priceSnapPrev, priceSnapHighest, promoExcluded, companyLoc] = await Promise.all([
        getJson("users", []),
        getJson("bblm", {}),
        getJson("activity-logs", []),
        getJson("product-requests", []),
        getJson("maintenance", { active: false, message: "" }),
        getJson("bblm-status", {}),
        getJson("price-snapshot-current", {}),
        getJson("price-snapshot-prev", {}),
        getJson("price-snapshot-highest", {}),
        getJson("promo-excluded", {}),
        getJson("company-location", {}),
      ]);
      return json({ success: true, exportedAt: new Date().toISOString(), data: { users, bblm, "activity-logs": logs, "product-requests": requests, maintenance, "bblm-status": bblmStatus, "price-snapshot-current": priceSnapCurrent, "price-snapshot-prev": priceSnapPrev, "price-snapshot-highest": priceSnapHighest, "promo-excluded": promoExcluded, "company-location": companyLoc } });
    }

    // POST /restore
    if (path === "/restore" && method === "POST") {
      const { adminPassword, data } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      if (!data || typeof data !== "object") return json({ success: false, message: "data harus berupa object" }, 400);
      const keys = ["users","bblm","activity-logs","product-requests","maintenance","bblm-status","price-snapshot-current","price-snapshot-prev","price-snapshot-highest","promo-excluded","company-location"];
      let restored = 0;
      await Promise.all(keys.map(async k => {
        if (data[k] !== undefined) { await setJson(k, data[k]); restored++; }
      }));
      return json({ success: true, message: restored + " kunci data berhasil direstore" });
    }

    // GET /price-history/:barcode
    if (path.startsWith("/price-history/") && method === "GET") {
      const barcode = decodeURIComponent(path.replace("/price-history/", "").trim());
      if (!barcode) return json({ success: false, message: "barcode wajib diisi" }, 400);
      const [individual, prev] = await Promise.all([
        getJson(`price-history:${barcode}`, null),
        getJson("price-snapshot-prev", { date: null, prices: {} })
      ]);
      const prevPrice = prev.prices?.[barcode];
      const data = prevPrice != null ? { price: prevPrice, date: prev.date } : individual;
      return json({ success: true, data });
    }

    // POST /price-history
    if (path === "/price-history" && method === "POST") {
      const { barcode, price } = body;
      if (!barcode || price === undefined) return json({ success: false, message: "barcode dan price wajib diisi" }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const existing = await getJson(`price-history:${barcode}`, null);
      if (!existing || existing.date !== today) await setJson(`price-history:${barcode}`, { price: Number(price), date: today });
      return json({ success: true });
    }

    // GET /upload-harga — halaman kelola harga acuan
    if (path === "/upload-harga" && method === "GET") {
      return html(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kelola Harga Coret - PDA Mini Mataram</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f0f4f8;min-height:100vh;padding:16px}
.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.1)}
h1{font-size:20px;color:#1a202c;margin-bottom:4px;font-weight:800}
.sub{color:#718096;font-size:13px;margin-bottom:20px}
.step-row{display:flex;gap:8px;align-items:flex-start;margin-bottom:10px}
.step-num{background:#3182ce;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;margin-top:1px}
.step-text{font-size:13px;color:#4a5568;line-height:1.5}
.step-text b{color:#1a202c}
.status-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}
.status-box{border-radius:10px;padding:14px;border:2px solid #e2e8f0;text-align:center}
.status-box.has-data{border-color:#48bb78;background:#f0fff4}
.status-box.no-data{border-color:#e2e8f0;background:#f7fafc}
.status-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.status-box.has-data .status-label{color:#276749}
.status-box.no-data .status-label{color:#a0aec0}
.status-icon{font-size:24px;margin-bottom:4px}
.status-count{font-size:18px;font-weight:800;color:#1a202c}
.status-date{font-size:11px;color:#718096;margin-top:2px}
.status-empty{font-size:12px;color:#a0aec0;font-style:italic}
.divider{border:none;border-top:1px solid #e2e8f0;margin:16px 0}
label{display:block;font-size:13px;font-weight:600;color:#4a5568;margin-bottom:6px}
input[type=password]{width:100%;padding:11px 14px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none}
input[type=password]:focus{border-color:#3182ce}
.btn-acuan{display:block;width:100%;padding:15px;background:linear-gradient(135deg,#e53e3e,#c53030);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;margin-top:14px;letter-spacing:.02em}
.btn-acuan:disabled{background:#a0aec0;cursor:not-allowed}
.btn-refresh{display:inline-block;padding:8px 14px;background:#edf2f7;color:#4a5568;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;margin-top:4px}
.alert{padding:12px 14px;border-radius:8px;font-size:13px;margin-top:12px;display:none;font-weight:500}
.ok{background:#f0fff4;color:#276749;border:1px solid #9ae6b4}
.err{background:#fff5f5;color:#c53030;border:1px solid #fed7d7}
.warn-box{background:#fffbeb;border:1px solid #f6e05e;border-radius:8px;padding:12px 14px;font-size:12px;color:#744210;margin-top:12px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
  <h1>🏷️ Kelola Harga Coret</h1>
  <div class="sub">PDA Mini Mataram — Atur acuan harga coret di aplikasi</div>
  <div class="step-row"><div class="step-num">1</div><div class="step-text"><b>Sebelum update harga di spreadsheet</b> — klik tombol di bawah untuk menyimpan harga saat ini sebagai acuan harga coret.</div></div>
  <div class="step-row"><div class="step-num">2</div><div class="step-text"><b>Update harga di spreadsheet</b> dengan harga baru yang lebih murah.</div></div>
  <div class="step-row"><div class="step-num">3</div><div class="step-text"><b>Harga coret otomatis tampil</b> di aplikasi ketika user scan barcode yang harganya turun.</div></div>
  <hr class="divider">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <span style="font-size:13px;font-weight:700;color:#4a5568">Status Harga di Server</span>
    <button class="btn-refresh" onclick="loadStatus()">↻ Refresh</button>
  </div>
  <div class="status-grid">
    <div id="boxAcuan" class="status-box no-data">
      <div class="status-label">Harga Acuan (Coret)</div>
      <div id="iconAcuan" class="status-icon">❌</div>
      <div id="countAcuan" class="status-empty">Belum ada</div>
      <div id="dateAcuan" class="status-date"></div>
    </div>
    <div id="boxTerbaru" class="status-box no-data">
      <div class="status-label">Harga Terbaru</div>
      <div id="iconTerbaru" class="status-icon">⏳</div>
      <div id="countTerbaru" class="status-empty">Memuat...</div>
      <div id="dateTerbaru" class="status-date"></div>
    </div>
  </div>
  <div id="warnBox" class="warn-box" style="display:none"></div>
  <hr class="divider">
  <label>Password Admin</label>
  <input type="password" id="pwd" placeholder="Masukkan password admin">
  <button class="btn-acuan" id="btnAcuan" onclick="doSetAcuan()">🔒 Simpan Harga Terbaru sebagai Acuan Harga Coret</button>
  <div class="alert ok" id="aOk"></div>
  <div class="alert err" id="aErr"></div>
</div>
<script>
async function loadStatus(){
  try{
    const r=await fetch("/api/sync-prices");
    const j=await r.json();
    if(!j.success)return;
    const cur=j.current,prev=j.prev;
    const bT=document.getElementById("boxTerbaru");
    if(cur&&cur.count>0){bT.className="status-box has-data";document.getElementById("iconTerbaru").textContent="✅";document.getElementById("countTerbaru").innerHTML='<span class="status-count">'+cur.count.toLocaleString("id-ID")+'</span>';document.getElementById("dateTerbaru").textContent=cur.date?"Tanggal: "+cur.date:"";}
    else{bT.className="status-box no-data";document.getElementById("iconTerbaru").textContent="⏳";document.getElementById("countTerbaru").innerHTML='<span class="status-empty">Belum ada (buka aplikasi dulu)</span>';document.getElementById("dateTerbaru").textContent="";}
    const bA=document.getElementById("boxAcuan");
    if(prev&&prev.count>0){bA.className="status-box has-data";document.getElementById("iconAcuan").textContent="✅";document.getElementById("countAcuan").innerHTML='<span class="status-count">'+prev.count.toLocaleString("id-ID")+'</span>';document.getElementById("dateAcuan").textContent=prev.date?"Disimpan: "+prev.date:"";}
    else{bA.className="status-box no-data";document.getElementById("iconAcuan").textContent="❌";document.getElementById("countAcuan").innerHTML='<span class="status-empty">Belum ada</span>';document.getElementById("dateAcuan").textContent="";}
    const wb=document.getElementById("warnBox");
    if(cur&&cur.count>0&&(!prev||prev.count===0)){wb.style.display="block";wb.textContent="⚠️ Harga acuan belum disimpan. Klik tombol di bawah SEBELUM mengubah harga di spreadsheet.";}
    else if(cur&&cur.count>0&&prev&&prev.count>0&&cur.date===prev.date){wb.style.display="block";wb.textContent="ℹ️ Harga acuan sudah disimpan hari ini ("+prev.date+"). Sekarang update spreadsheet.";}
    else{wb.style.display="none";}
  }catch(e){document.getElementById("countTerbaru").textContent="Gagal memuat";}
}
async function doSetAcuan(){
  const pwd=document.getElementById("pwd").value.trim();
  if(!pwd){showErr("Password admin wajib diisi");return;}
  const btn=document.getElementById("btnAcuan");
  btn.disabled=true;btn.textContent="⏳ Menyimpan...";
  hideAlert();
  try{
    const r=await fetch("/api/set-price-acuan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({adminPassword:pwd})});
    const j=await r.json();
    if(j.success){showOk("✅ "+j.message);loadStatus();}
    else showErr(j.message||"Gagal menyimpan");
  }catch(e){showErr("Error: "+e.message);}
  btn.disabled=false;btn.textContent="🔒 Simpan Harga Terbaru sebagai Acuan Harga Coret";
}
function showOk(m){const e=document.getElementById("aOk");e.textContent=m;e.style.display="block";}
function showErr(m){const e=document.getElementById("aErr");e.textContent=m;e.style.display="block";}
function hideAlert(){document.getElementById("aOk").style.display="none";document.getElementById("aErr").style.display="none";}
loadStatus();
<\/script>
</body>
</html>`);
    }

    // POST /set-price-acuan
    if (path === "/set-price-acuan" && method === "POST") {
      const { snapPassword, adminPassword } = body;
      const pw = snapPassword || adminPassword || "";
      if (pw !== SNAP_PASSWORD && pw !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const current = await getJson("price-snapshot-current", { date: null, prices: {} });
      if (!current.date || Object.keys(current.prices || {}).length === 0) {
        return json({ success: false, message: "Belum ada harga terbaru di server. Buka aplikasi dulu agar harga tersinkron dari spreadsheet." });
      }
      await setJson("price-snapshot-prev", current);
      const snapIdxAcuan = await getJson("price-snapshots-index", []);
      if (!snapIdxAcuan.some(s => s.date === current.date)) {
        await setJson(`price-snapshot:${current.date}`, current);
        snapIdxAcuan.unshift({ date: current.date, count: Object.keys(current.prices || {}).length });
        if (snapIdxAcuan.length > 60) snapIdxAcuan.length = 60;
        await setJson("price-snapshots-index", snapIdxAcuan);
        await updateHighestSnapshot(current.prices);
      } else {
        await updateHighestSnapshot(current.prices);
      }
      const count = Object.keys(current.prices).length;
      return json({ success: true, saved: count, message: count.toLocaleString("id-ID") + " harga berhasil disimpan sebagai acuan. Sekarang update spreadsheet — harga coret akan tampil otomatis." });
    }

    // GET /sync-prices/check
    if (path === "/sync-prices/check" && method === "GET") {
      const { date, count } = query;
      const syncMeta = await getJson("sync-meta", { date: null, count: 0 });
      const needSync = !date || !count || syncMeta.date !== date || syncMeta.count !== parseInt(count, 10);
      return json({ needSync, serverDate: syncMeta.date || null, serverCount: syncMeta.count || 0 }, 200, { "Cache-Control": "no-store" });
    }

    // GET /sync-prices
    if (path === "/sync-prices" && method === "GET") {
      const [current, prev, highest] = await Promise.all([
        getJson("price-snapshot-current", { date: null, prices: {} }),
        getJson("price-snapshot-prev", { date: null, prices: {} }),
        getJson("price-snapshot-highest", { prices: {}, updatedAt: null })
      ]);
      const cPrices = current.prices || {};
      const pPrices = prev.prices || {};
      const hPrices = highest.prices || {};
      const diffCount = Object.keys(hPrices).filter(bc => { const hp = hPrices[bc]; const cp = cPrices[bc]; return hp != null && cp != null && hp > cp; }).length;
      const diffCountManual = Object.keys(pPrices).filter(bc => { const pp = pPrices[bc]; const cp = cPrices[bc]; return pp != null && cp != null && pp > cp; }).length;
      const cCount = Object.keys(cPrices).length;
      const etag = '"sp-' + (current.date||"null") + "-" + (prev.date||"null") + "-" + cCount + '"';
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: CORS });
      const syncMeta = await getJson("sync-meta", { date: null, count: 0 });
      const today = new Date().toISOString().slice(0, 10);
      const needSync = syncMeta.date !== today || syncMeta.count !== cCount;
      return json({ success: true, current: { date: current.date, count: cCount }, prev: { date: prev.date, count: Object.keys(pPrices).length, diffCount: diffCountManual }, highest: { count: Object.keys(hPrices).length, updatedAt: highest.updatedAt, diffCount }, diffCount, needSync }, 200, { "ETag": etag, "Cache-Control": "public, max-age=60, stale-while-revalidate=300" });
    }

    // POST /sync-prices
    if (path === "/sync-prices" && method === "POST") {
      const { items } = body;
      if (!Array.isArray(items) || !items.length) return json({ success: false, message: "items harus array" }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const prices = {};
      items.forEach(({ barcode, price }) => { if (barcode) prices[barcode] = Number(price) || 0; });
      const incomingCount = Object.keys(prices).length;
      const syncMeta = await getJson("sync-meta", { date: null, count: 0 });
      if (syncMeta.date === today && syncMeta.count === incomingCount) {
        return json({ success: true, saved: incomingCount, skipped: true });
      }
      const [_, existingHighest] = await Promise.all([
        setJson("price-snapshot-current", { date: today, prices }),
        getJson("price-snapshot-highest", { prices: {}, updatedAt: null })
      ]);
      await setJson("sync-meta", { date: today, count: incomingCount });
      const highest = existingHighest.prices || {};
      let updated = 0;
      for (const [barcode, price] of Object.entries(prices)) {
        const p = Number(price) || 0;
        if (p > 0 && (highest[barcode] == null || p > highest[barcode])) { highest[barcode] = p; updated++; }
      }
      if (updated > 0) await setJson("price-snapshot-highest", { prices: highest, updatedAt: new Date().toISOString() });
      return json({ success: true, saved: incomingCount, skipped: false });
    }

    // POST /product-request
    if (path === "/product-request" && method === "POST") {
      const { barcode, namaBarang, keterangan, username } = body;
      if (!barcode || !namaBarang || !username) return json({ success: false, message: "barcode, namaBarang, dan username wajib diisi" }, 400);
      const list = await getJson("product-requests", []);
      list.unshift({ id: randomUUID(), barcode: barcode.trim(), namaBarang: namaBarang.trim(), keterangan: (keterangan ?? "").trim(), username: username.trim(), createdAt: new Date().toISOString(), resolved: false });
      if (list.length > 500) list.length = 500;
      await setJson("product-requests", list);
      return json({ success: true });
    }

    // GET /product-request
    if (path === "/product-request" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      let list = await getJson("product-requests", []);
      if (query.showResolved !== "1") list = list.filter(r => !r.resolved);
      return json({ success: true, requests: list });
    }

    // PATCH /product-request/:id/resolve
    const patchResolveMatch = path.match(/^\/product-request\/([^/]+)\/resolve$/);
    if (patchResolveMatch && method === "PATCH") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const id = patchResolveMatch[1];
      const list = await getJson("product-requests", []);
      const idx = list.findIndex(r => r.id === id);
      if (idx === -1) return json({ success: false, message: "Request tidak ditemukan" }, 404);
      list[idx].resolved = true;
      list[idx].resolvedAt = new Date().toISOString();
      await setJson("product-requests", list);
      return json({ success: true });
    }

    // GET /price-snapshots
    if (path === "/price-snapshots" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const snapIndex = await getJson("price-snapshots-index", []);
      return json({ success: true, snapshots: snapIndex });
    }

    // POST /price-snapshots/:date/set-acuan
    const setAcuanMatch = path.match(/^\/price-snapshots\/(\d{4}-\d{2}-\d{2})\/set-acuan$/);
    if (setAcuanMatch && method === "POST") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const date = setAcuanMatch[1];
      const snap = await getJson(`price-snapshot:${date}`, null);
      if (!snap) return json({ success: false, message: `Snapshot ${date} tidak ditemukan` }, 404);
      await setJson("price-snapshot-prev", snap);
      await updateHighestSnapshot(snap.prices);
      const count = Object.keys(snap.prices || {}).length;
      return json({ success: true, message: `Snapshot ${date} (${count.toLocaleString("id-ID")} produk) dijadikan acuan harga coret` });
    }

    // POST /price-snapshots/rebuild-highest
    if (path === "/price-snapshots/rebuild-highest" && method === "POST") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const snapIndex = await getJson("price-snapshots-index", []);
      if (!snapIndex.length) return json({ success: false, message: "Belum ada snapshot tersimpan" });
      const highest = {};
      let processed = 0;
      for (const s of snapIndex) {
        const snap = await getJson(`price-snapshot:${s.date}`, null);
        if (!snap || !snap.prices) continue;
        for (const [barcode, price] of Object.entries(snap.prices)) {
          const p = Number(price) || 0;
          if (p > 0 && (highest[barcode] == null || p > highest[barcode])) highest[barcode] = p;
        }
        processed++;
      }
      if (!processed) return json({ success: false, message: "Tidak ada data snapshot yang bisa dibaca" });
      await setJson("price-snapshot-highest", { prices: highest, updatedAt: new Date().toISOString() });
      const count = Object.keys(highest).length;
      return json({ success: true, processed, message: `Berhasil membangun ulang dari ${processed} snapshot. ${count.toLocaleString("id-ID")} produk tersimpan di harga tertinggi.`, count });
    }

    // DELETE /price-snapshots/:date
    const snapDeleteMatch = path.match(/^\/price-snapshots\/(\d{4}-\d{2}-\d{2})$/);
    if (snapDeleteMatch && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const date = snapDeleteMatch[1];
      await deleteKey(`price-snapshot:${date}`);
      const snapIndex = await getJson("price-snapshots-index", []);
      await setJson("price-snapshots-index", snapIndex.filter(s => s.date !== date));
      return json({ success: true, message: `Snapshot ${date} berhasil dihapus` });
    }

    // POST /price-snapshot-highest/reset
    if (path === "/price-snapshot-highest/reset" && method === "POST") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      await deleteKey("price-snapshot-highest");
      return json({ success: true, message: "price-snapshot-highest berhasil direset." });
    }

    // GET /promo-list
    if (path === "/promo-list" && method === "GET") {
      const [highest, current, excluded] = await Promise.all([
        getJson("price-snapshot-highest", { prices: {} }),
        getJson("price-snapshot-current", { date: null, prices: {} }),
        getJson("promo-excluded", { barcodes: [] })
      ]);
      const etag = '"pl-' + (highest.updatedAt||"null") + "-" + (current.date||"null") + "-" + (excluded.updatedAt||"null") + '"';
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: CORS });
      const hPrices = highest.prices || {};
      const cPrices = current.prices || {};
      const excludedSet = new Set(excluded.barcodes || []);
      const items = [];
      for (const [barcode, prevPrice] of Object.entries(hPrices)) {
        if (excludedSet.has(barcode)) continue;
        const currentPrice = cPrices[barcode];
        if (currentPrice == null) continue;
        const p = Number(prevPrice) || 0;
        const c = Number(currentPrice) || 0;
        if (p > c && c > 0) {
          const discount = p - c;
          const discountPct = (discount / p) * 100;
          items.push({ barcode, prevPrice: p, currentPrice: c, discount, discountPct });
        }
      }
      items.sort((a, b) => b.discountPct - a.discountPct);
      return json({ success: true, count: items.length, excludedCount: excludedSet.size, highestUpdatedAt: highest.updatedAt || null, currentDate: current.date || null, items }, 200, { "ETag": etag, "Cache-Control": "public, max-age=120, stale-while-revalidate=600" });
    }

    // GET /promo-excluded
    if (path === "/promo-excluded" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const exc = await getJson("promo-excluded", { barcodes: [] });
      return json({ success: true, barcodes: exc.barcodes || [], updatedAt: exc.updatedAt || null });
    }

    // POST /promo-exclude
    if (path === "/promo-exclude" && method === "POST") {
      const { adminPassword, barcode: bc } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      if (!bc) return json({ success: false, message: "barcode wajib diisi" }, 400);
      const exc = await getJson("promo-excluded", { barcodes: [] });
      const barcodes = exc.barcodes || [];
      if (!barcodes.includes(bc)) { barcodes.push(bc); await setJson("promo-excluded", { barcodes, updatedAt: new Date().toISOString() }); }
      return json({ success: true, total: barcodes.length });
    }

    // DELETE /promo-exclude/:barcode
    if (path.startsWith("/promo-exclude/") && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const bc = decodeURIComponent(path.replace("/promo-exclude/", "").trim());
      if (!bc) return json({ success: false, message: "barcode wajib diisi" }, 400);
      const exc = await getJson("promo-excluded", { barcodes: [] });
      const barcodes = (exc.barcodes || []).filter(b => b !== bc);
      await setJson("promo-excluded", { barcodes, updatedAt: new Date().toISOString() });
      return json({ success: true, total: barcodes.length });
    }

    // GET /neo-status — storage info Netlify Blobs (pengganti Neon DB monitor)
    if (path === "/neo-status" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const keys = ["users","bblm","activity-logs","product-requests","maintenance","bblm-status","price-snapshot-current","price-snapshot-prev","price-snapshot-highest","promo-excluded","company-location","sync-meta","pw-reset-requests","cron-logs","morning-reset-log","price-snapshots-index","price-refresh-ts"];
      const store = getInventoryStore();
      const results = await Promise.all(keys.map(async k => {
        try {
          const raw = await store.get(k);
          const bytes = raw ? new TextEncoder().encode(raw).length : 0;
          let valueType = "null";
          if (raw) { try { const v = JSON.parse(raw); valueType = Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v; } catch {} }
          return { key: k, bytes, kb: (bytes/1024).toFixed(2), type: valueType, updatedAt: null };
        } catch { return { key: k, bytes: 0, kb: "0.00", type: "null", updatedAt: null }; }
      }));
      const totalBytes = results.reduce((s,r)=>s+r.bytes,0);
      const cacheKeys = [..._memCache.keys()];
      const cacheInfo = cacheKeys.map(k => {
        const e = _memCache.get(k);
        const ttlLeft = e ? Math.max(0, Math.round((e.exp - Date.now()) / 1000)) : 0;
        return { key: k, ttlLeft };
      });
      return json({
        success: true,
        storage: "Netlify Blobs",
        db: {
          totalSize: (totalBytes / 1024).toFixed(1) + " KB",
          tableSize: "-",
          indexSize: "-",
          rowCount: results.filter(r=>r.bytes>0).length,
          totalValueBytes: totalBytes,
          totalValueKB: (totalBytes/1024).toFixed(2),
          totalValueMB: (totalBytes/1024/1024).toFixed(3),
          dbBytes: totalBytes,
          dbSizePretty: (totalBytes/1024).toFixed(1) + " KB",
          freeBytes: null,
          freeSizePretty: "Netlify Blobs (unlimited free tier)",
          usedPercent: 0,
          limitBytes: null,
          limitPretty: "Netlify Blobs"
        },
        keys: results.filter(r=>r.bytes>0),
        cache: { hitKeys: cacheInfo.length, keys: cacheInfo },
        checkedAt: new Date().toISOString()
      });
    }

    // GET /neo-monitor — halaman monitor storage
    if (path === "/neo-monitor" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) {
        return html("<h2>Unauthorized — tambahkan ?adminPassword=xxx ke URL</h2>", 403);
      }
      return html(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Storage Monitor - PDA Mini Mataram</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;min-height:100vh;padding:16px;color:#e2e8f0}
h1{font-size:18px;font-weight:800;color:#fff;margin-bottom:2px}
.sub{color:#64748b;font-size:12px;margin-bottom:16px}
.grid4{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px}
@media(min-width:600px){.grid4{grid-template-columns:repeat(4,1fr)}}
.stat-card{background:#1e293b;border-radius:12px;padding:14px;border:1px solid #334155}
.stat-label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:6px}
.stat-val{font-size:24px;font-weight:800;color:#fff;line-height:1}
.stat-sub{font-size:11px;color:#64748b;margin-top:4px}
.stat-card.green .stat-val{color:#4ade80}
.stat-card.blue .stat-val{color:#60a5fa}
.stat-card.purple .stat-val{color:#c084fc}
.stat-card.orange .stat-val{color:#fb923c}
.section{background:#1e293b;border-radius:12px;padding:16px;margin-bottom:12px;border:1px solid #334155}
.section-title{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:#64748b;font-weight:600;padding:6px 8px;border-bottom:1px solid #334155;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
td{padding:7px 8px;border-bottom:1px solid #1e293b;color:#e2e8f0;vertical-align:middle}
tr:last-child td{border:none}
tr:hover td{background:#0f172a}
.bar-wrap{background:#0f172a;border-radius:4px;height:6px;width:100%;min-width:60px}
.bar{height:6px;border-radius:4px;transition:.3s}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700}
.tag-arr{background:#1e3a5f;color:#60a5fa}
.tag-obj{background:#1a2e1a;color:#4ade80}
.tag-str{background:#2e1a3a;color:#c084fc}
.btn{padding:8px 16px;border-radius:8px;border:none;font-size:12px;font-weight:700;cursor:pointer;transition:.15s}
.btn-refresh{background:#3b82f6;color:#fff}
.btn-refresh:hover{background:#2563eb}
.btn-logout{background:#334155;color:#94a3b8;margin-right:8px}
.top-bar{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.top-btns{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot-green{background:#4ade80;box-shadow:0 0 6px #4ade80}
.dot-red{background:#f87171}
.dot-yellow{background:#fbbf24;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.auto-refresh{font-size:11px;color:#64748b;display:flex;align-items:center;gap:6px}
.cache-item{display:flex;justify-content:space-between;padding:5px 8px;border-radius:6px;background:#0f172a;margin-bottom:4px;font-size:11px}
.err-box{background:#2d0a0a;border:1px solid #7f1d1d;border-radius:10px;padding:14px;color:#f87171;font-size:13px;margin-bottom:12px}
.loading{display:flex;align-items:center;gap:8px;color:#64748b;font-size:13px;padding:20px 0}
.spinner{width:16px;height:16px;border:2px solid #334155;border-top-color:#60a5fa;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.updated-at{font-size:10px;color:#475569;margin-top:2px}
.key-highlight{color:#60a5fa;font-family:monospace;font-size:11px}
.key-highlight.warn{color:#fbbf24}
.key-highlight.large{color:#f87171}
</style>
</head>
<body>
<div class="top-bar">
  <div>
    <h1>📊 Storage Monitor</h1>
    <div class="sub">PDA Mini Mataram — Netlify Blobs Storage Dashboard</div>
  </div>
  <div class="top-btns">
    <span class="auto-refresh"><span class="status-dot dot-yellow" id="dotStatus"></span><span id="autoLabel">Auto-refresh 30s</span></span>
    <button class="btn btn-refresh" onclick="loadData(true)">↻ Refresh Sekarang</button>
    <button class="btn btn-logout" onclick="history.back()">← Kembali</button>
  </div>
</div>
<div id="errBox" class="err-box" style="display:none"></div>
<div class="grid4" id="statCards">
  <div class="stat-card blue"><div class="stat-label">Total Ukuran</div><div class="stat-val" id="sTotal">-</div><div class="stat-sub">Netlify Blobs</div></div>
  <div class="stat-card green"><div class="stat-label">Value Size (JSON)</div><div class="stat-val" id="sValueMB">-</div><div class="stat-sub" id="sValueKB">-</div></div>
  <div class="stat-card purple"><div class="stat-label">Total Keys</div><div class="stat-val" id="sRows">-</div><div class="stat-sub">kunci aktif</div></div>
  <div class="stat-card orange"><div class="stat-label">Cache (RAM)</div><div class="stat-val" id="sCacheHits">-</div><div class="stat-sub">key aktif di memori</div></div>
</div>
<div class="section">
  <div class="section-title">
    <span>📦 Detail Penyimpanan per Key</span>
    <span class="updated-at" id="updatedAt">-</span>
  </div>
  <div id="keyTableContainer"><div class="loading"><div class="spinner"></div>Memuat data...</div></div>
</div>
<div class="section">
  <div class="section-title">⚡ In-Memory Cache (Netlify RAM)</div>
  <div id="cacheContainer"><div class="loading"><div class="spinner"></div>Memuat cache...</div></div>
</div>
<script>
var adminPw=new URLSearchParams(location.search).get('adminPassword')||'';
var countdownTimer=null;
var refreshCountdown=30;
function startCountdown(){
  refreshCountdown=30;
  if(countdownTimer)clearInterval(countdownTimer);
  countdownTimer=setInterval(function(){
    refreshCountdown--;
    document.getElementById('autoLabel').textContent='Auto-refresh '+refreshCountdown+'s';
    if(refreshCountdown<=0){clearInterval(countdownTimer);loadData(false);}
  },1000);
}
function fmtBytes(b){if(b>=1024*1024)return(b/1024/1024).toFixed(2)+' MB';if(b>=1024)return(b/1024).toFixed(1)+' KB';return b+' B';}
function fmtDate(s){if(!s)return'-';return new Date(s).toLocaleString('id-ID',{dateStyle:'short',timeStyle:'medium'});}
async function loadData(manual){
  var dot=document.getElementById('dotStatus');
  dot.className='status-dot dot-yellow';
  document.getElementById('errBox').style.display='none';
  try{
    var r=await fetch('/api/neo-status?adminPassword='+encodeURIComponent(adminPw));
    var j=await r.json();
    if(!j.success){document.getElementById('errBox').textContent='Error: '+(j.message||'Unauthorized');document.getElementById('errBox').style.display='block';dot.className='status-dot dot-red';return;}
    dot.className='status-dot dot-green';
    document.getElementById('sTotal').textContent=j.db.dbSizePretty||'-';
    var mb=parseFloat(j.db.totalValueMB);
    document.getElementById('sValueMB').textContent=mb>=1?mb.toFixed(2)+' MB':j.db.totalValueKB+' KB';
    document.getElementById('sValueKB').textContent=parseInt(j.db.totalValueBytes||0).toLocaleString('id-ID')+' bytes';
    document.getElementById('sRows').textContent=(j.db.rowCount||0).toLocaleString('id-ID');
    document.getElementById('sCacheHits').textContent=(j.cache.hitKeys||0);
    var keys=j.keys||[];
    var maxBytes=keys.reduce(function(m,k){return Math.max(m,k.bytes);},1);
    var rows=keys.map(function(k){
      var pct=Math.min(100,Math.round((k.bytes/maxBytes)*100));
      var cls=k.bytes>500000?'large':k.bytes>100000?'warn':'';
      var tagCls=k.type==='array'?'tag-arr':k.type==='object'?'tag-obj':'tag-str';
      return '<tr><td><span class="key-highlight '+cls+'">'+k.key+'</span></td><td>'+fmtBytes(k.bytes)+'</td><td style="width:120px"><div class="bar-wrap"><div class="bar" style="width:'+pct+'%;background:'+(cls==='large'?'#f87171':cls==='warn'?'#fbbf24':'#3b82f6')+'"></div></div></td><td><span class="badge '+tagCls+'">'+(k.type||'-')+'</span></td></tr>';
    }).join('');
    document.getElementById('keyTableContainer').innerHTML=keys.length?'<table><thead><tr><th>Key</th><th>Ukuran</th><th>Proporsi</th><th>Tipe</th></tr></thead><tbody>'+rows+'</tbody></table>':'<div style="color:#64748b;padding:16px;text-align:center">Tidak ada data</div>';
    var items=(j.cache.keys||[]);
    if(!items.length){document.getElementById('cacheContainer').innerHTML='<div style="color:#64748b;font-size:12px;padding:8px 0">Belum ada key di RAM cache</div>';}
    else{document.getElementById('cacheContainer').innerHTML=items.map(function(c){var pct=Math.min(100,Math.round((c.ttlLeft/300)*100));return'<div class="cache-item"><span style="color:#c084fc;font-family:monospace;font-size:11px">'+c.key+'</span><span style="color:#94a3b8">'+c.ttlLeft+'s tersisa</span></div>';}).join('');}
    document.getElementById('updatedAt').textContent='Diperbarui: '+fmtDate(j.checkedAt);
    startCountdown();
  }catch(e){document.getElementById('errBox').textContent='Gagal mengambil data: '+e.message;document.getElementById('errBox').style.display='block';dot.className='status-dot dot-red';}
}
loadData(true);
<\/script>
</body>
</html>`);
    }

    // GET /cron/daily-reset
    if (path === "/cron/daily-reset" && method === "GET") {
      const { secret } = query;
      if (secret !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const now = new Date().toISOString();
      const actions = ["bblm -> cleared","bblm-status -> updating","price-snapshot-prev -> cleared","price-snapshot-current -> cleared","price-snapshot-highest -> cleared"];
      await Promise.all([
        setJson("bblm", { hasData: false, gradeNames: [], products: [], totalProducts: 0, updatedAt: null, updatedBy: "", sourceLabel: "" }),
        setJson("bblm-status", { status: "updating", updatedAt: now, resetBy: "cron-04:00" }),
        setJson("price-snapshot-prev", { date: null, prices: {} }),
        setJson("price-snapshot-current", { date: null, prices: {} }),
        setJson("price-snapshot-highest", { prices: {}, updatedAt: null }),
      ]);
      const cronLogs = await getJson("cron-logs", []);
      cronLogs.unshift({ runAt: now, success: true, actions });
      if (cronLogs.length > 30) cronLogs.length = 30;
      await setJson("cron-logs", cronLogs);
      return json({ success: true, message: "Daily reset berhasil: data BBLM dihapus, status -> masih update, semua harga coret & promo direset", resetAt: now, actions });
    }

    // GET /cron/status
    if (path === "/cron/status" && method === "GET") {
      const logs = await getJson("cron-logs", []);
      const last = logs[0] ?? null;
      const now = new Date();
      const next = new Date(now);
      next.setUTCHours(20, 0, 0, 0);
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      return json({ success: true, lastRun: last ? { runAt: last.runAt, success: last.success, actions: last.actions } : null, nextRun: next.toISOString(), nextRunWITA: next.toLocaleString("id-ID", { timeZone: "Asia/Makassar", dateStyle: "full", timeStyle: "short" }), totalLogs: logs.length, recentLogs: logs.slice(0, 7) });
    }

    // GET /company-location
    if (path === "/company-location" && method === "GET") {
      const loc = await getJson("company-location", { lat: null, lng: null, radiusKm: 1, name: "Perusahaan" });
      return json({ success: true, ...loc }, 200, { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" });
    }

    // POST /company-location
    if (path === "/company-location" && method === "POST") {
      const { adminPassword, lat, lng, radiusKm, name } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      if (lat === undefined || lng === undefined) return json({ success: false, message: "lat dan lng wajib diisi" }, 400);
      const data = { lat: parseFloat(lat), lng: parseFloat(lng), radiusKm: parseFloat(radiusKm ?? 1), name: name ?? "Perusahaan", updatedAt: new Date().toISOString() };
      await setJson("company-location", data);
      return json({ success: true, ...data });
    }

    // POST /location-check
    if (path === "/location-check" && method === "POST") {
      const { username, lat, lng, accuracy } = body;
      if (!username) return json({ success: false, message: "username wajib diisi" }, 400);
      if (lat === undefined || lng === undefined) return json({ success: false, message: "lat dan lng wajib diisi" }, 400);
      const company = await getJson("company-location", { lat: null, lng: null, radiusKm: 1, name: "Perusahaan" });
      if (company.lat === null || company.lng === null) return json({ success: true, status: "unconfigured", message: "Lokasi perusahaan belum diatur oleh admin" });
      const distKm = haversine(parseFloat(lat), parseFloat(lng), company.lat, company.lng);
      const distM = Math.round(distKm * 1000);
      const isInRadius = distKm <= company.radiusKm;
      if (!isInRadius) {
        const logs = await getJson("activity-logs", []);
        logs.unshift({ username, action: "⚠️ LOKASI DI LUAR RADIUS", detail: distM + "m dari " + company.name + " (batas: " + (company.radiusKm * 1000) + "m)" + (accuracy ? " · akurasi GPS: " + Math.round(accuracy) + "m" : ""), createdAt: new Date().toISOString(), type: "location-warning" });
        if (logs.length > 1000) logs.length = 1000;
        await setJson("activity-logs", logs);
      }
      return json({ success: true, isInRadius, distanceM: distM, radiusM: Math.round(company.radiusKm * 1000), companyName: company.name, status: isInRadius ? "dalam_radius" : "di_luar_radius" });
    }

    // GET /kelola-lokasi
    if (path === "/kelola-lokasi" && method === "GET") {
      return html(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kelola Lokasi Perusahaan - PDA Mini Mataram</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;min-height:100vh;padding:16px;color:#e2e8f0}
.card{background:#1e293b;border-radius:14px;padding:20px;margin-bottom:14px;border:1px solid #334155}
h1{font-size:20px;font-weight:800;color:#f1f5f9;margin-bottom:4px}
.sub{color:#94a3b8;font-size:13px;margin-bottom:20px}
label{display:block;font-size:12px;font-weight:700;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
input[type=text],input[type=number],input[type=password]{width:100%;padding:10px 14px;background:#0f172a;border:1.5px solid #334155;border-radius:8px;font-size:14px;color:#f1f5f9;outline:none}
input:focus{border-color:#6366f1}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
#map{height:280px;border-radius:10px;overflow:hidden;border:2px solid #334155;margin:14px 0}
.btn{display:block;width:100%;padding:14px;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;transition:.2s}
.btn-save{background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff}
.btn-save:disabled{background:#334155;color:#64748b;cursor:not-allowed}
.btn-gps{background:#0f172a;border:1.5px solid #334155;color:#94a3b8;margin-top:8px;font-size:13px;padding:10px;border-radius:10px;cursor:pointer;width:100%}
.alert{padding:12px 14px;border-radius:8px;font-size:13px;margin-top:12px;display:none;font-weight:600}
.ok{background:#052e16;color:#4ade80;border:1px solid #166534}
.err{background:#2d0a0a;color:#f87171;border:1px solid #7f1d1d}
.info-box{background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px;margin:12px 0}
.info-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1e293b;font-size:13px}
.info-row:last-child{border:none}
.info-label{color:#94a3b8}
.info-val{color:#f1f5f9;font-weight:700;text-align:right;max-width:60%}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
.badge-ok{background:#052e16;color:#4ade80}
.badge-off{background:#1e293b;color:#64748b}
.log-item{padding:10px 0;border-bottom:1px solid #1e293b;font-size:12px}
.log-item:last-child{border:none}
.log-action{font-weight:700;color:#f97316}
.log-detail{color:#94a3b8;margin-top:2px}
.log-time{color:#475569;font-size:11px;margin-top:2px}
.log-user{color:#818cf8;font-weight:700}
.section-title{font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tab{flex:1;padding:10px;text-align:center;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:1.5px solid #334155;color:#64748b;background:#0f172a;transition:.2s}
.tab.active{background:#6366f1;color:#fff;border-color:#6366f1}
.tab-content{display:none}
.tab-content.active{display:block}
.pin-hint{font-size:12px;color:#64748b;margin-bottom:10px}
.radius-info{background:#0f2942;border:1px solid #1e40af;border-radius:8px;padding:10px 14px;font-size:12px;color:#93c5fd;margin-top:8px}
.mt-12{margin-top:12px}
</style>
</head>
<body>
<div class="card">
  <h1>📍 Kelola Lokasi Perusahaan</h1>
  <div class="sub">PDA Mini Mataram — Atur koordinat & radius lokasi perusahaan</div>
  <div class="tabs">
    <div class="tab active" onclick="switchTab('setting',this)">⚙ Setting Lokasi</div>
    <div class="tab" onclick="switchTab('log',this)">⚠ Log Peringatan</div>
  </div>
  <div id="tab-setting" class="tab-content active">
    <div class="section-title">Status Saat Ini</div>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Status</span><span id="statusBadge" class="badge badge-off">Memuat...</span></div>
      <div class="info-row"><span class="info-label">Nama Perusahaan</span><span class="info-val" id="curName">—</span></div>
      <div class="info-row"><span class="info-label">Koordinat</span><span class="info-val" id="curCoord">—</span></div>
      <div class="info-row"><span class="info-label">Radius</span><span class="info-val" id="curRadius">—</span></div>
      <div class="info-row"><span class="info-label">Terakhir diubah</span><span class="info-val" id="curUpdated">—</span></div>
    </div>
    <div class="section-title">Peta — Klik untuk pilih lokasi perusahaan</div>
    <p class="pin-hint">💡 Klik titik di peta untuk menempatkan pin lokasi. Lingkaran ungu = area radius.</p>
    <div id="map"></div>
    <div class="row">
      <div><label>Latitude</label><input id="lat" type="text" placeholder="-8.5836" readonly/></div>
      <div><label>Longitude</label><input id="lng" type="text" placeholder="116.1017" readonly/></div>
    </div>
    <div class="mt-12">
      <label>Radius (meter)</label>
      <input id="radius" type="number" placeholder="500" value="500" min="50" max="50000" oninput="onRadiusChange()"/>
      <div class="radius-info" id="radiusInfo">Radius: <b>500 meter</b> dari titik perusahaan</div>
    </div>
    <div class="mt-12"><label>Nama Perusahaan</label><input id="namaPerusahaan" type="text" placeholder="PDA Mini Mataram" value="PDA Mini Mataram"/></div>
    <div class="mt-12"><label>Password Admin</label><input id="adminPwd" type="password" placeholder="Masukkan password admin"/></div>
    <div class="alert ok" id="alertOk">✓ Lokasi & radius berhasil disimpan!</div>
    <div class="alert err" id="alertErr"></div>
    <button class="btn btn-save" id="btnSave" onclick="saveLocation()" style="margin-top:14px">💾 Simpan Lokasi & Radius</button>
    <button class="btn-gps" onclick="useMyLocation()">📱 Gunakan Lokasi GPS Saya</button>
  </div>
  <div id="tab-log" class="tab-content">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span class="section-title" style="margin:0">Log Peringatan Lokasi</span>
      <button onclick="loadLogs()" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer">↻ Refresh</button>
    </div>
    <label>Password Admin</label>
    <input id="adminPwdLog" type="password" placeholder="Masukkan password admin" style="margin-bottom:8px"/>
    <button onclick="loadLogs()" style="background:#6366f1;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;width:100%">🔍 Tampilkan Log Peringatan</button>
    <div id="logContainer" style="margin-top:14px"></div>
  </div>
</div>
<script>
var map=L.map('map').setView([-8.5836,116.1017],13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap',maxZoom:19}).addTo(map);
var marker=null,circle=null,currentLat=null,currentLng=null;
function updateCircle(lat,lng,r){if(circle)map.removeLayer(circle);circle=L.circle([lat,lng],{color:'#6366f1',fillColor:'#6366f1',fillOpacity:0.12,weight:2,radius:r}).addTo(map);}
function placeMarker(lat,lng){if(marker)map.removeLayer(marker);marker=L.marker([lat,lng],{icon:L.divIcon({html:'<div style="background:#6366f1;width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.5)"></div>',iconSize:[16,16],iconAnchor:[8,8]})}).addTo(map);document.getElementById('lat').value=lat.toFixed(7);document.getElementById('lng').value=lng.toFixed(7);currentLat=lat;currentLng=lng;updateCircle(lat,lng,parseInt(document.getElementById('radius').value)||500);}
map.on('click',function(e){placeMarker(e.latlng.lat,e.latlng.lng);});
function onRadiusChange(){var r=parseInt(document.getElementById('radius').value)||500;document.getElementById('radiusInfo').innerHTML='Radius: <b>'+r.toLocaleString('id-ID')+' meter</b> dari titik perusahaan';if(currentLat&&currentLng)updateCircle(currentLat,currentLng,r);}
async function loadCurrentSetting(){try{var res=await fetch('/api/company-location');var data=await res.json();if(data.lat!==null&&data.lat!==undefined){document.getElementById('statusBadge').className='badge badge-ok';document.getElementById('statusBadge').textContent='Aktif';document.getElementById('curName').textContent=data.name||'Perusahaan';document.getElementById('curCoord').textContent=data.lat.toFixed(6)+', '+data.lng.toFixed(6);var rm=Math.round(data.radiusKm*1000);document.getElementById('curRadius').textContent=rm+' meter';document.getElementById('curUpdated').textContent=data.updatedAt?new Date(data.updatedAt).toLocaleString('id-ID'):'Belum pernah';document.getElementById('namaPerusahaan').value=data.name||'PDA Mini Mataram';document.getElementById('radius').value=rm;document.getElementById('radiusInfo').innerHTML='Radius: <b>'+rm.toLocaleString('id-ID')+' meter</b> dari titik perusahaan';placeMarker(data.lat,data.lng);map.setView([data.lat,data.lng],16);}else{document.getElementById('statusBadge').className='badge badge-off';document.getElementById('statusBadge').textContent='Belum dikonfigurasi';document.getElementById('curCoord').textContent='Klik peta untuk atur lokasi';}}catch(e){}}
async function saveLocation(){var lat=parseFloat(document.getElementById('lat').value);var lng=parseFloat(document.getElementById('lng').value);var radiusM=parseInt(document.getElementById('radius').value)||500;var name=document.getElementById('namaPerusahaan').value.trim()||'PDA Mini Mataram';var pwd=document.getElementById('adminPwd').value.trim();if(isNaN(lat)||isNaN(lng)){showErr('Klik peta terlebih dahulu untuk memilih lokasi!');return;}if(!pwd){showErr('Password admin wajib diisi!');return;}var btn=document.getElementById('btnSave');btn.disabled=true;btn.textContent='Menyimpan...';try{var res=await fetch('/api/company-location',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({adminPassword:pwd,lat:lat,lng:lng,radiusKm:radiusM/1000,name:name})});var data=await res.json();if(data.success){showOk();loadCurrentSetting();}else showErr(data.message||'Gagal menyimpan');}catch(e){showErr('Error: '+e.message);}btn.disabled=false;btn.textContent='Simpan Lokasi & Radius';}
function useMyLocation(){if(!navigator.geolocation){showErr('GPS tidak tersedia di browser ini');return;}navigator.geolocation.getCurrentPosition(function(pos){placeMarker(pos.coords.latitude,pos.coords.longitude);map.setView([pos.coords.latitude,pos.coords.longitude],17);},function(err){showErr('Gagal ambil GPS: '+err.message);},{enableHighAccuracy:true});}
async function loadLogs(){var pwd=document.getElementById('adminPwdLog').value.trim();if(!pwd){document.getElementById('logContainer').innerHTML='<div style="color:#f87171;font-size:13px;padding:10px 0">Masukkan password admin untuk melihat log</div>';return;}document.getElementById('logContainer').innerHTML='<div style="color:#94a3b8;font-size:13px;padding:10px 0">Memuat log...</div>';try{var res=await fetch('/api/activity-log?adminPassword='+encodeURIComponent(pwd)+'&limit=200');var data=await res.json();if(!data.success){document.getElementById('logContainer').innerHTML='<div style="color:#f87171;font-size:13px">'+(data.message||'Unauthorized')+'</div>';return;}var warns=(data.logs||[]).filter(function(l){return l.type==='location-warning'||(l.action&&l.action.includes('LOKASI'));});if(warns.length===0){document.getElementById('logContainer').innerHTML='<div style="color:#4ade80;font-size:13px;padding:20px;text-align:center;background:#052e16;border-radius:8px">Tidak ada peringatan lokasi tercatat</div>';return;}document.getElementById('logContainer').innerHTML=warns.map(function(l){return'<div class="log-item"><div style="display:flex;justify-content:space-between;align-items:center"><span class="log-user">👤 '+l.username+'</span><span class="log-action">'+l.action+'</span></div><div class="log-detail">📍 '+l.detail+'</div><div class="log-time">'+new Date(l.createdAt).toLocaleString('id-ID')+'</div></div>';}).join('');}catch(e){document.getElementById('logContainer').innerHTML='<div style="color:#f87171;font-size:13px">Error: '+e.message+'</div>';}}
function switchTab(name,el){document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});document.querySelectorAll('.tab-content').forEach(function(t){t.classList.remove('active');});el.classList.add('active');document.getElementById('tab-'+name).classList.add('active');}
function showOk(){var a=document.getElementById('alertOk');a.style.display='block';document.getElementById('alertErr').style.display='none';setTimeout(function(){a.style.display='none';},4000);}
function showErr(msg){var a=document.getElementById('alertErr');a.textContent=msg;a.style.display='block';document.getElementById('alertOk').style.display='none';}
loadCurrentSetting();
<\/script>
</body>
</html>`);
    }

    // DELETE /location-warnings
    if (path === "/location-warnings" && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const logs = await getJson("activity-logs", []);
      const filtered = logs.filter(l => l.type !== "location-warning" && !(l.action && l.action.includes("LOKASI DI LUAR")));
      const removed = logs.length - filtered.length;
      await setJson("activity-logs", filtered);
      return json({ success: true, message: removed + " log peringatan lokasi berhasil dihapus", removed });
    }

    // POST /price-snapshot/refresh
    if (path === "/price-snapshot/refresh" && method === "POST") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      ["price-snapshot-current","price-snapshot-prev","price-snapshot-highest","sync-meta","__promo_etag"].forEach(k => _memCache.delete(k));
      await setJson("price-refresh-ts", { ts: Date.now() });
      return json({ success: true, message: "Cache harga diperbarui. Semua user akan mendapat data terbaru." });
    }

    // GET /price-refresh-ts
    if (path === "/price-refresh-ts" && method === "GET") {
      const sig = await getJson("price-refresh-ts", { ts: 0 });
      return json({ ts: sig.ts || 0 }, 200, { "Cache-Control": "no-store" });
    }

    // POST /morning-reset
    if (path === "/morning-reset" && method === "POST") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      await Promise.all([
        setJson("bblm-status", { status: "updating", updatedAt: now.toISOString() }),
        setJson("price-snapshot-prev", { date: null, prices: {} }),
        setJson("morning-reset-log", { date: today, executedAt: now.toISOString() }),
      ]);
      return json({ success: true, message: "Reset pagi berhasil: BBLM → Masih Update, Harga Coret → direset", executedAt: now.toISOString() });
    }

    // GET /morning-reset-status
    if (path === "/morning-reset-status" && method === "GET") {
      const log = await getJson("morning-reset-log", { date: null, executedAt: null });
      const today = new Date().toISOString().slice(0, 10);
      return json({ success: true, done: log.date === today, date: log.date, executedAt: log.executedAt });
    }

    // POST /password-reset-request
    if (path === "/password-reset-request" && method === "POST") {
      const { username } = body;
      if (!username) return json({ success: false, message: "username wajib diisi" }, 400);
      const requests = await getJson("pw-reset-requests", []);
      const existing = requests.findIndex(r => r.username === username);
      const entry = { username, requestedAt: new Date().toISOString(), handled: false };
      if (existing >= 0) requests[existing] = entry;
      else requests.unshift(entry);
      if (requests.length > 50) requests.length = 50;
      await setJson("pw-reset-requests", requests);
      return json({ success: true });
    }

    // GET /password-reset-requests
    if (path === "/password-reset-requests" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const requests = await getJson("pw-reset-requests", []);
      return json({ success: true, requests: requests.filter(r => !r.handled) });
    }

    // PATCH /password-reset-requests/:username
    const pwResetMatch = path.match(/^\/password-reset-requests\/([^/]+)$/);
    if (pwResetMatch && method === "PATCH") {
      if (body.adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const uname = decodeURIComponent(pwResetMatch[1]);
      const requests = await getJson("pw-reset-requests", []);
      const idx = requests.findIndex(r => r.username === uname);
      if (idx >= 0) { requests[idx].handled = true; await setJson("pw-reset-requests", requests); }
      return json({ success: true });
    }


    // ── BBLM FOTO routes ──────────────────────────────────────────────────

    // POST /bblm-foto/clear — clear all (must be before :id match)
    if (path === "/bblm-foto/clear" && method === "POST") {
      if (body.adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const list = await getJson("bblm-foto", []);
      const store = getInventoryStore();
      await Promise.all(list.map(it => store.delete("bblm-foto-photo-" + it.id).catch(() => {})));
      await setJson("bblm-foto", []);
      await setJson("bblm-foto-downloaded", []);
      return json({ success: true, deleted: list.length });
    }

    // POST /bblm-foto/mark-downloaded — tandai item sudah diunduh
    if (path === "/bblm-foto/mark-downloaded" && method === "POST") {
      const { ids } = body;
      if (!Array.isArray(ids) || ids.length === 0) return json({ success: false, message: "ids wajib array" }, 400);
      const current = await getJson("bblm-foto-downloaded", []);
      const set = new Set(current.map(String));
      ids.forEach(id => set.add(String(id)));
      await setJson("bblm-foto-downloaded", [...set]);
      return json({ success: true, total: set.size });
    }

    // GET /bblm-foto — list metadata (no photos embedded)
    if (path === "/bblm-foto" && method === "GET") {
      const list = await getJson("bblm-foto", []);
      const downloadedIds = await getJson("bblm-foto-downloaded", []);
      return json({ success: true, count: list.length, items: list, downloadedIds });
    }

    // POST /bblm-foto — add item (photo stored separately)
    if (path === "/bblm-foto" && method === "POST") {
      const { barcode, prodCd, prodNm, stkQty, category, posisi, username } = body;
      if (!barcode) return json({ success: false, message: "barcode wajib diisi" }, 400);
      const id = Date.now().toString() + Math.random().toString(36).slice(2, 6);
      const list = await getJson("bblm-foto", []);
      const newItem = {
        id, barcode: barcode || "", prodCd: prodCd || "", prodNm: prodNm || "",
        stkQty: stkQty || "", category: category || "", posisi: posisi || "",
        username: username || "",
        capturedAt: new Date().toISOString(), hasPhoto: false
      };
      list.push(newItem);
      await setJson("bblm-foto", list);
      return json({ success: true, id, item: newItem });
    }

    // /bblm-foto/:id/photo — GET or POST photo
    const bblmFotoPhotoMatch = path.match(/^\/bblm-foto\/([^/]+)\/photo$/);
    if (bblmFotoPhotoMatch) {
      const id = bblmFotoPhotoMatch[1];
      const store = getInventoryStore();
      if (method === "GET") {
        const photo = await store.get("bblm-foto-photo-" + id);
        if (!photo) return json({ success: false, message: "foto tidak ditemukan" }, 404);
        return json({ success: true, fotoBase64: photo });
      }
      if (method === "POST") {
        const { fotoBase64 } = body;
        if (!fotoBase64) return json({ success: false, message: "fotoBase64 wajib" }, 400);
        await store.set("bblm-foto-photo-" + id, fotoBase64);
        const list = await getJson("bblm-foto", []);
        const idx = list.findIndex(it => it.id === id);
        if (idx >= 0) { list[idx].hasPhoto = true; await setJson("bblm-foto", list); }
        return json({ success: true });
      }
    }

    // PATCH /bblm-foto/:id — update metadata
    const bblmFotoDelMatch = path.match(/^\/bblm-foto\/([^/]+)$/);
    if (bblmFotoDelMatch && method === "PATCH") {
      const id = bblmFotoDelMatch[1];
      const { prodNm, stkQty, category, posisi } = body;
      const list = await getJson("bblm-foto", []);
      const idx = list.findIndex(it => it.id === id);
      if (idx < 0) return json({ success: false, message: "Item tidak ditemukan" }, 404);
      if (prodNm   !== undefined) list[idx].prodNm   = prodNm;
      if (stkQty   !== undefined) list[idx].stkQty   = stkQty;
      if (category !== undefined) list[idx].category = category;
      if (posisi   !== undefined) list[idx].posisi   = posisi;
      list[idx].updatedAt = new Date().toISOString();
      await setJson("bblm-foto", list);
      return json({ success: true, item: list[idx] });
    }

    // DELETE /bblm-foto/:id
    if (bblmFotoDelMatch && method === "DELETE") {
      const id = bblmFotoDelMatch[1];
      const list = await getJson("bblm-foto", []);
      const newList = list.filter(it => it.id !== id);
      await setJson("bblm-foto", newList);
      try { const store = getInventoryStore(); await store.delete("bblm-foto-photo-" + id); } catch {}
      return json({ success: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: "Internal server error", detail: String(err) }, 500);
  }
}
