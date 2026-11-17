#!/usr/bin/env python3
"""Development-only live Desktop authentication fault drill. Never a plugin asset.

Nothing runs on import. --prepare copies/signs only a new private /private/tmp
fixture. --inject explicitly changes the launch environment and gracefully
relaunches the exact selected Desktop after a detached-worker handshake and a
10-second final-answer delay. Only the fixed existing root chat is reopened.
No native request is made here: the fresh same chat must observe the real error.
There is no private IPC, database write, forced termination or mutation replay.
"""
import argparse
import ctypes
import importlib.util
import json
import os
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROOT_THREAD = "00000000-0000-4000-8000-000000000002"
DELAY = 10
RECOVERY_OFFSET = 95
MIN_RECOVERY_LEASE = 100


def load_helper(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "skills/ccuh-doctor/scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


desktop = load_helper("ccuh_drill_desktop", "desktop_recovery.py")
recovery = load_helper("ccuh_drill_recovery", "recovery.py")
Blocked = desktop.Blocked


def runtime_helper():
    spec = importlib.util.spec_from_file_location("ccuh_drill_runtime", ROOT / "lab/runtime_preflight.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DrillHost(desktop.MacLifecycle):
    """Public lifecycle APIs and explicit developer subprocesses only."""
    def source(self):
        return recovery.Store("launchctl").snapshot()

    def change_source(self, expected, value):
        return recovery.Store("launchctl").change(expected, value)

    def candidate(self, path):
        return recovery.adhoc_candidate_evidence(path)

    def copy_and_sign(self, runtime, work):
        source_bundle = Path(runtime["cli"]["path"]).parents[2]
        candidate_bundle = work / "CodexCLI.app"
        shutil.copytree(source_bundle, candidate_bundle, symlinks=True)
        candidate_cli = candidate_bundle / "Contents/MacOS/codex"
        helper = runtime_helper()
        try:
            sidecars = helper.copy_sidecars(runtime, candidate_cli)
        except helper.Blocked as error:
            raise Blocked(error.code)
        entitlements = work / "empty-entitlements.plist"
        descriptor = os.open(entitlements, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(plistlib.dumps({}))
        signed = subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--entitlements",
                                 str(entitlements), "--timestamp=none", str(candidate_bundle)],
                                capture_output=True, timeout=120)
        if signed.returncode != 0:
            raise Blocked("developer_candidate_signing_unconfirmed")
        try:
            helper.validate_sidecars(runtime, candidate_cli, sidecars)
        except helper.Blocked as error:
            raise Blocked(error.code)
        self._copied_sidecars = sidecars
        return candidate_cli

    def sidecars(self, runtime, candidate_cli, evidence=None):
        helper = runtime_helper()
        try:
            return helper.validate_sidecars(runtime, candidate_cli, evidence if evidence is not None else self._copied_sidecars)
        except helper.Blocked as error:
            raise Blocked(error.code)

    def tool_preflight(self, runtime, candidate_cli, sidecars):
        helper = runtime_helper()
        try:
            return helper.runtime_preflight(runtime, candidate_cli, sidecars)
        except helper.Blocked as error:
            raise Blocked(error.code)

    def repair_native(self, plan, marker_path):
        work = Path(plan["prepared"]["workspace"])
        selected = recovery.make_plan(recovery.Store("launchctl"), plan["prepared"]["runtime"]["app_path"],
                                      "authentication_failed", remove_adhoc=True, response_path=marker_path)
        path = work / "native-repair-plan.json"
        recovery.private_create(path, selected)
        return recovery.apply_plan(path, work / "native-repair-backup.json", "authentication_failed")

    def schedule_product_restart(self, plan_path):
        # A separate CLI parent must exit after the worker handshake. Calling
        # desktop.schedule here would leave its worker waiting for this watcher.
        environment = dict(os.environ)
        environment.pop(desktop.KEY, None)
        result = subprocess.run([sys.executable, str(Path(desktop.__file__).resolve()), "--execute", str(plan_path)],
                                env=environment, cwd="/", capture_output=True, timeout=25)
        try:
            response = json.loads(result.stdout)
        except (ValueError, UnicodeError):
            raise Blocked("product_restart_schedule_unconfirmed_no_retry")
        if result.returncode or response.get("status") != "restart_scheduled":
            raise Blocked("product_restart_schedule_unconfirmed_no_retry")
        return response

    def launch_fault(self, app_path, candidate):
        # Use the exported public NSString constant, not a guessed dictionary key.
        environment_key = ctypes.c_void_p.in_dll(self.appkit, "NSWorkspaceLaunchConfigurationEnvironment").value
        environment = self.send(self.cls("NSDictionary"), "dictionaryWithObject:forKey:", ctypes.c_void_p,
                                (ctypes.c_void_p, ctypes.c_void_p), self.string(candidate), self.string(desktop.KEY))
        configuration = self.send(self.cls("NSDictionary"), "dictionaryWithObject:forKey:", ctypes.c_void_p,
                                  (ctypes.c_void_p, ctypes.c_void_p), environment, environment_key)
        url = self.send(self.cls("NSURL"), "fileURLWithPath:", ctypes.c_void_p, (ctypes.c_void_p,), self.string(app_path))
        error = ctypes.c_void_p()
        app = self.send(self.workspace, "launchApplicationAtURL:options:configuration:error:", ctypes.c_void_p,
                        (ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)),
                        url, desktop.LAUNCH_WITHOUT_ACTIVATION, configuration, ctypes.byref(error))
        return self.send(app, "processIdentifier", ctypes.c_int) if app else None

    def open_root_chat(self, app_path):
        return self.open_thread(ROOT_THREAD, app_path) == 0

    def queue_continuation(self, official_cli, receipt_path, message_file=None):
        message = ("Continue the explicitly authorized CCUH live Desktop authentication drill in this same chat. "
                   "Read the private drill receipt at " + receipt_path + ". Confirm the exact fresh Desktop/engine, "
                   "then use the official native tool once on the checkpoint's owned dummy target to record the real "
                   "authentication error. Write only the exact native response and pinned live context to the receipt's "
                   "native_failure_path; the prearmed external worker owns product repair and restart. "
                   "Do not repeat unknown operations or disturb other work.")
        if message_file:
            message = desktop.continuation_file(message_file)[0]
        environment = dict(os.environ)
        environment[desktop.KEY] = official_cli  # Explicit official child only.
        result = subprocess.run([official_cli, "queue", "--thread", ROOT_THREAD, "--message", message],
                                env=environment, cwd=str(ROOT), capture_output=True, timeout=30)
        return result.returncode == 0  # Acceptance is not proof of chat delivery.


