import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const priceSnapshotTable = pgTable("price_snapshot", {
  barcode: text("barcode").primaryKey(),
  harga: text("harga").notNull(),
  savedAt: timestamp("saved_at", { withTimezone: true }).defaultNow().notNull(),
});

export type PriceSnapshot = typeof priceSnapshotTable.$inferSelect;
