-- 060_documents_type_widen.sql
-- Widen documents.type — it stored the file MIME but was VARCHAR(50), too small
-- for Office OOXML MIME types:
--   docx = application/vnd.openxmlformats-officedocument.wordprocessingml.document (71 chars)
--   xlsx = application/vnd.openxmlformats-officedocument.spreadsheetml.sheet      (65 chars)
-- Inserting either overflowed the column → "value too long" (SQLSTATE 22001),
-- which uploadController surfaced as a generic "Database error". So every docx/
-- xlsx upload failed at the INSERT while PDFs/images (short MIMEs) worked.
ALTER TABLE documents ALTER COLUMN type TYPE VARCHAR(255);
