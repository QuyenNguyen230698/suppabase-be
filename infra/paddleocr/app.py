"""PaddleOCR sidecar — accurate text extraction for the OCR ingestion core.

The Node OCR core (src/services/ingest/cores/ocrCore.js) calls this BEFORE the
vision LLM because PaddleOCR reads printed numbers/characters more accurately
than a vision model, which matters for invoice financial data.

Contract (paddleClient.js expects exactly this):
    POST /ocr   multipart form field "file" = image or single-page rendered bytes
    200 → { "text": str, "lines": [{ "text", "confidence", "box" }], "mean_confidence": float }

Run locally:
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 8900
Then point the Node service at it:
    PADDLE_OCR_URL=http://localhost:8900
"""

from io import BytesIO

import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from PIL import Image
from paddleocr import PaddleOCR

app = FastAPI(title="paddleocr-sidecar")

# lang="en" handles Latin scripts + digits well; switch/add for other locales.
# use_angle_cls fixes rotated scans. Loaded once at startup (heavy).
_ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)


def _load_image(raw: bytes) -> np.ndarray:
    try:
        img = Image.open(BytesIO(raw)).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"cannot decode image: {exc}")
    return np.array(img)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ocr")
async def ocr(file: UploadFile = File(...)):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")

    image = _load_image(raw)
    result = _ocr.ocr(image, cls=True)

    lines = []
    confs = []
    # PaddleOCR returns [[ [box, (text, conf)], ... ]] (one list per page/image).
    for page in result or []:
        for entry in page or []:
            box, (text, conf) = entry[0], entry[1]
            lines.append({"text": text, "confidence": float(conf), "box": box})
            confs.append(float(conf))

    return {
        "text": "\n".join(li["text"] for li in lines),
        "lines": lines,
        "mean_confidence": (sum(confs) / len(confs)) if confs else None,
    }
