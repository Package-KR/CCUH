#!/usr/bin/env python3
"""Development-only complete runtime fixture and public CLI execution proof.

Importing this module performs no work. Only the two selected official host
images are copied, without rewriting their embedded signatures. The execution
preflight is a separate, explicit public ``codex exec`` model turn; it never
changes launchctl, quits Desktop, calls native UI tools, or overrides the model.
"""

import ctypes
import hashlib
import importlib.util
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


TEAM = "2DC432GLL2"
CLI_RELATIVE = Path("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")
SIDECARS = ("codex-code-mode-host", "codex-exec-server")
MAX_HOST_BYTES = 256 * 1024 * 1024
MAX_IMAGE_BYTES = 512 * 1024 * 1024
MAX_EVENT_BYTES = 8 * 1024 * 1024
DEFAULT_DISABLED_MCP = ("computer-use", "node_repl", "context-mode", "agent-hud")
DIAGNOSTIC_PHRASES = ("code mode", "code-mode-host", "code_mode", "functions.exec",
                      "No such file or directory", "Operation not permitted", "Permission denied",
                      "not available", "unavailable", "not found", "not supported", "failed to start",
                      "startup failed", "unknown tool", "invalid tool", "namespace", "timeout")


class Blocked(Exception):
    def __init__(self, code, details=None):
        super().__init__(code)
        self.code = code
        self.details = details or {}


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _identity(info):
    return {"device": info.st_dev, "inode": info.st_ino, "size": info.st_size,
            "mtime_ns": info.st_mtime_ns, "mode": stat.S_IMODE(info.st_mode),
            "owner_uid": info.st_uid}


def _regular(path, owners, max_bytes=MAX_IMAGE_BYTES):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid not in owners
            or stat.S_IMODE(info.st_mode) & 0o022 or not stat.S_IMODE(info.st_mode) & 0o111
            or not 0 < info.st_size <= max_bytes):
        raise Blocked("runtime_owned_regular_executable_required")
    return info


def _digest(path, owners, max_bytes=MAX_IMAGE_BYTES):
    before = _regular(path, owners, max_bytes)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    digest = hashlib.sha256()
    count = 0
    with os.fdopen(descriptor, "rb") as handle:
        if _identity(os.fstat(handle.fileno())) != _identity(before):
            raise Blocked("runtime_file_changed")
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > max_bytes:
                raise Blocked("runtime_file_exceeds_limit")
            digest.update(chunk)
        if _identity(os.fstat(handle.fileno())) != _identity(before):
            raise Blocked("runtime_file_changed")
    if _identity(path.lstat()) != _identity(before) or count != before.st_size:
        raise Blocked("runtime_file_changed")
    return {"path": str(path), "sha256": digest.hexdigest(), **_identity(before)}


def _real_parents(path, boundary, private=False):
    if boundary not in path.parents:
        raise Blocked("runtime_path_outside_boundary")
    selected = path.parent
    while True:
        info = selected.lstat()
        if (not stat.S_ISDIR(info.st_mode) or selected.is_symlink()
                or (private and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022))):
            raise Blocked("runtime_parent_directory_unconfirmed")
        if selected == boundary:
            break
        selected = selected.parent


def _paths(runtime, candidate_cli):
    app = Path(runtime["app_path"])
    official = Path(runtime["cli"]["path"])
    candidate = Path(candidate_cli)
    if (not app.is_absolute() or app.resolve() != app or not official.is_absolute()
            or official != app / CLI_RELATIVE or official.resolve() != official):
        raise Blocked("runtime_official_cli_path_unconfirmed")
    if (not candidate.is_absolute() or candidate.resolve() != candidate
            or tuple(candidate.parts[-4:]) != ("CodexCLI.app", "Contents", "MacOS", "codex")):
        raise Blocked("runtime_candidate_path_unconfirmed")
    workspace = candidate.parents[3]
    # A single private work directory immediately below /private/tmp keeps the
    # copy boundary explicit and prevents accepting an unrelated enclosing tree.
    if workspace.parent != Path("/private/tmp"):
        raise Blocked("runtime_private_tmp_workspace_required")
    info = workspace.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise Blocked("runtime_private_workspace_required")
    _real_parents(official, app)
    _real_parents(candidate, workspace, private=True)
    _regular(candidate, {os.getuid()})
    return app, official, candidate, workspace


