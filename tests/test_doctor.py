import importlib.util
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "skills/ccuh-doctor/scripts/doctor.py"
SPEC = importlib.util.spec_from_file_location("ccuh_doctor", SCRIPT)
doctor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(doctor)


class ResponseClassificationTests(unittest.TestCase):
    def category(self, payload):
        return doctor.classify_response(payload)["category"]

    def test_successful_shell_exit_does_not_hide_nested_mcp_auth_error(self):
        response = {
            "exit_code": 0,
            "result": {
                "isError": True,
                "content": [{"type": "text", "text": "Computer Use server error -10000: Sender process is not authenticated"}],
            },
        }
        self.assertEqual(self.category(response), "authentication_failed")

    def test_serialized_mcp_envelope_is_examined(self):
        response = {"content": [{"type": "text", "text": json.dumps({"isError": True, "content": [{"text": "unexpected service failure"}]})}]}
        self.assertEqual(self.category(response), "tool_error")

    def test_top_level_error_and_nested_error_are_both_detected(self):
        self.assertEqual(self.category({"isError": True}), "tool_error")
        self.assertEqual(self.category({"isError": False, "result": {"isError": True}}), "tool_error")

    def test_signing_identity_failure_is_authentication_not_startup(self):
        self.assertEqual(self.category("native pipe startup failed; peer rejected: missing-code-signing-identity"), "authentication_failed")

    def test_missing_executable_is_startup_failure(self):
        self.assertEqual(self.category("MCP startup failed: No such file or directory (os error 2)"), "startup_failed")

    def test_permission_failure_is_not_target_absence(self):
        self.assertEqual(self.category("Could not find window: permission denied"), "permission_denied")

    def test_lookup_error_does_not_mean_no_window_exists(self):
        self.assertEqual(self.category("Failed to list windows"), "target_lookup_failed")
        self.assertEqual(self.category("No matching window found"), "target_lookup_failed")
        self.assertEqual(self.category("window not found"), "target_lookup_failed")

    def test_explicit_target_closed_report_is_distinct_from_lookup_failure(self):
        self.assertEqual(self.category("The tab was closed"), "target_absent")

    def test_empty_inventory_does_not_prove_target_absent(self):
        self.assertEqual(self.category({"windows": []}), "response_unverified")

    def test_minimized_window_is_capture_limitation_not_absence(self):
        self.assertEqual(self.category("window is minimized; call activate_window"), "capture_failed")

    def test_timeout_retains_unknown_operation_outcome(self):
        report = doctor.classify_response({"status": "completed", "content": [{"text": "window creation timed out"}]})
        self.assertEqual(report["category"], "timeout")
        self.assertEqual(report["operation_outcome"], "unknown")

    def test_structured_timeout_without_message(self):
        self.assertEqual(self.category({"timeout": True}), "timeout")

    def test_observed_capability_error_is_classified_in_plain_and_mcp_responses(self):
        message = "Capability is not available: visibility"
        error = {"isError": True, "content": [{"type": "text", "text": message}]}
        payloads = (
            message,
            error,
            {"exit_code": 0, "result": error},
            {"content": [{"text": json.dumps(error)}]},
        )
        for payload in payloads:
            with self.subTest(payload_type=type(payload).__name__):
                report = doctor.classify_response(payload)
                self.assertEqual(report["category"], "capability_unavailable")
                self.assertTrue(report["is_error_detected"])
                self.assertEqual(report["connection_status"], "unverified")

    def test_observed_unresolved_operation_is_not_a_completed_or_cancelled_request(self):
        message = "CCUH: a previous native operation still has no confirmed completion..."
        error = {"isError": True, "content": [{"type": "text", "text": message}]}
        payloads = (
            message,
            {"status": "completed", "exit_code": 0, "result": error},
            {"isError": False, "content": [{"text": json.dumps(error)}]},
        )
        for payload in payloads:
            with self.subTest(payload_type=type(payload).__name__):
                report = doctor.classify_response(payload)
                self.assertEqual(report["category"], "operation_unresolved")
                self.assertTrue(report["is_error_detected"])
                self.assertEqual(report["operation_outcome"], "unknown")
                self.assertEqual(report["connection_status"], "unverified")

    def test_specific_new_errors_take_precedence_over_generic_timeout(self):
        capability = {"isError": True, "content": [{"text": "Capability is not available: visibility; request timed out"}]}
        unresolved = {"isError": True, "content": [{"text": "CCUH: a previous native operation still has no confirmed completion. The earlier call timed out."}]}
        self.assertEqual(self.category(capability), "capability_unavailable")
        self.assertEqual(self.category(unresolved), "operation_unresolved")

    def test_unresolved_previous_operation_remains_primary_when_capability_also_fails(self):
        message = "CCUH: a previous native operation still has no confirmed completion. Capability is not available: visibility"
        self.assertEqual(self.category({"isError": True, "content": [{"text": message}]}), "operation_unresolved")

    def test_unavailable_tool_is_classified(self):
        self.assertEqual(self.category("Browser is not available: extension"), "tool_unavailable")

    def test_nonerror_response_never_proves_connection_ready(self):
        report = doctor.classify_response({"isError": False, "exit_code": 0, "content": [{"text": "Action completed."}]})
        self.assertEqual(report["category"], "response_unverified")
        self.assertEqual(report["connection_status"], "unverified")

    def test_error_text_and_secrets_are_not_returned(self):
        secret = "private-token-value-not-for-output"
        report = doctor.classify_response({"isError": True, "content": [{"text": "Sender process is not authenticated: " + secret}]})
        self.assertNotIn(secret, json.dumps(report))


