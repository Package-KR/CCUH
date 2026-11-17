"""Fixture-only runtime coverage; no signing or real model turn is executed."""
import importlib.util
import json
import os
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("ccuh_runtime_preflight", ROOT / "lab/runtime_preflight.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class Sidecars(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ccuh-runtime-unit-", dir="/private/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / "Official.app"
        self.official = self.app / runtime.CLI_RELATIVE
        self.write_executable(self.official, b"official-cli")
        self.work = self.root / "candidate-work"
        # Production requires a direct /private/tmp private boundary.
        self.work_temp = tempfile.TemporaryDirectory(prefix="ccuh-runtime-unit-candidate-", dir="/private/tmp")
        self.addCleanup(self.work_temp.cleanup)
        self.work = Path(self.work_temp.name)
        self.candidate = self.work / "CodexCLI.app/Contents/MacOS/codex"
        self.write_executable(self.candidate, b"adhoc-cli")
        self.data = {"app_path": str(self.app), "cli": {"path": str(self.official)}}
        for name in runtime.SIDECARS:
            self.write_executable(self.source(name), ("signed-image-" + name).encode())
        self.signature = patch.object(runtime, "_signature", side_effect=self.fake_signature)
        self.signature.start()
        self.addCleanup(self.signature.stop)
        self.no_commands = patch.object(runtime.subprocess, "run", side_effect=AssertionError("real subprocess forbidden"))
        self.no_commands.start()
        self.addCleanup(self.no_commands.stop)
        self.no_children = patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("real child forbidden"))
        self.no_children.start()
        self.addCleanup(self.no_children.stop)

    def write_executable(self, path, contents):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
        path.chmod(0o755)

    def source(self, name):
        return self.app / "Contents/Resources/codex-cli/bin" / name

    def fake_signature(self, path, name):
        return {"identifier": name, "team_identifier": runtime.TEAM,
                "cdhash": "a" * 40, "strict_verification_confirmed": True}

    def assert_blocked(self, code, function, *args):
        with self.assertRaises(runtime.Blocked) as caught:
            function(*args)
        self.assertEqual(caught.exception.code, code)

    def test_copy_keeps_both_embedded_images_identical_and_validation_is_read_only(self):
        originals = {name: self.source(name).read_bytes() for name in runtime.SIDECARS}
        evidence = runtime.copy_sidecars(self.data, self.candidate)
        for name in runtime.SIDECARS:
            self.assertEqual((self.candidate.parent / name).read_bytes(), originals[name])
            self.assertEqual(self.source(name).read_bytes(), originals[name])
        self.assertEqual(runtime.validate_sidecars(self.data, self.candidate, evidence), evidence)
        self.assertEqual(len(evidence["hosts"]), 2)

    def test_missing_source_blocks_before_any_host_is_copied(self):
        self.source(runtime.SIDECARS[1]).unlink()
        self.assert_blocked("runtime_sidecar_copy_unconfirmed", runtime.copy_sidecars, self.data, self.candidate)
        self.assertFalse((self.candidate.parent / runtime.SIDECARS[0]).exists())

    def test_existing_target_and_target_symlink_are_never_overwritten(self):
        target = self.candidate.parent / runtime.SIDECARS[0]
        target.symlink_to(self.source(runtime.SIDECARS[0]))
        self.assert_blocked("runtime_sidecar_destination_exists", runtime.copy_sidecars, self.data, self.candidate)
        self.assertTrue(target.is_symlink())

    def test_source_symlink_is_rejected(self):
        source = self.source(runtime.SIDECARS[0])
        actual = source.with_name("actual-image")
        source.rename(actual)
        source.symlink_to(actual)
        self.assert_blocked("runtime_owned_regular_executable_required", runtime.copy_sidecars, self.data, self.candidate)

    def test_nonprivate_workspace_and_symlink_parent_are_rejected(self):
        self.work.chmod(0o755)
        self.assert_blocked("runtime_private_workspace_required", runtime.copy_sidecars, self.data, self.candidate)
        self.work.chmod(0o700)
        candidate_bundle = self.work / "CodexCLI.app"
        actual = self.work / "Actual.app"
        candidate_bundle.rename(actual)
        candidate_bundle.symlink_to(actual)
        self.assert_blocked("runtime_candidate_path_unconfirmed", runtime.copy_sidecars, self.data, self.candidate)

    def test_group_writable_source_is_rejected(self):
        self.source(runtime.SIDECARS[0]).chmod(0o775)
        self.assert_blocked("runtime_owned_regular_executable_required", runtime.copy_sidecars, self.data, self.candidate)

    def test_source_or_candidate_change_invalidates_pinned_evidence(self):
        evidence = runtime.copy_sidecars(self.data, self.candidate)
        target = self.candidate.parent / runtime.SIDECARS[0]
        target.write_bytes(b"changed signed image")
        self.assert_blocked("runtime_sidecar_copy_not_identical", runtime.validate_sidecars, self.data, self.candidate, evidence)

    def test_equal_byte_replacement_still_invalidates_file_identity(self):
        evidence = runtime.copy_sidecars(self.data, self.candidate)
        target = self.candidate.parent / runtime.SIDECARS[0]
        replacement = target.with_name("replacement")
        self.write_executable(replacement, target.read_bytes())
        replacement.replace(target)
        self.assert_blocked("runtime_sidecar_evidence_changed", runtime.validate_sidecars, self.data, self.candidate, evidence)

    def completed_event(self, marker, **changes):
        item = {"type": "code_mode_tool_call", "status": "completed",
                "code": 'text("' + marker + '"); await tools.exec_command({cmd:"/usr/bin/true"});',
                "output": json.dumps({"ccuh_runtime_preflight": marker, "nested_exit_code": 0})}
        item.update(changes)
        return {"type": "item.completed", "item": item}

    def test_actual_tool_event_and_nested_success_are_required(self):
        marker = "marker"
        raw = json.dumps(self.completed_event(marker)).encode()
        self.assertTrue(runtime.analyze_preflight_events(raw, marker)["code_mode_and_nested_exec_confirmed"])
        bad_exit = json.dumps(self.completed_event(marker, output=json.dumps({"ccuh_runtime_preflight": marker, "nested_exit_code": 1}))).encode()
        self.assertFalse(runtime.analyze_preflight_events(bad_exit, marker)["code_mode_and_nested_exec_confirmed"])
        final_echo = json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": raw.decode()}}).encode()
        self.assertFalse(runtime.analyze_preflight_events(final_echo, marker)["code_mode_and_nested_exec_confirmed"])

    def test_started_call_and_direct_shell_marker_are_unconfirmed(self):
        event = self.completed_event("marker")
        event["type"] = "item.started"
        self.assertFalse(runtime.analyze_preflight_events(json.dumps(event).encode(), "marker")["code_mode_and_nested_exec_confirmed"])
        event["type"] = "item.completed"
        event["item"]["type"] = "command_execution"
        self.assertFalse(runtime.analyze_preflight_events(json.dumps(event).encode(), "marker")["code_mode_and_nested_exec_confirmed"])

    def test_opt_in_diagnostic_exposes_only_error_excerpt_and_event_schema(self):
        events = [{"type": "item.completed", "item": {"type": "agent_message", "text": "private agent prose"}},
                  {"type": "item.completed", "item": {"type": "command_execution", "command": "/usr/bin/true",
                                                         "aggregated_output": "private output", "exit_code": 0}},
                  {"type": "item.completed", "item": {"type": "error", "message": "functions.exec namespace unavailable at /Users/example/config"}}]
        raw = "\n".join(json.dumps(event) for event in events).encode()
        basic = runtime.analyze_preflight_events(raw, "marker")
        self.assertNotIn("diagnostic_items", basic)
        diagnostic = runtime.analyze_preflight_events(raw, "marker", diagnostic=True)
        encoded = json.dumps(diagnostic)
        self.assertNotIn("private agent prose", encoded)
        self.assertNotIn("private output", encoded)
        self.assertNotIn("/Users/example", encoded)
        self.assertIn("functions.exec namespace unavailable", encoded)
        self.assertTrue(diagnostic["diagnostic_items"][1]["command_is_exact_true"])
        self.assertFalse(diagnostic["code_mode_and_nested_exec_confirmed"])

    def test_public_command_is_ephemeral_read_only_and_inherits_model(self):
        command = runtime.build_preflight_command(self.candidate, self.work)
        self.assertIn("--ephemeral", command)
        self.assertIn("read-only", command)
        self.assertIn("code_mode", command)
        self.assertIn("code_mode_only", command)
        self.assertNotIn("--model", command)
        self.assertNotIn("-m", command)
        self.assertNotIn("--trust", command)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", command)

    def test_preflight_returns_only_sanitized_confirmed_proof_and_rechecks_hosts(self):
        evidence = runtime.copy_sidecars(self.data, self.candidate)
        def run(command, prompt, environment, cwd, timeout, candidate, host, auditor):
            marker = "ccuh-runtime-" + "b" * 32
            self.assertEqual(environment["CODEX_CLI_PATH"], str(self.candidate))
            self.assertIn(marker.encode(), prompt)
            event = self.command_event(marker)
            return subprocess.CompletedProcess(command, 0, json.dumps(event).encode(), b""), self.record(100, 1, self.candidate), [self.record(101, 100, self.candidate.parent / runtime.SIDECARS[0])]
        with patch.object(runtime.uuid, "uuid4", return_value=type("ID", (), {"hex": "b" * 32})()), patch.object(runtime, "_run_observed", side_effect=run):
            result = runtime.runtime_preflight(self.data, self.candidate, evidence, process_auditor=object())
        self.assertTrue(result["sidecars_revalidated"])
        self.assertTrue(result["code_mode_and_nested_exec_confirmed"])
        self.assertFalse(result["raw_response_saved"])
        self.assertNotIn("marker", result)

    def test_timeout_is_unknown_and_blocks_injection(self):
        evidence = runtime.copy_sidecars(self.data, self.candidate)
        with patch.object(runtime, "_run_observed", side_effect=runtime.Blocked("runtime_preflight_timeout", {"operation_outcome": "unknown"})):
            with self.assertRaises(runtime.Blocked) as caught:
                runtime.runtime_preflight(self.data, self.candidate, evidence, timeout=1, process_auditor=object())
        self.assertEqual(caught.exception.code, "runtime_preflight_timeout")
        self.assertEqual(caught.exception.details["operation_outcome"], "unknown")

    def record(self, pid, ppid, executable, **changes):
        record = {"pid": pid, "ppid": ppid, "uid": os.getuid(), "start_seconds": 1000 + pid,
                  "start_microseconds": 1, "executable": str(executable)}
        record.update(changes)
        return record

    def command_event(self, marker, **changes):
        expected = runtime.build_nested_command(marker)
        item = {"type": "command_execution", "status": "completed", "exit_code": 0,
                "command": shlex.join(["/bin/zsh", "-c", expected]),
                "aggregated_output": json.dumps({"ccuh_runtime_preflight": marker, "nested_exit_code": 0})}
        item.update(changes)
        return {"type": "item.completed", "item": item}

    def test_exact_child_command_and_success_output_are_separate_required_proof(self):
        expected = runtime.build_nested_command("marker")
        event = self.command_event("marker")
        proof = runtime.analyze_preflight_events(json.dumps(event).encode(), "marker", expected_command=expected)
        self.assertTrue(proof["nested_command_proof_confirmed"])
        self.assertFalse(proof["code_mode_and_nested_exec_confirmed"])
        for changes in ({"command": expected + "; echo extra"}, {"exit_code": 1},
                        {"aggregated_output": "done"}, {"status": "in_progress"}):
            with self.subTest(changes=changes):
                event = self.command_event("marker", **changes)
                self.assertFalse(runtime.analyze_preflight_events(json.dumps(event).encode(), "marker", expected_command=expected)["nested_command_proof_confirmed"])

    def test_only_known_development_warning_is_nonfatal(self):
        warning = {"type": "item.completed", "item": {"type": "error", "message": "Under-development features enabled: code_mode, code_mode_only. Under-development features are incomplete."}}
        result = runtime.analyze_preflight_events(json.dumps(warning).encode(), "marker")
        self.assertEqual(result["known_feature_warning_count"], 1)
        self.assertEqual(result["unrecognized_error_item_count"], 0)
        warning["item"]["message"] = "failed to start code-mode-host"
        result = runtime.analyze_preflight_events(json.dumps(warning).encode(), "marker")
        self.assertEqual(result["unrecognized_error_item_count"], 1)

    def test_exact_command_without_selected_code_host_cannot_pass_runtime_preflight(self):
        evidence = runtime.copy_sidecars(self.data, self.candidate)
        marker = "ccuh-runtime-" + "b" * 32
        result = subprocess.CompletedProcess([], 0, json.dumps(self.command_event(marker)).encode(), b"")
        with patch.object(runtime.uuid, "uuid4", return_value=type("ID", (), {"hex": "b" * 32})()), patch.object(runtime, "_run_observed", return_value=(result, self.record(100, 1, self.candidate), [])):
            with self.assertRaises(runtime.Blocked) as caught:
                runtime.runtime_preflight(self.data, self.candidate, evidence, process_auditor=object())
        self.assertFalse(caught.exception.details["code_mode_and_nested_exec_confirmed"])
        self.assertTrue(caught.exception.details["nested_command_proof_confirmed"])

    def test_selected_host_observation_requires_exact_binary_ancestry_and_start(self):
        evidence = runtime.copy_sidecars(self.data, self.candidate)
        pinned = evidence["hosts"][0]["candidate"]
        root = self.record(100, 1, self.candidate)
        host = self.record(101, 100, pinned["path"])
        class Auditor:
            def process(self, pid):
                return root if pid == 100 else host
            def descendants(self, pid):
                self.selected_pid = pid
                return [host]
        auditor = Auditor()
        observed = []
        self.assertEqual(runtime._observe_hosts(auditor, 100, self.candidate, None, pinned, observed), root)
        self.assertEqual(auditor.selected_pid, 100)
        self.assertEqual(observed[0]["binary_sha256"], pinned["sha256"])
        host["ppid"] = 999
        self.assert_blocked("runtime_preflight_host_ancestry_unconfirmed", runtime._observe_hosts,
                            auditor, 100, self.candidate, root, pinned, [])
        host["ppid"] = 100
        host["start_seconds"] = 1
        self.assert_blocked("runtime_preflight_host_predates_candidate", runtime._observe_hosts,
                            auditor, 100, self.candidate, root, pinned, [])

    def test_popen_polling_observes_only_own_selected_descendants(self):
        evidence = runtime.copy_sidecars(self.data, self.candidate)
        pinned = evidence["hosts"][0]["candidate"]
        root = self.record(100, 1, self.candidate)
        host = self.record(101, 100, pinned["path"])
        class Auditor:
            def process(self, pid):
                return root if pid == 100 else host
            def descendants(self, pid):
                if pid != 100:
                    raise AssertionError("unselected process inventory")
                return [host]
        class Child:
            pid = 100
            returncode = None
            attempts = 0
            def communicate(self, input=None, timeout=None):
                self.attempts += 1
                if self.attempts == 1:
                    raise subprocess.TimeoutExpired("fixture", timeout)
                self.returncode = 0
                return b"{}", b""
            def poll(self):
                return self.returncode
        with patch.object(runtime.subprocess, "Popen", return_value=Child()):
            completed, root_observed, hosts = runtime._run_observed([], b"prompt", {}, str(self.work), 2,
                                                                  self.candidate, pinned, Auditor())
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(root_observed, root)
        self.assertEqual(len(hosts), 1)

    def test_signature_failure_is_unconfirmed_even_with_team_metadata(self):
        self.signature.stop()
        metadata = b"Identifier=codex-code-mode-host\nTeamIdentifier=2DC432GLL2\nCDHash=" + b"a" * 40 + b"\n"
        results = [subprocess.CompletedProcess([], 1, b"", b"invalid signature"),
                   subprocess.CompletedProcess([], 0, b"", metadata)]
        with patch.object(runtime.subprocess, "run", side_effect=results):
            self.assert_blocked("runtime_official_sidecar_signature_unconfirmed", runtime._signature,
                                self.source(runtime.SIDECARS[0]), runtime.SIDECARS[0])


if __name__ == "__main__":
    unittest.main()
