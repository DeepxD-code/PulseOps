-- 005_add_source_health.sql
-- Non-negotiable #6: source failures never silent —
-- Telegram alert after 3 consecutive zero-result runs for a source.

CREATE TABLE IF NOT EXISTS source_health (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source_name        TEXT NOT NULL,
    run_id             TEXT DEFAULT '',
    jobs_found         INTEGER DEFAULT 0,
    consecutive_zeros  INTEGER DEFAULT 0,
    error              TEXT DEFAULT '',
    checked_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_source_health_name ON source_health(source_name);
CREATE INDEX IF NOT EXISTS idx_source_health_checked ON source_health(source_name, checked_at);
