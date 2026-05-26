// circuitBreaker — per-provider state machine to stop hammering a failing upstream.
//
// States:
//   CLOSED   — normal operation. Errors increment a counter.
//   OPEN     — too many recent errors → fail fast for `coolDownMs` without calling upstream.
//   HALF_OPEN — after cool-down, allow ONE probe. Success → CLOSED, failure → OPEN again.
//
// We track multiple independent breakers keyed by provider name.
//
// Usage:
//   const result = await withBreaker('cloudflare', () => cf.chat(...));
//
// Failing fast:
//   When OPEN, calls throw { code: 'ERR_BREAKER_OPEN', status: 503 } immediately.
//   Callers (aiProvider) catch this and fall back to PEB.

const FAIL_THRESHOLD = parseInt(process.env.BREAKER_FAIL_THRESHOLD || '5', 10);
const WINDOW_MS      = parseInt(process.env.BREAKER_WINDOW_MS      || '60000', 10);   // count window
const COOLDOWN_MS    = parseInt(process.env.BREAKER_COOLDOWN_MS    || '30000', 10);   // open → half-open
const HALF_OPEN_PROBES = parseInt(process.env.BREAKER_HALF_OPEN_PROBES || '1', 10);

// breakers: Map<name, state>
const breakers = new Map();

function getBreaker(name) {
  if (!breakers.has(name)) {
    breakers.set(name, {
      name,
      state: 'CLOSED',
      failures: [],             // timestamps of recent failures
      openedAt: 0,
      halfOpenInflight: 0,
      // Lifetime counters for observability
      totals: { calls: 0, failures: 0, opens: 0, short_circuits: 0, successes: 0 },
    });
  }
  return breakers.get(name);
}

function pruneFailures(b) {
  const cutoff = Date.now() - WINDOW_MS;
  b.failures = b.failures.filter(t => t > cutoff);
}

function recordFailure(b) {
  b.failures.push(Date.now());
  pruneFailures(b);
  b.totals.failures++;
  if (b.failures.length >= FAIL_THRESHOLD && b.state !== 'OPEN') {
    b.state = 'OPEN';
    b.openedAt = Date.now();
    b.totals.opens++;
    console.warn(`[breaker:${b.name}] tripped OPEN after ${b.failures.length} failures in ${WINDOW_MS}ms`);
  }
}

function recordSuccess(b) {
  b.totals.successes++;
  if (b.state === 'HALF_OPEN') {
    // Probe succeeded → close circuit
    b.state = 'CLOSED';
    b.failures = [];
    b.halfOpenInflight = 0;
    console.log(`[breaker:${b.name}] HALF_OPEN probe succeeded → CLOSED`);
  } else if (b.state === 'CLOSED') {
    // Slow drain of old failures even on success
    pruneFailures(b);
  }
}

function maybeTransitionToHalfOpen(b) {
  if (b.state === 'OPEN' && Date.now() - b.openedAt >= COOLDOWN_MS) {
    b.state = 'HALF_OPEN';
    b.halfOpenInflight = 0;
    console.log(`[breaker:${b.name}] cooldown elapsed → HALF_OPEN (probing)`);
  }
}

/**
 * Run `fn` through the breaker. Returns whatever fn returns.
 * Throws { code: 'ERR_BREAKER_OPEN', status: 503 } when the circuit is open.
 */
export async function withBreaker(name, fn) {
  const b = getBreaker(name);
  b.totals.calls++;
  maybeTransitionToHalfOpen(b);

  if (b.state === 'OPEN') {
    b.totals.short_circuits++;
    const err = new Error(`Circuit breaker open for "${name}"`);
    err.code = 'ERR_BREAKER_OPEN';
    err.status = 503;
    err.breaker = name;
    throw err;
  }

  if (b.state === 'HALF_OPEN') {
    if (b.halfOpenInflight >= HALF_OPEN_PROBES) {
      b.totals.short_circuits++;
      const err = new Error(`Circuit half-open, probe in flight for "${name}"`);
      err.code = 'ERR_BREAKER_OPEN';
      err.status = 503;
      err.breaker = name;
      throw err;
    }
    b.halfOpenInflight++;
  }

  try {
    const result = await fn();
    recordSuccess(b);
    return result;
  } catch (err) {
    // Only trip on real upstream/network failures, NOT auth/4xx errors that the
    // caller caused. We treat anything with status >= 500 OR transport errors.
    const isUpstreamFail = !err.status || err.status >= 500
      || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET'
      || err.cause?.code === 'ECONNREFUSED' || err.cause?.code === 'ETIMEDOUT';
    if (isUpstreamFail) recordFailure(b);
    // Decrement half-open in-flight count regardless
    if (b.state === 'HALF_OPEN') b.halfOpenInflight = Math.max(0, b.halfOpenInflight - 1);
    throw err;
  }
}

export function getStats() {
  const out = {};
  for (const [name, b] of breakers) {
    pruneFailures(b);
    maybeTransitionToHalfOpen(b);
    out[name] = {
      state: b.state,
      recent_failures: b.failures.length,
      threshold: FAIL_THRESHOLD,
      window_ms: WINDOW_MS,
      cooldown_ms: COOLDOWN_MS,
      ms_until_half_open: b.state === 'OPEN' ? Math.max(0, COOLDOWN_MS - (Date.now() - b.openedAt)) : 0,
      half_open_inflight: b.halfOpenInflight,
      totals: { ...b.totals },
    };
  }
  return out;
}

export function reset(name) {
  if (name) {
    const b = breakers.get(name);
    if (!b) return false;
    b.state = 'CLOSED';
    b.failures = [];
    b.openedAt = 0;
    b.halfOpenInflight = 0;
    return true;
  }
  breakers.clear();
  return true;
}

export function isOpen(name) {
  const b = breakers.get(name);
  if (!b) return false;
  maybeTransitionToHalfOpen(b);
  return b.state === 'OPEN';
}