def _signature(path, identifier):
    try:
        verified = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(path)],
                                  capture_output=True, timeout=20)
        displayed = subprocess.run(["/usr/bin/codesign", "--display", "--verbose=4", str(path)],
                                   capture_output=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("runtime_official_sidecar_signature_unconfirmed")
    metadata = displayed.stderr.decode("utf-8", "replace")
    fields = {}
    for key in ("Identifier", "TeamIdentifier", "CDHash"):
        match = re.search(r"^" + key + r"=([^\r\n]+)$", metadata, re.MULTILINE)
        fields[key] = match.group(1).strip() if match else None
    if (verified.returncode or displayed.returncode or fields["Identifier"] != identifier
            or fields["TeamIdentifier"] != TEAM or not fields["CDHash"]
            or not re.fullmatch(r"[0-9a-fA-F]{40,64}", fields["CDHash"])):
        # Embedded metadata alone is not a successful trust check. In
        # particular, sandbox-denied codesign must not turn into a pass.
        raise Blocked("runtime_official_sidecar_signature_unconfirmed")
    return {"identifier": identifier, "team_identifier": TEAM,
            "cdhash": fields["CDHash"].lower(), "strict_verification_confirmed": True}


def _image(path, identifier, owners):
    evidence = _digest(path, owners, MAX_HOST_BYTES)
    evidence["signature"] = _signature(path, identifier)
    if _digest(path, owners, MAX_HOST_BYTES) != {key: value for key, value in evidence.items() if key != "signature"}:
        raise Blocked("runtime_file_changed_during_signature_check")
    return evidence


def _sources(app):
    root = app / "Contents/Resources/codex-cli/bin"
    sources = {}
    for name in SIDECARS:
        path = root / name
        _real_parents(path, app)
        sources[name] = _image(path, name, {0, os.getuid()})
    return sources


def _evidence(runtime, candidate_cli):
    app, official, candidate, _ = _paths(runtime, candidate_cli)
    sources = _sources(app)
    hosts = []
    for name in SIDECARS:
        target = _image(candidate.parent / name, name, {os.getuid()})
        source = sources[name]
        if (source["sha256"] != target["sha256"] or source["size"] != target["size"]
                or source["signature"] != target["signature"]):
            raise Blocked("runtime_sidecar_copy_not_identical")
        hosts.append({"name": name, "source": source, "candidate": target})
    return {"schema_version": 1, "kind": "ccuh_developer_runtime_sidecars",
            "official_cli_path": str(official), "candidate_cli_path": str(candidate), "hosts": hosts}


def copy_sidecars(runtime, candidate_cli):
    """Exclusively copy official signed hosts beside a new private candidate.

    Call before signing the enclosing candidate bundle. Existing destination
    paths are rejected, including symlinks. No official file is changed.
    """
    try:
        app, _, candidate, _ = _paths(runtime, candidate_cli)
        sources = _sources(app)
        for name in SIDECARS:
            if os.path.lexists(candidate.parent / name):
                raise Blocked("runtime_sidecar_destination_exists")
        for name in SIDECARS:
            source = sources[name]
            source_path = Path(source["path"])
            source_fd = os.open(source_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(source_fd, "rb") as incoming:
                if _identity(os.fstat(incoming.fileno())) != {key: source[key] for key in _identity(os.fstat(incoming.fileno()))}:
                    raise Blocked("runtime_source_changed_before_copy")
                target_fd = os.open(candidate.parent / name,
                                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                                    source["mode"])
                with os.fdopen(target_fd, "wb") as outgoing:
                    copied = 0
                    while True:
                        chunk = incoming.read(1024 * 1024)
                        if not chunk:
                            break
                        copied += len(chunk)
                        if copied > MAX_HOST_BYTES:
                            raise Blocked("runtime_file_exceeds_limit")
                        outgoing.write(chunk)
                    os.fchmod(outgoing.fileno(), source["mode"])
                    outgoing.flush()
                    os.fsync(outgoing.fileno())
        evidence = _evidence(runtime, candidate)
        if any(host["source"] != sources[host["name"]] for host in evidence["hosts"]):
            raise Blocked("runtime_source_changed_during_copy")
        return evidence
    except Blocked:
        raise
    except (OSError, ValueError, KeyError, TypeError):
        raise Blocked("runtime_sidecar_copy_unconfirmed")


def validate_sidecars(runtime, candidate_cli, evidence):
    """Recheck source and adjacent candidate images without changing files."""
    try:
        observed = _evidence(runtime, candidate_cli)
        if observed != evidence:
            raise Blocked("runtime_sidecar_evidence_changed")
        return observed
    except Blocked:
        raise
    except (OSError, ValueError, KeyError, TypeError):
        raise Blocked("runtime_sidecar_validation_unconfirmed")


def build_preflight_command(candidate_cli, cwd, disabled_mcp=DEFAULT_DISABLED_MCP):
    """Build the installed CLI's supported public exec route; inherit model."""
    if any(not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name) for name in disabled_mcp):
        raise Blocked("runtime_preflight_invalid_mcp_name")
    command = [str(candidate_cli), "--no-daemon", "exec", "--json", "--ephemeral",
               "--skip-git-repo-check", "--sandbox", "read-only", "--cd", str(cwd),
               "--color", "never", "--enable", "code_mode", "--enable", "code_mode_only",
               "--disable", "hooks", "--disable", "plugins", "--disable", "apps",
               "--disable", "memories", "--disable", "shell_snapshot"]
    for name in sorted(set(disabled_mcp)):
        command += ["-c", "mcp_servers." + name + ".enabled=false"]
    return command + ["-"]


def _proof_present(value, marker):
    if isinstance(value, dict):
        if (value.get("ccuh_runtime_preflight") == marker
                and type(value.get("nested_exit_code")) is int and value["nested_exit_code"] == 0):
            return True
        return any(_proof_present(child, marker) for key, child in value.items()
                   if key not in ("data", "blob", "url"))
    if isinstance(value, list):
        return any(_proof_present(child, marker) for child in value)
    if isinstance(value, str):
        for line in value.splitlines():
            try:
                parsed = json.loads(line)
            except (ValueError, RecursionError):
                continue
            if isinstance(parsed, (dict, list)) and _proof_present(parsed, marker):
                return True
    return False


def build_nested_command(marker):
    """A fixed command emits proof only after the real /usr/bin/true exits 0."""
    program = ('import json,subprocess; '
               'r=subprocess.run(["/usr/bin/true"],check=True); '
               'print(json.dumps({"ccuh_runtime_preflight":' + repr(marker)
               + ',"nested_exit_code":r.returncode}))')
    return shlex.join([str(Path(sys.executable).resolve()), "-c", program])


def _same_command(observed, expected):
    if not isinstance(observed, str) or not isinstance(expected, str):
        return False
    if observed == expected:
        return True
    try:
        words = shlex.split(observed)
    except ValueError:
        return False
    return (len(words) == 3 and words[0] in ("/bin/zsh", "/bin/bash", "/bin/sh")
            and words[1] in ("-c", "-lc") and words[2] == expected)


def _development_warning(item):
    message = item.get("message")
    return (isinstance(message, str)
            and re.match(r"^Under-development features enabled:\s*code_mode,\s*code_mode_only(?:[.\n]|$)", message) is not None)


class ProcessAuditor:
    """Reuse product libproc readers, without constructing AppKit lifecycle UI.

    Only process(pid) and descendants(pid) for the newly spawned preflight
    client are exposed. No process arguments, environment, or system inventory
    are requested.
    """
    def __init__(self):
        source = Path(__file__).resolve().parents[1] / "skills/ccuh-doctor/scripts/desktop_recovery.py"
        spec = importlib.util.spec_from_file_location("ccuh_runtime_process_reader", source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.reader = object.__new__(self.module.MacLifecycle)
        self.reader.libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.reader.libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.reader.libproc.proc_pidinfo.restype = ctypes.c_int
        self.reader.libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        self.reader.libproc.proc_pidpath.restype = ctypes.c_int
        self.reader.libproc.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        self.reader.libproc.proc_listchildpids.restype = ctypes.c_int

    def process(self, pid):
        try:
            return self.reader.process(pid)
        except self.module.Blocked as error:
            raise Blocked(error.code)

    def descendants(self, pid):
        try:
            return self.reader.descendants(pid)
        except self.module.Blocked as error:
            raise Blocked(error.code)


def _process_identity(record):
    if (not isinstance(record, dict) or type(record.get("pid")) is not int or record["pid"] <= 1
            or type(record.get("ppid")) is not int or record["ppid"] <= 0
            or record.get("uid") != os.getuid() or type(record.get("start_seconds")) is not int
            or record["start_seconds"] <= 0 or type(record.get("start_microseconds")) is not int
            or not 0 <= record["start_microseconds"] < 1000000
            or not isinstance(record.get("executable"), str)):
        raise Blocked("runtime_preflight_process_identity_unconfirmed")
    return {key: record[key] for key in ("pid", "ppid", "uid", "start_seconds", "start_microseconds", "executable")}


def _observe_hosts(auditor, pid, candidate, root_identity, pinned_host, observations):
    current = auditor.process(pid)
    if current is None:
        return root_identity
    current = _process_identity(current)
    if current["pid"] != pid or current["executable"] != str(candidate):
        raise Blocked("runtime_preflight_candidate_process_mismatch")
    if root_identity is not None and current != root_identity:
        raise Blocked("runtime_preflight_candidate_pid_reused")
    root_identity = current
    descendants = auditor.descendants(pid)
    if not isinstance(descendants, list) or len(descendants) > 4096:
        raise Blocked("runtime_preflight_descendants_unconfirmed")
    by_pid = {item.get("pid"): item for item in descendants if isinstance(item, dict)}
    for item in descendants:
        if not isinstance(item, dict) or item.get("executable") != pinned_host["path"]:
            continue
        host = _process_identity(item)
        # Validate the observed parent chain back to this exact selected root,
        # rather than trusting a same-name process from an unrelated tree.
        parent, visited = host["ppid"], {host["pid"]}
        while parent != pid:
            if parent in visited or parent not in by_pid:
                raise Blocked("runtime_preflight_host_ancestry_unconfirmed")
            visited.add(parent)
            parent_record = _process_identity(by_pid[parent])
            parent = parent_record["ppid"]
        if ((host["start_seconds"], host["start_microseconds"])
                < (current["start_seconds"], current["start_microseconds"])):
            raise Blocked("runtime_preflight_host_predates_candidate")
        if auditor.process(host["pid"]) != item:
            raise Blocked("runtime_preflight_host_identity_changed")
        host["binary_sha256"] = pinned_host["sha256"]
        if host not in observations:
            if _digest(Path(host["executable"]), {os.getuid()}, MAX_HOST_BYTES)["sha256"] != pinned_host["sha256"]:
                raise Blocked("runtime_preflight_host_binary_changed")
            observations.append(host)
    return root_identity


def _stop_preflight(process):
    """Only stop the newly spawned client, never Desktop or shared helpers."""
    if process.poll() is None:
        process.terminate()
    try:
        process.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=3)


def _run_observed(command, prompt, environment, cwd, timeout, candidate, pinned_host,
                  auditor, clock=time.monotonic):
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=environment, cwd=cwd)
    root_identity, observations = None, []
    deadline = clock() + timeout
    first = True
    try:
        while True:
            root_identity = _observe_hosts(auditor, process.pid, candidate, root_identity, pinned_host, observations)
            remaining = deadline - clock()
            if remaining <= 0:
                raise Blocked("runtime_preflight_timeout", {"operation_outcome": "unknown", "injection_allowed": False})
            try:
                stdout, stderr = process.communicate(input=prompt if first else None,
                                                     timeout=min(0.05, remaining))
                if root_identity is None:
                    raise Blocked("runtime_preflight_candidate_process_unobserved")
                return subprocess.CompletedProcess(command, process.returncode, stdout, stderr), root_identity, observations
            except subprocess.TimeoutExpired as partial:
                first = False
                if any(isinstance(value, bytes) and len(value) > MAX_EVENT_BYTES
                       for value in (partial.stdout, partial.stderr)):
                    raise Blocked("runtime_preflight_output_exceeds_limit")
    except BaseException:
        _stop_preflight(process)
        raise


