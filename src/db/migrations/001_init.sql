CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  title VARCHAR(255),
  model VARCHAR(100) NOT NULL,
  source VARCHAR(20) DEFAULT 'chat' CHECK (source IN ('chat', 'pro')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrate existing rows that may not have source column yet
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='conversations' AND column_name='source'
  ) THEN
    ALTER TABLE conversations ADD COLUMN source VARCHAR(20) DEFAULT 'chat' CHECK (source IN ('chat', 'pro'));
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  size_bytes INT NOT NULL,
  status VARCHAR(20) DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error')),
  error_msg TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(768),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  created_by VARCHAR NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_document ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_doc_chunks_embedding'
  ) THEN
    CREATE INDEX idx_doc_chunks_embedding ON document_chunks USING hnsw (embedding vector_cosine_ops);
  END IF;
END$$;
