---
name: ccuh-doctor
description: Diagnose Codex Computer Use or browser connection failures, including missing tools, startup errors, authentication failures, lost targets, and unknown timeout outcomes. Use when a user asks for CCUH connection diagnostics or Computer Use cannot connect.
---

# CCUH connection diagnostics

This is a user-facing feature bundled with CCUH. Use it on request or when a connection failure blocks a CCUH task. Normal UI tasks do not need a diagnostic run. The helper reads installation metadata or one selected response; it does not operate apps, change settings, or verify a live connection.

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

Do not automatically replace binaries, rewrite configuration, restart the app, expand permissions, inspect the current browser screen, or bypass authentication. Any actual UI connection check must follow the user's selected target and the current Computer Use instructions. The development lab and native measurement app are not required for this feature.
