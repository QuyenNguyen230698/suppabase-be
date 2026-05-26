-- ============================================================
-- 031_agent_templates.sql
-- User-selectable AI agent profiles managed via admin CMS.
-- Each template = persona prompt + a list of rules (soft, hard-regex, hard-llm).
-- User picks a template when starting a new conversation; rules are injected
-- before each user message reaches the model.
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_templates (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug            VARCHAR(64) UNIQUE NOT NULL,
  name            VARCHAR(120) NOT NULL,
  description     TEXT,
  icon            VARCHAR(40),
  category        VARCHAR(40) NOT NULL DEFAULT 'general',
  -- Persona / system prompt for this agent
  system_prompt   TEXT NOT NULL,
  -- Soft rules — appended into system prompt verbatim
  -- Shape: [{ id, text, severity: 'soft' | 'block_regex' | 'block_llm' }]
  rules           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Layer-1 block patterns: [{ pattern, flags?, message? }]
  block_patterns  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Layer-2 LLM safety pre-check toggle
  block_llm_check BOOLEAN NOT NULL DEFAULT FALSE,
  fallback_response TEXT,
  locale          VARCHAR(10) DEFAULT 'vi',
  temperature     NUMERIC(3,2) DEFAULT 0.7,
  max_tokens      INT DEFAULT 4096,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'global' (super_admin only) | 'org' (admin within org_node) | 'private'
  visibility      VARCHAR(20) NOT NULL DEFAULT 'org',
  org_node_id     UUID REFERENCES org_nodes(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  usage_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_templates_active
  ON agent_templates(is_active, category);
CREATE INDEX IF NOT EXISTS idx_agent_templates_visibility
  ON agent_templates(visibility, org_node_id);

-- Only one default at a time (enforced via partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_templates_default
  ON agent_templates((1)) WHERE is_default = TRUE;

-- Link conversation ↔ agent in use
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS agent_template_id UUID
  REFERENCES agent_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_agent_template
  ON conversations(agent_template_id);
