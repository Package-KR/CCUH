<div align="center">

# CCUH

A macOS companion for app recognition and failed in-app actions in Codex Computer Use.

[English](README.md) | [한국어](README.ko.md)

**Under development. The previous implementation has been removed.**

</div>

## The Problem

Computer Use can connect to the wrong app or window, fail to enter text, or return from an action without the intended result. CCUH focuses on identifying these failures and helping the agent recover with evidence rather than repeating the same attempt silently. Existing app access restrictions and the user's input target must remain effective.

## Development

This repository contains an architecture scaffold and an experimental receiver. Automatic reception and exclusion checks for unrelated tools have been verified within the scope recorded in the development checklist. Browser operations alone do not establish that a call occurred outside Computer Use. There is no MCP server, app or window operations, skill, or native engine. Planned releases cover only this experimental scope.

Development is organized into common integration, app recognition, and in-app interaction. The next task is to inspect actual tool results and determine which failures can be observed reliably before adding recovery behavior.

The domain checklist, completion criteria, verification results, and observation limits are maintained in [the development checklist](docs/DEVELOPMENT.md).

## Releases

Pushes to `dev` run CI. Changes reaching `main` run the shared CI before `github-actions[bot]` creates the version commit, tag, and GitHub Release. The first release starts at `0.0.0`; later releases increment the patch version. Release titles use `v.0.0.0` format; Git tags use `v0.0.0`.

If publication fails after the tag is pushed, rerun the failed publish job or run Release manually with `repair_tag` set to that existing tag. This reuses the version rather than incrementing it again. GitHub Actions must be allowed to write the version commit to `main`; branch protection is not bypassed.

## Structure

| Directory          | Current responsibility                 |
| ------------------ | -------------------------------------- |
| `src/hooks/`       | Minimal receiver implementation        |
| `hooks/`           | Distributed hook entry point           |
| `.codex-plugin/`   | Plugin configuration                   |
| `.agents/plugins/` | Marketplace configuration              |
| `scripts/`         | Development and distribution utilities |
| `docs/`            | Domain checklist                       |

The planned source domains are `common`, `recognition`, and `interaction`. The receiver remains in `src/hooks/` until that migration is implemented. Only the minimal receiver hook is registered; MCP and native engine entry points are absent.

## License

[MIT](LICENSE)
