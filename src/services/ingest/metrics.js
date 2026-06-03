// metrics — tiny Prometheus exposition registry (no dependency).
//
// The sitemap's right rail (MONITORING) wants ingest rate, OCR fail %, embed
// throughput, worker health and DLQ depth scrapeable by Prometheus/Grafana.
// We avoid pulling in prom-client for a handful of series — this emits the
// text exposition format directly.
//
//   • Counters   — monotonic; incremented inline by the worker/cores.
//   • Gauges     — point-in-time; some are pushed (worker_up), some are
//     computed at scrape time from the DB (queue/DLQ depth) via registerGauge.

const counters = new Map();   // name → Map(labelKey → value)
const counterMeta = new Map();// name → help
const gauges = new Map();     // name → number  (pushed gauges)
const gaugeMeta = new Map();  // name → help
const dynamicGauges = new Map(); // name → { help, fn: async () => number | [{labels,value}] }

function labelKey(labels) {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return keys.map((k) => `${k}="${String(labels[k]).replace(/[\\"\n]/g, '_')}"`).join(',');
}

export function defineCounter(name, help) {
  if (!counters.has(name)) { counters.set(name, new Map()); counterMeta.set(name, help); }
}

export function incCounter(name, labels = {}, by = 1) {
  if (!counters.has(name)) defineCounter(name, name);
  const series = counters.get(name);
  const k = labelKey(labels);
  series.set(k, (series.get(k) || 0) + by);
}

export function setGauge(name, value, help) {
  gauges.set(name, value);
  if (help && !gaugeMeta.has(name)) gaugeMeta.set(name, help);
}

// Register a gauge computed at scrape time (e.g. SELECT count from DB).
// fn returns a number, or an array of { labels, value } for a labelled gauge.
export function registerGauge(name, help, fn) {
  dynamicGauges.set(name, { help, fn });
}

function fmtLine(name, k, value) {
  return k ? `${name}{${k}} ${value}` : `${name} ${value}`;
}

// Render the full registry in Prometheus text exposition format.
export async function render() {
  const out = [];

  for (const [name, series] of counters) {
    out.push(`# HELP ${name} ${counterMeta.get(name) || name}`);
    out.push(`# TYPE ${name} counter`);
    if (series.size === 0) out.push(`${name} 0`);
    for (const [k, v] of series) out.push(fmtLine(name, k, v));
  }

  for (const [name, v] of gauges) {
    out.push(`# HELP ${name} ${gaugeMeta.get(name) || name}`);
    out.push(`# TYPE ${name} gauge`);
    out.push(`${name} ${v}`);
  }

  for (const [name, { help, fn }] of dynamicGauges) {
    out.push(`# HELP ${name} ${help || name}`);
    out.push(`# TYPE ${name} gauge`);
    try {
      const res = await fn();
      if (Array.isArray(res)) {
        for (const { labels = {}, value } of res) out.push(fmtLine(name, labelKey(labels), value));
      } else {
        out.push(`${name} ${res}`);
      }
    } catch (err) {
      // A failing scrape query shouldn't blow up the whole /metrics response.
      out.push(`# scrape error for ${name}: ${String(err.message).replace(/\n/g, ' ')}`);
    }
  }

  return out.join('\n') + '\n';
}

// ── Ingestion metric names (pre-defined so they appear even at zero) ─────────
defineCounter('ingest_jobs_total',     'Ingest jobs processed, by core and outcome');
defineCounter('ingest_embed_total',    'Embeddings attempted, by outcome (ok|fail|invalid)');
defineCounter('ingest_ocr_total',      'OCR invoices processed, by review_status');
setGauge('ingest_worker_up', 0, 'Whether the ingest worker loop is running (1) or not (0)');
