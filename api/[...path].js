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

async function deleteKey(key) {
  await initDb();
  await sql`DELETE FROM kv_store WHERE key = ${key}`;
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

    if (path === "/sync-prices" && method === "GET") {
      const [current, prev, highest] = await Promise.all([
        getJson("price-snapshot-current", { date: null, prices: {} }),
        getJson("price-snapshot-prev", { date: null, prices: {} }),
        getJson("price-snapshot-highest", { prices: {}, updatedAt: null })
      ]);
      const cPrices = current.prices || {};
      const pPrices = prev.prices || {};
      const hPrices = highest.prices || {};
      // diffCount: produk yang harga tertingginya > harga terbaru (akan tampil harga coret)
      const diffCount = Object.keys(hPrices).filter(bc => {
        const hp = hPrices[bc];
        const cp = cPrices[bc];
        return hp != null && cp != null && hp > cp;
      }).length;
      // diffCountManual: dari acuan manual saja
      const diffCountManual = Object.keys(pPrices).filter(bc => {
        const pp = pPrices[bc];
        const cp = cPrices[bc];
        return pp != null && cp != null && pp > cp;
      }).length;
      return send({ success: true,
        current: { date: current.date, count: Object.keys(cPrices).length },
        prev: { date: prev.date, count: Object.keys(pPrices).length, diffCount: diffCountManual },
        highest: { count: Object.keys(hPrices).length, updatedAt: highest.updatedAt, diffCount },
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
      // Selalu update highest agar harga naik langsung tercermin (tidak tunggu hari berganti)
      await updateHighestSnapshot(prices);
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



    // GET /dashboard — halaman dashboard admin
    if (path === "/dashboard" && method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const html = "<!DOCTYPE html>\n<html lang=\"id\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Dashboard Admin - PDA Mini Mataram</title>\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\nbody{font-family:system-ui,sans-serif;background:#0f172a;min-height:100vh;padding:16px;color:#e2e8f0}\nh1{font-size:18px;font-weight:700;color:#fff}\n.sub{color:#64748b;font-size:12px;margin-bottom:20px;margin-top:2px}\n.login-card{background:#1e293b;border-radius:14px;padding:28px 24px;max-width:360px;margin:60px auto}\n.login-card h1{text-align:center;margin-bottom:4px}\n.login-card .sub{text-align:center;margin-bottom:20px}\nlabel{display:block;font-size:12px;font-weight:600;color:#94a3b8;margin-bottom:6px}\ninput[type=password]{width:100%;padding:11px 14px;background:#0f172a;border:1.5px solid #334155;border-radius:8px;font-size:14px;color:#e2e8f0;outline:none}\ninput:focus{border-color:#3b82f6}\n.btn{display:block;width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;margin-top:14px}\n.btn-sm{display:inline-block;padding:7px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:none;margin-right:6px;margin-top:6px}\n.btn-blue{background:#1d4ed8;color:#fff}\n.btn-red{background:#dc2626;color:#fff}\n.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}\n.card{background:#1e293b;border-radius:12px;padding:16px}\n.card.full{grid-column:1/-1}\n.card-label{font-size:11px;color:#64748b;font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}\n.card-val{font-size:28px;font-weight:800;color:#fff;line-height:1}\n.card-sub{font-size:11px;color:#64748b;margin-top:4px}\n.badge{display:inline-block;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700}\n.badge-green{background:#14532d;color:#4ade80}\n.badge-red{background:#450a0a;color:#f87171}\n.badge-yellow{background:#422006;color:#fb923c}\n.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}\n.dot-green{background:#4ade80}\n.dot-yellow{background:#fb923c}\n.log-row{padding:8px 0;border-bottom:1px solid #334155;font-size:12px;display:flex;gap:8px}\n.log-row:last-child{border:none}\n.log-time{color:#64748b;min-width:90px}\n.log-user{color:#60a5fa;font-weight:600;min-width:70px}\n.section-title{font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}\n.action-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}\n.err{color:#f87171;font-size:13px;text-align:center;margin-top:12px}\n</style>\n</head>\n<body>\n<div id=\"L\">\n  <div class=\"login-card\">\n    <h1>&#128737;&#65039; Dashboard Admin</h1>\n    <div class=\"sub\">PDA Mini Mataram</div>\n    <label>Password Admin</label>\n    <input type=\"password\" id=\"P\" placeholder=\"Masukkan password admin\" onkeydown=\"if(event.key==='Enter')login()\">\n    <button class=\"btn\" onclick=\"login()\">Masuk</button>\n    <div class=\"err\" id=\"LE\"></div>\n  </div>\n</div>\n<div id=\"D\" style=\"display:none\">\n  <div style=\"display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px\">\n    <div><h1>&#128737;&#65039; Dashboard Admin</h1><div class=\"sub\">PDA Mini Mataram &middot; <span id=\"LR\">memuat...</span></div></div>\n    <button class=\"btn-sm btn-blue\" onclick=\"load()\" style=\"margin-top:4px\">&#8635; Refresh</button>\n  </div>\n  <div class=\"grid\">\n    <div class=\"card\"><div class=\"card-label\">&#128230; Total Produk</div><div class=\"card-val\" id=\"vP\">-</div><div class=\"card-sub\" id=\"vPS\"></div></div>\n    <div class=\"card\"><div class=\"card-label\">&#128101; Total User</div><div class=\"card-val\" id=\"vU\">-</div><div class=\"card-sub\" id=\"vUS\"></div></div>\n    <div class=\"card\"><div class=\"card-label\">&#128202; Aktivitas Hari Ini</div><div class=\"card-val\" id=\"vA\">-</div><div class=\"card-sub\" id=\"vAS\"></div></div>\n    <div class=\"card\"><div class=\"card-label\">&#128203; Status BBLM</div><div style=\"font-size:16px;margin-top:4px\" id=\"vB\">-</div><div class=\"card-sub\" id=\"vBS\"></div></div>\n    <div class=\"card full\"><div class=\"card-label\">&#127991;&#65039; Status Promo</div><div id=\"vPR\">-</div></div>\n    <div class=\"card full\"><div class=\"card-label\">&#129302; Cron Reset Otomatis</div><div id=\"vC\">-</div></div>\n  </div>\n  <div class=\"card\" style=\"margin-bottom:12px\">\n    <div class=\"section-title\">&#9889; Aksi Cepat</div>\n    <div class=\"action-row\">\n      <button class=\"btn-sm btn-blue\" onclick=\"window.open('/api/upload-harga','_blank')\">&#128228; Upload Harga</button>\n      <button class=\"btn-sm btn-blue\" onclick=\"backup()\">&#128190; Download Backup</button>\n      <button class=\"btn-sm btn-red\" onclick=\"if(confirm('Jalankan reset cron sekarang?'))cronRun()\">&#128260; Jalankan Cron</button>\n    </div>\n  </div>\n  <div class=\"card\">\n    <div class=\"section-title\">&#128221; Aktivitas Terbaru</div>\n    <div id=\"vL\"><div style=\"color:#475569;font-size:13px\">Memuat...</div></div>\n  </div>\n</div>\n<script>\nvar pw='';\nfunction login(){\n  var v=document.getElementById('P').value.trim();\n  if(!v){document.getElementById('LE').textContent='Password wajib diisi';return;}\n  pw=v;\n  document.getElementById('L').style.display='none';\n  document.getElementById('D').style.display='block';\n  load();\n  setInterval(load,30000);\n}\nfunction fmt(iso){\n  if(!iso)return'-';\n  return new Date(iso).toLocaleString('id-ID',{timeZone:'Asia/Makassar',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})+' WITA';\n}\nfunction fmtT(iso){\n  if(!iso)return'-';\n  return new Date(iso).toLocaleString('id-ID',{timeZone:'Asia/Makassar',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});\n}\nfunction load(){\n  document.getElementById('LR').textContent='memuat...';\n  Promise.all([\n    fetch('/api/bblm').then(function(r){return r.json();}).catch(function(){return{};}),\n    fetch('/api/users?adminPassword='+encodeURIComponent(pw)).then(function(r){return r.json();}).catch(function(){return{};}),\n    fetch('/api/activity-log?adminPassword='+encodeURIComponent(pw)+'&limit=200').then(function(r){return r.json();}).catch(function(){return{};}),\n    fetch('/api/bblm-status').then(function(r){return r.json();}).catch(function(){return{};}),\n    fetch('/api/sync-prices').then(function(r){return r.json();}).catch(function(){return{};}),\n    fetch('/api/cron/status').then(function(r){return r.json();}).catch(function(){return{};})\n  ]).then(function(res){\n    var bblm=res[0],users=res[1],logs=res[2],bblmSt=res[3],sync=res[4],cron=res[5];\n    // Produk\n    var tp=bblm.totalProducts||0;\n    document.getElementById('vP').textContent=tp.toLocaleString('id-ID');\n    document.getElementById('vPS').textContent=bblm.updatedAt?('Update: '+fmt(bblm.updatedAt)):'Belum ada data';\n    // User\n    var tu=(users.users||[]).length;\n    var sus=(users.users||[]).filter(function(u){return u.suspended;}).length;\n    document.getElementById('vU').textContent=tu;\n    document.getElementById('vUS').textContent=sus>0?(sus+' ditangguhkan'):'Semua aktif';\n    // Aktivitas hari ini\n    var today=new Date().toISOString().slice(0,10);\n    var tl=(logs.logs||[]).filter(function(l){return l.createdAt&&l.createdAt.startsWith(today);});\n    var uu=[...new Set(tl.map(function(l){return l.username;}))];\n    document.getElementById('vA').textContent=tl.length;\n    document.getElementById('vAS').textContent=uu.length>0?(uu.length+' user aktif'):'Belum ada aktivitas';\n    // BBLM status\n    var isBusy=bblmSt.status==='updating';\n    document.getElementById('vB').innerHTML=isBusy\n      ?'<span class=\"dot dot-yellow\"></span><span style=\"color:#fb923c\">Masih Update</span>'\n      :'<span class=\"dot dot-green\"></span><span style=\"color:#4ade80\">Sudah Update</span>';\n    document.getElementById('vBS').textContent=bblmSt.updatedAt?fmt(bblmSt.updatedAt):'';\n    // Promo\n    var h=sync.highest||{};\n    var hasH=(h.count||0)>0;\n    var dc=sync.diffCount||0;\n    document.getElementById('vPR').innerHTML=hasH\n      ?('<span class=\"badge badge-green\">&#10003; PROMO AKTIF</span> <span style=\"font-size:13px;color:#94a3b8;margin-left:8px\">'+dc+' produk harga turun &middot; '+((h.count)||0).toLocaleString('id-ID')+' referensi</span>')\n      :'<span class=\"badge badge-red\">&#10007; TIDAK AKTIF</span> <span style=\"font-size:13px;color:#64748b;margin-left:8px\">Harga tertinggi belum dibangun</span>';\n    // Cron\n    var lr=cron.lastRun;\n    var nr=cron.nextRunWITA||'-';\n    document.getElementById('vC').innerHTML=lr\n      ?('<div style=\"margin-bottom:6px\"><span class=\"badge badge-green\">&#10003; Terakhir jalan</span> <span style=\"font-size:13px;color:#94a3b8;margin-left:8px\">'+fmt(lr.runAt)+'</span></div><div style=\"font-size:12px;color:#64748b\">Berikutnya: '+nr+'</div>')\n      :('<span class=\"badge badge-yellow\">&#9888; Belum pernah jalan</span> <span style=\"font-size:12px;color:#64748b;margin-left:8px\">Berikutnya: '+nr+'</span>');\n    // Logs\n    var rl=(logs.logs||[]).slice(0,10);\n    document.getElementById('vL').innerHTML=rl.length\n      ?rl.map(function(l){return '<div class=\"log-row\"><span class=\"log-time\">'+fmtT(l.createdAt)+'</span><span class=\"log-user\">'+(l.username||'-')+'</span><span>'+(l.action||'')+(l.detail?' &middot; '+l.detail:'')+'</span></div>';}).join('')\n      :'<div style=\"color:#475569;font-size:13px;padding:8px 0\">Belum ada aktivitas</div>';\n    document.getElementById('LR').textContent='Update: '+new Date().toLocaleTimeString('id-ID',{timeZone:'Asia/Makassar'})+' WITA';\n  }).catch(function(e){document.getElementById('LR').textContent='Gagal: '+e.message;});\n}\nfunction backup(){\n  fetch('/api/backup?adminPassword='+encodeURIComponent(pw)).then(function(r){return r.blob();}).then(function(b){\n    var a=document.createElement('a');\n    a.href=URL.createObjectURL(b);\n    a.download='backup-'+new Date().toISOString().slice(0,10)+'.json';\n    a.click();\n  });\n}\nfunction cronRun(){\n  fetch('/api/cron/daily-reset?secret='+encodeURIComponent(pw)).then(function(r){return r.json();}).then(function(j){\n    alert(j.success?'Cron berhasil dijalankan!':j.message||'Gagal');\n    if(j.success)load();\n  });\n}\n</script>\n</body>\n</html>";
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
        "bblm-status -> updating",
        "price-snapshot-prev -> cleared",
        "price-snapshot-current -> cleared",
        "price-snapshot-highest -> cleared"
      ];
      await Promise.all([
        // 1. Set status BBLM -> masih update
        setJson("bblm-status", { status: "updating", updatedAt: now, resetBy: "cron-04:00" }),
        // 2. Hapus semua snapshot harga -> promo hilang, harga kembali normal
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
        message: "Daily reset berhasil: status BBLM -> masih update, semua harga coret & promo direset",
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

    return send({ error: "Not found" }, 404);
  } catch (err) {
    return send({ error: "Internal server error", detail: String(err) }, 500);
  }
}
