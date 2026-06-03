export const runtime = "edge";

import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

async function getJson(key, defaultValue) {
  try {
    const raw = await redis.get(key);
    if (raw === null || raw === undefined) return defaultValue;
    return raw;
  } catch {
    return defaultValue;
  }
}

async function setJson(key, data) {
  await redis.set(key, data);
}

export default async function handler(req) {
  const url = new URL(req.url);
  const method = req.method;

  if (method === "OPTIONS") {
    return new Response("", { status: 200, headers: CORS_HEADERS });
  }

  const path = url.pathname.replace(/^\/?api/, "") || "/";

  let body = {};
  if (method !== "GET" && method !== "HEAD") {
    try { body = await req.json(); } catch { /* ignore */ }
  }

  const query = Object.fromEntries(url.searchParams.entries());

  try {
    if (path === "/healthz" && method === "GET") {
      return json({ status: "ok" });
    }

    if (path === "/bblm" && method === "GET") {
      const data = await getJson("bblm", {
        hasData: false, gradeNames: [], products: [],
        totalProducts: 0, updatedAt: null, updatedBy: "", sourceLabel: "",
      });
      return json(data);
    }

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
      await setJson("bblm", data);
      return json({ success: true, totalProducts: products.length });
    }

    if (path === "/bblm-status" && method === "GET") {
      const data = await getJson("bblm-status", { status: "updating", updatedAt: null });
      return json(data);
    }

    if (path === "/bblm-status" && method === "POST") {
      const { status, adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      if (status !== "updated" && status !== "updating") {
        return json({ success: false, message: "status must be 'updated' or 'updating'" }, 400);
      }
      const updatedAt = new Date().toISOString();
      await setJson("bblm-status", { status, updatedAt });
      return json({
        success: true, status, updatedAt,
        message: status === "updated" ? "BBLM sudah di update" : "BBLM masih proses update",
      });
    }

    if (path === "/pwd-status" && method === "GET") {
      const data = await getJson("pwd-status", {});
      return json(data);
    }

    if (path === "/pwd-status" && method === "POST") {
      const { username, changedAt } = body;
      if (!username) {
        return json({ success: false, message: "username is required" }, 400);
      }
      const current = await getJson("pwd-status", {});
      current[username] = changedAt ?? new Date().toISOString();
      await setJson("pwd-status", current);
      return json({ success: true });
    }

    if (path === "/activity-log" && method === "GET") {
      const { adminPassword, limit, username } = query;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      let logs = await getJson("activity-logs", []);
      if (username) logs = logs.filter(l => l.username === username);
      const maxLimit = Math.min(parseInt(limit ?? "100", 10) || 100, 1000);
      logs = logs.slice(0, maxLimit);
      return json({ success: true, logs });
    }

    if (path === "/activity-log" && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      await setJson("activity-logs", []);
      return json({ success: true, message: "Semua log berhasil dihapus" });
    }

    if (path === "/activity-log" && method === "POST") {
      const { username, action, detail } = body;
      if (!username || !action) {
        return json({ success: false, message: "username and action are required" }, 400);
      }
      const logs = await getJson("activity-logs", []);
      logs.unshift({ username, action, detail: detail ?? "", createdAt: new Date().toISOString() });
      if (logs.length > 1000) logs.length = 1000;
      await setJson("activity-logs", logs);
      return json({ success: true });
    }

    if (path === "/login" && method === "POST") {
      const { username, password } = body;
      if (!username || !password) {
        return json({ success: false, message: "username dan password wajib diisi" }, 400);
      }
      const users = await getJson("users", []);
      const user = users.find(u => u.username === username.trim() && u.password === password.trim());
      if (!user) {
        return json({ success: false, notFound: true, message: "User tidak ditemukan di server" }, 404);
      }
      if (user.suspended) {
        return json({ success: false, suspended: true, message: "Akun ditangguhkan oleh admin" }, 403);
      }
      return json({ success: true, namaLengkap: user.namaLengkap || user.username });
    }

    if (path === "/users" && method === "GET") {
      const { adminPassword } = query;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const users = await getJson("users", []);
      const safeUsers = users.map(u => ({
        username: u.username,
        namaLengkap: u.namaLengkap || u.username,
        suspended: u.suspended ?? false,
        createdAt: u.createdAt ?? null,
      }));
      return json({ success: true, users: safeUsers });
    }

    if (path === "/users" && method === "POST") {
      const { adminPassword, username, password, namaLengkap } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      if (!username || !password) {
        return json({ success: false, message: "username dan password wajib diisi" }, 400);
      }
      const users = await getJson("users", []);
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
      await setJson("users", users);
      return json({ success: true });
    }

    if (path === "/users/import" && method === "POST") {
      const { adminPassword, usersData } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      if (!Array.isArray(usersData)) {
        return json({ success: false, message: "usersData must be array" }, 400);
      }
      const existing = await getJson("users", []);
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
      await setJson("users", existing);
      return json({ success: true, added, total: existing.length });
    }

    const userPatchMatch = path.match(/^\/users\/([^/]+)$/);
    if (userPatchMatch && method === "PATCH") {
      const { adminPassword, namaLengkap, suspended, password } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const username = decodeURIComponent(userPatchMatch[1]);
      const users = await getJson("users", []);
      const idx = users.findIndex(u => u.username === username);
      if (idx === -1) {
        return json({ success: false, message: "User tidak ditemukan" }, 404);
      }
      if (namaLengkap !== undefined) users[idx].namaLengkap = namaLengkap.trim();
      if (suspended !== undefined) users[idx].suspended = suspended;
      if (password !== undefined && password !== "") users[idx].password = password.trim();
      await setJson("users", users);
      return json({ success: true });
    }

    const userDeleteMatch = path.match(/^\/users\/([^/]+)$/);
    if (userDeleteMatch && method === "DELETE") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const username = decodeURIComponent(userDeleteMatch[1]);
      let users = await getJson("users", []);
      const before = users.length;
      users = users.filter(u => u.username !== username);
      if (users.length === before) {
        return json({ success: false, message: "User tidak ditemukan" }, 404);
      }
      await setJson("users", users);
      return json({ success: true });
    }

    if (path === "/maintenance" && method === "GET") {
      const data = await getJson("maintenance", { active: false, message: "", updatedAt: null });
      return json(data);
    }

    if (path === "/maintenance" && method === "POST") {
      const { adminPassword, active, message } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const data = { active: !!active, message: message ?? "", updatedAt: new Date().toISOString() };
      await setJson("maintenance", data);
      return json({ success: true, ...data });
    }

    if (path === "/storage-info" && method === "GET") {
      const { adminPassword } = query;
      if (adminPassword !== ADMIN_PASSWORD) return json({ success: false, message: "Unauthorized" }, 403);
      const keys = ["users","bblm","activity-logs","product-requests","maintenance","bblm-status","price-snapshot-current","price-snapshot-prev"];
      const results = await Promise.all(keys.map(async k => {
        try {
          const raw = await redis.get(k);
          const str = raw ? JSON.stringify(raw) : "";
          const bytes = new TextEncoder().encode(str).length;
          return { key: k, bytes, kb: (bytes/1024).toFixed(2) };
        } catch { return { key: k, bytes: 0, kb: "0.00" }; }
      }));
      const totalBytes = results.reduce((s,r)=>s+r.bytes,0);
      return json({ success: true, items: results, totalKB: (totalBytes/1024).toFixed(2), totalMB: (totalBytes/1024/1024).toFixed(4) });
    }

    if (path === "/backup" && method === "GET") {
      const { adminPassword } = query;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const [users, bblm, logs, requests, maintenance, bblmStatus] = await Promise.all([
        getJson("users", []),
        getJson("bblm", {}),
        getJson("activity-logs", []),
        getJson("product-requests", []),
        getJson("maintenance", { active: false, message: "" }),
        getJson("bblm-status", {}),
      ]);
      return json({
        success: true,
        exportedAt: new Date().toISOString(),
        data: { users, bblm, "activity-logs": logs, "product-requests": requests, maintenance, "bblm-status": bblmStatus }
      });
    }

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
          await setJson(k, data[k]);
          restored++;
        }
      }));
      return json({ success: true, message: restored + " kunci data berhasil direstore" });
    }

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

    if (path === "/price-history" && method === "POST") {
      const { barcode, price } = body;
      if (!barcode || price === undefined) return json({ success: false, message: "barcode dan price wajib diisi" }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const existing = await getJson(`price-history:${barcode}`, null);
      if (!existing || existing.date !== today) {
        await setJson(`price-history:${barcode}`, { price: Number(price), date: today });
      }
      return json({ success: true });
    }

    if (path === "/sync-prices" && method === "GET") {
      const [current, prev] = await Promise.all([
        getJson("price-snapshot-current", { date: null, prices: {} }),
        getJson("price-snapshot-prev", { date: null, prices: {} })
      ]);
      return json({
        success: true,
        current: { date: current.date, count: Object.keys(current.prices || {}).length },
        prev: { date: prev.date, count: Object.keys(prev.prices || {}).length, prices: prev.prices || {} }
      });
    }

    if (path === "/sync-prices" && method === "POST") {
      const { items, forceOverwrite } = body;
      if (!Array.isArray(items) || !items.length) return json({ success: false, message: "items harus array" }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const current = await getJson("price-snapshot-current", { date: null, prices: {} });
      if (current.date === today && !forceOverwrite) return json({ success: true, saved: 0, message: "sudah tersimpan hari ini" });
      if (current.date && current.date !== today) {
        await setJson("price-snapshot-prev", current);
      }
      const prices = {};
      items.forEach(({ barcode, price }) => { if (barcode) prices[barcode] = Number(price) || 0; });
      await setJson("price-snapshot-current", { date: today, prices });
      return json({ success: true, saved: Object.keys(prices).length });
    }

    if (path === "/product-request" && method === "POST") {
      const { barcode, namaBarang, keterangan, username } = body;
      if (!barcode || !namaBarang || !username) {
        return json({ success: false, message: "barcode, namaBarang, dan username wajib diisi" }, 400);
      }
      const list = await getJson("product-requests", []);
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
      await setJson("product-requests", list);
      return json({ success: true });
    }

    if (path === "/product-request" && method === "GET") {
      const { adminPassword, showResolved } = query;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      let list = await getJson("product-requests", []);
      if (showResolved !== "1") list = list.filter(r => !r.resolved);
      return json({ success: true, requests: list });
    }

    const patchMatch = path.match(/^\/product-request\/([^/]+)\/resolve$/);
    if (patchMatch && method === "PATCH") {
      const { adminPassword } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return json({ success: false, message: "Unauthorized" }, 403);
      }
      const id = patchMatch[1];
      const list = await getJson("product-requests", []);
      const idx = list.findIndex(r => r.id === id);
      if (idx === -1) {
        return json({ success: false, message: "Request tidak ditemukan" }, 404);
      }
      list[idx].resolved = true;
      list[idx].resolvedAt = new Date().toISOString();
      await setJson("product-requests", list);
      return json({ success: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: "Internal server error", detail: String(err) }, 500);
  }
}
