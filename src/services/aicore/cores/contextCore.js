// ContextCore — assemble the system prompt + final message array.
//
// Ported from chatCore.streamChat (system-prompt build block). Concatenation
// order is preserved exactly so prompts are byte-identical to the old pipeline:
//   base prompt → agent persona → project instructions → earlier-summary
//   → memories → per-turn language directive.

import { buildSystemPrompt } from '../../promptService.js';
import { buildAgentSection } from '../../agentTemplateService.js';
import { buildMemoryBlock } from '../../memoryService.js';
import { detectLanguage, languageDirective } from '../../languageDetector.js';
import { loadProjectAndSummary } from '../persistence.js';

export async function buildContext(ctx) {
  const { source, locale, ragContext, hasImage, agent, conversationId, userId, lastUserMsg, userMessages } = ctx;

  let systemPrompt = await buildSystemPrompt({ scope: source, locale, context: ragContext, hasImage });

  const agentSection = buildAgentSection(agent);
  if (agentSection) {
    systemPrompt = `${systemPrompt}\n\n---\n[Agent: ${agent.name}]\n${agentSection}`;
  }

  if (conversationId && userId) {
    const { projectInstructions, conversationSummary } = await loadProjectAndSummary({ userId, conversationId });
    if (projectInstructions) {
      systemPrompt = `${systemPrompt}\n\n---\n[Project context]\n${projectInstructions}`;
    }
    if (conversationSummary) {
      systemPrompt = `${systemPrompt}\n\n---\n[Earlier conversation summary]\n${conversationSummary}`;
    }
  }

  if (userId) {
    const memoryBlock = await buildMemoryBlock(userId, lastUserMsg?.content);
    if (memoryBlock) systemPrompt = `${systemPrompt}${memoryBlock}`;
  }

  if (lastUserMsg?.content) {
    systemPrompt = `${systemPrompt}${languageDirective(detectLanguage(lastUserMsg.content))}`;
  }

  ctx.systemPrompt = systemPrompt;
  ctx.finalMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...userMessages]
    : userMessages;
}
