#!/usr/bin/env python3
"""Conservative CODEX_CLI_PATH recovery, with private rollback.

File stores are isolated launcher fixtures, not Codex configuration files.
The launchctl backend changes only future processes' environment. Neither
backend repairs an existing native connection or restarts an application.
Existing executables stay unchanged by default. Explicit ad-hoc override
removal requires exact native authentication evidence and reverified signing.
"""

import argparse
import contextlib
import errno
import hashlib
import importlib.util
import json
import os
import platform
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path


KEY = "CODEX_CLI_PATH"
LIMIT = 1024 * 1024
PLAN_TTL = 900
OFFICIAL_RELATIVE = Path("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")
OPENAI_TEAM = "2DC432GLL2"


class RecoveryError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def digest(value):
    return hashlib.sha256(value).hexdigest()


def value_digest(value):
    return digest(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def read_json(path):
    with Path(path).open("rb") as handle:
        raw = handle.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise RecoveryError("input_too_large")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError):
        raise RecoveryError("invalid_json")
    if not isinstance(value, dict):
        raise RecoveryError("expected_json_object")
    return value, raw


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def private_create(path, value):
    """Never overwrite a plan, evidence record, or rollback file."""
    target = Path(path)
    descriptor = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(encode(value))
        handle.flush()
        os.fsync(handle.fileno())


def atomic_replace(path, raw, mode):
    target = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".ccuh-recovery-", dir=str(target.parent))
    try:
        with os.fdopen(descriptor, "wb") as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def owned_regular_file(path, private=False):
    target = Path(path)
    info = target.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise RecoveryError("unsafe_file")
    if private and stat.S_IMODE(info.st_mode) & 0o077:
        raise RecoveryError("private_file_permissions_required")
    return info


@contextlib.contextmanager
def fixture_lock(path):
    # Cooperative fixture writers only. Never delete another writer's lock.
    lock = Path(path).with_name(Path(path).name + ".ccuh-recovery.lock")
    try:
        descriptor = os.open(str(lock), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise RecoveryError("fixture_busy")
    try:
        os.close(descriptor)
        yield
    finally:
        lock.unlink()


class Store:
    def __init__(self, kind, path=None):
        if kind not in ("file", "launchctl"):
            raise RecoveryError("unsupported_backend")
        self.kind = kind
        self.path = Path(path).absolute() if kind == "file" and path else None
        if kind == "file" and self.path is None:
            raise RecoveryError("environment_file_required")
        if kind == "launchctl" and platform.system() != "Darwin":
            raise RecoveryError("launchctl_requires_macos")

    def descriptor(self):
        return {"kind": self.kind, "path": str(self.path) if self.path else None}

    def snapshot(self):
        if self.kind == "file":
            owned_regular_file(self.path)
            data, raw = read_json(self.path)
            value = data.get(KEY)
            if value is not None and not isinstance(value, str):
                raise RecoveryError("invalid_override_type")
            return {"value": value or None, "fingerprint": digest(raw), "data": data}
        completed = subprocess.run(["/bin/launchctl", "getenv", KEY], capture_output=True, text=True, timeout=10)
        if completed.returncode != 0:
            raise RecoveryError("launchctl_read_unconfirmed")
        value = completed.stdout.rstrip("\n") or None
        return {"value": value, "fingerprint": value_digest(value)}

    def change(self, current, value):
        if self.snapshot()["fingerprint"] != current["fingerprint"]:
            raise RecoveryError("source_changed")
        if self.kind == "file":
            data = dict(current["data"])
            if value is None:
                data.pop(KEY, None)
            else:
                data[KEY] = value
            info = owned_regular_file(self.path)
            atomic_replace(self.path, encode(data), stat.S_IMODE(info.st_mode))
        else:
            command = ["/bin/launchctl", "unsetenv", KEY] if value is None else ["/bin/launchctl", "setenv", KEY, value]
            completed = subprocess.run(command, capture_output=True, timeout=10)
            if completed.returncode != 0:
                raise RecoveryError("launchctl_write_unconfirmed")
        observed = self.snapshot()
        if observed["value"] != value:
            raise RecoveryError("repair_outcome_unknown")
        return observed

    def lock(self):
        return fixture_lock(self.path) if self.kind == "file" else contextlib.nullcontext()


def runtime_evidence(app_path):
    """Verify the real Mach-O, not the enclosing app's resource seal.

    Some execution sandboxes cause codesign to report a false signature failure.
    Any failed check is therefore 'unconfirmed', never proof of invalid signing.
    Apply/startup require a context where verification actually succeeds.
    """
    app = Path(app_path).resolve()
    binary = app / OFFICIAL_RELATIVE
    result = {"verified": False, "binary_exists": binary.is_file(), "signing_team_matches": False}
    try:
        with (app / "Contents/Info.plist").open("rb") as handle:
            metadata = plistlib.loads(handle.read(LIMIT))
        result["bundle_identity_matches"] = metadata.get("CFBundleIdentifier") == "com.openai.codex"
        if not result["bundle_identity_matches"] or not result["binary_exists"] or platform.system() != "Darwin":
            return result
        verified = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(binary)], capture_output=True, timeout=15)
        shown = subprocess.run(["/usr/bin/codesign", "--display", "--verbose=4", str(binary)], capture_output=True, text=True, timeout=15)
        team = re.search(r"^TeamIdentifier=(.+)$", shown.stderr, flags=re.MULTILINE)
        result["verification_exit_code"] = verified.returncode
        result["signing_team_matches"] = shown.returncode == 0 and bool(team) and team.group(1).strip() == OPENAI_TEAM
        result["verified"] = verified.returncode == 0 and result["signing_team_matches"]
        if result["verified"]:
            hasher = hashlib.sha256()
            with binary.open("rb") as handle:
                for chunk in iter(lambda: handle.read(LIMIT), b""):
                    hasher.update(chunk)
            result["binary_sha256"] = hasher.hexdigest()
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        pass
    return result


