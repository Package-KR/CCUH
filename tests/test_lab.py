import http.client
import importlib.util
import json
from pathlib import Path
import threading
import unittest


SPEC = importlib.util.spec_from_file_location(
    "ccuh_lab_server", Path(__file__).resolve().parents[1] / "lab" / "server.py"
)
lab = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lab)


class LabHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = lab.create_server(0, max_events=3)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def request(self, method, path, payload=None, headers=None, raw=None):
        request_headers = dict(headers or {})
        body = raw
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            data = response.read()
            result_headers = dict(response.getheaders())
            if result_headers.get("Content-Type", "").startswith("application/json"):
                data = json.loads(data)
            return response.status, data, result_headers
        finally:
            connection.close()

    def test_only_loopback_and_explicit_pages_are_available(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        for path in ("/target", "/user"):
            status, body, headers = self.request("GET", path)
            self.assertEqual(status, 200)
            self.assertTrue(headers["Content-Type"].startswith("text/html"))
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIn("connect-src 'self'", headers["Content-Security-Policy"])
        for path in ("/", "/unknown", "/../server.py", "/target.html"):
            self.assertEqual(self.request("GET", path)[0], 404)

    def test_saved_form_state_persists_and_is_independently_recorded(self):
        self.assertEqual(self.request("GET", "/worker")[1]["worker"]["revision"], 0)
        status, data, _ = self.request("POST", "/worker", {"name": "ccuh-demo", "enabled": True})
        self.assertEqual(status, 200)
        self.assertEqual(data["worker"], {"name": "ccuh-demo", "enabled": True, "revision": 1})
        self.assertEqual(self.request("GET", "/worker")[1]["worker"], data["worker"])
        snapshot = self.request("GET", "/events")[1]
        self.assertEqual(snapshot["worker"], data["worker"])
        self.assertEqual(snapshot["events"][0]["event"], "worker_saved")
        self.assertEqual(snapshot["events"][0]["source"], "target")
        self.assertEqual(snapshot["events"][0]["data"], data["worker"])

    def test_invalid_save_does_not_mutate_state(self):
        for payload in (
            {"name": "ccuh-demo", "enabled": 1},
            {"name": "", "enabled": True},
            {"name": "has spaces", "enabled": True},
            {"name": "ccuh-demo", "enabled": True, "token": "not-a-real-secret"},
        ):
            self.assertEqual(self.request("POST", "/worker", payload)[0], 400)
        self.assertEqual(self.request("GET", "/worker")[1]["worker"]["revision"], 0)
        self.assertEqual(self.request("GET", "/events")[1]["total_events"], 0)

    def test_user_events_preserve_source_order_text_and_selection(self):
        text = "ccuh-input-01 한글"
        for event in ("focus", "input", "selectionchange"):
            status, data, _ = self.request("POST", "/events", {
                "source": "user", "event": event,
                "data": {"value": text, "selection_start": 3, "selection_end": 7,
                         "focused": True, "visibility": "visible", "page_id": "test-page",
                         "client_sequence": 7, "client_time_ms": 1_000_000,
                         "client_monotonic_ms": 500},
            })
            self.assertEqual(status, 200)
        events = self.request("GET", "/events")[1]["events"]
        self.assertEqual([e["event"] for e in events], ["focus", "input", "selectionchange"])
        self.assertEqual([e["sequence"] for e in events], [1, 2, 3])
        self.assertTrue(all(e["source"] == "user" for e in events))
        self.assertEqual(events[1]["data"]["value"], text)
        self.assertEqual(events[2]["data"]["selection_end"], 7)
        self.assertEqual(events[0]["data"]["page_id"], "test-page")
        self.assertEqual(events[0]["data"]["client_monotonic_ms"], 500)
        self.assertLessEqual(events[0]["monotonic_ns"], events[2]["monotonic_ns"])

    def test_event_retention_is_bounded_and_loss_is_explicit(self):
        for _ in range(5):
            self.assertEqual(self.request("POST", "/events", {
                "source": "target", "event": "window_blur", "data": {},
            })[0], 200)
        snapshot = self.request("GET", "/events")[1]
        self.assertEqual(snapshot["total_events"], 5)
        self.assertEqual(snapshot["dropped_events"], 2)
        self.assertEqual([e["sequence"] for e in snapshot["events"]], [3, 4, 5])

    def test_unexpected_event_fields_and_bad_payloads_are_rejected(self):
        for payload in (
            {"source": "other-app", "event": "input", "data": {}},
            {"source": "user", "event": "keypress", "data": {}},
            {"source": "user", "event": "input", "data": {"password": "not-real"}},
            {"source": "user", "event": "input", "data": {"value": "x" * 4097}},
            {"source": "user", "event": "input", "data": {"selection_start": True}},
            {"source": "user", "event": "input", "data": {"visibility": "unknown"}},
        ):
            self.assertEqual(self.request("POST", "/events", payload)[0], 400)
        self.assertEqual(self.request("GET", "/events")[1]["total_events"], 0)

    def test_remote_origin_and_rebinding_host_are_rejected(self):
        payload = {"name": "ccuh-demo", "enabled": True}
        self.assertEqual(self.request("POST", "/worker", payload,
                                      {"Origin": "https://example.invalid"})[0], 403)
        self.assertEqual(self.request("GET", "/events", headers={"Host": "example.invalid"})[0], 403)
        self.assertEqual(self.request("GET", "/worker")[1]["worker"]["revision"], 0)

    def test_invalid_json_wrong_content_type_and_oversized_bodies_fail(self):
        self.assertEqual(self.request("POST", "/worker", raw=b"{", headers={
            "Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/events", raw=b"{}", headers={
            "Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/events", raw=b"x" * (lab.MAX_BODY_BYTES + 1), headers={
            "Content-Type": "application/json"})[0], 413)
        self.assertEqual(self.request("POST", "/missing", payload={})[0], 404)

    def test_restart_starts_a_new_empty_run(self):
        self.request("POST", "/worker", {"name": "ccuh-demo", "enabled": True})
        snapshot = self.request("GET", "/events")[1]
        other = lab.create_server(0)
        try:
            self.assertNotEqual(snapshot["run_id"], other.lab_state.run_id)
            self.assertEqual(other.lab_state.current_worker()["revision"], 0)
            self.assertEqual(other.lab_state.snapshot()["events"], [])
        finally:
            other.server_close()


if __name__ == "__main__":
    unittest.main()
