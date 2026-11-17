#!/usr/bin/env python3
"""Local-only CCUH fixture. No browser launch, screen capture, or external requests."""

import argparse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import socket
import threading
import time
from typing import Any, Dict, Optional
from urllib.parse import urlsplit
import uuid


MAX_BODY_BYTES = 16_384
MAX_EVENTS = 2_000
EVENT_NAMES = {
    "page_ready", "focus", "blur", "window_focus", "window_blur",
    "visibilitychange", "input", "selectionchange", "name_input",
    "enabled_change", "save_requested", "save_failed",
}
STRING_FIELDS = {"value": 4_096, "visibility": 16, "name": 63, "message": 160, "page_id": 80}
BOOL_FIELDS = {"focused", "enabled"}
INT_FIELD_LIMITS = {
    "selection_start": 4_096, "selection_end": 4_096,
    "client_sequence": 1_000_000_000,
    "client_time_ms": 9_007_199_254_740_991,
    "client_monotonic_ms": 9_007_199_254_740_991,
}
WORKER_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\Z")


class LabState:
    def __init__(self, max_events: int = MAX_EVENTS):
        if max_events < 1:
            raise ValueError("max_events must be positive")
        self.run_id = str(uuid.uuid4())
        self.worker = {"name": "", "enabled": False, "revision": 0}
        self.events = deque(maxlen=max_events)
        self.total_events = 0
        self.lock = threading.Lock()

    def _append(self, source: str, event: str, data: Dict[str, Any]) -> None:
        self.total_events += 1
        self.events.append({
            "sequence": self.total_events,
            "monotonic_ns": time.monotonic_ns(),
            "source": source,
            "event": event,
            "data": dict(data),
        })

    def record(self, source: str, event: str, data: Dict[str, Any]) -> int:
        with self.lock:
            self._append(source, event, data)
            return self.total_events

    def save_worker(self, name: str, enabled: bool) -> Dict[str, Any]:
        with self.lock:
            self.worker = {
                "name": name,
                "enabled": enabled,
                "revision": self.worker["revision"] + 1,
            }
            self._append("target", "worker_saved", self.worker)
            return dict(self.worker)

    def current_worker(self) -> Dict[str, Any]:
        with self.lock:
            return dict(self.worker)

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "run_id": self.run_id,
                "worker": dict(self.worker),
                "events": list(self.events),
                "total_events": self.total_events,
                "dropped_events": self.total_events - len(self.events),
            }


def validate_event(payload: Dict[str, Any]) -> Dict[str, Any]:
    if set(payload) != {"source", "event", "data"}:
        raise ValueError("Event requires only source, event, and data")
    if payload["source"] not in ("target", "user"):
        raise ValueError("Unknown fixture source")
    if not isinstance(payload["event"], str) or payload["event"] not in EVENT_NAMES:
        raise ValueError("Unknown fixture event")
    data = payload["data"]
    if not isinstance(data, dict):
        raise ValueError("Event data must be an object")
    for key, value in data.items():
        if key in STRING_FIELDS:
            if not isinstance(value, str) or len(value) > STRING_FIELDS[key]:
                raise ValueError("Invalid event text field")
            if key == "visibility" and value not in ("visible", "hidden", "prerender"):
                raise ValueError("Invalid visibility state")
        elif key in BOOL_FIELDS:
            if type(value) is not bool:
                raise ValueError("Invalid event boolean field")
        elif key in INT_FIELD_LIMITS:
            if type(value) is not int or not 0 <= value <= INT_FIELD_LIMITS[key]:
                raise ValueError("Invalid event integer field")
        else:
            raise ValueError("Unknown event field")
    return payload


class LabServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port: int, max_events: int = MAX_EVENTS):
        self.lab_state = LabState(max_events)
        self.static_root = Path(__file__).resolve().parent
        super().__init__(("127.0.0.1", port), LabHandler)