def response_payload(path):
    if path == "-":
        raw = sys.stdin.buffer.read(LIMIT + 1)
    else:
        with Path(path).open("rb") as handle:
            raw = handle.read(LIMIT + 1)
    if not raw.strip() or len(raw) > LIMIT:
        raise RecoveryError("invalid_diagnostic_input")
    text = raw.decode("utf-8")
    try:
        payload = json.loads(text)
    except (ValueError, RecursionError):
        payload = text
    return payload, raw


def payload_category(payload):
    # Completion uncertainty takes precedence over even an exact auth error.
    # Walk every nested dict/list, not only the outer MCP response envelope.
    pending = [(None, payload)]
    unresolved = False
    timeout_text = re.compile(r"\btimeout\b|\btimed out\b|result[_ ]unknown|outcome[_ ]unknown", re.IGNORECASE)
    while pending:
        field, value = pending.pop()
        if isinstance(value, dict):
            for key, child in value.items():
                name = key.lower().replace("_", "")
                if name in ("timeout", "timedout") and child is True:
                    return "timeout"
                if name in ("category", "status") and child == "timeout":
                    return "timeout"
                if (name == "operationoutcome" and child == "unknown") or (name == "category" and child == "operation_unresolved"):
                    unresolved = True
                pending.append((name, child))
        elif isinstance(value, list):
            pending.extend((field, child) for child in value)
        elif isinstance(value, str) and field in (None, "message", "error", "text", "stderr") and timeout_text.search(value):
            return "timeout"
    if unresolved:
        return "operation_unresolved"
    if isinstance(payload, dict):
        # Keep a known unknown outcome when consuming doctor's redacted output.
        if payload.get("operation_outcome") == "unknown":
            return "timeout" if payload.get("category") == "timeout" else "operation_unresolved"
        if payload.get("schema_version") == 1 and payload.get("mode") in ("response", "environment"):
            category = payload.get("category")
            known = {"operation_unresolved", "capability_unavailable", "browser_setup_unavailable", "authentication_failed", "permission_denied",
                     "startup_failed", "tool_unavailable", "timeout", "target_lookup_failed", "target_absent",
                     "capture_failed", "tool_error", "response_unverified", "input_error", "environment_checked"}
            return category if category in known else "tool_error"
    spec = importlib.util.spec_from_file_location("ccuh_recovery_doctor", Path(__file__).with_name("doctor.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.classify_response(payload)["category"]


def response_category(path):
    return None if path is None else payload_category(response_payload(path)[0])


def native_authentication_evidence(path):
    """Read one replayable error artifact, never infer evidence from a category.

    Accept a native error object, an MCP isError text block, or a raw error
    string. The code and sender-authentication message must occur together.
    This verifies supplied evidence, not its provenance or the native caller.
    """
    if not path or path == "-":
        raise RecoveryError("native_authentication_evidence_file_required")
    selected = Path(path).absolute()
    owned_regular_file(selected)
    payload, raw = response_payload(selected)
    if payload_category(payload) in ("timeout", "operation_unresolved"):
        raise RecoveryError("operation_completion_unconfirmed")
    message_pattern = re.compile(r"\bsender process (?:is )?not authenticated\b", re.IGNORECASE)

    def error_text(value):
        return isinstance(value, str) and bool(re.search(r"(?<![\d.])-10000(?![\d.])", value)) and bool(message_pattern.search(value))

    def confirmed(value):
        if not isinstance(value, dict):
            return False
        if isinstance(value.get("code"), int) and not isinstance(value.get("code"), bool) and value["code"] == -10000 and isinstance(value.get("message"), str) and message_pattern.search(value["message"]):
            return True
        if value.get("isError") is True and isinstance(value.get("content"), list):
            if any(isinstance(item, dict) and error_text(item.get("text")) for item in value["content"]):
                return True
        return any(confirmed(value[key]) for key in ("error", "result") if isinstance(value.get(key), dict))

    if not (error_text(payload) if isinstance(payload, str) else confirmed(payload)):
        raise RecoveryError("exact_native_authentication_evidence_required")
    return {"path": str(selected), "sha256": digest(raw), "category": "authentication_failed"}


def adhoc_candidate_evidence(value):
    """Only a valid, executable Mach-O with explicit ad-hoc signing qualifies.

    Missing TeamIdentifier alone is insufficient. Failed codesign verification
    (including sandbox errors) remains unconfirmed and must preserve the path.
    """
    result = {"verified": False}
    try:
        candidate = Path(value).expanduser()
        if not candidate.is_absolute() or platform.system() != "Darwin":
            return result
        candidate = candidate.resolve(strict=True)
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            return result
        with candidate.open("rb") as handle:
            if handle.read(4) not in (b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"):
                return result
        verified = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(candidate)], capture_output=True, timeout=15)
        shown = subprocess.run(["/usr/bin/codesign", "--display", "--verbose=4", str(candidate)], capture_output=True, text=True, timeout=15)
        signature = re.search(r"^Signature=(.+)$", shown.stderr, flags=re.MULTILINE)
        team = re.search(r"^TeamIdentifier=(.*)$", shown.stderr, flags=re.MULTILINE)
        adhoc = bool(signature) and signature.group(1).strip() == "adhoc"
        no_team = team is None or team.group(1).strip() == "not set"
        if verified.returncode != 0 or shown.returncode != 0 or not adhoc or not no_team:
            return result
        hasher = hashlib.sha256()
        with candidate.open("rb") as handle:
            for chunk in iter(lambda: handle.read(LIMIT), b""):
                hasher.update(chunk)
        return {"verified": True, "resolved_path": str(candidate), "binary_sha256": hasher.hexdigest(),
                "signature": "adhoc", "team_identifier_absent": True}
    except (OSError, ValueError, TypeError, RuntimeError, subprocess.TimeoutExpired):
        return result


def response_block(category):
    if category in ("operation_unresolved", "timeout"):
        return "operation_completion_unconfirmed"
    if category == "browser_setup_unavailable":
        return "host_browser_setup_required"
    if category not in (None, "startup_failed", "response_unverified", "environment_checked"):
        return "diagnostic_requires_other_recovery"
    return None


def assess_override(value, official):
    if not value:
        return "no_override"
    try:
        candidate = Path(value).expanduser()
        if not candidate.is_absolute():
            return "ambiguous_override_preserved"
        # exists()/is_file() can hide path errors on newer Python versions.
        # Only an explicit ENOENT from this override proves it is missing.
        try:
            info = candidate.stat()
        except OSError as error:
            if error.errno == errno.ENOENT:
                return "missing_override"
            raise
        if candidate.resolve() == official.resolve() and stat.S_ISREG(info.st_mode):
            return "official_override_preserved"
        return "existing_override_preserved"
    except (OSError, ValueError, RuntimeError):
        return "override_path_unconfirmed_preserved"


def make_plan(store, app_path, category=None, remove_adhoc=False, response_path=None):
    current = store.snapshot()
    app = Path(app_path).resolve()
    reason = assess_override(current["value"], app / OFFICIAL_RELATIVE)
    blocked = response_block(category)
    runtime = runtime_evidence(app)
    operation = "remove_adhoc_cli_override" if remove_adhoc else "remove_stale_cli_override"
    native_evidence = candidate = None
    if remove_adhoc:
        if category in ("operation_unresolved", "timeout"):
            raise RecoveryError("operation_completion_unconfirmed")
        native_evidence = native_authentication_evidence(response_path)
        if category not in (None, "authentication_failed"):
            status, reason = "blocked", "diagnostic_requires_other_recovery"
        elif reason != "existing_override_preserved":
            status = "no_change"
        elif not runtime.get("verified"):
            status, reason = "blocked", "runtime_verification_unconfirmed"
        else:
            candidate = adhoc_candidate_evidence(current["value"])
            status, reason = ("repair_available", "native_authentication_error_with_adhoc_override") if candidate.get("verified") else ("blocked", "adhoc_candidate_verification_unconfirmed")
    elif blocked:
        status, reason = "blocked", blocked
    elif reason != "missing_override":
        status = "no_change"
    elif not runtime.get("verified"):
        status, reason = "blocked", "runtime_verification_unconfirmed"
    else:
        status, reason = "repair_available", "missing_override"
    return {"schema_version": 1, "operation": operation, "status": status, "reason": reason,
            "created_at": time.time(), "uid": os.getuid(), "source": store.descriptor(), "app_path": str(app),
            "source_fingerprint": current["fingerprint"], "override_fingerprint": value_digest(current["value"]),
            "runtime": runtime, "diagnostic_category": category,
            "native_evidence": native_evidence, "candidate": candidate,
            "scope": "isolated_launcher_fixture" if store.kind == "file" else "future_process_launch_environment",
            "current_process_environment_changed": False, "current_connection": "unverified",
            "restart_or_new_session_required": store.kind == "launchctl"}


def validate_private(path):
    owned_regular_file(path, private=True)
    return read_json(path)[0]


def apply_plan(plan_path, backup_path, category=None):
    plan = validate_private(plan_path)
    operation = plan.get("operation")
    adhoc = operation == "remove_adhoc_cli_override"
    def blocks(selected):
        return response_block(selected) and not (adhoc and selected == "authentication_failed")
    if blocks(category) or blocks(plan.get("diagnostic_category")):
        raise RecoveryError("operation_or_diagnostic_blocks_apply")
    expected_reason = "native_authentication_error_with_adhoc_override" if adhoc else "missing_override"
    if plan.get("schema_version") != 1 or operation not in ("remove_stale_cli_override", "remove_adhoc_cli_override") or plan.get("status") != "repair_available" or plan.get("reason") != expected_reason:
        raise RecoveryError("plan_not_applicable")
    if plan.get("uid") != os.getuid() or not 0 <= time.time() - plan["created_at"] <= PLAN_TTL:
        raise RecoveryError("plan_expired_or_wrong_user")
    store = Store(plan["source"]["kind"], plan["source"].get("path"))
    with store.lock():
        current = store.snapshot()
        if current["fingerprint"] != plan["source_fingerprint"] or value_digest(current["value"]) != plan["override_fingerprint"]:
            raise RecoveryError("source_changed")
        expected_override = "existing_override_preserved" if adhoc else "missing_override"
        if assess_override(current["value"], Path(plan["app_path"]) / OFFICIAL_RELATIVE) != expected_override:
            raise RecoveryError("override_must_be_preserved")
        if adhoc:
            evidence = plan.get("native_evidence")
            candidate = plan.get("candidate")
            if not isinstance(evidence, dict) or not isinstance(candidate, dict) or not candidate.get("verified"):
                raise RecoveryError("plan_not_applicable")
        runtime = runtime_evidence(plan["app_path"])
        if not runtime.get("verified") or runtime.get("binary_sha256") != plan["runtime"].get("binary_sha256"):
            raise RecoveryError("runtime_verification_unconfirmed")
        if adhoc:
            if adhoc_candidate_evidence(current["value"]) != candidate:
                raise RecoveryError("adhoc_candidate_changed_or_unconfirmed")
            # Re-read the exact artifact after potentially slow signature checks,
            # just before preparing the backup/change. This is not atomic CAS.
            if native_authentication_evidence(evidence.get("path")) != evidence:
                raise RecoveryError("native_authentication_evidence_changed")
        if store.kind == "file":
            after_data = dict(current["data"])
            after_data.pop(KEY, None)
            after_fingerprint = digest(encode(after_data))
        else:
            after_fingerprint = value_digest(None)
        backup = {"schema_version": 1, "uid": os.getuid(), "source": store.descriptor(), "original_override": current["value"],
                  "before_fingerprint": current["fingerprint"], "after_fingerprint": after_fingerprint,
                  "scope": plan["scope"], "operation": operation, "applied": False}
        private_create(backup_path, backup)
        observed = store.change(current, None)
        backup["applied"] = True
        atomic_replace(backup_path, encode(backup), 0o600)
        if observed["fingerprint"] != after_fingerprint:
            raise RecoveryError("repair_outcome_unknown")
    return {"status": "repair_applied", "action": operation, "backup_created": True,
            "scope": plan["scope"], "current_process_environment_changed": False, "current_connection": "unverified",
            "restart_or_new_session_required": store.kind == "launchctl", "native_authentication_recovered": False}


def restore_backup(path):
    backup = validate_private(path)
    if backup.get("schema_version") != 1 or backup.get("uid") != os.getuid() or not isinstance(backup.get("original_override"), str):
        raise RecoveryError("backup_not_restorable")
    store = Store(backup["source"]["kind"], backup["source"].get("path"))
    with store.lock():
        current = store.snapshot()
        if current["fingerprint"] != backup["after_fingerprint"] or current["value"] is not None:
            raise RecoveryError("restore_source_changed")
        store.change(current, backup["original_override"])
        backup["restored"] = True
        atomic_replace(path, encode(backup), 0o600)
    return {"status": "restore_applied", "scope": backup["scope"], "current_process_environment_changed": False,
            "current_connection": "unverified", "restart_or_new_session_required": store.kind == "launchctl"}


def predispatch(request, available, permission_state, diagnostic_category=None):
    """Gate only standalone probes; never rewrite tab creation or UI input."""
    if response_block(diagnostic_category) == "operation_completion_unconfirmed":
        return {"decision": "wait_for_operation_completion", "dispatch_allowed": False, "request_modified": False}
    if permission_state in ("pending", "denied"):
        return {"decision": "wait_for_permission", "dispatch_allowed": False, "request_modified": False}
    if request.get("kind") != "optional_capability_probe" or not isinstance(request.get("capability"), str):
        return {"decision": "not_a_supported_recovery_probe", "dispatch_allowed": False, "request_modified": False}
    if request["capability"] not in available:
        optional = request.get("optional") is True
        return {"decision": "skip_optional_probe" if optional else "wait_for_supported_capability", "dispatch_allowed": False, "request_modified": False}
    if request.get("requires_permission") is True and permission_state != "granted":
        return {"decision": "wait_for_permission", "dispatch_allowed": False, "request_modified": False}
    return {"decision": "probe_supported", "dispatch_allowed": True, "request_modified": False}


def selected_startup(store, app_path):
    current = store.snapshot()
    binary = current["value"] or str(Path(app_path).resolve() / OFFICIAL_RELATIVE)
    child_environment = dict(os.environ)
    child_environment.pop(KEY, None)
    if current["value"]:
        child_environment[KEY] = current["value"]
    try:
        completed = subprocess.run([binary, "--version"], env=child_environment, capture_output=True, text=True, timeout=15)
        version = re.search(r"^codex-cli [A-Za-z0-9._+\-]+$", completed.stdout.strip(), flags=re.MULTILINE)
        return {"category": "startup_completed" if completed.returncode == 0 else "startup_failed", "exit_code": completed.returncode,
                "version": version.group(0) if version else None}
    except FileNotFoundError as error:
        return {"category": "startup_failed", "errno": "ENOENT" if error.errno == errno.ENOENT else "not_available"}
    except subprocess.TimeoutExpired:
        return {"category": "startup_outcome_unknown", "operation_outcome": "unknown"}


def startup_drill(store, app_path, plan_path, backup_path):
    if store.kind != "file":
        raise RecoveryError("startup_drill_requires_isolated_file_store")
    initial = store.snapshot()
    if assess_override(initial["value"], Path(app_path).resolve() / OFFICIAL_RELATIVE) != "missing_override":
        raise RecoveryError("startup_drill_requires_missing_override")
    runtime = runtime_evidence(app_path)
    if not runtime.get("verified"):
        raise RecoveryError("runtime_verification_unconfirmed")
    before = selected_startup(store, app_path)
    if before.get("errno") != "ENOENT":
        raise RecoveryError("missing_executable_not_reproduced")
    plan = make_plan(store, app_path, "startup_failed")
    private_create(plan_path, plan)
    repair = apply_plan(plan_path, backup_path, "startup_failed")
    after = selected_startup(store, app_path)
    return {"status": "startup_recovered" if after.get("category") == "startup_completed" else "startup_not_recovered",
            "scope": "isolated_child_process_startup", "before": before, "repair": repair, "after": after,
            "official_runtime_verified": True, "rollback_available": True, "current_connection": "unverified",
            "native_authentication_recovered": False, "current_process_environment_changed": False}


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=fr'''Startup drill (run instead of separate --repair-plan/--apply):
  The isolated fixture must still contain CODEX_CLI_PATH pointing to a missing
  executable. An already repaired fixture is rejected. Use fresh output paths.

  python3 "{Path(__file__).resolve()}" --startup-drill \
    --environment-file "/path/to/selected-launcher.json" \
    --plan-file "/private/tmp/ccuh-startup-plan.json" \
    --backup-file "/private/tmp/ccuh-startup-backup.json" \
    --evidence-file "/private/tmp/ccuh-startup-evidence.json"

The drill runs CLI --version before and after repairing only that fixture.
It does not restart an app or verify native authentication. --evidence-file is
optional. Plans, backups, and evidence files are never overwritten; even a
blocked repair plan can create its output file, so use a new path when retrying.

Exit codes: 0 = operation completed/no change; 1 = blocked or recovery not
confirmed; 2 = usage/input error. Plans and backups use mode 0600. Backup values
are private and never printed.''')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--repair-plan", action="store_true")
    action.add_argument("--apply", metavar="PLAN")
    action.add_argument("--restore", metavar="BACKUP")
    action.add_argument("--predispatch", action="store_true")
    action.add_argument("--startup-drill", action="store_true", help="Repair an isolated missing-override fixture and compare CLI --version before/after; requires --environment-file, --plan-file, and --backup-file.")
    backend = parser.add_mutually_exclusive_group()
    backend.add_argument("--environment-file", help="Explicit isolated JSON launcher fixture; not config.toml.")
    backend.add_argument("--launchctl", action="store_true", help="Explicit macOS future-process environment backend; does not update this session.")
    parser.add_argument("--plan-file", help="Fresh plan output path; required by --repair-plan and --startup-drill.")
    parser.add_argument("--backup-file", help="Fresh rollback output path; required by --apply and --startup-drill.")
    parser.add_argument("--evidence-file", help="Optional fresh output path for the JSON report.")
    parser.add_argument("--app-path", default="/Applications/ChatGPT.app")
    parser.add_argument("--response-file", help="One supplied diagnostic response (or - for stdin); unresolved/timeouts block mutation.")
    parser.add_argument("--remove-adhoc-cli-override", action="store_true", help="Opt in only with --repair-plan: remove an existing verified ad-hoc CLI override after exact native -10000 authentication evidence.")
    parser.add_argument("--request-file")
    parser.add_argument("--available-capability", action="append", default=[])
    parser.add_argument("--permission-state", choices=("unknown", "pending", "denied", "granted"), default="unknown")
    args = parser.parse_args(argv)
    try:
        if args.remove_adhoc_cli_override and not args.repair_plan:
            raise RecoveryError("adhoc_removal_requires_repair_plan")
        category = response_category(args.response_file)
        if args.predispatch:
            if not args.request_file:
                raise RecoveryError("request_file_required")
            report = predispatch(read_json(args.request_file)[0], args.available_capability, args.permission_state, category)
        elif args.apply:
            if not args.backup_file:
                raise RecoveryError("backup_file_required")
            report = apply_plan(args.apply, args.backup_file, category)
        elif args.restore:
            if response_block(category):
                raise RecoveryError("operation_or_diagnostic_blocks_restore")
            report = restore_backup(args.restore)
        else:
            if not args.environment_file and not args.launchctl:
                raise RecoveryError("explicit_backend_required")
            if not args.plan_file:
                raise RecoveryError("plan_file_required")
            store = Store("file" if args.environment_file else "launchctl", args.environment_file)
            if args.startup_drill:
                if response_block(category):
                    raise RecoveryError("operation_or_diagnostic_blocks_apply")
                if not args.backup_file:
                    raise RecoveryError("backup_file_required")
                report = startup_drill(store, args.app_path, args.plan_file, args.backup_file)
            else:
                plan = make_plan(store, args.app_path, category, args.remove_adhoc_cli_override, args.response_file)
                private_create(args.plan_file, plan)
                report = {key: plan[key] for key in ("status", "reason", "scope", "current_process_environment_changed", "current_connection", "restart_or_new_session_required")}
        if args.evidence_file:
            private_create(args.evidence_file, report)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if report.get("status") in ("blocked", "startup_not_recovered") else 0
    except RecoveryError as error:
        print(json.dumps({"status": "blocked", "reason": error.code, "current_connection": "unverified", "native_authentication_recovered": False}))
        return 1
    except (OSError, ValueError, KeyError, TypeError, UnicodeError, RuntimeError, subprocess.TimeoutExpired):
        print(json.dumps({"status": "blocked", "reason": "input_or_system_operation_unconfirmed", "current_connection": "unverified", "operation_outcome": "unknown"}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
