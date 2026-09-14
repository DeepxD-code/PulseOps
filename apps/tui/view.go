package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

func (m model) View() string {
	if !m.ready {
		return "Starting PulseOps TUI…"
	}

	var b strings.Builder

	b.WriteString(m.renderHeader())
	b.WriteString("\n")

	if m.showDetail && m.view == viewJobs && m.cursor < len(m.jobs) {
		b.WriteString(m.renderJobDetail(m.jobs[m.cursor]))
	} else {
		switch m.view {
		case viewJobs:
			b.WriteString(m.renderJobs())
		case viewQueue:
			b.WriteString(m.renderQueue())
		case viewMemory:
			b.WriteString(m.renderMemory())
		case viewRuns:
			b.WriteString(m.renderRuns())
		}
	}

	b.WriteString("\n")
	b.WriteString(m.renderFooter())

	return appStyle.Render(b.String())
}

// ── header ───────────────────────────────────────────────────────────────

func (m model) renderHeader() string {
	title := titleStyle.Render(" PulseOps ")
	sub := subtitleStyle.Render(" backend-engineer pipeline · india ")

	var tabs []string
	for _, v := range viewOrder {
		label := fmt.Sprintf(" %s ", viewNames[v])
		if v == m.view {
			tabs = append(tabs, tabActiveStyle.Render(label))
		} else {
			tabs = append(tabs, tabInactiveStyle.Render(label))
		}
	}
	tabRow := lipgloss.JoinHorizontal(lipgloss.Top, tabs...)

	top := lipgloss.JoinHorizontal(lipgloss.Top, title, sub)
	return top + "\n" + tabRow
}

// ── jobs ─────────────────────────────────────────────────────────────────

func (m model) renderJobs() string {
	var b strings.Builder

	filterLabel := quickFilters[m.filterIdx%len(quickFilters)]
	if filterLabel == "" {
		filterLabel = "all"
	}
	b.WriteString(subtitleStyle.Render(fmt.Sprintf("filter: %s   ", filterLabel)))
	if m.searching {
		b.WriteString(searchBoxStyle.Render("/ " + m.searchQuery + "█"))
	} else if m.searchQuery != "" {
		b.WriteString(searchBoxStyle.Render("search: " + m.searchQuery))
	}
	b.WriteString("\n\n")

	if len(m.jobs) == 0 {
		b.WriteString(emptyStateStyle.Render("No jobs match. Run `python main.py --simulate` first, or clear the filter with 'f'."))
		return b.String()
	}

	header := fmt.Sprintf("  %-4s %-5s %-32s %-18s %-14s", "SCORE", "GRD", "TITLE", "COMPANY", "STATUS")
	b.WriteString(rowDimStyle.Render(header))
	b.WriteString("\n")

	for i, j := range m.jobs {
		title := truncate(j.Title, 32)
		company := truncate(j.Company, 18)
		grade := gradeStyle(j.Grade).Render(fmt.Sprintf(" %s ", orDash(j.Grade)))
		status := statusStyle(j.Status).Render(j.Status)
		row := fmt.Sprintf("  %-4d  %s  %-32s %-18s %s", j.Score, grade, title, company, status)

		if i == m.cursor {
			b.WriteString(rowSelectedStyle.Render("▸ " + stripPad(row)))
		} else {
			b.WriteString(rowNormalStyle.Render("  " + row))
		}
		b.WriteString("\n")
	}

	return b.String()
}

func (m model) renderJobDetail(j job) string {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("%s  %s\n", detailKeyStyle.Render(j.Title), subtitleStyle.Render("@ "+j.Company)))
	b.WriteString(fmt.Sprintf("%s %d (%s)   %s %s   %s %s\n\n",
		detailKeyStyle.Render("score"), j.Score, orDash(j.Grade),
		detailKeyStyle.Render("status"), statusStyle(j.Status).Render(j.Status),
		detailKeyStyle.Render("source"), j.Source))

	field := func(label, val string) {
		if strings.TrimSpace(val) == "" {
			val = "—"
		}
		b.WriteString(detailKeyStyle.Render(label + ":"))
		b.WriteString("\n")
		b.WriteString(detailValStyle.Render(wrap(val, 88)))
		b.WriteString("\n\n")
	}

	field("Summary", j.TextSummary)
	field("Skill gap", jsonListToLines(j.SkillGap))
	field("Level strategy", j.LevelStrategy)
	field("Comp research", j.CompResearch)
	field("Negotiation notes", j.NegotiationNotes)
	field("Contact / domain", fmt.Sprintf("%s · %s (%s)", orDash(j.ContactEmail), orDash(j.InferredDomain), orDash(j.DomainConfidence)))

	b.WriteString(subtitleStyle.Render("[s] cycle status   [d] mark outreach sent   [esc/enter] back"))

	return detailBoxStyle.Width(min(m.width-4, 100)).Render(b.String())
}

