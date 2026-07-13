// Command pulseops-tui is the Go TUI dashboard for PulseOps (Phase 10).
//
// It is a read-mostly companion to the Flask dashboard (dashboard/app.py):
// both read from the same pulseops.db, and both can write a manual status
// override. Nothing here ever sends an email or evaluates a job — that
// stays in main.py's hands.
//
// Build:
//
//	cd dashboard/tui
//	go mod tidy   # fetches bubbletea/lipgloss/modernc.org-sqlite
//	go build -o pulseops-tui .
//
// Run (from the repo root, or pass -db path/to/pulseops.db):
//
//	./dashboard/tui/pulseops-tui
//
// Keybindings:
//
//	tab / 1-4   switch view (jobs / queue / memory / runs)
//	j k / ↑ ↓   navigate
//	enter       toggle job detail (jobs view)
//	s           cycle status of selected job (jobs view)
//	d           mark manual outreach sent (LinkedIn DM) for selected job
//	f           cycle quick status filter (jobs view)
//	/           search title/company (jobs view), enter to apply, esc to cancel
//	r           refresh current view
//	q / ctrl+c  quit
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

type viewMode int

const (
	viewJobs viewMode = iota
	viewQueue
	viewMemory
	viewRuns
)

var viewOrder = []viewMode{viewJobs, viewQueue, viewMemory, viewRuns}

var viewNames = map[viewMode]string{
	viewJobs:   "jobs",
	viewQueue:  "queue",
	viewMemory: "memory",
	viewRuns:   "runs",
}

// quickFilters is the cycle order for the 'f' key in the jobs view.
// "" means no filter (all statuses).
var quickFilters = []string{"", "Sourced", "Evaluated", "Matched", "Queued", "Sent", "Replied", "phone_screen"}

// ── model ────────────────────────────────────────────────────────────────

type model struct {
	db     *sql.DB
	dbPath string

	view   viewMode
	cursor int
	width  int
	height int

	jobs     []job
	queue    []queueItem
	memories []memoryItem
	runs     []runStat

	filterIdx   int
	searching   bool
	searchQuery string
	showDetail  bool

	statusMsg string
	isError   bool

	ready bool
}

func newModel(dbPath string, db *sql.DB) model {
	return model{
		db:        db,
		dbPath:    dbPath,
		view:      viewJobs,
		statusMsg: "Loading…",
	}
}

// ── messages ─────────────────────────────────────────────────────────────

type jobsLoadedMsg []job
type queueLoadedMsg []queueItem
type memoriesLoadedMsg []memoryItem
type runsLoadedMsg []runStat
type errMsg struct{ err error }
type statusUpdatedMsg struct {
	jobID  int
	status string
}

type outreachMarkedMsg struct {
	jobID   int
	channel string
}

// ── entry point ──────────────────────────────────────────────────────────

func main() {
	dbPath := flag.String("db", "pulseops.db", "path to pulseops.db (run from repo root, or pass full path)")
	flag.Parse()

	db, err := openDB(*dbPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[pulseops-tui] "+err.Error())
		os.Exit(1)
	}
	defer db.Close()

	m := newModel(*dbPath, db)
	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "[pulseops-tui] fatal: "+err.Error())
		os.Exit(1)
	}
}

// ── tea.Model interface ─────────────────────────────────────────────────

func (m model) Init() tea.Cmd {
	return tea.Batch(m.loadJobsCmd(), m.loadQueueCmd(), m.loadMemoriesCmd(), m.loadRunsCmd())
}

func (m model) loadJobsCmd() tea.Cmd {
	return func() tea.Msg {
		filter := quickFilters[m.filterIdx%len(quickFilters)]
		jobs, err := loadJobs(m.db, filter, strings.ToLower(strings.TrimSpace(m.searchQuery)))
		if err != nil {
			return errMsg{err}
		}
		return jobsLoadedMsg(jobs)
	}
}

func (m model) loadQueueCmd() tea.Cmd {
	return func() tea.Msg {
		q, err := loadQueue(m.db)
		if err != nil {
			return errMsg{err}
		}
		return queueLoadedMsg(q)
	}
}

func (m model) loadMemoriesCmd() tea.Cmd {
	return func() tea.Msg {
		mem, err := loadMemories(m.db)
		if err != nil {
			return errMsg{err}
		}
		return memoriesLoadedMsg(mem)
	}
}

func (m model) loadRunsCmd() tea.Cmd {
	return func() tea.Msg {
		r, err := loadRunStats(m.db, 10)
		if err != nil {
			return errMsg{err}
		}
		return runsLoadedMsg(r)
	}
}

func (m model) updateStatusCmd(jobID int, status string) tea.Cmd {
	return func() tea.Msg {
		if err := updateJobStatus(m.db, jobID, status); err != nil {
			return errMsg{err}
		}
		return statusUpdatedMsg{jobID: jobID, status: status}
	}
}

func (m model) logOutreachCmd(jobID int, company, domain, channel string) tea.Cmd {
	return func() tea.Msg {
		if err := logManualOutreach(m.db, jobID, company, domain, channel); err != nil {
			return errMsg{err}
		}
		return outreachMarkedMsg{jobID: jobID, channel: channel}
	}
}

