// streamParser — parse an upstream LLM stream into unified SSE events on a sink.
//
// Ported verbatim from the legacy chatCore.createStreamParser; the only change
// is res → sink (sink.emit replaces writeSse). Handles three on-the-wire shapes:
//   (a) Ollama NDJSON:   { message: { content, thinking? }, done? }
//   (b) OpenAI SSE:      data: { choices: [{ delta: { content, thinking? }, finish_reason? }] }
//   (c) Inline <think>:  content begins with "<think>...</think>" (older r1 models)
//
// Emits: thinking_delta, thinking, chunk, (done handled by caller via onDone).

// Race a promise against a timeout — bail when upstream stalls mid-stream.
export function withTimeout(promise, ms, label = 'op') {
  let to;
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'ERR_STREAM_TIMEOUT';
      reject(err);
    }, ms);
    to.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(to));
}

export const STREAM_READ_TIMEOUT_MS = 30000;
export const STREAM_BUFFER_MAX_BYTES = 1024 * 1024; // 1MB

export function createStreamParser(sink) {
  let fullContent = '';
  let fullThinking = '';
  let tokensIn = null;
  let tokensOut = null;

  let thinkBuf = '';
  let inThink = false;
  let thinkEmitted = false;

  function summary() {
    return { content: fullContent, reasoning: fullThinking || null, tokensIn, tokensOut };
  }

  // Flush any content held back in thinkBuf (the lookahead buffer keeps up to 6
  // chars in case a "<think" tag is starting). Must run before onDone so a
  // stream that ends mid-buffer (e.g. short reply, done arrives immediately
  // after the last token) doesn't drop its tail.
  function flushTail() {
    // A single token may carry "<think>…</think>answer" all at once; the opener
    // branch returns early after stripping "<think>", leaving the closer + tail
    // unparsed in thinkBuf. If the stream ends here, resolve it now.
    if (inThink && thinkBuf.includes('</think>')) {
      handleContentToken('');           // no new token; re-run closer logic
    }
    if (thinkBuf && !inThink) {
      fullContent += thinkBuf;
      sink.emit({ type: 'chunk', content: thinkBuf });
      thinkBuf = '';
    }
  }

  async function feed(reader, onDone) {
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await withTimeout(reader.read(), STREAM_READ_TIMEOUT_MS, 'upstream_read');
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > STREAM_BUFFER_MAX_BYTES) {
        const err = new Error('Upstream line exceeded buffer cap');
        err.code = 'ERR_STREAM_BUFFER_OVERFLOW';
        throw err;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;

        let payload = line;
        if (payload.startsWith('data: ')) payload = payload.slice(6);
        if (payload === '[DONE]') { flushTail(); await onDone(summary()); return; }

        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }

        if (typeof chunk.prompt_eval_count === 'number') tokensIn = chunk.prompt_eval_count;
        if (typeof chunk.eval_count === 'number') tokensOut = chunk.eval_count;
        if (chunk.usage?.prompt_tokens) tokensIn = chunk.usage.prompt_tokens;
        if (chunk.usage?.completion_tokens) tokensOut = chunk.usage.completion_tokens;

        const thinkTok = chunk.message?.thinking
          ?? chunk.choices?.[0]?.delta?.thinking
          ?? chunk.choices?.[0]?.delta?.reasoning_content
          ?? chunk.reasoning_content
          ?? '';
        if (thinkTok) {
          fullThinking += thinkTok;
          sink.emit({ type: 'thinking_delta', content: thinkTok });
          thinkEmitted = true;
        }

        const token = chunk.message?.content
          ?? chunk.choices?.[0]?.delta?.content
          ?? chunk.choices?.[0]?.message?.content
          ?? chunk.response
          ?? chunk.result?.response
          ?? chunk.delta
          ?? chunk.text
          ?? chunk.content
          ?? '';
        if (token) handleContentToken(token);

        const isDone = chunk.done === true || chunk.choices?.[0]?.finish_reason === 'stop';
        if (isDone) { flushTail(); await onDone(summary()); return; }
      }
    }

    flushTail();
    await onDone(summary());
  }

  function handleContentToken(token) {
    // Always scan for a "<think>" opener while not already inside one — even if
    // we've ALREADY received thinking via a dedicated `thinking`/`reasoning_content`
    // field. Some r1-style models emit BOTH: structured thinking deltas AND an
    // inline <think>…</think> block inside the content stream. The old guard
    // (`!thinkEmitted`) skipped the strip once any thinking arrived, so that
    // inline block leaked verbatim into the answer. Stripping unconditionally
    // keeps the visible content clean in every case.
    if (!inThink) {
      thinkBuf += token;
      const openIdx = thinkBuf.indexOf('<think>');
      if (openIdx !== -1) {
        const before = thinkBuf.slice(0, openIdx);
        if (before) {
          fullContent += before;
          sink.emit({ type: 'chunk', content: before });
        }
        inThink = true;
        thinkBuf = thinkBuf.slice(openIdx + 7);
        return;
      }
      // Hold back up to 6 chars in case a "<think" opener is mid-arrival.
      if (thinkBuf.length > 6) {
        const safe = thinkBuf.slice(0, -6);
        fullContent += safe;
        sink.emit({ type: 'chunk', content: safe });
        thinkBuf = thinkBuf.slice(-6);
      }
      return;
    }

    if (inThink) {
      thinkBuf += token;
      const closeIdx = thinkBuf.indexOf('</think>');
      if (closeIdx !== -1) {
        const reasoning = thinkBuf.slice(0, closeIdx).trim();
        const remainder = thinkBuf.slice(closeIdx + 8);
        fullThinking += reasoning;
        sink.emit({ type: 'thinking', content: reasoning });
        inThink = false;
        thinkEmitted = true;
        thinkBuf = '';
        if (remainder) {
          fullContent += remainder;
          sink.emit({ type: 'chunk', content: remainder });
        }
      }
      return;
    }

    fullContent += token;
    sink.emit({ type: 'chunk', content: token });
  }

  return { feed };
}

// Split a cached/tool response into ~24-char chunks so SSE replay still feels
// streamed instead of arriving as a single dump.
export function chunkifyForReplay(text, size = 24) {
  if (!text) return [];
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
