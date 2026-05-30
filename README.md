# Claude Code Token Monitor

**Track, analyze, and optimize your Claude Code Max token usage.**

A full-stack monitoring dashboard that parses your local Claude Code session files, identifies what consumes your tokens, shows when you actually hit rate limits, and gives you actionable recommendations to stay under the limit.

> Designed and built by **Eyal Rosenfeld** ([@eyalushke](https://github.com/eyalushke))

---

## What It Does

Claude Code Max subscribers get a rolling 5-hour token window. When you exceed it, Claude locks you out until the window resets. This dashboard gives you full transparency into:

- **What happened before each lockout** - drill down into every session, subagent, tool call, and project that contributed
- **Hourly token usage by project** - navigable per-day chart with rate limit markers at the exact minute
- **Which tools eat your tokens** - Read, Bash, Edit, Agent, WebFetch ranked by consumption
- **Which projects are heaviest** - per-project token breakdown over time
- **Cumulative buildup by project** - stacked area chart showing how each project contributed to a throttle event
- **Real rate limit detection** - uses actual "You've hit your limit" events from your logs, not estimates
- **Optimization recommendations** - auto-generated tips based on your real usage patterns
- **Local timezone support** - all chart times display in your local timezone

## Architecture

```
~/.claude/projects/*.jsonl     (Claude Code writes these automatically)
         |
         v
  Python ingestion script      (parses JSONL, runs locally every 6hr via scheduler)
         |
         v
  Supabase PostgreSQL           (claude_monitor schema, RLS-protected)
         |
         v
  Next.js Dashboard on Vercel   (dark/light theme, mobile + desktop)
```

**Key design decision:** No Anthropic API key needed. The dashboard reads JSONL files that Claude Code already saves to `~/.claude/projects/` on your machine. Zero extra token cost.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, Recharts |
| Database | Supabase (PostgreSQL) with dedicated `claude_monitor` schema |
| Ingestion | Python 3.9+ with supabase-py |
| Hosting | Vercel |
| Auto-sync | macOS LaunchAgent / Windows Task Scheduler / Linux cron |

## Dashboard Pages

| Route | Page | Description |
|-------|------|-------------|
| `/` | Overview | KPI gauges, token timeline by project, model distribution, daily activity with throttle markers |
| `/limits` | Limit Analysis | Hourly token usage by project with date navigation, rate limit markers, per-event drill-down with cumulative buildup by project, session hierarchy |
| `/tokens` | Tokens | Token type breakdown (input/output/cached), cache efficiency, model comparison |
| `/tools` | Tools | Tool-level analysis - which tools consume the most tokens |
| `/projects` | Projects | Per-project treemap and comparison table |
| `/costs` | Costs | Equivalent API cost tracking and value analysis |
| `/recommendations` | Tips | Auto-generated optimization suggestions based on your data |

---

## Setup Guide (Step by Step)

### Prerequisites

- **macOS, Windows, or Linux** with Claude Code installed (the JSONL files live at `~/.claude/projects/`)
- **Node.js 18+** and **npm**
- **Python 3.9+**
- A free **Supabase** account ([supabase.com](https://supabase.com))
- A free **Vercel** account ([vercel.com](https://vercel.com)) - optional, for hosting

### Step 1: Clone the Repository

```bash
git clone https://github.com/eyalushke/claude-monitor-tokens.git
cd claude-monitor-tokens
```

### Step 2: Verify .gitignore Works

Before touching any config, confirm secrets won't be tracked:

```bash
# Create dummy env files
echo "TEST=secret" > .env.local
echo "TEST=secret" > scripts/.env

# Verify they're ignored
git status
# Should show NO .env.local or scripts/.env in the output

# Clean up
rm .env.local scripts/.env
```

### Step 3: Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Note your project URL and keys from **Settings > API > Project API keys**:
   - `Project URL` (e.g., `https://xxxxx.supabase.co`)
   - `anon/public key` (starts with `eyJ...`)
   - `service_role key` (starts with `eyJ...`) - keep this secret!

### Step 4: Run Database Migrations

In your Supabase project, go to **SQL Editor** and run these files **in order**:

```
1. supabase/migrations/001_create_tables.sql        -- Creates tables in claude_monitor schema
2. supabase/migrations/002_expose_schema.sql         -- Exposes schema to PostgREST API
3. supabase/migrations/004_rate_limit_events.sql     -- Adds rate limit event tracking
4. supabase/migrations/005_remove_public_objects.sql -- Cleanup (removes any stale public objects)
5. supabase/migrations/006_fix_advisor_warnings.sql  -- Resolves Supabase Advisor warnings
6. supabase/migrations/007_drop_unused_tool_usage.sql -- Drops the unused tool_usage table
```

> **Note on numbering:** There is no `003_*.sql`. An early `003` migration created
> objects in the `public` schema; it was removed when everything moved to the
> `claude_monitor` schema (the `005` cleanup migration handles any leftovers). The gap
> is intentional — just run the files listed above in order.

> **Important:** All tables live in the `claude_monitor` schema, NOT in `public`. After running `002_expose_schema.sql`, go to **Settings > API > Data API Settings > Exposed schemas** and verify `claude_monitor` appears in the list. If not, add it manually and restart the project from **Settings > General > Restart project**.

### Step 5: Configure Environment (Dashboard)

```bash
cp .env.local.example .env.local
```

Edit `.env.local` with your Supabase credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
NEXT_PUBLIC_PLAN_TYPE=max5          # or: pro, max20
NEXT_PUBLIC_PLAN_TOKEN_LIMIT=88000  # pro=44000, max5=88000, max20=220000
NEXT_PUBLIC_PLAN_WINDOW_HOURS=5
```

### Step 6: Install and Run the Dashboard

```bash
npm install
npm run dev
```

Visit **http://localhost:3000** to see the dashboard (needs Supabase data after ingestion).

### Step 7: Configure the Ingestion Script

```bash
cd scripts
pip3 install -r requirements.txt
cp .env.example .env
```

Edit `scripts/.env`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here
CLAUDE_DIR=~/.claude
```

### Step 8: Test the Ingestion (Dry Run)

```bash
python3 ingest.py --dry-run
```

This parses all your JSONL files without writing to the database. You should see output like:

```
Found 572 JSONL files
Parsed 532 sessions, 24084 messages, 18 rate limit events
--- DRY RUN SUMMARY ---
Sessions: 532
Messages: 24084
Total input tokens: 1,807,705
Total output tokens: 11,128,705
```

### Step 9: Run Real Ingestion

```bash
python3 ingest.py
```

This pushes all parsed data to Supabase. Takes about 20-30 seconds for the first full run. Subsequent runs are incremental (only new/modified files).

Now visit **http://localhost:3000** - your dashboard should show real data!

### Step 10: Set Up Scheduled Auto-Sync

The ingestion script needs to run periodically to keep the dashboard up to date. Choose the method for your operating system:

---

#### macOS (LaunchAgent) - Recommended

Run the included setup script:

```bash
bash scripts/setup-launchd.sh
```

This installs a macOS LaunchAgent that:
- Runs the ingestion script **every 6 hours**
- Also runs **on login** (when your Mac wakes from sleep)
- Logs to `~/Library/Logs/claude-monitor-ingest.log`

**How it works:** macOS `launchd` is the system scheduler. A LaunchAgent runs in your user session - it starts when you log in and pauses when your Mac sleeps. When the Mac wakes up and the 6-hour interval has elapsed, it runs immediately.

The setup script creates a plist file at `~/Library/LaunchAgents/com.claude-monitor.ingest.plist`. See [`scripts/setup-launchd.sh`](scripts/setup-launchd.sh) for the full source.

**Useful commands:**

```bash
# Run sync manually right now
launchctl start com.claude-monitor.ingest

# Check the log
tail -f ~/Library/Logs/claude-monitor-ingest.log

# Stop auto-sync
launchctl unload ~/Library/LaunchAgents/com.claude-monitor.ingest.plist

# Re-enable auto-sync
launchctl load ~/Library/LaunchAgents/com.claude-monitor.ingest.plist
```

---

#### Windows (Task Scheduler)

1. Open **Task Scheduler** (search for it in the Start menu)

2. Click **Create Basic Task**:
   - Name: `Claude Monitor Ingest`
   - Trigger: **Daily**, set start time, then check **Repeat task every 6 hours** for a duration of **Indefinitely**
   - Action: **Start a program**
   - Program: `python3` (or full path like `C:\Python39\python.exe`)
   - Arguments: `C:\path\to\claude-monitor-tokens\scripts\ingest.py`
   - Start in: `C:\path\to\claude-monitor-tokens\scripts`

3. In the task properties, under **Conditions**:
   - Uncheck "Start the task only if the computer is on AC power"
   - Check "Wake the computer to run this task" (optional)

4. Under **Settings**:
   - Check "Run task as soon as possible after a scheduled start is missed"
   - This ensures it runs after sleep/hibernate

**Or use PowerShell** to create it programmatically:

```powershell
$action = New-ScheduledTaskAction `
    -Execute "python3" `
    -Argument "C:\path\to\claude-monitor-tokens\scripts\ingest.py" `
    -WorkingDirectory "C:\path\to\claude-monitor-tokens\scripts"

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Hours 6) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries

Register-ScheduledTask `
    -TaskName "Claude Monitor Ingest" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Sync Claude Code token usage to Supabase every 6 hours"
```

**Note:** On Windows, Claude Code stores sessions at `%USERPROFILE%\.claude\projects\`. Set `CLAUDE_DIR=%USERPROFILE%\.claude` in your `scripts/.env`.

---

#### Linux (cron)

Add a cron job that runs every 6 hours:

```bash
crontab -e
```

Add this line (adjust the path):

```cron
0 */6 * * * cd /path/to/claude-monitor-tokens/scripts && /usr/bin/python3 ingest.py >> ~/claude-monitor-ingest.log 2>&1
```

This runs at minute 0 of every 6th hour (00:00, 06:00, 12:00, 18:00). The cron daemon handles missed runs when the machine was asleep — the job runs at the next scheduled time after wake.

For **systemd timer** (alternative to cron, runs after sleep):

```bash
# Create ~/. config/systemd/user/claude-monitor.service
[Unit]
Description=Claude Monitor Token Ingestion

[Service]
Type=oneshot
WorkingDirectory=/path/to/claude-monitor-tokens/scripts
ExecStart=/usr/bin/python3 ingest.py
```

```bash
# Create ~/.config/systemd/user/claude-monitor.timer
[Unit]
Description=Run Claude Monitor ingestion every 6 hours

[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now claude-monitor.timer
```

The `Persistent=true` flag ensures the timer fires after sleep/suspend if the interval was missed.

---

### Step 11: Deploy to Vercel (Optional)

```bash
npx vercel link
npx vercel env add NEXT_PUBLIC_SUPABASE_URL production
npx vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
npx vercel env add SUPABASE_SERVICE_ROLE_KEY production
npx vercel env add NEXT_PUBLIC_PLAN_TYPE production
npx vercel env add NEXT_PUBLIC_PLAN_TOKEN_LIMIT production
npx vercel env add NEXT_PUBLIC_PLAN_WINDOW_HOURS production
npx vercel --prod
```

---

## Security

| Check | Status |
|-------|--------|
| Hardcoded secrets in source code | None |
| Secrets in git history | None |
| `.env` files tracked by git | No - properly gitignored |
| Service role key exposed to browser | No - server-only with `import "server-only"` guard |
| Supabase RLS | Enabled on all tables; anon role is read-only |
| API routes | None exist - no server-side attack surface |

The `NEXT_PUBLIC_SUPABASE_ANON_KEY` is the only key visible in the browser. It's the publishable/anon key restricted by Row Level Security to SELECT-only queries.

---

## Data Model

All tables live in the `claude_monitor` schema in Supabase.

| Table | Description | Key Fields |
|-------|-------------|------------|
| `sessions` | One row per Claude Code session | id, project_name, started_at, total_*_tokens, is_subagent |
| `messages` | One row per assistant response | session_id, model, input_tokens, output_tokens, cache_*, tool_names |
| `daily_aggregates` | Pre-computed daily summaries | date, project_name, model, token totals |
| `tool_daily_aggregates` | Per-tool daily summaries | date, tool_name, invocation_count, associated tokens |
| `rate_limit_events` | Actual "You've hit your limit" events | timestamp, reset_message, tokens_in_window_* |
| `sync_state` | Tracks ingestion progress | last_sync_at, files_processed, status |

---

## How the Ingestion Works

The Python script ([`scripts/ingest.py`](scripts/ingest.py)) reads JSONL files from `~/.claude/projects/`:

1. **Parses** each line as JSON, extracting `type: "assistant"` records with `message.usage` data
2. **Extracts** token counts (input, output, cache_read, cache_creation), tool names, model, session ID
3. **Detects** rate limit events from `"You've hit your limit"` text in assistant messages
4. **Aggregates** into daily summaries by project, model, and tool
5. **Upserts** everything to Supabase (idempotent - safe to re-run)

Flags:
- `--dry-run` - Parse and report without writing to DB
- `--force` - Re-process all files regardless of modification time

### Scripts Reference

| Script | Description |
|--------|-------------|
| [`scripts/ingest.py`](scripts/ingest.py) | Main ingestion script - parses JSONL files and pushes to Supabase |
| [`scripts/setup-launchd.sh`](scripts/setup-launchd.sh) | macOS LaunchAgent installer - sets up 6-hour auto-sync |
| [`scripts/sync-now.sh`](scripts/sync-now.sh) | One-liner to manually trigger ingestion |
| [`scripts/trigger_server.py`](scripts/trigger_server.py) | Optional localhost HTTP server for browser-triggered sync (advanced) |
| [`scripts/requirements.txt`](scripts/requirements.txt) | Python dependencies |
| [`scripts/.env.example`](scripts/.env.example) | Template for ingestion environment variables |

---

## FAQ

**Q: Does this use my Claude Code tokens?**
A: No. It reads files already on your disk. Zero API calls to Anthropic.

**Q: What's the "88K limit"?**
A: Community-estimated token limit for Max5 per 5-hour window. Our analysis shows the actual threshold is dynamic and varies based on cache usage. The dashboard tracks real throttle events instead of guessing.

**Q: Can I use this with Claude Code Pro (not Max)?**
A: Yes. Change `NEXT_PUBLIC_PLAN_TYPE=pro` and `NEXT_PUBLIC_PLAN_TOKEN_LIMIT=44000` in your `.env.local`.

**Q: Does it work on Linux/Windows?**
A: Yes. The dashboard (Next.js) works anywhere. The ingestion script works on any OS with Python 3.9+ and access to `~/.claude/projects/`. See [Step 10](#step-10-set-up-scheduled-auto-sync) for platform-specific scheduling instructions.

**Q: How do I change the sync interval?**
A: On macOS, edit `~/Library/LaunchAgents/com.claude-monitor.ingest.plist` and change the `StartInterval` value (in seconds). Default is `21600` (6 hours). Then reload: `launchctl unload <plist> && launchctl load <plist>`.

**Q: What happens when my computer sleeps?**
A: The scheduler pauses during sleep. On wake, it checks if the interval has elapsed and runs immediately if so. No data is lost - the script processes all files modified since the last sync.

**Q: How do I update after pulling new code?**
A: `npm install && npm run build` for the dashboard. `pip3 install -r scripts/requirements.txt` for the ingestion.

---

## License

MIT

---

Built with Claude Code, for Claude Code users.
