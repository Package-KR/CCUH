import importlib.util
import io
import json
import os
import plistlib
import stat
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "skills/ccuh-doctor/scripts/recovery.py"
SPEC = importlib.util.spec_from_file_location("ccuh_recovery", SCRIPT)
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)
VERIFIED = {"verified": True, "binary_exists": True, "signing_team_matches": True, "binary_sha256": "fixture-digest"}


class RecoveryFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "Fixture.app"
        self.binary = self.app / recovery.OFFICIAL_RELATIVE
        self.binary.parent.mkdir(parents=True)
        self.binary.write_text("fixture-not-an-official-runtime")
        self.env_file = self.root / "launcher.json"
        self.missing = str(self.root / "missing-codex")
        self.original = {"KEEP": "unrelated-fixture-value", recovery.KEY: self.missing}
        self.env_file.write_text(json.dumps(self.original))
        self.store = recovery.Store("file", self.env_file)
        self.plan_file = self.root / "plan.json"
        self.backup_file = self.root / "backup.json"

    def save_plan(self, category=None):
        with patch.object(recovery, "runtime_evidence", return_value=VERIFIED):
            plan = recovery.make_plan(self.store, self.app, category)
        recovery.private_create(self.plan_file, plan)
        return plan

    def apply(self, category=None):
        with patch.object(recovery, "runtime_evidence", return_value=VERIFIED):
            return recovery.apply_plan(self.plan_file, self.backup_file, category)

    def test_actual_fixture_edit_preserves_unrelated_keys_and_restores(self):
        process_override_before = os.environ.get(recovery.KEY)
        self.assertEqual(self.save_plan()["status"], "repair_available")
        report = self.apply()
        self.assertEqual(report["status"], "repair_applied")
        self.assertEqual(json.loads(self.env_file.read_text()), {"KEEP": self.original["KEEP"]})
        self.assertEqual(stat.S_IMODE(self.backup_file.stat().st_mode), 0o600)
        self.assertFalse(report["native_authentication_recovered"])
        self.assertFalse(report["current_process_environment_changed"])
        self.assertNotIn(self.missing, json.dumps(report))
        restored = recovery.restore_backup(self.backup_file)
        self.assertEqual(restored["status"], "restore_applied")
        self.assertEqual(json.loads(self.env_file.read_text()), self.original)
        self.assertEqual(os.environ.get(recovery.KEY), process_override_before)

    def test_existing_official_override_is_preserved(self):
        self.env_file.write_text(json.dumps({recovery.KEY: str(self.binary)}))
        plan = self.save_plan()
        self.assertEqual(plan["status"], "no_change")
        self.assertEqual(plan["reason"], "official_override_preserved")
        with self.assertRaises(recovery.RecoveryError):
            self.apply()
        self.assertFalse(self.backup_file.exists())
        self.assertEqual(self.store.snapshot()["value"], str(self.binary))

    def test_existing_custom_override_is_preserved(self):
        custom = self.root / "custom-cli"
        custom.touch()
        self.env_file.write_text(json.dumps({recovery.KEY: str(custom)}))
        self.assertEqual(self.save_plan()["reason"], "existing_override_preserved")

    def test_relative_override_is_not_assumed_missing(self):
        self.env_file.write_text(json.dumps({recovery.KEY: "relative/codex"}))
        self.assertEqual(self.save_plan()["reason"], "ambiguous_override_preserved")

    def test_symlink_loop_override_is_preserved_as_unconfirmed(self):
        loop = self.root / "loop"
        loop.symlink_to(loop)
        self.env_file.write_text(json.dumps({recovery.KEY: str(loop)}))
        self.assertEqual(self.save_plan()["reason"], "override_path_unconfirmed_preserved")

    def test_absent_override_is_no_change(self):
        self.env_file.write_text("{}")
        self.assertEqual(self.save_plan()["reason"], "no_override")

    def test_unconfirmed_runtime_blocks_plan(self):
        with patch.object(recovery, "runtime_evidence", return_value={"verified": False}):
            plan = recovery.make_plan(self.store, self.app)
        self.assertEqual(plan["status"], "blocked")
        self.assertEqual(plan["reason"], "runtime_verification_unconfirmed")

    def test_unknown_operation_blocks_planning_and_applying_without_changes(self):
        for category in ("timeout", "operation_unresolved"):
            with self.subTest(category=category):
                with patch.object(recovery, "runtime_evidence", return_value=VERIFIED):
                    blocked_plan = recovery.make_plan(self.store, self.app, category)
                self.assertEqual(blocked_plan["reason"], "operation_completion_unconfirmed")
        self.save_plan()
        before = self.env_file.read_bytes()
        for category in ("timeout", "operation_unresolved"):
            with self.subTest(category=category):
                with self.assertRaises(recovery.RecoveryError) as caught:
                    self.apply(category)
                self.assertEqual(caught.exception.code, "operation_or_diagnostic_blocks_apply")
                self.assertEqual(self.env_file.read_bytes(), before)
                self.assertFalse(self.backup_file.exists())

    def test_authentication_failure_is_not_repaired_by_unsetting_override(self):
        plan = self.save_plan("authentication_failed")
        self.assertEqual(plan["status"], "blocked")
        with self.assertRaises(recovery.RecoveryError):
            self.apply()
        self.assertEqual(self.store.snapshot()["value"], self.missing)

    def test_changed_source_prevents_stale_plan_apply(self):
        self.save_plan()
        self.env_file.write_text(json.dumps({**self.original, "OTHER": "new"}))
        with self.assertRaises(recovery.RecoveryError) as caught:
            self.apply()
        self.assertEqual(caught.exception.code, "source_changed")
        self.assertFalse(self.backup_file.exists())

    def test_override_becomes_existing_after_plan_so_it_is_preserved(self):
        self.save_plan()
        Path(self.missing).touch()
        with self.assertRaises(recovery.RecoveryError) as caught:
            self.apply()
        self.assertEqual(caught.exception.code, "override_must_be_preserved")
        self.assertEqual(self.store.snapshot()["value"], self.missing)

    def test_runtime_change_prevents_apply(self):
        self.save_plan()
        with patch.object(recovery, "runtime_evidence", return_value={**VERIFIED, "binary_sha256": "changed"}):
            with self.assertRaises(recovery.RecoveryError):
                recovery.apply_plan(self.plan_file, self.backup_file)
        self.assertFalse(self.backup_file.exists())

    def test_existing_backup_is_not_overwritten(self):
        self.save_plan()
        self.backup_file.write_text("keep this backup")
        with self.assertRaises(FileExistsError):
            self.apply()
        self.assertEqual(self.store.snapshot()["value"], self.missing)
        self.assertEqual(self.backup_file.read_text(), "keep this backup")

    def test_restore_does_not_overwrite_later_environment_edits(self):
        self.save_plan()
        self.apply()
        self.env_file.write_text(json.dumps({"KEEP": "later change"}))
        with self.assertRaises(recovery.RecoveryError) as caught:
            recovery.restore_backup(self.backup_file)
        self.assertEqual(caught.exception.code, "restore_source_changed")

    def test_symlink_fixture_is_rejected(self):
        link = self.root / "symlink.json"
        link.symlink_to(self.env_file)
        with self.assertRaises(recovery.RecoveryError):
            recovery.Store("file", link).snapshot()

    def test_startup_drill_executes_missing_path_then_mock_official_version(self):
        # Real child processes; mock trust evidence only. This is not live
        # official-runtime verification (the separate recorded drill is).
        self.binary.write_text("#!/bin/sh\nprintf 'codex-cli 0.0.0-fixture\\n'\n")
        self.binary.chmod(0o700)
        with patch.object(recovery, "runtime_evidence", return_value=VERIFIED):
            report = recovery.startup_drill(self.store, self.app, self.plan_file, self.backup_file)
        self.assertEqual(report["before"]["errno"], "ENOENT")
        self.assertEqual(report["after"]["exit_code"], 0)
        self.assertEqual(report["after"]["version"], "codex-cli 0.0.0-fixture")
        self.assertEqual(report["status"], "startup_recovered")
        self.assertEqual(report["scope"], "isolated_child_process_startup")
        self.assertFalse(report["native_authentication_recovered"])
        recovery.restore_backup(self.backup_file)
        self.assertEqual(json.loads(self.env_file.read_text()), self.original)

    def test_timed_out_startup_has_unknown_outcome(self):
        with patch.object(recovery.subprocess, "run", side_effect=subprocess.TimeoutExpired("fixture", 15)):
            outcome = recovery.selected_startup(self.store, self.app)
        self.assertEqual(outcome["operation_outcome"], "unknown")

    def test_cli_apply_with_unresolved_response_is_blocked(self):
        self.save_plan()
        response = self.root / "error.json"
        response.write_text(json.dumps({"isError": True, "content": [{"text": "CCUH: a previous native operation still has no confirmed completion."}]}))
        output = io.StringIO()
        with redirect_stdout(output):
            result = recovery.main(["--apply", str(self.plan_file), "--backup-file", str(self.backup_file), "--response-file", str(response)])
        self.assertEqual(result, 1)
        self.assertEqual(json.loads(output.getvalue())["reason"], "operation_or_diagnostic_blocks_apply")
        self.assertFalse(self.backup_file.exists())

    def browser_setup_payloads(self):
        return (
            {"isError": True, "content": [{"type": "text", "text": "CUA_REPL_ENABLED_SURFACES is required"}]},
            {"schema_version": 1, "mode": "response", "category": "browser_setup_unavailable",
             "connection_status": "unverified", "operation_outcome": "unverified",
             "is_error_detected": True, "next_action": "redacted"},
        )

    def test_browser_setup_error_blocks_stale_cli_repair_planning(self):
        before = self.env_file.read_bytes()
        for index, payload in enumerate(self.browser_setup_payloads()):
            with self.subTest(payload_type="raw" if index == 0 else "doctor"):
                response = self.root / "browser-error.json"
                response.write_text(json.dumps(payload))
                self.assertEqual(recovery.response_category(response), "browser_setup_unavailable")
                plan_file = self.root / ("blocked-plan-{}.json".format(index))
                output = io.StringIO()
                with patch.object(recovery, "runtime_evidence", return_value=VERIFIED), redirect_stdout(output):
                    result = recovery.main(["--repair-plan", "--environment-file", str(self.env_file),
                                            "--app-path", str(self.app), "--plan-file", str(plan_file),
                                            "--response-file", str(response)])
                self.assertEqual(result, 1)
                self.assertEqual(json.loads(output.getvalue())["reason"], "host_browser_setup_required")
                self.assertEqual(json.loads(plan_file.read_text())["status"], "blocked")
                self.assertEqual(self.env_file.read_bytes(), before)
                self.assertFalse(self.backup_file.exists())

    def test_browser_setup_error_blocks_existing_plan_apply_and_startup_drill(self):
        self.save_plan()
        before = self.env_file.read_bytes()
        for payload in self.browser_setup_payloads():
            response = self.root / "browser-error.json"
            response.write_text(json.dumps(payload))
            actions = (
                ["--apply", str(self.plan_file)],
                ["--startup-drill", "--environment-file", str(self.env_file),
                 "--app-path", str(self.app), "--plan-file", str(self.root / "unused-drill-plan.json")],
            )
            for action in actions:
                with self.subTest(action=action[0], payload=payload):
                    output = io.StringIO()
                    with patch.object(recovery, "runtime_evidence", side_effect=AssertionError("must not probe runtime")), \
                         patch.object(recovery, "selected_startup", side_effect=AssertionError("must not launch")), \
                         redirect_stdout(output):
                        result = recovery.main([*action, "--backup-file", str(self.backup_file),
                                                "--response-file", str(response)])
                    self.assertEqual(result, 1)
                    self.assertEqual(json.loads(output.getvalue())["reason"], "operation_or_diagnostic_blocks_apply")
                    self.assertEqual(self.env_file.read_bytes(), before)
                    self.assertFalse(self.backup_file.exists())
                    self.assertFalse((self.root / "unused-drill-plan.json").exists())

    def test_browser_setup_error_preserves_unknown_operation_precedence(self):
        raw = self.browser_setup_payloads()[0]
        for payload, expected in (
            ({"result": raw, "timedOut": True}, "timeout"),
            ({"result": raw, "operation_outcome": "unknown"}, "operation_unresolved"),
            ({**self.browser_setup_payloads()[1], "operation_outcome": "unknown"}, "operation_unresolved"),
        ):
            with self.subTest(category=expected):
                self.assertEqual(recovery.payload_category(payload), expected)
                self.assertEqual(recovery.response_block(expected), "operation_completion_unconfirmed")

    def test_doctor_json_unknown_outcome_is_not_lost_when_used_for_recovery(self):
        self.save_plan()
        for category in ("operation_unresolved", "timeout"):
            with self.subTest(category=category):
                response = self.root / (category + ".json")
                response.write_text(json.dumps({"schema_version": 1, "mode": "response", "category": category,
                                                "connection_status": "unverified", "operation_outcome": "unknown",
                                                "is_error_detected": True, "next_action": "redacted"}))
                self.assertEqual(recovery.response_category(response), category)
                output = io.StringIO()
                with redirect_stdout(output):
                    result = recovery.main(["--apply", str(self.plan_file), "--backup-file", str(self.backup_file), "--response-file", str(response)])
                self.assertEqual(result, 1)
                self.assertFalse(self.backup_file.exists())
                self.assertEqual(self.store.snapshot()["value"], self.missing)

    def test_response_file_read_is_bounded_before_size_validation(self):
        reads = []
        class BoundedReader(io.BytesIO):
            def read(self, size=-1):
                reads.append(size)
                return super().read(size)
        reader = BoundedReader(b"x" * 100)
        with patch.object(recovery, "LIMIT", 32), patch.object(recovery.Path, "open", return_value=reader), patch.object(recovery.Path, "read_bytes", side_effect=AssertionError("unbounded read forbidden")):
            with self.assertRaises(recovery.RecoveryError) as caught:
                recovery.response_payload("selected-response.json")
        self.assertEqual(caught.exception.code, "invalid_diagnostic_input")
        self.assertEqual(reads, [33])

    def test_response_file_at_limit_is_accepted_with_a_single_bounded_read(self):
        reads = []
        class BoundedReader(io.BytesIO):
            def read(self, size=-1):
                reads.append(size)
                return super().read(size)
        reader = BoundedReader(b'"ok"')
        with patch.object(recovery, "LIMIT", 4), patch.object(recovery.Path, "open", return_value=reader):
            payload, raw = recovery.response_payload("selected-response.json")
        self.assertEqual(payload, "ok")
        self.assertEqual(raw, b'"ok"')
        self.assertEqual(reads, [5])


