-- 006_add_outcomes.sql
-- Layer 3 pipeline memory: callback/interview stage tracking.
-- Non-negotiable #10: feedback loop only learns from jobs that reached
-- phone_screen or beyond (NOT 'Sent'/'Applied' — real signal only).
-- Interview prep auto-trigger: stage='phone_screen' AND prep_sent=0.

CREATE TABLE IF NOT EXISTS outcomes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       INTEGER,
    company      TEXT,
    title        TEXT,
    stage        TEXT NOT NULL,   -- phone_screen|technical|final|offer|rejected|accepted
    notes        TEXT DEFAULT '',
    recorded_at  TEXT,
    prep_sent    INTEGER DEFAULT 0,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_outcomes_stage  ON outcomes(stage);
CREATE INDEX IF NOT EXISTS idx_outcomes_job_id ON outcomes(job_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_prep   ON outcomes(stage, prep_sent);
