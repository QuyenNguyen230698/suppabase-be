#!/usr/bin/env node
// Embed every row in banned_exemplars that has NULL embedding.
// Idempotent: re-runs only fill in missing embeddings.
//
// Usage:
//   AI_PROVIDER=cloudflare node scripts/embed_exemplars.js
//
// (Forces CF for the embed call so this works even if the chat path is on PEB.)

import 'dotenv/config';
import { generateEmbedding } from '../src/services/embeddingService.js';
import { query } from '../src/db/index.js';

const BATCH = 5;          // bge-m3 likes small batches over the gateway
const SLEEP_MS = 250;     // gentle pacing to avoid rate limit

async function main() {
  const { rows } = await query(
    `SELECT id, text FROM banned_exemplars WHERE embedding IS NULL AND is_active = TRUE ORDER BY id`
  );
  console.log(`[embed_exemplars] ${rows.length} rows to embed`);

  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async (r) => {
      const vec = await generateEmbedding(r.text);
      if (!Array.isArray(vec) || !vec.length) throw new Error(`empty embedding for id=${r.id}`);
      await query(
        `UPDATE banned_exemplars SET embedding = $2::vector WHERE id = $1`,
        [r.id, `[${vec.join(',')}]`]
      );
      return r.id;
    }));
    for (const res of results) {
      if (res.status === 'fulfilled') { ok++; process.stdout.write('.'); }
      else { fail++; console.error(`\n  ! ${res.reason?.message || res.reason}`); }
    }
    await new Promise(r => setTimeout(r, SLEEP_MS));
  }
  console.log(`\n[embed_exemplars] done: ok=${ok} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
