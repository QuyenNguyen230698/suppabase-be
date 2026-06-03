// backoff — exponential backoff + jitter for the ingestion retry worker.
//
// On a transient failure the job goes back to 'queued' with next_attempt_at
// pushed into the future; the worker only re-claims it once that time passes.
// Jitter spreads retries so a provider outage doesn't cause a thundering herd
// when it recovers. Once attempts exceed max_attempts the job is terminal
// ('dead') and gets mirrored into ingest_dlq.

const BASE_MS = Number(process.env.INGEST_BACKOFF_BASE_MS || 2000);   // 2s
const MAX_MS  = Number(process.env.INGEST_BACKOFF_MAX_MS  || 300000); // 5m cap

// Delay before the Nth retry (attempt = number already made, ≥1).
// 2s, 4s, 8s, 16s … capped at MAX_MS, ± up to 50% jitter.
export function backoffMs(attempt) {
  const expo = Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = expo * (Math.random() * 0.5); // 0–50% extra
  return Math.round(expo + jitter);
}

export function nextAttemptAt(attempt) {
  return new Date(Date.now() + backoffMs(attempt));
}
