// StreamSink — abstracts where AICore's SSE output goes, so the same pipeline
// serves three transports without the cores ever touching an Express res:
//
//   ExpressSink  — pro (PEB) + public: write SSE straight to res.
//   QueueSink    — authenticated chat: route events through chatQueue's write()
//                  (the worker runs detached from the original request).
//   CollectSink  — non-stream: accumulate content/reasoning, emit nothing.
//
// Every sink implements: openHeaders(convId?), emit(event), end(), get ended,
// onClose(fn), startHeartbeat(ms) → stopFn.

// ── ExpressSink ──────────────────────────────────────────────────
export class ExpressSink {
  constructor(res) { this.res = res; this._closed = false; }

  openHeaders(convId) {
    const res = this.res;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (convId) res.setHeader('X-Conversation-Id', convId);
    res.flushHeaders?.();
  }

  emit(event) {
    if (this.res.writableEnded) return;
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  end() {
    if (this.res.writableEnded) return;
    this.res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    this.res.end();
  }

  get ended() { return this.res.writableEnded; }

  onClose(fn) { this.res.on('close', fn); this.res.on('finish', fn); }

  startHeartbeat(ms = 15000) {
    const timer = setInterval(() => {
      if (this.res.writableEnded) return;
      try { this.res.write(': ping\n\n'); } catch { /* socket gone */ }
    }, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // HTTP error BEFORE the SSE stream opened (guard/quota). ExpressSink only.
  fail(status, body) {
    if (this.res.headersSent) { this.emit({ type: 'error', ...body }); this.res.end(); return; }
    this.res.status(status).json(body);
  }
}

// ── QueueSink ────────────────────────────────────────────────────
// Wraps chatQueue's write(obj). Headers + heartbeat are owned by
// chatQueue.subscribe(), so those are no-ops here. emit() passes the event
// object straight through (no stringify→parse round-trip).
export class QueueSink {
  constructor(write) { this.write = write; this._ended = false; }
  openHeaders() {}
  emit(event) { if (!this._ended) this.write(event); }
  end() { if (this._ended) return; this._ended = true; this.write({ type: 'done' }); }
  get ended() { return this._ended; }
  onClose(fn) { this._onClose = fn; }
  // chatQueue heartbeats the live SSE socket; nothing to do here.
  startHeartbeat() { return () => {}; }
  // The worker has no HTTP status to return — guard ran pre-enqueue. If we ever
  // reach here, surface as an SSE error.
  fail(status, body) { this.emit({ type: 'error', ...body }); this.end(); }
  // Called by the queue worker when the client disconnects.
  triggerClose() { this._onClose?.(); }
}

// ── CollectSink ──────────────────────────────────────────────────
// Non-stream: gather content/reasoning + the final usage event, emit nothing.
export class CollectSink {
  constructor() {
    this.content = '';
    this.reasoning = '';
    this.usage = null;
    this.replacedContent = null;     // content_replaced (thinking strip)
    this.harmful = null;             // harmful_output_replaced
    this._ended = false;
  }
  openHeaders() {}
  emit(event) {
    switch (event.type) {
      case 'chunk':            this.content += event.content || ''; break;
      case 'thinking':         this.reasoning += event.content || ''; break;
      case 'thinking_delta':   this.reasoning += event.content || ''; break;
      case 'content_replaced': this.replacedContent = event.content; break;
      case 'harmful_output_replaced': this.harmful = event; break;
      case 'usage':            this.usage = event; break;
      default: break;          // conversation_id / thinking_delta / etc. ignored
    }
  }
  end() { this._ended = true; }
  get ended() { return this._ended; }
  onClose() {}
  startHeartbeat() { return () => {}; }
  // Final content: thinking-strip replacement wins, then harmful replacement.
  finalContent() {
    if (this.harmful) return this.harmful.replacement;
    if (this.replacedContent !== null) return this.replacedContent;
    return this.content;
  }
}
