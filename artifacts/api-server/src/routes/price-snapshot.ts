import { Router, type IRouter } from "express";
import { db, priceSnapshotTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/price-snapshot", async (req, res) => {
  try {
    const rows = await db.select().from(priceSnapshotTable);
    const snapshot: Record<string, string> = {};
    for (const row of rows) {
      snapshot[row.barcode] = row.harga;
    }
    res.json({ snapshot });
  } catch (err) {
    req.log.error({ err }, "Failed to get price snapshot");
    res.status(500).json({ error: "Failed to get snapshot" });
  }
});

router.post("/price-snapshot", async (req, res) => {
  try {
    const incoming = req.body as Record<string, string>;
    if (!incoming || typeof incoming !== "object") {
      res.status(400).json({ error: "Invalid body" });
      return;
    }

    const entries = Object.entries(incoming);
    if (entries.length === 0) {
      res.json({ ok: true, updated: 0 });
      return;
    }

    const existing = await db.select().from(priceSnapshotTable);
    const existingMap: Record<string, number> = {};
    for (const row of existing) {
      existingMap[row.barcode] =
        parseInt(row.harga.replace(/[^0-9]/g, "")) || 0;
    }

    const toUpsert = entries.filter(([bc, h]) => {
      const newH = parseInt(h.replace(/[^0-9]/g, "")) || 0;
      const oldH = existingMap[bc] ?? 0;
      return newH >= oldH;
    });

    if (toUpsert.length === 0) {
      res.json({ ok: true, updated: 0 });
      return;
    }

    await db
      .insert(priceSnapshotTable)
      .values(toUpsert.map(([barcode, harga]) => ({ barcode, harga })))
      .onConflictDoUpdate({
        target: priceSnapshotTable.barcode,
        set: {
          harga: sql`EXCLUDED.harga`,
          savedAt: sql`NOW()`,
        },
      });

    res.json({ ok: true, updated: toUpsert.length });
  } catch (err) {
    req.log.error({ err }, "Failed to update price snapshot");
    res.status(500).json({ error: "Failed to update snapshot" });
  }
});

export default router;
