// searchController — knowledge-base search endpoints (Search Core).
//   GET /api/search/documents  ?q=&core=&lang=&limit=   → ranked chunks
//   GET /api/search/invoices   ?q=&limit=                → structured invoices

import { searchChunks, searchInvoices } from '../services/aicore/searchCore.js';

export async function searchDocuments(req, res) {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'q is required', code: 'ERR_QUERY_REQUIRED' });
  try {
    const results = await searchChunks({
      userId: req.user.id,
      q,
      core: req.query.core ? String(req.query.core) : null,
      lang: req.query.lang ? String(req.query.lang) : null,
      limit: req.query.limit,
    });
    res.json({ query: q, count: results.length, results });
  } catch (err) {
    console.error('[search] documents error:', err.message);
    res.status(500).json({ error: 'Search failed', code: 'ERR_SEARCH' });
  }
}

export async function searchInvoiceDocs(req, res) {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'q is required', code: 'ERR_QUERY_REQUIRED' });
  try {
    const results = await searchInvoices({ userId: req.user.id, q, limit: req.query.limit });
    res.json({ query: q, count: results.length, results });
  } catch (err) {
    console.error('[search] invoices error:', err.message);
    res.status(500).json({ error: 'Search failed', code: 'ERR_SEARCH' });
  }
}
