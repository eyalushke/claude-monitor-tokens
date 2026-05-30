#!/usr/bin/env python3
"""
Claude Code Token Usage Ingestion Script

Parses JSONL session files from ~/.claude/projects/ and pushes
structured token usage data to Supabase for the monitoring dashboard.

Usage:
    python3 ingest.py              # Full ingestion
    python3 ingest.py --dry-run    # Parse only, no DB writes
    python3 ingest.py --force      # Re-process all files regardless of mtime
"""

import json
import logging
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

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
CLAUDE_DIR = Path(os.getenv("CLAUDE_DIR", "~/.claude")).expanduser()
PROJECTS_DIR = CLAUDE_DIR / "projects"
BATCH_SIZE = 500
DB_SCHEMA = "claude_monitor"

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

    if not DRY_RUN:
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

    log.info("Upserting daily aggregates...")
    upsert_batch(client, "daily_aggregates", daily_aggs, "date,project_name,model")
    upsert_batch(client, "tool_daily_aggregates", tool_aggs, "date,tool_name")
    log.info(f"Upserted {len(daily_aggs)} daily aggs, {len(tool_aggs)} tool aggs")

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
