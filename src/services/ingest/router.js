// router — classify an uploaded document to the ingestion core that handles it.
//
// The upload middleware (middleware/upload.js → verifyFileMagic) has ALREADY
// sniffed the real type from magic bytes, pinned req.file.mimetype to the
// trusted value, and set req.file.kind. So the router does NOT re-sniff — it
// maps the trusted kind → core and records the routing decision on the
// documents row. If a kind can't be mapped (shouldn't happen post-middleware),
// the document is quarantined rather than silently dropped.
//
//   kind 'image'              → image core   (caption + OCR + embed)
//   kind 'pdf'                → ocr core     (PaddleOCR sidecar → vision → structure)
//   kind 'code'               → code core    (tree-sitter chunk)
//   kind 'document' | 'text'  → text core    (sentence chunk)
//
// PDFs go to the OCR core because the invoice/structured-extraction path lives
// there; a text-only PDF still flows through fine (OCR core falls back to its
// text layer). Refine pdf→{ocr|text} heuristics in PR5.

const KIND_TO_CORE = {
  image:    'image',
  pdf:      'ocr',
  code:     'code',
  document: 'text',
  text:     'text',
};

export function coreForKind(kind) {
  return KIND_TO_CORE[kind] || null;
}

// Returns { core, detectedMime, magicOk } for a verified upload. The buffer is
// accepted for future content-based refinement (e.g. invoice detection) but is
// not re-sniffed here — middleware already did the trusted sniff.
export function route({ kind, mimetype }) {
  const core = coreForKind(kind);
  return {
    core,                       // null → caller should quarantine
    detectedMime: mimetype || null,
    magicOk: core !== null,
  };
}
