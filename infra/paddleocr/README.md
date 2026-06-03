# PaddleOCR sidecar

Accurate OCR for the OCR ingestion core (`src/services/ingest/cores/ocrCore.js`).
PaddleOCR runs **before** the vision LLM because its printed-character/number
accuracy is higher — critical for invoice financial data.

## Contract

```
POST /ocr   multipart: file=<image bytes>
200 → {
  "text": "full text, newline-joined",
  "lines": [{ "text": "...", "confidence": 0.98, "box": [[x,y],...] }],
  "mean_confidence": 0.95
}
GET /health → { "ok": true }
```

This is exactly what `src/services/ingest/paddleClient.js` expects.

## Run

### Docker (recommended)
```bash
docker build -t suppabase-paddleocr infra/paddleocr
docker run -p 8900:8900 suppabase-paddleocr
```

### Local Python
```bash
cd infra/paddleocr
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8900
```

## Wire into the Node service

Set in `.env.*`:
```
PADDLE_OCR_URL=http://localhost:8900
PADDLE_OCR_TIMEOUT_MS=30000   # optional
```

If `PADDLE_OCR_URL` is unset or the sidecar is unreachable, the OCR core throws
and the ingest worker retries → dead-letters (PaddleOCR is **required** for the
invoice path; we never silently fall back to vision-only on financial data).

## Notes
- `lang="en"` covers Latin scripts + digits. Add/switch languages in `app.py`
  (`PaddleOCR(lang=...)`) for other locales.
- PDFs: this sidecar decodes a single image. Render PDF pages to images upstream
  (or extend `app.py` with `pdf2image`) before sending multi-page PDFs.
- First request is slow (model download/warm-up); subsequent calls are fast.
