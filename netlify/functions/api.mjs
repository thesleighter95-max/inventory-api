import { getStore } from "@netlify/blobs";
import { randomUUID } from "crypto";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "00000";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

async function getJson(store, key, defaultValue) {
  try {
    const raw = await store.get(key);
    if (!raw) return defaultValue;
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

async function setJson(store, key, data) {
  await store.set(key, JSON.stringify(data));
}

export default async function handler(req) {
  const url = new URL(req.url);
  const method = req.method;

  if (method === "OPTIONS") {
    return new Response("", { status: 200, headers: CORS_HEADERS });
  }

  // Extract path: strip /api prefix
  const path = url.pathname.replace(/^\/?api/, "") || "/";

  let body = {};
  if (method !== "GET" && method !== "HEAD") {
    try { body = await req.json(); } catch { /* ignore */ }
  }

  const query = Object.fromEntries(url.searchParams.entries());
  const store = getStore("inventory");

  try {
    // GET /healthz
    if (path === "/healthz" && method === "GET") {
      return json({ status: "ok" });
    }

    // GET /bblm
    if (path === "/bblm" && method === "GET") {
      const data = await getJson(store, "bblm", {
        hasData: false, gradeNames: [], products: [],
        totalProducts: 0, updatedAt: null, updatedBy: "", sourceLabel: "",
      });
      return json(data);
    }

    // POST /bblm
    if (path === "/bblm" && method === "POST") {
      const { gradeNames, products, sourceLabel, updatedBy } = body;
      if (!Array.isArray(products)) {
        return json({ success: false, message: "products must be an array" }, 400);
      }
      const data = {
        hasData: true,
        gradeNames: Array.isArray(gradeNames) ? gradeNames : [],
        products,
        totalProducts: products.length,
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy ?? "unknown",
        sourceLabel: sourceLabel ?? "unknown",
      };
      await setJson(store, "bblm", data);
      return json({ success: true, totalProducts: products.length });
    }

    // GET /bblm-status
    if (path === "/bblm-status" && method === "GET") {
      const data = await getJson(store, "bblm-status", { status: "updating", updatedAt: null });
      return json(data);
    }

    // POST /bblm-status
    if (path === "/bblm-status" && method === "POST") {
      const { status, adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      if (status !== "updated" && status !== "updating") {
        return json({ success: false, message: "status must be 'updated' or 'updating'" }, 400);
      }
      const updatedAt = new Date().toISOString();
      await setJson(store, "bblm-status", { status, updatedAt });
      return json({
        success: true, status, updatedAt,
        message: status === "updated" ? "BBLM sudah di update" : "BBLM masih proses update",
      });
    }

    // GET /pwd-status
    if (path === "/pwd-status" && method === "GET") {
      const data = await getJson(store, "pwd-status", {});
      return json(data);
    }

    // POST /pwd-status
    if (path === "/pwd-status" && method === "POST") {
      const { username, changedAt } = body;
      if (!username) {
        return json({ success: false, message: "username is required" }, 400);
      }
      const current = await getJson(store, "pwd-status", {});
      current[username] = changedAt ?? new Date().toISOString();
      await setJson(store, "pwd-status", current);
      return json({ success: true });
    }

    // GET /activity-log
    if (path === "/activity-log" && method === "GET") {
      const { adminPassword, limit, username } = query;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      let logs = await getJson(store, "activity-logs", []);
      if (username) logs = logs.filter(l => l.username === username);
      const maxLimit = Math.min(parseInt(limit ?? "100", 10) || 100, 1000);
      logs = logs.slice(0, maxLimit);
      return json({ success: true, logs });
    }

    // DELETE /activity-log
    if (path === "/activity-log" && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      await setJson(store, "activity-logs", []);
      return json({ success: true, message: "Semua log berhasil dihapus" });
    }

    // POST /activity-log
    if (path === "/activity-log" && method === "POST") {
      const { username, action, detail } = body;
      if (!username || !action) {
        return json({ success: false, message: "username and action are required" }, 400);
      }
      const logs = await getJson(store, "activity-logs", []);
      logs.unshift({ username, action, detail: detail ?? "", createdAt: new Date().toISOString() });
      if (logs.length > 1000) logs.length = 1000;
      await setJson(store, "activity-logs", logs);
      return json({ success: true });
    }

    // POST /login  — cek user di Netlify Blobs
    if (path === "/login" && method === "POST") {
      const { username, password } = body;
      if (!username || !password) {
        return json({ success: false, message: "username dan password wajib diisi" }, 400);
      }
      const users = await getJson(store, "users", []);
      const user = users.find(u => u.username === username.trim() && u.password === password.trim());
      if (!user) {
        return json({ success: false, notFound: true, message: "User tidak ditemukan di server" }, 404);
      }
      if (user.suspended) {
        return json({ success: false, suspended: true, message: "Akun ditangguhkan oleh admin" }, 403);
      }
      return json({ success: true, namaLengkap: user.namaLengkap || user.username });
    }

    // GET /users  — hanya admin
    if (path === "/users" && method === "GET") {
      const { adminPassword } = query;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const users = await getJson(store, "users", []);
      const safeUsers = users.map(u => ({
        username: u.username,
        namaLengkap: u.namaLengkap || u.username,
        suspended: u.suspended ?? false,
        createdAt: u.createdAt ?? null,
      }));
      return json({ success: true, users: safeUsers });
    }

    // POST /users  — tambah user baru, hanya admin
    if (path === "/users" && method === "POST") {
      const { adminPassword, username, password, namaLengkap } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      if (!username || !password) {
        return json({ success: false, message: "username dan password wajib diisi" }, 400);
      }
      const users = await getJson(store, "users", []);
      const existing = users.find(u => u.username === username.trim());
      if (existing) {
        return json({ success: false, message: "Username sudah ada" }, 409);
      }
      users.push({
        username: username.trim(),
        password: password.trim(),
        namaLengkap: (namaLengkap || username).trim(),
        suspended: false,
        createdAt: new Date().toISOString(),
      });
      await setJson(store, "users", users);
      return json({ success: true });
    }

    // POST /users/import  — bulk import dari CSV, hanya admin
    if (path === "/users/import" && method === "POST") {
      const { adminPassword, usersData } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      if (!Array.isArray(usersData)) {
        return json({ success: false, message: "usersData must be array" }, 400);
      }
      const existing = await getJson(store, "users", []);
      const existingMap = {};
      existing.forEach(u => { existingMap[u.username] = true; });
      let added = 0;
      usersData.forEach(u => {
        if (u.username && u.password && !existingMap[u.username]) {
          existing.push({
            username: u.username,
            password: u.password,
            namaLengkap: u.namaLengkap || u.username,
            suspended: false,
            createdAt: new Date().toISOString(),
          });
          existingMap[u.username] = true;
          added++;
        }
      });
      await setJson(store, "users", existing);
      return json({ success: true, added, total: existing.length });
    }

    // PATCH /users/:username  — edit nama / suspend / reset password, hanya admin
    const userPatchMatch = path.match(/^\/users\/([^/]+)$/);
    if (userPatchMatch && method === "PATCH") {
      const { adminPassword, namaLengkap, suspended, password } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const username = decodeURIComponent(userPatchMatch[1]);
      const users = await getJson(store, "users", []);
      const idx = users.findIndex(u => u.username === username);
      if (idx === -1) {
        return json({ success: false, message: "User tidak ditemukan" }, 404);
      }
      if (namaLengkap !== undefined) users[idx].namaLengkap = namaLengkap.trim();
      if (suspended !== undefined) users[idx].suspended = suspended;
      if (password !== undefined && password !== "") users[idx].password = password.trim();
      await setJson(store, "users", users);
      return json({ success: true });
    }

    // DELETE /users/:username  — hapus user, hanya admin
    const userDeleteMatch = path.match(/^\/users\/([^/]+)$/);
    if (userDeleteMatch && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const username = decodeURIComponent(userDeleteMatch[1]);
      let users = await getJson(store, "users", []);
      const before = users.length;
      users = users.filter(u => u.username !== username);
      if (users.length === before) {
        return json({ success: false, message: "User tidak ditemukan" }, 404);
      }
      await setJson(store, "users", users);
      return json({ success: true });
    }

    // GET /maintenance
    if (path === "/maintenance" && method === "GET") {
      const data = await getJson(store, "maintenance", { active: false, message: "", updatedAt: null });
      return json(data);
    }

    // POST /maintenance
    if (path === "/maintenance" && method === "POST") {
      const { adminPassword, active, message } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const data = { active: !!active, message: message ?? "", updatedAt: new Date().toISOString() };
      await setJson(store, "maintenance", data);
      return json({ success: true, ...data });
    }

    // GET /backup
    if (path === "/backup" && method === "GET") {
      const { adminPassword } = query;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const [users, bblm, logs, requests, maintenance, bblmStatus] = await Promise.all([
        getJson(store, "users", []),
        getJson(store, "bblm", {}),
        getJson(store, "activity-logs", []),
        getJson(store, "product-requests", []),
        getJson(store, "maintenance", { active: false, message: "" }),
        getJson(store, "bblm-status", {}),
      ]);
      return json({
        success: true,
        exportedAt: new Date().toISOString(),
        data: { users, bblm, "activity-logs": logs, "product-requests": requests, maintenance, "bblm-status": bblmStatus }
      });
    }

    // POST /restore
    if (path === "/restore" && method === "POST") {
      const { adminPassword, data } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      if (!data || typeof data !== "object") {
        return json({ success: false, message: "data harus berupa object" }, 400);
      }
      const keys = ["users", "bblm", "activity-logs", "product-requests", "maintenance", "bblm-status"];
      let restored = 0;
      await Promise.all(keys.map(async (k) => {
        if (data[k] !== undefined) {
          await setJson(store, k, data[k]);
          restored++;
        }
      }));
      return json({ success: true, message: restored + " kunci data berhasil direstore" });
    }

    // POST /product-request
    if (path === "/product-request" && method === "POST") {
      const { barcode, namaBarang, keterangan, username } = body;
      if (!barcode || !namaBarang || !username) {
        return json({ success: false, message: "barcode, namaBarang, dan username wajib diisi" }, 400);
      }
      const list = await getJson(store, "product-requests", []);
      list.unshift({
        id: randomUUID(),
        barcode: barcode.trim(),
        namaBarang: namaBarang.trim(),
        keterangan: (keterangan ?? "").trim(),
        username: username.trim(),
        createdAt: new Date().toISOString(),
        resolved: false,
      });
      if (list.length > 500) list.length = 500;
      await setJson(store, "product-requests", list);
      return json({ success: true });
    }

    // GET /product-request
    if (path === "/product-request" && method === "GET") {
      const { adminPassword, showResolved } = query;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      let list = await getJson(store, "product-requests", []);
      if (showResolved !== "1") list = list.filter(r => !r.resolved);
      return json({ success: true, requests: list });
    }

    // PATCH /product-request/:id/resolve
    const patchMatch = path.match(/^\/product-request\/([^/]+)\/resolve$/);
    if (patchMatch && method === "PATCH") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const id = patchMatch[1];
      const list = await getJson(store, "product-requests", []);
      const idx = list.findIndex(r => r.id === id);
      if (idx === -1) {
        return json({ success: false, message: "Request tidak ditemukan" }, 404);
      }
      list[idx].resolved = true;
      list[idx].resolvedAt = new Date().toISOString();
      await setJson(store, "product-requests", list);
      return json({ success: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: "Internal server error", detail: String(err) }, 500);
  }
}
