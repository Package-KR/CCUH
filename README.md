<div align="center">

# CCUH

A macOS companion for app recognition and failed in-app actions in Codex Computer Use.

[English](README.md) | [한국어](README.ko.md)

</div>

> [!WARNING]
> **Under active development.**

## The Problem

Computer Use can connect to the wrong app or window, fail to enter text, or return from an action without the intended result. CCUH focuses on identifying these failures and helping the agent recover with evidence rather than repeating the same attempt silently. Existing app access restrictions and the user's input target must remain effective.

## Supported Environment

CCUH is currently being developed for **Codex App and Codex CLI on macOS only**. Computer Use must be available in the Codex client, and **Node.js 24 or later** is required.

Windows support may be explored in the future if circumstances allow; there is no confirmed plan yet.

## Execution Modes

Background is the default. Select a mode for the current chat with `$ccuh-background` or `$ccuh-visible`. In Codex App, type `/` and choose **CCUH Background** or **CCUH Visible**. Codex CLI also supports `/skills`.

Both modes share the same target checks and failure handling. Background applies automatically during Computer Use when no explicit mode has been selected.

| Mode       | Behavior                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Background | Keeps CCUH from deliberately raising windows or switching the user's workspace. Stops when no supported background route is available.  |
| Visible    | Allows an explicitly selected task window to be brought into view through an exposed official action. Normal app approvals still apply. |

These modes guide CCUH within official Computer Use; they do not change its internal engine.

## License

[MIT](LICENSE)
