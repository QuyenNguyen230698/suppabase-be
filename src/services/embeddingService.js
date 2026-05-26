import { embed } from './aiProvider.js';

export const EMBED_MODEL_TAG = process.env.EMBED_MODEL || '@cf/baai/bge-m3';
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

export async function generateEmbedding(text) {
  return embed(text);
}

export function chunkText(text) {
  if (!text || !text.trim()) return [];

  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const sentences = normalized.split(/(?<=[.!?])\s+/);

  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? current + ' ' + sentence : sentence;
    if (candidate.split(/\s+/).length > CHUNK_SIZE && current) {
      chunks.push(current.trim());
      const words = current.split(/\s+/);
      current = words.slice(-CHUNK_OVERLAP).join(' ') + ' ' + sentence;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter((c) => c.length > 20);
}
