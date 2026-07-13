-- 004_add_email_variants.sql
-- A/B reply-rate tracking for the 3 email variants.
-- Initial weights 33/33/34. After 10 sends, weights adjust by reply rate.

CREATE TABLE IF NOT EXISTS email_variants (
    variant     TEXT PRIMARY KEY,   -- technical_lead | mission_lead | direct
    sends       INTEGER DEFAULT 0,
    replies     INTEGER DEFAULT 0,
    weight      REAL DEFAULT 0.3333,
    updated_at  TEXT
);

INSERT OR IGNORE INTO email_variants (variant, sends, replies, weight, updated_at)
VALUES ('technical_lead', 0, 0, 0.3333, ''),
       ('mission_lead',   0, 0, 0.3333, ''),
       ('direct',         0, 0, 0.3334, '');
