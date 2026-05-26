-- ============================================================
-- 020_projects.sql
-- Projects (claude.ai concept):
--   • Group conversations + pinned documents under a named context.
--   • custom_instructions are appended to the system prompt when
--     a conversation belongs to this project.
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
  id                    UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  VARCHAR(120) NOT NULL,
  description           TEXT,
  custom_instructions   TEXT,
  color                 VARCHAR(20) DEFAULT 'indigo',
  icon                  VARCHAR(30),
  is_archived           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, is_archived);

-- Add FK now that the table exists (deferred from 018).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_conversations_project'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT fk_conversations_project
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
  END IF;
END$$;

-- Pin documents to a project (knowledge base scoped per project)
CREATE TABLE IF NOT EXISTS project_documents (
  project_id   UUID NOT NULL REFERENCES projects(id)  ON DELETE CASCADE,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  pinned_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (project_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_project_documents_doc ON project_documents(document_id);
