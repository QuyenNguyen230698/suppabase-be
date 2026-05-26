import { extractTextFromImage } from '../ocrService.js';

export async function extract(buffer) {
  const text = await extractTextFromImage(buffer);
  if (!text || text.trim().length < 5) {
    throw new Error('OCR could not extract readable text from this image.');
  }
  return text;
}
