---
name: ccuh-doctor
description: Diagnose Codex Computer Use failures, reversibly repair selected CLI overrides, and restart Codex after a checkpoint and idle-work check. Use for CCUH recovery requests, startup or authentication failures, lost targets, and unknown timeout outcomes.
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
- `browser_setup_unavailable` means the supplied error reports missing host browser initialization. The recovery helper blocks CLI repair for this response; use the host's documented browser setup instead. Changing a CLI override does not provide a missing browser surface.
- Report the detected category, the last confirmed stage, and the relevant next check in the user's language. Preserve `unverified` when live authentication, target access, or the task outcome was not tested.

The helper returns 0 for completed metadata inspection or no detected response error, 1 for a detected failure/unknown timeout outcome, and 2 for invalid input. Handle these as diagnostic results, not reasons to rerun the command repeatedly.

## Recover a supported CLI selection failure

When recovery is authorized, use [the bundled recovery helper](scripts/recovery.py). By default it supports only a `CODEX_CLI_PATH` override pointing to a missing executable. It preserves existing official and custom executables, verifies the real official CLI's code signature and team, writes a private rollback backup, and checks the plan's original-value/runtime preconditions before applying it.

For the macOS future-process environment, prepare a concrete plan with `python3 "<installed-skill-directory>/scripts/recovery.py" --repair-plan --launchctl --plan-file "/private/tmp/ccuh-repair-plan.json"`. Inspect the result before applying the supported change with `--apply "/private/tmp/ccuh-repair-plan.json" --backup-file "/private/tmp/ccuh-repair-backup.json"`. Use fresh paths: plans and backups are never overwritten. `--restore BACKUP` is available when rollback is requested and its preconditions still hold. Pass the already selected `--response-file` when available; timeout/unresolved outcomes block repair.

For the specific native error `-10000: Sender process is not authenticated`, an existing ad-hoc CLI override can also be removed with an explicit opt-in. First confirm which source selected that CLI for the failed call. Prepare the same plan command with `--remove-adhoc-cli-override --response-file "/path/to/observed-native-error.json"`. The evidence must contain the exact native error; a generic login/authentication category is insufficient. The helper requires a valid executable Mach-O with a verified ad-hoc signature and no Team ID, and rechecks the evidence, candidate hash/signature, official runtime, and selected source before applying. A failed signature check leaves the override preserved. The executable itself is never changed or deleted. Inspect and apply the resulting private plan with the same `--apply` command above; retain its rollback backup.

The launchctl backend affects future processes, not the current app/session. It does not edit config.toml or other override sources; clearing an unrelated source does not establish repair. Do not restart an app with unconfirmed work. Report a required fresh process separately from the repair result, then repeat the same native read of the approved target through the documented Computer Use path. Only a successful native read establishes authentication recovery for that tested path. The helper deliberately leaves `current_connection: unverified` after changing a source. The `--environment-file` backend is an isolated launcher fixture, and `--startup-drill` proves only executable startup, not native authentication recovery.

For an authorized isolated launcher startup test, run `--startup-drill` **instead of** the separate `--repair-plan`/`--apply` sequence. The selected JSON fixture must still contain `CODEX_CLI_PATH` pointing to a missing executable; an already repaired fixture is rejected. The drill runs CLI `--version`, prepares and applies the fixture repair with a rollback backup, then runs `--version` again. It requires `--environment-file`, `--plan-file`, and `--backup-file`; `--evidence-file` optionally saves the result:

```sh
python3 "<installed-skill-directory>/scripts/recovery.py" --startup-drill \
  --environment-file "/path/to/selected-launcher.json" \
  --plan-file "/private/tmp/ccuh-startup-plan.json" \
  --backup-file "/private/tmp/ccuh-startup-backup.json" \
  --evidence-file "/private/tmp/ccuh-startup-evidence.json"
```

Use fresh paths for all outputs. Even a blocked `--repair-plan` can create its plan file, so choose a new path when retrying. This startup test changes only the selected fixture and starts CLI child processes; it does not restart the Desktop or verify native authentication.

The helper also gates independent optional-capability probes and permission waits with `--predispatch`; it does not rewrite UI requests, drop visibility settings to force foreground work, grant permissions, or retry pending native operations. A signature check failing inside a sandbox is unconfirmed, not proof of invalid signing; repair requires an execution context where verification succeeds.

## Restart the running Desktop after repair

When restarting Codex is authorized, use [desktop_recovery.py](scripts/desktop_recovery.py) after repairing the actual selected source. Restarting only the engine may reuse a stale `CODEX_CLI_PATH` inherited by the Desktop parent. The helper requests normal termination of the exact Desktop instance, waits for it to exit, launches the official app without activation, and verifies a new official engine. It never force-quits or opens a second instance while the old app remains.

Before preparing a plan, collect fresh status metadata from the actual Desktop, confirm other chats and background work are idle, and finish all native calls. An idle chat label alone does not establish that its background terminals stopped. When the available API cannot inspect them, use the user's explicit confirmation; do not interrupt another chat to make it idle. Any unknown mutation or pending native operation blocks restart. Save this chat's ID and completed stage in a private checkpoint. The current turn may be designated for restart only after that checkpoint is ready.

Run `python3 "<installed-skill-directory>/scripts/desktop_recovery.py" --help` for the plan contract. Create fresh private checkpoint and idle-evidence files, then prepare a private plan with `--plan PLAN --receipt RECEIPT --expected-desktop-pid PID --expected-engine-pid PID --thread-id UUID --checkpoint FILE --idle-evidence FILE --background-work-confirmed-idle`. Review it and run `--execute PLAN`. A separate worker rechecks the source, signatures, process identities, and fresh evidence before termination and records its stages in the receipt. Preserve the checkpoint and receipt across the restart.

The optional resume message is limited to the same existing chat and uses the public deep link and queue command. Queue acceptance does not prove the chat resumed; interrupted or unloaded chats may require the user to reopen them. Do not replay an uncertain mutation or repeatedly enqueue prompts. After reconnection, create fresh Computer Use handles and repeat the same approved target read in this chat. Only that read establishes native recovery. A new engine PID or a successful app launch alone is insufficient. Keep live Desktop restart verification separate from actual authentication-failure recovery evidence.

Do not replace binaries, rewrite unrelated configuration, expand permissions, or bypass authentication. Any actual UI connection check must follow the user's selected target and current Computer Use instructions. The development lab and native measurement app are not required for this feature.
