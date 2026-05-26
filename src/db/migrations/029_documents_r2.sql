-- Documents now live in Cloudflare R2 (bucket "suppabase", prefix "suppabase-ai/").
-- Add storage metadata so we can delete the R2 object on conversation/message
-- delete, expiry, or doc removal. `kind` lets us branch behaviour by attachment
-- type (image → vision, pdf/doc/code → RAG, text → RAG).

ALTER TABLE documents ADD COLUMN IF NOT EXISTS r2_key         TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS r2_public_url  TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS kind           TEXT;

-- Backfill `kind` for any pre-existing rows so old data renders correctly.
-- Heuristic: image MIME → 'image', pdf → 'pdf', everything else → 'document'.
UPDATE documents
   SET kind = CASE
     WHEN type LIKE 'image/%'             THEN 'image'
     WHEN type = 'application/pdf'        THEN 'pdf'
     WHEN type LIKE 'text/%'              THEN 'text'
     ELSE 'document'
   END
 WHERE kind IS NULL;

ALTER TABLE documents
  ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('image', 'pdf', 'document', 'code', 'text'));

CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents (kind);
