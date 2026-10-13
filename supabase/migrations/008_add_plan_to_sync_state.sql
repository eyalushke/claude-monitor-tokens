-- Store the Claude plan detected by ingest.py from Claude Code's cached account
-- profile (~/.claude.json -> oauthAccount), so the dashboard no longer needs it
-- configured manually. Existing sync_state RLS policies already cover new columns.

ALTER TABLE claude_monitor.sync_state
  ADD COLUMN IF NOT EXISTS plan_type          TEXT,
  ADD COLUMN IF NOT EXISTS organization_type  TEXT,
  ADD COLUMN IF NOT EXISTS seat_tier          TEXT,
  ADD COLUMN IF NOT EXISTS rate_limit_tier    TEXT,
  ADD COLUMN IF NOT EXISTS plan_detected_at   TIMESTAMPTZ;

-- Make PostgREST pick up the new columns immediately
NOTIFY pgrst, 'reload schema';
