// Runs in a worker_thread so a pathological PDF (pdf-parse ReDoS, OOM, or
// infinite loop) can't pin the main event loop. parentPort receives a
// Buffer-like object; we respond with { text } or { error }.

import { parentPort } from 'worker_threads';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

parentPort.on('message', async (buf) => {
  try {
    const data = await pdfParse(Buffer.from(buf));
    parentPort.postMessage({ text: (data.text || '').trim() });
  } catch (err) {
    parentPort.postMessage({ error: err.message || 'pdf parse failed' });
  }
});
