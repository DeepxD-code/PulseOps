# PulseOps TUI

A read-mostly Go terminal dashboard (Bubble Tea + Lipgloss, Catppuccin Mocha
theme) over the same `pulseops.db` SQLite file the Python pipeline writes to.
It is the Career-Ops-inspired counterpart to the Flask dashboard
(`dashboard/app.py`) — same data, keyboard-first instead of browser-first.

Deferred per the build plan until the core daily loop has produced enough
real rows to be worth browsing (see `pulseops_master_prompt.md`, Phase 10).
The code is complete and compiles; it's documented here for whenever you
want to wire it into your cron/launchd routine.

## Build

```bash
cd dashboard/tui
go mod tidy      # fetches bubbletea, lipgloss, modernc.org/sqlite
go build -o pulseops-tui .
```

> **Sandboxed/offline build environments:** `go mod tidy` needs
> `proxy.golang.org` (or direct git access to `modernc.org`, which is a
> vanity import redirecting to a real VCS host). If your network blocks
> both, vendor the three dependencies locally or build on a machine with
> normal internet access — there's nothing PulseOps-specific blocking it,
> it's a standard `go mod tidy` fetch.

## Run

```bash
# from the repo root (uses ./pulseops.db by default)
./dashboard/tui/pulseops-tui

# or point at a specific DB
./dashboard/tui/pulseops-tui -db /path/to/pulseops.db
```

## Keybindings

| Key            | Action                                              |
|----------------|------------------------------------------------------|
| `tab` / `1`-`4`| Switch view: jobs · queue · memory · runs            |
| `j`/`k`, `↑`/`↓`| Move cursor                                          |
| `enter`        | Open job detail (jobs view)                          |
| `s`            | Cycle the selected job's status (writes to DB)       |
| `f`            | Cycle the quick status filter (jobs view)             |
| `/`            | Search title/company — `enter` applies, `esc` cancels|
| `r`            | Refresh the current view                              |
| `q` / `ctrl+c` | Quit                                                  |

## Design notes

- **No write path beyond status overrides.** Sends, evaluations, and resume
  builds only ever happen inside `main.py`. The TUI (like the Flask
  dashboard) can move a job between pipeline statuses by hand — useful for
  marking something `phone_screen` the moment you get a call, which then
  trips the interview-prep auto-trigger on the next pipeline run.
- **Single SQLite connection (`SetMaxOpenConns(1)`).** Avoids lock
  contention with the Python pipeline's own connections during a
  concurrent `main.py` run; reads are quick enough that this isn't a
  bottleneck for a single-user CLI tool.
- **Pure-Go SQLite driver (`modernc.org/sqlite`).** No cgo, no C toolchain
  required to build — matters if you ever cross-compile this for another
  machine.
