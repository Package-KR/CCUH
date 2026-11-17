#!/usr/bin/env python3
"""Plan and schedule a guarded, graceful Codex Desktop restart on macOS.

Planning is read only apart from its new private plan. Execution starts a
detached worker and waits for its ready handshake. The worker uses public
AppKit lifecycle APIs, never force-quits, and launches the selected official
application at most once without activation. Optional same-chat queueing does
not prove message processing or native authentication recovery. A subsequent
read-only call in the same chat must establish recovery separately.
"""

import argparse
import ctypes
import datetime
import errno
import hashlib
import json
import os
import platform
import plistlib
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


LIMIT = 1024 * 1024
TEAM = "2DC432GLL2"
BUNDLE = "com.openai.codex"
KEY = "CODEX_CLI_PATH"
CLI_RELATIVE = "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
PLAN_TTL = 300
IDLE_TTL = 120
CHECKPOINT_TTL = 900
LAUNCH_WITHOUT_ACTIVATION = 0x00000200
SCHEMA = 1


class Blocked(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(LIMIT), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc(seconds=None):
    return datetime.datetime.fromtimestamp(time.time() if seconds is None else seconds,
                                           datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp(value):
    if not isinstance(value, str):
        raise Blocked("utc_timestamp_required")
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.timestamp()
    except (ValueError, OverflowError):
        raise Blocked("utc_timestamp_required")


def fresh(value, ttl, now):
    age = now - timestamp(value)
    if age < -5 or age > ttl:
        raise Blocked("guard_evidence_stale")


def read_private(path, private=True):
    """Read an owned regular file without following a substituted symlink."""
    target = Path(path)
    before = target.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid():
        raise Blocked("owned_regular_file_required")
    if private and stat.S_IMODE(before.st_mode) & 0o077:
        raise Blocked("private_file_permissions_required")
    descriptor = os.open(str(target), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as handle:
        opened = os.fstat(handle.fileno())
        if not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid() or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise Blocked("source_changed_during_read")
        if private and stat.S_IMODE(opened.st_mode) & 0o077:
            raise Blocked("private_file_permissions_required")
        raw = handle.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise Blocked("file_exceeds_one_mib")
    return raw


def read_json(path):
    raw = read_private(path)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError):
        raise Blocked("invalid_json")
    if not isinstance(value, dict):
        raise Blocked("json_object_required")
    return value, raw


def create_private(path, value):
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(encoded(value))
        handle.flush()
        os.fsync(handle.fileno())


def replace_private(path, value):
    # Only the worker's own already-private receipt is replaced.
    read_private(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".ccuh-restart-", dir=str(Path(path).parent))
    try:
        with os.fdopen(descriptor, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(encoded(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def guard_files(checkpoint_path, idle_path, thread_id, now, check_fresh=True):
    checkpoint, checkpoint_raw = read_json(checkpoint_path)
    idle, idle_raw = read_json(idle_path)
    if checkpoint.get("schema_version") != SCHEMA or checkpoint.get("thread_id") != thread_id:
        raise Blocked("checkpoint_thread_mismatch")
    if check_fresh:
        fresh(checkpoint.get("created_at"), CHECKPOINT_TTL, now)
    if checkpoint.get("ready_for_restart") is not True or checkpoint.get("native_operations_pending") is not False or checkpoint.get("mutation_outcome_unknown") is not False:
        raise Blocked("checkpoint_not_ready_or_operation_unresolved")
    if idle.get("schema_version") != SCHEMA or idle.get("current_thread_id") != thread_id:
        raise Blocked("idle_evidence_thread_mismatch")
    if check_fresh:
        fresh(idle.get("observed_at"), IDLE_TTL, now)
    if idle.get("source") != "codex_desktop_list_threads" or idle.get("inventory_complete") is not True or idle.get("background_work_confirmed_idle") is not True:
        raise Blocked("complete_idle_inventory_required")
    if idle.get("other_busy_thread_ids") != [] or idle.get("other_unknown_thread_ids") != []:
        raise Blocked("other_threads_busy_or_unknown")
    return {"checkpoint": {"path": str(Path(checkpoint_path).absolute()), "sha256": sha(checkpoint_raw)},
            "idle": {"path": str(Path(idle_path).absolute()), "sha256": sha(idle_raw)},
            "current_thread_checkpoint_acknowledged": True}


def verified_binary(path, expected_identifier=None):
    """Verify the actual executable, not a deep enclosing-app resource seal."""
    try:
        verify = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(path)], capture_output=True, timeout=20)
        metadata = subprocess.run(["/usr/bin/codesign", "--display", "--verbose=4", str(path)], capture_output=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("official_signing_check_unavailable")
    text = metadata.stderr.decode("utf-8", "replace")
    team = re.search(r"^TeamIdentifier=([^\r\n]+)$", text, re.MULTILINE)
    identifier = re.search(r"^Identifier=([^\r\n]+)$", text, re.MULTILINE)
    if verify.returncode or metadata.returncode or not team or team.group(1).strip() != TEAM or not identifier:
        raise Blocked("official_signing_not_confirmed")
    if expected_identifier and identifier.group(1).strip() != expected_identifier:
        raise Blocked("official_executable_identifier_mismatch")
    return {"path": str(Path(path).resolve()), "sha256": file_sha(path), "signing_team": TEAM,
            "signing_verified": True, "identifier": identifier.group(1).strip()}


def official_runtime(app_path):
    app = Path(app_path).resolve()
    try:
        raw = (app / "Contents/Info.plist").read_bytes()
        if len(raw) > LIMIT:
            raise ValueError()
        metadata = plistlib.loads(raw)
        executable = metadata.get("CFBundleExecutable")
        if metadata.get("CFBundleIdentifier") != BUNDLE or not isinstance(executable, str) or not executable or Path(executable).name != executable:
            raise ValueError()
        main = (app / "Contents/MacOS" / executable).resolve()
        cli = (app / CLI_RELATIVE).resolve()
        if app not in main.parents or app not in cli.parents or not main.is_file() or not cli.is_file():
            raise ValueError()
    except (OSError, ValueError, TypeError):
        raise Blocked("official_app_metadata_unconfirmed")
    return {"app_path": str(app), "bundle_id": BUNDLE, "metadata_sha256": sha(raw),
            "main": verified_binary(main, BUNDLE), "cli": verified_binary(cli)}


def config_source(path, official_cli):
    """Conservatively recognize only absent or scalar official CLI overrides.

    An unsupported TOML representation blocks instead of guessing. This is a
    selected-file check, not a general TOML parser or a search of user files.
    """
    raw = read_private(path, private=False)
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        raise Blocked("config_source_unrecognized")
    overrides = []
    for line in text.splitlines():
        if KEY not in line or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r'\s*(?:CODEX_CLI_PATH|"CODEX_CLI_PATH"|\'CODEX_CLI_PATH\')\s*=\s*("(?:[^"\\]|\\.)*"|\'[^\']*\')\s*(?:#.*)?', line)
        if not match:
            raise Blocked("config_override_representation_unrecognized")
        literal = match.group(1)
        try:
            value = json.loads(literal) if literal.startswith('"') else literal[1:-1]
        except ValueError:
            raise Blocked("config_override_representation_unrecognized")
        if not value or not Path(value).is_absolute() or Path(value).resolve() != Path(official_cli):
            raise Blocked("config_override_not_official")
        overrides.append(value)
    return {"path": str(Path(path).absolute()), "sha256": sha(raw), "override_count": len(overrides), "overrides_absent_or_official": True}


def clean_sources(official_cli, config_path=None):
    try:
        result = subprocess.run(["/bin/launchctl", "getenv", KEY], capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("future_launch_environment_unconfirmed")
    if result.returncode or len(result.stdout) > LIMIT:
        raise Blocked("future_launch_environment_unconfirmed")
    try:
        value = result.stdout.decode("utf-8").rstrip("\n")
    except UnicodeError:
        raise Blocked("future_launch_environment_unconfirmed")
    if value and ("\0" in value or not Path(value).is_absolute() or Path(value).resolve() != Path(official_cli)):
        raise Blocked("future_launch_override_not_official")
    return {"launchctl": {"override_present": bool(value), "value_sha256": sha(value.encode()), "absent_or_official": True},
            "config": config_source(config_path, official_cli) if config_path else None,
            "parent_process_environment_changed": False}


def continuation_file(path):
    raw = read_private(path)
    if not 0 < len(raw) <= 8192:
        raise Blocked("resume_message_must_be_one_to_8192_bytes")
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        raise Blocked("resume_message_must_be_utf8")
    if not text.strip() or "\0" in text:
        raise Blocked("resume_message_must_be_nonempty_text")
    return text, {"message_file": str(Path(path).absolute()), "message_sha256": sha(raw), "message_bytes": len(raw)}


class ProcBsdInfo(ctypes.Structure):
    # Public SDK sys/proc_info.h, PROC_PIDTBSDINFO=3, MAXCOMLEN=16.
    _fields_ = [(name, ctypes.c_uint32) for name in ("flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")]
    _fields_ += [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "tdev", "tpgid")]
    _fields_ += [("nice", ctypes.c_int32), ("start_seconds", ctypes.c_uint64), ("start_microseconds", ctypes.c_uint64)]


class MacLifecycle:
    """Public AppKit and libproc only; no AppleScript, AX, or private IPC."""
    def __init__(self):
        if platform.system() != "Darwin":
            raise Blocked("macos_required")
        self.appkit = ctypes.CDLL("/System/Library/Frameworks/AppKit.framework/AppKit")
        self.objc = ctypes.CDLL("/usr/lib/libobjc.A.dylib")
        self.libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.objc.objc_getClass.argtypes = [ctypes.c_char_p]
        self.objc.objc_getClass.restype = ctypes.c_void_p
        self.objc.sel_registerName.argtypes = [ctypes.c_char_p]
        self.objc.sel_registerName.restype = ctypes.c_void_p
        self.send_address = ctypes.cast(self.objc.objc_msgSend, ctypes.c_void_p).value
        self.libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.libproc.proc_pidinfo.restype = ctypes.c_int
        self.libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        self.libproc.proc_pidpath.restype = ctypes.c_int
        self.libproc.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        self.libproc.proc_listchildpids.restype = ctypes.c_int
        self.pool = self.send(self.cls("NSAutoreleasePool"), "new")
        self.workspace = self.send(self.cls("NSWorkspace"), "sharedWorkspace")
        self.running_class = self.cls("NSRunningApplication")
        for receiver, selector in ((self.workspace, "launchApplicationAtURL:options:configuration:error:"),
                                   (self.running_class, "runningApplicationWithProcessIdentifier:"),
                                   (self.running_class, "runningApplicationsWithBundleIdentifier:")):
            if not self.send(receiver, "respondsToSelector:", ctypes.c_bool, (ctypes.c_void_p,), self.sel(selector)):
                raise Blocked("public_lifecycle_api_unavailable")

    def cls(self, name):
        result = self.objc.objc_getClass(name.encode())
        if not result:
            raise Blocked("public_lifecycle_api_unavailable")
        return result

    def sel(self, name):
        return self.objc.sel_registerName(name.encode())

    def send(self, receiver, selector, result=ctypes.c_void_p, types=(), *args):
        function = ctypes.CFUNCTYPE(result, ctypes.c_void_p, ctypes.c_void_p, *types)(self.send_address)
        return function(receiver, self.sel(selector), *args)

    def string(self, value):
        return self.send(self.cls("NSString"), "stringWithUTF8String:", ctypes.c_void_p, (ctypes.c_char_p,), value.encode())

    def text(self, value):
        raw = self.send(value, "UTF8String", ctypes.c_char_p)
        return raw.decode("utf-8") if raw else ""

    def url_path(self, value):
        return str(Path(self.text(self.send(value, "path"))).resolve()) if value else ""

    def applications(self):
        array = self.send(self.running_class, "runningApplicationsWithBundleIdentifier:", ctypes.c_void_p, (ctypes.c_void_p,), self.string(BUNDLE))
        count = self.send(array, "count", ctypes.c_ulong)
        if count > 32:
            raise Blocked("desktop_inventory_unconfirmed")
        result = []
        for index in range(count):
            app = self.send(array, "objectAtIndex:", ctypes.c_void_p, (ctypes.c_ulong,), index)
            result.append({"pid": self.send(app, "processIdentifier", ctypes.c_int),
                           "bundle_path": self.url_path(self.send(app, "bundleURL")),
                           "executable": self.url_path(self.send(app, "executableURL"))})
        return result

    def process(self, pid):
        info = ProcBsdInfo()
        ctypes.set_errno(0)
        count = self.libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if count != ctypes.sizeof(info):
            error = ctypes.get_errno()
            if error in (errno.ESRCH, errno.ENOENT):
                return None
            try:
                os.kill(pid, 0)  # Existence check only; never sends a signal.
            except ProcessLookupError:
                return None
            except PermissionError:
                pass
            raise Blocked("process_identity_unconfirmed")
        buffer = ctypes.create_string_buffer(4096)
        if self.libproc.proc_pidpath(pid, buffer, len(buffer)) <= 0:
            raise Blocked("process_path_unconfirmed")
        return {"pid": int(info.pid), "ppid": int(info.ppid), "uid": int(info.uid),
                "start_seconds": int(info.start_seconds), "start_microseconds": int(info.start_microseconds),
                "executable": str(Path(os.fsdecode(buffer.value)).resolve())}

    def descendants(self, pid):
        pending, found = [pid], []
        while pending:
            parent = pending.pop()
            buffer = (ctypes.c_int * 4096)()
            count = self.libproc.proc_listchildpids(parent, buffer, ctypes.sizeof(buffer))
            if count < 0 or count >= len(buffer):
                raise Blocked("child_process_inventory_unconfirmed")
            for child in buffer[:count]:
                record = self.process(child)
                if record:
                    found.append(record)
                    pending.append(child)
                if len(found) > 4096:
                    raise Blocked("child_process_inventory_unconfirmed")
        return found

    def is_app_server(self, record):
        # Read arguments only for an already-identified exact executable/PID.
        # Return the role; never retain, print, or hash argument values.
        try:
            result = subprocess.run(["/bin/ps", "-p", str(record["pid"]), "-o", "args="], capture_output=True, timeout=5)
            if result.returncode or len(result.stdout) > LIMIT:
                raise ValueError()
            command = result.stdout.decode("utf-8").strip()
            executable = record["executable"]
            if command.startswith(executable + " "):
                arguments = shlex.split(command[len(executable):])
            else:
                words = shlex.split(command)
                if not words or words[0] not in (executable, Path(executable).name):
                    raise ValueError()
                arguments = words[1:]
            return "app-server" in arguments and "exec-server" not in arguments
        except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
            raise Blocked("known_cli_process_role_unconfirmed")

    def terminate(self, pid):
        app = self.send(self.running_class, "runningApplicationWithProcessIdentifier:", ctypes.c_void_p, (ctypes.c_int,), pid)
        return bool(app and self.send(app, "terminate", ctypes.c_bool))

    def launch(self, app_path):
        url = self.send(self.cls("NSURL"), "fileURLWithPath:", ctypes.c_void_p, (ctypes.c_void_p,), self.string(app_path))
        configuration = self.send(self.cls("NSDictionary"), "dictionary")
        error = ctypes.c_void_p()
        app = self.send(self.workspace, "launchApplicationAtURL:options:configuration:error:", ctypes.c_void_p,
                        (ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)),
                        url, LAUNCH_WITHOUT_ACTIVATION, configuration, ctypes.byref(error))
        return self.send(app, "processIdentifier", ctypes.c_int) if app else None

    def open_thread(self, thread_id, app_path):
        # Public registered URL route, exact official app, background only.
        # Do not use queue --resume: it targets a daemon rather than Desktop.
        if len(self.applications()) != 1:
            raise Blocked("existing_desktop_required_for_continuation")
        result = subprocess.run(["/usr/bin/open", "-g", "-a", app_path, "codex://threads/" + thread_id],
                                capture_output=True, timeout=10)
        return result.returncode

    def close(self):
        if getattr(self, "pool", None):
            self.send(self.pool, "drain", None)
            self.pool = None


def same_process(first, second):
    keys = ("pid", "uid", "start_seconds", "start_microseconds", "executable")
    return first is not None and second is not None and all(first.get(key) == second.get(key) for key in keys)


def old_processes_gone(plan, backend):
    return all(not same_process(record, backend.process(record["pid"])) for record in (plan["desktop"], plan["engine"]))


def capture_processes(runtime, backend, desktop_pid, engine_pid):
    applications = backend.applications()
    if len(applications) != 1 or applications[0] != {"pid": desktop_pid, "bundle_path": runtime["app_path"], "executable": runtime["main"]["path"]}:
        raise Blocked("exact_single_desktop_instance_required")
    desktop = backend.process(desktop_pid)
    engine = backend.process(engine_pid)
    if not desktop or not engine or desktop["uid"] != os.getuid() or engine["uid"] != os.getuid() or desktop["executable"] != runtime["main"]["path"]:
        raise Blocked("expected_desktop_or_engine_identity_mismatch")
    descendants = backend.descendants(desktop_pid)
    if not any(same_process(engine, item) for item in descendants):
        raise Blocked("expected_engine_is_not_desktop_child")
    if engine["ppid"] != desktop_pid or not backend.is_app_server(engine):
        raise Blocked("expected_engine_is_not_desktop_app_server")
    # A selected previous engine may be stale; pin its identity without trusting
    # its signature. Only the replacement engine must be the official binary.
    engine["binary_sha256"] = file_sha(engine["executable"])
    engine["process_role"] = "app-server"
    return desktop, engine


def make_plan(app_path, desktop_pid, engine_pid, checkpoint, idle, thread_id, receipt,
              background_idle, config_path=None, delay=3, now=None, backend=None, resume_message_file=None):
    now = time.time() if now is None else now
    if not background_idle:
        raise Blocked("explicit_background_idle_confirmation_required")
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", thread_id) or type(desktop_pid) is not int or desktop_pid <= 1 or type(engine_pid) is not int or engine_pid <= 1:
        raise Blocked("exact_thread_and_process_ids_required")
    if type(delay) not in (int, float) or not 1 <= delay <= 30:
        raise Blocked("startup_delay_must_be_one_to_thirty_seconds")
    receipt = Path(receipt).absolute()
    if receipt.exists() or receipt.with_name(receipt.name + ".worker.log").exists():
        raise Blocked("new_receipt_and_log_paths_required")
    runtime = official_runtime(app_path)
    guards = guard_files(checkpoint, idle, thread_id, now)
    sources = clean_sources(runtime["cli"]["path"], config_path)
    owned_backend = backend is None
    backend = backend or MacLifecycle()
    try:
        desktop, engine = capture_processes(runtime, backend, desktop_pid, engine_pid)
    finally:
        if owned_backend:
            backend.close()
    continuation = continuation_file(resume_message_file)[1] if resume_message_file else None
    return {"schema_version": SCHEMA, "kind": "ccuh_desktop_restart_plan", "plan_id": str(uuid.uuid4()), "owner_uid": os.getuid(),
            "created_at": utc(now), "expires_at": utc(now + PLAN_TTL), "thread_id": thread_id,
            "runtime": runtime, "desktop": desktop, "engine": engine, "guards": guards, "sources": sources,
            "receipt_path": str(receipt), "delay_seconds": delay, "termination_timeout_seconds": 30,
            "launch_timeout_seconds": 45, "script_sha256": file_sha(__file__),
            "background_work_confirmed_idle": True, "native_authentication_recovered": False,
            "same_chat_native_verification_required": True, "automatic_chat_resume_promised": False,
            "continuation": continuation}


def validate_plan(plan, now, allow_elapsed_after_quit=False):
    if plan.get("schema_version") != SCHEMA or plan.get("kind") != "ccuh_desktop_restart_plan" or plan.get("owner_uid") != os.getuid():
        raise Blocked("invalid_plan")
    if timestamp(plan.get("created_at")) > now + 5 or (not allow_elapsed_after_quit and now > timestamp(plan.get("expires_at"))) or not 0 < timestamp(plan.get("expires_at")) - timestamp(plan.get("created_at")) <= PLAN_TTL:
        raise Blocked("plan_expired_or_invalid_lifetime")
    if plan.get("script_sha256") != file_sha(__file__):
        raise Blocked("helper_changed_replan_required")
    if plan.get("background_work_confirmed_idle") is not True or not 1 <= plan.get("delay_seconds", 0) <= 30:
        raise Blocked("invalid_restart_policy")
    if plan.get("termination_timeout_seconds") != 30 or plan.get("launch_timeout_seconds") != 45:
        raise Blocked("invalid_restart_policy")


def preconditions(plan, backend, now, require_original=True):
    validate_plan(plan, now, allow_elapsed_after_quit=not require_original)
    runtime = official_runtime(plan["runtime"]["app_path"])
    if runtime != plan["runtime"]:
        raise Blocked("official_runtime_changed")
    # Fresh quiescence is mandatory before requesting quit. Once this guarded
    # operation has completed that quit, elapsed evidence must not strand the
    # app closed: retain the exact authorization hashes and source/runtime
    # checks while allowing the already-observed idle evidence to age.
    guards = guard_files(plan["guards"]["checkpoint"]["path"], plan["guards"]["idle"]["path"], plan["thread_id"], now,
                         check_fresh=require_original)
    if guards != plan["guards"]:
        raise Blocked("checkpoint_or_idle_evidence_changed")
    config = plan["sources"]["config"]
    if clean_sources(runtime["cli"]["path"], config["path"] if config else None) != plan["sources"]:
        raise Blocked("future_launch_sources_changed")
    if require_original:
        if plan.get("continuation"):
            unused, descriptor = continuation_file(plan["continuation"]["message_file"])
            if descriptor != plan["continuation"]:
                raise Blocked("resume_message_changed")
        desktop, engine = capture_processes(runtime, backend, plan["desktop"]["pid"], plan["engine"]["pid"])
        if desktop != plan["desktop"] or engine != plan["engine"]:
            raise Blocked("original_process_identity_changed")


def receipt_base(plan):
    return {"schema_version": SCHEMA, "plan_id": plan["plan_id"], "thread_id": plan["thread_id"],
            "stage": "worker_starting", "history": [], "launch_attempts": 0, "graceful_termination_requested": False,
            "force_termination_used": False, "native_authentication_recovered": False, "current_connection": "unverified",
            "same_chat_native_verification_required": True, "automatic_chat_resume_promised": False,
            "parent_process_environment_changed": False, "worker_cli_override_removed": True,
            "stdout_stderr_private": True, "checkpoint_sha256": plan["guards"]["checkpoint"]["sha256"]}


def stage(receipt, path, name, now, **fields):
    receipt.update(fields)
    receipt["stage"] = name
    receipt["updated_at"] = utc(now)
    receipt["history"].append({"stage": name, "at": utc(now)})
    replace_private(path, receipt)


def replacement_identity(plan, backend):
    applications = backend.applications()
    if not applications:
        return None
    if len(applications) != 1:
        raise Blocked("multiple_desktop_instances_detected")
    app = applications[0]
    if app["bundle_path"] != plan["runtime"]["app_path"] or app["executable"] != plan["runtime"]["main"]["path"]:
        raise Blocked("replacement_desktop_path_mismatch")
    desktop = backend.process(app["pid"])
    if not desktop or same_process(plan["desktop"], desktop) or desktop["uid"] != os.getuid() or desktop["executable"] != plan["runtime"]["main"]["path"]:
        raise Blocked("replacement_desktop_identity_unconfirmed")
    engines = [record for record in backend.descendants(desktop["pid"])
               if record["ppid"] == desktop["pid"] and record["executable"] == plan["runtime"]["cli"]["path"]
               and record["uid"] == os.getuid() and backend.is_app_server(record)]
    if not engines:
        return None
    if len(engines) != 1:
        raise Blocked("replacement_engine_ambiguous")
    engine = engines[0]
    if same_process(plan["engine"], engine) or verified_binary(engine["executable"]) != plan["runtime"]["cli"]:
        raise Blocked("replacement_engine_signing_unconfirmed")
    # Signing can overlap normal startup process replacement. A changed
    # candidate is never verified: let the existing launch deadline bound a
    # fresh observation, without requesting another quit or launch. Keep
    # conflicting paths, owners, roles, and pinned old identities fatal.
    current_desktop = backend.process(desktop["pid"])
    current_engine = backend.process(engine["pid"])
    if not same_process(desktop, current_desktop) or not same_process(engine, current_engine):
        if current_desktop and (same_process(plan["desktop"], current_desktop)
                                or current_desktop["uid"] != os.getuid()
                                or current_desktop["executable"] != plan["runtime"]["main"]["path"]):
            raise Blocked("replacement_process_changed_during_verification")
        if current_engine and (same_process(plan["engine"], current_engine)
                               or current_engine["uid"] != os.getuid()
                               or current_engine["executable"] != plan["runtime"]["cli"]["path"]
                               or current_engine["ppid"] != desktop["pid"]
                               or not backend.is_app_server(current_engine)):
            raise Blocked("replacement_process_changed_during_verification")
        return None
    return {"desktop_pid": desktop["pid"], "desktop_start_seconds": desktop["start_seconds"],
            "desktop_start_microseconds": desktop["start_microseconds"], "engine_pid": engine["pid"],
            "engine_start_seconds": engine["start_seconds"], "engine_start_microseconds": engine["start_microseconds"],
            "engine_process_role": "app-server",
            "official_desktop_path_confirmed": True, "official_engine_path_confirmed": True,
            "official_engine_sha256": plan["runtime"]["cli"]["sha256"], "official_signing_confirmed": True}


def continue_same_chat(plan, backend):
    text, descriptor = continuation_file(plan["continuation"]["message_file"])
    if descriptor != plan["continuation"]:
        raise Blocked("resume_message_changed")
    if replacement_identity(plan, backend) is None:
        raise Blocked("verified_replacement_required_for_continuation")
    opened = backend.open_thread(plan["thread_id"], plan["runtime"]["app_path"])
    if opened != 0:
        raise Blocked("same_chat_deeplink_not_confirmed")
    environment = dict(os.environ)
    environment[KEY] = plan["runtime"]["cli"]["path"]  # Child only.
    try:
        result = subprocess.run([plan["runtime"]["cli"]["path"], "queue", "--thread", plan["thread_id"], "--message", text],
                                capture_output=True, timeout=15, env=environment)
    except subprocess.TimeoutExpired:
        return {"continuation_status": "queue_outcome_unknown_no_retry", "queued_message_processing_confirmed": False}
    return {"continuation_status": "queued_awaiting_native_verification" if result.returncode == 0 else "queue_not_confirmed",
            "queue_exit_code": result.returncode, "queued_message_processing_confirmed": False,
            "same_thread_only": True, "daemon_resume_used": False}


def launch_once(plan, backend, receipt, receipt_path, now):
    if not receipt["graceful_termination_requested"]:
        raise Blocked("guarded_quit_not_previously_requested")
    if receipt["launch_attempts"]:
        raise Blocked("launch_already_attempted_no_duplicate")
    if not old_processes_gone(plan, backend):
        raise Blocked("old_processes_still_running")
    if backend.applications():
        return False
    preconditions(plan, backend, now, require_original=False)
    # Persist the attempt before calling AppKit: a returned error is not proof
    # that no app was launched and must never trigger a second launch.
    stage(receipt, receipt_path, "launch_requested", now, launch_attempts=1)
    launched_pid = backend.launch(plan["runtime"]["app_path"])
    if launched_pid is None:
        raise Blocked("official_launch_result_unconfirmed")
    return True


def final_quit_authorization(plan, now):
    """Check freshness using the clock after the final guard-file I/O."""
    checkpoint, checkpoint_raw = read_json(plan["guards"]["checkpoint"]["path"])
    idle, idle_raw = read_json(plan["guards"]["idle"]["path"])
    if sha(checkpoint_raw) != plan["guards"]["checkpoint"]["sha256"] or sha(idle_raw) != plan["guards"]["idle"]["sha256"]:
        raise Blocked("checkpoint_or_idle_evidence_changed")
    current = now()
    if current > timestamp(plan["expires_at"]):
        raise Blocked("plan_expired_before_quit")
    fresh(checkpoint.get("created_at"), CHECKPOINT_TTL, current)
    fresh(idle.get("observed_at"), IDLE_TTL, current)


def record_failure(plan, backend, receipt, receipt_path, error, now):
    # A completed guarded quit should not strand the user. A still-clean
    # official runtime/source, no old process, no existing instance, and zero
    # earlier attempts are all required for one best-effort launch.
    fallback = False
    if receipt["graceful_termination_requested"] and not receipt["launch_attempts"]:
        try:
            if old_processes_gone(plan, backend) and not backend.applications():
                fallback = launch_once(plan, backend, receipt, receipt_path, now())
        except (Blocked, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
            pass
    stage(receipt, receipt_path, "blocked", now(), status="restart_not_verified",
          reason=error.code if isinstance(error, Blocked) else "lifecycle_operation_unconfirmed",
          bounded_official_launch_attempted_on_failure=fallback)
    return receipt


def run_restart(plan, backend, receipt, receipt_path, now=time.time, sleep=time.sleep):
    """The mutation state machine, injectable for tests; called only by worker."""
    try:
        preconditions(plan, backend, now())
        stage(receipt, receipt_path, "delay_started", now())
        sleep(plan["delay_seconds"])
        preconditions(plan, backend, now())
        stage(receipt, receipt_path, "quit_preflight_complete", now())
        final_quit_authorization(plan, now)
        # No slow signing, process hashing, or receipt I/O between this final
        # real-clock authorization and the actual graceful request.
        receipt["graceful_termination_requested"] = True
        accepted = backend.terminate(plan["desktop"]["pid"])
        stage(receipt, receipt_path, "graceful_termination_requested", now())
        if not accepted:
            raise Blocked("graceful_termination_not_accepted")
        deadline = now() + plan["termination_timeout_seconds"]
        while not old_processes_gone(plan, backend):
            if now() >= deadline:
                raise Blocked("graceful_termination_deadline_no_force_used")
            sleep(0.25)
        stage(receipt, receipt_path, "old_processes_confirmed_gone", now())
        preconditions(plan, backend, now(), require_original=False)
        launch_once(plan, backend, receipt, receipt_path, now())
        deadline = now() + plan["launch_timeout_seconds"]
        while True:
            preconditions(plan, backend, now(), require_original=False)
            identity = replacement_identity(plan, backend)
            if identity:
                stage(receipt, receipt_path, "desktop_and_engine_verified", now(), status="desktop_restart_verified", replacement=identity)
                if plan.get("continuation"):
                    try:
                        continued = continue_same_chat(plan, backend)
                        stage(receipt, receipt_path, "continuation_awaiting_native_verification", now(), **continued)
                    except (Blocked, OSError, ValueError, TypeError, subprocess.TimeoutExpired) as error:
                        stage(receipt, receipt_path, "continuation_not_confirmed", now(),
                              continuation_status=error.code if isinstance(error, Blocked) else "continuation_runtime_unconfirmed",
                              queued_message_processing_confirmed=False)
                return receipt
            if now() >= deadline:
                raise Blocked("replacement_engine_deadline_connection_unverified")
            sleep(0.5)
    except (Blocked, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        return record_failure(plan, backend, receipt, receipt_path, error, now)


def load_plan(path, expected_sha=None):
    plan, raw = read_json(path)
    if expected_sha is not None and sha(raw) != expected_sha:
        raise Blocked("plan_changed")
    validate_plan(plan, time.time())
    return plan, sha(raw)


def sidecar(plan_path, suffix):
    return str(Path(plan_path).absolute()) + suffix


def wait_scheduler_exit(scheduler_pid, receipt, receipt_path, parent_pid=os.getppid,
                        monotonic=time.monotonic, sleep=time.sleep):
    deadline = monotonic() + 15
    while parent_pid() == scheduler_pid:
        if monotonic() >= deadline:
            raise Blocked("scheduler_still_present_no_restart")
        sleep(0.05)
    stage(receipt, receipt_path, "scheduler_parent_exit_confirmed", time.time(), scheduler_parent_exited=True)


def worker(plan_path, expected_sha, claim_id):
    plan, unused = load_plan(plan_path, expected_sha)
    claim, unused = read_json(sidecar(plan_path, ".claim"))
    if claim.get("claim_id") != claim_id or claim.get("plan_sha256") != expected_sha:
        raise Blocked("worker_claim_mismatch")
    scheduler_pid = claim.get("scheduler_pid")
    if type(scheduler_pid) is not int or scheduler_pid <= 1 or os.getppid() != scheduler_pid:
        raise Blocked("worker_scheduler_parent_unconfirmed")
    receipt_path = plan["receipt_path"]
    receipt, unused = read_json(receipt_path)
    if receipt.get("plan_id") != plan["plan_id"] or receipt.get("stage") != "worker_starting":
        raise Blocked("worker_receipt_mismatch")
    backend = MacLifecycle()
    try:
        preconditions(plan, backend, time.time())
        stage(receipt, receipt_path, "worker_ready", time.time(), worker_pid=os.getpid(), detached_session_confirmed=os.getsid(0) == os.getpid())
        deadline = time.monotonic() + 15
        while True:
            try:
                go, unused = read_json(sidecar(plan_path, ".go"))
                if go.get("claim_id") != claim_id:
                    raise Blocked("worker_handshake_mismatch")
                break
            except FileNotFoundError:
                if time.monotonic() >= deadline:
                    raise Blocked("worker_handshake_not_completed_no_restart")
                time.sleep(0.05)
        wait_scheduler_exit(scheduler_pid, receipt, receipt_path)
        run_restart(plan, backend, receipt, receipt_path)
    except (Blocked, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        record_failure(plan, backend, receipt, receipt_path, error, time.time)
    finally:
        backend.close()
    return 0 if receipt.get("status") == "desktop_restart_verified" else 1


def schedule(plan_path):
    plan, plan_sha = load_plan(plan_path)
    backend = MacLifecycle()
    try:
        preconditions(plan, backend, time.time())
    finally:
        backend.close()
    claim_id = str(uuid.uuid4())
    create_private(sidecar(plan_path, ".claim"), {"claim_id": claim_id, "plan_sha256": plan_sha, "created_at": utc(), "scheduler_pid": os.getpid()})
    receipt_path = plan["receipt_path"]
    create_private(receipt_path, receipt_base(plan))
    log_path = receipt_path + ".worker.log"
    descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    environment = dict(os.environ)
    environment.pop(KEY, None)  # Child only; never carry a stale parent override.
    with os.fdopen(descriptor, "wb") as log:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--_worker", str(Path(plan_path).absolute()),
                                  "--_expected-plan-sha", plan_sha, "--_claim-id", claim_id],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True,
                                 cwd="/", env=environment)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        current, unused = read_json(receipt_path)
        if current.get("stage") == "worker_ready":
            if current.get("worker_pid") != child.pid or current.get("detached_session_confirmed") is not True:
                raise Blocked("detached_worker_handshake_unconfirmed")
            create_private(sidecar(plan_path, ".go"), {"claim_id": claim_id, "created_at": utc()})
            return {"status": "restart_scheduled", "worker_pid": child.pid, "worker_ready_handshake_confirmed": True,
                    "delay_seconds": plan["delay_seconds"], "receipt_path": receipt_path,
                    "native_authentication_recovered": False, "same_chat_native_verification_required": True,
                    "automatic_chat_resume_promised": False, "parent_process_environment_changed": False}
        if current.get("stage") == "blocked" or child.poll() is not None:
            raise Blocked("worker_preflight_failed_no_restart")
        time.sleep(0.05)
    # No .go is written: worker's own handshake deadline prevents a restart.
    raise Blocked("worker_ready_deadline_no_restart_authorized")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog="Exit codes: 0 plan saved/restart scheduled; 1 safely blocked or restart unverified; 2 invalid invocation. --execute returns after a detached-worker handshake, before any quit. Inspect the private receipt after relaunch. No forced termination or automatic chat resume.")
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--plan", metavar="NEW_PLAN")
    actions.add_argument("--execute", metavar="PLAN")
    actions.add_argument("--_worker", metavar="PLAN", help=argparse.SUPPRESS)
    parser.add_argument("--app-path", default="/Applications/ChatGPT.app")
    parser.add_argument("--expected-desktop-pid", type=int)
    parser.add_argument("--expected-engine-pid", type=int)
    parser.add_argument("--thread-id")
    parser.add_argument("--checkpoint")
    parser.add_argument("--idle-evidence")
    parser.add_argument("--receipt", help="New private receipt path, updated by the detached worker.")
    parser.add_argument("--background-work-confirmed-idle", action="store_true")
    parser.add_argument("--config-source", help="Optional selected Codex TOML file: pin its digest and require any recognized CLI override to be official.")
    parser.add_argument("--delay-seconds", type=float, default=3)
    parser.add_argument("--resume-message-file", help="Optional private UTF-8 message (1..8192 bytes): after verified restart open only this plan's chat and use plain codex queue. Processing and native recovery remain unverified.")
    parser.add_argument("--_expected-plan-sha", help=argparse.SUPPRESS)
    parser.add_argument("--_claim-id", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        if args._worker:
            if not args._expected_plan_sha or not args._claim_id:
                raise Blocked("worker_claim_required")
            return worker(args._worker, args._expected_plan_sha, args._claim_id)
        if args.execute:
            result = schedule(args.execute)
        else:
            if not all((args.expected_desktop_pid, args.expected_engine_pid, args.thread_id, args.checkpoint, args.idle_evidence, args.receipt)):
                parser.error("Planning requires exact Desktop/engine PIDs, thread ID, checkpoint, idle evidence, and a new receipt path.")
            plan = make_plan(args.app_path, args.expected_desktop_pid, args.expected_engine_pid, args.checkpoint,
                             args.idle_evidence, args.thread_id, args.receipt, args.background_work_confirmed_idle,
                             args.config_source, args.delay_seconds, resume_message_file=args.resume_message_file)
            create_private(args.plan, plan)
            result = {"status": "restart_plan_saved", "plan_id": plan["plan_id"], "expires_at": plan["expires_at"],
                      "desktop_pid": plan["desktop"]["pid"], "engine_pid": plan["engine"]["pid"],
                      "native_authentication_recovered": False, "same_chat_native_verification_required": True}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (Blocked, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"status": "blocked", "reason": error.code if isinstance(error, Blocked) else "input_or_runtime_check_unconfirmed",
                          "native_authentication_recovered": False, "current_connection": "unverified"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
