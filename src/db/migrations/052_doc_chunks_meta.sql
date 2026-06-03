-- ============================================================
-- 052_doc_chunks_meta.sql
-- Code-aware chunk metadata for the Text/Code core.
--
-- When the router sends a file to the code path, the core chunks by AST
-- (tree-sitter) along function/class boundaries instead of by sentence, and
-- prepends the parent signature/scope so each chunk is self-describing. These
-- columns let Search Core filter by language and show precise source locations
-- (path + line range) back to the user.
--
-- All nullable — plain text/image/pdf chunks simply leave them NULL, so this is
-- a pure additive change with no backfill needed.
-- ============================================================

ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS lang             VARCHAR(32);
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS symbol           TEXT;   -- function / class / method name
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS start_line       INT;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS end_line         INT;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS parent_signature TEXT;   -- enclosing scope prepended for context

CREATE INDEX IF NOT EXISTS idx_doc_chunks_lang
  ON document_chunks (lang) WHERE lang IS NOT NULL;
