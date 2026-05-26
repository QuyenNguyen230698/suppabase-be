// tools/index.js — registry of callable tools for agent function calling.
//
// Each tool exports:
//   • schema:    OpenAI-compatible JSON schema (name, description, parameters)
//   • execute:   async (args, ctx) => result
//
// ctx contains: userId, conversationId, docIds, locale, agent
//
// Adding a new tool:
//   1. Create file `tools/<name>.js` with schema + execute
//   2. Register here in REGISTRY
//   3. Add slug to agent_templates.allowed_tools to expose

import * as searchDocuments  from './searchDocuments.js';
import * as getCurrentTime   from './getCurrentTime.js';
import * as calculator       from './calculator.js';

export const REGISTRY = {
  search_documents:  searchDocuments,
  get_current_time:  getCurrentTime,
  calculator:        calculator,
};

/**
 * Build the OpenAI-compatible `tools` array for a request, filtered by the
 * agent's allowed_tools allowlist. Empty list = tools disabled.
 */
export function toolsForAgent(agent) {
  if (!agent) return [];
  const allowed = Array.isArray(agent.allowed_tools) ? agent.allowed_tools : [];
  if (!allowed.length) return [];
  const tools = [];
  for (const name of allowed) {
    const t = REGISTRY[name];
    if (!t) {
      console.warn(`[tools] unknown tool "${name}" referenced by agent ${agent.slug}`);
      continue;
    }
    tools.push({ type: 'function', function: t.schema });
  }
  return tools;
}

/**
 * Execute a tool call from the model. Returns string content for the tool
 * message — JSON-stringified if not already a string.
 */
export async function executeTool(name, args, ctx) {
  const tool = REGISTRY[name];
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  try {
    const result = await tool.execute(args || {}, ctx || {});
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err) {
    console.warn(`[tools] ${name} failed:`, err.message);
    return JSON.stringify({ error: err.message || 'Tool execution failed' });
  }
}

export const ALL_TOOL_NAMES = Object.keys(REGISTRY);