class AdhocOverrideRecoveryTests(unittest.TestCase):
    setUp = RecoveryFixtureTests.setUp

    def candidate(self):
        custom = self.root / "custom-adhoc-codex"
        custom.write_bytes(b"\xcf\xfa\xed\xfeisolated-fixture-not-executable-code")
        custom.chmod(0o700)
        self.original = {"KEEP": "preserved", recovery.KEY: str(custom)}
        self.env_file.write_text(json.dumps(self.original))
        self.response = self.root / "native-error.json"
        self.response.write_text(json.dumps({"error": {"code": -10000, "message": "Sender process is not authenticated"}}))
        return custom

    def codesign(self, command, **kwargs):
        self.assertEqual(command[0], "/usr/bin/codesign")
        self.assertIn(command[1], ("--verify", "--display"))
        if command[1] == "--verify":
            self.assertEqual(command[2], "--strict")
        return SimpleNamespace(returncode=0, stdout="", stderr="Signature=adhoc\nTeamIdentifier=not set\n")

    def save_adhoc_plan(self):
        with patch.object(recovery, "runtime_evidence", return_value=VERIFIED), patch.object(recovery.platform, "system", return_value="Darwin"), patch.object(recovery.subprocess, "run", side_effect=self.codesign):
            plan = recovery.make_plan(self.store, self.app, "authentication_failed", True, self.response)
        recovery.private_create(self.plan_file, plan)
        return plan

    def apply_adhoc(self, candidate_signer=None, official=VERIFIED):
        with patch.object(recovery, "runtime_evidence", return_value=official), patch.object(recovery.platform, "system", return_value="Darwin"), patch.object(recovery.subprocess, "run", side_effect=candidate_signer or self.codesign):
            return recovery.apply_plan(self.plan_file, self.backup_file, "authentication_failed")

    def test_opt_in_removes_only_override_and_restores_existing_adhoc_path(self):
        custom = self.candidate()
        before = custom.read_bytes()
        process_before = os.environ.get(recovery.KEY)
        plan = self.save_adhoc_plan()
        self.assertEqual(plan["operation"], "remove_adhoc_cli_override")
        self.assertEqual(plan["status"], "repair_available")
        self.assertEqual(plan["candidate"]["resolved_path"], str(custom.resolve()))
        report = self.apply_adhoc()
        self.assertEqual(report["action"], "remove_adhoc_cli_override")
        self.assertFalse(report["native_authentication_recovered"])
        self.assertEqual(report["current_connection"], "unverified")
        self.assertEqual(json.loads(self.env_file.read_text()), {"KEEP": "preserved"})
        self.assertEqual(custom.read_bytes(), before)
        self.assertEqual(os.environ.get(recovery.KEY), process_before)
        recovery.restore_backup(self.backup_file)
        self.assertEqual(json.loads(self.env_file.read_text()), self.original)
        self.assertNotIn(str(custom), json.dumps(report))

    def test_default_mode_preserves_existing_adhoc_override(self):
        custom = self.candidate()
        with patch.object(recovery, "runtime_evidence", return_value=VERIFIED), patch.object(recovery.subprocess, "run", side_effect=AssertionError("unexpected signing or execution")):
            plan = recovery.make_plan(self.store, self.app)
        self.assertEqual(plan["reason"], "existing_override_preserved")
        self.assertEqual(self.store.snapshot()["value"], str(custom))

    def test_exact_error_evidence_is_required_not_a_generic_auth_category(self):
        self.candidate()
        for payload in [
            {"schema_version": 1, "mode": "response", "category": "authentication_failed"},
            {"error": {"code": -10001, "message": "Sender process is not authenticated"}},
            {"error": {"code": -10000, "message": "Unrelated authentication error"}},
            {"error": {"code": -10000.0, "message": "Sender process is not authenticated"}},
            {"content": [{"text": "-10000 Sender process is not authenticated"}]},
        ]:
            self.response.write_text(json.dumps(payload))
            with self.subTest(payload=payload), self.assertRaises(recovery.RecoveryError) as caught:
                recovery.native_authentication_evidence(self.response)
            self.assertEqual(caught.exception.code, "exact_native_authentication_evidence_required")
        for selected in (None, "-"):
            with self.assertRaises(recovery.RecoveryError) as caught:
                recovery.native_authentication_evidence(selected)
            self.assertEqual(caught.exception.code, "native_authentication_evidence_file_required")

    def test_actual_mcp_error_text_is_supported_without_printing_its_contents(self):
        self.candidate()
        self.response.write_text(json.dumps({"isError": True, "content": [{"type": "text", "text": "SkyComputerUseError (-10000): Sender process is not authenticated; private-caller-detail"}]}))
        evidence = recovery.native_authentication_evidence(self.response)
        self.assertEqual(evidence["sha256"], recovery.digest(self.response.read_bytes()))
        self.assertNotIn("private-caller-detail", json.dumps(evidence))

    def test_changed_evidence_blocks_apply_even_when_new_error_is_still_exact(self):
        self.candidate()
        self.save_adhoc_plan()
        self.response.write_text(self.response.read_text() + "\n")
        with self.assertRaises(recovery.RecoveryError) as caught:
            self.apply_adhoc()
        self.assertEqual(caught.exception.code, "native_authentication_evidence_changed")
        self.assertFalse(self.backup_file.exists())
        self.assertIn(recovery.KEY, json.loads(self.env_file.read_text()))

    def test_unknown_outcome_in_fresh_evidence_blocks_apply(self):
        self.candidate()
        self.save_adhoc_plan()
        payload = json.loads(self.response.read_text())
        payload["operation_outcome"] = "unknown"
        self.response.write_text(json.dumps(payload))
        with self.assertRaises(recovery.RecoveryError) as caught:
            self.apply_adhoc()
        self.assertEqual(caught.exception.code, "operation_completion_unconfirmed")
        self.assertFalse(self.backup_file.exists())

    def test_nested_completion_uncertainty_precedes_exact_native_auth_evidence(self):
        self.candidate()
        native = {"code": -10000, "message": "Sender process is not authenticated"}
        cases = [
            ({"result": {"operation_outcome": "unknown", "error": native}}, "operation_unresolved"),
            ({"timeout": True, "error": native}, "timeout"),
            ({"result": {"error": {"timeout": True}}, "error": native}, "timeout"),
            ({"nested": [{"deep": [{"operation_outcome": "unknown"}]}], "error": native}, "operation_unresolved"),
            ({"nested": [{"category": "timeout"}], "error": native}, "timeout"),
            ({"nested": [{"timedOut": True}], "error": native}, "timeout"),
            ({"error": {"code": -10000, "message": "Sender process is not authenticated; request timed out"}}, "timeout"),
            ({"isError": True, "content": [{"text": "-10000 Sender process is not authenticated; result unknown"}]}, "timeout"),
        ]
        for payload, expected in cases:
            with self.subTest(payload=payload):
                self.response.write_text(json.dumps(payload))
                self.assertEqual(recovery.payload_category(payload), expected)
                with self.assertRaises(recovery.RecoveryError) as caught:
                    recovery.native_authentication_evidence(self.response)
                self.assertEqual(caught.exception.code, "operation_completion_unconfirmed")
                with patch.object(recovery, "runtime_evidence", return_value=VERIFIED), patch.object(recovery, "adhoc_candidate_evidence") as candidate_probe:
                    with self.assertRaises(recovery.RecoveryError) as caught:
                        recovery.make_plan(self.store, self.app, "authentication_failed", True, self.response)
                self.assertEqual(caught.exception.code, "operation_completion_unconfirmed")
                candidate_probe.assert_not_called()
                self.assertFalse(self.backup_file.exists())

    def test_nested_unknown_or_timeout_in_saved_evidence_blocks_apply(self):
        native = {"code": -10000, "message": "Sender process is not authenticated"}
        for payload in [
            {"result": {"operation_outcome": "unknown", "error": native}},
            {"timeout": True, "error": native},
        ]:
            with self.subTest(payload=payload):
                self.candidate()
                if self.plan_file.exists():
                    self.plan_file.unlink()
                self.save_adhoc_plan()
                self.response.write_text(json.dumps(payload))
                with self.assertRaises(recovery.RecoveryError) as caught:
                    self.apply_adhoc()
                self.assertEqual(caught.exception.code, "operation_completion_unconfirmed")
                self.assertFalse(self.backup_file.exists())
                self.assertEqual(json.loads(self.env_file.read_text()), self.original)

    def test_evidence_is_rechecked_after_signature_verification(self):
        self.candidate()
        self.save_adhoc_plan()
        def runtime_verification(app):
            self.response.write_text(self.response.read_text() + "\n")
            return VERIFIED
        with patch.object(recovery, "runtime_evidence", side_effect=runtime_verification), patch.object(recovery.platform, "system", return_value="Darwin"), patch.object(recovery.subprocess, "run", side_effect=self.codesign):
            with self.assertRaises(recovery.RecoveryError) as caught:
                recovery.apply_plan(self.plan_file, self.backup_file)
        self.assertEqual(caught.exception.code, "native_authentication_evidence_changed")
        self.assertFalse(self.backup_file.exists())

    def test_candidate_content_change_blocks_apply(self):
        custom = self.candidate()
        self.save_adhoc_plan()
        custom.write_bytes(custom.read_bytes() + b"changed")
        with self.assertRaises(recovery.RecoveryError) as caught:
            self.apply_adhoc()
        self.assertEqual(caught.exception.code, "adhoc_candidate_changed_or_unconfirmed")
        self.assertFalse(self.backup_file.exists())

    def test_candidate_resolved_path_change_blocks_apply_even_with_identical_bytes(self):
        custom = self.candidate()
        second = self.root / "other-adhoc-codex"
        second.write_bytes(custom.read_bytes())
        second.chmod(0o700)
        link = self.root / "selected-cli"
        link.symlink_to(custom)
        self.env_file.write_text(json.dumps({recovery.KEY: str(link)}))
        self.save_adhoc_plan()
        link.unlink()
        link.symlink_to(second)
        with self.assertRaises(recovery.RecoveryError) as caught:
            self.apply_adhoc()
        self.assertEqual(caught.exception.code, "adhoc_candidate_changed_or_unconfirmed")
        self.assertFalse(self.backup_file.exists())

    def test_adhoc_signature_must_verify_and_have_no_team_identifier(self):
        custom = self.candidate()
        cases = [
            (1, 0, "Signature=adhoc\nTeamIdentifier=not set\n", False),
            (0, 1, "Signature=adhoc\nTeamIdentifier=not set\n", False),
            (0, 0, "Signature=adhoc\nTeamIdentifier=ANOTHERTEAM\n", False),
            (0, 0, "Signature=Developer ID\nTeamIdentifier=not set\n", False),
            (0, 0, "TeamIdentifier=not set\n", False),
            (0, 0, "Signature=adhoc\nTeamIdentifier=not set\n", True),
            (0, 0, "Signature=adhoc\n", True),
        ]
        for verify_exit, display_exit, details, expected in cases:
            def signing(command, **kwargs):
                return SimpleNamespace(returncode=verify_exit if command[1] == "--verify" else display_exit, stdout="", stderr=details)
            with self.subTest(details=details, verify=verify_exit, display=display_exit), patch.object(recovery.platform, "system", return_value="Darwin"), patch.object(recovery.subprocess, "run", side_effect=signing):
                self.assertEqual(recovery.adhoc_candidate_evidence(str(custom))["verified"], expected)

    def test_non_macho_or_nonexecutable_candidates_never_invoke_codesign(self):
        custom = self.candidate()
        for content, mode in [(b"not-a-mach-o", 0o700), (b"\xcf\xfa\xed\xfecontent", 0o600)]:
            custom.write_bytes(content)
            custom.chmod(mode)
            with patch.object(recovery.platform, "system", return_value="Darwin"), patch.object(recovery.subprocess, "run", side_effect=AssertionError("must not launch")):
                self.assertFalse(recovery.adhoc_candidate_evidence(str(custom))["verified"])

    def test_changed_source_or_official_runtime_blocks_adhoc_apply(self):
        self.candidate()
        self.save_adhoc_plan()
        with self.assertRaises(recovery.RecoveryError) as caught:
            self.apply_adhoc(official={**VERIFIED, "binary_sha256": "changed"})
        self.assertEqual(caught.exception.code, "runtime_verification_unconfirmed")
        self.env_file.write_text(json.dumps({**self.original, "LATER": "change"}))
        with self.assertRaises(recovery.RecoveryError) as caught:
            self.apply_adhoc()
        self.assertEqual(caught.exception.code, "source_changed")
        self.assertFalse(self.backup_file.exists())

    def test_plan_operation_and_reason_cannot_be_mixed(self):
        self.candidate()
        plan = self.save_adhoc_plan()
        plan["reason"] = "missing_override"
        self.plan_file.write_text(json.dumps(plan))
        with self.assertRaises(recovery.RecoveryError) as caught:
            self.apply_adhoc()
        self.assertEqual(caught.exception.code, "plan_not_applicable")
        self.assertFalse(self.backup_file.exists())

    def test_cli_opt_in_is_only_valid_with_repair_plan(self):
        output = io.StringIO()
        with redirect_stdout(output):
            result = recovery.main(["--restore", "not-read.json", "--remove-adhoc-cli-override"])
        self.assertEqual(result, 1)
        self.assertEqual(json.loads(output.getvalue())["reason"], "adhoc_removal_requires_repair_plan")

    def test_cli_plan_requires_opt_in_then_apply_rechecks_saved_evidence(self):
        self.candidate()
        with patch.object(recovery, "runtime_evidence", return_value=VERIFIED), patch.object(recovery.platform, "system", return_value="Darwin"), patch.object(recovery.subprocess, "run", side_effect=self.codesign):
            output = io.StringIO()
            with redirect_stdout(output):
                planned = recovery.main(["--repair-plan", "--remove-adhoc-cli-override", "--environment-file", str(self.env_file), "--app-path", str(self.app), "--plan-file", str(self.plan_file), "--response-file", str(self.response)])
            self.assertEqual(planned, 0)
            self.assertEqual(json.loads(output.getvalue())["status"], "repair_available")
            output = io.StringIO()
            with redirect_stdout(output):
                applied = recovery.main(["--apply", str(self.plan_file), "--backup-file", str(self.backup_file)])
            self.assertEqual(applied, 0)
            self.assertFalse(json.loads(output.getvalue())["native_authentication_recovered"])


