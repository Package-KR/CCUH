#!/usr/bin/env python3
"""Wait for this lab's own typing checkpoint; return metadata, never text."""

import argparse
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


def ready(records, run_id, require_space_change=False):
    entries = [e for e in records if e.get("run_id") == run_id]
    starts = [e for e in entries if e.get("event") == "typing_test_started"]
    if not starts:
        return None
    start = starts[-1]
    if require_space_change and start.get("space_change_count", 0) < 1:
        return None
    following = [e for e in entries if e.get("seq", 0) >= start["seq"]]
    if any(e.get("event") in ("typing_test_completed", "typing_test_interrupted") for e in following):
        return None
    typed = [e for e in following if e.get("event") == "text_changed" and e.get("typing_phase") == "typing"]
    states = [e for e in following if "probe_key_window" in e]
    if not typed or not states:
        return None
    state = states[-1]
    if not all(state.get(k) for k in ("probe_key_window", "probe_is_frontmost", "editor_is_first_responder")):
        return None
    if state.get("probe_window_fullscreen") is not False:
        return None
    duration_ns = start["phase_deadline_monotonic_ns"] - start["monotonic_ns"]
    started_utc = datetime.fromisoformat(start["timestamp_utc"].replace("Z", "+00:00"))
    deadline = started_utc + timedelta(microseconds=duration_ns // 1000)
    remaining_seconds = (deadline - datetime.now(timezone.utc)).total_seconds()
    if remaining_seconds < 6:
        return None
    return {
        "status": "typing_ready",
        "run_id": run_id,
        "typing_started_utc": start["timestamp_utc"],
        "first_text_event_utc": typed[0]["timestamp_utc"],
        "typing_deadline_utc": deadline.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "remaining_seconds": round(remaining_seconds, 3),
        "checkpoint_sequence": start["seq"],
        "text_event_count": typed[-1].get("typing_text_event_count"),
        "fullscreen": False,
        "foreground_key_responder_ready": True,
        "input_provenance": "requires_user_confirmation",
        "desktop_identity": "requires_user_confirmation",
        "space_change_count_at_start": start.get("space_change_count", 0),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--require-space-change", action="store_true")
    args = parser.parse_args()
    if not 0 < args.timeout <= 60:
        parser.error("timeout must be within (0, 60]")
    end = time.monotonic() + args.timeout
    while time.monotonic() < end:
        entries = []
        try:
            with args.log.open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - 262144))
                lines = handle.read().splitlines()
            for line in lines:
                try:
                    value = json.loads(line)
                    if isinstance(value, dict):
                        entries.append(value)
                except (ValueError, UnicodeError):
                    pass
            result = ready(entries, args.run_id, args.require_space_change)
            if result:
                print(json.dumps(result), flush=True)
                return 0
        except FileNotFoundError:
            pass
        time.sleep(0.05)
    print(json.dumps({"status": "typing_not_ready", "run_id": args.run_id}), flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