func currentListLen(m model) int {
	switch m.view {
	case viewJobs:
		return len(m.jobs)
	case viewQueue:
		return len(m.queue)
	case viewMemory:
		return len(m.memories)
	case viewRuns:
		return len(m.runs)
	}
	return 0
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.ready = true
		return m, nil

	case jobsLoadedMsg:
		m.jobs = []job(msg)
		if m.cursor >= len(m.jobs) {
			m.cursor = 0
		}
		m.statusMsg = fmt.Sprintf("Loaded %d job(s)", len(m.jobs))
		m.isError = false
		return m, nil

	case queueLoadedMsg:
		m.queue = []queueItem(msg)
		return m, nil

	case memoriesLoadedMsg:
		m.memories = []memoryItem(msg)
		return m, nil

	case runsLoadedMsg:
		m.runs = []runStat(msg)
		return m, nil

	case statusUpdatedMsg:
		for i := range m.jobs {
			if m.jobs[i].ID == msg.jobID {
				m.jobs[i].Status = msg.status
			}
		}
		m.statusMsg = fmt.Sprintf("Job #%d → %s  (%s)", msg.jobID, msg.status, nowStamp())
		m.isError = false
		return m, nil

	case outreachMarkedMsg:
		m.statusMsg = fmt.Sprintf("Job #%d — %s logged  (%s)", msg.jobID, msg.channel, nowStamp())
		m.isError = false
		return m, nil

	case errMsg:
		m.statusMsg = "Error: " + msg.err.Error()
		m.isError = true
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)
	}

	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// ── search-mode keys take priority ──────────────────────────────────
	if m.searching {
		switch msg.Type {
		case tea.KeyEsc:
			m.searching = false
			m.searchQuery = ""
			return m, m.loadJobsCmd()
		case tea.KeyEnter:
			m.searching = false
			m.cursor = 0
			return m, m.loadJobsCmd()
		case tea.KeyBackspace:
			if len(m.searchQuery) > 0 {
				m.searchQuery = m.searchQuery[:len(m.searchQuery)-1]
			}
			return m, nil
		case tea.KeyRunes:
			m.searchQuery += string(msg.Runes)
			return m, nil
		}
		return m, nil
	}

	// ── detail overlay: only esc/enter/s are meaningful ────────────────
	if m.showDetail {
		switch msg.String() {
		case "esc", "enter", "q":
			m.showDetail = false
			return m, nil
		case "s":
			return m.cycleSelectedStatus()
		case "d":
			return m.markSelectedOutreach()
		case "ctrl+c":
			return m, tea.Quit
		}
		return m, nil
	}

	switch msg.String() {
	case "ctrl+c", "q":
		return m, tea.Quit

	case "tab":
		m.view = viewOrder[(int(m.view)+1)%len(viewOrder)]
		m.cursor = 0
		return m, nil

	case "1":
		m.view, m.cursor = viewJobs, 0
		return m, nil
	case "2":
		m.view, m.cursor = viewQueue, 0
		return m, nil
	case "3":
		m.view, m.cursor = viewMemory, 0
		return m, nil
	case "4":
		m.view, m.cursor = viewRuns, 0
		return m, nil

	case "j", "down":
		if n := currentListLen(m); n > 0 && m.cursor < n-1 {
			m.cursor++
		}
		return m, nil

	case "k", "up":
		if m.cursor > 0 {
			m.cursor--
		}
		return m, nil

	case "enter":
		if m.view == viewJobs && len(m.jobs) > 0 {
			m.showDetail = true
		}
		return m, nil

	case "s":
		if m.view == viewJobs {
			return m.cycleSelectedStatus()
		}
		return m, nil

	case "d":
		if m.view == viewJobs {
			return m.markSelectedOutreach()
		}
		return m, nil

	case "f":
		if m.view == viewJobs {
			m.filterIdx = (m.filterIdx + 1) % len(quickFilters)
			m.cursor = 0
			return m, m.loadJobsCmd()
		}
		return m, nil

	case "/":
		if m.view == viewJobs {
			m.searching = true
			m.searchQuery = ""
		}
		return m, nil

	case "r":
		switch m.view {
		case viewJobs:
			return m, m.loadJobsCmd()
		case viewQueue:
			return m, m.loadQueueCmd()
		case viewMemory:
			return m, m.loadMemoriesCmd()
		case viewRuns:
			return m, m.loadRunsCmd()
		}
		return m, nil
	}

	return m, nil
}

func (m model) cycleSelectedStatus() (tea.Model, tea.Cmd) {
	if m.view != viewJobs || m.cursor >= len(m.jobs) {
		return m, nil
	}
	j := m.jobs[m.cursor]
	next := nextStatus(j.Status)
	return m, m.updateStatusCmd(j.ID, next)
}

func (m model) markSelectedOutreach() (tea.Model, tea.Cmd) {
	if m.view != viewJobs || m.cursor >= len(m.jobs) {
		return m, nil
	}
	j := m.jobs[m.cursor]
	return m, m.logOutreachCmd(j.ID, j.Company, j.InferredDomain, "linkedin_dm")
}