// ── queue ────────────────────────────────────────────────────────────────

func (m model) renderQueue() string {
	var b strings.Builder
	if len(m.queue) == 0 {
		b.WriteString(emptyStateStyle.Render("Send queue is empty — nothing waiting on the daily cap or send window."))
		return b.String()
	}
	header := fmt.Sprintf("  %-6s %-32s %-18s %-26s %s", "SCORE", "TITLE", "COMPANY", "REASON", "QUEUED AT")
	b.WriteString(rowDimStyle.Render(header))
	b.WriteString("\n")
	for i, q := range m.queue {
		row := fmt.Sprintf("  %-6d %-32s %-18s %-26s %s",
			q.Score, truncate(q.Title, 32), truncate(q.Company, 18), truncate(q.Reason, 26), q.QueuedAt)
		if i == m.cursor {
			b.WriteString(rowSelectedStyle.Render("▸ " + stripPad(row)))
		} else {
			b.WriteString(rowNormalStyle.Render("  " + row))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// ── memory ───────────────────────────────────────────────────────────────

func (m model) renderMemory() string {
	var b strings.Builder
	if len(m.memories) == 0 {
		b.WriteString(emptyStateStyle.Render(`No active memories yet. Try: python memory.py add "..."`))
		return b.String()
	}
	for i, mem := range m.memories {
		flag := ""
		if mem.CVCandidate {
			flag = lipgloss.NewStyle().Foreground(mochaPeach).Bold(true).Render(" [cv_candidate — never auto-written] ")
		}
		line := fmt.Sprintf("[%s]%s %s — %s", mem.Category, flag, mem.Company, truncate(mem.RawText, 90))
		if i == m.cursor {
			b.WriteString(rowSelectedStyle.Render("▸ " + line))
		} else {
			b.WriteString(rowNormalStyle.Render("  " + line))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// ── runs ─────────────────────────────────────────────────────────────────

func (m model) renderRuns() string {
	var b strings.Builder
	if len(m.runs) == 0 {
		b.WriteString(emptyStateStyle.Render("No run_stats recorded yet — run the pipeline at least once."))
		return b.String()
	}
	for i, r := range m.runs {
		var stats map[string]any
		_ = json.Unmarshal([]byte(r.StatsJSON), &stats)
		summary := fmt.Sprintf("sourced=%v evaluated=%v sent=%v queued=%v",
			stats["sourced"], stats["evaluated"], stats["sent"], stats["queued"])
		line := fmt.Sprintf("%s  [%s]  %s  %s", r.CreatedAt, r.RunType, r.RunID, summary)
		if i == m.cursor {
			b.WriteString(rowSelectedStyle.Render("▸ " + line))
		} else {
			b.WriteString(rowNormalStyle.Render("  " + line))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// ── footer ───────────────────────────────────────────────────────────────

func (m model) renderFooter() string {
	hints := "tab/1-4 view · j/k nav · enter detail · s status · d mark outreach · f filter · / search · r refresh · q quit"
	line := keyHintStyle.Render(hints)

	if m.statusMsg != "" {
		style := statusMsgStyle
		if m.isError {
			style = errMsgStyle
		}
		line += "\n" + style.Render(m.statusMsg)
	}
	return footerStyle.Render(line)
}

// ── small helpers ────────────────────────────────────────────────────────

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return s[:n]
	}
	return s[:n-1] + "…"
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

func stripPad(s string) string { return strings.TrimRight(s, " ") }

func wrap(s string, width int) string {
	words := strings.Fields(s)
	if len(words) == 0 {
		return s
	}
	var lines []string
	cur := words[0]
	for _, w := range words[1:] {
		if len(cur)+1+len(w) > width {
			lines = append(lines, cur)
			cur = w
		} else {
			cur += " " + w
		}
	}
	lines = append(lines, cur)
	return strings.Join(lines, "\n")
}

func jsonListToLines(jsonStr string) string {
	if strings.TrimSpace(jsonStr) == "" {
		return ""
	}
	var items []string
	if err := json.Unmarshal([]byte(jsonStr), &items); err != nil {
		// skill_gap may be stored as a comma-separated string (legacy field) —
		// fall back to that rather than show raw JSON.
		return strings.ReplaceAll(jsonStr, ",", ", ")
	}
	for i, it := range items {
		items[i] = "• " + it
	}
	return strings.Join(items, "\n")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
