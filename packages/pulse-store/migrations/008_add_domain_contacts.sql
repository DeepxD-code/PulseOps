-- 008: domain contact cache — one verified lookup serves all future runs.
-- Never stores fabricated addresses: only JD-extracted, page-scraped, or
-- search-verified (domain-matched) emails.
CREATE TABLE IF NOT EXISTS domain_contacts (
    domain     TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    source     TEXT NOT NULL,  -- jd | site-scrape | web-search
    found_at   TEXT NOT NULL,
    send_count INTEGER NOT NULL DEFAULT 0,
    bounce_count INTEGER NOT NULL DEFAULT 0
);
