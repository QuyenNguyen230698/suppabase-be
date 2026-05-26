ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS agent_template_id UUID NULL
    REFERENCES agent_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_agent
  ON messages(agent_template_id)
  WHERE agent_template_id IS NOT NULL;
