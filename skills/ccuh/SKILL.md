---
name: ccuh
description: Verify the intended native app and window, then use one bounded official re-selection when the target differs during a bundled Computer Use task. Apply only alongside actual Computer Use, not ordinary coding, setup, searches, or unrelated tools.
---

# CCUH

Use the intended task target even when the user selects another window. An official `App` handle is app-scoped; retaining it does not pin a window. A matching title is a selection condition, not an app approval or stable window ID.

## Load the target helper

Read [the runtime](../../dist/recognition/runtime.js) as text and execute its contents unchanged through `mcp__cua_repl.js`. It declares `var ccuh` and performs no UI action when loaded. Inspect `ccuh.sourceHash` to identify the loaded source. Do not import filesystem modules, execute the helper through another UI engine, or modify the supplied `cua` API.

Load once per REPL lifetime, again after `js_reset`, and when the installed helper changes. The normal first-call requirements of Computer Use still apply. A first app acquisition may be necessary before bootstrapping; perform no typing, clicking, or sending through that handle until the guard is ready. Browser-only tasks retain their documented Tab binding and do not need a native app helper.

## Bind the intended target

Obtain the app through the normal `cua.getApp()` approval flow. Reuse the same returned object for the task's windows. If acquisition is denied or incomplete, stop; neither hook context nor a matching name transfers approval to another handle or backend.

Derive the expected app name and window condition from the user's task and actual observations. Do not adopt the current foreground window as the task target. If the intended window is ambiguous, request the missing distinction rather than guessing.

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

If a menu or selection does not match the fresh observation, stop and report the mismatch immediately. Retry only after new evidence changes the conditions. Keep the user's input target intact; do not substitute app activation, global keys, private AX access, or another engine for a failed official route.

This is an agent workflow connected through skill discovery and CUA-only hook context. It does not force arbitrary CUA JavaScript through the helper, and it does not authorize work outside the user's request. Do not invoke CCUH monitoring or app discovery for other tools or after the Computer Use task ends.
