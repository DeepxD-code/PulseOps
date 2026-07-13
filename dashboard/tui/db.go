package main

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// job mirrors the subset of the `jobs` table the TUI displays.
type job struct {
	ID               int
	Title            string
	Company          string
	Status           string
	Source           string
	Score            int
	Grade            string
	EmailVariant     string
	TextSummary      string
	SkillGap         string
	LevelStrategy    string
	CompResearch     string
	NegotiationNotes string
	ContactEmail     string
	InferredDomain   string
	DomainConfidence string
	ProcessedAt      string
}

// queueItem mirrors `send_queue` joined with `jobs`.
type queueItem struct {
	ID       int
	JobID    int
	Score    int
	Title    string
	Company  string
	Reason   string
	QueuedAt string
}

// memoryItem mirrors `memories`.
type memoryItem struct {
	ID          int
	Category    string
	RawText     string
	Company     string
	Action      string
	CVCandidate bool
	CreatedAt   string
}

// auditEntry mirrors one JSONL line written by persistence/audit_log.py.
// The TUI reads jobs/queue/memories from SQLite directly; audit entries
// are summarized via run_stats instead, since the JSONL log lives outside
// the DB (kept in sync with the Flask dashboard's /api/audit route).
type runStat struct {
	RunID     string
	RunType   string
	CreatedAt string
	StatsJSON string
}

var statuses = []string{
	"Sourced", "Filtered", "Evaluated", "Matched", "Queued", "Sent",
	"FollowupSent", "Replied", "phone_screen", "technical", "final",
	"offer", "rejected", "accepted", "manual_required",
}

func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite + this CLI tool: avoid concurrent writer locks
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("could not open %s — has main.py --simulate been run yet? (%w)", path, err)
	}
	return db, nil
}

func loadJobs(db *sql.DB, statusFilter, search string) ([]job, error) {
	query := `SELECT id, title, company, status, source, score, letter_grade,
	                  email_variant_used, text_summary, skill_gap, level_strategy,
	                  comp_research, negotiation_notes, contact_email,
	                  inferred_domain, domain_confidence, COALESCE(processed_at, '')
	           FROM jobs WHERE 1=1`
	args := []any{}
	if statusFilter != "" {
		query += " AND status = ?"
		args = append(args, statusFilter)
	}
	if search != "" {
		query += " AND (LOWER(title) LIKE ? OR LOWER(company) LIKE ?)"
		like := "%" + search + "%"
		args = append(args, like, like)
	}
	query += " ORDER BY processed_at DESC LIMIT 500"

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []job
	for rows.Next() {
		var j job
		if err := rows.Scan(&j.ID, &j.Title, &j.Company, &j.Status, &j.Source,
			&j.Score, &j.Grade, &j.EmailVariant, &j.TextSummary, &j.SkillGap,
			&j.LevelStrategy, &j.CompResearch, &j.NegotiationNotes, &j.ContactEmail,
			&j.InferredDomain, &j.DomainConfidence, &j.ProcessedAt); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

func loadQueue(db *sql.DB) ([]queueItem, error) {
	rows, err := db.Query(`
		SELECT q.id, q.job_id, q.score, j.title, j.company, q.reason, COALESCE(q.queued_at, '')
		FROM send_queue q JOIN jobs j ON j.id = q.job_id
		WHERE q.status = 'pending'
		ORDER BY q.score DESC, q.queued_at ASC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []queueItem
	for rows.Next() {
		var q queueItem
		if err := rows.Scan(&q.ID, &q.JobID, &q.Score, &q.Title, &q.Company, &q.Reason, &q.QueuedAt); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

func loadMemories(db *sql.DB) ([]memoryItem, error) {
	rows, err := db.Query(`
		SELECT id, category, raw_text, company, action, cv_candidate, COALESCE(created_at, '')
		FROM memories WHERE active = 1
		ORDER BY created_at DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []memoryItem
	for rows.Next() {
		var m memoryItem
		var cvFlag int
		if err := rows.Scan(&m.ID, &m.Category, &m.RawText, &m.Company, &m.Action, &cvFlag, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.CVCandidate = cvFlag == 1
		out = append(out, m)
	}
	return out, rows.Err()
}

func loadRunStats(db *sql.DB, limit int) ([]runStat, error) {
	rows, err := db.Query(`SELECT run_id, run_type, COALESCE(created_at, ''), stats_json
	                        FROM run_stats ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []runStat
	for rows.Next() {
		var r runStat
		if err := rows.Scan(&r.RunID, &r.RunType, &r.CreatedAt, &r.StatsJSON); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// updateJobStatus writes a manual override — the same human-in-the-loop
// escape hatch the Flask dashboard exposes via POST /api/jobs/<id>/status.
func updateJobStatus(db *sql.DB, jobID int, status string) error {
	_, err := db.Exec(`UPDATE jobs SET status = ? WHERE id = ?`, status, jobID)
	return err
}

// logManualOutreach records a manually-sent LinkedIn DM (or referral
// follow-through) against a job — the 'd' keybinding in the jobs view.
// Mirrors persistence/db_manager.py:log_manual_outreach. This matters
// beyond record-keeping: G5's cooldown check reads any status='sent' row
// from the outreach table regardless of channel, so a DM logged here
// correctly prevents the pipeline from also cold-emailing the same
// company later, and it feeds the weekly digest's callback-rate
// calibration data — which is otherwise blind to dm_first outreach.
func logManualOutreach(db *sql.DB, jobID int, company, domain, channel string) error {
	validChannels := map[string]bool{"linkedin_dm": true, "referral": true, "other": true}
	if !validChannels[channel] {
		channel = "other"
	}
	normalised := normaliseCompany(company)
	_, err := db.Exec(`
		INSERT INTO outreach
			(job_id, company, company_normalised, domain, contact_email, subject,
			 body, email_variant, sent_at, status, channel, notes)
		VALUES (?,?,?,?,'','','','',?,'sent',?,'')`,
		jobID, company, normalised, domain, nowISO(), channel,
	)
	return err
}

// normaliseCompany mirrors the Python normalise_company() dedup helper
// closely enough for cooldown lookups to match correctly across both tools.
func normaliseCompany(name string) string {
	suffixes := []string{" inc", " ltd", " llc", " corp", " limited",
		" technologies", " solutions", " systems", " software"}
	result := strings.ToLower(strings.TrimSpace(name))
	for _, suf := range suffixes {
		result = strings.TrimSuffix(result, suf)
	}
	return strings.TrimSpace(result)
}

func nowISO() string {
	return time.Now().Format("2006-01-02T15:04:05.000000")
}

// nextStatus cycles to the next value in the canonical status workflow,
// wrapping around. Used by the 's' keybinding.
func nextStatus(current string) string {
	for i, s := range statuses {
		if s == current {
			return statuses[(i+1)%len(statuses)]
		}
	}
	return statuses[0]
}

func nowStamp() string {
	return time.Now().Format("15:04:05")
}
