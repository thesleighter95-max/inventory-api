import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { store } from "../lib/store.js";

const router: IRouter = Router();

router.get("/bblm", (_req, res) => {
  const data = store.getBblm();
  res.json(data);
});

router.post("/bblm", (req, res) => {
  const { gradeNames, products, sourceLabel, updatedBy } = req.body as {
    gradeNames: string[];
    products: unknown[];
    sourceLabel?: string;
    updatedBy?: string;
  };

  if (!Array.isArray(products)) {
    res.status(400).json({ success: false, message: "products must be an array" });
    return;
  }

  store.setBblm({
    hasData: true,
    gradeNames: Array.isArray(gradeNames) ? gradeNames : [],
    products: products as never,
    totalProducts: products.length,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy ?? "unknown",
    sourceLabel: sourceLabel ?? "unknown",
  });

  res.json({ success: true, totalProducts: products.length });
});

router.get("/bblm-status", (_req, res) => {
  const data = store.getBblmStatus();
  res.json(data);
});

router.post("/bblm-status", (req, res) => {
  const { status, adminPassword } = req.body as {
    status?: string;
    adminPassword?: string;
  };

  const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] ?? "00000";
  if (adminPassword !== ADMIN_PASSWORD) {
    res.status(403).json({ success: false, message: "Unauthorized" });
    return;
  }

  if (status !== "updated" && status !== "updating") {
    res.status(400).json({ success: false, message: "status must be 'updated' or 'updating'" });
    return;
  }

  const updatedAt = new Date().toISOString();
  store.setBblmStatus({ status, updatedAt });

  res.json({
    success: true,
    status,
    message: status === "updated" ? "BBLM sudah di update" : "BBLM masih proses update",
    updatedAt,
  });
});

router.get("/pwd-status", (_req, res) => {
  const data = store.getPwdStatus();
  res.json(data);
});

router.post("/pwd-status", (req, res) => {
  const { username, changedAt } = req.body as {
    username?: string;
    changedAt?: string;
  };

  if (!username) {
    res.status(400).json({ success: false, message: "username is required" });
    return;
  }

  const current = store.getPwdStatus();
  current[username] = changedAt ?? new Date().toISOString();
  store.setPwdStatus(current);

  res.json({ success: true });
});

router.get("/activity-log", (req, res) => {
  const { adminPassword, limit, username } = req.query as {
    adminPassword?: string;
    limit?: string;
    username?: string;
  };

  const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] ?? "00000";
  if (adminPassword !== ADMIN_PASSWORD) {
    res.status(403).json({ success: false, message: "Unauthorized" });
    return;
  }

  let logs = store.getLogs();

  if (username) {
    logs = logs.filter((l) => l.username === username);
  }

  const maxLimit = Math.min(parseInt(limit ?? "100", 10) || 100, 1000);
  logs = logs.slice(0, maxLimit);

  res.json({ success: true, logs });
});

router.post("/activity-log", (req, res) => {
  const { username, action, detail } = req.body as {
    username?: string;
    action?: string;
    detail?: string;
  };

  if (!username || !action) {
    res.status(400).json({ success: false, message: "username and action are required" });
    return;
  }

  store.addLog({
    username,
    action,
    detail: detail ?? "",
    createdAt: new Date().toISOString(),
  });

  res.json({ success: true });
});

router.post("/product-request", (req, res) => {
  const { barcode, namaBarang, keterangan, username } = req.body as {
    barcode?: string;
    namaBarang?: string;
    keterangan?: string;
    username?: string;
  };

  if (!barcode || !namaBarang || !username) {
    res.status(400).json({ success: false, message: "barcode, namaBarang, dan username wajib diisi" });
    return;
  }

  store.addProductRequest({
    id: randomUUID(),
    barcode: barcode.trim(),
    namaBarang: namaBarang.trim(),
    keterangan: (keterangan ?? "").trim(),
    username: username.trim(),
    createdAt: new Date().toISOString(),
    resolved: false,
  });

  res.json({ success: true });
});

router.get("/product-request", (req, res) => {
  const { adminPassword, showResolved } = req.query as {
    adminPassword?: string;
    showResolved?: string;
  };

  const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] ?? "00000";
  if (adminPassword !== ADMIN_PASSWORD) {
    res.status(403).json({ success: false, message: "Unauthorized" });
    return;
  }

  let list = store.getProductRequests();
  if (showResolved !== "1") list = list.filter((r) => !r.resolved);

  res.json({ success: true, requests: list });
});

router.patch("/product-request/:id/resolve", (req, res) => {
  const { adminPassword } = req.body as { adminPassword?: string };
  const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] ?? "00000";

  if (adminPassword !== ADMIN_PASSWORD) {
    res.status(403).json({ success: false, message: "Unauthorized" });
    return;
  }

  const ok = store.resolveProductRequest(req.params.id);
  if (!ok) {
    res.status(404).json({ success: false, message: "Request tidak ditemukan" });
    return;
  }

  res.json({ success: true });
});

export default router;
