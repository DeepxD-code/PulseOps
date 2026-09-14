# PulseOps — Windows Task Scheduler Setup

For running PulseOps unattended on a Windows machine instead of Linux
cron or GitHub Actions. See `CRON.md` for the Linux/macOS and GitHub
Actions equivalents.

## Quick setup (GUI)

1. Open **Task Scheduler** → **Create Task** (not "Create Basic Task" —
   the full dialog gives you more control over working directory and
   retry behavior).
2. **General tab:**
   - Name: `PulseOps Daily Pipeline`
   - "Run whether user is logged on or not"
   - "Run with highest privileges" — unchecked (not needed)
3. **Triggers tab → New:**
   - Daily, start time `09:00:00`, recur every 1 day
4. **Actions tab → New:**
   - Action: Start a program
   - Program/script: `python.exe` (or the full path from `where python`)
   - Add arguments: `main.py`
   - Start in: `C:\path\to\pulseops` ← **critical** — without this,
     `.env` and `config/*.yml` won't resolve and the run will fail the
     same way a misconfigured cron job would.
5. **Conditions tab:** uncheck "Start the task only if the computer is on
   AC power" if this is a laptop.
6. **Settings tab:** check "If the task fails, restart every" → 10 minutes,
   up to 3 attempts — covers transient network blips in the LLM cascade.

Repeat for the weekly scan: trigger **Weekly, Sunday, 08:00:00**,
arguments `main_weekly.py`.

## Import via XML (faster than the wizard)

Save each block below as a `.xml` file, then:

```powershell
schtasks /create /tn "PulseOps Daily Pipeline" /xml "pulseops-daily.xml"
schtasks /create /tn "PulseOps Weekly Scan" /xml "pulseops-weekly.xml"
```

Replace `C:\path\to\pulseops` and the `python.exe` path with your actual
install locations before importing (`where python` to find yours).

**pulseops-daily.xml**
```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T09:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <RestartOnFailure>
      <Interval>PT10M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions>
    <Exec>
      <Command>python.exe</Command>
      <Arguments>main.py</Arguments>
      <WorkingDirectory>C:\path\to\pulseops</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
```

**pulseops-weekly.xml**
```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-04T08:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <WeeksInterval>1</WeeksInterval>
        <DaysOfWeek><Sunday /></DaysOfWeek>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <RestartOnFailure>
      <Interval>PT10M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions>
    <Exec>
      <Command>python.exe</Command>
      <Arguments>main_weekly.py</Arguments>
      <WorkingDirectory>C:\path\to\pulseops</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
```

## Verifying it actually ran

Task Scheduler's own history tab only tells you the process exit code,
not whether the pipeline did anything useful. Check instead:

```powershell
type logs\audit_2026-06.jsonl | findstr RUN_END
```

or open the Flask dashboard (`python main.py --dashboard`) and look at the
**runs** view, which reads `run_stats` directly — the same table both the
Flask dashboard and the Go TUI use.
