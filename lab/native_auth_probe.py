#!/usr/bin/env python3
"""Development-only native auth probe using the official App Server MCP API.

No authentication injection, UI writes, or signing changes. Only a prior user
approval for the exact CCUH dummy app may be explicitly acknowledged; every
other approval request stops the probe.
Only an explicitly selected dummy app's get_app_state is requested. Responses
are summarized; screen text, image content, environment values, and tokens are
never written to evidence. A deadline is not proof of native cancellation.
"""

import argparse
import datetime
import hashlib
import json
import os
import plistlib
import queue
import re
import stat
import subprocess
import tempfile
import threading
import time
from pathlib import Path


MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_LAUNCHER_BYTES = 1024 * 1024
DEFAULT_CLI = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
DEFAULT_CLIENT = "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
DEFAULT_DISABLED = ("node_repl", "context-mode", "agent-hud")
KNOWN_REQUESTS = {"item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
                  "mcpServer/elicitation/request", "tool/requestUserInput", "attestation/generate", "item/tool/call"}
ERROR_MESSAGES = (
    "Computer Use server error -10000: Sender process is not authenticated",
    "Sender process is not authenticated",
    "missing-code-signing-identity",
    "Sky Computer Use native pipe startup failed",
    "Sky Computer Use requires the trusted nodeRepl runtime",
    "Sky Computer Use native pipe is unavailable",
    "No such file or directory",
    "Capability is not available: visibility",
    "Method not found",
    "Not initialized",
)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def launcher_from_environment_file(path, official_cli):
    """Select one CLI from an owned isolated JSON fixture, not its other values."""
    source = Path(path).absolute()
    initial = source.lstat()
    if not stat.S_ISREG(initial.st_mode) or initial.st_uid != os.getuid():
        raise ValueError("launcher_source_must_be_owned_regular_file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(str(source), flags)
    with os.fdopen(descriptor, "rb") as handle:
        opened = os.fstat(handle.fileno())
        if not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid():
            raise ValueError("launcher_source_must_be_owned_regular_file")
        raw = handle.read(MAX_LAUNCHER_BYTES + 1)
    if len(raw) > MAX_LAUNCHER_BYTES:
        raise ValueError("launcher_source_exceeds_limit")
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("launcher_source_must_be_json_object")
    override_present = "CODEX_CLI_PATH" in data
    value = data["CODEX_CLI_PATH"] if override_present else str(official_cli)
    if not isinstance(value, str) or not value or "\0" in value or not Path(value).is_absolute():
        raise ValueError("selected_cli_must_be_absolute_path_string")
    selected = Path(value).resolve()
    return selected, {"kind": "isolated_environment_file", "source_sha256": sha(raw),
                      "source_path_sha256": sha(str(source).encode()), "override_present": override_present,
                      "selected_cli_path_sha256": sha(str(selected).encode()), "other_fixture_values_injected": False}


def allowed_errors(text):
    # Only fixed known phrases, never a returned message or its surrounding data.
    lower = text.lower()
    return [message for message in ERROR_MESSAGES if message.lower() in lower]


def marker_present(value, marker):
    if not marker:
        return None
    if isinstance(value, str):
        return marker in value
    if isinstance(value, list):
        return any(marker_present(child, marker) for child in value)
    if isinstance(value, dict):
        if value.get("type") in ("image", "audio"):
            return False
        return any(marker_present(child, marker) for key, child in value.items() if key not in ("data", "blob", "url"))
    return False


def summarize_response(message, raw, marker=None):
    result = message.get("result")
    error = message.get("error")
    is_error = result.get("isError") if isinstance(result, dict) else None
    known = allowed_errors(json.dumps(error if error is not None else result, ensure_ascii=False)) if error is not None or is_error is True else []
    return {"response_sha256": sha(raw), "response_bytes": len(raw), "rpc_error_code": error.get("code") if isinstance(error, dict) and type(error.get("code")) is int else None,
            "native_error_code": -10000 if ERROR_MESSAGES[0] in known else None,
            "isError": is_error if type(is_error) is bool else None, "error_messages": known,
            "unrecognized_error_redacted": (error is not None or is_error is True) and not bool(known),
            "expected_marker_present": marker_present(result, marker)}


def observed_native_error_export(message):
    """Return only a verbatim allowlisted subset of an actual MCP error.

    The export is not the raw MCP envelope. Keep the response digest separately
    so a constructed error fixture or an unrelated summary is not evidence of
    a live authentication failure.
    """
    result = message.get("result")
    if not isinstance(result, dict) or result.get("isError") is not True:
        return None
    content = result.get("content", [])
    if not isinstance(content, list):
        return None
    for entry in content:
        if isinstance(entry, dict) and entry.get("type") == "text" and isinstance(entry.get("text"), str) and ERROR_MESSAGES[0] in entry["text"]:
            return {"isError": True, "content": [{"type": "text", "text": ERROR_MESSAGES[0]}]}
    return None


class ProbeStop(Exception):
    def __init__(self, status, phase, details=None):
        self.status, self.phase, self.details = status, phase, details or {}


def is_approved_probe_request(message):
    params = message.get("params", {})
    schema = params.get("requestedSchema", {})
    return (message.get("method") == "mcpServer/elicitation/request"
            and params.get("serverName") == "computer-use"
            and params.get("mode") == "form"
            and params.get("message") == "Allow ChatGPT to use CCUH Focus Probe?"
            and isinstance(schema, dict) and schema.get("type") == "object"
            and schema.get("properties", {}) == {} and schema.get("required", []) == [])


class RpcClient:
    def __init__(self, command, cwd, timeout, environment, acknowledge_approved_probe_access=False):
        self.process = subprocess.Popen(command, cwd=cwd, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.deadline = time.monotonic() + timeout
        self.messages = queue.Queue()
        self.acknowledge_approved_probe_access = acknowledge_approved_probe_access
        self.approval_acknowledgements = 0
        self.stderr_digest = hashlib.sha256()
        self.stderr_bytes = 0
        self.stderr_known = set()
        self.stderr_lock = threading.Lock()
        self.stdout_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self.stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self.stdout_thread.start()
        self.stderr_thread.start()

    def _read_stdout(self):
        try:
            while True:
                raw = self.process.stdout.readline(MAX_FRAME_BYTES + 1)
                if not raw:
                    self.messages.put(("eof", None))
                    return
                if len(raw) > MAX_FRAME_BYTES:
                    self.messages.put(("frame_too_large", None))
                    return
                if raw.strip():
                    self.messages.put(("line", raw))
        except OSError:
            self.messages.put(("eof", None))

    def _read_stderr(self):
        tail = ""
        while True:
            raw = self.process.stderr.read1(4096)
            if not raw:
                return
            text = tail + raw.decode("utf-8", errors="replace")
            with self.stderr_lock:
                self.stderr_bytes += len(raw)
                self.stderr_digest.update(raw)
                self.stderr_known.update(allowed_errors(text))
            tail = text[-256:]

    def send(self, message):
        self.process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        self.process.stdin.flush()

    def request(self, request_id, method, params):
        self.send({"id": request_id, "method": method, "params": params})
        while True:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise ProbeStop("timeout", method)
            try:
                kind, raw = self.messages.get(timeout=remaining)
            except queue.Empty:
                raise ProbeStop("timeout", method)
            if kind != "line":
                raise ProbeStop("protocol_error" if kind == "frame_too_large" else "client_exited", method)
            try:
                message = json.loads(raw)
            except (ValueError, UnicodeError, RecursionError):
                raise ProbeStop("protocol_error", method, {"invalid_frame_sha256": sha(raw), "invalid_frame_bytes": len(raw)})
            if not isinstance(message, dict):
                raise ProbeStop("protocol_error", method)
            if "method" in message and "id" in message:
                server_method = message.get("method")
                if self.acknowledge_approved_probe_access and self.approval_acknowledgements == 0 and is_approved_probe_request(message):
                    self.send({"id": message["id"], "result": {"action": "accept", "content": {}}})
                    self.approval_acknowledgements += 1
                    continue
                details = {"server_request_method": server_method if server_method in KNOWN_REQUESTS else "unrecognized_server_request", "automatically_approved": False}
                if server_method == "mcpServer/elicitation/request":
                    params = message.get("params", {})
                    mode = params.get("mode")
                    details["approval_mode"] = mode if mode in ("form", "openai/form", "openaiForm", "url", "openai/userVerification") else "unrecognized"
                    # Permission prompts are not screen data. Never expose a
                    # URL, challenge, metadata, or a user-verification proof.
                    prompt = params.get("message", "")
                    if isinstance(prompt, str):
                        details["approval_prompt_sha256"] = sha(prompt.encode())
                        if mode == "form" and prompt == "Allow ChatGPT to use CCUH Focus Probe?":
                            details["dummy_app_permission_prompt"] = prompt
                    schema = params.get("requestedSchema", {})
                    if isinstance(schema, dict):
                        details["requested_schema_sha256"] = sha(json.dumps(schema, sort_keys=True).encode())
                        details["requested_field_count"] = len(schema.get("properties", {})) if isinstance(schema.get("properties", {}), dict) else None
                raise ProbeStop("approval_required", method, details)
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise ProbeStop("rpc_error", method, summarize_response(message, raw))
            if "result" not in message:
                raise ProbeStop("protocol_error", method)
            return message, raw

    def close(self):
        cleanup = "already_exited"
        try:
            self.process.stdin.close()
        except OSError:
            pass
        if self.process.poll() is None:
            cleanup = "stdin_closed"
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                cleanup = "client_terminated"
                try:
                    self.process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    cleanup = "client_killed_after_termination_deadline"
                    self.process.kill()
                    self.process.wait(timeout=2)
        self.stdout_thread.join(timeout=0.2)
        self.stderr_thread.join(timeout=0.2)
        if not self.stdout_thread.is_alive():
            self.process.stdout.close()
        if not self.stderr_thread.is_alive():
            self.process.stderr.close()
        with self.stderr_lock:
            return {"client_cleanup": cleanup, "client_exit_code": self.process.poll(), "stderr_bytes": self.stderr_bytes,
                    "stderr_sha256": self.stderr_digest.hexdigest(), "stderr_known_messages": sorted(self.stderr_known),
                    "shared_helpers_terminated": False, "native_operation_cancellation_confirmed": False}


def build_command(cli, client, disabled):
    if "computer-use" in disabled:
        raise ValueError("selected_server_cannot_be_disabled")
    if any(not re.fullmatch(r"[A-Za-z0-9_-]+", name) for name in disabled):
        raise ValueError("invalid_server_name")
    command = [str(cli), "--no-daemon"]
    for name in sorted(set(disabled)):
        command += ["-c", "mcp_servers." + name + ".enabled=false"]
    command += ["-c", 'mcp_servers.computer-use.enabled=true',
                "-c", 'mcp_servers.computer-use.command=' + json.dumps(str(client)),
                "-c", 'mcp_servers.computer-use.env.CODEX_CLI_PATH=' + json.dumps(str(cli)),
                "-c", 'mcp_servers.computer-use.args=["mcp"]', "app-server", "--stdio"]
    return command


def probe(cli, app, client, expected_marker=None, timeout=30, disabled=DEFAULT_DISABLED, tool_name="get_app_state", acknowledge_approved_probe_access=False):
    report = {"schema_version": 1, "scope": "official_app_server_native_mcp_read_only", "status": "not_started",
              "server": "computer-use", "cli_sha256": file_digest(cli), "mcp_client_sha256": file_digest(client),
              "target_app_path_sha256": sha(str(app).encode()), "expected_marker_sha256": sha(expected_marker.encode()) if expected_marker else None,
              "other_mcp_disabled_count": len(set(disabled)), "steps_completed": [], "tool_call_dispatched": False,
              "current_connection": "unverified", "raw_response_saved": False, "environment_values_saved": False,
              "child_cli_override_matches_selected": True, "mcp_cli_override_matches_selected": True,
              "parent_environment_changed": False, "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    rpc = None
    try:
        if tool_name != "get_app_state" and not tool_name.endswith("__get_app_state"):
            raise ProbeStop("tool_not_permitted", "preflight")
        with tempfile.TemporaryDirectory(prefix="ccuh-auth-probe-") as cwd:
            environment = dict(os.environ)
            environment["CODEX_CLI_PATH"] = str(cli)
            rpc = RpcClient(build_command(cli, client, disabled), cwd, timeout, environment, acknowledge_approved_probe_access)
            rpc.request(1, "initialize", {"clientInfo": {"name": "ccuh-auth-drill", "version": "0.0.3"}, "capabilities": {"experimentalApi": True}})
            rpc.send({"method": "initialized"})
            report["steps_completed"].append("initialize")
            message, _ = rpc.request(2, "thread/start", {"cwd": cwd, "ephemeral": True, "sandbox": "read-only", "approvalPolicy": "on-request"})
            thread_id = message["result"].get("thread", {}).get("id")
            if not isinstance(thread_id, str) or not thread_id:
                raise ProbeStop("protocol_error", "thread/start")
            report["steps_completed"].append("thread/start")
            message, _ = rpc.request(3, "mcpServerStatus/list", {"threadId": thread_id, "serverName": "computer-use", "detail": "toolsAndAuthOnly"})
            data = message["result"].get("data", [])
            servers = [server for server in data if isinstance(server, dict) and server.get("name") == "computer-use"]
            if len(servers) != 1:
                raise ProbeStop("tool_not_exposed", "mcpServerStatus/list", {"matching_server_count": len(servers)})
            tools = servers[0].get("tools", {})
            if not isinstance(tools, dict):
                raise ProbeStop("protocol_error", "mcpServerStatus/list")
            matches = [tool for key, tool in tools.items() if isinstance(tool, dict) and (tool.get("name") == tool_name or key == tool_name)]
            if len(matches) != 1 or not isinstance(matches[0].get("name"), str):
                raise ProbeStop("tool_not_exposed", "mcpServerStatus/list", {"matching_tool_count": len(matches)})
            selected = matches[0]
            schema = selected.get("inputSchema", {})
            if not isinstance(schema, dict) or any(key != "app" for key in schema.get("required", [])) or "app" not in schema.get("properties", {}):
                raise ProbeStop("tool_schema_unusable", "mcpServerStatus/list")
            report["steps_completed"].append("mcpServerStatus/list")
            report["tool_call_dispatched"] = True
            message, raw = rpc.request(4, "mcpServer/tool/call", {"threadId": thread_id, "server": "computer-use", "tool": selected["name"], "arguments": {"app": str(app)}})
            summary = summarize_response(message, raw, expected_marker)
            report["tool_response"] = summary
            error_export = observed_native_error_export(message)
            if error_export is not None:
                report["result"] = error_export
                report["native_error_export"] = {"source": "observed_mcp_tool_response", "format": "sanitized_subset",
                                               "verbatim_allowlisted_substring": True,
                                               "response_sha256": summary["response_sha256"]}
            report["steps_completed"].append("mcpServer/tool/call")
            if summary["isError"] is True:
                report["status"] = "authentication_denied" if any("not authenticated" in text for text in summary["error_messages"]) else "tool_error"
            elif expected_marker:
                report["status"] = "target_marker_confirmed" if summary["expected_marker_present"] else "target_marker_not_confirmed"
            else:
                report["status"] = "read_response_received"
    except ProbeStop as stopped:
        report.update({"status": stopped.status, "stopped_phase": stopped.phase, "stop_details": stopped.details})
        if stopped.status == "timeout":
            report["operation_outcome"] = "unknown" if report["tool_call_dispatched"] else "not_dispatched"
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        report["status"] = "input_or_process_error"
    finally:
        if rpc is not None:
            report["process"] = rpc.close()
            report["prior_user_approval_acknowledgements"] = rpc.approval_acknowledgements
        report["finished_at_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return report


def write_evidence(path, report):
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    launcher = parser.add_mutually_exclusive_group(required=True)
    launcher.add_argument("--cli", type=Path)
    launcher.add_argument("--environment-file", type=Path, help="Owned isolated JSON launcher fixture: read only CODEX_CLI_PATH; other values are not injected.")
    parser.add_argument("--official-cli", type=Path, default=Path(DEFAULT_CLI), help="Fallback executable only when the launcher fixture has no CODEX_CLI_PATH key.")
    parser.add_argument("--app", required=True, type=Path, help="Exact existing approved dummy .app path; no app discovery or fallback.")
    parser.add_argument("--evidence", required=True, type=Path, help="New sanitized JSON evidence file (0600); existing files are never overwritten.")
    parser.add_argument("--mcp-command", "--mcp-client", dest="mcp_client", type=Path, default=Path(DEFAULT_CLIENT), help="Explicit native MCP helper command; default is the installed official client.")
    parser.add_argument("--expected-marker")
    parser.add_argument("--acknowledge-approved-probe-access", action="store_true", help="Acknowledge only the exact empty-form CCUH Focus Probe access request already explicitly approved by the user; never grants any other approval.")
    parser.add_argument("--deadline-seconds", type=float, default=30)
    parser.add_argument("--disable-mcp-server", action="append", default=None, help="Other MCP server to disable for this child only; default: node_repl, context-mode, agent-hud.")
    parser.add_argument("--tool-name", default="get_app_state", help="Exact registered read-state tool name, never a guessed alias.")
    args = parser.parse_args(argv)
    try:
        if args.environment_file is not None:
            selected_cli, launcher_source = launcher_from_environment_file(args.environment_file, args.official_cli)
        else:
            if not args.cli.is_absolute():
                raise ValueError("cli_must_be_absolute")
            selected_cli = args.cli.resolve()
            launcher_source = {"kind": "explicit_cli", "selected_cli_path_sha256": sha(str(selected_cli).encode())}
    except (OSError, ValueError, TypeError, UnicodeError, RuntimeError):
        parser.error("Provide an owned regular launcher JSON file of at most 1 MiB and an absolute executable path string.")
    if not selected_cli.is_file() or not args.mcp_client.is_file() or not args.app.is_absolute() or not args.app.is_dir() or args.app.suffix != ".app" or not 0 < args.deadline_seconds <= 120:
        parser.error("Provide existing CLI/client files, an absolute dummy .app directory, and a deadline in (0, 120].")
    if args.evidence.exists():
        parser.error("Evidence file already exists; select a new path.")
    if args.acknowledge_approved_probe_access:
        try:
            metadata = plistlib.loads((args.app / "Contents/Info.plist").read_bytes())
        except (OSError, ValueError):
            parser.error("The approved CCUH dummy app bundle is required.")
        if args.app.name != "CCUH Focus Probe.app" or metadata.get("CFBundleIdentifier") != "local.ccuh.focus-probe":
            parser.error("The approved CCUH dummy app bundle is required.")
    disabled = DEFAULT_DISABLED if args.disable_mcp_server is None else tuple(args.disable_mcp_server)
    report = probe(selected_cli, args.app.resolve(), args.mcp_client.resolve(), args.expected_marker, args.deadline_seconds, disabled, args.tool_name, args.acknowledge_approved_probe_access)
    report["launcher_source"] = launcher_source
    write_evidence(args.evidence, report)
    print(json.dumps({"status": report["status"], "tool_call_dispatched": report["tool_call_dispatched"], "raw_response_saved": False}))
    return 0 if report["status"] in ("target_marker_confirmed", "read_response_received") else 1


if __name__ == "__main__":
    raise SystemExit(main())
