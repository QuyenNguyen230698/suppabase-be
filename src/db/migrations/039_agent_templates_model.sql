-- ============================================================
-- 039_agent_templates_model.sql
-- Optional locked model per agent template.
--
-- When `model` is set, the agent pins that chat model: the FE locks the model
-- selector and the BE overrides whatever model the client sends. When NULL
-- (default), the user picks the model freely as before.
--
-- Value should be one of ALLOWED_MODELS (validated in the API layer via
-- modelRegistry.isAllowedChatModel); the column itself stays a plain string so
-- the allow-list can change without a migration.
-- ============================================================

ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS model VARCHAR(200) DEFAULT NULL;
