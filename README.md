<div align="center">

# CCUH

A macOS companion for reliable app and window targeting in Codex Computer Use.

[English](README.md) | [한국어](README.ko.md)

**Under development. The previous implementation has been removed.**

</div>

## The Problem

Users should be able to keep working while Codex Computer Use operates on the intended app and window. App access restrictions must remain effective, and a change in the user's foreground app must not redirect the agent's task.

## Development

This repository contains an architecture scaffold and an experimental receiver. Automatic reception and exclusion checks for unrelated tools have been verified within the scope recorded in the development checklist. Browser operations alone do not establish that a call occurred outside Computer Use. There is no MCP server, app or window operations, skill, or native engine. Planned releases cover only this experimental scope.

Development starts with one prerequisite: prove that a real Computer Use request automatically reaches CCUH while preserving app access restrictions and the user's focus from the first call. Window discovery and actions follow only after that prerequisite passes.

The five development stages, completion criteria, verification results, and observation limits are maintained in [the development checklist](docs/DEVELOPMENT.md).

## Releases

Pushes to `dev` run CI. Changes reaching `main` run the shared CI before `github-actions[bot]` creates the version commit, tag, and GitHub Release. The first release starts at `0.0.0`; later releases increment the patch version. Release titles use `v.0.0.0` format; Git tags use `v0.0.0`.

If publication fails after the tag is pushed, rerun the failed publish job or run Release manually with `repair_tag` set to that existing tag. This reuses the version rather than incrementing it again. GitHub Actions must be allowed to write the version commit to `main`; branch protection is not bypassed.

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

The directories reserve responsibilities only. They do not imply implemented functionality. Only the minimal receiver hook is registered; MCP and native engine entry points are absent. Repository settings and the existing toolchain declarations remain available.

## License

[MIT](LICENSE)
