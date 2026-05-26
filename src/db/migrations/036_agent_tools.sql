-- ============================================================
-- 036_agent_tools.sql
-- Per-agent tool allowlist for OpenAI-compatible function calling.
-- ============================================================

ALTER TABLE agent_templates
  ADD COLUMN IF NOT EXISTS allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Seed: enable relevant tools for starter agents
UPDATE agent_templates SET allowed_tools = '["search_documents","get_current_time"]'::jsonb
  WHERE slug = 'doc-reader';

UPDATE agent_templates SET allowed_tools = '["calculator","get_current_time"]'::jsonb
  WHERE slug = 'code-writer';

UPDATE agent_templates SET allowed_tools = '["get_current_time"]'::jsonb
  WHERE slug = 'general';