class PredispatchTests(unittest.TestCase):
    def test_unsupported_optional_probe_is_skipped_without_ui_request_rewrite(self):
        request = {"kind": "optional_capability_probe", "capability": "visibility", "optional": True}
        before = dict(request)
        result = recovery.predispatch(request, [], "unknown")
        self.assertEqual(result["decision"], "skip_optional_probe")
        self.assertFalse(result["dispatch_allowed"])
        self.assertFalse(result["request_modified"])
        self.assertEqual(request, before)

    def test_required_missing_capability_waits(self):
        result = recovery.predispatch({"kind": "optional_capability_probe", "capability": "visibility"}, [], "granted")
        self.assertEqual(result["decision"], "wait_for_supported_capability")

    def test_permission_wait_does_not_grant_access(self):
        for state in ("pending", "denied", "unknown"):
            request = {"kind": "optional_capability_probe", "capability": "visibility", "requires_permission": True}
            result = recovery.predispatch(request, ["visibility"], state)
            self.assertEqual(result["decision"], "wait_for_permission")
            self.assertFalse(result["dispatch_allowed"])

    def test_does_not_strip_visibility_false_from_creation_request(self):
        request = {"kind": "create_tab", "options": {"visible": False}}
        self.assertEqual(recovery.predispatch(request, [], "granted")["decision"], "not_a_supported_recovery_probe")
        self.assertFalse(request["options"]["visible"])

    def test_pending_operation_blocks_even_supported_probe(self):
        request = {"kind": "optional_capability_probe", "capability": "visibility"}
        for category in ("timeout", "operation_unresolved"):
            result = recovery.predispatch(request, ["visibility"], "granted", category)
            self.assertEqual(result["decision"], "wait_for_operation_completion")
            self.assertFalse(result["dispatch_allowed"])


