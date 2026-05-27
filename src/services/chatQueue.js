// Chat concurrency queue — lazy-start design.
//
// Solves the race condition where the worker finishes BEFORE the client opens
// the SSE stream (GET /api/chat/stream/:jobId). Classic symptom: "Job already
// completed" even though POST and GET happen within milliseconds.
//
// Design principle: workers with a free slot do NOT start immediately. They
// wait until the subscriber attaches. Once attached, the worker starts and
// writes directly to the live response. Workers that are queued (no free slot)
// also wait for the subscriber before starting, but the worker behind them can
// take a free slot and start if a different subscriber is already attached.
//
// Buffer fallback: if the worker somehow finishes before the subscriber
// arrives (e.g. a cached response), ALL emitted events are buffered and
// replayed on subscribe(). This makes the system correct under any race.

import crypto from 'crypto';

const CONCURRENCY = parseInt(process.env.CHAT_CONCURRENCY || '50', 10);
const JOB_TTL_MS  = parseInt(process.env.CHAT_JOB_TTL_MS  || String(5 * 60 * 1000), 10);

// ── Redis (optional metadata persistence) ─────────────────────────────────
let redis = null;
async function getRedis() {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { default: IORedis } = await import('ioredis');
    redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    console.log('[chatQueue] Redis connected:', url.replace(/:[^:@]+@/, ':***@'));
  } catch (err) {
    console.warn('[chatQueue] Redis unavailable, in-memory only:', err.message);
    redis = null;
  }
  return redis;
}

// ── In-memory state ────────────────────────────────────────────────────────
// jobId → {
//   userId, status: 'pending'|'waiting_subscriber'|'running'|'done'|'error',
//   createdAt, expiresAt,
//   buffer: string[],      // raw SSE lines buffered before/during run
//   abortCtrl: AbortController|null,
//   startWorker: Function|null,  // called by subscribe() to kick off the job
// }
const jobMeta = new Map();

// jobId → { res, heartbeat, timeout }
const jobSubs  = new Map();

// FIFO wait queue for jobs that have no free slot yet
// Each entry: { jobId, kick: () => void }
// kick() is called by drainQueue() when a slot opens up
const waitQueue = [];

let activeCount = 0;

// ── Helpers ────────────────────────────────────────────────────────────────
function makeJobId() { return crypto.randomBytes(16).toString('hex'); }

