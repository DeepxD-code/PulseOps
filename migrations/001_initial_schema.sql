-- 001_initial_schema.sql
-- Core tables: jobs, outreach, recruiter_replies, recruiter_profiles,
--              run_stats, settings, migrations_applied

CREATE TABLE IF NOT EXISTS migrations_applied (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT UNIQUE NOT NULL,
    applied_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    title               TEXT NOT NULL,
    company             TEXT NOT NULL,
    company_normalised  TEXT NOT NULL DEFAULT '',
    link                TEXT UNIQUE,
    source              TEXT DEFAULT '',
    run_id              TEXT DEFAULT '',
    score               INTEGER DEFAULT 0,
    letter_grade        TEXT DEFAULT '',
    status              TEXT DEFAULT 'Sourced',
    posted_at           TEXT DEFAULT '',
    location_raw        TEXT DEFAULT '',
    location_resolved   TEXT DEFAULT '',
    text_summary        TEXT DEFAULT '',
    skill_gap           TEXT DEFAULT '[]',
    bullet_adjustments  TEXT DEFAULT '[]',
    tailored_skills     TEXT DEFAULT '[]',
    star_stories        TEXT DEFAULT '[]',
    level_strategy      TEXT DEFAULT '',
    comp_research       TEXT DEFAULT '',
    negotiation_notes   TEXT DEFAULT '',
    recruiter_message   TEXT DEFAULT '',
    recruiter_email     TEXT DEFAULT '',
    contact_email       TEXT DEFAULT '',
    inferred_domain     TEXT DEFAULT '',
    domain_confidence   TEXT DEFAULT '',
    email_variant_used  TEXT DEFAULT '',
    eval_engine         TEXT DEFAULT '',
    eval_tokens         INTEGER DEFAULT 0,
    eval_duration_ms    INTEGER DEFAULT 0,
    pdf_path            TEXT DEFAULT '',
    report_path         TEXT DEFAULT '',
    processed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_company_norm ON jobs(company_normalised);
CREATE INDEX IF NOT EXISTS idx_jobs_run_id      ON jobs(run_id);

CREATE TABLE IF NOT EXISTS outreach (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id              INTEGER,
    company             TEXT,
    company_normalised  TEXT DEFAULT '',
    domain              TEXT DEFAULT '',
    contact_email       TEXT,
    subject             TEXT DEFAULT '',
    body                TEXT DEFAULT '',
    email_variant       TEXT DEFAULT '',
    sent_at             TEXT,
    status              TEXT DEFAULT '',
    followup_sent       INTEGER DEFAULT 0,
    followup_sent_at    TEXT DEFAULT '',
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_outreach_company_norm ON outreach(company_normalised);
CREATE INDEX IF NOT EXISTS idx_outreach_domain       ON outreach(domain);
CREATE INDEX IF NOT EXISTS idx_outreach_contact      ON outreach(contact_email);
CREATE INDEX IF NOT EXISTS idx_outreach_job_id       ON outreach(job_id);

CREATE TABLE IF NOT EXISTS recruiter_replies (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        INTEGER,
    sender_email  TEXT,
    subject       TEXT,
    snippet       TEXT,
    received_at   TEXT,
    notified      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_replies_notified ON recruiter_replies(notified);

CREATE TABLE IF NOT EXISTS recruiter_profiles (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    company   TEXT NOT NULL,
    name      TEXT DEFAULT '',
    title     TEXT DEFAULT '',
    link      TEXT DEFAULT '',
    cached_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recruiter_profiles_company ON recruiter_profiles(company);

CREATE TABLE IF NOT EXISTS run_stats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    run_type    TEXT DEFAULT 'daily',
    stats_json  TEXT DEFAULT '{}',
    created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_stats_run_id ON run_stats(run_id);
