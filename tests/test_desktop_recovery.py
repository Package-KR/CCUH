import copy
import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "skills/ccuh-doctor/scripts/desktop_recovery.py"
SPEC = importlib.util.spec_from_file_location("ccuh_desktop_recovery", SOURCE)
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)
THREAD = "00000000-0000-4000-8000-000000000002"


class Clock:
    def __init__(self):
        self.value = 1000.0

    def now(self):
        return self.value

    def sleep(self, value):
        self.value += value


class LifecycleFixture:
    """No AppKit, real processes, launchctl, or application UI are used."""
    def __init__(self, runtime, old_engine):
        self.runtime = runtime
        self.old = {"pid": 100, "ppid": 1, "uid": os.getuid(), "start_seconds": 500,
                    "start_microseconds": 1, "executable": runtime["main"]["path"]}
        self.engine = {"pid": 101, "ppid": 100, "uid": os.getuid(), "start_seconds": 501,
                       "start_microseconds": 2, "executable": str(old_engine)}
        self.new = dict(self.old, pid=200, start_seconds=1005)
        self.new_engine = dict(self.engine, pid=201, ppid=200, start_seconds=1006, executable=runtime["cli"]["path"])
        self.records = {100: self.old, 101: self.engine}
        self.apps = [self.app(100)]
        self.terminate_calls = []
        self.launch_calls = []
        self.refuse_quit = False
        self.hold_old = False
        self.external_relaunch = False
        self.launch_returns_none = False
        self.no_new_engine = False

    def app(self, pid):
        return {"pid": pid, "bundle_path": self.runtime["app_path"], "executable": self.runtime["main"]["path"]}

    def applications(self):
        return copy.deepcopy(self.apps)

    def process(self, pid):
        return copy.deepcopy(self.records.get(pid))

    def descendants(self, pid):
        return [copy.deepcopy(item) for item in self.records.values() if item["ppid"] == pid]

    def is_app_server(self, record):
        return record["pid"] in (101, 201)

    def open_thread(self, thread_id, app_path):
        self.opened_thread = (thread_id, app_path)
        return 0

    def new_instance(self):
        self.apps = [self.app(200)]
        self.records[200] = self.new
        if not self.no_new_engine:
            self.records[201] = self.new_engine

    def terminate(self, pid):
        self.terminate_calls.append(pid)
        if self.refuse_quit:
            return False
        if not self.hold_old:
            self.records.pop(100, None)
            self.records.pop(101, None)
            self.apps = []
            if self.external_relaunch:
                self.new_instance()
        return True

    def launch(self, path):
        self.launch_calls.append(path)
        self.new_instance()
        return None if self.launch_returns_none else 200

    def close(self):
        pass


class DesktopRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.clock = Clock()
        self.main = self.root / "official-main"
        self.cli = self.root / "official-cli"
        self.adhoc = self.root / "known-adhoc-cli"
        for path in (self.main, self.cli, self.adhoc):
            path.write_text(path.name)
        identity = lambda path, identifier: {"path": str(path), "sha256": recovery.file_sha(path),
                                             "signing_team": recovery.TEAM, "signing_verified": True, "identifier": identifier}
        self.runtime = {"app_path": str(self.root / "Official.app"), "bundle_id": recovery.BUNDLE,
                        "metadata_sha256": "a" * 64, "main": identity(self.main, recovery.BUNDLE),
                        "cli": identity(self.cli, "official-cli-identifier")}
        self.sources = {"launchctl": {"override_present": False, "value_sha256": recovery.sha(b""), "absent_or_official": True},
                        "config": None, "parent_process_environment_changed": False}
        self.checkpoint = self.root / "checkpoint.json"
        self.idle = self.root / "idle.json"
        self.receipt = self.root / "receipt.json"
        recovery.create_private(self.checkpoint, {"schema_version": 1, "thread_id": THREAD,
            "created_at": recovery.utc(self.clock.now()), "ready_for_restart": True,
            "native_operations_pending": False, "mutation_outcome_unknown": False,
            "resume_instructions": "PRIVATE_CHECKPOINT_TEXT"})
        recovery.create_private(self.idle, {"schema_version": 1, "observed_at": recovery.utc(self.clock.now()),
            "current_thread_id": THREAD, "other_busy_thread_ids": [], "other_unknown_thread_ids": [],
            "background_work_confirmed_idle": True, "source": "codex_desktop_list_threads", "inventory_complete": True})
        self.backend = LifecycleFixture(self.runtime, self.adhoc)
        self.runtime_patch = patch.object(recovery, "official_runtime", return_value=self.runtime)
        self.sources_patch = patch.object(recovery, "clean_sources", return_value=self.sources)
        self.binary_patch = patch.object(recovery, "verified_binary", return_value=self.runtime["cli"])
        for mocked in (self.runtime_patch, self.sources_patch, self.binary_patch):
            mocked.start()
            self.addCleanup(mocked.stop)

    def plan(self, delay=3):
        return recovery.make_plan(self.runtime["app_path"], 100, 101, self.checkpoint, self.idle, THREAD,
                                  self.receipt, True, delay=delay, now=self.clock.now(), backend=self.backend)

    def run_plan(self, plan=None):
        plan = plan or self.plan()
        receipt = recovery.receipt_base(plan)
        recovery.create_private(self.receipt, receipt)
        return recovery.run_restart(plan, self.backend, receipt, self.receipt, self.clock.now, self.clock.sleep)

    def mutate_guard(self, path, **values):
        data, unused = recovery.read_json(path)
        data.update(values)
        recovery.replace_private(path, data)

    def test_healthy_restart_verifies_new_processes_without_authentication_claim(self):
        result = self.run_plan(self.plan(delay=15))
        self.assertEqual(result["status"], "desktop_restart_verified")
        self.assertEqual(self.backend.terminate_calls, [100])
        self.assertEqual(self.backend.launch_calls, [self.runtime["app_path"]])
        self.assertEqual(result["replacement"]["engine_pid"], 201)
        self.assertEqual(result["launch_attempts"], 1)
        self.assertFalse(result["native_authentication_recovered"])
        self.assertFalse(result["force_termination_used"])
        self.assertFalse(result["automatic_chat_resume_promised"])
        self.assertTrue(result["same_chat_native_verification_required"])
        self.assertEqual(stat.S_IMODE(self.receipt.stat().st_mode), 0o600)
        self.assertNotIn("PRIVATE_CHECKPOINT_TEXT", json.dumps(result))

    def test_known_adhoc_old_engine_is_pinned_without_trusting_its_signer(self):
        plan = self.plan()
        self.assertEqual(plan["engine"]["executable"], str(self.adhoc))
        self.assertEqual(plan["engine"]["binary_sha256"], recovery.file_sha(self.adhoc))
        self.assertNotIn("signing_verified", plan["engine"])
        self.assertEqual(self.run_plan(plan)["status"], "desktop_restart_verified")

    def test_busy_unknown_incomplete_or_unresolved_guards_never_request_quit(self):
        cases = ((self.idle, {"other_busy_thread_ids": ["other"]}),
                 (self.idle, {"other_unknown_thread_ids": ["other"]}),
                 (self.idle, {"inventory_complete": False}),
                 (self.checkpoint, {"native_operations_pending": True}),
                 (self.checkpoint, {"mutation_outcome_unknown": True}),
                 (self.checkpoint, {"ready_for_restart": False}))
        original_idle = self.idle.read_bytes()
        original_checkpoint = self.checkpoint.read_bytes()
        for path, changes in cases:
            with self.subTest(changes=changes):
                self.idle.write_bytes(original_idle)
                self.checkpoint.write_bytes(original_checkpoint)
                self.mutate_guard(path, **changes)
                with self.assertRaises(recovery.Blocked):
                    self.plan()
                self.assertEqual(self.backend.terminate_calls, [])

    def test_stale_or_changed_guard_and_reused_pid_block_before_quit(self):
        plan = self.plan()
        self.backend.records[101] = dict(self.backend.engine, start_microseconds=99)
        result = self.run_plan(plan)
        self.assertEqual(result["reason"], "original_process_identity_changed")
        self.assertFalse(self.backend.terminate_calls)
        self.receipt.unlink()
        self.backend.records[101] = self.backend.engine
        self.clock.value += recovery.IDLE_TTL + 1
        result = self.run_plan(plan)
        self.assertEqual(result["reason"], "guard_evidence_stale")
        self.assertFalse(self.backend.terminate_calls)

    def test_source_change_is_rejected_without_restarting(self):
        plan = self.plan()
        with patch.object(recovery, "clean_sources", return_value={"changed": True}):
            result = self.run_plan(plan)
        self.assertEqual(result["reason"], "future_launch_sources_changed")
        self.assertFalse(self.backend.terminate_calls)
        self.assertFalse(self.backend.launch_calls)

    def test_slow_precondition_check_cannot_use_stale_clock_to_authorize_quit(self):
        plan = self.plan()
        original = recovery.preconditions
        checks = []

        def slow_checks(*args, **kwargs):
            original(*args, **kwargs)
            checks.append(True)
            if len(checks) == 2:
                self.clock.value += recovery.IDLE_TTL

        with patch.object(recovery, "preconditions", side_effect=slow_checks):
            result = self.run_plan(plan)
        self.assertEqual(result["reason"], "guard_evidence_stale")
        self.assertFalse(result["graceful_termination_requested"])
        self.assertEqual(self.backend.terminate_calls, [])
        self.assertEqual(self.backend.launch_calls, [])

    def test_final_guard_read_uses_clock_after_file_io(self):
        plan = self.plan()
        original = recovery.read_json
        reads = []

        def slow_read(path):
            result = original(path)
            reads.append(str(path))
            self.clock.value += 61
            return result

        with patch.object(recovery, "read_json", side_effect=slow_read):
            with self.assertRaisesRegex(recovery.Blocked, "guard_evidence_stale"):
                recovery.final_quit_authorization(plan, self.clock.now)
        self.assertEqual(len(reads), 2)
        self.assertFalse(self.backend.terminate_calls)

    def test_changed_engine_file_is_rejected_before_quit(self):
        plan = self.plan()
        self.adhoc.write_text("different executable")
        result = self.run_plan(plan)
        self.assertEqual(result["reason"], "original_process_identity_changed")
        self.assertFalse(self.backend.terminate_calls)

    def test_refused_graceful_termination_preserves_application(self):
        self.backend.refuse_quit = True
        result = self.run_plan()
        self.assertEqual(result["reason"], "graceful_termination_not_accepted")
        self.assertTrue(self.backend.records.get(100))
        self.assertEqual(self.backend.launch_calls, [])
        self.assertFalse(result["force_termination_used"])

    def test_termination_deadline_never_forces_or_launches_duplicate(self):
        self.backend.hold_old = True
        result = self.run_plan()
        self.assertEqual(result["reason"], "graceful_termination_deadline_no_force_used")
        self.assertEqual(self.backend.terminate_calls, [100])
        self.assertEqual(self.backend.launch_calls, [])
        self.assertTrue(self.backend.records.get(101))

    def test_external_relaunch_is_verified_without_duplicate_launch(self):
        self.backend.external_relaunch = True
        result = self.run_plan()
        self.assertEqual(result["status"], "desktop_restart_verified")
        self.assertEqual(result["launch_attempts"], 0)
        self.assertEqual(self.backend.launch_calls, [])

    def test_exec_server_and_grandchild_cli_do_not_make_app_server_ambiguous(self):
        original = self.backend.new_instance

        def multiple_roles():
            original()
            self.backend.records[202] = dict(self.backend.new_engine, pid=202)
            self.backend.records[203] = dict(self.backend.new_engine, pid=203, ppid=201)

        self.backend.new_instance = multiple_roles
        result = self.run_plan()
        self.assertEqual(result["status"], "desktop_restart_verified")
        self.assertEqual(result["replacement"]["engine_pid"], 201)
        self.assertEqual(result["replacement"]["engine_process_role"], "app-server")

    def test_idle_evidence_aging_after_authorized_quit_does_not_strand_app(self):
        original = self.backend.terminate

        def slow_quit(pid):
            accepted = original(pid)
            self.clock.value += recovery.IDLE_TTL + 1
            return accepted

        self.backend.terminate = slow_quit
        result = self.run_plan()
        self.assertEqual(result["status"], "desktop_restart_verified")
        self.assertEqual(len(self.backend.launch_calls), 1)

    def test_scheduler_must_exit_before_mutation_can_start(self):
        plan = self.plan()
        receipt = recovery.receipt_base(plan)
        recovery.create_private(self.receipt, receipt)
        parent_pids = iter((555, 555, 1))
        recovery.wait_scheduler_exit(555, receipt, self.receipt, parent_pid=lambda: next(parent_pids),
                                     monotonic=self.clock.now, sleep=self.clock.sleep)
        self.assertTrue(receipt["scheduler_parent_exited"])
        self.assertEqual(receipt["stage"], "scheduler_parent_exit_confirmed")
        self.assertFalse(self.backend.terminate_calls)
        with self.assertRaisesRegex(recovery.Blocked, "scheduler_still_present_no_restart"):
            recovery.wait_scheduler_exit(555, receipt, self.receipt, parent_pid=lambda: 555,
                                         monotonic=self.clock.now, sleep=self.clock.sleep)

    def test_ambiguous_launch_result_never_retries_even_if_app_exists(self):
        self.backend.launch_returns_none = True
        result = self.run_plan()
        self.assertEqual(result["reason"], "official_launch_result_unconfirmed")
        self.assertEqual(result["launch_attempts"], 1)
        self.assertEqual(len(self.backend.launch_calls), 1)
        self.assertFalse(result["native_authentication_recovered"])

    def test_unexpected_failure_after_completed_quit_attempts_one_safe_official_launch(self):
        original = self.backend.terminate

        def error_after_quit(pid):
            original(pid)
            raise OSError("PRIVATE_OPERATING_SYSTEM_ERROR")

        self.backend.terminate = error_after_quit
        result = self.run_plan()
        self.assertEqual(result["reason"], "lifecycle_operation_unconfirmed")
        self.assertTrue(result["bounded_official_launch_attempted_on_failure"])
        self.assertEqual(len(self.backend.launch_calls), 1)
        self.assertFalse(result["native_authentication_recovered"])
        self.assertNotIn("PRIVATE_OPERATING_SYSTEM_ERROR", json.dumps(result))

    def test_os_error_after_launch_attempt_never_launches_again(self):
        original = self.backend.launch

        def error_after_launch(path):
            original(path)
            raise OSError("PRIVATE_LAUNCH_ERROR")

        self.backend.launch = error_after_launch
        result = self.run_plan()
        self.assertEqual(result["reason"], "lifecycle_operation_unconfirmed")
        self.assertEqual(result["launch_attempts"], 1)
        self.assertEqual(len(self.backend.launch_calls), 1)
        self.assertFalse(result["bounded_official_launch_attempted_on_failure"])

    def test_absent_new_engine_times_out_without_second_launch(self):
        self.backend.no_new_engine = True
        result = self.run_plan()
        self.assertEqual(result["reason"], "replacement_engine_deadline_connection_unverified")
        self.assertEqual(len(self.backend.launch_calls), 1)
        self.assertEqual(result["current_connection"], "unverified")

    def test_engine_replaced_during_signing_is_observed_again_without_relaunch(self):
        signed_pids = []
        self.backend.is_app_server = lambda record: record["pid"] in (101, 201, 202)

        def replace_first_engine(path):
            signed_pids.append(next(record["pid"] for record in self.backend.records.values()
                                    if record["ppid"] == 200))
            if len(signed_pids) == 1:
                self.backend.records.pop(201)
                self.backend.records[202] = dict(self.backend.new_engine, pid=202, start_seconds=1007)
            return self.runtime["cli"]

        with patch.object(recovery, "verified_binary", side_effect=replace_first_engine):
            result = self.run_plan()
        self.assertEqual(result["status"], "desktop_restart_verified")
        self.assertEqual(result["replacement"]["engine_pid"], 202)
        self.assertEqual(signed_pids, [201, 202])
        self.assertEqual(self.backend.terminate_calls, [100])
        self.assertEqual(self.backend.launch_calls, [self.runtime["app_path"]])
        self.assertEqual(result["launch_attempts"], 1)
        self.assertFalse(result["native_authentication_recovered"])

    def test_continuously_replaced_engine_exhausts_original_deadline_without_relaunch(self):
        signed_pids = []
        self.backend.is_app_server = lambda record: record["pid"] == 101 or record["pid"] >= 201

        def replace_each_engine(path):
            engine = next(record for record in self.backend.records.values() if record["ppid"] == 200)
            signed_pids.append(engine["pid"])
            self.backend.records.pop(engine["pid"])
            self.backend.records[engine["pid"] + 1] = dict(engine, pid=engine["pid"] + 1,
                                                         start_seconds=engine["start_seconds"] + 1)
            return self.runtime["cli"]

        plan = self.plan()
        started_at = self.clock.now()
        with patch.object(recovery, "verified_binary", side_effect=replace_each_engine):
            result = self.run_plan(plan)
        self.assertEqual(result["status"], "restart_not_verified")
        self.assertEqual(result["reason"], "replacement_engine_deadline_connection_unverified")
        self.assertGreater(len(signed_pids), 1)
        self.assertEqual(self.clock.now(), started_at + plan["delay_seconds"] + plan["launch_timeout_seconds"])
        self.assertEqual(self.backend.terminate_calls, [100])
        self.assertEqual(self.backend.launch_calls, [self.runtime["app_path"]])
        self.assertEqual(result["launch_attempts"], 1)
        self.assertEqual(result["current_connection"], "unverified")
        self.assertFalse(result["native_authentication_recovered"])

    def test_conflicting_engine_identity_during_signing_remains_fatal(self):
        for changes in ({"executable": str(self.adhoc)}, {"uid": os.getuid() + 1},
                        {"ppid": 100}, {"pid": 201, "start_seconds": 1007, "role": "exec-server"}):
            with self.subTest(changes=changes):
                self.backend = LifecycleFixture(self.runtime, self.adhoc)
                self.backend.is_app_server = lambda record: record.get("role") != "exec-server"

                def change_engine(path):
                    replacement = dict(self.backend.new_engine, start_seconds=1007)
                    replacement.update(changes)
                    self.backend.records[201] = replacement
                    return self.runtime["cli"]

                with patch.object(recovery, "verified_binary", side_effect=change_engine) as signing:
                    result = self.run_plan()
                self.assertEqual(result["reason"], "replacement_process_changed_during_verification")
                self.assertEqual(signing.call_count, 1)
                self.assertEqual(self.backend.terminate_calls, [100])
                self.assertEqual(self.backend.launch_calls, [self.runtime["app_path"]])
                self.receipt.unlink()

    def test_replacement_signature_failure_cannot_report_success(self):
        with patch.object(recovery, "verified_binary", side_effect=recovery.Blocked("official_signing_not_confirmed")):
            result = self.run_plan()
        self.assertEqual(result["status"], "restart_not_verified")
        self.assertEqual(result["reason"], "official_signing_not_confirmed")
        self.assertEqual(len(self.backend.launch_calls), 1)

    def test_private_file_symlink_and_permission_checks(self):
        link = self.root / "checkpoint-link"
        link.symlink_to(self.checkpoint)
        with self.assertRaises(recovery.Blocked):
            recovery.read_json(link)
        self.checkpoint.chmod(0o644)
        with self.assertRaises(recovery.Blocked):
            recovery.read_json(self.checkpoint)
        self.assertFalse(self.backend.terminate_calls)

    def test_future_launch_override_is_read_only_and_valid_official_value_preserved(self):
        self.sources_patch.stop()
        for stdout, present in ((b"", False), ((str(self.cli) + "\n").encode(), True)):
            completed = type("Result", (), {"returncode": 0, "stdout": stdout})()
            with patch.object(recovery.subprocess, "run", return_value=completed) as run:
                result = recovery.clean_sources(str(self.cli))
            self.assertEqual(result["launchctl"]["override_present"], present)
            self.assertEqual(run.call_args[0][0], ["/bin/launchctl", "getenv", "CODEX_CLI_PATH"])
            self.assertNotIn(str(self.cli), json.dumps(result))
        completed = type("Result", (), {"returncode": 0, "stdout": str(self.adhoc).encode()})()
        with patch.object(recovery.subprocess, "run", return_value=completed):
            with self.assertRaisesRegex(recovery.Blocked, "future_launch_override_not_official"):
                recovery.clean_sources(str(self.cli))

    def test_selected_config_requires_absent_or_official_scalar_override(self):
        config = self.root / "config.toml"
        config.write_text('[mcp_servers.computer-use.env]\nCODEX_CLI_PATH = ' + json.dumps(str(self.cli)) + '\n# PRIVATE_CONFIG_NOTE\n')
        result = recovery.config_source(config, str(self.cli))
        self.assertTrue(result["overrides_absent_or_official"])
        self.assertEqual(result["override_count"], 1)
        self.assertNotIn("PRIVATE_CONFIG_NOTE", json.dumps(result))
        for text in ('CODEX_CLI_PATH = "relative"\n', 'env = { CODEX_CLI_PATH = "' + str(self.cli) + '" }\n'):
            config.write_text(text)
            with self.assertRaises(recovery.Blocked):
                recovery.config_source(config, str(self.cli))

    def test_known_cli_role_detection_never_returns_argument_values(self):
        backend = object.__new__(recovery.MacLifecycle)
        record = {"pid": 201, "executable": "/official path/codex"}
        for role, expected in (("app-server", True), ("exec-server", False)):
            result = type("Result", (), {"returncode": 0,
                "stdout": (record["executable"] + " " + role + " --private-token SECRET_VALUE").encode()})()
            with patch.object(recovery.subprocess, "run", return_value=result) as run:
                self.assertIs(backend.is_app_server(record), expected)
                self.assertEqual(run.call_args[0][0], ["/bin/ps", "-p", "201", "-o", "args="])

    def test_optional_continuation_is_pinned_same_chat_plain_queue_only(self):
        message = self.root / "resume.txt"
        message.write_text("PRIVATE_RESUME_BODY")
        message.chmod(0o600)
        plan = recovery.make_plan(self.runtime["app_path"], 100, 101, self.checkpoint, self.idle, THREAD,
                                  self.receipt, True, now=self.clock.now(), backend=self.backend, resume_message_file=message)
        self.assertNotIn("PRIVATE_RESUME_BODY", json.dumps(plan))
        completed = type("Result", (), {"returncode": 0})()
        with patch.object(recovery.subprocess, "run", return_value=completed) as run:
            result = self.run_plan(plan)
        command = run.call_args[0][0]
        self.assertEqual(command, [str(self.cli), "queue", "--thread", THREAD, "--message", "PRIVATE_RESUME_BODY"])
        self.assertNotIn("--resume", command)
        self.assertEqual(self.backend.opened_thread, (THREAD, self.runtime["app_path"]))
        self.assertEqual(result["status"], "desktop_restart_verified")
        self.assertEqual(result["continuation_status"], "queued_awaiting_native_verification")
        self.assertFalse(result["queued_message_processing_confirmed"])
        self.assertFalse(result["native_authentication_recovered"])
        self.assertNotIn("PRIVATE_RESUME_BODY", json.dumps(result))

    def test_changed_or_large_resume_message_is_rejected_without_quit(self):
        message = self.root / "resume.txt"
        message.write_bytes(b"x" * 8193)
        message.chmod(0o600)
        with self.assertRaises(recovery.Blocked):
            recovery.continuation_file(message)
        message.write_text("original")
        plan = recovery.make_plan(self.runtime["app_path"], 100, 101, self.checkpoint, self.idle, THREAD,
                                  self.receipt, True, now=self.clock.now(), backend=self.backend, resume_message_file=message)
        message.write_text("changed")
        result = self.run_plan(plan)
        self.assertEqual(result["reason"], "resume_message_changed")
        self.assertFalse(self.backend.terminate_calls)

    def test_scheduler_requires_detached_ready_handshake_and_scrubs_child_override_only(self):
        plan = self.plan()
        path = self.root / "plan.json"
        recovery.create_private(path, plan)
        captured = {}

        def popen(command, **kwargs):
            captured.update(kwargs)
            self.assertEqual(stat.S_IMODE(os.fstat(kwargs["stdout"].fileno()).st_mode), 0o600)
            receipt, unused = recovery.read_json(self.receipt)
            recovery.stage(receipt, self.receipt, "worker_ready", self.clock.now(), worker_pid=999, detached_session_confirmed=True)
            return type("Child", (), {"pid": 999, "poll": lambda self: None})()

        with patch.object(recovery, "MacLifecycle", return_value=self.backend), \
             patch.object(recovery.time, "time", side_effect=self.clock.now), \
             patch.object(recovery.subprocess, "Popen", side_effect=popen), \
             patch.dict(os.environ, {"CODEX_CLI_PATH": "PRIVATE_STALE_PARENT_OVERRIDE"}):
            result = recovery.schedule(path)
            self.assertEqual(os.environ["CODEX_CLI_PATH"], "PRIVATE_STALE_PARENT_OVERRIDE")
        self.assertTrue(captured["start_new_session"])
        self.assertTrue(captured["close_fds"])
        self.assertNotIn("CODEX_CLI_PATH", captured["env"])
        self.assertTrue(Path(str(path) + ".go").is_file())
        self.assertEqual(result["status"], "restart_scheduled")
        self.assertNotIn("PRIVATE_STALE_PARENT_OVERRIDE", json.dumps(result))
        self.assertFalse(self.backend.terminate_calls)

    def test_worker_preflight_os_error_records_unverified_failure_without_quit(self):
        plan = self.plan()
        path = self.root / "worker-plan.json"
        recovery.create_private(path, plan)
        plan_sha = recovery.sha(path.read_bytes())
        recovery.create_private(str(path) + ".claim", {"claim_id": "test-claim", "plan_sha256": plan_sha, "scheduler_pid": 555})
        recovery.create_private(self.receipt, recovery.receipt_base(plan))
        with patch.object(recovery, "MacLifecycle", return_value=self.backend), \
             patch.object(recovery.time, "time", side_effect=self.clock.now), \
             patch.object(recovery.os, "getppid", return_value=555), \
             patch.object(recovery, "preconditions", side_effect=OSError("PRIVATE_PREFLIGHT_ERROR")):
            exit_code = recovery.worker(path, plan_sha, "test-claim")
        result, unused = recovery.read_json(self.receipt)
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["reason"], "lifecycle_operation_unconfirmed")
        self.assertFalse(result["native_authentication_recovered"])
        self.assertNotIn("PRIVATE_PREFLIGHT_ERROR", json.dumps(result))
        self.assertEqual(self.backend.terminate_calls, [])
        self.assertEqual(self.backend.launch_calls, [])


if __name__ == "__main__":
    unittest.main()
