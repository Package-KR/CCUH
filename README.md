<div align="center">

# CCUH

**Codex Computer Use Helpers**

A macOS plugin for existing Chrome tab workflows and supported Codex Computer Use recovery.

[English](README.md) | [한국어](README.ko.md)

</div>

> [!WARNING]
> **Public preview.**
>
> Requires the host's documented browser Computer Use interface. OS focus/Spaces blocking and atomic prevention of unrelated content collection are not guaranteed.

## About

CCUH includes:

- **ccuh:** Reuse an existing tab by exact URL, restrict supported actions to that target, and stop uncertain operations without creating replacement windows.
- **ccuh-doctor:** Connection diagnostics, reversible CLI repair, and Codex restart after a saved checkpoint and idle-work check.
- **Development tools:** Dummy screens, input measurement, and automated tests. Excluded from the release ZIP.

Requires macOS, a working Chrome Computer Use connection in the current chat, and Python 3.9+ for Doctor. CCUH does not install the host browser interface. Related requests may select the skill automatically; it does not intercept every Computer Use call.

With Codex CLI installed:

```sh
codex plugin marketplace add dijeungi/CCUH --ref v0.0.10
codex plugin add ccuh@ccuh
```

In a new chat, select Chrome and the `ccuh` skill, then request: “Use the existing `https://example.com/settings` tab to change …; keep my current focus and stop if the supported background path is unavailable.” Use `ccuh-doctor` for a blocked connection. [Official Chrome setup](https://learn.chatgpt.com/docs/chrome-extension)

Actual Chrome tests cover inactive tabs, minimized windows, and typing in another Desktop, plus native authentication recovery after an actual Codex restart. These are tested cases, not universal guarantees. URL checks can block a mismatched result from being returned after capture; they cannot make host capture/input atomic. [Evidence and current compatibility](https://github.com/dijeungi/CCUH/blob/v0.0.10/lab/results/release-0.0.10.json)

## License

[MIT](LICENSE)
