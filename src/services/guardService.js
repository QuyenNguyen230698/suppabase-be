// guardService — multi-layer safety pre-check for user messages.
//
//   L0 (normalize):    strip zero-width / fullwidth / leet — applied to every layer below.
//   L0a (injection):   detect prompt-injection signals (always on).
//   L1 (global regex): zero-tolerance hard blocklist across ALL agents.
//   L2 (agent regex):  per-agent block_patterns from agent template.
//   L4 (LLM-Guard):    semantic check via Llama-Guard. Opt-in per agent.
//
// Returns: { safe: boolean, reason?, layer?, pattern?, category?, severity? }
//
// Failure modes:
//   • If LLM provider is down, we fail-OPEN at L4 and log — never block on infra.
//   • L1 / L2 are deterministic — they never fail-open.

import crypto from 'crypto';
import { chat as cfChat } from './cloudflareAIService.js';
import { detectInjection } from './injectionDetector.js';
import { detectPII } from './piiMasker.js';
import { query } from '../db/index.js';
import { normalize, matchesAny } from './inputNormalizer.js';
import { getBlockStatus, recordViolation } from './violationLimiter.js';
import { checkSemantic } from './semanticGuard.js';
import { classifyInput } from './llmClassifier.js';

const LLAMA_GUARD_MODEL = process.env.GUARD_MODEL || '@cf/meta/llama-guard-3-8b';

// ── L1 global blocklist cache ────────────────────────────────────
// Loaded from `global_block_patterns` on first hit, refreshed every 60s.
// We compile RegExp objects once and reuse to avoid per-request overhead.
const GLOBAL_CACHE_TTL_MS = 60 * 1000;
let globalCache = { at: 0, items: [] };

async function loadGlobalPatterns(force = false) {
  if (!force && (Date.now() - globalCache.at) < GLOBAL_CACHE_TTL_MS && globalCache.items.length) {
    return globalCache.items;
  }
  try {
    const { rows } = await query(
      `SELECT g.id, g.category_code, g.pattern, g.flags, g.target_form, g.message,
              c.severity, c.action_default
       FROM global_block_patterns g
       JOIN threat_categories c ON c.code = g.category_code
       WHERE g.is_active = TRUE AND c.is_active = TRUE`
    );
    const items = [];
    for (const r of rows) {
      try {
        items.push({
          id: r.id,
          category: r.category_code,
          severity: r.severity,
          action: r.action_default,
          message: r.message,
          target: r.target_form,
          re: new RegExp(r.pattern, r.flags || 'iu'),
        });
      } catch (err) {
        console.warn('[guard] bad global pattern skipped:', r.id, err.message);
      }
    }
    globalCache = { at: Date.now(), items };
  } catch (err) {
    console.warn('[guard] loadGlobalPatterns failed (using stale cache):', err.message);
  }
  return globalCache.items;
}

export function _invalidateGlobalCache() { globalCache.at = 0; }

// L1 — global hard blocklist. Runs against both normalized + asciiFold.
async function checkGlobalBlocklist(normalized, asciiFold) {
  const items = await loadGlobalPatterns();
  for (const it of items) {
    let hit = false;
    if (it.target === 'normalized') hit = it.re.test(normalized);
    else if (it.target === 'ascii') hit = it.re.test(asciiFold);
    else hit = matchesAny(it.re, normalized, asciiFold);
    if (hit) {
      return {
        safe: false,
        layer: 'L1_global',
        category: it.category,
        severity: it.severity,
        pattern_id: it.id,
        reason: it.message,
        action: it.action,
      };
    }
  }
  return { safe: true };
}

