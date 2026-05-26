// searchDocuments — RAG retrieval from user's documents.
// Reuses the existing ragService.similaritySearch.

import { similaritySearch, buildContext } from '../ragService.js';

export const schema = {
  name: 'search_documents',
  description: 'Search the user\'s uploaded documents for content relevant to a query. Returns top matching passages with document names. Use when the user asks about content they may have attached or uploaded.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language search query — what the user wants to know.',
      },
      top_k: {
        type: 'integer',
        description: 'Number of passages to return (default 5, max 10).',
      },
    },
    required: ['query'],
  },
};

export async function execute({ query, top_k }, ctx) {
  if (!query || typeof query !== 'string') {
    return { error: 'query required (string)' };
  }
  if (!ctx.userId) {
    return { error: 'authenticated user required' };
  }

  const k = Math.min(10, Math.max(1, Number(top_k) || 5));
  // ctx.docIds is the list attached to the current message; if null we search all
  // user's documents (similaritySearch handles both).
  try {
    const chunks = await similaritySearch(query, ctx.userId, ctx.docIds || null, k);
    if (!chunks?.length) {
      return { passages: [], context: '', message: 'No matching content found in user documents.' };
    }
    return {
      passages: chunks.map(c => ({
        document: c.document_name || c.name || 'unknown',
        excerpt: (c.content || '').slice(0, 500),
        score: c.score ?? null,
      })),
      context: buildContext(chunks),
    };
  } catch (err) {
    return { error: `Search failed: ${err.message}` };
  }
}
