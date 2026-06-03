# PaddleOCR sidecar for the OCR ingestion core.
# Build:  docker build -t suppabase-paddleocr infra/paddleocr
# Run:    docker run -p 8900:8900 suppabase-paddleocr
# Wire:   set PADDLE_OCR_URL=http://<host>:8900 in the Node service env.

FROM python:3.10-slim

# PaddleOCR/OpenCV runtime libs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8900
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8900"]
