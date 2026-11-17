import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "lab/native_auth_probe.py"
SPEC = importlib.util.spec_from_file_location("ccuh_native_auth_probe", SOURCE)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class LauncherSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "private-launcher.json"
        self.selected = self.root / "private-selected-cli"
        self.official = self.root / "official-cli"
        self.selected.write_bytes(b"selected fixture executable")
        self.official.write_bytes(b"official fixture executable")

    def write_source(self, value):
        raw = json.dumps(value).encode("utf-8")
        self.source.write_bytes(raw)
        return raw

    def test_actual_source_selects_only_cli_override_and_redacts_values(self):
        raw = self.write_source({"CODEX_CLI_PATH": str(self.selected),
                                 "SECRET": "PRIVATE_FIXTURE_SECRET",
                                 "HOME": "/private/fixture-home"})
        before = dict(os.environ)
        selected, metadata = probe.launcher_from_environment_file(self.source, self.official)
        self.assertEqual(selected, self.selected)
        self.assertEqual(metadata["kind"], "isolated_environment_file")
        self.assertEqual(metadata["source_sha256"], probe.sha(raw))
        self.assertEqual(metadata["selected_cli_path_sha256"], probe.sha(str(self.selected).encode()))
        self.assertTrue(metadata["override_present"])
        self.assertFalse(metadata["other_fixture_values_injected"])
        self.assertEqual(dict(os.environ), before)
        serialized = json.dumps(metadata)
        for private in (str(self.source), str(self.selected), "PRIVATE_FIXTURE_SECRET", "/private/fixture-home"):
            self.assertNotIn(private, serialized)

    def test_same_source_after_override_removal_uses_official_fallback(self):
        self.write_source({"CODEX_CLI_PATH": str(self.selected), "unrelated": "preserved"})
        first_cli, first = probe.launcher_from_environment_file(self.source, self.official)
        raw = self.write_source({"unrelated": "preserved"})
        second_cli, second = probe.launcher_from_environment_file(self.source, self.official)
        self.assertEqual(first_cli, self.selected)
        self.assertEqual(second_cli, self.official)
        self.assertTrue(first["override_present"])
        self.assertFalse(second["override_present"])
        self.assertEqual(first["source_path_sha256"], second["source_path_sha256"])
        self.assertNotEqual(first["source_sha256"], second["source_sha256"])
        self.assertEqual(second["source_sha256"], probe.sha(raw))
        self.assertEqual(json.loads(self.source.read_text()), {"unrelated": "preserved"})

    def test_present_invalid_values_are_rejected_instead_of_falling_back(self):
        for value in (None, True, 3, {}, [], "", "relative/cli", "~/cli", "/private/cli\0secret"):
            with self.subTest(value_type=type(value).__name__):
                self.write_source({"CODEX_CLI_PATH": value})
                with self.assertRaises(ValueError):
                    probe.launcher_from_environment_file(self.source, self.official)
        self.write_source({})
        with self.assertRaises(ValueError):
            probe.launcher_from_environment_file(self.source, Path("relative/official"))

    def test_symlinks_directories_and_other_owners_are_rejected(self):
        self.write_source({})
        link = self.root / "link.json"
        link.symlink_to(self.source)
        for path in (link, self.root):
            with self.subTest(kind=path.name):
                with self.assertRaises(ValueError):
                    probe.launcher_from_environment_file(path, self.official)
        other_owner = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=os.getuid() + 1)
        with patch.object(probe.os, "fstat", return_value=other_owner):
            with self.assertRaises(ValueError):
                probe.launcher_from_environment_file(self.source, self.official)

    def test_source_read_has_one_mib_limit_and_requires_json_object(self):
        self.source.write_bytes(b" " * (probe.MAX_LAUNCHER_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "exceeds_limit"):
            probe.launcher_from_environment_file(self.source, self.official)
        for raw in (b"[]", b"null", b'"private-string"', b'{"unclosed":', b"\xff"):
            with self.subTest(raw_length=len(raw)):
                self.source.write_bytes(raw)
                with self.assertRaises((ValueError, UnicodeError)):
                    probe.launcher_from_environment_file(self.source, self.official)


class NativeProbeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "CCUH Focus Probe.app"
        self.app.mkdir()
        self.client = self.root / "native-client"
        self.client.write_text("fixture native client; not executed")

    def server(self, scenario):
        cli = self.root / (scenario + "-cli")
        # This fixture speaks the public JSONL schema. No real app, token,
        # native socket, or CLI runtime is contacted by these tests.
        program = '''
import json,os,sys,time
from pathlib import Path
scenario=SCENARIO
expected_app=EXPECTED_APP
if os.environ.get("CODEX_CLI_PATH") != str(Path(__file__).resolve()):
    sys.exit(9)
initialized=False
for line in sys.stdin:
    request=json.loads(line)
    method=request["method"]
    if method=="initialized":
        initialized=True
        continue
    if method=="initialize":
        result={"userAgent":"fixture"}
    elif method=="thread/start":
        if not initialized:
            sys.exit(8)
        if scenario=="approval":
            print(json.dumps({"id":90,"method":"mcpServer/elicitation/request","params":{"message":"PRIVATE_APPROVAL_TEXT","token":"PRIVATE_TOKEN"}}),flush=True)
            for line in sys.stdin:
                Path(expected_app).with_name("approval-response-sent").touch()
            break
        result={"thread":{"id":"fixture-thread"}}
    elif method=="mcpServerStatus/list":
        assert request["params"]["serverName"]=="computer-use"
        assert request["params"]["detail"]=="toolsAndAuthOnly"
        tool={"name":"get_app_state","inputSchema":{"type":"object","required":["app"],"properties":{"app":{"type":"string"}}}}
        result={"data":[{"name":"computer-use","tools":{} if scenario=="missing" else {"get_app_state":tool}}]}
    elif method=="mcpServer/tool/call":
        Path(expected_app).with_name("native-call-dispatched").touch()
        assert request["params"]["tool"]=="get_app_state"
        assert request["params"]["arguments"]=={"app":expected_app}
        if scenario.startswith("permission_"):
            params={"serverName":"computer-use","mode":"form","message":"Allow ChatGPT to use CCUH Focus Probe?","requestedSchema":{"type":"object","properties":{},"required":[]}}
            if scenario=="permission_wrong_server": params["serverName"]="other-server"
            if scenario=="permission_fields": params["requestedSchema"]["properties"]={"secret":{"type":"string"}}
            if scenario=="permission_url": params["mode"]="url"
            if scenario=="permission_private_prompt": params["message"]+=" token=PRIVATE_TOKEN"
            print(json.dumps({"id":90,"method":"mcpServer/elicitation/request","params":params}),flush=True)
            acknowledgement=sys.stdin.readline()
            if not acknowledgement: break
            received=json.loads(acknowledgement)
            assert received=={"id":90,"result":{"action":"accept","content":{}}}
            Path(expected_app).with_name("ack-count").write_text("1")
            if scenario=="permission_twice":
                print(json.dumps({"id":91,"method":"mcpServer/elicitation/request","params":params}),flush=True)
                acknowledgement=sys.stdin.readline()
                if not acknowledgement: break
                Path(expected_app).with_name("ack-count").write_text("2")
        if scenario=="timeout":
            time.sleep(10)
        if scenario=="auth":
            print("dynamic_app_tools_peer_rejected reason=missing-code-signing-identity token=PRIVATE_TOKEN",file=sys.stderr,flush=True)
            result={"isError":True,"content":[{"type":"text","text":"Computer Use server error -10000: Sender process is not authenticated token=PRIVATE_TOKEN"}]}
        elif scenario=="unknown_error":
            result={"isError":True,"content":[{"type":"text","text":"PRIVATE_UNKNOWN_ERROR_WITH_TOKEN"}]}
        else:
            result={"isError":False,"content":[{"type":"text","text":"CCUH Test Input PRIVATE_UI_TEXT"},{"type":"image","data":"PRIVATE_IMAGE_BYTES"}]}
    else:
        sys.exit(7)
    print(json.dumps({"id":request["id"],"result":result}),flush=True)
'''
        program = program.replace("SCENARIO", repr(scenario)).replace("EXPECTED_APP", repr(str(self.app)))
        cli.write_text("#!" + sys.executable + "\n" + program)
        cli.chmod(0o700)
        return cli.resolve()

    def run_probe(self, scenario, timeout=3, acknowledge=False):
        return probe.probe(self.server(scenario), self.app, self.client, "CCUH Test Input", timeout,
                           acknowledge_approved_probe_access=acknowledge)

    def test_successful_exact_target_read_records_marker_without_contents(self):
        previous = os.environ.get("CODEX_CLI_PATH")
        report = self.run_probe("success")
        self.assertEqual(report["status"], "target_marker_confirmed")
        self.assertEqual(report["steps_completed"], ["initialize", "thread/start", "mcpServerStatus/list", "mcpServer/tool/call"])
        self.assertTrue(report["tool_response"]["expected_marker_present"])
        self.assertGreater(report["tool_response"]["response_bytes"], 0)
        self.assertEqual(len(report["tool_response"]["response_sha256"]), 64)
        serialized = json.dumps(report)
        for private in ("PRIVATE_UI_TEXT", "PRIVATE_IMAGE_BYTES", "CCUH Test Input", str(self.app)):
            self.assertNotIn(private, serialized)
        self.assertEqual(os.environ.get("CODEX_CLI_PATH"), previous)
        self.assertFalse(report["parent_environment_changed"])

    def test_native_auth_denial_records_only_allowlisted_error(self):
        report = self.run_probe("auth")
        self.assertEqual(report["status"], "authentication_denied")
        self.assertTrue(report["tool_response"]["isError"])
        self.assertEqual(report["tool_response"]["native_error_code"], -10000)
        self.assertIn(probe.ERROR_MESSAGES[0], report["tool_response"]["error_messages"])
        self.assertIn("missing-code-signing-identity", report["process"]["stderr_known_messages"])
        self.assertNotIn("PRIVATE_TOKEN", json.dumps(report))
        self.assertEqual(report["result"], {"isError": True, "content": [{"type": "text", "text": probe.ERROR_MESSAGES[0]}]})
        self.assertEqual(report["native_error_export"]["source"], "observed_mcp_tool_response")
        self.assertEqual(report["native_error_export"]["response_sha256"], report["tool_response"]["response_sha256"])

    def test_unknown_error_message_is_redacted(self):
        report = self.run_probe("unknown_error")
        self.assertEqual(report["status"], "tool_error")
        self.assertTrue(report["tool_response"]["unrecognized_error_redacted"])
        self.assertNotIn("PRIVATE_UNKNOWN_ERROR_WITH_TOKEN", json.dumps(report))
        self.assertNotIn("result", report)

    def test_native_error_export_requires_real_error_flag_and_exact_content_sentence(self):
        full = probe.ERROR_MESSAGES[0]
        cases = (
            {"result": {"isError": False, "content": [{"type": "text", "text": full}]}},
            {"result": {"isError": True, "content": [{"type": "text", "text": "Sender process is not authenticated"}]}},
            {"result": {"isError": True, "content": [{"type": "image", "data": full}]}},
            {"result": {"isError": True, "category": "authentication_failed"}},
            {"error": {"code": -10000, "message": full}},
        )
        for message in cases:
            with self.subTest(message_type=list(message)):
                self.assertIsNone(probe.observed_native_error_export(message))

    def test_approval_request_stops_without_response_or_native_call(self):
        report = self.run_probe("approval")
        self.assertEqual(report["status"], "approval_required")
        self.assertFalse(report["stop_details"]["automatically_approved"])
        self.assertFalse(report["tool_call_dispatched"])
        self.assertFalse((self.root / "approval-response-sent").exists())
        self.assertFalse((self.root / "native-call-dispatched").exists())
        self.assertNotIn("PRIVATE_APPROVAL_TEXT", json.dumps(report))
        self.assertNotIn("PRIVATE_TOKEN", json.dumps(report))

    def test_missing_tool_stops_before_native_call(self):
        report = self.run_probe("missing")
        self.assertEqual(report["status"], "tool_not_exposed")
        self.assertFalse(report["tool_call_dispatched"])
        self.assertFalse((self.root / "native-call-dispatched").exists())

    def test_previously_approved_exact_prompt_still_stops_without_opt_in(self):
        report = self.run_probe("permission_exact")
        self.assertEqual(report["status"], "approval_required")
        self.assertEqual(report["prior_user_approval_acknowledgements"], 0)
        self.assertFalse((self.root / "ack-count").exists())

    def test_opt_in_acknowledges_only_exact_existing_app_access(self):
        report = self.run_probe("permission_exact", acknowledge=True)
        self.assertEqual(report["status"], "target_marker_confirmed")
        self.assertEqual(report["prior_user_approval_acknowledgements"], 1)
        self.assertEqual((self.root / "ack-count").read_text(), "1")

    def test_other_server_fields_url_and_private_prompt_still_stop_with_opt_in(self):
        for scenario in ("permission_wrong_server", "permission_fields", "permission_url", "permission_private_prompt"):
            with self.subTest(scenario=scenario):
                report = self.run_probe(scenario, acknowledge=True)
                self.assertEqual(report["status"], "approval_required")
                self.assertEqual(report["prior_user_approval_acknowledgements"], 0)
                self.assertFalse((self.root / "ack-count").exists())
                self.assertNotIn("PRIVATE_TOKEN", json.dumps(report))

    def test_opt_in_never_acknowledges_a_second_request(self):
        report = self.run_probe("permission_twice", acknowledge=True)
        self.assertEqual(report["status"], "approval_required")
        self.assertEqual(report["prior_user_approval_acknowledgements"], 1)
        self.assertEqual((self.root / "ack-count").read_text(), "1")

    def test_timeout_does_not_claim_native_cancellation(self):
        report = self.run_probe("timeout", timeout=0.3)
        self.assertEqual(report["status"], "timeout")
        self.assertEqual(report["operation_outcome"], "unknown")
        self.assertFalse(report["process"]["native_operation_cancellation_confirmed"])
        self.assertFalse(report["process"]["shared_helpers_terminated"])
        self.assertIsNotNone(report["process"]["client_exit_code"])

    def test_write_tool_is_refused_before_process_start(self):
        cli = self.server("success")
        report = probe.probe(cli, self.app, self.client, tool_name="click")
        self.assertEqual(report["status"], "tool_not_permitted")
        self.assertFalse(report["tool_call_dispatched"])
        self.assertNotIn("process", report)

    def test_cli_overrides_use_validated_unquoted_dotted_keys(self):
        command = probe.build_command(Path("/official cli"), Path("/official native"), probe.DEFAULT_DISABLED)
        self.assertIn("mcp_servers.agent-hud.enabled=false", command)
        self.assertIn("mcp_servers.context-mode.enabled=false", command)
        self.assertIn("mcp_servers.node_repl.enabled=false", command)
        self.assertIn('mcp_servers.computer-use.command="/official native"', command)
        self.assertIn('mcp_servers.computer-use.env.CODEX_CLI_PATH="/official cli"', command)
        self.assertFalse(any('mcp_servers."' in arg for arg in command))
        for invalid in ("computer-use", "name.with.dot", "name\"", "name=secret"):
            with self.subTest(server=invalid):
                with self.assertRaises(ValueError):
                    probe.build_command(Path("cli"), Path("client"), [invalid])

    def test_image_data_does_not_count_as_expected_text_marker(self):
        value = {"content": [{"type": "image", "data": "CCUH Test Input"}]}
        self.assertFalse(probe.marker_present(value, "CCUH Test Input"))

    def test_evidence_is_private_and_existing_file_not_overwritten(self):
        evidence = self.root / "evidence.json"
        probe.write_evidence(evidence, {"status": "fixture"})
        self.assertEqual(stat.S_IMODE(evidence.stat().st_mode), 0o600)
        before = evidence.read_bytes()
        with self.assertRaises(FileExistsError):
            probe.write_evidence(evidence, {"status": "overwrite"})
        self.assertEqual(evidence.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
