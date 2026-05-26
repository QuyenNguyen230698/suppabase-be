// toolExecutor — multi-step agentic loop with tool calling.
//
// Flow:
//   1. Send messages + tools to model (non-stream).
//   2. If response has tool_calls: execute each, append tool results, loop.
//   3. If no tool_calls: return final assistant content.
//   4. Cap at MAX_STEPS to prevent runaway loops.
//
// We use a separate non-stream path because Cloudflare Workers AI's
// streaming + tool-calling support varies by model. Non-stream is reliable
// across Llama 3.x family. The result is then "fake-streamed" to the client
// (similar to cache hit replay) so UX stays identical.

import { chatWithTools } from './cloudflareAIService.js';
import { executeTool } from './tools/index.js';
import { withBreaker } from './circuitBreaker.js';

const MAX_STEPS = parseInt(process.env.TOOL_MAX_STEPS || '4', 10);

/**
 * Run a tool-enabled conversation loop.
 * @returns { content, toolCallsTrace: [{name, args, result}], tokensIn, tokensOut, steps }
 */
export async function runWithTools({ model, messages, tools, ctx, signal, options }) {
  const transcript = [...messages];
  const trace = [];
  let tokensIn = 0;
  let tokensOut = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await withBreaker('cloudflare', () =>
      chatWithTools({ model, messages: transcript, tools, signal, options })
    );
    const choice = result.message || {};
    tokensIn  += result.usage?.prompt_tokens ?? 0;
    tokensOut += result.usage?.completion_tokens ?? 0;

    const toolCalls = Array.isArray(choice?.tool_calls) ? choice.tool_calls : null;

    if (toolCalls && toolCalls.length) {
      // Push assistant message with tool_calls. CF rejects null content,
      // so use empty string when content is missing.
      transcript.push({
        role: 'assistant',
        content: choice.content || '',
        tool_calls: toolCalls,
      });

      // Execute each tool, push tool messages
      for (const tc of toolCalls) {
        const name = tc.function?.name || tc.name;
        let args = {};
        try {
          args = typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function?.arguments || tc.arguments || {});
        } catch (err) {
          args = { _parse_error: err.message, raw: tc.function?.arguments };
        }
        const outString = await executeTool(name, args, ctx);
        trace.push({ name, args, result: tryParse(outString) });
        transcript.push({
          role: 'tool',
          tool_call_id: tc.id || `${name}-${step}`,
          name,
          content: outString,
        });
      }
      continue;   // loop for next model turn
    }

    // No tool calls → we have final content
    const content = choice?.content ?? '';
    return {
      content: typeof content === 'string' ? content : JSON.stringify(content),
      trace,
      tokensIn,
      tokensOut,
      steps: step + 1,
    };
  }

  // Hit MAX_STEPS — return what we have
  return {
    content: '(Tool loop exceeded maximum steps — partial result)',
    trace, tokensIn, tokensOut, steps: MAX_STEPS,
    truncated: true,
  };
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}
