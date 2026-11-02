<div align="center">

# CCUH

A macOS companion for app recognition and failed in-app actions in Codex Computer Use.

[English](README.md) | [한국어](README.ko.md)

**Under development. The previous implementation has been removed.**

</div>

## The Problem

Computer Use can connect to the wrong app or window, fail to enter text, or return from an action without the intended result. CCUH focuses on identifying these failures and helping the agent recover with evidence rather than repeating the same attempt silently. Existing app access restrictions and the user's input target must remain effective.

## Development

This repository contains an architecture scaffold and an experimental receiver. Hooks observe the supported Computer Use calls before invocation and after a returned result, without storing code or UI content. Actual automatic reception and exclusion checks for unrelated tools have been verified within the scope recorded in the development checklist. Browser operations alone do not establish that a call occurred outside Computer Use. There is no MCP server, app or window operations, skill, or native engine. Planned releases cover only this experimental scope.

Development is organized into common integration, app recognition, and in-app interaction. Result observation is implemented; app recognition and recovery are next. A returned result is not proof that an app action succeeded. In the live thrown-error probe, no post-hook receipt was observed for that call in the tested environment, so its return remained unobserved.

The domain checklist, completion criteria, verification results, and observation limits are maintained in [the development checklist](docs/DEVELOPMENT.md).

## Releases

Pushes to `dev` run CI. Changes reaching `main` run the shared CI before `github-actions[bot]` creates the version commit, tag, and GitHub Release. The first release starts at `0.0.0`; later releases increment the patch version. Release titles use `v.0.0.0` format; Git tags use `v0.0.0`.

If publication fails after the tag is pushed, rerun the failed publish job or run Release manually with `repair_tag` set to that existing tag. This reuses the version rather than incrementing it again. GitHub Actions must be allowed to write the version commit to `main`; branch protection is not bypassed.

## Structure

| Directory          | Current responsibility                 |
| ------------------ | -------------------------------------- |
| `src/common/`      | Invocation and result observation      |
| `src/recognition/` | App recognition placeholder            |
| `src/interaction/` | In-app failure handling placeholder    |
| `hooks/`           | Distributed before and after entries   |
| `.codex-plugin/`   | Plugin configuration                   |
| `.agents/plugins/` | Marketplace configuration              |
| `scripts/`         | Development and distribution utilities |
| `docs/`            | Domain checklist                       |

Only the two observation hooks are registered; MCP and native engine entry points are absent. The receiver retains the latest start, invocation, and result metadata under `~/.codex/ccuh/receiver/`. Match session and call hashes before relating records; these latest files are not a complete history of concurrent calls. Error flags are recorded only when present as booleans, and missing results remain unknown.

## License

[MIT](LICENSE)
