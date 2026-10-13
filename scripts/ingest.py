#!/usr/bin/env python3
"""
Claude Code Token Usage Ingestion Script

Parses JSONL session files from ~/.claude/projects/ and pushes
structured token usage data to Supabase for the monitoring dashboard.

Usage:
    python3 ingest.py              # Full ingestion
    python3 ingest.py --dry-run    # Parse only, no DB writes
    python3 ingest.py --force      # Re-process all files regardless of mtime
    python3 ingest.py --rebuild-aggregates  # Recompute all daily aggregates from the messages table
"""

import json
import logging
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

load_dotenv(Path(__file__).parent / ".env")

DRY_RUN = "--dry-run" in sys.argv
FORCE = "--force" in sys.argv
REBUILD_AGGREGATES = "--rebuild-aggregates" in sys.argv
CLAUDE_DIR = Path(os.getenv("CLAUDE_DIR", "~/.claude")).expanduser()
PROJECTS_DIR = CLAUDE_DIR / "projects"
BATCH_SIZE = 500
# Must not exceed the PostgREST max-rows setting (Supabase default: 1000)
PAGE_SIZE = 1000
DB_SCHEMA = "claude_monitor"
AGG_MESSAGE_COLUMNS = (
    "id,session_id,timestamp,model,input_tokens,output_tokens,cache_read_tokens,"
    "cache_creation_tokens,tool_names,tool_count,web_search_requests"
)

_FRAC_RE = re.compile(r"\.(\d+)")


def parse_iso_timestamp(value: str) -> datetime:
    """Parse an ISO-8601 timestamp tolerant of variable fractional-second precision.

    Postgres TIMESTAMPTZ values come back from PostgREST with trailing zeros
    trimmed (e.g. '2026-05-27T09:27:18.1936+00:00'), which Python 3.9's
    datetime.fromisoformat() rejects — it only accepts 0, 3, or 6 fractional
    digits. Normalize the fractional part to 6 digits and 'Z' to '+00:00' first.
    """
    s = value.strip().replace("Z", "+00:00")
    s = _FRAC_RE.sub(lambda m: "." + (m.group(1) + "000000")[:6], s)
    return datetime.fromisoformat(s)


def extract_project_name(encoded_path: str) -> str:
    """Extract human-readable project name from encoded directory path."""
    prefixes = [
        ("conductor-workspaces-", True),
        ("conductor-repos-", False),
        ("Documents-GitHub-", False),
    ]
    for prefix, is_workspace in prefixes:
        idx = encoded_path.find(prefix)
        if idx != -1:
            remainder = encoded_path[idx + len(prefix) :]
            if is_workspace:
                parts = remainder.rsplit("-", 1)
                return parts[0] if len(parts) > 1 else remainder
            return remainder

    parts = encoded_path.lstrip("-").split("-")
    return "-".join(parts[-3:]) if len(parts) >= 3 else encoded_path


def parse_session_path(file_path: Path) -> dict[str, Any]:
    """Extract session metadata from file path structure."""
    parts = file_path.parts
    projects_idx = None
    for i, p in enumerate(parts):
        if p == "projects":
            projects_idx = i
            break

    if projects_idx is None:
        return {}

    project_dir = parts[projects_idx + 1] if len(parts) > projects_idx + 1 else ""
    project_name = extract_project_name(project_dir)

    is_subagent = "subagents" in parts
    session_id = None
    agent_id = None

    if is_subagent:
        for i, p in enumerate(parts):
            if p == "subagents" and i > 0:
                session_id = parts[i - 1]
                agent_file = file_path.stem
                agent_id = agent_file.replace("agent-", "")
                break
    else:
        session_id = file_path.stem

    return {
        "project_path": project_dir,
        "project_name": project_name,
        "session_id": session_id or file_path.stem,
        "is_subagent": is_subagent,
        "agent_id": agent_id,
    }


