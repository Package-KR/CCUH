---
name: ccuh
description: Verify the intended native app and window, use one bounded official re-selection when the target differs, and check the observed result of an input or click during a bundled Computer Use task. Apply only alongside actual Computer Use, not ordinary coding, setup, searches, or unrelated tools.
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

If a menu or selection does not match the fresh observation, stop and report the mismatch immediately. Retry only after new evidence changes the conditions. Keep the user's input target intact; do not substitute app activation, global keys, private AX access, or another engine for a failed official route.

This is an agent workflow connected through skill discovery and CUA-only hook context. It does not force arbitrary CUA JavaScript through the helper, and it does not authorize work outside the user's request. Do not invoke CCUH monitoring or app discovery for other tools or after the Computer Use task ends.