def script_hashes():
    return {"drill": desktop.file_sha(__file__), "desktop": desktop.file_sha(desktop.__file__),
            "recovery": desktop.file_sha(recovery.__file__), "runtime": desktop.file_sha(ROOT / "lab/runtime_preflight.py")}


def validate_tool_preflight(evidence, candidate):
    if (not isinstance(evidence, dict) or evidence.get("schema_version") != 1 or
            evidence.get("kind") != "ccuh_developer_runtime_preflight" or
            evidence.get("code_mode_and_nested_exec_confirmed") is not True or
            evidence.get("sidecars_revalidated") is not True or
            evidence.get("candidate_cli_sha256") != candidate["binary_sha256"]):
        raise Blocked("actual_tool_preflight_required")


def prepare(app_path, host, work=None, now=None):
    """Explicit developer fault preparation; never touches the official app."""
    now = time.time() if now is None else now
    runtime = desktop.official_runtime(app_path)
    original = host.source()
    if original["value"] is not None:
        raise Blocked("absent_launchctl_override_baseline_required")
    if work is None:
        work = Path(tempfile.mkdtemp(prefix="ccuh-live-desktop-", dir="/private/tmp"))
    else:
        work = Path(work).absolute()
        if Path("/private/tmp") not in work.resolve().parents:
            raise Blocked("private_tmp_workspace_required")
        work.mkdir(mode=0o700)
    work = work.resolve()
    if Path("/private/tmp") not in work.parents:
        raise Blocked("private_tmp_workspace_required")
    backup = work / "launch-environment-backup.json"
    desktop.create_private(backup, {"schema_version": 1, "owner_uid": os.getuid(), "source": "launchctl",
                                    "original_value": None, "original_fingerprint": original["fingerprint"]})
    candidate_path = host.copy_and_sign(runtime, work).resolve()
    if candidate_path != work / "CodexCLI.app/Contents/MacOS/codex":
        raise Blocked("unexpected_developer_candidate_path")
    candidate = host.candidate(str(candidate_path))
    if not candidate.get("verified") or candidate.get("resolved_path") != str(candidate_path):
        raise Blocked("valid_adhoc_candidate_required")
    sidecars = host.sidecars(runtime, candidate_path)
    tool_preflight = host.tool_preflight(runtime, candidate_path, sidecars)
    validate_tool_preflight(tool_preflight, candidate)
    if desktop.official_runtime(app_path) != runtime:
        raise Blocked("official_source_changed_during_copy")
    prepared = {"schema_version": 1, "kind": "ccuh_developer_fault_preparation", "owner_uid": os.getuid(),
                "created_at": desktop.utc(now), "runtime": runtime, "workspace": str(work), "candidate": candidate,
                "sidecars": sidecars, "tool_preflight": tool_preflight,
                "baseline": original, "backup_path": str(backup), "backup_sha256": desktop.file_sha(backup),
                "script_hashes": script_hashes(), "existing_root_thread_id": ROOT_THREAD}
    desktop.create_private(work / "prepared.json", prepared)
    return prepared


def validate_prepared(prepared, host, now):
    if prepared.get("kind") != "ccuh_developer_fault_preparation" or prepared.get("owner_uid") != os.getuid() or prepared.get("existing_root_thread_id") != ROOT_THREAD:
        raise Blocked("developer_preparation_invalid")
    desktop.fresh(prepared["created_at"], 900, now)
    work = Path(prepared["workspace"])
    info = work.lstat()
    if work.resolve() != work or Path("/private/tmp") not in work.parents or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise Blocked("developer_workspace_not_private")
    if script_hashes() != prepared["script_hashes"] or desktop.file_sha(prepared["backup_path"]) != prepared["backup_sha256"]:
        raise Blocked("developer_preparation_changed")
    if desktop.official_runtime(prepared["runtime"]["app_path"]) != prepared["runtime"]:
        raise Blocked("official_runtime_changed")
    candidate_path = work / "CodexCLI.app/Contents/MacOS/codex"
    if host.candidate(str(candidate_path)) != prepared["candidate"]:
        raise Blocked("developer_candidate_changed_or_unconfirmed")
    if host.sidecars(prepared["runtime"], candidate_path, prepared["sidecars"]) != prepared["sidecars"]:
        raise Blocked("developer_sidecars_changed_or_unconfirmed")
    validate_tool_preflight(prepared.get("tool_preflight"), prepared["candidate"])