class LabHandler(BaseHTTPRequestHandler):
    server_version = "CCUHFixture/0.1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format: str, *args: Any) -> None:
        # Request URLs/headers and typed content are intentionally not printed.
        pass

    def _response(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", (
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
            "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        ))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: Dict[str, Any]) -> None:
        self._response(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"ok": False, "error": message})

    def _allowed_request(self) -> bool:
        port = self.server.server_address[1]
        allowed_hosts = {"127.0.0.1:{}".format(port), "localhost:{}".format(port)}
        if self.headers.get("Host") not in allowed_hosts:
            self._error(403, "Only the local fixture host is accepted")
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in {"http://" + h for h in allowed_hosts}:
            self._error(403, "Cross-origin requests are not accepted")
            return False
        return True

    def do_GET(self) -> None:
        if not self._allowed_request():
            return
        path = urlsplit(self.path).path
        if path in ("/target", "/user"):
            filename = "target.html" if path == "/target" else "user.html"
            self._response(200, (self.server.static_root / filename).read_bytes(),
                           "text/html; charset=utf-8")
        elif path == "/worker":
            self._json(200, {"ok": True, "worker": self.server.lab_state.current_worker()})
        elif path == "/events":
            self._json(200, self.server.lab_state.snapshot())
        else:
            self._error(404, "Unknown fixture route")

    def _read_json(self) -> Optional[Dict[str, Any]]:
        if self.headers.get("Transfer-Encoding"):
            self._error(400, "Transfer-Encoding is not supported")
            return None
        if self.headers.get_content_type() != "application/json":
            self._error(415, "Use application/json")
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "Content-Length is required")
            return None
        try:
            length = int(raw_length)
            if length < 0:
                raise ValueError
        except ValueError:
            self._error(400, "Invalid Content-Length")
            return None
        if length > MAX_BODY_BYTES:
            self._error(413, "Fixture request is too large")
            return None
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError
        except (ValueError, UnicodeError):
            self._error(400, "Expected a JSON object")
            return None
        except (socket.timeout, TimeoutError):
            self._error(408, "Fixture request body timed out")
            return None
        return payload

    def do_POST(self) -> None:
        if not self._allowed_request():
            return
        path = urlsplit(self.path).path
        if path not in ("/events", "/worker"):
            self._error(404, "Unknown fixture route")
            return
        payload = self._read_json()
        if payload is None:
            return
        if path == "/events":
            try:
                event = validate_event(payload)
            except (ValueError, TypeError):
                self._error(400, "Invalid fixture event")
                return
            sequence = self.server.lab_state.record(event["source"], event["event"], event["data"])
            self._json(200, {"ok": True, "sequence": sequence})
            return
        if (set(payload) != {"name", "enabled"}
                or not isinstance(payload.get("name"), str)
                or WORKER_NAME.fullmatch(payload["name"]) is None
                or type(payload.get("enabled")) is not bool):
            self._error(400, "Worker requires a lowercase name and a boolean enabled field")
            return
        worker = self.server.lab_state.save_worker(payload["name"], payload["enabled"])
        self._json(200, {"ok": True, "worker": worker})


def create_server(port: int = 8765, max_events: int = MAX_EVENTS) -> LabServer:
    if type(port) is not int or not 0 <= port <= 65_535:
        raise ValueError("port must be between 0 and 65535")
    return LabServer(port, max_events)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765, help="Local port (default: 8765)")
    args = parser.parse_args()
    try:
        server = create_server(args.port)
    except (OSError, ValueError) as exc:
        parser.exit(2, "Unable to start local fixture: {}\n".format(exc))
    base = "http://127.0.0.1:{}".format(server.server_address[1])
    print("CCUH fixture is listening on 127.0.0.1 only.", flush=True)
    print("Run ID: {}".format(server.lab_state.run_id), flush=True)
    print("Target: {}/target".format(base), flush=True)
    print("User input: {}/user".format(base), flush=True)
    print("Evaluator only: {}/events".format(base), flush=True)
    print("Use dummy text only. Stop with Ctrl+C. No browser is opened automatically.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
