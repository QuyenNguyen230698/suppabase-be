// /metrics — Prometheus scrape endpoint for the ingestion pipeline.
//
// Public (no auth) like /api/health so a Prometheus server can scrape it.
// Counters are pushed inline by the worker/cores; the gauges below are computed
// at scrape time from the DB (queue backlog + DLQ depth) so they're always
// current without a separate sampler.

import { Router } from 'express';
import { query } from '../db/index.js';
import { render, registerGauge } from '../services/ingest/metrics.js';

// Queue backlog by status — alerts on a growing 'queued'/'failed' pile.
registerGauge('ingest_jobs_status', 'Current ingest_jobs count by status', async () => {
  const { rows } = await query(`SELECT status, COUNT(*)::int AS n FROM ingest_jobs GROUP BY status`);
  return rows.map((r) => ({ labels: { status: r.status }, value: r.n }));
});

// DLQ depth — the sitemap's "DLQ phình to" alert source.
registerGauge('ingest_dlq_depth', 'Number of rows in the ingest dead-letter queue', async () => {
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ingest_dlq`);
  return rows[0]?.n ?? 0;
});

// Invoices awaiting human review — OCR-core review backlog.
registerGauge('ingest_invoices_needs_review', 'Invoices pending manual review', async () => {
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM invoices WHERE review_status = 'needs_review'`);
  return rows[0]?.n ?? 0;
});

const router = Router();

router.get('/', async (req, res) => {
  try {
    const body = await render();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(body);
  } catch (err) {
    res.status(500).send(`# metrics render error: ${err.message}\n`);
  }
});

export default router;