def parse_jsonl_file(file_path: Path) -> list[dict[str, Any]]:
    """Parse a JSONL file and extract assistant messages with usage data."""
    records: list[dict[str, Any]] = []
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if record.get("type") == "assistant":
                    msg = record.get("message", {})

                    # Detect rate limit events
                    for content_item in msg.get("content", []):
                        if isinstance(content_item, dict) and content_item.get("type") == "text":
                            text = content_item.get("text", "")
                            if "hit your limit" in text.lower():
                                records.append({
                                    "type": "rate_limit",
                                    "timestamp": record.get("timestamp"),
                                    "reset_message": text,
                                    "session_id": record.get("sessionId"),
                                })

                    usage = msg.get("usage", {})
                    if not usage:
                        continue

                    tool_names = []
                    for content_item in msg.get("content", []):
                        if isinstance(content_item, dict) and content_item.get("type") == "tool_use":
                            name = content_item.get("name", "unknown")
                            tool_names.append(name)

                    cache_creation = usage.get("cache_creation", {})

                    records.append({
                        "type": "assistant",
                        "message_uuid": record.get("uuid"),
                        "timestamp": record.get("timestamp"),
                        "model": msg.get("model", "unknown"),
                        "input_tokens": usage.get("input_tokens", 0),
                        "output_tokens": usage.get("output_tokens", 0),
                        "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
                        "cache_creation_tokens": usage.get("cache_creation_input_tokens", 0),
                        "cache_1h_tokens": cache_creation.get("ephemeral_1h_input_tokens", 0),
                        "cache_5m_tokens": cache_creation.get("ephemeral_5m_input_tokens", 0),
                        "web_search_requests": usage.get("server_tool_use", {}).get("web_search_requests", 0),
                        "web_fetch_requests": usage.get("server_tool_use", {}).get("web_fetch_requests", 0),
                        "service_tier": usage.get("service_tier"),
                        "speed": usage.get("speed"),
                        "tool_names": tool_names,
                        "tool_count": len(tool_names),
                        "session_id": record.get("sessionId"),
                        "git_branch": record.get("gitBranch"),
                        "claude_version": record.get("version"),
                    })

                elif record.get("type") == "user":
                    records.append({
                        "type": "user",
                        "timestamp": record.get("timestamp"),
                        "session_id": record.get("sessionId"),
                    })

    except Exception as e:
        log.error(f"Error reading {file_path}: {e}")

    return records


def build_session_data(
    path_meta: dict[str, Any],
    records: list[dict[str, Any]],
) -> dict[str, Any]:
    """Aggregate record data into a session summary."""
    timestamps = [r["timestamp"] for r in records if r.get("timestamp")]
    timestamps.sort()

    assistant_records = [r for r in records if r["type"] == "assistant"]

    total_input = sum(r.get("input_tokens", 0) for r in assistant_records)
    total_output = sum(r.get("output_tokens", 0) for r in assistant_records)
    total_cache_read = sum(r.get("cache_read_tokens", 0) for r in assistant_records)
    total_cache_creation = sum(r.get("cache_creation_tokens", 0) for r in assistant_records)
    total_tools = sum(r.get("tool_count", 0) for r in assistant_records)

    git_branch = None
    claude_version = None
    for r in assistant_records:
        if r.get("git_branch"):
            git_branch = r["git_branch"]
        if r.get("claude_version"):
            claude_version = r["claude_version"]

    session_id = path_meta["session_id"]
    if path_meta["is_subagent"] and path_meta.get("agent_id"):
        session_id = f"{path_meta['session_id']}/{path_meta['agent_id']}"

    return {
        "id": session_id,
        "project_path": path_meta["project_path"],
        "project_name": path_meta["project_name"],
        "started_at": timestamps[0] if timestamps else datetime.now(timezone.utc).isoformat(),
        "ended_at": timestamps[-1] if timestamps else None,
        "message_count": len(assistant_records),
        "tool_call_count": total_tools,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "total_cache_read_tokens": total_cache_read,
        "total_cache_creation_tokens": total_cache_creation,
        "git_branch": git_branch,
        "claude_version": claude_version,
        "is_subagent": path_meta["is_subagent"],
        "parent_session_id": path_meta["session_id"] if path_meta["is_subagent"] else None,
    }


