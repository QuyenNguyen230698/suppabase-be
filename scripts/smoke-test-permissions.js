#!/usr/bin/env node
// Smoke test: xác nhận moduleGuard enforce đúng action theo role × module.
// Chạy: node --env-file=.env.development scripts/smoke-test-permissions.js
//
// Yêu cầu: server đang chạy tại PORT (default 3045), seed users đã được tạo.

const BASE = `http://localhost:${process.env.PORT || 3045}`;

// ── Helpers ───────────────────────────────────────────────────

async function login(username, password = '123456') {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login failed for ${username}: ${res.status}`);
  const data = await res.json();
  return data.token || data.access_token;
}

async function req(method, path, token, body = null) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Multipart POST (simulate image upload cho pebChat)
async function postMultipart(path, token) {
  const { FormData, Blob } = await import('node:buffer').then(() => globalThis);
  const form = new FormData();
  form.append('message', 'test');
  form.append('image', new Blob(['fake'], { type: 'image/png' }), 'test.png');
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ── Assert helpers ────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label} → ${actual}`);
    passed++;
  } else {
    console.error(`  ✗ ${label} → got ${actual}, want ${expected}`);
    failed++;
  }
}

// ── Test cases ────────────────────────────────────────────────

async function run() {
  console.log(`\n=== Permission Smoke Test — ${BASE} ===\n`);

  // ── Login users ───────────────────────────────────────────
  // peb3 = bu_manager (pro_plan.create = none, pro_plan.view = none trong matrix)
  // peb1 = regional_admin (pro_plan.create = full)
  // peb9 = country_user  (chat.create = full, documents.upload = none)
  let bu_token, ra_token, cu_token;
  try {
    [bu_token, ra_token, cu_token] = await Promise.all([
      login('peb3'),
      login('peb1'),
      login('peb9'),
    ]);
    console.log('Logged in: bu_manager (peb3), regional_admin (peb1), country_user (peb9)\n');
  } catch (e) {
    console.error('Login failed:', e.message);
    console.error('Make sure server is running and seed users exist (node --env-file=.env.development scripts/seed-sample-users.js)');
    process.exit(1);
  }

  // ── 1. pebChat (module: pro_plan) ────────────────────────
  console.log('--- pro_plan module ---');

  // bu_manager: pro_plan.view = full (admin đã set override) → GET /conversations should 200
  {
    const r = await req('GET', '/api/chat/peb/conversations', bu_token);
    assert('bu_manager GET /api/chat/peb/conversations → 200 (override: view=full)', r.status, 200);
  }

  // bu_manager: pro_plan.create = none (override) → POST json should 403
  {
    const r = await req('POST', '/api/chat/peb', bu_token, { message: 'test' });
    assert('bu_manager POST /api/chat/peb (json) → 403 (create=none)', r.status, 403);
    assert('  error code ERR_PERMISSION_DENIED', r.body?.code, 'ERR_PERMISSION_DENIED');
  }

  // bu_manager: pro_plan.upload = none → POST multipart should 403 (bug fix check)
  {
    const r = await postMultipart('/api/chat/peb', bu_token);
    assert('bu_manager POST /api/chat/peb (multipart) → 403', r.status, 403);
  }

  // regional_admin: pro_plan.view = full → GET should pass (2xx or any non-403)
  {
    const r = await req('GET', '/api/chat/peb/conversations', ra_token);
    assert('regional_admin GET /api/chat/peb/conversations → 200', r.status, 200);
  }

  // ── 2. chat module ───────────────────────────────────────
  console.log('\n--- chat module ---');

  // country_user: chat.view = full → GET conversations ok
  {
    const r = await req('GET', '/api/chat/conversations', cu_token);
    assert('country_user GET /api/chat/conversations → 200', r.status, 200);
  }

  // country_user: chat.create = full → POST ok (controller may fail for other reasons, but not 403)
  {
    const r = await req('POST', '/api/chat', cu_token, { message: 'hi', model: 'test' });
    assert('country_user POST /api/chat → not 403', r.status !== 403, true);
  }

  // country_user: chat.delete = partial → DELETE ok (not 403)
  {
    const r = await req('DELETE', '/api/chat/conversations/00000000-0000-0000-0000-000000000000', cu_token);
    assert('country_user DELETE /api/chat/conversations/:id → not 403', r.status !== 403, true);
  }

  // ── 3. documents module ──────────────────────────────────
  console.log('\n--- documents module ---');

  // country_user: documents.view = partial → GET ok
  {
    const r = await req('GET', '/api/documents', cu_token);
    assert('country_user GET /api/documents → 200', r.status, 200);
  }

  // country_user: documents.upload = none → POST multipart /api/upload should 403
  {
    const r = await postMultipart('/api/upload', cu_token);
    assert('country_user POST /api/upload (multipart) → 403', r.status, 403);
  }

  // regional_admin: documents.upload = partial → POST multipart /api/upload should pass guard (not 403)
  {
    const r = await postMultipart('/api/upload', ra_token);
    assert('regional_admin POST /api/upload → not 403', r.status !== 403, true);
  }

  // ── 4. projects module ───────────────────────────────────
  console.log('\n--- projects module ---');

  // country_user: projects.view = full → GET ok
  {
    const r = await req('GET', '/api/projects', cu_token);
    assert('country_user GET /api/projects → 200', r.status, 200);
  }

  // country_user: projects.create = full → POST not 403
  {
    const r = await req('POST', '/api/projects', cu_token, { name: 'smoke-test' });
    assert('country_user POST /api/projects → not 403', r.status !== 403, true);
  }

  // ── Summary ───────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error('Unexpected error:', e); process.exit(1); });
