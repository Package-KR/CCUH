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

CCUH is currently being developed for **Codex App and Codex CLI on macOS only**. Computer Use must be available in the Codex client.

Building from source requires **stable Rust, Cargo, and Xcode or Command Line Tools**. The CCUH hooks run as a compiled Rust executable. Computer Use continues to run the generated JavaScript through its official runtime.

Windows support may be explored in the future if circumstances allow; there is no confirmed plan yet.

## How It Works

CCUH receives the official Computer Use `PreToolUse` and `PostToolUse` events. It records invocation identifiers, timing and minimal recovery metadata. Raw JavaScript, screen content and error messages are excluded from these records.

| Function                 | Behavior                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Invocation observation   | Connects matching call and return events and classifies pending, returned, failed and unconfirmed results.            |
| Limited read recovery    | Wraps supported standalone reads on a confirmed App object and permits one alternate read after a recognized timeout. |
| Bounded waiting          | Caps official CUA execution waits at 30 seconds and stops starting read recovery work after its 20-second budget. |
| Repeated-call protection | Stops duplicate or unsafe follow-up calls when a previous result is failed or unconfirmed.                            |

Supported reads are `getAXState()`, `getScreenshot()` and `getAXStateAndScreenshot()`. CCUH keeps official app approvals in place and does not add window activation or input commands. On macOS, the read methods share the same native state backend; recovery is a bounded retry after a transient failure.

Automatic recovery applies to a single standalone read statement such as `await app.getAXState();`. Code that stores the result in a variable or combines multiple operations receives the wait limit and outcome observation, but is not rewritten to use an alternate read.

CUA JavaScript execution requests are capped at 30 seconds. A shorter requested timeout is preserved, with one second reserved before that limit for supported read handling. The official runtime can wait for native requests already in progress, so the internal read budget alone does not guarantee a tool return. The official execution timeout is the outer wait bound; it does not acknowledge native cancellation. Unconfirmed operations block further app work in the same chat, including later turns. A metadata-only check can establish that the original read Promise settled only while its runtime state remains available. A kernel reset can discard that state, in which case the result stays unconfirmed. Late settlement never proves task success.

## Build

Run from the repository root to prepare the executable used by the plugin hooks:

```bash
cargo build --locked --release --bin ccuh-hook && mkdir -p bin && cp target/release/ccuh-hook bin/ccuh-hook
```

After installing or updating the plugin, review and trust its two hooks in Codex. Hook trust is separate from app access approval.

## License

[MIT](LICENSE)
