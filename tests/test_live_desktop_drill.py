"""Development drill tests: no real process, signing, AppKit or launchctl calls."""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("ccuh_live_drill", ROOT / "lab/live_desktop_drill.py")
drill = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(drill)


class Clock:
    def __init__(self, now=1000):
        self.value = now
        self.after_sleep = lambda: None

    def now(self):
        return self.value

    def sleep(self, duration):
        self.value += duration
        self.after_sleep()


class Host:
    def __init__(self, runtime):
        self.runtime = runtime
        self.value = None
        self.calls = []
        self.phase = "old"
        self.accept_terminate = True
        self.hang_terminate = False
        self.unknown_launch = False
        self.microseconds = 1
        self.candidate_path = None
        self.queue_error = None
        self.fault_microseconds = 1
        self.sidecar_value = "official-sidecar"

    def source(self):
        return {"value": self.value, "fingerprint": drill.recovery.value_digest(self.value)}

    def change_source(self, expected, value):
        if self.source() != expected:
            raise drill.Blocked("source_changed")
        self.calls.append(("source", value))
        self.value = value
        return self.source()

    def candidate(self, path):
        return {"verified": True, "resolved_path": str(Path(path).resolve()),
                "binary_sha256": drill.desktop.file_sha(path), "signature": "adhoc", "team_identifier_absent": True}

    def copy_and_sign(self, runtime, work):
        self.calls.append(("copy_and_sign",))
        path = work / "CodexCLI.app/Contents/MacOS/codex"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"fixture-adhoc-image")
        self.candidate_path = str(path)
        return path

    def record(self, pid, ppid, path):
        return {"pid": pid, "ppid": ppid, "uid": os.getuid(), "start_seconds": pid,
                "start_microseconds": self.microseconds if pid == 10 else self.fault_microseconds if pid == 21 else 1, "executable": path}

    def sidecars(self, runtime, candidate_cli, evidence=None):
        return {"runtime": runtime["cli"]["path"], "candidate": str(candidate_cli), "host_sha256": self.sidecar_value}

    def tool_preflight(self, runtime, candidate_cli, sidecars):
        return {"schema_version": 1, "kind": "ccuh_developer_runtime_preflight", "code_mode_and_nested_exec_confirmed": True,
                "sidecars_revalidated": True, "candidate_cli_sha256": drill.desktop.file_sha(candidate_cli)}

    def repair_native(self, plan, marker_path):
        self.calls.append(("product_repair", marker_path))
        self.value = None
        return {"status": "repair_applied", "native_authentication_recovered": False}

    def schedule_product_restart(self, plan_path):
        self.calls.append(("product_restart", str(plan_path)))
        return {"status": "restart_scheduled", "worker_pid": 100}

    def launch(self, path):
        self.calls.append(("official_launch", path))
        return 30

    def applications(self):
        if self.phase == "gone":
            return []
        return [{"pid": 10 if self.phase == "old" else 20,
                 "bundle_path": self.runtime["app_path"], "executable": self.runtime["main"]["path"]}]

    def process(self, pid):
        records = self.descendants(10 if self.phase == "old" else 20)
        if self.phase != "gone":
            app_pid = 10 if self.phase == "old" else 20
            records.append(self.record(app_pid, 1, self.runtime["main"]["path"]))
        return next((row for row in records if row["pid"] == pid), None)

    def descendants(self, pid):
        if self.phase == "old" and pid == 10:
            return [self.record(11, 10, self.runtime["cli"]["path"])]
        if self.phase == "new" and pid == 20:
            # Both are CLI images: only the direct app-server role is eligible.
            return [self.record(21, 20, self.candidate_path), self.record(22, 20, self.candidate_path),
                    self.record(23, 21, self.candidate_path)]
        return []

    def is_app_server(self, record):
        self.calls.append(("role", record["pid"]))
        return record["pid"] in (11, 21, 23)

    def terminate(self, pid):
        self.calls.append(("terminate", pid))
        if self.accept_terminate and not self.hang_terminate:
            self.phase = "gone"
        return self.accept_terminate

    def launch_fault(self, path, candidate):
        self.calls.append(("launch_fault", path, candidate))
        self.phase = "new"
        return None if self.unknown_launch else 20

    def open_root_chat(self, app_path):
        self.calls.append(("deep_link", drill.ROOT_THREAD))
        return True

    def queue_continuation(self, cli, path, message_file=None):
        self.calls.append(("queue", cli, path, message_file))
        if self.queue_error:
            raise self.queue_error
        return True

    def close(self):
        self.calls.append(("close",))


class LiveDrillTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/private/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cli = self.root / "official-codex"
        self.cli.write_bytes(b"official-fixture")
        self.runtime = {"app_path": str(self.root / "Official.app"), "bundle_id": "com.openai.codex",
                        "main": {"path": str(self.root / "official-desktop"), "sha256": "main"},
                        "cli": {"path": str(self.cli), "sha256": drill.desktop.file_sha(self.cli)}}
        self.host = Host(self.runtime)
        self.clock = Clock()
        self.trust = patch.object(drill.desktop, "official_runtime", return_value=self.runtime)
        self.trust.start()
        self.addCleanup(self.trust.stop)
        self.sources = patch.object(drill.desktop, "clean_sources", return_value={"launchctl": {"absent_or_official": True}, "config": None})
        self.sources.start()
        self.addCleanup(self.sources.stop)
        self.hashes = patch.object(drill, "script_hashes", return_value={"test_helpers": "pinned"})
        self.hashes.start()
        self.addCleanup(self.hashes.stop)
        # Any accidental real command invocation fails every test immediately.
        self.no_commands = patch.object(drill.subprocess, "run", side_effect=AssertionError("real subprocess forbidden"))
        self.no_commands.start()
        self.addCleanup(self.no_commands.stop)
        self.no_children = patch.object(drill.subprocess, "Popen", side_effect=AssertionError("real child forbidden"))
        self.no_children.start()
        self.addCleanup(self.no_children.stop)

    def prepared(self):
        return drill.prepare(self.runtime["app_path"], self.host, self.root / "work", self.clock.now())

    def guards(self, busy=False):
        checkpoint = self.root / "checkpoint.json"
        idle = self.root / "idle.json"
        drill.desktop.create_private(checkpoint, {"schema_version": 1, "thread_id": drill.ROOT_THREAD,
            "created_at": drill.desktop.utc(self.clock.now()), "ready_for_restart": True,
            "native_operations_pending": False, "mutation_outcome_unknown": False})
        drill.desktop.create_private(idle, {"schema_version": 1, "current_thread_id": drill.ROOT_THREAD,
            "observed_at": drill.desktop.utc(self.clock.now()), "source": "codex_desktop_list_threads",
            "inventory_complete": True, "background_work_confirmed_idle": True,
            "other_busy_thread_ids": ["another-chat"] if busy else [], "other_unknown_thread_ids": []})
        return checkpoint, idle

    def plan(self, queue=False):
        prepared = self.prepared()
        checkpoint, idle = self.guards()
        plan = drill.fault_plan(prepared, self.host, 10, 11, checkpoint, idle, True, queue, self.clock.now())
        receipt = {"plan_id": plan["plan_id"], "stage": "worker_starting", "history": [], "launch_attempts": 0,
                   "native_error_observed": False, "native_authentication_recovered": False,
                   "force_termination_used": False, "same_chat_continuation_verified": False}
        drill.desktop.create_private(plan["receipt_path"], receipt)
        return plan, receipt

    def run_until_source_recovered(self, plan, receipt):
        def recovered():
            if self.host.phase == "new" and self.clock.now() >= 1020:
                self.host.value = None  # Simulated later product repair; not a real environment.
        self.clock.after_sleep = recovered
        return drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)

    def run_with_slow_receipt(self, plan, receipt, slow_name):
        persist = drill.desktop.stage
        def slow_stage(selected_receipt, path, name, now, **fields):
            persist(selected_receipt, path, name, now, **fields)
            if name == slow_name:
                self.clock.value += drill.desktop.IDLE_TTL + 1
        with patch.object(drill.desktop, "stage", side_effect=slow_stage):
            return drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)

    def test_preparation_does_not_change_source_or_official_image(self):
        before = self.cli.read_bytes()
        prepared = self.prepared()
        self.assertEqual(self.host.value, None)
        self.assertEqual(self.cli.read_bytes(), before)
        self.assertEqual(prepared["existing_root_thread_id"], drill.ROOT_THREAD)
        self.assertEqual(os.stat(prepared["backup_path"]).st_mode & 0o777, 0o600)
        self.assertEqual([row[0] for row in self.host.calls], ["copy_and_sign"])

    def test_existing_global_override_is_preserved_before_fixture_creation(self):
        self.host.value = "/selected/custom/codex"
        with self.assertRaises(drill.Blocked):
            self.prepared()
        self.assertFalse((self.root / "work").exists())
        self.assertEqual(self.host.value, "/selected/custom/codex")

    def test_busy_background_or_missing_ack_blocks_before_source_mutation(self):
        prepared = self.prepared()
        checkpoint, idle = self.guards(busy=True)
        for confirmed in (False, True):
            with self.assertRaises(drill.Blocked):
                drill.fault_plan(prepared, self.host, 10, 11, checkpoint, idle, confirmed, now=self.clock.now())
        self.assertFalse(any(row[0] == "source" for row in self.host.calls))

    def test_graceful_one_shot_fault_selects_app_server_not_exec_server(self):
        plan, receipt = self.plan()
        result = self.run_until_source_recovered(plan, receipt)
        self.assertEqual(result["status"], "awaiting_same_chat_native_failure")
        self.assertEqual(result["replacement"]["engine_pid"], 21)
        self.assertFalse(result["native_error_observed"])
        self.assertFalse(result["native_authentication_recovered"])
        self.assertEqual(len([row for row in self.host.calls if row[0] == "launch_fault"]), 1)
        self.assertEqual(len([row for row in self.host.calls if row[0] == "deep_link"]), 1)
        self.assertFalse(any(row[0] == "queue" for row in self.host.calls))

    def test_plain_queue_is_explicit_once_and_uses_official_cli(self):
        plan, receipt = self.plan(queue=True)
        self.run_until_source_recovered(plan, receipt)
        queued = [row for row in self.host.calls if row[0] == "queue"]
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0][1], str(self.cli))
        self.assertTrue(receipt["queue_exit_zero"])
        self.assertFalse(receipt["same_chat_continuation_verified"])

    def test_pid_identity_change_during_delay_blocks_before_injection(self):
        plan, receipt = self.plan()
        self.clock.after_sleep = lambda: setattr(self.host, "microseconds", 99)
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["status"], "fault_fixture_not_verified")
        self.assertFalse(any(row[0] in ("source", "terminate", "launch_fault") for row in self.host.calls))

    def test_slow_receipt_before_source_authorization_blocks_all_injection(self):
        plan, receipt = self.plan()
        self.run_with_slow_receipt(plan, receipt, "environment_change_preflight_complete")
        self.assertEqual(receipt["reason"], "guard_evidence_stale")
        self.assertFalse(any(row[0] in ("source", "terminate", "launch_fault") for row in self.host.calls))
        self.assertFalse(receipt.get("graceful_termination_requested", False))
        self.assertNotIn("environment_change_requested", [entry["stage"] for entry in receipt["history"]])

    def test_slow_receipt_before_quit_authorization_restores_source_without_quit(self):
        plan, receipt = self.plan()
        self.run_with_slow_receipt(plan, receipt, "quit_preflight_complete")
        self.assertEqual(receipt["reason"], "guard_evidence_stale")
        self.assertFalse(any(row[0] in ("terminate", "launch_fault") for row in self.host.calls))
        self.assertFalse(receipt.get("graceful_termination_requested", False))
        self.assertNotIn("graceful_termination_requested", [entry["stage"] for entry in receipt["history"]])
        self.assertEqual([row[1] for row in self.host.calls if row[0] == "source"],
                         [plan["prepared"]["candidate"]["resolved_path"], None])
        self.assertEqual(self.host.value, None)

    def test_termination_refusal_restores_own_source_and_never_launches(self):
        plan, receipt = self.plan()
        self.host.accept_terminate = False
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(self.host.value, None)
        self.assertFalse(any(row[0] == "launch_fault" for row in self.host.calls))
        self.assertFalse(receipt["force_termination_used"])

    def test_old_process_timeout_has_no_force_or_replacement_launch(self):
        plan, receipt = self.plan()
        self.host.hang_terminate = True
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["reason"], "old_desktop_not_gone_no_force_no_launch")
        self.assertEqual(self.host.value, None)
        self.assertFalse(any(row[0] == "launch_fault" for row in self.host.calls))

    def test_unknown_launch_is_never_repeated_and_global_override_rolls_back(self):
        plan, receipt = self.plan()
        self.host.unknown_launch = True
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["reason"], "fault_launch_result_unknown_no_retry")
        self.assertEqual(self.host.value, None)
        self.assertEqual(len([row for row in self.host.calls if row[0] == "launch_fault"]), 1)
        self.assertFalse(any(row[0] == "deep_link" for row in self.host.calls))

    def test_deadman_clears_only_its_still_owned_value(self):
        plan, receipt = self.plan()
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["status"], "developer_rollback_restart_scheduled")
        self.assertEqual(receipt["source_restore"], "own_override_restored_to_absent")
        self.assertEqual(self.host.value, None)
        self.assertEqual(len([row for row in self.host.calls if row[0] == "product_restart"]), 1)
        self.assertFalse(receipt["native_error_observed"])
        self.assertLessEqual(self.clock.now(), 1096)
        self.host.value = "/later/user/choice"
        self.assertEqual(drill.restore_own_source(plan["prepared"], self.host), "different_value_preserved")
        self.assertEqual(self.host.value, "/later/user/choice")

    def test_queue_timeout_does_not_repeat_or_claim_delivery(self):
        plan, receipt = self.plan(queue=True)
        self.host.queue_error = subprocess.TimeoutExpired("queue", 30)
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(len([row for row in self.host.calls if row[0] == "queue"]), 1)
        self.assertEqual(self.host.value, None)
        self.assertFalse(receipt["same_chat_continuation_verified"])
        self.assertEqual(receipt["status"], "developer_rollback_restart_scheduled")

    def test_unconfirmed_same_chat_open_keeps_external_rollback_armed(self):
        plan, receipt = self.plan()
        with patch.object(self.host, "open_root_chat", return_value=False):
            drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertFalse(receipt["deep_link_confirmed"])
        self.assertEqual(receipt["status"], "developer_rollback_restart_scheduled")
        self.assertEqual(len([row for row in self.host.calls if row[0] == "product_restart"]), 1)

    def write_native_marker(self, plan, receipt, **changes):
        value = {"schema_version": 1, "kind": "ccuh_live_native_authentication_failure", "plan_id": plan["plan_id"],
                 "thread_id": drill.ROOT_THREAD, "observed_at": drill.desktop.utc(self.clock.now()),
                 "desktop": receipt["replacement"]["desktop"], "engine": receipt["replacement"]["engine"],
                 "error": {"code": -10000, "message": "sender process is not authenticated"}}
        value.update(changes)
        drill.desktop.create_private(plan["native_failure_path"], value)

    def test_exact_native_marker_uses_product_repair_and_original_fresh_guards(self):
        plan, receipt = self.plan()
        def marker():
            if self.host.phase == "new" and self.clock.now() >= 1020 and not Path(plan["native_failure_path"]).exists():
                self.write_native_marker(plan, receipt)
        self.clock.after_sleep = marker
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["status"], "product_repair_restart_scheduled")
        self.assertTrue(receipt["native_error_observed"])
        self.assertFalse(receipt["native_authentication_recovered"])
        self.assertEqual(len([row for row in self.host.calls if row[0] == "product_repair"]), 1)
        restart, unused = drill.desktop.read_json(receipt["product_restart_plan"])
        self.assertEqual(restart["guards"], plan["guards"])
        self.assertEqual(restart["thread_id"], drill.ROOT_THREAD)
        self.assertEqual(restart["engine"], receipt["replacement"]["engine"])
        self.assertEqual(restart["delay_seconds"], 5)
        idle, unused = drill.desktop.read_json(plan["guards"]["idle"]["path"])
        self.assertEqual(idle["observed_at"], plan["original_idle_observed_at"])

    def test_native_marker_wrong_chat_blocks_repair_and_restart(self):
        plan, receipt = self.plan()
        def marker():
            if self.host.phase == "new" and self.clock.now() >= 1020 and not Path(plan["native_failure_path"]).exists():
                self.write_native_marker(plan, receipt, thread_id="another-chat")
        self.clock.after_sleep = marker
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["reason"], "native_failure_live_context_mismatch")
        self.assertFalse(any(row[0] in ("product_repair", "product_restart") for row in self.host.calls))
        self.assertEqual(self.host.value, None)

    def test_fault_engine_start_identity_change_preserves_new_engine(self):
        plan, receipt = self.plan()
        def changed():
            if self.host.phase == "new" and self.clock.now() >= 1020:
                self.host.fault_microseconds = 999
        self.clock.after_sleep = changed
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["reason"], "fault_process_identity_changed_no_restart")
        self.assertFalse(any(row[0] == "product_restart" for row in self.host.calls))

    def test_other_source_edit_is_preserved_without_restart(self):
        plan, receipt = self.plan()
        def changed():
            if self.host.phase == "new" and self.clock.now() >= 1020:
                self.host.value = "/later/user/choice"
        self.clock.after_sleep = changed
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(self.host.value, "/later/user/choice")
        self.assertFalse(any(row[0] == "product_restart" for row in self.host.calls))

    def test_existing_recovery_claim_prevents_second_restart(self):
        plan, receipt = self.plan()
        drill.desktop.create_private(plan["recovery_lock_path"], {"plan_id": plan["plan_id"], "owner": "another-worker"})
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertFalse(any(row[0] in ("product_repair", "product_restart") for row in self.host.calls))

    def test_insufficient_idle_lease_refuses_injection_plan(self):
        prepared = self.prepared()
        checkpoint, idle = self.guards()
        self.clock.value += drill.desktop.IDLE_TTL - drill.MIN_RECOVERY_LEASE + 1
        with self.assertRaises(drill.Blocked) as caught:
            drill.fault_plan(prepared, self.host, 10, 11, checkpoint, idle, True, now=self.clock.now())
        self.assertEqual(caught.exception.code, "insufficient_original_idle_recovery_lease")

    def test_bounded_preflight_latency_keeps_recovery_inside_original_lease(self):
        plan, receipt = self.plan()
        self.clock.value += 18
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["status"], "developer_rollback_restart_scheduled")
        self.assertEqual(receipt["product_restart_execute_attempts"], 1)
        self.assertLess(self.clock.value, 1000 + drill.desktop.IDLE_TTL)
        self.assertFalse(receipt["native_error_observed"])

    def test_sidecar_changed_after_preparation_blocks_injection(self):
        prepared = self.prepared()
        checkpoint, idle = self.guards()
        self.host.sidecar_value = "changed"
        with self.assertRaises(drill.Blocked) as caught:
            drill.fault_plan(prepared, self.host, 10, 11, checkpoint, idle, True, now=self.clock.now())
        self.assertEqual(caught.exception.code, "developer_sidecars_changed_or_unconfirmed")

    def test_changed_idle_inventory_before_fallback_prevents_restart(self):
        plan, receipt = self.plan()
        changed = False
        def busy():
            nonlocal changed
            if self.host.phase == "new" and self.clock.now() >= 1020 and not changed:
                idle, unused = drill.desktop.read_json(plan["guards"]["idle"]["path"])
                idle["other_unknown_thread_ids"] = ["new-unknown-chat"]
                drill.desktop.replace_private(plan["guards"]["idle"]["path"], idle)
                changed = True
        self.clock.after_sleep = busy
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["reason"], "other_threads_busy_or_unknown")
        self.assertFalse(any(row[0] == "product_restart" for row in self.host.calls))

    def test_closed_after_own_quit_before_any_launch_has_one_official_launch(self):
        plan, receipt = self.plan()
        original = drill.preconditions
        def fail_after_quit(selected, host, now, source_value=None, originals=True):
            if host.phase == "gone":
                raise drill.Blocked("fixture_failure_before_launch")
            return original(selected, host, now, source_value, originals)
        with patch.object(drill, "preconditions", side_effect=fail_after_quit):
            drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(len([row for row in self.host.calls if row[0] == "official_launch"]), 1)
        self.assertFalse(any(row[0] == "launch_fault" for row in self.host.calls))
        self.assertTrue(receipt["bounded_official_relaunch_requested"])

    def test_product_restart_adapter_uses_separate_public_cli_parent(self):
        host = object.__new__(drill.DrillHost)
        response = json.dumps({"status": "restart_scheduled", "worker_pid": 900}).encode()
        with patch.object(drill.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=response)) as run:
            result = host.schedule_product_restart("/private/tmp/restart-plan.json")
        self.assertEqual(result["worker_pid"], 900)
        self.assertEqual(run.call_args.args[0], [drill.sys.executable, str(Path(drill.desktop.__file__).resolve()),
                                               "--execute", "/private/tmp/restart-plan.json"])
        self.assertNotIn(drill.desktop.KEY, run.call_args.kwargs["env"])

    def test_pending_native_read_at_deadline_clears_source_without_restart(self):
        plan, receipt = self.plan()
        def pending():
            if self.host.phase == "new" and self.clock.now() >= 1020 and not Path(plan["native_pending_path"]).exists():
                drill.desktop.create_private(plan["native_pending_path"], {"schema_version": 1,
                    "kind": "ccuh_live_native_read_pending", "plan_id": plan["plan_id"], "thread_id": drill.ROOT_THREAD,
                    "desktop": receipt["replacement"]["desktop"], "engine": receipt["replacement"]["engine"],
                    "created_at": drill.desktop.utc(self.clock.now())})
        self.clock.after_sleep = pending
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["status"], "native_read_pending_no_restart")
        self.assertTrue(receipt["native_operation_completion_unconfirmed"])
        self.assertEqual(self.host.value, None)
        self.assertFalse(any(row[0] in ("product_repair", "product_restart") for row in self.host.calls))
        self.assertEqual(len([row for row in self.host.calls if row[0] == "terminate"]), 1)

    def test_product_final_clock_check_prevents_quit_after_original_idle_ttl(self):
        plan, receipt = self.plan()
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        restart, unused = drill.desktop.read_json(receipt["product_restart_plan"])
        self.assertEqual(restart["delay_seconds"], 5)
        restart_receipt = drill.desktop.receipt_base(restart)
        drill.desktop.create_private(restart["receipt_path"], restart_receipt)
        self.clock.value = 1115  # Original idle observation is exactly 1000.
        persist = drill.desktop.stage
        def late_stage(selected, path, name, now, **fields):
            persist(selected, path, name, now, **fields)
            if name == "quit_preflight_complete":
                self.clock.value += 1
        with patch.object(drill.desktop, "stage", side_effect=late_stage):
            drill.desktop.run_restart(restart, self.host, restart_receipt, restart["receipt_path"],
                                      now=self.clock.now, sleep=self.clock.sleep)
        self.assertEqual(restart_receipt["reason"], "guard_evidence_stale")
        self.assertFalse(restart_receipt["graceful_termination_requested"])
        self.assertEqual(len([row for row in self.host.calls if row[0] == "terminate"]), 1)
        idle, unused = drill.desktop.read_json(plan["guards"]["idle"]["path"])
        self.assertEqual(idle["observed_at"], drill.desktop.utc(1000))

    def test_failure_marker_cannot_override_still_pending_native_read(self):
        plan, receipt = self.plan()
        def both():
            if self.host.phase == "new" and self.clock.now() >= 1020 and not Path(plan["native_pending_path"]).exists():
                self.write_native_marker(plan, receipt)
                drill.desktop.create_private(plan["native_pending_path"], {"unconfirmed": True})
        self.clock.after_sleep = both
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["status"], "native_read_pending_no_restart")
        self.assertFalse(receipt["native_error_observed"])
        self.assertFalse(any(row[0] == "product_restart" for row in self.host.calls))

    def test_pending_file_appearing_during_claim_blocks_restart(self):
        plan, receipt = self.plan()
        create = drill.desktop.create_private
        def publish(path, value):
            create(path, value)
            if str(path) == plan["recovery_lock_path"]:
                create(plan["native_pending_path"], {"unconfirmed": True})
        with patch.object(drill.desktop, "create_private", side_effect=publish):
            drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertEqual(receipt["reason"], "native_read_pending_no_restart")
        self.assertFalse(any(row[0] in ("product_repair", "product_restart") for row in self.host.calls))

    def test_exact_observer_and_resume_messages_are_pinned(self):
        prepared = self.prepared()
        checkpoint, idle = self.guards()
        observer = self.root / "observer.txt"
        resume = self.root / "resume.txt"
        observer.write_text("Exact observer: one native read with a pending handshake.")
        resume.write_text("Read receipt and perform final proof.")
        observer.chmod(0o600)
        resume.chmod(0o600)
        plan = drill.fault_plan(prepared, self.host, 10, 11, checkpoint, idle, True, True, self.clock.now(),
                                resume_message_file=resume, native_observer_message_file=observer)
        receipt = {"plan_id": plan["plan_id"], "history": [], "launch_attempts": 0, "native_error_observed": False}
        drill.desktop.create_private(plan["receipt_path"], receipt)
        self.run_until_source_recovered(plan, receipt)
        self.assertEqual([row for row in self.host.calls if row[0] == "queue"][0][3], str(observer))
        self.assertEqual(plan["closed_relaunch_plan"]["continuation"]["message_file"], str(resume))

    def test_native_repair_adapter_calls_actual_product_plan_and_apply_apis(self):
        plan, receipt = self.plan()
        host = object.__new__(drill.DrillHost)
        store = object()
        with patch.object(drill.recovery, "Store", return_value=store), patch.object(drill.recovery, "make_plan", return_value={"fixture": True}) as make, patch.object(drill.recovery, "apply_plan", return_value={"status": "repair_applied"}) as apply:
            host.repair_native(plan, plan["native_failure_path"])
        self.assertEqual(make.call_args.args, (store, self.runtime["app_path"], "authentication_failed"))
        self.assertEqual(make.call_args.kwargs, {"remove_adhoc": True, "response_path": plan["native_failure_path"]})
        self.assertEqual(apply.call_args.args[2], "authentication_failed")

    def test_actual_copy_adapter_preserves_sidecar_evidence_before_signing(self):
        host = object.__new__(drill.DrillHost)
        work = self.root / "copy-work"
        work.mkdir()
        order = []
        evidence = {"source_host": "pinned-before-sign"}
        helper = SimpleNamespace(Blocked=drill.Blocked,
            copy_sidecars=lambda *args: order.append("copy_sidecars") or evidence,
            validate_sidecars=lambda *args: order.append(("validate", args[2])) or evidence)
        def sign(*args, **kwargs):
            order.append("sign")
            return SimpleNamespace(returncode=0)
        with patch.object(drill, "runtime_helper", return_value=helper), patch.object(drill.shutil, "copytree"), patch.object(drill.subprocess, "run", side_effect=sign):
            candidate = host.copy_and_sign(self.runtime, work)
            self.assertEqual(host.sidecars(self.runtime, candidate), evidence)
        self.assertEqual(order, ["copy_sidecars", "sign", ("validate", evidence), ("validate", evidence)])

    def observe_once(self, plan, receipt, result, complete=True):
        seen = {}
        def observed():
            if self.host.phase == "new" and self.clock.now() >= 1020 and not seen:
                begun = drill.observer_begin(plan, self.host, self.clock.now)
                seen["begin"] = begun
                self.assertTrue(begun["permitted"])
                frame = {"schema_version": 1, "kind": "ccuh_live_native_response", "observer_id": begun["observer_id"],
                         "operation_complete": complete, "result": result}
                drill.desktop.replace_private(begun["response_staging_path"], frame)
                seen["finish"] = drill.observer_finish(plan, self.host, begun["response_staging_path"], self.clock.now)
        self.clock.after_sleep = observed
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        return seen

    def test_observer_begin_finish_authentication_error_routes_product_repair(self):
        plan, receipt = self.plan()
        result = {"isError": True, "content": [{"type": "text", "text": "[-10000] sender process is not authenticated"}]}
        seen = self.observe_once(plan, receipt, result)
        self.assertEqual(seen["finish"]["status"], "native_authentication_failure_recorded")
        marker, unused = drill.desktop.read_json(plan["native_failure_path"])
        self.assertEqual(marker["error"], result)
        self.assertFalse(Path(plan["native_pending_path"]).exists())
        self.assertEqual(receipt["status"], "product_repair_restart_scheduled")
        self.assertEqual(os.stat(seen["begin"]["response_staging_path"]).st_mode & 0o777, 0o600)

    def test_observer_definite_non_auth_response_requests_early_developer_rollback(self):
        plan, receipt = self.plan()
        seen = self.observe_once(plan, receipt, {"isError": False})
        self.assertEqual(seen["finish"]["status"], "native_observation_completed_without_authentication_evidence")
        self.assertEqual(receipt["status"], "developer_rollback_restart_scheduled")
        self.assertLess(self.clock.now(), 1021)
        self.assertFalse(receipt["native_error_observed"])
        self.assertFalse(Path(plan["native_failure_path"]).exists())

    def test_observer_timeout_retains_pending_and_prevents_restart(self):
        plan, receipt = self.plan()
        seen = self.observe_once(plan, receipt, {"error": {"message": "tool timed out; outcome unknown"}})
        self.assertTrue(seen["finish"]["pending_retained"])
        self.assertEqual(receipt["status"], "native_read_pending_no_restart")
        self.assertFalse(any(row[0] == "product_restart" for row in self.host.calls))

    def test_observer_placeholder_or_unknown_completion_retains_pending(self):
        plan, receipt = self.plan()
        seen = self.observe_once(plan, receipt, {"isError": False}, complete=False)
        self.assertEqual(seen["finish"]["status"], "native_operation_unresolved")
        self.assertTrue(Path(plan["native_pending_path"]).exists())
        self.assertFalse(any(row[0] == "product_restart" for row in self.host.calls))

    def test_observer_begin_declines_after_recovery_has_claimed(self):
        plan, receipt = self.plan()
        drill.desktop.create_private(plan["recovery_lock_path"], {"plan_id": plan["plan_id"]})
        result = drill.observer_begin(plan, self.host, self.clock.now)
        self.assertFalse(result["permitted"])
        self.assertFalse(Path(plan["native_pending_path"]).exists())

    def test_observer_begin_lock_race_removes_only_its_own_pending(self):
        plan, receipt = self.plan()
        seen = {}
        publish = drill.publish_private_json
        def race(path, value):
            publish(path, value)
            if str(path) == plan["native_pending_path"]:
                drill.desktop.create_private(plan["recovery_lock_path"], {"owner": "watcher"})
        def begin():
            if self.host.phase == "new" and self.clock.now() >= 1020 and not seen:
                with patch.object(drill, "publish_private_json", side_effect=race):
                    seen["result"] = drill.observer_begin(plan, self.host, self.clock.now)
                self.host.value = None
        self.clock.after_sleep = begin
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertFalse(seen["result"]["permitted"])
        self.assertFalse(Path(plan["native_pending_path"]).exists())

    def test_observer_finish_rejects_changed_pending_hash(self):
        plan, receipt = self.plan()
        seen = {}
        def begin():
            if self.host.phase == "new" and self.clock.now() >= 1020 and not seen:
                seen["begin"] = drill.observer_begin(plan, self.host, self.clock.now)
                pending, unused = drill.desktop.read_json(plan["native_pending_path"])
                pending["observer_id"] = "changed"
                drill.desktop.replace_private(plan["native_pending_path"], pending)
                with self.assertRaises(drill.Blocked) as caught:
                    drill.observer_finish(plan, self.host, seen["begin"]["response_staging_path"], self.clock.now)
                self.assertEqual(caught.exception.code, "observer_claim_or_pending_changed")
        self.clock.after_sleep = begin
        drill.run_fault(plan, self.host, receipt, self.clock.now, self.clock.sleep)
        self.assertTrue(Path(plan["native_pending_path"]).exists())
        self.assertFalse(any(row[0] == "product_restart" for row in self.host.calls))

    def test_real_queue_adapter_constructs_only_plain_fixed_chat_command(self):
        host = object.__new__(drill.DrillHost)
        with patch.object(drill.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run, patch.dict(os.environ, {drill.desktop.KEY: "/stale/parent"}):
            self.assertTrue(host.queue_continuation(str(self.cli), "/private/tmp/receipt.json"))
        command = run.call_args.args[0]
        self.assertEqual(command[:4], [str(self.cli), "queue", "--thread", drill.ROOT_THREAD])
        self.assertNotIn("--resume", command)
        self.assertEqual(run.call_args.kwargs["env"][drill.desktop.KEY], str(self.cli))

    def test_root_chat_adapter_reuses_public_background_open(self):
        host = object.__new__(drill.DrillHost)
        with patch.object(host, "open_thread", return_value=0) as opened:
            self.assertTrue(host.open_root_chat(self.runtime["app_path"]))
        opened.assert_called_once_with(drill.ROOT_THREAD, self.runtime["app_path"])

    def test_missing_worker_handshake_never_writes_go_or_changes_source(self):
        prepared = self.prepared()
        checkpoint, idle = self.guards()
        plan = drill.fault_plan(prepared, self.host, 10, 11, checkpoint, idle, True, now=self.clock.now())
        child = SimpleNamespace(pid=99, poll=lambda: None)
        with patch.object(drill.time, "time", side_effect=self.clock.now), patch.object(drill.time, "monotonic", side_effect=self.clock.now), patch.object(drill.time, "sleep", side_effect=self.clock.sleep), patch.object(drill.subprocess, "Popen", return_value=child) as popen:
            with self.assertRaises(drill.Blocked) as caught:
                drill.schedule(plan, self.host)
        self.assertEqual(caught.exception.code, "fault_handshake_deadline_no_injection")
        self.assertFalse((Path(prepared["workspace"]) / "fault-plan.json.go").exists())
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertFalse(any(row[0] in ("source", "terminate", "launch_fault") for row in self.host.calls))

    def test_worker_confirms_scheduler_exit_before_running_the_fault(self):
        plan, receipt = self.plan()
        path = str(Path(plan["prepared"]["workspace"]) / "fault-plan.json")
        drill.desktop.create_private(path, plan)
        plan_sha = drill.desktop.file_sha(path)
        drill.desktop.create_private(path + ".claim", {"claim_id": "claim", "plan_sha256": plan_sha, "scheduler_pid": 42})
        drill.desktop.create_private(path + ".go", {"claim_id": "claim"})
        with patch.object(drill, "DrillHost", return_value=self.host), patch.object(drill.os, "getppid", return_value=42), patch.object(drill.os, "getsid", return_value=100), patch.object(drill.os, "getpid", return_value=100), patch.object(drill.time, "time", side_effect=self.clock.now), patch.object(drill.desktop, "wait_scheduler_exit") as wait:
            def run(selected_plan, selected_host, selected_receipt):
                wait.assert_called_once()
                selected_receipt["status"] = "awaiting_same_chat_native_failure"
                return selected_receipt
            with patch.object(drill, "run_fault", side_effect=run):
                self.assertEqual(drill.worker(path, plan_sha, "claim"), 0)
        self.assertEqual(wait.call_args.args[0], 42)
        self.assertEqual(wait.call_args.args[2], plan["receipt_path"])
        self.assertFalse(any(row[0] in ("source", "terminate", "launch_fault") for row in self.host.calls))


if __name__ == "__main__":
    unittest.main()
