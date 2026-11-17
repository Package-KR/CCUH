import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("ccuh_wait_typing", Path(__file__).resolve().parents[1] / "lab/wait_typing.py")
waiter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(waiter)


class TypingReadinessTests(unittest.TestCase):
    def entries(self, age=1, focused=True, fullscreen=False):
        started = datetime.now(timezone.utc) - timedelta(seconds=age)
        return [
            {"run_id": "owned", "seq": 1, "event": "typing_test_started",
             "timestamp_utc": started.isoformat(), "monotonic_ns": 900000000000000000,
             "phase_deadline_monotonic_ns": 900000020000000000,
             "probe_key_window": focused, "probe_is_frontmost": focused,
             "editor_is_first_responder": True, "probe_window_fullscreen": fullscreen},
            {"run_id": "owned", "seq": 2, "event": "text_changed", "typing_phase": "typing",
             "typing_text_event_count": 1, "timestamp_utc": datetime.now(timezone.utc).isoformat()},
        ]

    def test_different_process_clock_epochs_do_not_extend_typing_window(self):
        result = waiter.ready(self.entries(), "owned")
        self.assertEqual(result["status"], "typing_ready")
        self.assertGreater(result["remaining_seconds"], 17)
        self.assertLess(result["remaining_seconds"], 20)

    def test_expired_window_without_completion_notification_is_rejected(self):
        self.assertIsNone(waiter.ready(self.entries(age=30), "owned"))

    def test_wrong_run_or_focus_or_fullscreen_is_not_ready(self):
        self.assertIsNone(waiter.ready(self.entries(), "different"))
        self.assertIsNone(waiter.ready(self.entries(focused=False), "owned"))
        self.assertIsNone(waiter.ready(self.entries(fullscreen=True), "owned"))

    def test_completion_after_input_cannot_trigger_old_work(self):
        entries = self.entries()
        entries.append({"run_id": "owned", "seq": 3, "event": "typing_test_completed"})
        self.assertIsNone(waiter.ready(entries, "owned"))

    def test_cross_space_trial_requires_a_received_space_change(self):
        entries = self.entries()
        self.assertIsNone(waiter.ready(entries, "owned", require_space_change=True))
        entries[0]["space_change_count"] = 1
        self.assertEqual(waiter.ready(entries, "owned", require_space_change=True)["status"], "typing_ready")


if __name__ == "__main__":
    unittest.main()
