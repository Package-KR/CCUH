<div align="center">

# CCUH

A macOS companion for reliable app and window targeting in Codex Computer Use.

[English](README.md) | [한국어](README.ko.md)

**Under development. The previous implementation has been removed.**

</div>

## The Problem

Users should be able to keep working while Codex Computer Use operates on the intended app and window. App access restrictions must remain effective, and a change in the user's foreground app must not redirect the agent's task.

## Development

This repository currently contains an architecture scaffold. It has no runnable MCP server, hooks, skill, or native engine. Installation and releases are paused.

Development starts with one prerequisite: prove that a real Computer Use request automatically reaches CCUH while preserving app access restrictions and the user's focus from the first call. Window discovery and actions follow only after that prerequisite passes.

The ordered milestones and completion criteria are maintained in [the development plan](docs/DEVELOPMENT.md).

## Structure

| Directory          | Intended responsibility                        |
| ------------------ | ---------------------------------------------- |
| `src/codex/`       | Codex integration and activation boundary      |
| `src/mcp/`         | MCP contracts and tool registration            |
| `src/macos/`       | Native process and session coordination        |
| `src/hooks/`       | Hook implementation                            |
| `swift/`           | macOS accessibility implementation             |
| `hooks/`           | Distributed hook entry points                  |
| `skills/ccuh/`     | Instructions for authorized Computer Use tasks |
| `.codex-plugin/`   | Plugin configuration                           |
| `.agents/plugins/` | Marketplace configuration                      |
| `bin/`             | CLI entry points                               |
| `scripts/`         | Development and distribution utilities         |
| `dist/`            | Generated distribution output                  |
| `docs/`            | Development plan                               |

The directories reserve responsibilities only. They do not imply implemented functionality. Repository settings and the existing toolchain declarations remain available, with runtime entry points disabled.

## License

[MIT](LICENSE)
