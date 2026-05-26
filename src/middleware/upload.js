import multer from 'multer';
import path from 'path';
import { fileTypeFromBuffer } from 'file-type';

// Unified attachment upload: images, PDFs, office docs, code/text — Claude-style
// "Attach" surface. Per-kind size limits enforced in validateFileSize below.

const IMAGE_MIMETYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
]);

const DOC_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
]);

const CODE_MIMETYPES = new Set([
  'application/json', 'application/xml', 'application/javascript',
  'application/typescript', 'application/x-yaml', 'application/x-sh',
  'application/x-python', 'application/x-sql',
]);

const CODE_EXTENSIONS = new Set([
  'vue', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh',
  'bash', 'zsh', 'sql', 'json', 'yaml', 'yml', 'toml', 'ini', 'env',
  'css', 'scss', 'sass', 'less', 'html', 'xml', 'md', 'mdx', 'tex', 'lua',
  'r', 'dart', 'scala', 'gradle', 'dockerfile', 'csv',
]);

function classify(file) {
  const mt = (file.mimetype || '').toLowerCase();
  const ext = (path.extname(file.originalname || '').slice(1) || '').toLowerCase();
  if (IMAGE_MIMETYPES.has(mt))       return 'image';
  if (mt === 'application/pdf')      return 'pdf';
  if (DOC_MIMETYPES.has(mt))         return 'document';
  if (CODE_MIMETYPES.has(mt))        return 'code';
  if (mt.startsWith('text/'))        return mt === 'text/plain' || mt === 'text/markdown' ? 'text' : 'code';
  if (CODE_EXTENSIONS.has(ext))      return 'code';
  return null;
}

// Per-kind size caps. Mirrors Claude's accepted attachment sizes scaled down a
// bit for our free-tier setup.
export const SIZE_LIMITS = {
  image:    5  * 1024 * 1024,
  pdf:      25 * 1024 * 1024,
  document: 10 * 1024 * 1024,
  code:     10 * 1024 * 1024,
  text:     10 * 1024 * 1024,
};

const ABSOLUTE_MAX = SIZE_LIMITS.pdf; // multer global cap

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ABSOLUTE_MAX },
  fileFilter: (req, file, cb) => {
    const kind = classify(file);
    if (kind) {
      file.kind = kind;
      cb(null, true);
    } else {
      cb(new Error(
        'File type not supported. Accepted: images (jpg/png/gif/webp/bmp), PDF, ' +
        'office documents (docx/xlsx/csv), and text/code files.',
      ));
    }
  },
}).single('file');

export function validateFileSize(req, res, next) {
  if (!req.file) return next();
  const kind = req.file.kind || classify(req.file) || 'document';
  req.file.kind = kind;
  const max = SIZE_LIMITS[kind] ?? SIZE_LIMITS.document;
  if (req.file.size > max) {
    const mb = Math.round(max / 1024 / 1024);
    return res.status(400).json({
      error: `File too large for ${kind}. Max size: ${mb}MB`,
      code: 'ERR_FILE_TOO_LARGE',
    });
  }
  next();
}

// Magic-byte verification — never trust the client-supplied mimetype.
// For binary kinds (image/pdf/document) the sniffed type MUST match the
// declared classification. Text/code files (csv, json, .py, ...) usually
// lack a magic signature so file-type returns nothing — we fall back to
// a UTF-8 decodability check and reject if the bytes contain NUL / non-text
// patterns (i.e. a binary masquerading as code).
const BINARY_KIND_WHITELIST = {
  image:    new Set(['jpg', 'png', 'gif', 'webp', 'bmp']),
  pdf:      new Set(['pdf']),
  document: new Set(['docx', 'xlsx', 'doc', 'xls', 'csv']),
};

function looksLikeText(buf) {
  // Reject if NUL byte in first 8KB — that's the strongest "this is binary" signal.
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head);
    return true;
  } catch {
    return false;
  }
}

export async function verifyFileMagic(req, res, next) {
  if (!req.file) return next();
  const { buffer, kind } = req.file;
  if (!buffer || !kind) {
    return res.status(400).json({ error: 'Invalid upload', code: 'ERR_UPLOAD' });
  }

  try {
    const sniffed = await fileTypeFromBuffer(buffer);

    if (kind === 'image' || kind === 'pdf' || kind === 'document') {
      if (kind === 'document' && !sniffed) {
        // CSV legitimately has no magic — accept only if it parses as text.
        if (!looksLikeText(buffer)) {
          return res.status(415).json({ error: 'File content does not match declared type', code: 'ERR_FILE_MIME_MISMATCH' });
        }
        // Lock down mime so downstream extractors don't pick a binary path.
        req.file.mimetype = 'text/csv';
        return next();
      }
      const allowed = BINARY_KIND_WHITELIST[kind];
      if (!sniffed || !allowed.has(sniffed.ext)) {
        return res.status(415).json({
          error: `File content does not match declared type (${kind})`,
          code: 'ERR_FILE_MIME_MISMATCH',
        });
      }
      // Pin the trusted mimetype from sniff result.
      req.file.mimetype = sniffed.mime;
      return next();
    }

    // code / text — no reliable magic. Reject if it's actually a binary
    // (e.g. someone renamed evil.exe to evil.js).
    if (sniffed) {
      return res.status(415).json({
        error: 'Binary content not allowed for text/code files',
        code: 'ERR_FILE_MIME_MISMATCH',
      });
    }
    if (!looksLikeText(buffer)) {
      return res.status(415).json({
        error: 'File does not appear to be valid text',
        code: 'ERR_FILE_MIME_MISMATCH',
      });
    }
    return next();
  } catch (err) {
    console.error('[upload] magic-byte verify failed:', err.message);
    return res.status(500).json({ error: 'Upload verification failed', code: 'ERR_UPLOAD' });
  }
}

export function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = Math.round(ABSOLUTE_MAX / 1024 / 1024);
      return res.status(400).json({ error: `File too large. Max size: ${mb}MB`, code: 'ERR_FILE_TOO_LARGE' });
    }
    return res.status(400).json({ error: err.message, code: 'ERR_UPLOAD' });
  }
  if (err) return res.status(400).json({ error: err.message, code: 'ERR_UPLOAD' });
  next();
}
