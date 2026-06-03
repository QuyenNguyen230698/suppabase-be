// chatCore — DEPRECATED SHIM (PR7).
//
// The chat pipeline was rebuilt as the AICore pipeline (services/aicore/).
// All DB helpers moved to aicore/persistence.js; the streaming orchestration is
// now aicore/index.js (AICore.run) driven via a StreamSink. The old
// streamChat(req,res,opts) monolith is gone.
//
// This file only re-exports the persistence helpers so any straggler import
// (scripts, external callers) keeps working. New code should import from
// services/aicore/persistence.js (DB) and services/aicore/index.js (pipeline)
// directly.

export {
  upsertConversation,
  saveUserMessage,
  saveAssistantMessage,
  loadConversationMessages,
  loadConversationImageDocIds,
  linkDocumentsToMessage,
  loadProjectAndSummary,
  listConversationsBySource,
  getConversationWithMessages,
  deleteConversationBySource,
} from './aicore/persistence.js';