def _diagnostic_item(event_type, item, marker):
    """Opt-in public event schema and bounded error text, never model prose."""
    item_type = item.get("type", "")
    result = {"event_type": event_type, "item_type": item_type,
              "keys": sorted(key for key in item if isinstance(key, str)
                             and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", key))[:64]}
    for key in ("tool_name", "tool", "name", "status"):
        value = item.get(key)
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", value):
            result[key] = value
    error_text = []
    if item_type == "error":
        for key in ("message", "error"):
            value = item.get(key)
            if isinstance(value, dict):
                value = value.get("message")
            if isinstance(value, str):
                # This optional diagnostic is limited to the public error
                # item's message, never arbitrary event text or tool output.
                excerpt = value.replace(marker, "<preflight-marker>")
                excerpt = re.sub(r"/Users/[^/\s]+", "<home>", excerpt)
                excerpt = re.sub(r"sk-[A-Za-z0-9_-]{12,}", "<redacted-token>", excerpt)
                excerpt = re.sub(r"(?i)bearer\s+\S+", "Bearer <redacted-token>", excerpt)
                error_text.append(excerpt[:512])
        if error_text:
            result["error_message_excerpts"] = error_text[:2]
    text = json.dumps(item, ensure_ascii=False).lower()
    result["known_error_phrases"] = [phrase for phrase in DIAGNOSTIC_PHRASES if phrase.lower() in text]
    command = item.get("command")
    if isinstance(command, str):
        result["command_is_exact_true"] = command.strip() in ("/usr/bin/true", "true")
        result["command_mentions_code_mode"] = any(phrase in command for phrase in ("tools.exec_command", "functions.exec", "code-mode-host"))
    return result


def analyze_preflight_events(raw, marker, diagnostic=False, expected_command=None):
    """Accept tool completion/output evidence, never an agent's echoed marker.

    CLI JSONL versions can expose code-mode calls as a dedicated item or a
    named tool-call item. Unknown event shapes fail closed; the returned types
    and hashes permit adaptation without saving raw responses.
    """
    if not isinstance(raw, bytes) or len(raw) > MAX_EVENT_BYTES:
        raise Blocked("runtime_preflight_output_exceeds_limit")
    event_types, item_types = set(), set()
    complete = False
    command_proof = False
    other_errors = 0
    warnings = 0
    count = 0
    shapes = []
    try:
        for line in raw.splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            if not isinstance(event, dict):
                raise ValueError()
            count += 1
            event_type = event.get("type", "")
            if isinstance(event_type, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", event_type):
                event_types.add(event_type)
            item = event.get("item", {})
            if not isinstance(item, dict):
                continue
            item_type = item.get("type", "")
            if isinstance(item_type, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", item_type):
                item_types.add(item_type)
            if item_type == "error":
                if _development_warning(item):
                    warnings += 1
                else:
                    other_errors += 1
            if diagnostic and len(shapes) < 24:
                shape = _diagnostic_item(event_type, item, marker)
                if shape not in shapes:
                    shapes.append(shape)
            if event_type != "item.completed":
                continue
            if (item_type == "command_execution" and item.get("status") == "completed"
                    and type(item.get("exit_code")) is int and item["exit_code"] == 0
                    and _same_command(item.get("command"), expected_command)
                    and _proof_present(item.get("aggregated_output"), marker)):
                command_proof = True
            tool_name = item.get("tool_name", item.get("tool", item.get("name")))
            is_code = (isinstance(item_type, str) and "code_mode" in item_type)
            is_code = is_code or (item_type in ("tool_call", "dynamic_tool_call", "function_call")
                                 and tool_name in ("functions.exec", "exec"))
            if not is_code or item.get("is_error") is True or item.get("status") in ("failed", "error", "in_progress"):
                continue
            code = next((item[key] for key in ("code", "source", "input", "arguments")
                         if isinstance(item.get(key), str)), "")
            if not all(part in code for part in ("tools.exec_command", "/usr/bin/true", "text(", marker)):
                continue
            complete = any(_proof_present(item[key], marker)
                           for key in ("output", "result", "response", "content", "aggregated_output") if key in item) or complete
    except (ValueError, UnicodeError, RecursionError):
        raise Blocked("runtime_preflight_invalid_jsonl")
    result = {"code_mode_and_nested_exec_confirmed": complete, "event_count": count,
              "event_types": sorted(event_types), "item_types": sorted(item_types),
              "stdout_bytes": len(raw), "stdout_sha256": _sha(raw),
              "nested_command_proof_confirmed": command_proof,
              "unrecognized_error_item_count": other_errors, "known_feature_warning_count": warnings}
    if diagnostic:
        result["diagnostic_items"] = shapes
    return result


def runtime_preflight(runtime, candidate_cli, sidecars, timeout=120, disabled_mcp=DEFAULT_DISABLED_MCP,
                      diagnostic=False, process_auditor=None):
    """Explicitly run one ephemeral public CLI turn before Desktop disruption.

    The parent must confirm the CLI event format with a real smoke test. A
    missing/unknown tool event is unconfirmed even if the final answer repeats
    the expected marker. Timeouts block injection and do not prove cancellation
    of a nested operation. No raw response is returned or persisted. Opt-in
    diagnostic mode exposes schema keysets and bounded public error messages;
    it never exposes agent prose, command output, environment, or stderr text.
    """
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0 < timeout <= 180:
        raise Blocked("runtime_preflight_deadline_required")
    validate_sidecars(runtime, candidate_cli, sidecars)
    _, _, candidate, workspace = _paths(runtime, candidate_cli)
    cli_before = _digest(candidate, {os.getuid()})
    marker = "ccuh-runtime-" + uuid.uuid4().hex
    nested_command = build_nested_command(marker)
    code = ('const r = await tools.exec_command({cmd:' + json.dumps(nested_command) + ',login:false,max_output_tokens:256}); '
            'if (r.exit_code !== 0) throw new Error("nested exec failed"); '
            'text(r.output);')
    prompt = ("Execute exactly one functions.exec tool call containing the following JavaScript, then finish. "
              "Use the code-mode exec tool; do not substitute a direct shell tool. Do not inspect files, "
              "configuration, credentials, environment, apps, network, or other tools. Do not edit anything. "
              "Do not call any other tool. Return only done afterward.\n\n" + code)
    environment = dict(os.environ)
    environment["CODEX_CLI_PATH"] = str(candidate)
    code_host = next(host["candidate"] for host in sidecars["hosts"] if host["name"] == "codex-code-mode-host")
    try:
        auditor = process_auditor or ProcessAuditor()
        with tempfile.TemporaryDirectory(prefix="ccuh-runtime-proof-", dir=str(workspace)) as cwd:
            command = build_preflight_command(candidate, cwd, disabled_mcp)
            completed, candidate_process, observed_hosts = _run_observed(
                command, prompt.encode("utf-8"), environment, cwd, timeout, candidate, code_host, auditor)
    except subprocess.TimeoutExpired:
        raise Blocked("runtime_preflight_timeout", {"operation_outcome": "unknown", "injection_allowed": False})
    except OSError:
        raise Blocked("runtime_preflight_process_unconfirmed")
    details = {"exit_code": completed.returncode, "stderr_bytes": len(completed.stderr),
               "stderr_sha256": _sha(completed.stderr), "model_override_supplied": False,
               "scope": "ephemeral_public_cli_code_mode_and_nested_exec", "raw_response_saved": False,
               "parent_environment_changed": False, "native_authentication_recovered": False,
               "proof_method": "selected_signed_code_host_and_exact_public_command_output",
               "candidate_process": candidate_process, "code_mode_host_observations": observed_hosts,
               "nested_command_sha256": _sha(nested_command.encode()),
               "required_code_mode_features": ["code_mode", "code_mode_only"]}
    details.update(analyze_preflight_events(completed.stdout, marker, diagnostic=diagnostic,
                                           expected_command=nested_command))
    details["wrapper_event_visible"] = details["code_mode_and_nested_exec_confirmed"]
    details["code_mode_and_nested_exec_confirmed"] = bool(observed_hosts) and details["nested_command_proof_confirmed"]
    if (completed.returncode != 0 or not details["code_mode_and_nested_exec_confirmed"]
            or details["unrecognized_error_item_count"]):
        raise Blocked("runtime_code_mode_completion_unconfirmed", details)
    if _digest(candidate, {os.getuid()}) != cli_before:
        raise Blocked("runtime_candidate_changed_during_preflight")
    validate_sidecars(runtime, candidate, sidecars)
    return {"schema_version": 1, "kind": "ccuh_developer_runtime_preflight", **details,
            "candidate_cli_sha256": cli_before["sha256"], "sidecars_revalidated": True}
