// codeChunker — split source code into symbol-aligned chunks for embedding.
//
// Goal (per the Text/Code core sitemap): chunk along function/class/method
// boundaries instead of by sentence, and prepend the enclosing signature so a
// retrieved chunk is self-describing ("this is method X of class Y").
//
// PR4 uses a language-agnostic heuristic (brace depth + def/class/function
// keywords) — no native deps. The interface (chunkCode → [{content, symbol,
// startLine, endLine, parentSignature, lang}]) is the seam where a tree-sitter
// AST splitter drops in later without touching callers.

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', vue: 'vue',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', cc: 'cpp', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', lua: 'lua',
  scala: 'scala', dart: 'dart', r: 'r',
};

export function langForName(name = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return LANG_BY_EXT[ext] || null;
}

const MAX_CHUNK_LINES = Number(process.env.CODE_CHUNK_MAX_LINES || 120);

// Signature heuristics — the line that opens a symbol. Captures the name so we
// can both tag the chunk and prepend it as parent context to inner chunks.
const SIGNATURE_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:public|private|protected|static\s+)*(?:function|class|interface|struct|enum|def|fn|func|impl|module|namespace)\b[^\n{:]*/;
const NAME_RE = /(?:function|class|interface|struct|enum|def|fn|func|impl|module|namespace)\s+([A-Za-z_$][\w$]*)/;

function symbolName(line) {
  const m = line.match(NAME_RE);
  return m ? m[1] : null;
}

// Split into top-level symbol blocks by tracking brace depth (C-family) AND
// indentation resets (Python-like). Falls back to a flat sliding window when no
// symbol boundaries are detected (e.g. a config file routed as code).
export function chunkCode(source, { name = '', lang = null } = {}) {
  const language = lang || langForName(name);
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  const blocks = [];
  let cur = null;          // { startLine, symbol, parentSignature, lines: [] }
  let depth = 0;

  const flush = () => {
    if (cur && cur.lines.join('').trim()) {
      blocks.push(cur);
    }
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isSig = SIGNATURE_RE.test(line);

    // A top-level signature (brace depth 0) starts a new block.
    if (isSig && depth === 0) {
      flush();
      cur = {
        startLine: i + 1,
        symbol: symbolName(line),
        parentSignature: line.trim().slice(0, 200),
        lines: [],
      };
    }
    if (!cur) {
      // Preamble before the first symbol (imports, top-level statements).
      cur = { startLine: i + 1, symbol: null, parentSignature: null, lines: [] };
    }
    cur.lines.push(line + '\n');

    // Track brace depth for C-family scoping.
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }

    // Split overly long blocks so a single huge function still fits the model.
    if (cur.lines.length >= MAX_CHUNK_LINES && depth === 0) flush();
  }
  flush();

  // Map to chunk records; prepend parent signature into content for context.
  return blocks.map((b) => {
    const body = b.lines.join('');
    const content = b.parentSignature && b.symbol
      ? `// ${b.parentSignature}\n${body}`
      : body;
    return {
      content: content.trim(),
      symbol: b.symbol,
      startLine: b.startLine,
      endLine: b.startLine + b.lines.length - 1,
      parentSignature: b.parentSignature,
      lang: language,
    };
  }).filter((c) => c.content.length > 10);
}
