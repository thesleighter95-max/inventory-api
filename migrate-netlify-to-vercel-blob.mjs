#!/usr/bin/env node
    /**
    * migrate-netlify-to-vercel-blob.mjs
    * 
    * Script migrasi data dari Netlify Blobs ke Vercel Blob.
    * 
    * Requirements:
    *   NETLIFY_TOKEN     — Netlify Personal Access Token (dari app.netlify.com/user/applications)
    *   NETLIFY_SITE_ID   — ID situs Netlify Anda
    *   BLOB_READ_WRITE_TOKEN — Vercel Blob token (dari Vercel Dashboard → Storage → Blob store)
    * 
    * Usage:
    *   NETLIFY_TOKEN=xxx NETLIFY_SITE_ID=xxx BLOB_READ_WRITE_TOKEN=xxx node migrate-netlify-to-vercel-blob.mjs
    */

    import { put } from "@vercel/blob";

    const NETLIFY_TOKEN   = process.env.NETLIFY_TOKEN;
    const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;
    const BLOB_TOKEN      = process.env.BLOB_READ_WRITE_TOKEN;

    if (!NETLIFY_TOKEN || !NETLIFY_SITE_ID || !BLOB_TOKEN) {
    console.error("ERROR: Set NETLIFY_TOKEN, NETLIFY_SITE_ID, dan BLOB_READ_WRITE_TOKEN");
    process.exit(1);
    }

    const NETLIFY_API = "https://api.netlify.com/api/v1";
    const BLOB_PREFIX = "inventory/";

    // ── Netlify Blobs helpers ───────────────────────────────────────
    async function netlifyGet(key) {
    // Netlify Blobs API: GET /sites/:site_id/blobs/:store_name/:key
    const url = `${NETLIFY_API}/sites/${NETLIFY_SITE_ID}/blobs/inventory/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` }
    });
    if (!res.ok) return null;
    return await res.text();
    }

    async function netlifyList() {
    // List all keys in the "inventory" store
    const url = `${NETLIFY_API}/sites/${NETLIFY_SITE_ID}/blobs/inventory`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` }
    });
    if (!res.ok) { console.error("List failed:", res.status, await res.text()); return []; }
    const data = await res.json();
    return data.blobs || data.items || data || [];
    }

    // ── Vercel Blob helpers ─────────────────────────────────────────
    async function vercelPut(key, value, contentType = "application/json") {
    await put(BLOB_PREFIX + key + (contentType === "text/plain" ? ".txt" : ".json"), value, {
      access: "public",
      addRandomSuffix: false,
      contentType,
      cacheControlMaxAge: 0,
      token: BLOB_TOKEN,
    });
    }

    // ── Main migration ──────────────────────────────────────────────
    async function migrate() {
    console.log("\n=== MIGRASI NETLIFY BLOBS → VERCEL BLOB ===\n");

    // 1. List all blobs
    console.log("1. Mengambil daftar blob dari Netlify...");
    const items = await netlifyList();
    console.log(`   Ditemukan ${items.length} items`);

    if (!items.length) {
      console.log("   Tidak ada data untuk dimigrasi.");
      return;
    }

    let ok = 0, fail = 0;

    // 2. Migrate each item
    for (const item of items) {
      const key = item.key || item.name || item;
      try {
        const raw = await netlifyGet(key);
        if (raw === null) {
          console.log(`  SKIP (kosong): ${key}`);
          continue;
        }

        // Determine content type
        const isPhoto = key.startsWith("gallery-photo-") || key.startsWith("bblm-foto-photo-");
        const contentType = isPhoto ? "text/plain" : "application/json";

        await vercelPut(key, raw, contentType);
        console.log(`  ✓ ${key} (${raw.length} bytes)`);
        ok++;
      } catch (e) {
        console.error(`  ✗ ${key}: ${e.message}`);
        fail++;
      }

      // Rate limiting — jangan terlalu cepat
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`\n=== SELESAI: ${ok} berhasil, ${fail} gagal ===\n`);
    }

    migrate().catch(e => { console.error("FATAL:", e); process.exit(1); });
    