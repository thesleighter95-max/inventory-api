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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "00000";

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
      const [individual, prev] = await Promise.all([
        getJson(`price-history:${barcode}`, null),
        getJson("price-snapshot-prev", { date: null, prices: {} })
      ]);
      const prevPrice = prev?.prices?.[barcode];
      return send({ success: true, data: prevPrice != null ? { price: prevPrice, date: prev.date } : individual });
    }

    if (path === "/price-history" && method === "POST") {
      const { barcode, price } = body;
      if (!barcode || price === undefined) return send({ success: false, message: "barcode dan price wajib diisi" }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const existing = await getJson(`price-history:${barcode}`, null);
      if (!existing || existing.date !== today) await setJson(`price-history:${barcode}`, { price: Number(price), date: today });
      return send({ success: true });
    }


    // GET /upload-harga — halaman upload Excel/CSV untuk harga lama & baru
    if (path === "/upload-harga" && method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).end(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload Harga - PDA Mini Mataram</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f0f4f8;min-height:100vh;padding:16px}
.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.1)}
h1{font-size:20px;color:#1a202c;margin-bottom:4px}
.sub{color:#718096;font-size:13px;margin-bottom:16px}
label{display:block;font-size:13px;font-weight:600;color:#4a5568;margin-bottom:6px;margin-top:12px}
input[type=password],input[type=file],select{width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none}
input:focus,select:focus{border-color:#3182ce}
.tabs{display:flex;gap:8px;margin:16px 0}
.tab{flex:1;padding:10px;border:2px solid #e2e8f0;border-radius:8px;background:#fff;font-size:13px;font-weight:600;cursor:pointer;text-align:center;color:#718096}
.tab.active{border-color:#3182ce;color:#3182ce;background:#ebf8ff}
.btn{display:block;width:100%;padding:13px;background:#3182ce;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;margin-top:16px}
.btn:disabled{background:#a0aec0;cursor:not-allowed}
.hint{font-size:11px;color:#a0aec0;margin-top:4px}
.desc{font-size:12px;color:#718096;padding:10px;background:#f7fafc;border-radius:8px;margin-bottom:12px}
.col-row{display:flex;gap:10px;margin-top:4px}
.col-row>div{flex:1}
.preview{margin-top:14px;overflow:auto;border:1px solid #e2e8f0;border-radius:8px;font-size:12px}
.preview table{width:100%;border-collapse:collapse}
.preview th{background:#f7fafc;padding:7px 10px;text-align:left;border-bottom:1px solid #e2e8f0;color:#718096;font-size:11px}
.preview td{padding:7px 10px;border-bottom:1px solid #f0f4f8}
.count{font-size:12px;color:#718096;margin-top:6px;text-align:right}
.alert{padding:12px 14px;border-radius:8px;font-size:13px;margin-top:12px;display:none}
.ok{background:#f0fff4;color:#276749;border:1px solid #9ae6b4}
.err{background:#fff5f5;color:#c53030;border:1px solid #fed7d7}
</style>
</head>
<body>
<div class="card">
  <h1>Upload Harga</h1>
  <div class="sub">PDA Mini Mataram — Import harga dari file Excel atau CSV</div>

  <label>Password Admin</label>
  <input type="password" id="pwd" placeholder="Password admin">

  <div class="tabs">
    <div class="tab active" onclick="setMode(0)" id="t0">📸 Harga Lama</div>
    <div class="tab" onclick="setMode(1)" id="t1">🆕 Harga Baru</div>
  </div>

  <div class="desc" id="desc">
    <b>Harga Lama (Prev):</b> Dipakai sebagai acuan harga coret. Kalau harga sekarang lebih murah, harga ini akan tampil dicoret di aplikasi.
  </div>

  <label>Pilih File Excel / CSV</label>
  <input type="file" id="file" accept=".xlsx,.xls,.csv" onchange="readFile(this)">
  <div class="hint">Format yang didukung: .xlsx · .xls · .csv</div>

  <div id="mapArea" style="display:none">
    <div class="col-row">
      <div><label>Kolom Barcode</label><select id="cBarcode" onchange="renderPreview()"></select></div>
      <div><label>Kolom Harga</label><select id="cHarga" onchange="renderPreview()"></select></div>
    </div>
    <div class="preview" id="previewBox"></div>
    <div class="count" id="countInfo"></div>
  </div>

  <button class="btn" id="btnUp" onclick="doUpload()" disabled>⬆️ Upload Harga</button>
  <div class="alert ok" id="aOk"></div>
  <div class="alert err" id="aErr"></div>
</div>

<script>
let mode=0, rows=[], headers=[];
function setMode(m){
  mode=m;
  document.getElementById("t0").className="tab"+(m===0?" active":"");
  document.getElementById("t1").className="tab"+(m===1?" active":"");
  document.getElementById("desc").innerHTML=m===0
    ?"<b>Harga Lama (Prev):</b> Dipakai sebagai acuan harga coret. Kalau harga sekarang lebih murah, harga ini akan tampil dicoret di aplikasi."
    :"<b>Harga Baru (Sync):</b> Update harga terbaru ke sistem. Otomatis geser snapshot hari ini ke prev jika sudah ada.";
}
function readFile(inp){
  const file=inp.files[0]; if(!file) return;
  const r=new FileReader();
  r.onload=e=>{
    try{
      const wb=XLSX.read(new Uint8Array(e.target.result),{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      rows=XLSX.utils.sheet_to_json(ws,{defval:""});
      if(!rows.length){showErr("File kosong");return;}
      headers=Object.keys(rows[0]);
      const cb=document.getElementById("cBarcode"), ch=document.getElementById("cHarga");
      cb.innerHTML=headers.map(h=>"<option>"+h+"</option>").join("");
      ch.innerHTML=headers.map(h=>"<option>"+h+"</option>").join("");
      cb.value=headers.find(h=>/barcode|kode|sku|id/i.test(h))||headers[0];
      ch.value=headers.find(h=>/harga|price|nilai|rp|cost/i.test(h))||headers[1]||headers[0];
      document.getElementById("mapArea").style.display="block";
      document.getElementById("btnUp").disabled=false;
      renderPreview();
    }catch(e){showErr("Gagal baca: "+e.message);}
  };
  r.readAsArrayBuffer(file);
}
function getItems(){
  const bc=document.getElementById("cBarcode").value, hg=document.getElementById("cHarga").value;
  return rows.map(r=>({barcode:String(r[bc]||"").trim(),price:parseFloat(String(r[hg]||"0").replace(/[^0-9.]/g,""))||0})).filter(r=>r.barcode&&r.barcode!=="0");
}
function renderPreview(){
  const items=getItems(), show=items.slice(0,5);
  document.getElementById("countInfo").textContent=items.length+" baris terdeteksi";
  document.getElementById("previewBox").innerHTML="<table><tr><th>#</th><th>Barcode</th><th>Harga</th></tr>"+
    show.map((r,i)=>"<tr><td>"+(i+1)+"</td><td>"+r.barcode+"</td><td>Rp "+r.price.toLocaleString("id-ID")+"</td></tr>").join("")+
    (items.length>5?"<tr><td colspan=3 style='color:#a0aec0;text-align:center'>... dan "+(items.length-5)+" baris lainnya</td></tr>":"")+
    "</table>";
}
async function doUpload(){
  const pwd=document.getElementById("pwd").value.trim();
  if(!pwd){showErr("Password admin wajib diisi");return;}
  const items=getItems();
  if(!items.length){showErr("Tidak ada data valid");return;}
  document.getElementById("btnUp").disabled=true;
  document.getElementById("btnUp").textContent="⏳ Mengupload...";
  hideAlert();
  try{
    const ep=mode===0?"/api/snap-prices":"/api/sync-prices";
    const res=await fetch(ep,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({adminPassword:pwd,items:items.map(i=>({barcode:i.barcode,price:i.price}))})});
    const j=await res.json();
    if(j.success) showOk((mode===0?"✅ Harga Lama disimpan":"✅ Harga Baru disync")+" — "+(j.saved??items.length)+" produk");
    else showErr(j.message||"Gagal upload");
  }catch(e){showErr("Error: "+e.message);}
  document.getElementById("btnUp").disabled=false;
  document.getElementById("btnUp").textContent="⬆️ Upload Harga";
}
function showOk(m){const e=document.getElementById("aOk");e.textContent=m;e.style.display="block";}
function showErr(m){const e=document.getElementById("aErr");e.textContent=m;e.style.display="block";}
function hideAlert(){document.getElementById("aOk").style.display="none";document.getElementById("aErr").style.display="none";}
<\/script>
</body>
</html>`);
      return;
    }

    // POST /snap-prices — simpan harga sekarang sebagai acuan (prev), lalu set current baru
    if (path === "/snap-prices" && method === "POST") {
      const { adminPassword, items } = body;
      if (adminPassword !== ADMIN_PASSWORD) return send({ success: false, message: "Unauthorized" }, 403);
      if (!Array.isArray(items) || !items.length) return send({ success: false, message: "items harus array" }, 400);
      const today = new Date().toISOString().slice(0, 10);
      // Simpan items sebagai price-snapshot-prev (harga acuan / harga lama)
      const prices = {};
      items.forEach(({ barcode, price }) => { if (barcode) prices[barcode] = Number(price) || 0; });
      await setJson("price-snapshot-prev", { date: today, prices });
      return send({ success: true, saved: Object.keys(prices).length, message: "Harga berhasil di-snap sebagai acuan" });
    }

    if (path === "/sync-prices" && method === "GET") {
      const [current, prev] = await Promise.all([
        getJson("price-snapshot-current", { date: null, prices: {} }),
        getJson("price-snapshot-prev", { date: null, prices: {} })
      ]);
      return send({ success: true, current: { date: current.date, count: Object.keys(current.prices || {}).length }, prev: { date: prev.date, count: Object.keys(prev.prices || {}).length, prices: prev.prices || {} } });
    }

    if (path === "/sync-prices" && method === "POST") {
      const { items, forceOverwrite } = body;
      if (!Array.isArray(items) || !items.length) return send({ success: false, message: "items harus array" }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const current = await getJson("price-snapshot-current", { date: null, prices: {} });
      if (current.date === today && !forceOverwrite) return send({ success: true, saved: 0, message: "sudah tersimpan hari ini" });
      if (current.date && current.date !== today) await setJson("price-snapshot-prev", current);
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
