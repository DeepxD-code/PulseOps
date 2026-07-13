-- 003_add_send_queue.sql
-- Cap/window overflow queue. G7 (daily cap) and G8 (send window) QUEUE
-- instead of SKIP — processed by score priority at next run.

CREATE TABLE IF NOT EXISTS send_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        INTEGER NOT NULL,
    score         INTEGER DEFAULT 0,
    reason        TEXT DEFAULT '',         -- e.g. "G7: daily cap reached" / "G8: outside send window"
    status        TEXT DEFAULT 'pending',  -- pending|sent|skipped
    queued_at     TEXT,
    processed_at  TEXT DEFAULT '',
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_send_queue_status ON send_queue(status);
CREATE INDEX IF NOT EXISTS idx_send_queue_score  ON send_queue(score DESC);
