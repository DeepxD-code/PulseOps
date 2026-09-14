-- 007_add_outreach_channel.sql
-- Adds channel tracking to the outreach table.
--
-- Why: dm_first is the default outreach mode (config/settings.yml ->
-- outreach.mode). Every A/B/C match gets a LinkedIn DM draft delivered to
-- Telegram; cold-email auto-send is the exception, not the rule, for
-- users without a Hunter.io key (or any user relying primarily on manual
-- LinkedIn outreach). Before this migration, the `outreach` table was only
-- ever written by the auto-email path (send_engine.py -> save_outreach()),
-- which meant:
--   1. G5 cooldown checks (get_last_outreach_for_company) had zero visibility
--      into manually-sent DMs, risking a double-contact via a different
--      channel within the 30-day cooldown window.
--   2. Callback-rate-by-score-band calibration (the whole point of treating
--      SEND_THRESHOLD=88 as a hypothesis to refine) was blind to the
--      majority of actual outreach happening in dm_first mode.
--
-- `channel` defaults to 'email' so all pre-existing rows (written by the
-- only code path that existed before this migration) are correctly
-- classified without a backfill script.

ALTER TABLE outreach ADD COLUMN channel TEXT DEFAULT 'email';
ALTER TABLE outreach ADD COLUMN notes TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_outreach_channel ON outreach(channel);
