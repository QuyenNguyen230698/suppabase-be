// ingestionCore — entry point of the document pipeline.
//
// Called right after a file is uploaded to R2 (uploadController). It records
// the router's decision on the documents row and enqueues a durable ingest_jobs
// row for the background worker to pick up. This replaces the old fire-and-forget
// setImmediate(processAttachment) so jobs survive restarts and can be retried.
//
// Quarantine: if the router can't map the file to a core (shouldn't happen
// after the magic-byte middleware), the document is flagged 'quarantined' and
// NO job is enqueued.

import { query } from '../../db/index.js';
import { route } from './router.js';

// Persist routing metadata + enqueue a job. Returns { core, jobId } or
// { core: null, quarantined: true }.
export async function enqueueDocument({ documentId, kind, mimetype, payload = {} }) {
  const decision = route({ kind, mimetype });

  await query(
    `UPDATE documents
        SET detected_mime = $1, magic_ok = $2, router_core = $3
      WHERE id = $4`,
    [decision.detectedMime, decision.magicOk, decision.core, documentId],
  );

  if (!decision.core) {
    await query(
      `UPDATE documents SET status = 'quarantined', error_msg = 'Router could not classify file' WHERE id = $1`,
      [documentId],
    );
    return { core: null, quarantined: true };
  }

  const { rows } = await query(
    `INSERT INTO ingest_jobs (document_id, core, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [documentId, decision.core, JSON.stringify(payload)],
  );
  return { core: decision.core, jobId: rows[0].id };
}