function rawLine(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

// Emit one SSE event — write live if subscriber attached, else buffer.
function jobWrite(jobId, obj) {
  const line = rawLine(obj);
  const sub  = jobSubs.get(jobId);
  if (sub && !sub.res.writableEnded) {
    sub.res.write(line);
  } else {
    const m = jobMeta.get(jobId);
    if (m) m.buffer.push(line);
  }
}

function broadcastQueuePositions() {
  let pos = 1;
  for (const { jobId } of waitQueue) {
    const sub = jobSubs.get(jobId);
    if (sub && !sub.res.writableEnded) {
      sub.res.write(rawLine({ type: 'queue_position', position: pos, queue_length: waitQueue.length }));
    }
    pos++;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Enqueue a chat job. Returns { jobId } synchronously.
 * The worker does NOT start until subscribe() is called for this jobId.
 *
 * @param {object} opts
 * @param {string}   opts.userId
 * @param {Function} opts.run  async (write, signal) => void
 *   write(obj) — emit one SSE event object
 *   signal     — AbortSignal (fires on client disconnect)
 */
export function enqueue({ userId, run }) {
  const jobId = makeJobId();
  const now   = Date.now();

  const meta = {
    userId,
    status:      'waiting_subscriber',
    createdAt:   now,
    expiresAt:   now + JOB_TTL_MS,
    buffer:      [],
    abortCtrl:   null,
    startWorker: null,   // filled below
  };
  jobMeta.set(jobId, meta);

  setTimeout(() => cleanupJob(jobId), JOB_TTL_MS + 2000);

  const write = (obj) => jobWrite(jobId, obj);

  // Build the actual worker function
  const workerFn = async () => {
    const m = jobMeta.get(jobId);
    if (!m) return;

    m.status = 'running';
    // activeCount already incremented when the slot was reserved in enqueue()

    const ac = new AbortController();
    m.abortCtrl = ac;

    const sub = jobSubs.get(jobId);
    if (sub) sub.res.on('close', () => ac.abort());

    try {
      await run(write, ac.signal);
      m.status = 'done';
    } catch (err) {
      m.status = 'error';
      write({ type: 'error', error: err.message || 'Internal error' });
    } finally {
      activeCount--;
      const liveSub = jobSubs.get(jobId);
      if (liveSub && !liveSub.res.writableEnded) {
        // Flush any buffered events that arrived before subscriber
        for (const line of m.buffer) liveSub.res.write(line);
        m.buffer = [];
        liveSub.res.end();
      }
      drainQueue();
    }
  };

  if (activeCount < CONCURRENCY) {
    // Free slot — reserve it now but wait for subscriber to kick off
    activeCount++;
    meta.startWorker = () => {
      // Subscriber attached — actually start
      setImmediate(workerFn);
    };
    meta._freeSlotReserved = true;
  } else {
    // No free slot — queue and wait for both: a slot AND a subscriber
    const queueEntry = { jobId, kick: null };
    meta.startWorker = () => {
      // Subscriber attached — tell the queue entry it can start when drained
      queueEntry.kick = workerFn;
      // Try drain in case a slot opened between enqueue and subscribe
      drainQueue();
    };
    waitQueue.push(queueEntry);
  }

  return { jobId };
}

/**
 * Attach an SSE HTTP response to a job and start the worker.
 */
export function subscribe(jobId, res) {
  const meta = jobMeta.get(jobId);

  // ── SSE headers ───────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!meta || Date.now() > meta.expiresAt) {
    res.write(rawLine({ type: 'error', error: 'Job not found or expired', code: 'ERR_JOB_NOT_FOUND' }));
    res.end();
    return;
  }

  // ── Replay buffer (jobs that finished before subscriber arrived) ──────────
  if (meta.buffer.length > 0) {
    for (const line of meta.buffer) res.write(line);
    meta.buffer = [];
  }

  if (meta.status === 'done' || meta.status === 'error') {
    res.end();
    return;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  const heartbeat = setInterval(() => {
    if (res.writableEnded) { clearInterval(heartbeat); return; }
    res.write(': heartbeat\n\n');
  }, 15000);

  // ── Timeout ───────────────────────────────────────────────────────────────
  const timeout = setTimeout(() => {
    if (!res.writableEnded) {
      res.write(rawLine({ type: 'error', error: 'Queue timeout — please try again', code: 'ERR_QUEUE_TIMEOUT' }));
      res.end();
    }
    clearInterval(heartbeat);
    const idx = waitQueue.findIndex((e) => e.jobId === jobId);
    if (idx !== -1) waitQueue.splice(idx, 1);
    // Release reserved slot if job never ran
    if (meta._freeSlotReserved && meta.status === 'waiting_subscriber') {
      activeCount--;
      meta._freeSlotReserved = false;
      drainQueue();
    }
    cleanupJob(jobId);
  }, JOB_TTL_MS);

  res.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    if (meta.abortCtrl) meta.abortCtrl.abort();
    jobSubs.delete(jobId);
  });

  jobSubs.set(jobId, { res, heartbeat, timeout });

  // ── Queue position (if still waiting for a slot) ──────────────────────────
  if (!meta._freeSlotReserved) {
    const pos = waitQueue.findIndex((e) => e.jobId === jobId) + 1;
    if (pos > 0) {
      res.write(rawLine({ type: 'queue_position', position: pos, queue_length: waitQueue.length }));
    }
  }

  // ── Kick the worker now that subscriber is attached ───────────────────────
  if (meta.startWorker) {
    const fn = meta.startWorker;
    meta.startWorker = null;
    fn();
  }
}

export function freeSlots()  { return Math.max(0, CONCURRENCY - activeCount); }
export function queueDepth() { return waitQueue.length; }
export function stats() {
  return { concurrency_limit: CONCURRENCY, active: activeCount, queued: waitQueue.length, free_slots: freeSlots() };
}

// ── Internal ───────────────────────────────────────────────────────────────
function drainQueue() {
  while (activeCount < CONCURRENCY && waitQueue.length > 0) {
    const entry = waitQueue[0];
    if (!entry.kick) break; // subscriber not attached yet for this job — stop
    waitQueue.shift();
    activeCount++; // reserve the slot for this queued job
    broadcastQueuePositions();
    setImmediate(entry.kick);
  }
}

function cleanupJob(jobId) {
  jobMeta.delete(jobId);
  const sub = jobSubs.get(jobId);
  if (sub) {
    clearInterval(sub.heartbeat);
    clearTimeout(sub.timeout);
    if (!sub.res.writableEnded) sub.res.end();
    jobSubs.delete(jobId);
  }
}
