package main

import "github.com/charmbracelet/lipgloss"

// Catppuccin Mocha palette (https://github.com/catppuccin/catppuccin)
var (
	mochaBase     = lipgloss.Color("#1e1e2e")
	mochaMantle   = lipgloss.Color("#181825")
	mochaCrust    = lipgloss.Color("#11111b")
	mochaText     = lipgloss.Color("#cdd6f4")
	mochaSubtext1 = lipgloss.Color("#bac2de")
	mochaSubtext0 = lipgloss.Color("#a6adc8")
	mochaOverlay1 = lipgloss.Color("#7f849c")
	mochaOverlay0 = lipgloss.Color("#6c7086")
	mochaSurface1 = lipgloss.Color("#45475a")
	mochaSurface0 = lipgloss.Color("#313244")
	mochaBlue     = lipgloss.Color("#89b4fa")
	mochaLavender = lipgloss.Color("#b4befe")
	mochaSapphire = lipgloss.Color("#74c7ec")
	mochaSky      = lipgloss.Color("#89dceb")
	mochaTeal     = lipgloss.Color("#94e2d5")
	mochaGreen    = lipgloss.Color("#a6e3a1")
	mochaYellow   = lipgloss.Color("#f9e2af")
	mochaPeach    = lipgloss.Color("#fab387")
	mochaMaroon   = lipgloss.Color("#eba0ac")
	mochaRed      = lipgloss.Color("#f38ba8")
	mochaMauve    = lipgloss.Color("#cba6f7")
	mochaPink     = lipgloss.Color("#f5c2e7")
)

var (
	appStyle = lipgloss.NewStyle().
			Background(mochaBase).
			Foreground(mochaText)

	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(mochaCrust).
			Background(mochaMauve).
			Padding(0, 1)

	subtitleStyle = lipgloss.NewStyle().
			Foreground(mochaSubtext0).
			Italic(true)

	tabActiveStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(mochaCrust).
			Background(mochaBlue).
			Padding(0, 2)

	tabInactiveStyle = lipgloss.NewStyle().
				Foreground(mochaSubtext0).
				Background(mochaSurface0).
				Padding(0, 2)

	headerBarStyle = lipgloss.NewStyle().
			BorderStyle(lipgloss.NormalBorder()).
			BorderForeground(mochaSurface1).
			BorderBottom(true).
			Width(100)

	footerStyle = lipgloss.NewStyle().
			Foreground(mochaSubtext0).
			Background(mochaMantle).
			Padding(0, 1)

	keyHintStyle = lipgloss.NewStyle().
			Foreground(mochaPeach).
			Bold(true)

	rowNormalStyle = lipgloss.NewStyle().
			Foreground(mochaText)

	rowSelectedStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(mochaCrust).
				Background(mochaLavender)

	rowDimStyle = lipgloss.NewStyle().
			Foreground(mochaOverlay0)

	statusMsgStyle = lipgloss.NewStyle().
			Foreground(mochaGreen).
			Bold(true)

	errMsgStyle = lipgloss.NewStyle().
			Foreground(mochaRed).
			Bold(true)

	searchBoxStyle = lipgloss.NewStyle().
			Foreground(mochaSky).
			Background(mochaSurface0).
			Padding(0, 1)

	detailBoxStyle = lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(mochaMauve).
			Padding(1, 2).
			Width(96)

	detailKeyStyle = lipgloss.NewStyle().
			Foreground(mochaPeach).
			Bold(true)

	detailValStyle = lipgloss.NewStyle().
			Foreground(mochaText)

	emptyStateStyle = lipgloss.NewStyle().
			Foreground(mochaOverlay1).
			Italic(true).
			Padding(2, 0)
)

// gradeStyle returns a colored badge style for a letter grade (A/B/C/D/F).
func gradeStyle(grade string) lipgloss.Style {
	base := lipgloss.NewStyle().Bold(true).Padding(0, 1)
	switch grade {
	case "A":
		return base.Foreground(mochaCrust).Background(mochaGreen)
	case "B":
		return base.Foreground(mochaCrust).Background(mochaTeal)
	case "C":
		return base.Foreground(mochaCrust).Background(mochaYellow)
	case "D":
		return base.Foreground(mochaCrust).Background(mochaPeach)
	default:
		return base.Foreground(mochaCrust).Background(mochaRed)
	}
}

// statusStyle colors a job/queue status string.
func statusStyle(status string) lipgloss.Style {
	switch status {
	case "Sent", "FollowupSent", "Replied", "accepted", "offer":
		return lipgloss.NewStyle().Foreground(mochaGreen)
	case "phone_screen", "technical", "final":
		return lipgloss.NewStyle().Foreground(mochaSapphire)
	case "Queued":
		return lipgloss.NewStyle().Foreground(mochaYellow)
	case "rejected", "manual_required":
		return lipgloss.NewStyle().Foreground(mochaRed)
	default:
		return lipgloss.NewStyle().Foreground(mochaSubtext0)
	}
}
