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

### Docker Compose (recommended — survives reboots/crashes)
```bash
cd infra/paddleocr
docker compose up -d --build
docker compose ps          # check status / health
docker compose logs -f     # watch model warm-up on first boot
```
`restart: unless-stopped` keeps the container running on its own, so it comes
back after a VPS reboot or crash without manual intervention.

### Docker (manual run)
```bash
docker build -t suppabase-paddleocr infra/paddleocr
docker run -d --restart=unless-stopped --name paddleocr -p 8900:8900 suppabase-paddleocr
```

### Local Python
```bash
cd infra/paddleocr
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8900
```

## PM2 vs. Docker — they are independent

The Node backend runs under **PM2**; PaddleOCR runs in **Docker**. They only
talk over HTTP (`paddleClient.js` → `POST :8900/ocr`):

- `pm2 restart` the backend → it reconnects to the already-running container
  instantly. It does **not** start/stop/restart the OCR container.
- If the container is stopped/crashed, OCR fails until it's running again — but
  with `restart: unless-stopped` it self-heals after crashes and reboots, so you
  shouldn't need to restart Docker by hand just because you restarted the BE.
- Pulling new BE code + `pm2 restart` does not rebuild the sidecar. Only run
  `docker compose up -d --build` again when you change files under
  `infra/paddleocr/`.

## Wire into the Node service

Set in `.env.*`:
```
PADDLE_OCR_URL=http://localhost:8900
PADDLE_OCR_TIMEOUT_MS=30000   # optional
```

If `PADDLE_OCR_URL` is **unset**, the OCR core skips OCR and extracts the PDF's
embedded text layer instead (pdf-parse) so normal text PDFs still become
searchable — only scanned/image-only PDFs need the sidecar. If the URL is **set
but unreachable**, the core throws and the worker retries → dead-letters (a
configured-but-down sidecar is an operational error, not a fallback case). The
structured-invoice path always requires PaddleOCR; we never fall back to
vision-only on financial data.

## Notes
- `lang="en"` covers Latin scripts + digits. Add/switch languages in `app.py`
  (`PaddleOCR(lang=...)`) for other locales.
- PDFs: this sidecar decodes a single image. Render PDF pages to images upstream
  (or extend `app.py` with `pdf2image`) before sending multi-page PDFs.
- First request is slow (model download/warm-up); subsequent calls are fast.
