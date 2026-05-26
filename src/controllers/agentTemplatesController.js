// agentTemplatesController — CRUD endpoints for agent templates.
//
// Authority rules:
//   • super_admin  → can do anything, set visibility='global'
//   • admin (lvl 2)→ can CRUD templates with visibility='org' tied to own org_node
//                    cannot set visibility='global' nor edit global templates
//   • user         → read-only via list endpoint (mounted separately)

import * as svc from '../services/agentTemplateService.js';

function isSuperAdmin(req)  { return req.user?.role === 'super_admin'; }
function isAdmin(req)       { return /admin/i.test(req.user?.role || ''); }

function badRequest(res, msg) { return res.status(400).json({ error: msg, code: 'ERR_BAD_INPUT' }); }
function notFound(res)        { return res.status(404).json({ error: 'Agent template not found', code: 'ERR_NOT_FOUND' }); }
function forbidden(res, msg)  { return res.status(403).json({ error: msg, code: 'ERR_FORBIDDEN' }); }

// Schema validation is now handled by Zod in routes (see schemas/agentTemplates.js).
// This controller assumes req.body has already been parsed + stripped.

function sanitizeForRole(body, req) {
  const out = { ...body };
  if (!isSuperAdmin(req)) {
    // admin cannot create/edit global templates
    if (out.visibility === 'global') out.visibility = 'org';
    out.org_node_id = req.user?.org_node_id || null;
  }
  return out;
}

// ── Endpoints ────────────────────────────────────────────────────

export async function list(req, res) {
  try {
    const rows = await svc.listVisible({
      user: req.user,
      category: req.query.category || null,
      includeInactive: req.query.include_inactive === '1' && isAdmin(req),
    });
    res.json({ items: rows });
  } catch (err) {
    console.error('[agentTemplates] list:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

export async function getOne(req, res) {
  try {
    const row = await svc.getById(req.params.id);
    if (!row) return notFound(res);
    res.json(row);
  } catch (err) {
    console.error('[agentTemplates] getOne:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

export async function create(req, res) {
  try {
    const payload = sanitizeForRole(req.body, req);
    const row = await svc.create(payload, req.user.id);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Slug already exists', code: 'ERR_DUPLICATE' });
    console.error('[agentTemplates] create:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

export async function update(req, res) {
  try {
    const existing = await svc.getById(req.params.id);
    if (!existing) return notFound(res);

    // Admin cannot edit global templates
    if (!isSuperAdmin(req) && existing.visibility === 'global') {
      return forbidden(res, 'Only super admin can edit global templates');
    }
    // Admin cannot edit templates of another org
    if (!isSuperAdmin(req) && existing.org_node_id && existing.org_node_id !== req.user?.org_node_id) {
      return forbidden(res, 'Cannot edit template of another org');
    }

    const payload = sanitizeForRole(req.body, req);
    const row = await svc.update(req.params.id, payload);
    res.json(row);
  } catch (err) {
    console.error('[agentTemplates] update:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

export async function remove(req, res) {
  try {
    const existing = await svc.getById(req.params.id);
    if (!existing) return notFound(res);
    if (existing.is_default) return badRequest(res, 'Cannot delete the default template — set another as default first');
    if (!isSuperAdmin(req) && existing.visibility === 'global') {
      return forbidden(res, 'Only super admin can delete global templates');
    }
    const ok = await svc.remove(req.params.id);
    if (!ok) return notFound(res);
    res.status(204).end();
  } catch (err) {
    console.error('[agentTemplates] remove:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

export async function setDefault(req, res) {
  if (!isSuperAdmin(req)) return forbidden(res, 'Only super admin can change the default template');
  try {
    const row = await svc.setDefault(req.params.id);
    if (!row) return notFound(res);
    res.json(row);
  } catch (err) {
    console.error('[agentTemplates] setDefault:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}
