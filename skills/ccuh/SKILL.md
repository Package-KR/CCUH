---
name: ccuh
description: Verify the intended native app and window, use bounded official re-selection, check input or click results, and retry eligible local draft replacement once during a bundled Computer Use task. Apply only alongside actual Computer Use, not ordinary coding, setup, searches, or unrelated tools.
---

# CCUH

Use the intended task target even when the user selects another window. An official `App` handle is app-scoped; retaining it does not pin a window. A matching title is a selection condition, not an app approval or stable window ID.

## Load the target helper

Read [the runtime](../../dist/recognition/runtime.js) as text and execute its contents unchanged through `mcp__cua_repl.js`. It declares `var ccuh` and performs no UI action when loaded. Inspect `ccuh.sourceHash` to identify the loaded source. Do not import filesystem modules, execute the helper through another UI engine, or modify the supplied `cua` API.

Load once per REPL lifetime, again after `js_reset`, and when the installed helper changes. The normal first-call requirements of Computer Use still apply. A first app acquisition may be necessary before bootstrapping; perform no typing, clicking, or sending through that handle until the guard is ready. Browser-only tasks retain their documented Tab binding and do not need a native app helper.

## Bind the intended target

Obtain the app through the normal `cua.getApp()` approval flow. Reuse the same returned object for the task's windows. If acquisition is denied or incomplete, stop; neither hook context nor a matching name transfers approval to another handle or backend.

Derive the expected app name and window condition from the user's task and actual observations. Do not adopt the current foreground window as the task target. If the intended window is ambiguous, request the missing distinction rather than guessing.

An app-only binding can observe a legitimate sheet with an empty window title. It does not identify that sheet: check its unique observed sheet ID and required controls again inside the action callback. A binding that requires a specific window remains blocked when the title is absent. Do not drop a required window condition merely to get past a mismatch.

Create a binding with explicit inputs:

```javascript
var target = ccuh.createTarget({
  requestId: 'task-target-1',
  app,
  appName: expectedAppName,
  windowTitle: expectedWindowTitle,
  maxAgeMs: 1000,
  reselect: async context => ccuh.selectWindowFromMenu(context, observedWindowMenuLabel, expectedWindowTitle),
});
```

The menu label must come from the same app's observed menu bar, such as its localized Window menu. Supply `reselect` only when that route is supported by current evidence. If there is no such route, omit it and report the blocked target. A title shared by several possible windows is insufficient; obtain a distinction before acting.

`selectWindowFromMenu` returning `true` means its selection call returned. The guard's subsequent fresh observation determines whether the target actually matches.

## Check before acting

Use `ccuh.withTarget(target, async ({ app, state }) => { ... })` for each native action. It reads full fresh state, classifies the target, and runs the callback only after a match. Derive element indexes inside that callback from `state`; never reuse indexes from before the guard or another app object. Keep one logical native action in each callback.

The helper can call the supplied official re-selection route once when the app matches but its window differs, then reads and checks the result again. It does not recover unknown targets, app mismatches, or access failures. `prepareTarget(target)` provides the same target check as a summary; it is not a durable permission to act later. `withTarget` always checks again.

Read the returned `recognition`, `recoveryAttempts`, and `recovered` fields. `blocked` means the action callback did not run. `executed` means the callback returned, and its `recognition` describes the subsequent target observation; it does not prove that a save, send, or other app operation succeeded. Confirm the requested outcome from official fresh state. A callback exception is not retried, and an uncertain send or save must not be repeated automatically.

## Verify an input or click result

Use `ccuh.withVerifiedTarget(target, action, verify)` when the requested result can be checked in full AX snapshots. Keep the same approved App handle and derive action indexes from the supplied fresh `state`. The action callback runs at most once. The verifier receives only `{ before, after }` strings and must compare the specific requested effect without sending input or making more app calls.

Return `true` only for evidence of the requested transition, `false` when that transition is not observed, or `'unknown'` when the evidence is insufficient or ambiguous. A changed tree alone is insufficient. Existing matching text in `before`, a cleared draft, an enabled button, or a returned click is not proof that a new message was sent, a file was saved, or a server operation completed. For sends, require new matching evidence that was absent before, and keep uncertainty if the UI cannot distinguish it.

Read both `status` and `outcome`:

