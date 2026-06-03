-- ============================================================
-- 051_invoices.sql
-- OCR Core relational output. Unlike Image/Text/Code cores (which produce
-- vector chunks for RAG), the OCR core extracts STRUCTURED invoice data:
-- a header + line items, arithmetically validated (qty × unit_price = line_total,
-- Σ line_total = subtotal, etc).
--
-- Flow (services/ingest/cores/ocrCore.js):
--   PaddleOCR sidecar (text+boxes) → vision model (scout) → LLM structure (JSON)
--   → validate arithmetic → pass: review_status='auto_ok'
--                           → fail: review_status='needs_review' (human queue)
--
-- Numeric columns use NUMERIC (exact) — never float — because money must not
-- accumulate rounding error during validation.
-- ============================================================

CREATE TABLE IF NOT EXISTS invoices (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id       VARCHAR NOT NULL,
  vendor        TEXT,
  invoice_no    TEXT,
  issued_at     DATE,
  currency      VARCHAR(8),
  subtotal      NUMERIC(18, 2),
  tax           NUMERIC(18, 2),
  total         NUMERIC(18, 2),
  review_status TEXT NOT NULL DEFAULT 'needs_review'
                  CHECK (review_status IN ('auto_ok', 'needs_review', 'approved', 'rejected')),
  -- Per-field validation detail: which checks passed/failed, confidences, raw text.
  validation    JSONB,
  reviewed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_document ON invoices (document_id);
CREATE INDEX IF NOT EXISTS idx_invoices_user     ON invoices (user_id, created_at DESC);
-- Reviewer dashboard reads pending rows.
CREATE INDEX IF NOT EXISTS idx_invoices_review
  ON invoices (review_status) WHERE review_status = 'needs_review';

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id   UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no      INT  NOT NULL,
  description  TEXT,
  qty          NUMERIC(18, 4),
  unit_price   NUMERIC(18, 4),
  line_total   NUMERIC(18, 2),
  -- Did qty × unit_price reconcile with line_total (within tolerance)?
  calc_ok      BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice
  ON invoice_line_items (invoice_id, line_no);
