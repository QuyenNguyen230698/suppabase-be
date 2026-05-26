-- ============================================================
-- 017_module_icons.sql
-- Seed icon SVG paths into modules.icon so FE can drop the
-- MODULE_META hard-coded icon map. Each value is the inner SVG
-- markup intended to be placed inside <svg viewBox="0 0 24 24">.
-- ============================================================

UPDATE modules SET icon = '<path d="M21 12a8 8 0 0 1-11.3 7.3L4 21l1.7-5.7A8 8 0 1 1 21 12z"/>'
WHERE id = 'chat' AND (icon IS NULL OR icon = '');

UPDATE modules SET icon = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
WHERE id = 'pro_plan' AND (icon IS NULL OR icon = '');

UPDATE modules SET icon = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
WHERE id = 'documents' AND (icon IS NULL OR icon = '');

UPDATE modules SET icon = '<circle cx="9" cy="9" r="5"/><path d="m14 14 7 7M14 9h7M17.5 5.5v7"/>'
WHERE id = 'api_tokens' AND (icon IS NULL OR icon = '');

UPDATE modules SET icon = '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'
WHERE id = 'permissions' AND (icon IS NULL OR icon = '');
