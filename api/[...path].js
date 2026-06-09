import { neon, neonConfig } from "@neondatabase/serverless";

// Aktifkan connection caching agar tiap request tidak buka koneksi baru ke Neon
neonConfig.fetchConnectionCache = true;

const sql = neon(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL);

let dbReady = false;
async function initDb() {
  if (dbReady) return;
  await sql`CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  dbReady = true;
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "00000";
const SNAP_PASSWORD = process.env.SNAP_PASSWORD || "00000";

async function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

async function getJson(key, defaultValue) {
  if (_CACHEABLE.has(key)) {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
  }
  try {
    await initDb();
    const rows = await sql`SELECT value FROM kv_store WHERE key = ${key}`;
    const val = (!rows.length || rows[0].value === null) ? defaultValue : rows[0].value;
    if (_CACHEABLE.has(key)) cacheSet(key, val);
    return val;
  } catch {
    return defaultValue;
  }
}

async function setJson(key, data) {
  cacheInvalidate(key);
  await initDb();
  await sql`INSERT INTO kv_store (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(data)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(data)}, updated_at = NOW()`;
  if (_CACHEABLE.has(key)) cacheSet(key, data);
}

async function deleteKey(key) {
  await initDb();
  await sql`DELETE FROM kv_store WHERE key = ${key}`;
  cacheInvalidate(key);
}

// ============================================================
// IN-MEMORY CACHE (module-level, survives warm Vercel instances)
// Reduces DB reads untuk key yang sering dibaca
// ============================================================
const _memCache = new Map();
const _CACHE_TTL = 60 * 1000; // 1 menit

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

// Update price-snapshot-highest: simpan harga tertinggi per produk dari semua snapshot
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

// Jalankan initDb saat cold start, bukan nunggu request pertama
const dbReadyPromise = initDb().catch(() => {});

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const urlObj = new URL(req.url, "http://localhost");
  const path = urlObj.pathname.replace(/^\/?api/, "") || "/";
  const method = req.method;
  const query = Object.fromEntries(urlObj.searchParams.entries());

  let body = {};
  if (method !== "GET" && method !== "HEAD") {
    body = await parseBody(req);
  }

  const send = (data, status = 200) => res.status(status).json(data);

  try {
    if (path === "/healthz" && method === "GET") return send({ status: "ok" });

    if (path === "/bblm" && method === "GET") {
      const bblmData = await getJson("bblm", { hasData: false, gradeNames: [], products: [], totalProducts: 0, updatedAt: null, updatedBy: "", sourceLabel: "" });
      if (bblmData.updatedAt) {
        const etag = '"' + bblmData.updatedAt + '"';
        res.setHeader("Cache-Control", "public, max-age=1800, stale-while-revalidate=3600");
        res.setHeader("ETag", etag);
        if (req.headers["if-none-match"] === etag) return res.status(304).end();
      }
      return send(bblmData);
    }

    if (path === "/bblm" && method === "POST") {
      const { gradeNames, products, sourceLabel, updatedBy } = body;
      if (!Array.isArray(products)) return send({ success: false, message: "products must be an array" }, 400);
      const data = { hasData: true, gradeNames: Array.isArray(gradeNames) ? gradeNames : [], products, totalProducts: products.length, updatedAt: new Date().toISOString(), updatedBy: updatedBy ?? "unknown", sourceLabel: sourceLabel ?? "unknown" };
      await setJson("bblm", data);
      return send({ success: true, totalProducts: products.length });
    }

    if (path === "/bblm-status" && method === "GET") return send(await getJson("bblm-status", { status: "updating", updatedAt: null }));

    if (path === "/bblm-status" && method === "POST") {
      const { status, adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      if (status !== "updated" && status !== "updating") return send({ success: false, message: "status must be 'updated' or 'updating'" }, 400);
      const updatedAt = new Date().toISOString();
      await setJson("bblm-status", { status, updatedAt });
      return send({ success: true, status, updatedAt, message: status === "updated" ? "BBLM sudah di update" : "BBLM masih proses update" });
    }

    if (path === "/pwd-status" && method === "GET") return send(await getJson("pwd-status", {}));

    if (path === "/pwd-status" && method === "POST") {
      const { username, changedAt } = body;
      if (!username) return send({ success: false, message: "username is required" }, 400);
      const current = await getJson("pwd-status", {});
      current[username] = changedAt ?? new Date().toISOString();
      await setJson("pwd-status", current);
      return send({ success: true });
    }

    if (path === "/activity-log" && method === "GET") {
      const { adminPassword, limit, username } = query;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      let logs = await getJson("activity-logs", []);
      if (username) logs = logs.filter(l => l.username === username);
      return send({ success: true, logs: logs.slice(0, Math.min(parseInt(limit ?? "100", 10) || 100, 1000)) });
    }

    if (path === "/activity-log" && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      await setJson("activity-logs", []);
      return send({ success: true, message: "Semua log berhasil dihapus" });
    }

    if (path === "/activity-log" && method === "POST") {
      const { username, action, detail } = body;
      if (!username || !action) return send({ success: false, message: "username and action are required" }, 400);
      const logs = await getJson("activity-logs", []);
      logs.unshift({ username, action, detail: detail ?? "", createdAt: new Date().toISOString() });
      if (logs.length > 1000) logs.length = 1000;
      await setJson("activity-logs", logs);
      return send({ success: true });
    }

    if (path === "/login" && method === "POST") {
      const { username, password } = body;
      if (!username || !password) return send({ success: false, message: "username dan password wajib diisi" }, 400);
      const users = await getJson("users", []);
      const user = users.find(u => u.username === username.trim() && u.password === password.trim());
      if (!user) return send({ success: false, notFound: true, message: "User tidak ditemukan di server" }, 404);
      if (user.suspended) return send({ success: false, suspended: true, message: "Akun ditangguhkan oleh admin" }, 403);
      return send({ success: true, namaLengkap: user.namaLengkap || user.username });
    }

    if (path === "/users" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const users = await getJson("users", []);
      return send({ success: true, users: users.map(u => ({ username: u.username, namaLengkap: u.namaLengkap || u.username, suspended: u.suspended ?? false, createdAt: u.createdAt ?? null })) });
    }

    if (path === "/users" && method === "POST") {
      const { adminPassword, username, password, namaLengkap } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      if (!username || !password) return send({ success: false, message: "username dan password wajib diisi" }, 400);
      const users = await getJson("users", []);
      if (users.find(u => u.username === username.trim())) return send({ success: false, message: "Username sudah ada" }, 409);
      users.push({ username: username.trim(), password: password.trim(), namaLengkap: (namaLengkap || username).trim(), suspended: false, createdAt: new Date().toISOString() });
      await setJson("users", users);
      return send({ success: true });
    }

    if (path === "/users/import" && method === "POST") {
      const { adminPassword, usersData } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      if (!Array.isArray(usersData)) return send({ success: false, message: "usersData must be array" }, 400);
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
      return send({ success: true, added, total: existing.length });
    }

    const userPatchMatch = path.match(/^\/users\/([^/]+)$/);
    if (userPatchMatch && method === "PATCH") {
      const { adminPassword, namaLengkap, suspended, password } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const username = decodeURIComponent(userPatchMatch[1]);
      const users = await getJson("users", []);
      const idx = users.findIndex(u => u.username === username);
      if (idx === -1) return send({ success: false, message: "User tidak ditemukan" }, 404);
      if (namaLengkap !== undefined) users[idx].namaLengkap = namaLengkap.trim();
      if (suspended !== undefined) users[idx].suspended = suspended;
      if (password !== undefined && password !== "") users[idx].password = password.trim();
      await setJson("users", users);
      return send({ success: true });
    }

    const userDeleteMatch = path.match(/^\/users\/([^/]+)$/);
    if (userDeleteMatch && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const username = decodeURIComponent(userDeleteMatch[1]);
      let users = await getJson("users", []);
      const before = users.length;
      users = users.filter(u => u.username !== username);
      if (users.length === before) return send({ success: false, message: "User tidak ditemukan" }, 404);
      await setJson("users", users);
      return send({ success: true });
    }

    if (path === "/maintenance" && method === "GET") {
      const data = await getJson("maintenance", { active: false, message: "", updatedAt: null });
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      return send(data);
    }

    if (path === "/maintenance" && method === "POST") {
      const { adminPassword, active, message } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const data = { active: !!active, message: message ?? "", updatedAt: new Date().toISOString() };
      await setJson("maintenance", data);
      return send({ success: true, ...data });
    }

    if (path === "/storage-info" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const keys = ["users","bblm","activity-logs","product-requests","maintenance","bblm-status","price-snapshot-current","price-snapshot-prev"];
      const results = await Promise.all(keys.map(async k => {
        try {
          const rows = await sql`SELECT value FROM kv_store WHERE key = ${k}`;
          const val = rows.length ? rows[0].value : null;
          const str = val ? JSON.stringify(val) : "";
          const bytes = Buffer.byteLength(str, "utf8");
          return { key: k, bytes, kb: (bytes/1024).toFixed(2) };
        } catch { return { key: k, bytes: 0, kb: "0.00" }; }
      }));
      const totalBytes = results.reduce((s,r)=>s+r.bytes, 0);
      return send({ success: true, items: results, totalKB: (totalBytes/1024).toFixed(2), totalMB: (totalBytes/1024/1024).toFixed(4) });
    }

    if (path === "/backup" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const [users, bblm, logs, requests, maintenance, bblmStatus, snapshotCurrent, snapshotPrev] = await Promise.all([
        getJson("users", []), getJson("bblm", {}), getJson("activity-logs", []),
        getJson("product-requests", []), getJson("maintenance", { active: false, message: "" }), getJson("bblm-status", {}),
        getJson("price-snapshot-current", { date: null, prices: {} }), getJson("price-snapshot-prev", { date: null, prices: {} }),
      ]);
      return send({ success: true, exportedAt: new Date().toISOString(), data: { users, bblm, "activity-logs": logs, "product-requests": requests, maintenance, "bblm-status": bblmStatus, "price-snapshot-current": snapshotCurrent, "price-snapshot-prev": snapshotPrev } });
    }

    if (path === "/restore" && method === "POST") {
      const { adminPassword, data } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      if (!data || typeof data !== "object") return send({ success: false, message: "data harus berupa object" }, 400);
      const keys = ["users","bblm","activity-logs","product-requests","maintenance","bblm-status","price-snapshot-current","price-snapshot-prev"];
      let restored = 0;
      await Promise.all(keys.map(async k => { if (data[k] !== undefined) { await setJson(k, data[k]); restored++; } }));
      return send({ success: true, message: restored + " kunci data berhasil direstore" });
    }

    if (path.startsWith("/price-history/") && method === "GET") {
      const barcode = decodeURIComponent(path.replace("/price-history/", "").trim());
      if (!barcode) return send({ success: false, message: "barcode wajib diisi" }, 400);
      const [individual, prev, current, highest, excluded] = await Promise.all([
        getJson(`price-history:${barcode}`, null),
        getJson("price-snapshot-prev", { date: null, prices: {} }),
        getJson("price-snapshot-current", { date: null, prices: {} }),
        getJson("price-snapshot-highest", { prices: {} }),
        getJson("promo-excluded", { barcodes: [] })
      ]);
      // Jika barcode dikecualikan dari promo, kembalikan data tanpa info promo
      const isExcluded = (excluded.barcodes || []).includes(barcode);
      const currentSnapshotPrice = current?.prices?.[barcode];
      let promo = null;

      if (!isExcluded) {
        // 1. Cek harga tertinggi otomatis dari semua snapshot
        const highestPrice = highest?.prices?.[barcode];
        if (highestPrice != null && currentSnapshotPrice != null && highestPrice > currentSnapshotPrice) {
          promo = { prevPrice: highestPrice, currentPrice: currentSnapshotPrice, source: "highest" };
        }

        // 2. Cek acuan manual (price-snapshot-prev) — pakai jika harganya lebih tinggi dari highest
        const prevPrice = prev?.prices?.[barcode];
        if (prevPrice != null && currentSnapshotPrice != null && prevPrice > currentSnapshotPrice) {
          if (!promo || prevPrice > promo.prevPrice) {
            promo = { prevPrice, currentPrice: currentSnapshotPrice, source: "manual", date: prev.date };
          }
        }
      }

      const prevPrice = prev?.prices?.[barcode];
      const data = prevPrice != null ? { price: prevPrice, date: prev.date } : individual;
      return send({ success: true, data, promo, excluded: isExcluded });
    }

    if (path === "/price-history" && method === "POST") {
      const { barcode, price } = body;
      if (!barcode || price === undefined) return send({ success: false, message: "barcode dan price wajib diisi" }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const existing = await getJson(`price-history:${barcode}`, null);
      if (!existing || existing.date !== today) await setJson(`price-history:${barcode}`, { price: Number(price), date: today });
      return send({ success: true });
    }

    // GET /upload-harga — halaman kelola harga acuan (harga coret)
    if (path === "/upload-harga" && method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).end(`<!DOCTYPE html>
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
    const cur=j.current, prev=j.prev;
    // Harga Terbaru (current)
    const bT=document.getElementById("boxTerbaru");
    if(cur&&cur.count>0){
      bT.className="status-box has-data";
      document.getElementById("iconTerbaru").textContent="✅";
      document.getElementById("countTerbaru").innerHTML='<span class="status-count">'+cur.count.toLocaleString("id-ID")+'</span>';
      document.getElementById("dateTerbaru").textContent=cur.date?"Tanggal: "+cur.date:"";
    }else{
      bT.className="status-box no-data";
      document.getElementById("iconTerbaru").textContent="⏳";
      document.getElementById("countTerbaru").innerHTML='<span class="status-empty">Belum ada (buka aplikasi dulu)</span>';
      document.getElementById("dateTerbaru").textContent="";
    }
    // Harga Acuan (prev)
    const bA=document.getElementById("boxAcuan");
    if(prev&&prev.count>0){
      bA.className="status-box has-data";
      document.getElementById("iconAcuan").textContent="✅";
      document.getElementById("countAcuan").innerHTML='<span class="status-count">'+prev.count.toLocaleString("id-ID")+'</span>';
      document.getElementById("dateAcuan").textContent=prev.date?"Disimpan: "+prev.date:"";
    }else{
      bA.className="status-box no-data";
      document.getElementById("iconAcuan").textContent="❌";
      document.getElementById("countAcuan").innerHTML='<span class="status-empty">Belum ada</span>';
      document.getElementById("dateAcuan").textContent="";
    }
    // Peringatan
    const wb=document.getElementById("warnBox");
    if(cur&&cur.count>0&&(!prev||prev.count===0)){
      wb.style.display="block";
      wb.textContent="⚠️ Harga acuan belum disimpan. Klik tombol di bawah SEBELUM mengubah harga di spreadsheet agar harga coret bisa tampil.";
    }else if(cur&&cur.count>0&&prev&&prev.count>0&&cur.date===prev.date){
      wb.style.display="block";
      wb.textContent="ℹ️ Harga acuan sudah disimpan hari ini ("+prev.date+"). Sekarang update spreadsheet dengan harga baru — harga coret akan otomatis tampil.";
    }else{
      wb.style.display="none";
    }
  }catch(e){
    document.getElementById("countTerbaru").textContent="Gagal memuat";
  }
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
      return;
    }

    // POST /set-price-acuan — admin eksplisit simpan harga terbaru sebagai acuan harga coret (current → prev)
    if (path === "/set-price-acuan" && method === "POST") {
      const { snapPassword, adminPassword } = body;
      const pw = snapPassword || adminPassword || "";
      if (pw !== SNAP_PASSWORD && pw !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const current = await getJson("price-snapshot-current", { date: null, prices: {} });
      if (!current.date || Object.keys(current.prices || {}).length === 0) {
        return send({ success: false, message: "Belum ada harga terbaru di server. Buka aplikasi dulu agar harga tersinkron dari spreadsheet." });
      }
      await setJson("price-snapshot-prev", current);
      // Simpan juga ke riwayat harga per tanggal
      const snapIdxAcuan = await getJson("price-snapshots-index", []);
      if (!snapIdxAcuan.some(s => s.date === current.date)) {
        await setJson(`price-snapshot:${current.date}`, current);
        snapIdxAcuan.unshift({ date: current.date, count: Object.keys(current.prices || {}).length });
        if (snapIdxAcuan.length > 60) snapIdxAcuan.length = 60;
        await setJson("price-snapshots-index", snapIdxAcuan);
        await updateHighestSnapshot(current.prices);
      } else {
        // Snapshot tanggal ini sudah ada, tetap update highest
        await updateHighestSnapshot(current.prices);
      }
      const count = Object.keys(current.prices).length;
      return send({ success: true, saved: count, message: count.toLocaleString("id-ID") + " harga berhasil disimpan sebagai acuan. Sekarang update spreadsheet — harga coret akan tampil otomatis." });
    }

    // GET /sync-prices/check — ringan, cek apakah perlu kirim ulang data harga (hemat bandwidth)
    if (path === "/sync-prices/check" && method === "GET") {
      const { date, count } = query;
      const syncMeta = await getJson("sync-meta", { date: null, count: 0 });
      const needSync = !date || !count || syncMeta.date !== date || syncMeta.count !== parseInt(count, 10);
      res.setHeader("Cache-Control", "no-store");
      return send({ needSync, serverDate: syncMeta.date || null, serverCount: syncMeta.count || 0 });
    }

    if (path === "/sync-prices" && method === "GET") {
      const [current, prev, highest] = await Promise.all([
        getJson("price-snapshot-current", { date: null, prices: {} }),
        getJson("price-snapshot-prev", { date: null, prices: {} }),
        getJson("price-snapshot-highest", { prices: {}, updatedAt: null })
      ]);
      const cPrices = current.prices || {};
      const pPrices = prev.prices || {};
      const hPrices = highest.prices || {};
      const diffCount = Object.keys(hPrices).filter(bc => {
        const hp = hPrices[bc]; const cp = cPrices[bc];
        return hp != null && cp != null && hp > cp;
      }).length;
      const diffCountManual = Object.keys(pPrices).filter(bc => {
        const pp = pPrices[bc]; const cp = cPrices[bc];
        return pp != null && cp != null && pp > cp;
      }).length;
      const cCount = Object.keys(cPrices).length;
      const etag = '"sp-' + (current.date||"null") + "-" + (prev.date||"null") + "-" + cCount + '"';
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
      const syncMeta = await getJson("sync-meta", { date: null, count: 0 });
      const today = new Date().toISOString().slice(0, 10);
      const needSync = syncMeta.date !== today || syncMeta.count !== cCount;
      return send({ success: true,
        current: { date: current.date, count: cCount },
        prev: { date: prev.date, count: Object.keys(pPrices).length, diffCount: diffCountManual },
        highest: { count: Object.keys(hPrices).length, updatedAt: highest.updatedAt, diffCount },
        diffCount,
        needSync
      });
    }

    // POST /sync-prices — dipanggil otomatis oleh app saat load, simpan harga terbaru dari spreadsheet
    if (path === "/sync-prices" && method === "POST") {
      const { items } = body;
      if (!Array.isArray(items) || !items.length) return send({ success: false, message: "items harus array" }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const prices = {};
      items.forEach(({ barcode, price }) => { if (barcode) prices[barcode] = Number(price) || 0; });
      const incomingCount = Object.keys(prices).length;

      // OPTIMASI BANDWIDTH: skip DB write jika tanggal + jumlah produk sudah sama
      // (semua user baca dari spreadsheet yang sama → data identik)
      const syncMeta = await getJson("sync-meta", { date: null, count: 0 });
      if (syncMeta.date === today && syncMeta.count === incomingCount) {
        return send({ success: true, saved: incomingCount, skipped: true });
      }

      // Data baru atau jumlah produk berubah → simpan ke DB
      const [_, existingHighest] = await Promise.all([
        setJson("price-snapshot-current", { date: today, prices }),
        getJson("price-snapshot-highest", { prices: {}, updatedAt: null })
      ]);
      // Update sync-meta agar request berikutnya bisa di-skip
      await setJson("sync-meta", { date: today, count: incomingCount });

      const highest = existingHighest.prices || {};
      let updated = 0;
      for (const [barcode, price] of Object.entries(prices)) {
        const p = Number(price) || 0;
        if (p > 0 && (highest[barcode] == null || p > highest[barcode])) {
          highest[barcode] = p;
          updated++;
        }
      }
      if (updated > 0) {
        await setJson("price-snapshot-highest", { prices: highest, updatedAt: new Date().toISOString() });
      }
      return send({ success: true, saved: incomingCount, skipped: false });
    }

    if (path === "/product-request" && method === "POST") {
      const { barcode, namaBarang, keterangan, username } = body;
      if (!barcode || !namaBarang || !username) return send({ success: false, message: "barcode, namaBarang, dan username wajib diisi" }, 400);
      const list = await getJson("product-requests", []);
      const { randomUUID } = await import("crypto");
      list.unshift({ id: randomUUID(), barcode: barcode.trim(), namaBarang: namaBarang.trim(), keterangan: (keterangan ?? "").trim(), username: username.trim(), createdAt: new Date().toISOString(), resolved: false });
      if (list.length > 500) list.length = 500;
      await setJson("product-requests", list);
      return send({ success: true });
    }

    if (path === "/product-request" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      let list = await getJson("product-requests", []);
      if (query.showResolved !== "1") list = list.filter(r => !r.resolved);
      return send({ success: true, requests: list });
    }

    const patchMatch = path.match(/^\/product-request\/([^/]+)\/resolve$/);
    if (patchMatch && method === "PATCH") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const id = patchMatch[1];
      const list = await getJson("product-requests", []);
      const idx = list.findIndex(r => r.id === id);
      if (idx === -1) return send({ success: false, message: "Request tidak ditemukan" }, 404);
      list[idx].resolved = true;
      list[idx].resolvedAt = new Date().toISOString();
      await setJson("product-requests", list);
      return send({ success: true });
    }


    // GET /price-snapshots — daftar riwayat snapshot harga per tanggal
    if (path === "/price-snapshots" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const snapIndex = await getJson("price-snapshots-index", []);
      return send({ success: true, snapshots: snapIndex });
    }

    // POST /price-snapshots/:date/set-acuan — jadikan snapshot tanggal tertentu sebagai acuan harga coret
    const setAcuanMatch = path.match(/^\/price-snapshots\/(\d{4}-\d{2}-\d{2})\/set-acuan$/);
    if (setAcuanMatch && method === "POST") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const date = setAcuanMatch[1];
      const snap = await getJson(`price-snapshot:${date}`, null);
      if (!snap) return send({ success: false, message: `Snapshot ${date} tidak ditemukan` }, 404);
      await setJson("price-snapshot-prev", snap);
      await updateHighestSnapshot(snap.prices);
      const count = Object.keys(snap.prices || {}).length;
      return send({ success: true, message: `Snapshot ${date} (${count.toLocaleString("id-ID")} produk) dijadikan acuan harga coret` });
    }

    // POST /price-snapshots/rebuild-highest — bangun ulang price-snapshot-highest dari semua snapshot tersimpan
    if (path === "/price-snapshots/rebuild-highest" && method === "POST") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const snapIndex = await getJson("price-snapshots-index", []);
      if (!snapIndex.length) return send({ success: false, message: "Belum ada snapshot tersimpan" });
      const highest = {};
      let processed = 0;
      for (const s of snapIndex) {
        const snap = await getJson(`price-snapshot:${s.date}`, null);
        if (!snap || !snap.prices) continue;
        for (const [barcode, price] of Object.entries(snap.prices)) {
          const p = Number(price) || 0;
          if (p > 0 && (highest[barcode] == null || p > highest[barcode])) {
            highest[barcode] = p;
          }
        }
        processed++;
      }
      if (!processed) return send({ success: false, message: "Tidak ada data snapshot yang bisa dibaca" });
      await setJson("price-snapshot-highest", { prices: highest, updatedAt: new Date().toISOString() });
      const count = Object.keys(highest).length;
      return send({ success: true, processed, message: `Berhasil membangun ulang dari ${processed} snapshot. ${count.toLocaleString("id-ID")} produk tersimpan di harga tertinggi.`, count });
    }

        // DELETE /price-snapshots/:date — hapus snapshot tanggal tertentu
    const snapDeleteMatch = path.match(/^\/price-snapshots\/(\d{4}-\d{2}-\d{2})$/);
    if (snapDeleteMatch && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const date = snapDeleteMatch[1];
      await deleteKey(`price-snapshot:${date}`);
      const snapIndex = await getJson("price-snapshots-index", []);
      await setJson("price-snapshots-index", snapIndex.filter(s => s.date !== date));
      return send({ success: true, message: `Snapshot ${date} berhasil dihapus` });
    }

    // POST /price-snapshot-highest/reset — hapus dan reset price-snapshot-highest (admin only)
    if (path === "/price-snapshot-highest/reset" && method === "POST") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      await deleteKey("price-snapshot-highest");
      return send({ success: true, message: "price-snapshot-highest berhasil direset. Klik Bangun Ulang Tertinggi untuk membangun ulang dari snapshot yang valid." });
    }

    // GET /promo-list — daftar artikel promo (harga terbaru < harga tertinggi historis)
    if (path === "/promo-list" && method === "GET") {
      const [highest, current, excluded] = await Promise.all([
        getJson("price-snapshot-highest", { prices: {} }),
        getJson("price-snapshot-current", { date: null, prices: {} }),
        getJson("promo-excluded", { barcodes: [] })
      ]);
      const etag = '"pl-' + (highest.updatedAt||"null") + "-" + (current.date||"null") + "-" + (excluded.updatedAt||"null") + '"';
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
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
      return send({
        success: true,
        count: items.length,
        excludedCount: excludedSet.size,
        highestUpdatedAt: highest.updatedAt || null,
        currentDate: current.date || null,
        items
      });
    }

    // GET /promo-excluded — daftar barcode yang dikecualikan dari promo (admin only)
    if (path === "/promo-excluded" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const exc = await getJson("promo-excluded", { barcodes: [] });
      return send({ success: true, barcodes: exc.barcodes || [], updatedAt: exc.updatedAt || null });
    }

    // POST /promo-exclude — tambah barcode ke daftar pengecualian promo (admin only)
    if (path === "/promo-exclude" && method === "POST") {
      const { adminPassword, barcode: bc } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      if (!bc) return send({ success: false, message: "barcode wajib diisi" }, 400);
      const exc = await getJson("promo-excluded", { barcodes: [] });
      const barcodes = exc.barcodes || [];
      if (!barcodes.includes(bc)) {
        barcodes.push(bc);
        await setJson("promo-excluded", { barcodes, updatedAt: new Date().toISOString() });
      }
      return send({ success: true, total: barcodes.length });
    }

    // DELETE /promo-exclude/:barcode — restore barcode dari daftar pengecualian (admin only)
    if (path.startsWith("/promo-exclude/") && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const bc = decodeURIComponent(path.replace("/promo-exclude/", "").trim());
      if (!bc) return send({ success: false, message: "barcode wajib diisi" }, 400);
      const exc = await getJson("promo-excluded", { barcodes: [] });
      const barcodes = (exc.barcodes || []).filter(b => b !== bc);
      await setJson("promo-excluded", { barcodes, updatedAt: new Date().toISOString() });
      return send({ success: true, total: barcodes.length });
    }




    // GET /neo-status — statistik lengkap storage Neon DB (admin only)
    if (path === "/neo-status" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      try {
        await initDb();
        // Ambil semua key + ukuran value dari kv_store
        const rows = await sql`
          SELECT
            key,
            updated_at,
            octet_length(value::text) AS value_bytes,
            jsonb_typeof(value) AS value_type
          FROM kv_store
          ORDER BY octet_length(value::text) DESC
        `;
        // Ambil ukuran tabel dari pg_relation_size
        const tableStats = await sql`
          SELECT
            pg_size_pretty(pg_total_relation_size('kv_store')) AS total_size,
            pg_size_pretty(pg_relation_size('kv_store')) AS table_size,
            pg_size_pretty(pg_indexes_size('kv_store')) AS index_size,
            (SELECT count(*) FROM kv_store)::int AS row_count,
            pg_database_size(current_database()) AS db_bytes_raw,
            pg_size_pretty(pg_database_size(current_database())) AS db_size_pretty
        `;
        const tbl = tableStats[0] || {};
        // Neon free tier = 512 MB = 536870912 bytes
        const NEON_FREE_LIMIT = 536870912;
        const dbBytes = parseInt(tbl.db_bytes_raw || 0);
        const freeBytes = Math.max(0, NEON_FREE_LIMIT - dbBytes);
        const usedPercent = Math.min(100, ((dbBytes / NEON_FREE_LIMIT) * 100).toFixed(1));
        const totalBytes = rows.reduce((s, r) => s + (r.value_bytes || 0), 0);
        // In-memory cache status
        const cacheKeys = [..._memCache.keys()];
        const cacheInfo = cacheKeys.map(k => {
          const e = _memCache.get(k);
          const ttlLeft = e ? Math.max(0, Math.round((e.exp - Date.now()) / 1000)) : 0;
          return { key: k, ttlLeft };
        });
        return send({
          success: true,
          db: {
            totalSize: tbl.total_size || "-",
            tableSize: tbl.table_size || "-",
            indexSize: tbl.index_size || "-",
            rowCount: tbl.row_count || rows.length,
            totalValueBytes: totalBytes,
            totalValueKB: (totalBytes / 1024).toFixed(2),
            totalValueMB: (totalBytes / 1024 / 1024).toFixed(3),
            dbBytes: dbBytes,
            dbSizePretty: tbl.db_size_pretty || "-",
            freeBytes: freeBytes,
            freeSizePretty: (freeBytes / 1048576).toFixed(1) + " MB",
            usedPercent: parseFloat(usedPercent),
            limitBytes: 536870912,
            limitPretty: "512 MB"
          },
          keys: rows.map(r => ({
            key: r.key,
            bytes: r.value_bytes || 0,
            kb: ((r.value_bytes || 0) / 1024).toFixed(2),
            type: r.value_type,
            updatedAt: r.updated_at
          })),
          cache: {
            hitKeys: cacheInfo.length,
            keys: cacheInfo
          },
          checkedAt: new Date().toISOString()
        });
      } catch(e) {
        return send({ success: false, message: "DB error: " + e.message }, 500);
      }
    }

    // GET /neo-monitor — halaman monitor Neon DB (admin only)
    if (path === "/neo-monitor" && method === "GET") {
      if (query.adminPassword !== ADMIN_PASSWORD) {
        res.setHeader("Content-Type","text/html;charset=utf-8");
        return res.status(403).end("<h2>Unauthorized — tambahkan ?adminPassword=xxx ke URL</h2>");
      }
      res.setHeader("Content-Type","text/html;charset=utf-8");
      return res.status(200).end(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Server Neo Monitor - PDA Mini Mataram</title>
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
.ttl-bar{height:4px;border-radius:2px;background:#1e293b;margin-top:3px;overflow:hidden}
.ttl-fill{height:4px;background:#7c3aed;border-radius:2px;transition:.3s}
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
    <h1>&#128201; Server Neo Monitor</h1>
    <div class="sub">PDA Mini Mataram &mdash; Neon PostgreSQL Storage Dashboard</div>
  </div>
  <div class="top-btns">
    <span class="auto-refresh"><span class="status-dot dot-yellow" id="dotStatus"></span><span id="autoLabel">Auto-refresh 30s</span></span>
    <button class="btn btn-refresh" onclick="loadData(true)">&#8635; Refresh Sekarang</button>
    <button class="btn btn-logout" onclick="history.back()">&#8592; Kembali</button>
  </div>
</div>

<div id="errBox" class="err-box" style="display:none"></div>

<!-- STAT CARDS -->
<div class="grid4" id="statCards">
  <div class="stat-card blue"><div class="stat-label">Total Ukuran DB</div><div class="stat-val" id="sTotal">-</div><div class="stat-sub" id="sTableSize">-</div></div>
  <div class="stat-card green"><div class="stat-label">Value Size (JSON)</div><div class="stat-val" id="sValueMB">-</div><div class="stat-sub" id="sValueKB">-</div></div>
  <div class="stat-card purple"><div class="stat-label">Total Rows</div><div class="stat-val" id="sRows">-</div><div class="stat-sub">kunci di kv_store</div></div>
  <div class="stat-card orange"><div class="stat-label">Cache (RAM)</div><div class="stat-val" id="sCacheHits">-</div><div class="stat-sub">key aktif di memori</div></div>
</div>

<!-- KEY TABLE -->
<div class="section">
  <div class="section-title">
    <span>&#128230; Detail Penyimpanan per Key</span>
    <span class="updated-at" id="updatedAt">-</span>
  </div>
  <div id="keyTableContainer"><div class="loading"><div class="spinner"></div>Memuat data...</div></div>
</div>

<!-- CACHE TABLE -->
<div class="section">
  <div class="section-title">&#9889; In-Memory Cache (Vercel RAM)</div>
  <div id="cacheContainer"><div class="loading"><div class="spinner"></div>Memuat cache...</div></div>
</div>

<script>
var adminPw = new URLSearchParams(location.search).get('adminPassword') || '';
var autoTimer = null;
var refreshCountdown = 30;
var countdownTimer = null;

function startCountdown() {
  refreshCountdown = 30;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(function(){
    refreshCountdown--;
    document.getElementById('autoLabel').textContent = 'Auto-refresh ' + refreshCountdown + 's';
    if (refreshCountdown <= 0) { clearInterval(countdownTimer); loadData(false); }
  }, 1000);
}

function fmtBytes(b) {
  if (b >= 1024*1024) return (b/1024/1024).toFixed(2) + ' MB';
  if (b >= 1024) return (b/1024).toFixed(1) + ' KB';
  return b + ' B';
}
function fmtDate(s) {
  if (!s) return '-';
  return new Date(s).toLocaleString('id-ID', {dateStyle:'short',timeStyle:'medium'});
}

async function loadData(manual) {
  var dot = document.getElementById('dotStatus');
  dot.className = 'status-dot dot-yellow';
  document.getElementById('errBox').style.display = 'none';
  try {
    var r = await fetch('/api/neo-status?adminPassword=' + encodeURIComponent(adminPw));
    var j = await r.json();
    if (!j.success) {
      document.getElementById('errBox').textContent = 'Error: ' + (j.message || 'Unauthorized');
      document.getElementById('errBox').style.display = 'block';
      dot.className = 'status-dot dot-red';
      return;
    }
    dot.className = 'status-dot dot-green';
    renderStats(j);
    renderKeyTable(j);
    renderCache(j);
    document.getElementById('updatedAt').textContent = 'Diperbarui: ' + fmtDate(j.checkedAt);
    startCountdown();
  } catch(e) {
    document.getElementById('errBox').textContent = 'Gagal mengambil data: ' + e.message;
    document.getElementById('errBox').style.display = 'block';
    dot.className = 'status-dot dot-red';
  }
}

function renderStats(j) {
  document.getElementById('sTotal').textContent = j.db.totalSize || '-';
  document.getElementById('sTableSize').textContent = 'Table: ' + (j.db.tableSize || '-') + ' / Index: ' + (j.db.indexSize || '-');
  var mb = parseFloat(j.db.totalValueMB);
  document.getElementById('sValueMB').textContent = mb >= 1 ? mb.toFixed(2) + ' MB' : j.db.totalValueKB + ' KB';
  document.getElementById('sValueKB').textContent = parseInt(j.db.totalValueBytes || 0).toLocaleString('id-ID') + ' bytes';
  document.getElementById('sRows').textContent = (j.db.rowCount || 0).toLocaleString('id-ID');
  document.getElementById('sCacheHits').textContent = (j.cache.hitKeys || 0);
}

function renderKeyTable(j) {
  var keys = j.keys || [];
  var maxBytes = keys.reduce(function(m,k){ return Math.max(m, k.bytes); }, 1);
  var rows = keys.map(function(k) {
    var pct = Math.min(100, Math.round((k.bytes / maxBytes) * 100));
    var cls = k.bytes > 500000 ? 'large' : k.bytes > 100000 ? 'warn' : '';
    var tagCls = k.type === 'array' ? 'tag-arr' : k.type === 'object' ? 'tag-obj' : 'tag-str';
    return '<tr>' +
      '<td><span class="key-highlight ' + cls + '">' + k.key + '</span></td>' +
      '<td>' + fmtBytes(k.bytes) + '</td>' +
      '<td style="width:120px"><div class="bar-wrap"><div class="bar" style="width:' + pct + '%;background:' + (cls === 'large' ? '#f87171' : cls === 'warn' ? '#fbbf24' : '#3b82f6') + '"></div></div></td>' +
      '<td><span class="badge ' + tagCls + '">' + (k.type || '-') + '</span></td>' +
      '<td style="color:#475569">' + fmtDate(k.updatedAt) + '</td>' +
    '</tr>';
  }).join('');
  document.getElementById('keyTableContainer').innerHTML = keys.length
    ? '<table><thead><tr><th>Key</th><th>Ukuran</th><th>Proporsi</th><th>Tipe</th><th>Diperbarui</th></tr></thead><tbody>' + rows + '</tbody></table>'
    : '<div style="color:#64748b;padding:16px;text-align:center">Tidak ada data</div>';
}

function renderCache(j) {
  var items = (j.cache.keys || []);
  if (!items.length) {
    document.getElementById('cacheContainer').innerHTML = '<div style="color:#64748b;font-size:12px;padding:8px 0">Belum ada key di RAM cache (cold start atau instance baru)</div>';
    return;
  }
  var html = items.map(function(c){
    var pct = Math.min(100, Math.round((c.ttlLeft / 300) * 100));
    return '<div class="cache-item">' +
      '<span style="color:#c084fc;font-family:monospace;font-size:11px">' + c.key + '</span>' +
      '<span style="color:#94a3b8">' + c.ttlLeft + 's tersisa</span>' +
    '</div>' +
    '<div class="ttl-bar"><div class="ttl-fill" style="width:' + pct + '%"></div></div>';
  }).join('');
  document.getElementById('cacheContainer').innerHTML = html;
}

loadData(true);
</script>
</body>
</html>`);
    }

        // GET /dashboard — halaman dashboard admin
    if (path === "/dashboard" && method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const html = "<!DOCTYPE html>\n<html lang=\"id\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Dashboard Admin - PDA Mini Mataram</title>\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\nbody{font-family:system-ui,sans-serif;background:#0f172a;min-height:100vh;padding:16px;color:#e2e8f0}\nh1{font-size:18px;font-weight:700;color:#fff}\n.sub{color:#64748b;font-size:12px;margin-bottom:20px;margin-top:2px}\n.login-card{background:#1e293b;border-radius:14px;padding:28px 24px;max-width:360px;margin:60px auto}\n.login-card h1{text-align:center;margin-bottom:4px}\n.login-card .sub{text-align:center;margin-bottom:20px}\nlabel{display:block;font-size:12px;font-weight:600;color:#94a3b8;margin-bottom:6px}\ninput[type=password]{width:100%;padding:11px 14px;background:#0f172a;border:1.5px solid #334155;border-radius:8px;font-size:14px;color:#e2e8f0;outline:none}\ninput:focus{border-color:#3b82f6}\n.btn{display:block;width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;margin-top:14px}\n.btn-sm{display:inline-block;padding:7px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:none;margin-right:6px;margin-top:6px}\n.btn-blue{background:#1d4ed8;color:#fff}\n.btn-red{background:#dc2626;color:#fff}\n.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}\n.card{background:#1e293b;border-radius:12px;padding:16px}\n.card.full{grid-column:1/-1}\n.card-label{font-size:11px;color:#64748b;font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}\n.card-val{font-size:28px;font-weight:800;color:#fff;line-height:1}\n.card-sub{font-size:11px;color:#64748b;margin-top:4px}\n.badge{display:inline-block;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700}\n.badge-green{background:#14532d;color:#4ade80}\n.badge-red{background:#450a0a;color:#f87171}\n.badge-yellow{background:#422006;color:#fb923c}\n.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}\n.dot-green{background:#4ade80}\n.dot-yellow{background:#fb923c}\n.log-row{padding:8px 0;border-bottom:1px solid #334155;font-size:12px;display:flex;gap:8px}\n.log-row:last-child{border:none}\n.log-time{color:#64748b;min-width:90px}\n.log-user{color:#60a5fa;font-weight:600;min-width:70px}\n.section-title{font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}\n.action-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}\n.err{color:#f87171;font-size:13px;text-align:center;margin-top:12px}\n</style>\n</head>\n<body>\n<div id=\"L\">\n  <div class=\"login-card\">\n    <h1>&#128737;&#65039; Dashboard Admin</h1>\n    <div class=\"sub\">PDA Mini Mataram</div>\n    <label>Password Admin</label>\n    <input type=\"password\" id=\"P\" placeholder=\"Masukkan password admin\" onkeydown=\"if(event.key==='Enter')login()\">\n    <button class=\"btn\" onclick=\"login()\">Masuk</button>\n    <div class=\"err\" id=\"LE\"></div>\n  </div>\n</div>\n<div id=\"D\" style=\"display:none\">\n  <div style=\"display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px\">\n    <div><h1>&#128737;&#65039; Dashboard Admin</h1><div class=\"sub\">PDA Mini Mataram &middot; <span id=\"LR\">memuat...</span></div></div>\n    <button class=\"btn-sm btn-blue\" onclick=\"load()\" style=\"margin-top:4px\">&#8635; Refresh</button>\n  </div>\n  <div class=\"grid\">\n    <div class=\"card\"><div class=\"card-label\">&#128230; Total Produk</div><div class=\"card-val\" id=\"vP\">-</div><div class=\"card-sub\" id=\"vPS\"></div></div>\n    <div class=\"card\"><div class=\"card-label\">&#128101; Total User</div><div class=\"card-val\" id=\"vU\">-</div><div class=\"card-sub\" id=\"vUS\"></div></div>\n    <div class=\"card\"><div class=\"card-label\">&#128202; Aktivitas Hari Ini</div><div class=\"card-val\" id=\"vA\">-</div><div class=\"card-sub\" id=\"vAS\"></div></div>\n    <div class=\"card\"><div class=\"card-label\">&#128203; Status BBLM</div><div style=\"font-size:16px;margin-top:4px\" id=\"vB\">-</div><div class=\"card-sub\" id=\"vBS\"></div></div>\n    <div class=\"card full\"><div class=\"card-label\">&#127991;&#65039; Status Promo</div><div id=\"vPR\">-</div></div>\n    <div class=\"card full\"><div class=\"card-label\">&#129302; Cron Reset Otomatis</div><div id=\"vC\">-</div></div>\n  </div>\n  <div class=\"card\" style=\"margin-bottom:12px\">\n    <div class=\"section-title\">&#9889; Aksi Cepat</div>\n    <div class=\"action-row\">\n      <button class=\"btn-sm btn-blue\" onclick=\"window.open('/api/upload-harga','_blank')\">&#128228; Upload Harga</button>\n      <button class=\"btn-sm btn-blue\" onclick=\"backup()\">&#128190; Download Backup</button>\n      <button class=\"btn-sm btn-red\" onclick=\"if(confirm('Jalankan reset cron sekarang?'))cronRun()\">&#128260; Jalankan Cron</button>\n      <button class=\"btn-sm\" style=\"background:#7c3aed;color:#fff\" onclick=\"window.open('/api/neo-monitor?adminPassword='+encodeURIComponent(pw),'_blank')\">&#128201; Server Neo</button>\n    </div>\n  </div>\n  <div class=\"card\">\n    <div class=\"section-title\">&#128221; Aktivitas Terbaru</div>\n    <div id=\"vL\"><div style=\"color:#475569;font-size:13px\">Memuat...</div></div>\n  </div>\n</div>\n<script>\nvar pw='';\nfunction login(){\n  var v=document.getElementById('P').value.trim();\n  if(!v){document.getElementById('LE').textContent='Password wajib diisi';return;}\n  pw=v;\n  document.getElementById('L').style.display='none';\n  document.getElementById('D').style.display='block';\n  load();\n  setInterval(load,30000);\n}\nfunction fmt(iso){\n  if(!iso)return'-';\n  return new Date(iso).toLocaleString('id-ID',{timeZone:'Asia/Makassar',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})+' WITA';\n}\nfunction fmtT(iso){\n  if(!iso)return'-';\n  return new Date(iso).toLocaleString('id-ID',{timeZone:'Asia/Makassar',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});\n}\nfunction load(){\n  document.getElementById('LR').textContent='memuat...';\n  Promise.all([\n    fetch('/api/bblm').then(function(r){return r.json();}).catch(function(){return{};}),\n    fetch('/api/users?adminPassword='+encodeURIComponent(pw)).then(function(r){return r.json();}).catch(function(){return{};}),\n    fetch('/api/activity-log?adminPassword='+encodeURIComponent(pw)+'&limit=200').then(function(r){return r.json();}).catch(function(){return{};}),\n    fetch('/api/bblm-status').then(function(r){return r.json();}).catch(function(){return{};}),\n    fetch('/api/sync-prices').then(function(r){return r.json();}).catch(function(){return{};}),\n    fetch('/api/cron/status').then(function(r){return r.json();}).catch(function(){return{};})\n  ]).then(function(res){\n    var bblm=res[0],users=res[1],logs=res[2],bblmSt=res[3],sync=res[4],cron=res[5];\n    // Produk\n    var tp=bblm.totalProducts||0;\n    document.getElementById('vP').textContent=tp.toLocaleString('id-ID');\n    document.getElementById('vPS').textContent=bblm.updatedAt?('Update: '+fmt(bblm.updatedAt)):'Belum ada data';\n    // User\n    var tu=(users.users||[]).length;\n    var sus=(users.users||[]).filter(function(u){return u.suspended;}).length;\n    document.getElementById('vU').textContent=tu;\n    document.getElementById('vUS').textContent=sus>0?(sus+' ditangguhkan'):'Semua aktif';\n    // Aktivitas hari ini\n    var today=new Date().toISOString().slice(0,10);\n    var tl=(logs.logs||[]).filter(function(l){return l.createdAt&&l.createdAt.startsWith(today);});\n    var uu=[...new Set(tl.map(function(l){return l.username;}))];\n    document.getElementById('vA').textContent=tl.length;\n    document.getElementById('vAS').textContent=uu.length>0?(uu.length+' user aktif'):'Belum ada aktivitas';\n    // BBLM status\n    var isBusy=bblmSt.status==='updating';\n    document.getElementById('vB').innerHTML=isBusy\n      ?'<span class=\"dot dot-yellow\"></span><span style=\"color:#fb923c\">Masih Update</span>'\n      :'<span class=\"dot dot-green\"></span><span style=\"color:#4ade80\">Sudah Update</span>';\n    document.getElementById('vBS').textContent=bblmSt.updatedAt?fmt(bblmSt.updatedAt):'';\n    // Promo\n    var h=sync.highest||{};\n    var hasH=(h.count||0)>0;\n    var dc=sync.diffCount||0;\n    document.getElementById('vPR').innerHTML=hasH\n      ?('<span class=\"badge badge-green\">&#10003; PROMO AKTIF</span> <span style=\"font-size:13px;color:#94a3b8;margin-left:8px\">'+dc+' produk harga turun &middot; '+((h.count)||0).toLocaleString('id-ID')+' referensi</span>')\n      :'<span class=\"badge badge-red\">&#10007; TIDAK AKTIF</span> <span style=\"font-size:13px;color:#64748b;margin-left:8px\">Harga tertinggi belum dibangun</span>';\n    // Cron\n    var lr=cron.lastRun;\n    var nr=cron.nextRunWITA||'-';\n    document.getElementById('vC').innerHTML=lr\n      ?('<div style=\"margin-bottom:6px\"><span class=\"badge badge-green\">&#10003; Terakhir jalan</span> <span style=\"font-size:13px;color:#94a3b8;margin-left:8px\">'+fmt(lr.runAt)+'</span></div><div style=\"font-size:12px;color:#64748b\">Berikutnya: '+nr+'</div>')\n      :('<span class=\"badge badge-yellow\">&#9888; Belum pernah jalan</span> <span style=\"font-size:12px;color:#64748b;margin-left:8px\">Berikutnya: '+nr+'</span>');\n    // Logs\n    var rl=(logs.logs||[]).slice(0,10);\n    document.getElementById('vL').innerHTML=rl.length\n      ?rl.map(function(l){return '<div class=\"log-row\"><span class=\"log-time\">'+fmtT(l.createdAt)+'</span><span class=\"log-user\">'+(l.username||'-')+'</span><span>'+(l.action||'')+(l.detail?' &middot; '+l.detail:'')+'</span></div>';}).join('')\n      :'<div style=\"color:#475569;font-size:13px;padding:8px 0\">Belum ada aktivitas</div>';\n    document.getElementById('LR').textContent='Update: '+new Date().toLocaleTimeString('id-ID',{timeZone:'Asia/Makassar'})+' WITA';\n  }).catch(function(e){document.getElementById('LR').textContent='Gagal: '+e.message;});\n}\nfunction backup(){\n  fetch('/api/backup?adminPassword='+encodeURIComponent(pw)).then(function(r){return r.blob();}).then(function(b){\n    var a=document.createElement('a');\n    a.href=URL.createObjectURL(b);\n    a.download='backup-'+new Date().toISOString().slice(0,10)+'.json';\n    a.click();\n  });\n}\nfunction cronRun(){\n  fetch('/api/cron/daily-reset?secret='+encodeURIComponent(pw)).then(function(r){return r.json();}).then(function(j){\n    alert(j.success?'Cron berhasil dijalankan!':j.message||'Gagal');\n    if(j.success)load();\n  });\n}\n</script>\n</body>\n</html>";
      res.status(200).end(html);
      return;
    }

    // GET /cron/daily-reset?secret=ADMIN_PASSWORD
    // Dipanggil oleh cron-job.org setiap jam 04:00 WITA (UTC+8 = 20:00 UTC hari sebelumnya)
    if (path === "/cron/daily-reset" && method === "GET") {
      const { secret } = query;
      if (secret !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const now = new Date().toISOString();
      const actions = [
        "bblm -> cleared",
        "bblm-status -> updating",
        "price-snapshot-prev -> cleared",
        "price-snapshot-current -> cleared",
        "price-snapshot-highest -> cleared"
      ];
      await Promise.all([
        // 1. Hapus isi spreadsheet BBLM -> kosong, wajib upload ulang pagi ini
        setJson("bblm", { hasData: false, gradeNames: [], products: [], totalProducts: 0, updatedAt: null, updatedBy: "", sourceLabel: "" }),
        // 2. Set status BBLM -> masih update
        setJson("bblm-status", { status: "updating", updatedAt: now, resetBy: "cron-04:00" }),
        // 3. Hapus semua snapshot harga -> promo hilang, harga kembali normal
        setJson("price-snapshot-prev", { date: null, prices: {} }),
        setJson("price-snapshot-current", { date: null, prices: {} }),
        setJson("price-snapshot-highest", { prices: {}, updatedAt: null }),
      ]);
      // Simpan log eksekusi cron
      const cronLogs = await getJson("cron-logs", []);
      cronLogs.unshift({ runAt: now, success: true, actions });
      if (cronLogs.length > 30) cronLogs.length = 30;
      await setJson("cron-logs", cronLogs);
      return send({
        success: true,
        message: "Daily reset berhasil: data BBLM dihapus, status -> masih update, semua harga coret & promo direset",
        resetAt: now,
        actions
      });
    }


    // GET /cron/status — cek riwayat eksekusi cron (tanpa auth untuk kemudahan monitoring)
    if (path === "/cron/status" && method === "GET") {
      const logs = await getJson("cron-logs", []);
      const last = logs[0] ?? null;
      const now = new Date();
      // Hitung eksekusi berikutnya (jam 20:00 UTC = 04:00 WITA)
      const next = new Date(now);
      next.setUTCHours(20, 0, 0, 0);
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      return send({
        success: true,
        lastRun: last ? { runAt: last.runAt, success: last.success, actions: last.actions } : null,
        nextRun: next.toISOString(),
        nextRunWITA: next.toLocaleString("id-ID", { timeZone: "Asia/Makassar", dateStyle: "full", timeStyle: "short" }),
        totalLogs: logs.length,
        recentLogs: logs.slice(0, 7)
      });
    }


    // Haversine formula — hitung jarak (km) antara dua koordinat
    function haversine(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat/2)*Math.sin(dLat/2) +
                Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*
                Math.sin(dLon/2)*Math.sin(dLon/2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    // GET /company-location — ambil setting lokasi perusahaan
    if (path === "/company-location" && method === "GET") {
      const loc = await getJson("company-location", { lat: null, lng: null, radiusKm: 1, name: "Perusahaan" });
      res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
      return send({ success: true, ...loc });
    }

    // POST /company-location — set lokasi perusahaan (admin)
    if (path === "/company-location" && method === "POST") {
      const { adminPassword, lat, lng, radiusKm, name } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      if (lat === undefined || lng === undefined) return send({ success: false, message: "lat dan lng wajib diisi" }, 400);
      const data = {
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        radiusKm: parseFloat(radiusKm ?? 1),
        name: name ?? "Perusahaan",
        updatedAt: new Date().toISOString()
      };
      await setJson("company-location", data);
      return send({ success: true, ...data });
    }

    // POST /location-check — cek lokasi user, catat peringatan jika di luar radius
    if (path === "/location-check" && method === "POST") {
      const { username, lat, lng, accuracy } = body;
      if (!username) return send({ success: false, message: "username wajib diisi" }, 400);
      if (lat === undefined || lng === undefined) return send({ success: false, message: "lat dan lng wajib diisi" }, 400);

      const company = await getJson("company-location", { lat: null, lng: null, radiusKm: 1, name: "Perusahaan" });

      if (company.lat === null || company.lng === null) {
        return send({ success: true, status: "unconfigured", message: "Lokasi perusahaan belum diatur oleh admin" });
      }

      const distKm = haversine(parseFloat(lat), parseFloat(lng), company.lat, company.lng);
      const distM = Math.round(distKm * 1000);
      const isInRadius = distKm <= company.radiusKm;

      if (!isInRadius) {
        // Catat peringatan ke activity log
        const logs = await getJson("activity-logs", []);
        logs.unshift({
          username,
          action: "⚠️ LOKASI DI LUAR RADIUS",
          detail: distM + "m dari " + company.name + " (batas: " + (company.radiusKm * 1000) + "m)" + (accuracy ? " · akurasi GPS: " + Math.round(accuracy) + "m" : ""),
          createdAt: new Date().toISOString(),
          type: "location-warning"
        });
        if (logs.length > 1000) logs.length = 1000;
        await setJson("activity-logs", logs);
      }

      return send({
        success: true,
        isInRadius,
        distanceM: distM,
        radiusM: Math.round(company.radiusKm * 1000),
        companyName: company.name,
        status: isInRadius ? "dalam_radius" : "di_luar_radius"
      });
    }


    // GET /kelola-lokasi — halaman admin kelola lokasi perusahaan & radius
    if (path === "/kelola-lokasi" && method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const html = `<!DOCTYPE html>
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
  <h1>&#128205; Kelola Lokasi Perusahaan</h1>
  <div class="sub">PDA Mini Mataram &#8212; Atur koordinat &amp; radius lokasi perusahaan</div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('setting',this)">&#9881; Setting Lokasi</div>
    <div class="tab" onclick="switchTab('log',this)">&#9888; Log Peringatan</div>
  </div>

  <!-- TAB SETTING -->
  <div id="tab-setting" class="tab-content active">
    <div class="section-title">Status Saat Ini</div>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Status</span><span id="statusBadge" class="badge badge-off">Memuat...</span></div>
      <div class="info-row"><span class="info-label">Nama Perusahaan</span><span class="info-val" id="curName">&#8212;</span></div>
      <div class="info-row"><span class="info-label">Koordinat</span><span class="info-val" id="curCoord">&#8212;</span></div>
      <div class="info-row"><span class="info-label">Radius</span><span class="info-val" id="curRadius">&#8212;</span></div>
      <div class="info-row"><span class="info-label">Terakhir diubah</span><span class="info-val" id="curUpdated">&#8212;</span></div>
    </div>

    <div class="section-title">Peta &#8212; Klik untuk pilih lokasi perusahaan</div>
    <p class="pin-hint">&#128161; Klik titik di peta untuk menempatkan pin lokasi. Lingkaran ungu = area radius.</p>
    <div id="map"></div>

    <div class="row">
      <div>
        <label>Latitude</label>
        <input id="lat" type="text" placeholder="-8.5836" readonly/>
      </div>
      <div>
        <label>Longitude</label>
        <input id="lng" type="text" placeholder="116.1017" readonly/>
      </div>
    </div>

    <div class="mt-12">
      <label>Radius (meter)</label>
      <input id="radius" type="number" placeholder="500" value="500" min="50" max="50000" oninput="onRadiusChange()"/>
      <div class="radius-info" id="radiusInfo">Radius: <b>500 meter</b> dari titik perusahaan</div>
    </div>

    <div class="mt-12">
      <label>Nama Perusahaan</label>
      <input id="namaPerusahaan" type="text" placeholder="PDA Mini Mataram" value="PDA Mini Mataram"/>
    </div>

    <div class="mt-12">
      <label>Password Admin</label>
      <input id="adminPwd" type="password" placeholder="Masukkan password admin"/>
    </div>

    <div class="alert ok" id="alertOk">&#10003; Lokasi &amp; radius berhasil disimpan!</div>
    <div class="alert err" id="alertErr"></div>

    <button class="btn btn-save" id="btnSave" onclick="saveLocation()" style="margin-top:14px">&#128190; Simpan Lokasi &amp; Radius</button>
    <button class="btn-gps" onclick="useMyLocation()">&#128225; Gunakan Lokasi GPS Saya</button>
  </div>

  <!-- TAB LOG -->
  <div id="tab-log" class="tab-content">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span class="section-title" style="margin:0">Log Peringatan Lokasi</span>
      <button onclick="loadLogs()" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer">&#8635; Refresh</button>
    </div>
    <label>Password Admin</label>
    <input id="adminPwdLog" type="password" placeholder="Masukkan password admin" style="margin-bottom:8px"/>
    <button onclick="loadLogs()" style="background:#6366f1;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;width:100%">&#128269; Tampilkan Log Peringatan</button>
    <div id="logContainer" style="margin-top:14px"></div>
  </div>
</div>

<script>
var map = L.map('map').setView([-8.5836, 116.1017], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'&copy; OpenStreetMap',maxZoom:19}).addTo(map);

var marker = null, circle = null, currentLat = null, currentLng = null;

function updateCircle(lat, lng, r) {
  if (circle) map.removeLayer(circle);
  circle = L.circle([lat, lng], {color:'#6366f1',fillColor:'#6366f1',fillOpacity:0.12,weight:2,radius:r}).addTo(map);
}

function placeMarker(lat, lng) {
  if (marker) map.removeLayer(marker);
  marker = L.marker([lat, lng], {
    icon: L.divIcon({
      html: '<div style="background:#6366f1;width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.5)"></div>',
      iconSize:[16,16],iconAnchor:[8,8]
    })
  }).addTo(map);
  document.getElementById('lat').value = lat.toFixed(7);
  document.getElementById('lng').value = lng.toFixed(7);
  currentLat = lat; currentLng = lng;
  updateCircle(lat, lng, parseInt(document.getElementById('radius').value) || 500);
}

map.on('click', function(e) { placeMarker(e.latlng.lat, e.latlng.lng); });

function onRadiusChange() {
  var r = parseInt(document.getElementById('radius').value) || 500;
  document.getElementById('radiusInfo').innerHTML = 'Radius: <b>' + r.toLocaleString('id-ID') + ' meter</b> dari titik perusahaan';
  if (currentLat && currentLng) updateCircle(currentLat, currentLng, r);
}

async function loadCurrentSetting() {
  try {
    var res = await fetch('/api/company-location');
    var data = await res.json();
    if (data.lat !== null && data.lat !== undefined) {
      document.getElementById('statusBadge').className = 'badge badge-ok';
      document.getElementById('statusBadge').textContent = 'Aktif';
      document.getElementById('curName').textContent = data.name || 'Perusahaan';
      document.getElementById('curCoord').textContent = data.lat.toFixed(6) + ', ' + data.lng.toFixed(6);
      var rm = Math.round(data.radiusKm * 1000);
      document.getElementById('curRadius').textContent = rm + ' meter';
      document.getElementById('curUpdated').textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleString('id-ID') : 'Belum pernah';
      document.getElementById('namaPerusahaan').value = data.name || 'PDA Mini Mataram';
      document.getElementById('radius').value = rm;
      document.getElementById('radiusInfo').innerHTML = 'Radius: <b>' + rm.toLocaleString('id-ID') + ' meter</b> dari titik perusahaan';
      placeMarker(data.lat, data.lng);
      map.setView([data.lat, data.lng], 16);
    } else {
      document.getElementById('statusBadge').className = 'badge badge-off';
      document.getElementById('statusBadge').textContent = 'Belum dikonfigurasi';
      document.getElementById('curCoord').textContent = 'Klik peta untuk atur lokasi';
    }
  } catch(e) {}
}

async function saveLocation() {
  var lat = parseFloat(document.getElementById('lat').value);
  var lng = parseFloat(document.getElementById('lng').value);
  var radiusM = parseInt(document.getElementById('radius').value) || 500;
  var name = document.getElementById('namaPerusahaan').value.trim() || 'PDA Mini Mataram';
  var pwd = document.getElementById('adminPwd').value.trim();
  if (isNaN(lat) || isNaN(lng)) { showErr('Klik peta terlebih dahulu untuk memilih lokasi!'); return; }
  if (!pwd) { showErr('Password admin wajib diisi!'); return; }
  var btn = document.getElementById('btnSave');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    var res = await fetch('/api/company-location', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({adminPassword:pwd, lat:lat, lng:lng, radiusKm:radiusM/1000, name:name})
    });
    var data = await res.json();
    if (data.success) { showOk(); loadCurrentSetting(); }
    else showErr(data.message || 'Gagal menyimpan');
  } catch(e) { showErr('Error: ' + e.message); }
  btn.disabled = false; btn.textContent = 'Simpan Lokasi & Radius';
}

function useMyLocation() {
  if (!navigator.geolocation) { showErr('GPS tidak tersedia di browser ini'); return; }
  navigator.geolocation.getCurrentPosition(
    function(pos) { placeMarker(pos.coords.latitude, pos.coords.longitude); map.setView([pos.coords.latitude, pos.coords.longitude], 17); },
    function(err) { showErr('Gagal ambil GPS: ' + err.message); },
    {enableHighAccuracy:true}
  );
}

async function loadLogs() {
  var pwd = document.getElementById('adminPwdLog').value.trim();
  if (!pwd) { document.getElementById('logContainer').innerHTML = '<div style="color:#f87171;font-size:13px;padding:10px 0">Masukkan password admin untuk melihat log</div>'; return; }
  document.getElementById('logContainer').innerHTML = '<div style="color:#94a3b8;font-size:13px;padding:10px 0">Memuat log...</div>';
  try {
    var res = await fetch('/api/activity-log?adminPassword=' + encodeURIComponent(pwd) + '&limit=200');
    var data = await res.json();
    if (!data.success) { document.getElementById('logContainer').innerHTML = '<div style="color:#f87171;font-size:13px">' + (data.message || 'Unauthorized') + '</div>'; return; }
    var warns = (data.logs || []).filter(function(l){ return l.type === 'location-warning' || (l.action && l.action.includes('LOKASI')); });
    if (warns.length === 0) {
      document.getElementById('logContainer').innerHTML = '<div style="color:#4ade80;font-size:13px;padding:20px;text-align:center;background:#052e16;border-radius:8px">Tidak ada peringatan lokasi tercatat</div>';
      return;
    }
    document.getElementById('logContainer').innerHTML = warns.map(function(l){
      return '<div class="log-item">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span class="log-user">&#128100; ' + l.username + '</span>' +
        '<span class="log-action">' + l.action + '</span></div>' +
        '<div class="log-detail">&#128205; ' + l.detail + '</div>' +
        '<div class="log-time">' + new Date(l.createdAt).toLocaleString('id-ID') + '</div></div>';
    }).join('');
  } catch(e) { document.getElementById('logContainer').innerHTML = '<div style="color:#f87171;font-size:13px">Error: ' + e.message + '</div>'; }
}

function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

function showOk() {
  var a = document.getElementById('alertOk'); a.style.display = 'block';
  document.getElementById('alertErr').style.display = 'none';
  setTimeout(function(){ a.style.display = 'none'; }, 4000);
}
function showErr(msg) {
  var a = document.getElementById('alertErr'); a.textContent = msg; a.style.display = 'block';
  document.getElementById('alertOk').style.display = 'none';
}

loadCurrentSetting();
<\/script>
</body>
</html>`;
      res.status(200).end(html);
      return;
    }


    // DELETE /location-warnings — hapus semua log peringatan lokasi (bukan semua log)
    if (path === "/location-warnings" && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      const logs = await getJson("activity-logs", []);
      const filtered = logs.filter(l => l.type !== "location-warning" && !(l.action && l.action.includes("LOKASI DI LUAR")));
      const removed = logs.length - filtered.length;
      await setJson("activity-logs", filtered);
      return send({ success: true, message: removed + " log peringatan lokasi berhasil dihapus", removed });
    }


    // POST /price-snapshot/refresh — admin clear cache agar semua user dapat harga terbaru
    if (path === "/price-snapshot/refresh" && method === "POST") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      ["price-snapshot-current","price-snapshot-prev","price-snapshot-highest","sync-meta","__promo_etag"].forEach(k => _memCache.delete(k));
      await setJson("price-refresh-ts", { ts: Date.now() });
      return send({ success: true, message: "Cache harga diperbarui. Semua user akan mendapat data terbaru." });
    }

    // GET /price-refresh-ts — sinyal kapan admin terakhir refresh cache (untuk auto-reload user)
    if (path === "/price-refresh-ts" && method === "GET") {
      const sig = await getJson("price-refresh-ts", { ts: 0 });
      res.setHeader("Cache-Control", "no-store");
      return send({ ts: sig.ts || 0 });
    }

    return send({ error: "Not found" }, 404);
  } catch (err) {
    return send({ error: "Internal server error", detail: String(err) }, 500);
  }
}