def compute_daily_aggregates(
    all_messages: list[dict[str, Any]],
    session_map: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Compute daily aggregates from messages."""
    daily: dict[tuple[str, str, str], dict[str, Any]] = {}
    tool_daily: dict[tuple[str, str], dict[str, int]] = {}

    sessions_by_date: dict[str, set[str]] = defaultdict(set)

    for msg in all_messages:
        ts = msg.get("timestamp")
        if not ts:
            continue
        date_str = ts[:10]
        session_id = msg.get("session_id", "")
        session = session_map.get(session_id, {})
        project_name = session.get("project_name", "unknown")
        model = msg.get("model", "unknown")

        key = (date_str, project_name, model)
        if key not in daily:
            daily[key] = {
                "date": date_str,
                "project_name": project_name,
                "model": model,
                "session_count": 0,
                "message_count": 0,
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "total_cache_read_tokens": 0,
                "total_cache_creation_tokens": 0,
                "total_tool_calls": 0,
                "web_search_count": 0,
            }

        d = daily[key]
        d["message_count"] += 1
        d["total_input_tokens"] += msg.get("input_tokens", 0)
        d["total_output_tokens"] += msg.get("output_tokens", 0)
        d["total_cache_read_tokens"] += msg.get("cache_read_tokens", 0)
        d["total_cache_creation_tokens"] += msg.get("cache_creation_tokens", 0)
        d["total_tool_calls"] += msg.get("tool_count", 0)
        d["web_search_count"] += msg.get("web_search_requests", 0)

        sessions_by_date[f"{date_str}|{project_name}|{model}"].add(session_id)

        for tool_name in msg.get("tool_names", []):
            tk = (date_str, tool_name)
            if tk not in tool_daily:
                tool_daily[tk] = {
                    "date": date_str,
                    "tool_name": tool_name,
                    "invocation_count": 0,
                    "associated_input_tokens": 0,
                    "associated_output_tokens": 0,
                }
            td = tool_daily[tk]
            td["invocation_count"] += 1
            td["associated_input_tokens"] += msg.get("input_tokens", 0)
            td["associated_output_tokens"] += msg.get("output_tokens", 0)

    for key_str, session_ids in sessions_by_date.items():
        date_str, project_name, model = key_str.split("|", 2)
        k = (date_str, project_name, model)
        if k in daily:
            daily[k]["session_count"] = len(session_ids)

    return list(daily.values()), list(tool_daily.values())


def upsert_batch(client: Any, table: str, rows: list[dict[str, Any]], conflict_cols: str) -> int:
    """Upsert a batch of rows to Supabase."""
    if not rows:
        return 0
    count = 0
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i : i + BATCH_SIZE]
        client.table(table).upsert(batch, on_conflict=conflict_cols).execute()
        count += len(batch)
    return count


def find_claude_config() -> Optional[Path]:
    """Locate Claude Code's global config (~/.claude.json, or inside CLAUDE_CONFIG_DIR)."""
    candidates = []
    if os.getenv("CLAUDE_CONFIG_FILE"):
        candidates.append(Path(os.environ["CLAUDE_CONFIG_FILE"]).expanduser())
    if os.getenv("CLAUDE_CONFIG_DIR"):
        candidates.append(Path(os.environ["CLAUDE_CONFIG_DIR"]).expanduser() / ".claude.json")
    candidates += [CLAUDE_DIR / ".claude.json", Path.home() / ".claude.json"]
    return next((p for p in candidates if p.is_file()), None)


def map_plan_type(organization_type: str, seat_tier: str, rate_limit_tier: str) -> Optional[str]:
    """Map Claude Code's account fields to a dashboard plan key (see PLAN_LIMITS in constants.ts)."""
    org, seat, tier = organization_type.lower(), seat_tier.lower(), rate_limit_tier.lower()
    if org == "claude_team" or seat.startswith("team_"):
        return "team_premium" if "premium" in seat else "team_standard"
    if org == "claude_max" or "max" in tier:
        return "max20" if "20x" in tier else "max5"
    if org == "claude_pro" or "pro" in tier:
        return "pro"
    return None


def detect_plan() -> Optional[dict[str, Any]]:
    """Read the plan from the account profile Claude Code caches locally.

    Only plan fields are read; identity fields (email, names, uuids) are ignored.
    """
    config_path = find_claude_config()
    if not config_path:
        log.warning("Claude config (.claude.json) not found; plan not detected")
        return None
    try:
        account = json.loads(config_path.read_text(encoding="utf-8")).get("oauthAccount") or {}
    except (OSError, json.JSONDecodeError) as e:
        log.warning(f"Could not read {config_path}: {e}; plan not detected")
        return None

    organization_type = account.get("organizationType") or ""
    seat_tier = account.get("seatTier") or ""
    rate_limit_tier = account.get("userRateLimitTier") or account.get("organizationRateLimitTier") or ""
    plan_type = map_plan_type(organization_type, seat_tier, rate_limit_tier)
    if not plan_type:
        log.warning(f"Unrecognised plan (organizationType={organization_type!r}, seatTier={seat_tier!r})")
    return {
        "plan_type": plan_type,
        "organization_type": organization_type or None,
        "seat_tier": seat_tier or None,
        "rate_limit_tier": rate_limit_tier or None,
        "plan_detected_at": datetime.now(timezone.utc).isoformat(),
    }


def record_plan(client: Any) -> None:
    """Store the detected plan on sync_state; never fails the sync (e.g. before migration 008)."""
    plan = detect_plan()
    if not plan:
        return
    log.info(f"Detected plan: {plan['plan_type']} (org={plan['organization_type']}, seat={plan['seat_tier']})")
    if client is None:
        return
    try:
        client.table("sync_state").update(plan).eq("id", 1).execute()
    except Exception as e:
        log.warning(f"Could not store plan on sync_state (has migration 008 been applied?): {e}")


def fetch_messages_for_date(client: Any, date_str: str) -> list[dict[str, Any]]:
    """Fetch every stored message for one UTC day, paginating past the PostgREST row cap."""
    start = f"{date_str}T00:00:00+00:00"
    end = f"{(datetime.fromisoformat(date_str) + timedelta(days=1)).date().isoformat()}T00:00:00+00:00"
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = (
            client.table("messages").select(AGG_MESSAGE_COLUMNS)
            .gte("timestamp", start).lt("timestamp", end)
            .order("id").range(offset, offset + PAGE_SIZE - 1)
            .execute().data
        )
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def fetch_session_projects(client: Any, session_ids: set[str]) -> dict[str, dict[str, Any]]:
    """Map session id -> {"project_name": ...} for the given sessions."""
    ids = sorted(session_ids)
    session_map: dict[str, dict[str, Any]] = {}
    for i in range(0, len(ids), 50):
        chunk = ids[i : i + 50]
        for row in client.table("sessions").select("id,project_name").in_("id", chunk).execute().data:
            session_map[row["id"]] = row
    return session_map


def delete_stale_keys(client: Any, table: str, date_str: str, key_cols: list[str], keep: set[tuple]) -> int:
    """Delete rows for a date whose key is not in the freshly recomputed set."""
    existing = client.table(table).select(",".join(["id"] + key_cols)).eq("date", date_str).execute().data
    stale_ids = [r["id"] for r in existing if tuple(r[c] for c in key_cols) not in keep]
    if stale_ids:
        client.table(table).delete().in_("id", stale_ids).execute()
    return len(stale_ids)


def recompute_aggregates_for_dates(client: Any, dates: set[str]) -> None:
    """Rebuild daily + tool aggregates for the given dates from the full messages table.

    Each run only parses files modified since the last sync, so aggregates computed from
    that batch alone would overwrite a day's totals with a partial count. Recomputing from
    the DB keeps every touched day complete, even when its messages span several runs.
    """
    for date_str in sorted(dates):
        messages = fetch_messages_for_date(client, date_str)
        session_map = fetch_session_projects(client, {m["session_id"] for m in messages})
        # Normalise DB rows to the shape compute_daily_aggregates expects
        for m in messages:
            m["tool_names"] = m.get("tool_names") or []
        daily_aggs, tool_aggs = compute_daily_aggregates(messages, session_map)

        if DRY_RUN:
            old = client.table("daily_aggregates").select("message_count").eq("date", date_str).execute().data
            old_count = sum(r["message_count"] for r in old)
            new_count = sum(r["message_count"] for r in daily_aggs)
            marker = "" if old_count == new_count else "  <-- changed"
            log.info(f"{date_str}: messages {old_count} -> {new_count}{marker}")
            continue

        upsert_batch(client, "daily_aggregates", daily_aggs, "date,project_name,model")
        upsert_batch(client, "tool_daily_aggregates", tool_aggs, "date,tool_name")
        stale = delete_stale_keys(
            client, "daily_aggregates", date_str, ["project_name", "model"],
            {(d["project_name"], d["model"]) for d in daily_aggs},
        )
        stale += delete_stale_keys(
            client, "tool_daily_aggregates", date_str, ["tool_name"],
            {(t["tool_name"],) for t in tool_aggs},
        )
        log.info(
            f"{date_str}: {len(messages)} messages -> {len(daily_aggs)} daily aggs, "
            f"{len(tool_aggs)} tool aggs ({stale} stale rows removed)"
        )


def rebuild_all_aggregates(client: Any) -> None:
    """Recompute aggregates for every day from the first stored message through today (UTC)."""
    first = client.table("messages").select("timestamp").order("timestamp").limit(1).execute().data
    if not first:
        log.info("No messages stored; nothing to rebuild")
        return
    day = parse_iso_timestamp(first[0]["timestamp"]).date()
    today = datetime.now(timezone.utc).date()
    dates: set[str] = set()
    while day <= today:
        dates.add(day.isoformat())
        day += timedelta(days=1)
    log.info(f"Rebuilding aggregates for {len(dates)} days ({min(dates)} .. {max(dates)})")
    recompute_aggregates_for_dates(client, dates)


def main() -> None:
    if DRY_RUN:
        log.info("=== DRY RUN MODE - No database writes ===")

    if not PROJECTS_DIR.exists():
        log.error(f"Projects directory not found: {PROJECTS_DIR}")
        sys.exit(1)

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY")

    client = None
    last_sync_mtime = None

    # --rebuild-aggregates reads from the DB, so it needs a client even in dry-run mode
    if not DRY_RUN or REBUILD_AGGREGATES:
        if not supabase_url or not supabase_key:
            log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")
            sys.exit(1)

        from supabase import create_client
        from supabase.lib.client_options import SyncClientOptions
        client = create_client(
            supabase_url,
            supabase_key,
            options=SyncClientOptions(schema=DB_SCHEMA),
        )

    if REBUILD_AGGREGATES:
        rebuild_all_aggregates(client)
        log.info("Aggregate rebuild complete!")
        return

    # Refresh the detected plan every run, even when no session files changed
    record_plan(client)

    if not DRY_RUN:
        if not FORCE:
            sync = client.table("sync_state").select("*").order("id", desc=True).limit(1).execute()
            if sync.data and sync.data[0].get("last_file_mtime"):
                raw_mtime = sync.data[0]["last_file_mtime"]
                try:
                    last_sync_mtime = parse_iso_timestamp(raw_mtime)
                    log.info(f"Last sync: {last_sync_mtime}")
                except ValueError as e:
                    log.warning(f"Unparseable last_file_mtime {raw_mtime!r}: {e}; reprocessing all files")
                    last_sync_mtime = None

        client.table("sync_state").update(
            {"status": "running", "last_sync_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", 1).execute()

    jsonl_files = sorted(PROJECTS_DIR.rglob("*.jsonl"))
    log.info(f"Found {len(jsonl_files)} JSONL files")

    if last_sync_mtime and not FORCE:
        jsonl_files = [
            f for f in jsonl_files
            if datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc) > last_sync_mtime
        ]
        log.info(f"Filtered to {len(jsonl_files)} files modified since last sync")

    if not jsonl_files:
        log.info("No new files to process")
        if client:
            client.table("sync_state").update(
                {"status": "idle", "files_processed": 0, "messages_ingested": 0}
            ).eq("id", 1).execute()
        return

    all_sessions: dict[str, dict[str, Any]] = {}
    all_messages: list[dict[str, Any]] = []
    all_tool_rows: list[dict[str, Any]] = []
    all_rate_limits: list[dict[str, Any]] = []
    max_mtime = datetime.min.replace(tzinfo=timezone.utc)

    for i, file_path in enumerate(jsonl_files, 1):
        if i % 50 == 0:
            log.info(f"Processing file {i}/{len(jsonl_files)}")

        path_meta = parse_session_path(file_path)
        if not path_meta:
            continue

        records = parse_jsonl_file(file_path)
        if not records:
            continue

        file_mtime = datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc)
        if file_mtime > max_mtime:
            max_mtime = file_mtime

        session_data = build_session_data(path_meta, records)
        session_id = session_data["id"]

        if session_id in all_sessions:
            existing = all_sessions[session_id]
            existing["message_count"] += session_data["message_count"]
            existing["tool_call_count"] += session_data["tool_call_count"]
            existing["total_input_tokens"] += session_data["total_input_tokens"]
            existing["total_output_tokens"] += session_data["total_output_tokens"]
            existing["total_cache_read_tokens"] += session_data["total_cache_read_tokens"]
            existing["total_cache_creation_tokens"] += session_data["total_cache_creation_tokens"]
            if session_data.get("ended_at"):
                if not existing.get("ended_at") or session_data["ended_at"] > existing["ended_at"]:
                    existing["ended_at"] = session_data["ended_at"]
        else:
            all_sessions[session_id] = session_data

        for r in records:
            if r["type"] == "assistant":
                msg_row = {
                    "session_id": session_id,
                    "message_uuid": r.get("message_uuid"),
                    "timestamp": r["timestamp"],
                    "model": r["model"],
                    "input_tokens": r.get("input_tokens", 0),
                    "output_tokens": r.get("output_tokens", 0),
                    "cache_read_tokens": r.get("cache_read_tokens", 0),
                    "cache_creation_tokens": r.get("cache_creation_tokens", 0),
                    "cache_1h_tokens": r.get("cache_1h_tokens", 0),
                    "cache_5m_tokens": r.get("cache_5m_tokens", 0),
                    "web_search_requests": r.get("web_search_requests", 0),
                    "web_fetch_requests": r.get("web_fetch_requests", 0),
                    "service_tier": r.get("service_tier"),
                    "speed": r.get("speed"),
                    "tool_names": r.get("tool_names", []),
                    "tool_count": r.get("tool_count", 0),
                }
                all_messages.append(msg_row)
            elif r["type"] == "rate_limit":
                all_rate_limits.append({
                    "timestamp": r["timestamp"],
                    "reset_message": r.get("reset_message", ""),
                    "session_id": r.get("session_id"),
                })

    log.info(f"Parsed {len(all_sessions)} sessions, {len(all_messages)} messages, {len(all_rate_limits)} rate limit events")

    daily_aggs, tool_aggs = compute_daily_aggregates(all_messages, all_sessions)
    log.info(f"Computed {len(daily_aggs)} daily aggregates, {len(tool_aggs)} tool aggregates")

    if DRY_RUN:
        log.info("--- DRY RUN SUMMARY ---")
        log.info(f"Sessions: {len(all_sessions)}")
        log.info(f"Messages: {len(all_messages)}")
        log.info(f"Daily aggregates: {len(daily_aggs)}")
        log.info(f"Tool aggregates: {len(tool_aggs)}")

        total_input = sum(m.get("input_tokens", 0) for m in all_messages)
        total_output = sum(m.get("output_tokens", 0) for m in all_messages)
        total_cache_read = sum(m.get("cache_read_tokens", 0) for m in all_messages)
        total_cache_creation = sum(m.get("cache_creation_tokens", 0) for m in all_messages)
        log.info(f"Total input tokens: {total_input:,}")
        log.info(f"Total output tokens: {total_output:,}")
        log.info(f"Total cache read tokens: {total_cache_read:,}")
        log.info(f"Total cache creation tokens: {total_cache_creation:,}")

        projects = defaultdict(int)
        for s in all_sessions.values():
            projects[s["project_name"]] += s["total_input_tokens"] + s["total_output_tokens"]
        log.info("Projects by token usage:")
        for name, tokens in sorted(projects.items(), key=lambda x: -x[1])[:10]:
            log.info(f"  {name}: {tokens:,}")

        tools = defaultdict(int)
        for m in all_messages:
            for t in m.get("tool_names", []):
                tools[t] += 1
        log.info("Tool invocation counts:")
        for name, count in sorted(tools.items(), key=lambda x: -x[1])[:10]:
            log.info(f"  {name}: {count}")

        return

    log.info("Upserting sessions...")
    session_rows = list(all_sessions.values())
    parent_sessions = [s for s in session_rows if not s["is_subagent"]]
    child_sessions = [s for s in session_rows if s["is_subagent"]]

    upsert_batch(client, "sessions", parent_sessions, "id")
    upsert_batch(client, "sessions", child_sessions, "id")
    log.info(f"Upserted {len(session_rows)} sessions")

    log.info("Upserting messages...")
    msg_count = 0
    for i in range(0, len(all_messages), BATCH_SIZE):
        batch = all_messages[i : i + BATCH_SIZE]
        valid_batch = [m for m in batch if m.get("message_uuid")]
        if valid_batch:
            client.table("messages").upsert(valid_batch, on_conflict="message_uuid").execute()
            msg_count += len(valid_batch)

        no_uuid = [m for m in batch if not m.get("message_uuid")]
        if no_uuid:
            for m in no_uuid:
                m.pop("message_uuid", None)
            client.table("messages").insert(no_uuid).execute()
            msg_count += len(no_uuid)

    log.info(f"Upserted {msg_count} messages")

    # Recompute touched days from the DB rather than upserting batch-only totals,
    # which would overwrite a day's aggregates with a partial count
    touched_dates = {d["date"] for d in daily_aggs}
    log.info(f"Recomputing aggregates for {len(touched_dates)} touched days...")
    recompute_aggregates_for_dates(client, touched_dates)

    if all_rate_limits:
        log.info(f"Upserting {len(all_rate_limits)} rate limit events...")
        from bisect import bisect_left, bisect_right
        sorted_msgs = sorted(all_messages, key=lambda m: m["timestamp"])
        timestamps = [m["timestamp"] for m in sorted_msgs]

        for rl in all_rate_limits:
            rl_ts = rl["timestamp"]
            window_start = (parse_iso_timestamp(rl_ts) - timedelta(hours=5)).isoformat()
            lo = bisect_left(timestamps, window_start)
            hi = bisect_right(timestamps, rl_ts)
            window = sorted_msgs[lo:hi]
            rl["tokens_in_window_input"] = sum(m.get("input_tokens", 0) for m in window)
            rl["tokens_in_window_output"] = sum(m.get("output_tokens", 0) for m in window)
            rl["tokens_in_window_cache_read"] = sum(m.get("cache_read_tokens", 0) for m in window)
            rl["tokens_in_window_cache_create"] = sum(m.get("cache_creation_tokens", 0) for m in window)
            rl["messages_in_window"] = len(window)

        unique_rls = {}
        for rl in all_rate_limits:
            unique_rls[rl["timestamp"]] = rl
        upsert_batch(client, "rate_limit_events", list(unique_rls.values()), "timestamp")
        log.info(f"Upserted {len(unique_rls)} unique rate limit events")

    client.table("sync_state").update({
        "status": "idle",
        "last_sync_at": datetime.now(timezone.utc).isoformat(),
        "files_processed": len(jsonl_files),
        "messages_ingested": msg_count,
        "last_file_mtime": max_mtime.isoformat(),
    }).eq("id", 1).execute()

    log.info("Ingestion complete!")


if __name__ == "__main__":
    main()