class LaunchEnvironmentTests(unittest.TestCase):
    def test_launchctl_changes_future_environment_only_and_restores(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = {"value": str(root / "nonexistent-codex")}
            original = state["value"]

            def launchctl(command, **kwargs):
                self.assertEqual(command[:1], ["/bin/launchctl"])
                if command[1] == "unsetenv":
                    state["value"] = None
                elif command[1] == "setenv":
                    state["value"] = command[3]
                return SimpleNamespace(returncode=0, stdout=(state["value"] or "") + "\n", stderr="")

            with patch.object(recovery.platform, "system", return_value="Darwin"), patch.object(recovery.subprocess, "run", side_effect=launchctl), patch.object(recovery, "runtime_evidence", return_value=VERIFIED):
                store = recovery.Store("launchctl")
                plan = recovery.make_plan(store, root / "App.app")
                recovery.private_create(root / "plan.json", plan)
                result = recovery.apply_plan(root / "plan.json", root / "backup.json")
                self.assertIsNone(state["value"])
                self.assertEqual(result["scope"], "future_process_launch_environment")
                self.assertTrue(result["restart_or_new_session_required"])
                self.assertFalse(result["current_process_environment_changed"])
                self.assertFalse(result["native_authentication_recovered"])
                recovery.restore_backup(root / "backup.json")
                self.assertEqual(state["value"], original)


if __name__ == "__main__":
    unittest.main()
