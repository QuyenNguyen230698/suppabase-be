import { Router } from 'express';
import { searchDocuments, searchInvoiceDocs } from '../controllers/searchController.js';

// Knowledge-base search (Search Core) — over ingested document content, not
// chat history (that lives under /api/search/conversations|messages).
const router = Router();
router.get('/documents', searchDocuments);
router.get('/invoices', searchInvoiceDocs);
export default router;
