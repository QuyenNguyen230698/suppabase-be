import { extract as extractTxt } from './txtExtractor.js';
import { extract as extractDocx } from './docxExtractor.js';
import { extract as extractXlsx } from './xlsxExtractor.js';
import { extract as extractImage } from './imageExtractor.js';
import { extract as extractPdf } from './pdfExtractor.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);

// All text-based and code mimetypes — read as raw UTF-8
const TEXT_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/html', 'text/css', 'text/csv', 'text/xml',
  'application/json', 'application/xml', 'application/javascript', 'application/typescript',
  'application/x-yaml', 'application/x-sh', 'application/x-python', 'application/x-sql',
]);

export async function extractText(buffer, mimetype, kind) {
  // Code/text files often arrive as application/octet-stream (browser couldn't
  // identify) or with quirky x-* MIME types. `kind` is the classification done
  // by the upload middleware based on extension + MIME, so prefer it when set.
  if (kind === 'code' || kind === 'text') return extractTxt(buffer);

  if (TEXT_TYPES.has(mimetype) || mimetype.startsWith('text/')) return extractTxt(buffer);

  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimetype === 'application/msword'
  )
    return extractDocx(buffer);

  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimetype === 'application/vnd.ms-excel'
  )
    return extractXlsx(buffer);

  if (mimetype === 'application/pdf') return extractPdf(buffer);

  // Images go through vision chat, not RAG
  if (IMAGE_TYPES.has(mimetype)) return extractImage(buffer);

  throw new Error(`Unsupported file type: ${mimetype}`);
}
