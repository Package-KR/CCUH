---
name: ccuh-doctor
description: Diagnose Codex Computer Use connection failures and reversibly repair supported missing-executable overrides. Use for CCUH recovery requests, startup errors, authentication failures, lost targets, and unknown timeout outcomes.
---

# CCUH connection diagnostics

This is a user-facing feature bundled with CCUH. Use it on request or when a connection failure blocks a CCUH task. Normal UI tasks do not need a diagnostic run. Diagnosis reads metadata or one selected response; the separate recovery helper changes only a specifically selected, supported environment source.

## Run a focused check

Use the helper relative to this skill's installed directory. Quote filesystem paths. Python 3.9 or later is required; there are no third-party Python dependencies. If Python is unavailable, report that the scripted check could not run and classify the supplied error manually without claiming a helper result or installing software automatically.

For an environment check, run:

```sh
python3 "<installed-skill-directory>/scripts/doctor.py" --format text
```

For a failed response already available in the task, prefer the explicitly selected response file:

```sh
python3 "<installed-skill-directory>/scripts/doctor.py" --response-file "/path/to/selected-response.json" --format text
```

The CLI also accepts `--response-file -` for stdin and `--format json` for structured output. Do not embed raw responses, tokens, or page content into shell command text. When no selected file is available, summarize the visible error directly; do not search unrelated logs or the full transcript to obtain an input file. Only write a minimal temporary response if the task's permitted local file workflow requires it.

## Explain the result

- Distinguish executable/startup errors, process authentication, app/OS permission, target lookup, capture failure, and timeout. The helper's categories are heuristics for the supplied evidence, not proof of the underlying product cause.
- A command exiting with 0 does not override a nested `isError: true`. Likewise, an error-free response or installed binary does not prove that Computer Use works.
- A lookup failure does not establish that the target closed. Keep the original target; do not create a replacement window as a diagnostic step.
- A timeout leaves the operation outcome unknown. Do not repeat a mutation or creation whose result is uncertain.
- Report the detected category, the last confirmed stage, and the relevant next check in the user's language. Preserve `unverified` when live authentication, target access, or the task outcome was not tested.

The helper returns 0 for completed metadata inspection or no detected response error, 1 for a detected failure/unknown timeout outcome, and 2 for invalid input. Handle these as diagnostic results, not reasons to rerun the command repeatedly.

## Recover a supported startup failure

When recovery is authorized, use [the bundled recovery helper](scripts/recovery.py). It supports a `CODEX_CLI_PATH` override pointing to a missing executable. It preserves existing official and custom executables, verifies the real official CLI's code signature and team, writes a private rollback backup, and checks the plan's original-value/runtime preconditions before applying it.

For the macOS future-process environment, prepare a concrete plan with `python3 "<installed-skill-directory>/scripts/recovery.py" --repair-plan --launchctl --plan-file "/private/tmp/ccuh-repair-plan.json"`. Inspect the result before applying the supported change with `--apply "/private/tmp/ccuh-repair-plan.json" --backup-file "/private/tmp/ccuh-repair-backup.json"`. Use fresh paths: plans and backups are never overwritten. `--restore BACKUP` is available when rollback is requested and its preconditions still hold. Pass the already selected `--response-file` when available; timeout/unresolved outcomes block repair.

The launchctl backend affects future processes, not the current app/session. Do not restart an app with unconfirmed work. Report a required fresh process separately from the repair result, then verify the intended target through the documented Computer Use path. The `--environment-file` backend and `--startup-drill` are isolated launcher tests, not Codex config.toml repair or proof of native authentication recovery.

The helper also gates independent optional-capability probes and permission waits with `--predispatch`; it does not rewrite UI requests, drop visibility settings to force foreground work, grant permissions, or retry pending native operations. A signature check failing inside a sandbox is unconfirmed, not proof of invalid signing; repair requires an execution context where verification succeeds.

Do not replace binaries, rewrite unrelated configuration, expand permissions, or bypass authentication. Any actual UI connection check must follow the user's selected target and current Computer Use instructions. The development lab and native measurement app are not required for this feature.
