-- 002_add_memory_tables.sql
-- Layer 2: Conversational Memory (memories table)

CREATE TABLE IF NOT EXISTS memories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    category      TEXT NOT NULL,           -- callback|feedback|project|skill|preference|note
    raw_text      TEXT NOT NULL,
    parsed        TEXT DEFAULT '{}',       -- JSON: typed ParsedMemory
    action        TEXT DEFAULT '',         -- add_to_blacklist|add_cooldown|flag_cv_candidate|deferred
    company       TEXT DEFAULT '',
    cv_candidate  INTEGER DEFAULT 0,       -- flagged, never auto-written to cv.md
    active        INTEGER DEFAULT 1,
    created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_category     ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_company      ON memories(company);
CREATE INDEX IF NOT EXISTS idx_memories_cv_candidate ON memories(cv_candidate, active);