class EnvironmentTests(unittest.TestCase):
    def test_metadata_and_override_do_not_prove_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Test.app"
            (app / "Contents").mkdir(parents=True)
            with (app / "Contents/Info.plist").open("wb") as handle:
                plistlib.dump({"CFBundleShortVersionString": "26.1111.21308", "CFBundleVersion": "27194"}, handle)
            binary = app / doctor.OFFICIAL_BINARY
            binary.parent.mkdir(parents=True)
            binary.touch()
            report = doctor.environment_report(app, {"CODEX_CLI_PATH": "/private/secret/custom-codex"})
            self.assertTrue(report["environment"]["official_binary_present"])
            self.assertTrue(report["environment"]["cli_override_present"])
            self.assertEqual(report["environment"]["app_build"], "27194")
            self.assertEqual(report["connection_status"], "unverified")
            self.assertEqual(report["operation_outcome"], "not_attempted")
            self.assertNotIn("/private/secret", json.dumps(report))

    def test_missing_bundle_returns_unverified_without_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            report = doctor.environment_report(Path(directory) / "absent.app", {})
            self.assertFalse(report["environment"]["app_present"])
            self.assertEqual(report["connection_status"], "unverified")


class CliTests(unittest.TestCase):
    def run_cli(self, *args, input_text=None, env=None):
        return subprocess.run([sys.executable, str(SCRIPT), *args], input=input_text, capture_output=True, text=True, env=env)

    def test_stdin_error_returns_json_and_exit_one(self):
        completed = self.run_cli("--response-file", "-", input_text=json.dumps({"isError": True, "content": [{"text": "Sender process is not authenticated"}]}))
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(json.loads(completed.stdout)["category"], "authentication_failed")
        self.assertEqual(completed.stderr, "")

    def test_invalid_file_returns_sanitized_input_error(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = str(Path(directory) / "secret-path-not-for-output")
            completed = self.run_cli("--response-file", missing)
            self.assertEqual(completed.returncode, 2)
            self.assertEqual(json.loads(completed.stdout)["category"], "input_error")
            self.assertNotIn(missing, completed.stdout + completed.stderr)

    def test_empty_and_oversized_input_are_rejected(self):
        for text in ("", " " * 10, "x" * (doctor.MAX_INPUT_BYTES + 1)):
            with self.subTest(length=len(text)):
                completed = self.run_cli("--response-file", "-", input_text=text)
                self.assertEqual(completed.returncode, 2)
                self.assertEqual(json.loads(completed.stdout)["category"], "input_error")

    def test_help_documents_exit_semantics(self):
        completed = self.run_cli("--help")
        self.assertEqual(completed.returncode, 0)
        self.assertIn("Exit codes:", completed.stdout)
        self.assertIn("unverified", completed.stdout)
        self.assertIn("--format {text,json}", completed.stdout)

    def test_explicit_json_preserves_default_output(self):
        payload = json.dumps({"isError": True, "content": [{"text": "Sender process is not authenticated"}]})
        default = self.run_cli("--response-file", "-", input_text=payload)
        explicit = self.run_cli("--response-file", "-", "--format", "json", input_text=payload)
        self.assertEqual(default.returncode, explicit.returncode)
        self.assertEqual(json.loads(default.stdout), json.loads(explicit.stdout))

    def test_text_explains_auth_path_lookup_and_timeout_without_raw_error(self):
        secret = "raw-private-token-not-for-output"
        cases = (
            ("Sender process is not authenticated", "authentication_failed", "호출 프로세스 인증 실패"),
            ("MCP startup failed: No such file or directory", "startup_failed", "서버 시작 또는 실행 경로 오류"),
            ("No matching window found", "target_lookup_failed", "기존 창이 없어졌다는 뜻은 아닙니다"),
            ("window creation timed out", "timeout", "취소 여부 미확인"),
        )
        for message, category, explanation in cases:
            with self.subTest(category=category):
                payload = json.dumps({"isError": True, "content": [{"text": message + ": " + secret}]})
                completed = self.run_cli("--response-file", "-", "--format", "text", input_text=payload)
                self.assertEqual(completed.returncode, 1)
                self.assertIn(category, completed.stdout)
                self.assertIn(explanation, completed.stdout)
                self.assertIn("현재 확인 단계:", completed.stdout)
                self.assertIn("연결 상태: 미확인", completed.stdout)
                self.assertIn("다음 조치:", completed.stdout)
                self.assertNotIn(secret, completed.stdout + completed.stderr)
                self.assertNotIn(message, completed.stdout + completed.stderr)
                self.assertEqual(completed.stderr, "")

    def test_text_environment_does_not_echo_override_or_claim_connection(self):
        secret = "/private/secret-cli-path-not-for-output"
        environment = dict(os.environ, CODEX_CLI_PATH=secret)
        with tempfile.TemporaryDirectory() as directory:
            completed = self.run_cli("--app-path", str(Path(directory) / "absent.app"), "--format", "text", env=environment)
        self.assertEqual(completed.returncode, 0)
        self.assertIn("실행 경로 재정의: 설정됨 (값 비공개)", completed.stdout)
        self.assertIn("실제 연결·UI 조작: 시도하지 않음", completed.stdout)
        self.assertIn("연결 상태: 미확인", completed.stdout)
        self.assertNotIn(secret, completed.stdout + completed.stderr)

    def test_text_invalid_file_does_not_leak_its_path(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = str(Path(directory) / "private-file-name-not-for-output")
            completed = self.run_cli("--response-file", missing, "--format", "text")
        self.assertEqual(completed.returncode, 2)
        self.assertIn("진단 입력 확인 필요", completed.stdout)
        self.assertIn("연결 상태: 미확인", completed.stdout)
        self.assertNotIn(missing, completed.stdout + completed.stderr)

    def test_new_error_categories_keep_json_keys_and_do_not_echo_sensitive_values(self):
        secret = "test-only-sensitive-token-not-for-output"
        expected_keys = {"schema_version", "mode", "category", "connection_status", "operation_outcome", "is_error_detected", "next_action"}
        cases = (
            ("Capability is not available: visibility", "capability_unavailable", "unverified"),
            ("CCUH: a previous native operation still has no confirmed completion...", "operation_unresolved", "unknown"),
        )
        for message, category, outcome in cases:
            with self.subTest(category=category):
                payload = json.dumps({"exit_code": 0, "result": {"isError": True, "content": [{"text": message + " token=" + secret}]}})
                completed = self.run_cli("--response-file", "-", input_text=payload)
                self.assertEqual(completed.returncode, 1)
                report = json.loads(completed.stdout)
                self.assertEqual(set(report), expected_keys)
                self.assertEqual(report["category"], category)
                self.assertEqual(report["operation_outcome"], outcome)
                self.assertNotIn(secret, completed.stdout + completed.stderr)
                self.assertNotIn(message, completed.stdout + completed.stderr)

    def test_new_errors_render_korean_preflight_and_unresolved_operation_guidance(self):
        secret = "test-only-private-value-not-for-output"
        cases = (
            ("Capability is not available: visibility", "capability_unavailable", "선택 옵션의 지원 여부를 사전에 확인", "탭이나 창을 다시 만들지 마세요"),
            ("CCUH: a previous native operation still has no confirmed completion...", "operation_unresolved", "취소된 것으로 볼 수 없습니다", "확인 전 임의 초기화, 인증 우회, 같은 변경의 중복 요청을 하지 마세요"),
        )
        for message, category, status_explanation, action in cases:
            with self.subTest(category=category):
                payload = json.dumps({"isError": True, "content": [{"text": message + " token=" + secret}]})
                completed = self.run_cli("--response-file", "-", "--format", "text", input_text=payload)
                self.assertEqual(completed.returncode, 1)
                self.assertIn(category, completed.stdout)
                self.assertIn(status_explanation, completed.stdout)
                self.assertIn(action, completed.stdout)
                self.assertIn("연결 상태: 미확인", completed.stdout)
                if category == "operation_unresolved":
                    self.assertIn("작업 결과: 불확실 (취소 여부 미확인)", completed.stdout)
                self.assertNotIn(secret, completed.stdout + completed.stderr)
                self.assertNotIn(message, completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