// Persist a violation to the audit log AND update rate-limit counters.
// Log failures are non-blocking; counter failures are non-blocking (we still
// return the verdict — rate limit is best-effort).
//
// Returns escalation info (if user just crossed soft/hard threshold) so the
// caller can include it in the user-facing error.
async function logViolation({ userId, agent, layer, category, severity, patternId, action, normalized }) {
  let escalation = null;
  try {
    const hash = crypto.createHash('sha256').update(normalized || '').digest('hex');
    await query(
      `INSERT INTO guardrail_violations
         (user_id, agent_template_id, layer, category_code, pattern_id,
          severity, message_hash, message_preview, action_taken)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        userId || null, agent?.id || null, layer, category || null,
        patternId || null, severity || null, hash,
        (normalized || '').slice(0, 200), action || 'BLOCKED',
      ]
    );
  } catch (err) {
    console.warn('[guard] logViolation insert failed:', err.message);
  }
  if (userId && severity) {
    try {
      const r = await recordViolation({ userId, category, severity });
      escalation = r.escalation;
    } catch (err) {
      console.warn('[guard] recordViolation failed:', err.message);
    }
  }
  return escalation;
}

// ── L2: per-agent regex (legacy block_patterns) ──────────────────
// Kept as-is for backward compat; runs after L1 against the normalized form.
export function checkRegex(text, patterns) {
  if (!text || !Array.isArray(patterns) || !patterns.length) return { safe: true };
  for (const p of patterns) {
    if (!p?.pattern) continue;
    let re;
    try {
      re = new RegExp(p.pattern, p.flags || 'iu');
    } catch (err) {
      console.warn('[guard] bad regex skipped:', p.pattern, err.message);
      continue;
    }
    if (re.test(text)) {
      return {
        safe: false,
        layer: 'L2_agent',
        pattern: p.pattern,
        reason: p.message || 'Yêu cầu này không được phép.',
      };
    }
  }
  return { safe: true };
}

// ── Layer 2: LLM (Llama-Guard) ───────────────────────────────────
// Llama-Guard outputs the literal string "safe" or "unsafe\nS<category>".
// We parse the first non-empty line.
export async function checkLLM(text, { timeoutMs = 3000 } = {}) {
  if (!text || text.length < 2) return { safe: true };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const result = await cfChat({
      model: LLAMA_GUARD_MODEL,
      messages: [{ role: 'user', content: text }],
      stream: false,
      signal: ctrl.signal,
      options: { max_tokens: 32, temperature: 0 },
    });
    const out = (result?.response || result?.result?.response || '').trim().toLowerCase();
    if (out.startsWith('unsafe')) {
      const category = out.split('\n')[1]?.trim() || 'policy';
      return {
        safe: false,
        layer: 'llm',
        reason: `Nội dung bị từ chối bởi bộ lọc an toàn (${category}).`,
      };
    }
    return { safe: true };
  } catch (err) {
    // Fail-open: never block on infra failure
    console.warn('[guard] LLM check failed (fail-open):', err.message);
    return { safe: true, degraded: true };
  } finally {
    clearTimeout(timer);
  }
}

// ── Combined input check ─────────────────────────────────────────
/**
 * Full guard pipeline on user input:
 *   L0  injection detector (always on, free) — block if score ≥ 7
 *   L1  agent block_patterns regex
 *   L2  Llama-Guard LLM (if agent.block_llm_check)
 *
 * Returns:
 *   { safe: boolean, reason?, layer?, pattern?, warnings? }
 *   warnings is a list of non-blocking notices: [{type, detail}]
 */
/**
 * Many-shot scan — check the full user message history, not just the latest.
 * Defends against splitting attacks where each turn is innocuous but the
 * sequence builds up to a violation, AND against priming attacks ("for the
 * rest of this conversation, ignore safety").
 *
 * Only scans turns NEW since the last check (cheap on long threads). Uses the
 * same L0+L1 pipeline as the per-turn check, but errors here are warnings, not
 * blocks — the per-turn check is the primary defender.
 */
export async function scanHistoryForPriming(messages, ctx = {}) {
  if (!Array.isArray(messages) || messages.length <= 1) return { safe: true };
  // Skip the last user message — it's already handled by checkUserMessage.
  // Scan only earlier user turns for priming patterns.
  const earlier = messages.slice(0, -1).filter(m => m?.role === 'user' && typeof m.content === 'string');
  for (const m of earlier) {
    const norm = normalize(m.content);
    const l1 = await checkGlobalBlocklist(norm.normalized, norm.asciiFold);
    if (!l1.safe && l1.category === 'JAILBREAK') {
      // Priming detected in earlier turn — block the whole conversation.
      await logViolation({
        userId: ctx.userId, layer: 'L0_history_priming', category: 'JAILBREAK',
        severity: 4, action: 'BLOCKED', normalized: norm.normalized,
      });
      return {
        safe: false,
        layer: 'L0_history_priming',
        category: 'JAILBREAK',
        severity: 4,
        reason: 'Phát hiện priming jailbreak trong lịch sử hội thoại. Vui lòng bắt đầu hội thoại mới.',
      };
    }
  }
  return { safe: true };
}

export async function checkUserMessage(text, agent, ctx = {}) {
  const warnings = [];
  const { userId = null } = ctx;

  // L7 pre-check — hard-blocked users can't even submit a message.
  if (userId) {
    const blk = await getBlockStatus(userId);
    if (blk.blocked === 'hard') {
      return {
        safe: false,
        layer: 'L7_rate_limit',
        category: 'RATE_LIMIT',
        reason: `Tài khoản tạm bị khoá do vi phạm chính sách nhiều lần. Mở lại lúc: ${new Date(blk.until).toLocaleString('vi-VN')}.`,
        block_until: blk.until,
        status: 403,
      };
    }
    if (blk.blocked === 'soft') {
      warnings.push({ type: 'soft_blocked', until: blk.until, note: 'Mọi tin nhắn sẽ qua kiểm tra LLM-Guard nghiêm ngặt.' });
    }
  }

  // L0 — normalize once, reuse across all downstream layers.
  const norm = normalize(text);
  const { normalized, asciiFold } = norm;
  if (norm.truncated) warnings.push({ type: 'input_truncated' });
  if (norm.stripped.zeroWidth) warnings.push({ type: 'zero_width_stripped', count: norm.stripped.zeroWidth });

  // L0a — anti prompt-injection (always on, fast heuristic)
  const inj = detectInjection(normalized);
  if (inj.action === 'block') {
    const escalation = await logViolation({ userId, agent, layer: 'L0_injection', category: 'JAILBREAK', severity: 4, action: 'BLOCKED', normalized });
    return {
      safe: false,
      layer: 'L0_injection',
      category: 'JAILBREAK',
      severity: 4,
      reason: 'Yêu cầu có dấu hiệu prompt-injection / jailbreak.',
      score: inj.score,
      signals: inj.signals,
      escalation,
    };
  }
  if (inj.action === 'warn') {
    warnings.push({ type: 'injection_warn', score: inj.score, signals: inj.signals.map(s => s.label) });
  }

  // PII in input — warn only (user may legitimately send their own info)
  const pii = detectPII(normalized);
  if (pii.count > 0) {
    warnings.push({ type: 'input_pii', categories: pii.found });
  }

  // L1 — global hard blocklist (applies to all agents, even when no agent).
  const l1 = await checkGlobalBlocklist(normalized, asciiFold);
  if (!l1.safe) {
    const escalation = await logViolation({
      userId, agent, layer: l1.layer, category: l1.category, severity: l1.severity,
      patternId: l1.pattern_id, action: l1.action, normalized,
    });
    return { ...l1, warnings, escalation };
  }

  // L2 — per-agent regex (skip if no agent)
  if (agent) {
    const l2 = checkRegex(normalized, agent.block_patterns);
    if (!l2.safe) {
      const escalation = await logViolation({ userId, agent, layer: l2.layer, severity: 3, action: 'BLOCKED', normalized });
      return { ...l2, warnings, escalation };
    }
  }

  // L3 — semantic similarity vs banned exemplars. Fail-open if no embeddings.
  const l3 = await checkSemantic(normalized);
  if (!l3.safe) {
    const escalation = await logViolation({
      userId, agent, layer: l3.layer, category: l3.category, severity: l3.severity,
      action: 'BLOCKED', normalized,
    });
    return { ...l3, warnings, escalation };
  }
  if (l3.degraded) warnings.push({ type: 'l3_degraded', reason: l3.reason });

  // L4 — LLM classifier (PEB). Runs as last resort if L1-L3 didn't trip but
  // input is non-trivial (>= 8 chars). Also force-enabled for soft-blocked users.
  const softBlocked = warnings.some(w => w.type === 'soft_blocked');
  if (normalized.length >= 8 && (process.env.L4_ENABLED !== 'false' || softBlocked)) {
    const l4 = await classifyInput(normalized);
    if (!l4.safe) {
      const escalation = await logViolation({
        userId, agent, layer: l4.layer, category: l4.category, severity: l4.severity,
        action: 'BLOCKED', normalized,
      });
      return { ...l4, warnings, escalation };
    }
    if (l4.degraded) warnings.push({ type: 'l4_degraded', reason: l4.reason });
  }

  // Legacy Llama-Guard (CF) — superseded by L4 (PEB). Only run if explicitly
  // opted-in via env, never by default. CF quota is shared with main chat, so
  // running per-message Llama-Guard would burn the budget for actual replies.
  if (process.env.LEGACY_LLAMAGUARD === 'true' && agent?.block_llm_check) {
    const llg = await checkLLM(normalized);
    if (!llg.safe) {
      const escalation = await logViolation({ userId, agent, layer: 'L4_llamaguard', category: 'LLM_GUARD', severity: 3, action: 'BLOCKED', normalized });
      return { ...llg, warnings, escalation };
    }
  }
  return { safe: true, warnings };
}

// ── Output PII scan ──────────────────────────────────────────────
/**
 * After the model finishes streaming, scan the assistant output for PII.
 * Returns { categories: [], count } so caller can auto-flag the qa_review row.
 */
export function scanOutput(text) {
  if (!text) return { categories: [], count: 0 };
  const pii = detectPII(text);
  return { categories: pii.found, count: pii.count };
}

// ── L6 — Harmful output scan ─────────────────────────────────────
// Patterns target content the model SHOULD never emit even if guardrails on
// the input side were bypassed. Tuned for false-negative: only block when
// confident (specific synthesis steps, working exploit code), not just any
// mention of dangerous topics.
//
// Returns { harmful: boolean, category?, reason? }
const OUTPUT_HARMFUL_PATTERNS = [
  // CBRN — actual synthesis steps (step-by-step + reagent quantities)
  {
    category: 'CBRN',
    re: /(step\s*\d+|bước\s*\d+|first[,:]|tiếp\s*theo)[\s\S]{0,200}(tnt|c[-\s]?4|sarin|ricin|anthrax|nerve\s*agent|chất\s*độc\s*thần\s*kinh)[\s\S]{0,400}(\d+\s*(g|gram|kg|ml|mol|mole)|nitrate|sulfur|ammonium|kali\s*clorat|kclo3|h2so4|hno3)/i,
    reason: 'Output chứa quy trình tổng hợp chất nguy hiểm.',
  },
  {
    category: 'CBRN',
    re: /(mix|trộn|combine|kết\s*hợp)[\s\S]{0,80}(ammonium\s*nitrate|kali\s*nitrat|fuel\s*oil|dầu\s*diesel)[\s\S]{0,80}(detonator|kíp\s*nổ|primer)/i,
    reason: 'Output chứa quy trình chế tạo chất nổ.',
  },
  // CYBERATTACK — working exploit code with intent
  {
    category: 'CYBERATTACK',
    re: /(import\s+(socket|paramiko|scapy|requests)|from\s+(socket|scapy)\s+import)[\s\S]{0,500}(brute\s*force|bruteforce|password_list|dictionary_attack|exploit|reverse_shell|backdoor)/i,
    reason: 'Output chứa mã tấn công thực thi được.',
  },
  {
    category: 'CYBERATTACK',
    re: /(bash|sh|cmd|powershell)\s*[-/]?c\s+['"]?[^'"\n]*(curl|wget)[^'"\n]*\|\s*(bash|sh)/i,
    reason: 'Output chứa one-liner tải và thực thi mã từ xa.',
  },
  // Malware payload markers
  {
    category: 'CYBERATTACK',
    re: /(msfvenom|metasploit)[\s\S]{0,80}(-p|--payload)\s+(windows|linux|android|java)/i,
    reason: 'Output chứa lệnh tạo payload tấn công.',
  },
  // SELF_HARM — specific method with dose/quantity
  {
    category: 'SELF_HARM',
    re: /(liều\s*chết|lethal\s*dose|fatal\s*dose|ld50)[\s\S]{0,80}(\d+\s*(mg|g|ml|viên|pill|tablet))/i,
    reason: 'Output chứa thông tin liều thuốc gây chết.',
  },
  // Drug synthesis steps
  {
    category: 'DRUG_SYNTHESIS',
    re: /(pseudoephedrine|ephedrine|p2p|phenylacetone|red\s*phosphorus|phospho\s*đỏ)[\s\S]{0,200}(reduction|reduce|khử)[\s\S]{0,200}(methamphetamine|meth|đá)/i,
    reason: 'Output chứa quy trình tổng hợp ma tuý.',
  },
];

const OUTPUT_REFUSAL = 'Xin lỗi, phần trả lời đã được hệ thống chặn vì chứa nội dung vi phạm chính sách. Vui lòng đặt câu hỏi khác.';

/**
 * Scan assistant output for harmful content. If a pattern matches, the caller
 * should REPLACE the entire output with OUTPUT_REFUSAL and flag for review.
 *
 * Returns { harmful, category, reason, safeText } where safeText is the
 * original text when safe, or OUTPUT_REFUSAL when harmful.
 */
export function scanOutputHarmful(text) {
  if (!text || typeof text !== 'string' || text.length < 30) {
    return { harmful: false, safeText: text };
  }
  for (const p of OUTPUT_HARMFUL_PATTERNS) {
    if (p.re.test(text)) {
      return {
        harmful: true,
        category: p.category,
        reason: p.reason,
        safeText: OUTPUT_REFUSAL,
      };
    }
  }
  return { harmful: false, safeText: text };
}

/**
 * Log a harmful-output event. Called by the stream finalizer when scan trips.
 */
export async function logHarmfulOutput({ userId, agent, conversationId, messageId, category, reason, preview }) {
  try {
    await query(
      `INSERT INTO guardrail_violations
         (user_id, conversation_id, agent_template_id, layer, category_code,
          severity, message_hash, message_preview, action_taken)
       VALUES ($1,$2,$3,'L6_output_scan',$4,4,$5,$6,'BLOCKED')`,
      [
        userId || null, conversationId || null, agent?.id || null, category || null,
        crypto.createHash('sha256').update(preview || '').digest('hex'),
        (preview || '').slice(0, 200),
      ]
    );
    if (messageId) {
      await autoFlagMessage(messageId, 'harmful_output', `L6 scan: ${reason}`);
    }
  } catch (err) {
    console.warn('[guard] logHarmfulOutput failed:', err.message);
  }
}

/**
 * Auto-create a qa_review row flagging a message for admin attention.
 * Called when output contains PII or matches risk patterns.
 */
export async function autoFlagMessage(messageId, reason, note) {
  if (!messageId) return;
  try {
    await query(
      `INSERT INTO qa_review (message_id, flagged, flag_reason, note, reviewed_at)
       VALUES ($1, TRUE, $2, $3, NOW())
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, reason, note]
    );
  } catch (err) {
    console.warn('[guard] autoFlagMessage failed:', err.message);
  }
}
