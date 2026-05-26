import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import path from 'path';

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.CLOUDFLARE_S3_API,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_ACCESS_KEY,
  },
});

const BUCKET = process.env.CLOUDFLARE_BUCKET_NAME;
const DOC_PREFIX = 'suppabase-ai';

/**
 * Upload a buffer to R2.
 * @param {string} key   - Object key, e.g. "avatar/uuid.jpg"
 * @param {Buffer} buffer
 * @param {string} contentType
 */
export async function uploadToR2(key, buffer, contentType) {
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
}

/**
 * Delete an object from R2 by key. Silently ignores missing objects.
 * @param {string} key
 */
export async function deleteFromR2(key) {
  if (!key) return;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch {
    // ignore — object may not exist
  }
}

/**
 * Delete many objects in parallel. Returns count of successful deletes.
 */
export async function deleteManyFromR2(keys) {
  const valid = (keys || []).filter(Boolean);
  if (!valid.length) return 0;
  const results = await Promise.allSettled(valid.map(deleteFromR2));
  return results.filter((r) => r.status === 'fulfilled').length;
}

/**
 * Fetch an R2 object as a Buffer. Throws if missing.
 */
export async function fetchFromR2(key) {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Build the R2 object key for a chat attachment.
 * Layout: suppabase-ai/<userId>/<documentId>.<ext>
 */
export function r2KeyForDocument(userId, documentId, originalName) {
  const ext = (path.extname(originalName || '') || '').toLowerCase().replace(/[^.\w]/g, '');
  return `${DOC_PREFIX}/${userId}/${documentId}${ext}`;
}

/**
 * Derive the public URL for an R2 object.
 * Uses R2_PUBLIC_DOMAIN env (custom domain or r2.dev domain) when set,
 * otherwise falls back to the S3 API endpoint pattern.
 */
export function r2PublicUrl(key) {
  const base = (process.env.R2_PUBLIC_DOMAIN || process.env.CLOUDFLARE_S3_API).replace(/\/$/, '');
  return `${base}/${key}`;
}
