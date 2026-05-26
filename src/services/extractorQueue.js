// In-process queue for document extraction. Caps concurrency so a burst of
// 100 simultaneous PDF uploads can't OOM the box, and applies a hard timeout
// per job so a malformed file (pdf-parse ReDoS, xlsx prototype-pollution loop)
// can't pin a worker forever.
//
// This is a stopgap — when we move to multi-process we should swap this for
// pg-boss / BullMQ so jobs survive a restart.

const MAX_CONCURRENCY = Number(process.env.EXTRACT_CONCURRENCY || 2);
const JOB_TIMEOUT_MS  = Number(process.env.EXTRACT_TIMEOUT_MS || 60000);

let inFlight = 0;
const waiters = [];

function acquire() {
  if (inFlight < MAX_CONCURRENCY) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  inFlight -= 1;
  const next = waiters.shift();
  if (next) {
    inFlight += 1;
    next();
  }
}

function withTimeout(promise, ms) {
  let to;
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => {
      const err = new Error(`Extractor timed out after ${ms}ms`);
      err.code = 'ERR_EXTRACT_TIMEOUT';
      reject(err);
    }, ms);
    to.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(to));
}

export async function runExtract(fn) {
  await acquire();
  try {
    return await withTimeout(Promise.resolve().then(fn), JOB_TIMEOUT_MS);
  } finally {
    release();
  }
}

export function queueStats() {
  return { inFlight, queued: waiters.length, maxConcurrency: MAX_CONCURRENCY };
}
