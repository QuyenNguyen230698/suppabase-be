// pdf-parse runs in a worker_thread so a malformed/malicious PDF can't pin
// the main event loop. The extractorQueue layer applies an outer timeout
// (default 60s) — we also enforce a worker-level kill so a hung worker
// doesn't keep its memory pinned.
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const WORKER_KILL_MS = Number(process.env.PDF_WORKER_KILL_MS || 45000);
const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, 'pdfWorker.js');

function runInWorker(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { type: 'module' });
    const killer = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(Object.assign(new Error('PDF worker timed out'), { code: 'ERR_PDF_TIMEOUT' }));
    }, WORKER_KILL_MS);
    killer.unref?.();

    worker.once('message', (msg) => {
      clearTimeout(killer);
      worker.terminate().catch(() => {});
      if (msg?.error) reject(new Error(msg.error));
      else resolve(msg?.text || '');
    });
    worker.once('error', (err) => {
      clearTimeout(killer);
      worker.terminate().catch(() => {});
      reject(err);
    });
    worker.once('exit', (code) => {
      clearTimeout(killer);
      if (code !== 0) reject(new Error(`PDF worker exited with code ${code}`));
    });

    // Copy into a dedicated ArrayBuffer so we can transfer ownership
    // (Node Buffers share a pooled ArrayBuffer — transferring that would
    // detach other Buffers in the same process).
    const ab = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(ab).set(buffer);
    worker.postMessage(ab, [ab]);
  });
}

export async function extract(buffer) {
  let text;
  try {
    text = await runInWorker(buffer);
  } catch (err) {
    throw new Error(`Could not parse PDF: ${err.message}`);
  }
  if (!text || !text.trim()) {
    throw new Error('PDF has no extractable text (may be a scanned image-only PDF)');
  }
  return text;
}
