import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

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
  try {
    await initDb();
    const rows = await sql`SELECT value FROM kv_store WHERE key = ${key}`;
    if (!rows.length || rows[0].value === null) return defaultValue;
    return rows[0].value;
  } catch {
    return defaultValue;
  }
}

async function setJson(key, data) {
  await initDb();
  await sql`INSERT INTO kv_store (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(data)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(data)}, updated_at = NOW()`;
}

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
      return send(await getJson("bblm", { hasData: false, gradeNames: [], products: [], totalProducts: 0, updatedAt: null, updatedBy: "", sourceLabel: "" }));
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

    if (path === "/maintenance" && method === "GET") return send(await getJson("maintenance", { active: false, message: "", updatedAt: null }));

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
      const [individual, prev, current] = await Promise.all([
        getJson(`price-history:${barcode}`, null),
        getJson("price-snapshot-prev", { date: null, prices: {} }),
        getJson("price-snapshot-current", { date: null, prices: {} })
      ]);
      const prevPrice = prev?.prices?.[barcode];
      const currentSnapshotPrice = current?.prices?.[barcode];
      // Server-side comparison: bandingkan snapshot acuan vs snapshot terbaru
      let promo = null;
      if (prevPrice != null && currentSnapshotPrice != null && prevPrice > currentSnapshotPrice) {
        promo = { prevPrice, currentPrice: currentSnapshotPrice };
      }
      const data = prevPrice != null ? { price: prevPrice, date: prev.date } : individual;
      return send({ success: true, data, promo });
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
      const count = Object.keys(current.prices).length;
      return send({ success: true, saved: count, message: count.toLocaleString("id-ID") + " harga berhasil disimpan sebagai acuan. Sekarang update spreadsheet — harga coret akan tampil otomatis." });
    }

    if (path === "/sync-prices" && method === "GET") {
      const [current, prev] = await Promise.all([
        getJson("price-snapshot-current", { date: null, prices: {} }),
        getJson("price-snapshot-prev", { date: null, prices: {} })
      ]);
      const cPrices = current.prices || {};
      const pPrices = prev.prices || {};
      const diffCount = Object.keys(pPrices).filter(bc => {
        const pp = pPrices[bc];
        const cp = cPrices[bc];
        return pp != null && cp != null && pp > cp;
      }).length;
      return send({ success: true,
        current: { date: current.date, count: Object.keys(cPrices).length },
        prev: { date: prev.date, count: Object.keys(pPrices).length },
        diffCount
      });
    }

    // POST /sync-prices — dipanggil otomatis oleh app saat load, simpan harga terbaru dari spreadsheet
    if (path === "/sync-prices" && method === "POST") {
      const { items } = body;
      if (!Array.isArray(items) || !items.length) return send({ success: false, message: "items harus array" }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const prices = {};
      items.forEach(({ barcode, price }) => { if (barcode) prices[barcode] = Number(price) || 0; });
      await setJson("price-snapshot-current", { date: today, prices });
      return send({ success: true, saved: Object.keys(prices).length });
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

    return send({ error: "Not found" }, 404);
  } catch (err) {
    return send({ error: "Internal server error", detail: String(err) }, 500);
  }
}