def fault_plan(prepared, host, desktop_pid, engine_pid, checkpoint, idle, background_idle,
               queue_continuation=False, now=None, resume_message_file=None, native_observer_message_file=None):
    now = time.time() if now is None else now
    if background_idle is not True:
        raise Blocked("explicit_background_idle_confirmation_required")
    validate_prepared(prepared, host, now)
    guards = desktop.guard_files(checkpoint, idle, ROOT_THREAD, now)
    idle_value, unused = desktop.read_json(idle)
    idle_observed = desktop.timestamp(idle_value["observed_at"])
    if idle_observed + desktop.IDLE_TTL - now < MIN_RECOVERY_LEASE:
        raise Blocked("insufficient_original_idle_recovery_lease")
    if host.source() != prepared["baseline"]:
        raise Blocked("launch_environment_changed")
    app, engine = desktop.capture_processes(prepared["runtime"], host, desktop_pid, engine_pid)
    if engine["executable"] != prepared["runtime"]["cli"]["path"] or engine["binary_sha256"] != prepared["runtime"]["cli"]["sha256"]:
        raise Blocked("official_live_engine_baseline_required")
    work = Path(prepared["workspace"])
    if resume_message_file is None:
        resume_message_file = work / "recovery-continuation.txt"
        message = ("Continue the authorized CCUH live Desktop drill in this same chat. Read " + str(work / "fault-receipt.json") +
                   ". If this was developer rollback without native evidence, report that the authentication trial is incomplete. "
                   "Read the product restart receipt, confirm the official replacement, and perform one read-only native call "
                   "on the checkpoint's owned dummy target for final proof. Do not replay unknown operations or restart again.")
        descriptor = os.open(resume_message_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(message.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
    continuation = desktop.continuation_file(resume_message_file)[1]
    observer = desktop.continuation_file(native_observer_message_file)[1] if native_observer_message_file else None
    clean_relaunch = desktop.make_plan(prepared["runtime"]["app_path"], desktop_pid, engine_pid, checkpoint, idle,
                                       ROOT_THREAD, work / "closed-relaunch-receipt.json", True, now=now, backend=host,
                                       resume_message_file=resume_message_file)
    return {"schema_version": 1, "kind": "ccuh_developer_live_fault", "plan_id": str(uuid.uuid4()),
            "created_at": desktop.utc(now), "expires_at": desktop.utc(now + 300),
            "prepared": prepared, "desktop": app, "engine": engine,
            "guards": guards, "thread_id": ROOT_THREAD, "delay_seconds": DELAY,
            "queue_continuation": queue_continuation is True,
            "receipt_path": str(work / "fault-receipt.json"), "native_failure_path": str(work / "native-failure.json"),
            "native_pending_path": str(work / "native-read.pending.json"), "native_observer": observer,
            "native_completed_path": str(work / "native-observation-completed.json"),
            "recovery_lock_path": str(work / "recovery.claim"), "recovery_deadline": desktop.utc(idle_observed + RECOVERY_OFFSET),
            "original_idle_observed_at": idle_value["observed_at"], "continuation": continuation,
            "closed_relaunch_plan": clean_relaunch}


def preconditions(plan, host, now, source_value=None, originals=True):
    if plan.get("kind") != "ccuh_developer_live_fault" or plan.get("thread_id") != ROOT_THREAD or plan.get("delay_seconds") != DELAY:
        raise Blocked("developer_fault_plan_invalid")
    desktop.fresh(plan["created_at"], 300, now)
    validate_prepared(plan["prepared"], host, now)
    guards = desktop.guard_files(plan["guards"]["checkpoint"]["path"], plan["guards"]["idle"]["path"], ROOT_THREAD, now)
    if guards != plan["guards"]:
        raise Blocked("checkpoint_or_idle_evidence_changed")
    if desktop.continuation_file(plan["continuation"]["message_file"])[1] != plan["continuation"]:
        raise Blocked("resume_message_changed")
    if plan.get("native_observer") and desktop.continuation_file(plan["native_observer"]["message_file"])[1] != plan["native_observer"]:
        raise Blocked("native_observer_message_changed")
    idle_value, unused = desktop.read_json(plan["guards"]["idle"]["path"])
    if (plan["original_idle_observed_at"] != idle_value["observed_at"] or
            plan["recovery_deadline"] != desktop.utc(desktop.timestamp(idle_value["observed_at"]) + RECOVERY_OFFSET)):
        raise Blocked("original_recovery_window_changed")
    if host.source()["value"] != source_value:
        raise Blocked("launch_environment_changed")
    if originals:
        app, engine = desktop.capture_processes(plan["prepared"]["runtime"], host, plan["desktop"]["pid"], plan["engine"]["pid"])
        if app != plan["desktop"] or engine != plan["engine"]:
            raise Blocked("original_process_identity_changed")


def restore_own_source(prepared, host):
    """Deadman changes only the still-owned override, never a later user edit."""
    backup, raw = desktop.read_json(prepared["backup_path"])
    if prepared.get("owner_uid") != os.getuid() or prepared.get("existing_root_thread_id") != ROOT_THREAD or desktop.sha(raw) != prepared["backup_sha256"] or backup.get("owner_uid") != os.getuid() or backup.get("original_value") is not None or prepared["baseline"]["value"] is not None:
        raise Blocked("own_source_backup_unconfirmed")
    current = host.source()
    candidate = prepared["candidate"]["resolved_path"]
    if current["value"] != candidate:
        return "already_absent" if current["value"] is None else "different_value_preserved"
    host.change_source(current, None)
    return "own_override_restored_to_absent"


def require_original_idle_lease(plan, now, minimum):
    remaining = desktop.timestamp(plan["original_idle_observed_at"]) + desktop.IDLE_TTL - now
    if remaining < minimum:
        raise Blocked("insufficient_original_idle_recovery_lease")


def fault_identity(plan, host):
    runtime = plan["prepared"]["runtime"]
    apps = host.applications()
    if not apps:
        return None
    if len(apps) != 1 or apps[0]["bundle_path"] != runtime["app_path"] or apps[0]["executable"] != runtime["main"]["path"]:
        raise Blocked("replacement_desktop_ambiguous_or_wrong_path")
    app = host.process(apps[0]["pid"])
    if not app or app["uid"] != os.getuid() or desktop.same_process(plan["desktop"], app):
        raise Blocked("replacement_desktop_identity_unconfirmed")
    candidate = plan["prepared"]["candidate"]
    engines = [item for item in host.descendants(app["pid"])
               if item["ppid"] == app["pid"] and item["executable"] == candidate["resolved_path"]
               and item["uid"] == os.getuid() and host.is_app_server(item)]
    if not engines:
        return None
    if len(engines) != 1 or host.candidate(candidate["resolved_path"]) != candidate:
        raise Blocked("replacement_fault_engine_unconfirmed")
    engine = engines[0]
    if not desktop.same_process(app, host.process(app["pid"])) or not desktop.same_process(engine, host.process(engine["pid"])):
        raise Blocked("replacement_process_changed")
    pinned_app, pinned_engine = desktop.capture_processes(runtime, host, app["pid"], engine["pid"])
    return {"desktop_pid": app["pid"], "engine_pid": engine["pid"],
            "desktop": pinned_app, "engine": pinned_engine,
            "official_desktop_confirmed": True, "candidate_engine_path_confirmed": True,
            "candidate_engine_sha256": candidate["binary_sha256"], "valid_adhoc_signing_confirmed": True}


def native_failure(plan, receipt, now):
    """Authenticate context separately from the product's exact error parser."""
    path = plan["native_failure_path"]
    marker, unused = desktop.read_json(path)
    expected = receipt["replacement"]
    if (marker.get("schema_version") != 1 or marker.get("kind") != "ccuh_live_native_authentication_failure" or
            marker.get("plan_id") != plan["plan_id"] or marker.get("thread_id") != ROOT_THREAD or
            marker.get("desktop") != expected["desktop"] or marker.get("engine") != expected["engine"]):
        raise Blocked("native_failure_live_context_mismatch")
    observed = desktop.timestamp(marker.get("observed_at"))
    if not desktop.timestamp(receipt["fault_started_at"]) <= observed <= now + 5 or now > desktop.timestamp(plan["recovery_deadline"]):
        raise Blocked("native_failure_outside_original_recovery_window")
    return recovery.native_authentication_evidence(path)


def publish_private_json(path, value):
    """Publish a complete private JSON file atomically without replacement."""
    temporary = Path(path).with_name("." + Path(path).name + "." + uuid.uuid4().hex)
    desktop.create_private(temporary, value)
    try:
        os.link(temporary, path, follow_symlinks=False)
    finally:
        temporary.unlink()


def observer_begin(plan, host, now=time.time):
    """Reserve one read; never invoke the native tool from this process."""
    if Path(plan["recovery_lock_path"]).exists() or now() >= desktop.timestamp(plan["recovery_deadline"]):
        return {"permitted": False, "reason": "recovery_claimed_or_original_window_expired"}
    preconditions(plan, host, now(), plan["prepared"]["candidate"]["resolved_path"], originals=False)
    receipt, unused = desktop.read_json(plan["receipt_path"])
    identity = fault_identity(plan, host)
    if identity != receipt.get("replacement"):
        raise Blocked("observer_fault_process_identity_mismatch")
    work = Path(plan["prepared"]["workspace"])
    claim_path = work / "native-observer.claim.json"
    observer_id = str(uuid.uuid4())
    claim = {"schema_version": 1, "kind": "ccuh_live_native_observer_claim", "plan_id": plan["plan_id"],
             "owner_uid": os.getuid(), "observer_id": observer_id}
    desktop.create_private(claim_path, claim)
    staging = work / "native-response.staging.json"
    desktop.create_private(staging, {})
    pending = {"schema_version": 1, "kind": "ccuh_live_native_read_pending", "plan_id": plan["plan_id"],
               "thread_id": ROOT_THREAD, "observer_id": observer_id, "created_at": desktop.utc(now()),
               "desktop": identity["desktop"], "engine": identity["engine"]}
    publish_private_json(plan["native_pending_path"], pending)
    claim.update({"pending_sha256": desktop.file_sha(plan["native_pending_path"]), "response_staging_path": str(staging)})
    desktop.replace_private(claim_path, claim)
    if Path(plan["recovery_lock_path"]).exists() or now() >= desktop.timestamp(plan["recovery_deadline"]):
        # Only remove the exact pending file this invocation published.
        if desktop.file_sha(plan["native_pending_path"]) == claim["pending_sha256"]:
            Path(plan["native_pending_path"]).unlink()
        return {"permitted": False, "reason": "recovery_claimed_or_original_window_expired"}
    return {"permitted": True, "observer_id": observer_id, "native_pending_path": plan["native_pending_path"],
            "response_staging_path": str(staging), "desktop": identity["desktop"], "engine": identity["engine"],
            "recovery_deadline": plan["recovery_deadline"]}


def observer_finish(plan, host, response_file, now=time.time):
    """Consume a confirmed minimal response; unresolved outcomes keep pending."""
    work = Path(plan["prepared"]["workspace"])
    claim, unused = desktop.read_json(work / "native-observer.claim.json")
    pending, pending_raw = desktop.read_json(plan["native_pending_path"])
    if (claim.get("kind") != "ccuh_live_native_observer_claim" or claim.get("plan_id") != plan["plan_id"] or
            claim.get("owner_uid") != os.getuid() or claim.get("pending_sha256") != desktop.sha(pending_raw) or
            Path(response_file).absolute() != Path(claim.get("response_staging_path", "")).absolute()):
        raise Blocked("observer_claim_or_pending_changed")
    receipt, unused = desktop.read_json(plan["receipt_path"])
    identity = fault_identity(plan, host)
    if (identity != receipt.get("replacement") or pending.get("plan_id") != plan["plan_id"] or
            pending.get("thread_id") != ROOT_THREAD or pending.get("observer_id") != claim.get("observer_id") or
            pending.get("desktop") != identity["desktop"] or pending.get("engine") != identity["engine"]):
        raise Blocked("observer_finish_live_context_mismatch")
    response, response_raw = desktop.read_json(response_file)
    if (response.get("schema_version") != 1 or response.get("kind") != "ccuh_live_native_response" or
            response.get("observer_id") != claim["observer_id"] or response.get("operation_complete") is not True or
            not isinstance(response.get("result"), dict) or not response["result"]):
        return {"status": "native_operation_unresolved", "pending_retained": True}
    category = recovery.payload_category(response["result"])
    if category in ("timeout", "operation_unresolved"):
        return {"status": "native_operation_unresolved", "pending_retained": True}
    auth = False
    try:
        recovery.native_authentication_evidence(response_file)
        auth = True
    except recovery.RecoveryError as error:
        if error.code != "exact_native_authentication_evidence_required":
            raise
    context = {"schema_version": 1, "plan_id": plan["plan_id"], "thread_id": ROOT_THREAD,
               "observer_id": claim["observer_id"], "observed_at": desktop.utc(now()),
               "desktop": identity["desktop"], "engine": identity["engine"], "response_sha256": desktop.sha(response_raw)}
    if auth:
        context.update({"kind": "ccuh_live_native_authentication_failure", "error": response["result"]})
        destination = plan["native_failure_path"]
    else:
        context.update({"kind": "ccuh_live_native_observation_completed", "category": category,
                        "native_authentication_evidence": False, "developer_rollback_requested": True})
        destination = plan["native_completed_path"]
    publish_private_json(destination, context)
    # Verify ownership once more before releasing the in-flight guard.
    if desktop.file_sha(plan["native_pending_path"]) != claim["pending_sha256"]:
        raise Blocked("observer_pending_changed_before_release")
    Path(plan["native_pending_path"]).unlink()
    return {"status": "native_authentication_failure_recorded" if auth else "native_observation_completed_without_authentication_evidence",
            "native_error_observed": auth, "pending_retained": False, "marker_path": destination,
            "within_original_recovery_window": now() < desktop.timestamp(plan["recovery_deadline"]),
            "native_authentication_recovered": False}


def completed_observation(plan, receipt):
    marker, unused = desktop.read_json(plan["native_completed_path"])
    expected = receipt["replacement"]
    if (marker.get("kind") != "ccuh_live_native_observation_completed" or marker.get("plan_id") != plan["plan_id"] or
            marker.get("thread_id") != ROOT_THREAD or marker.get("desktop") != expected["desktop"] or
            marker.get("engine") != expected["engine"] or marker.get("developer_rollback_requested") is not True):
        raise Blocked("completed_observation_context_mismatch")
    return True


def recover_running_fault(plan, host, receipt, now, marker=False):
    """The prearmed detached worker is the only restart owner for this drill."""
    if Path(plan["native_pending_path"]).exists():
        raise Blocked("native_read_pending_no_restart")
    preconditions(plan, host, now(), plan["prepared"]["candidate"]["resolved_path"], originals=False)
    if fault_identity(plan, host) != receipt["replacement"]:
        raise Blocked("fault_process_identity_changed_no_restart")
    evidence = native_failure(plan, receipt, now()) if marker else None
    desktop.create_private(plan["recovery_lock_path"], {"schema_version": 1, "plan_id": plan["plan_id"],
                            "owner_uid": os.getuid(), "worker_pid": os.getpid(), "claimed_at": desktop.utc(now())})
    # Recheck after claiming, before any global source mutation.
    if Path(plan["native_pending_path"]).exists():
        raise Blocked("native_read_pending_no_restart")
    preconditions(plan, host, now(), plan["prepared"]["candidate"]["resolved_path"], originals=False)
    if fault_identity(plan, host) != receipt["replacement"]:
        raise Blocked("fault_process_identity_changed_no_restart")
    if evidence:
        repaired = host.repair_native(plan, plan["native_failure_path"])
        if repaired.get("status") != "repair_applied":
            raise Blocked("product_native_repair_unconfirmed")
        desktop.stage(receipt, plan["receipt_path"], "native_product_repair_applied", now(),
                      native_error_observed=True, native_evidence=evidence, product_repair=repaired)
    else:
        restored = restore_own_source(plan["prepared"], host)
        if restored != "own_override_restored_to_absent":
            raise Blocked("developer_rollback_source_not_owned")
        desktop.stage(receipt, plan["receipt_path"], "developer_rollback_source_restored", now(),
                      source_restore=restored, authentication_trial_complete=False)
    if host.source() != plan["prepared"]["baseline"] or fault_identity(plan, host) != receipt["replacement"]:
        raise Blocked("repaired_source_or_fault_process_changed_no_restart")
    work = Path(plan["prepared"]["workspace"])
    replacement = receipt["replacement"]
    restart = desktop.make_plan(plan["prepared"]["runtime"]["app_path"], replacement["desktop_pid"],
                                replacement["engine_pid"], plan["guards"]["checkpoint"]["path"],
                                plan["guards"]["idle"]["path"], ROOT_THREAD, work / "product-restart-receipt.json", True,
                                delay=5, now=now(), backend=host,
                                resume_message_file=plan["continuation"]["message_file"])
    restart_path = work / "product-restart-plan.json"
    desktop.create_private(restart_path, restart)
    # Persist that execution may begin before invoking the helper. A timeout is
    # an unknown outcome, and never grants this watcher another attempt.
    desktop.stage(receipt, plan["receipt_path"], "product_restart_execute_requested", now(),
                  product_restart_plan=str(restart_path), product_restart_receipt=restart["receipt_path"],
                  product_restart_execute_attempts=1)
    if Path(plan["native_pending_path"]).exists():
        raise Blocked("native_read_pending_no_restart")
    scheduled = host.schedule_product_restart(restart_path)
    desktop.stage(receipt, plan["receipt_path"], "external_recovery_scheduled", now(),
                  status="product_repair_restart_scheduled" if evidence else "developer_rollback_restart_scheduled",
                  product_restart=scheduled, authentication_trial_complete=False)
    return receipt


def relaunch_after_known_unlaunched_fault(plan, host, receipt, now):
    """One official launch only when this worker quit and never tried launch."""
    if (not receipt.get("graceful_termination_accepted") or receipt.get("launch_attempts") != 0 or
            not desktop.old_processes_gone(plan, host) or host.applications()):
        return False
    restart = plan["closed_relaunch_plan"]
    restart_receipt = desktop.receipt_base(restart)
    # This is the same worker's already completed, guarded graceful quit.
    restart_receipt["graceful_termination_requested"] = True
    desktop.create_private(restart["receipt_path"], restart_receipt)
    return desktop.launch_once(restart, host, restart_receipt, restart["receipt_path"], now())


def run_fault(plan, host, receipt, now=time.time, sleep=time.sleep):
    path = plan["receipt_path"]
    def record(name, **fields):
        desktop.stage(receipt, path, name, now(), **fields)
    candidate = plan["prepared"]["candidate"]["resolved_path"]
    try:
        preconditions(plan, host, now())
        require_original_idle_lease(plan, now(), MIN_RECOVERY_LEASE)
        if now() >= desktop.timestamp(plan["recovery_deadline"]) - DELAY:
            raise Blocked("insufficient_original_recovery_window_no_injection")
        record("external_recovery_armed", external_recovery_armed=True, native_failure_path=plan["native_failure_path"],
               native_pending_path=plan["native_pending_path"], recovery_deadline=plan["recovery_deadline"],
               recovery_lock_path=plan["recovery_lock_path"])
        record("final_answer_delay_started")
        sleep(DELAY)
        preconditions(plan, host, now())
        record("environment_change_preflight_complete")
        desktop.final_quit_authorization(plan, now)
        require_original_idle_lease(plan, now(), 90)
        host.change_source(plan["prepared"]["baseline"], candidate)
        record("environment_change_requested")
        preconditions(plan, host, now(), candidate)
        record("quit_preflight_complete")
        desktop.final_quit_authorization(plan, now)
        require_original_idle_lease(plan, now(), 90)
        receipt["graceful_termination_requested"] = True
        accepted = host.terminate(plan["desktop"]["pid"])
        record("graceful_termination_requested")
        if not accepted:
            raise Blocked("graceful_termination_not_accepted_no_force")
        receipt["graceful_termination_accepted"] = True
        deadline = now() + 30
        while not desktop.old_processes_gone(plan, host):
            if now() >= deadline:
                raise Blocked("old_desktop_not_gone_no_force_no_launch")
            sleep(0.25)
        preconditions(plan, host, now(), candidate, originals=False)
        if host.applications():
            raise Blocked("unexpected_desktop_instance_no_launch")
        if now() > desktop.timestamp(plan["recovery_deadline"]) - 50:
            raise Blocked("insufficient_fault_launch_and_recovery_window")
        record("fault_launch_requested", launch_attempts=1)
        if host.launch_fault(plan["prepared"]["runtime"]["app_path"], candidate) is None:
            raise Blocked("fault_launch_result_unknown_no_retry")
        deadline = now() + 45
        while True:
            preconditions(plan, host, now(), candidate, originals=False)
            identity = fault_identity(plan, host)
            if identity:
                break
            if now() >= deadline:
                raise Blocked("fault_engine_not_verified_no_retry")
            sleep(0.5)
        record("fault_engine_started", status="fault_engine_started", replacement=identity, fault_started_at=desktop.utc(now()))
        record("same_chat_deep_link_requested", deep_link_attempted=True)
        try:
            opened = host.open_root_chat(plan["prepared"]["runtime"]["app_path"])
            record("same_chat_deep_link_returned", deep_link_confirmed=opened)
        except (OSError, subprocess.TimeoutExpired):
            record("same_chat_deep_link_unconfirmed", deep_link_confirmed=False)
        if plan["queue_continuation"]:
            record("plain_queue_requested", queue_attempted=True)
            try:
                accepted = host.queue_continuation(plan["prepared"]["runtime"]["cli"]["path"], path,
                                                   plan["native_observer"]["message_file"] if plan.get("native_observer") else None)
                record("plain_queue_returned", queue_exit_zero=accepted)
            except (OSError, subprocess.TimeoutExpired):
                record("plain_queue_outcome_unknown_no_retry", queue_exit_zero=False)
        record("awaiting_same_chat_native_failure", status="awaiting_same_chat_native_failure")
        # Both branches remain outside the engine being deliberately faulted.
        # The original idle evidence is never refreshed or extended.
        deadline = desktop.timestamp(plan["recovery_deadline"])
        while host.source()["value"] == candidate:
            pending = Path(plan["native_pending_path"]).exists()
            if Path(plan["native_failure_path"]).exists() and not pending:
                return recover_running_fault(plan, host, receipt, now, marker=True)
            if Path(plan["native_completed_path"]).exists() and not pending:
                completed_observation(plan, receipt)
                return recover_running_fault(plan, host, receipt, now)
            if now() >= deadline:
                if pending:
                    restored = restore_own_source(plan["prepared"], host)
                    record("native_read_pending_no_restart", status="native_read_pending_no_restart", source_restore=restored,
                           authentication_trial_complete=False, native_operation_completion_unconfirmed=True)
                    return receipt
                return recover_running_fault(plan, host, receipt, now)
            sleep(0.25)
        record("source_no_longer_owned", source_restore=restore_own_source(plan["prepared"], host))
    except (Blocked, recovery.RecoveryError, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        try:
            restored = restore_own_source(plan["prepared"], host)
        except Exception:
            restored = "restore_unconfirmed"
        try:
            closed = receipt.get("graceful_termination_requested", False) and desktop.old_processes_gone(plan, host)
        except (Blocked, OSError, ValueError, TypeError):
            closed = False
        relaunched = False
        if closed and receipt.get("launch_attempts", 0) == 0:
            try:
                relaunched = relaunch_after_known_unlaunched_fault(plan, host, receipt, now)
            except (Blocked, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
                pass
        record("blocked", status="fault_fixture_not_verified", reason=getattr(error, "code", "operation_unconfirmed"),
               source_restore=restored, desktop_relaunch_unconfirmed=closed,
               bounded_official_relaunch_requested=relaunched,
               manual_relaunch_may_be_required=closed and not relaunched)
    return receipt


def worker(plan_path, expected_sha, claim_id):
    plan, raw = desktop.read_json(plan_path)
    if desktop.sha(raw) != expected_sha:
        raise Blocked("fault_plan_changed")
    claim, unused = desktop.read_json(plan_path + ".claim")
    if claim.get("claim_id") != claim_id or claim.get("plan_sha256") != expected_sha:
        raise Blocked("fault_claim_mismatch")
    scheduler_pid = claim.get("scheduler_pid")
    if type(scheduler_pid) is not int or scheduler_pid <= 1 or os.getppid() != scheduler_pid:
        raise Blocked("fault_scheduler_parent_unconfirmed")
    receipt, unused = desktop.read_json(plan["receipt_path"])
    if receipt.get("plan_id") != plan["plan_id"] or receipt.get("stage") != "worker_starting":
        raise Blocked("fault_worker_receipt_mismatch")
    host = DrillHost()
    try:
        if os.getsid(0) != os.getpid():
            raise Blocked("detached_worker_required")
        preconditions(plan, host, time.time())
        desktop.stage(receipt, plan["receipt_path"], "worker_ready", time.time(), worker_pid=os.getpid(), detached_session_confirmed=True)
        deadline = time.monotonic() + 15
        while True:
            try:
                go, unused = desktop.read_json(plan_path + ".go")
                if go.get("claim_id") != claim_id:
                    raise Blocked("fault_worker_handshake_mismatch")
                break
            except FileNotFoundError:
                if time.monotonic() >= deadline:
                    raise Blocked("fault_handshake_missing_no_mutation")
                time.sleep(0.05)
        desktop.wait_scheduler_exit(scheduler_pid, receipt, plan["receipt_path"])
        run_fault(plan, host, receipt)
    except (Blocked, recovery.RecoveryError, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        desktop.stage(receipt, plan["receipt_path"], "blocked", time.time(), status="fault_fixture_not_verified",
                      reason=getattr(error, "code", "worker_preflight_unconfirmed"))
    finally:
        host.close()
    return 0 if receipt.get("status") in ("awaiting_same_chat_native_failure", "product_repair_restart_scheduled",
                                         "developer_rollback_restart_scheduled") else 1


def schedule(plan, host):
    preconditions(plan, host, time.time())
    work = Path(plan["prepared"]["workspace"])
    path = str(work / "fault-plan.json")
    desktop.create_private(path, plan)
    plan_sha = desktop.file_sha(path)
    claim = str(uuid.uuid4())
    desktop.create_private(path + ".claim", {"claim_id": claim, "plan_sha256": plan_sha, "scheduler_pid": os.getpid()})
    receipt = {"schema_version": 1, "plan_id": plan["plan_id"], "thread_id": ROOT_THREAD,
               "stage": "worker_starting", "history": [], "launch_attempts": 0,
               "force_termination_used": False, "native_error_observed": False,
               "native_authentication_recovered": False, "same_chat_continuation_verified": False,
               "queue_attempted": False, "graceful_termination_requested": False}
    desktop.create_private(plan["receipt_path"], receipt)
    descriptor = os.open(plan["receipt_path"] + ".worker.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    environment = dict(os.environ)
    environment.pop(desktop.KEY, None)
    with os.fdopen(descriptor, "wb") as log:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--_worker", path,
                                  "--_expected-plan-sha", plan_sha, "--_claim-id", claim],
                                 start_new_session=True, close_fds=True, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=log, env=environment, cwd="/")
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        current, unused = desktop.read_json(plan["receipt_path"])
        if current.get("stage") == "worker_ready":
            if current.get("worker_pid") != child.pid or current.get("detached_session_confirmed") is not True:
                raise Blocked("fault_detached_handshake_unconfirmed")
            desktop.create_private(path + ".go", {"claim_id": claim})
            return {"status": "developer_fault_scheduled", "worker_pid": child.pid,
                    "receipt_path": plan["receipt_path"], "delay_seconds": DELAY,
                    "native_error_observed": False, "native_authentication_recovered": False}
        if child.poll() is not None or current.get("stage") == "blocked":
            raise Blocked("fault_worker_preflight_failed_no_injection")
        time.sleep(0.05)
    raise Blocked("fault_handshake_deadline_no_injection")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument("--inject", metavar="PRIVATE_PREPARED_JSON")
    mode.add_argument("--restore-own-global", metavar="PRIVATE_PREPARED_JSON")
    mode.add_argument("--observer-begin", metavar="FAULT_PLAN")
    mode.add_argument("--observer-finish", metavar="FAULT_PLAN")
    mode.add_argument("--_worker", help=argparse.SUPPRESS)
    parser.add_argument("--app-path", default="/Applications/ChatGPT.app")
    parser.add_argument("--expected-desktop-pid", type=int)
    parser.add_argument("--expected-engine-pid", type=int)
    parser.add_argument("--checkpoint")
    parser.add_argument("--idle-evidence")
    parser.add_argument("--background-work-confirmed-idle", action="store_true")
    parser.add_argument("--queue-continuation", action="store_true", help="Explicitly queue one continuation to the fixed existing root chat; never uses --resume.")
    parser.add_argument("--resume-message-file", "--recovery-resume-message-file", dest="resume_message_file", help="Private UTF-8 message queued only to this same root chat after verified official restart.")
    parser.add_argument("--native-observer-message-file", help="Private UTF-8 exact observer message queued once to this same root chat after the controlled fault launch.")
    parser.add_argument("--response-file", help="Owned private minimal response staging file returned by --observer-begin.")
    parser.add_argument("--_expected-plan-sha", help=argparse.SUPPRESS)
    parser.add_argument("--_claim-id", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    host = None
    try:
        if args._worker:
            return worker(args._worker, args._expected_plan_sha, args._claim_id)
        host = DrillHost()
        if args.observer_begin or args.observer_finish:
            plan, unused = desktop.read_json(args.observer_begin or args.observer_finish)
            if args.observer_begin:
                result = observer_begin(plan, host)
            else:
                if not args.response_file:
                    raise Blocked("observer_response_file_required")
                result = observer_finish(plan, host, args.response_file)
        elif args.prepare:
            prepared = prepare(args.app_path, host)
            result = {"status": "developer_candidate_prepared", "prepared_path": str(Path(prepared["workspace"]) / "prepared.json"), "global_environment_changed": False}
        else:
            prepared, unused = desktop.read_json(args.inject or args.restore_own_global)
            if args.restore_own_global:
                result = {"status": restore_own_source(prepared, host)}
            else:
                if not all((args.expected_desktop_pid, args.expected_engine_pid, args.checkpoint, args.idle_evidence)):
                    raise Blocked("exact_process_checkpoint_and_idle_inputs_required")
                plan = fault_plan(prepared, host, args.expected_desktop_pid, args.expected_engine_pid,
                                  args.checkpoint, args.idle_evidence, args.background_work_confirmed_idle,
                                  args.queue_continuation, resume_message_file=args.resume_message_file,
                                  native_observer_message_file=args.native_observer_message_file)
                result = schedule(plan, host)
        print(json.dumps(result, indent=2))
        return 0
    except (Blocked, recovery.RecoveryError, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"status": "blocked", "reason": getattr(error, "code", "developer_drill_unconfirmed"), "native_authentication_recovered": False}))
        return 1
    finally:
        if host is not None:
            host.close()


if __name__ == "__main__":
    sys.exit(main())