- `status: 'blocked'` means the action was not attempted because preparation or callback validation did not pass.
- `status: 'checked'` means one action was attempted and a post-action observation was requested. It is not a success claim.
- `outcome.invocation` separately records `'returned'` or `'threw'`. A thrown call may already have applied its effect, so the helper still observes afterward.
- `outcome.status: 'confirmed'` means the verifier matched the requested transition in the same target's fresh AX state.
- `outcome.status: 'not-observed'` means no AX change or no matching transition at that observation. It is not proof of permanent failure or permission to retry.
- `outcome.status: 'unknown'` means the target or observation could not be confirmed, the verifier threw, or the verdict was inconclusive.

Identical before/after snapshots skip the verifier and return `no-observable-change`. A post-action target mismatch skips verification and returns unknown without reselecting the target. Operations whose intended effect closes or changes the target cannot be confirmed through this same-target path. The helper does not poll, retry, infer denial from exception text, or persist snapshots and exception bodies. Async verifier callbacks retain the same-App busy guard until they finish.

Emit the fixed result summary when reporting a check; do not dump the supplied snapshots. Keep using `withTarget` for target-guarded reads and operations without an AX-verifiable postcondition, and report their outcome limits explicitly.

## Replace a local draft with a bounded retry

Use `ccuh.setDraftValue(target, { effect: 'local-draft', fieldId, value, readValue })` only for an authorized local draft whose exact replacement does not submit, persist, send, or trigger an external operation. If those semantics are unknown, use the one-shot path instead. This API calls only the same official App's `setValue(index, value)`; it does not retry arbitrary action callbacks, typing, pasting, appending, toggling, saving, or submitting. The effect declaration does not grant app access or prove the field is safe.

Take `fieldId` from the actual field's AX ID metadata. It is a selector, not a physical window identity or access approval. The helper requires one editable row with that ID and a unique numeric index in the fresh full snapshot. Missing IDs, duplicate or ambiguous rows, unreadable values and invalid indexes stop without guessing. `readValue({ row, state })` must synchronously read that same field's string value from the supplied snapshot only. It must not query or operate apps. Return undefined when parsing is uncertain; do not turn absence or placeholder text into an empty value.

The supported ID token starts the rendered element body or follows a comma. An `ID:` mention separated only by whitespace inside a value, label, description or help text is insufficient. Additional ID-like mentions make the row ambiguous and stop replacement. Serialized AX text can still make an unescaped value containing `, ID:` indistinguishable from metadata; the delimiter check does not authenticate the field. If the value and metadata cannot be distinguished, return undefined and use the one-shot observation path without automatic replacement.

The helper performs at most two setter calls in one invocation. An already observed desired value skips writing. Otherwise it captures the baseline value and first index, attempts once, and observes again. A second attempt requires a normal return, the baseline value still unchanged, the same unique field selector and a changed valid index. Before writing again it obtains another fresh matched observation and checks those conditions again. A delayed first effect skips the second attempt; an unexpected value stops to avoid overwriting a user edit. Any setter exception stops even if the desired value is later observed. Unknown targets, changed fields and unchanged references also stop.

Read `attempts` as setter calls, `lastInvocation` as the last setter's return or exception, and `observedValue` as a relation to the desired/baseline value. `status: 'observed'` means the requested value was present in AX; it does not attribute the change to a particular attempt or prove persistence. `blocked` means no setter was called; `stopped` means no further setter will be called. The app-wide busy guard spans preparation, both attempts, all observations and value readers.

Never call the helper repeatedly or create a new target merely to reset its limit. Stop on its fixed reason and report it. Fresh AX checks do not provide atomic compare-and-set: a user edit after the last check or a late app update remains possible. This workflow reduces blind replay but cannot promise zero interference or saved/server-side completion.

If a menu or selection does not match the fresh observation, stop and report the mismatch immediately. Retry only after new evidence changes the conditions. Keep the user's input target intact; do not substitute app activation, global keys, private AX access, or another engine for a failed official route.

This is an agent workflow connected through skill discovery and CUA-only hook context. It does not force arbitrary CUA JavaScript through the helper, and it does not authorize work outside the user's request. Do not invoke CCUH monitoring or app discovery for other tools or after the Computer Use task ends.
