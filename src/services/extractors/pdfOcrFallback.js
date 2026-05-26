// Fallback when a PDF has no extractable text layer (scanned documents,
// image-only exports). Pipeline:
//   1. Render each page to a PNG via pdfjs-dist + node-canvas.
//   2. Upload each page PNG to R2 under a temporary key.
//   3. Call Cloudflare vision-by-url with ALL page URLs in one request — the
//      model returns a structured OCR/description for each page.
//   4. Best-effort delete the temp pages from R2.
//
// Output: concatenated plain text per page, suitable for chunking + embedding
// like any regular PDF text extraction. Throws on empty result so the caller
// can mark the document with a clear error.

import crypto from 'crypto';
import { createCanvas } from 'canvas';
import { uploadToR2, deleteFromR2, r2PublicUrl } from '../r2Service.js';
import { visionByUrl } from '../aiProvider.js';

const MAX_PAGES = Number(process.env.PDF_OCR_MAX_PAGES || 20);
const RENDER_SCALE = Number(process.env.PDF_OCR_SCALE || 1.6); // 1.0 = 72dpi
const TMP_PREFIX = 'pdf-ocr-tmp';

// Render a single PDF page to PNG bytes.
async function renderPage(pdfDoc, pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas.toBuffer('image/png');
}

// Public entry. `buffer` is the raw PDF bytes. Returns extracted text.
export async function extractByOcr(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs-dist needs a fresh Uint8Array view it owns (it will transfer)
  const data = new Uint8Array(buffer.byteLength);
  data.set(buffer);

  const loadingTask = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  });
  const pdfDoc = await loadingTask.promise;
  const totalPages = Math.min(pdfDoc.numPages, MAX_PAGES);
  if (totalPages === 0) throw new Error('PDF has 0 pages');

  // Render + upload pages in parallel (capped concurrency to be polite to R2).
  const sessionId = crypto.randomBytes(8).toString('hex');
  const pageUploads = []; // { pageNum, key, url }
  const CONCURRENCY = 3;

  let cursor = 1;
  async function worker() {
    while (cursor <= totalPages) {
      const pageNum = cursor++;
      try {
        const png = await renderPage(pdfDoc, pageNum);
        const key = `${TMP_PREFIX}/${sessionId}/page-${String(pageNum).padStart(3, '0')}.png`;
        await uploadToR2(key, png, 'image/png');
        pageUploads.push({ pageNum, key, url: r2PublicUrl(key) });
      } catch (err) {
        console.warn(`[pdf-ocr] page ${pageNum} render/upload failed: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  pageUploads.sort((a, b) => a.pageNum - b.pageNum);

  if (!pageUploads.length) throw new Error('PDF OCR: no pages could be rendered');

  // Single vision call with all page URLs. Llama 4 Scout handles up to many
  // image_url parts in one request. Prompt asks for per-page text in order.
  const prompt =
    `This is a scanned PDF. For EACH of the ${pageUploads.length} pages (in the exact order given), extract all visible text VERBATIM, preserving line breaks, tables, lists, names, numbers, and dates. ` +
    `Format strictly as:\n=== PAGE 1 ===\n<text of page 1>\n=== PAGE 2 ===\n<text of page 2>\n... and so on. ` +
    `Do NOT add commentary or summary. If a page is blank, write "(blank page)".`;

  let visionText = '';
  try {
    const { content } = await visionByUrl({
      imageUrls: pageUploads.map((p) => p.url),
      prompt,
      options: { max_tokens: 4096 },
    });
    visionText = (content || '').trim();
  } catch (err) {
    // Clean up temp pages before bubbling up so we don't leak storage.
    await cleanup(pageUploads);
    throw new Error(`PDF OCR vision call failed: ${err.message}`);
  }

  // Best-effort cleanup (do NOT block on R2 errors)
  cleanup(pageUploads).catch(() => {});

  if (!visionText) throw new Error('PDF OCR: vision returned empty text');
  return visionText;
}

async function cleanup(pageUploads) {
  await Promise.all(
    pageUploads.map((p) =>
      deleteFromR2(p.key).catch((e) =>
        console.warn(`[pdf-ocr] cleanup failed for ${p.key}: ${e.message}`),
      ),
    ),
  );
}
