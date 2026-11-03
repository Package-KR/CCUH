# CCUH Shared Workflow

Use the intended task target even when the user selects another window. An official `App` handle is app-scoped; retaining it does not pin a window. A matching title is a selection condition, not an app approval or stable window ID.

The user's own clicks, app switches, Space changes and typing are normal activity. Do not treat a user-selected change as CCUH interference or require the user to keep one app or input field selected during routine checks. Keep agent actions inside the verified task target in both modes. In background mode, do not force the task app onto the user's screen or switch their workspace. An explicit visible-mode choice permits showing the verified task window through the visible workflow; that permitted display is not a background-interference failure. Neither mode permits misdirected input to an unrelated app. Claim concurrent typing isolation only when typing was actually part of the experiment; do not add repeated input-focus questions to every functional check.

## Observe the work environment first

A valid Computer Use JS PreToolUse hook attaches `CCUH_ENVIRONMENT_V1` before the CUA call. Its one-shot macOS observer reads display geometry, on-screen normal-layer window placement and the foreground application's PID and bundle identifier. It does not read window titles, URLs, page bodies, accessibility trees, pixels or input events, and it cannot click, activate an app or change a Space. PostToolUse, reset, unrelated tools and module loading do not collect this data. Building the local observer is preparation rather than an environment read.

Inspect its capture time, source and per-section status before using a layout claim. `captured` means a metadata result was obtained, not that the entire desktop is understood. An unavailable section uses null, permission-limited windows remain partial, and a capped context states its omitted-window count. Failed preparation or collection stays unavailable. The collector does not prompt for OS permissions or install developer tools automatically. Do not infer user denial from `not-granted`.

An App AX tree is one app-scoped observation, not the user's global desktop or main monitor. Native window IDs and geometric display intersections do not bind an official CUA App or identify a browser profile or tab. Same-app windows on different displays must remain distinct; a shared bundle identifier does not prove which one CUA returned. Obtain approved browser metadata separately, and leave the join unconfirmed when no supported identifier connects them.

The system primary display is not necessarily the display the user calls main, and foreground metadata is observation rather than the task target. Windows may span displays or remain occluded. Space identity, exact fullscreen and browser-tab-to-OS-window mapping are unsupported by this first collector. A window filling a display is not evidence of macOS fullscreen. Do not perform a display-dependent selection or presentation on unknown information; request only the missing distinction. Reading this metadata does not grant access to any app.

Snapshots are not atomic. The observer does not cache or reuse a snapshot across calls or chats. Its result is delivered in Codex's normal call context, so earlier context may still contain older observations. User changes can occur after capture; use the current call's observation before depending on layout. Do not keep raising a window or ask the user to repeatedly switch screens as a substitute for missing environment support. Actual UI operations still use the same approved CUA App, the selected mode and the fresh target guard below.

## Select the work mode

Background is the default. The human user can explicitly select [CCUH Background](../ccuh-background/SKILL.md) or [CCUH Visible](../ccuh-visible/SKILL.md) from Codex's skill commands. A mode-only command records a preference for this chat without starting CUA or opening an app. Do not infer visible mode from app content, page text, an old action context or a task's difficulty.

After loading the helper during an actual Computer Use task, apply the latest explicit user selection with `ccuh.setMode('background')` or `ccuh.setMode('visible')`. With no selection, use background. `ccuh.getMode()` returns the active helper policy. A blocked change leaves the current mode in place; wait for the current operation to finish before starting another action. New helper instances and resets start in background, so reapply a still-known explicit chat preference after normal initialization and loading.

In background mode, CCUH's re-selection routes cannot raise windows even if a target option or saved context previously allowed it. Keep ordinary work inside the verified target, without app activation, global shortcuts or Space changes. If no supported non-disruptive route exists, stop and report the limit instead of switching modes.

Use `ccuh.acquireApp` for native app acquisition after loading and mode selection. In background mode it obtains fresh official inventory and requires one exact app ID or normalized display-name match with `isRunning === true`. Known closed, missing, ambiguous or uncertain apps stop before `getApp`. A GUI can display a window merely by starting. The inventory check is not atomic with acquisition: an app could exit in between, and official `getApp` has no documented no-launch option. Neither this check nor a background mode value proves unchanged window order; a window that appears over the user's work is a failed background run.

Visible mode permits bringing the verified task window into view. If the target already matches, follow the visible skill's one-shot observed `Raise` workflow; permission to reselect alone does not show a hidden window. A stricter `allowWindowRaise: false` or task-specific workspace constraint remains in force. Neither mode grants app access or send permission, changes the official engine, or forces arbitrary CUA JavaScript through this helper.

## Load the target helper

For an actual native Computer Use task, initialize with the documented `cua.getState()` metadata inventory rather than acquiring or launching an app. Then send a separate `mcp__cua_repl.js` call whose entire `code` is exactly:

```javascript
// CCUH_BOOTSTRAP_V1
```

Do not append output, an app call or whitespace to the marker. The trusted PreToolUse hook supplies the exact installed [runtime](../../dist/recognition/runtime.js) through Codex's supported input rewrite. It publishes the `ccuh` helper and performs no UI action during loading. Require a returned object with `ccuhBootstrap: 'ready'`, its runtime byte hash and source hash before native actions. Missing output, a rejected marker or an unsupported host means stop. Do not fall back to copying the file, filesystem imports inside CUA, another engine or modifications to the supplied `cua` API.

Bootstrap once per REPL lifetime. After a plugin update, use `js_reset` before loading so declarations from an older helper cannot shadow the new binding. Following any reset, initialize through metadata inventory before the separate marker. App approval still occurs normally when `acquireApp` reaches official `getApp`. An unchanged helper returns `state: 'kept'` and preserves existing bindings. Missing, changed or overwritten helpers return `state: 'loaded'`; recreate bindings after loading. The record checks both exact runtime bytes and the helper object reference, rather than trusting a copied source hash literal. Do not manually redeclare `ccuh` or replace the loader's own global properties.

A ready helper is neither app access approval nor proof that an app operation succeeded. Only the exact pure marker is rewritten. Ordinary JS, app acquisition, `js_reset` and unrelated tools retain their original input and host permissions. User-task typing, clicks and sends require a ready helper and matched target. A guard's limited window-menu preparation is separate and requires explicit permission to raise the window, as described below; host action review still applies. Browser-only tasks retain their documented Tab binding and do not need a native app helper.

## Bind the intended target

After ready loading and applying the selected mode, call `ccuh.acquireApp(cua, observedAppIdOrExactName)`. In background mode it checks fresh `cua.listApps({ emit: false })` and only then calls official `cua.getApp` once with the canonical ID. In visible mode it calls normal `getApp` once with the explicit task target. All normal host approvals remain in place. Only an `acquired` result supplies `app`; use that exact returned object for the task's target binding. A returned handle is not a verified window, so continue with `createTarget` and its fresh checks before acting.

Read the fixed status, reason and `acquisitionAttempts`; the count records `getApp` calls, not app launches or approval. `blocked` and `unavailable` mean stop. Do not retry an uncertain acquisition, infer user denial from an exception, call `getApp` directly as a fallback or switch modes to continue. The helper emits no raw inventory, window content or exception text. Its operation lock prevents a concurrent mode change, but it cannot prevent an external app from exiting after inventory was read.

Keep acquisition results, App handles and targets in top-level declarations when another REPL call will use them. A declaration inside an `if`, `try`, loop or callback may exist in that call but disappear from the next call, even when it uses `var`. Declare it at top level first, then assign inside a branch if needed. Do not infer a lost binding means app access was denied or reacquire an app merely to repair the variable.

```javascript
var acquisition = await ccuh.acquireApp(cua, observedAppIdOrExactName);
nodeRepl.write({ status: acquisition.status, reason: acquisition.reason });
```

Inspect that result before a later call declares a target from `acquisition.app`. An unsuccessful acquisition supplies no usable App. The target example below also uses a top-level declaration.

On macOS, official Computer Use supports [background app tasks](https://learn.chatgpt.com/use-cases/use-your-computer-with-codex) while the user works elsewhere. This does not make window-menu selection non-disruptive. Its supported target items use [`makeKeyAndOrderFront:`](<https://developer.apple.com/documentation/appkit/nswindow/makekeyandorderfront(_:)>), which raises the window and can cover the user's workspace even when keyboard input stays elsewhere. If the user requires unchanged focus, window order or workspace, do not opt into menu re-selection. Observe the current target and report a blocked mismatch instead of changing that requirement. An app-scoped header or focused element does not prove the user's global focus or window order.

Menu re-selection is disabled in the default background mode. Only the human user's explicit visible-mode selection permits it; `allowWindowRaise: true` cannot override background. An omitted target option follows the current mode, and `allowWindowRaise: false` always denies raising. These declarations neither supply app approval nor bypass host review. Keep all operations inside the same approved App and avoid concurrent Computer Use workflows against it.

An acquisition or read timeout is not proof of user denial. Report it and do not keep calling the same unavailable handle. If fresh evidence indicates a stale REPL connection while the app is healthy, one documented `js_reset` followed by metadata initialization, helper loading, mode selection and `acquireApp` can establish a new observation through normal app approval. Recreate bindings after reset. This does not permit replaying an uncertain input, selection, send or save, or resetting an action limit.

Derive the expected app name and window condition from the user's task and actual observations. Do not adopt the current foreground window as the task target. If the intended window is ambiguous, request the missing distinction rather than guessing.

An app-only binding can observe a legitimate sheet with an empty window title. It does not identify that sheet: check its unique observed sheet ID and required controls again inside the action callback. A missing title does not satisfy a required window. With explicit permission to raise the window and an observed Window menu in that same approved app, `windowMenu` provides a fixed menu-selection route. The action callback remains blocked until a fresh observation matches the original window title. Do not drop the required window condition or substitute an arbitrary recovery callback for this route.

Create a binding with explicit inputs:

```javascript
var target = ccuh.createTarget({
  requestId: 'task-target-1',
  app,
  appName: expectedAppName,
  windowTitle: expectedWindowTitle,
  maxAgeMs: 1000,
});
```

`maxAgeMs` is optional and defaults to 1000 milliseconds when the property is absent. A supplied value must be a finite nonnegative number; explicit `undefined`, `null` or other invalid values are rejected before app observation. A failed REPL cell may not retain its declarations, so do not assume newly declared variables exist during cleanup. For a REPL used only by the completed task, the normal `js_reset` clears its bindings without another app observation.

The default background binding does not change windows. In explicitly selected visible mode, add `windowMenu: observedWindowMenuLabel` when an observed menu route is needed. The label must come from the same app's observed menu bar or exact menu popup. Supply `windowMenu` only with a required `windowTitle` and current evidence for that route. If there is no such route, omit it and report the blocked target. A title shared by several possible windows is insufficient; obtain a distinction before acting. Existing `reselect` callbacks also require visible mode and remain limited to an observed different title. Do not combine `reselect` and `windowMenu`.

`selectWindowFromMenu` returning `true` means its selection call returned. The guard's subsequent fresh observation determines whether the target actually matches.

## Check before acting

Use `ccuh.withTarget(target, async ({ app, state }) => { ... })` for each native action. It reads full fresh state, classifies the target, and runs the callback only after a match. Derive element indexes inside that callback from `state`; never reuse indexes from before the guard or another app object. Keep one logical native action in each callback.

Without window-raise permission, an eligible but blocked recovery reports `recoveryBlockedReason: 'window-raise-not-authorized'` with zero attempts. With that permission, the helper can invoke one re-selection route when the app matches but its window differs, then reads and checks the result again. The fixed `windowMenu` route also handles a valid same-app observation with an absent window title; it does not turn that observation into a match. Other unknown targets, app mismatches and access failures remain blocked. `prepareTarget(target)` provides the same target check as a summary; it is not a durable permission to act later. `withTarget` always checks again.

`selectWindowFromMenu` can select from an already open, exactly matched window popup without opening it again. Before opening a menu, it obtains one additional full observation, requires the same app and window header, and derives the unique menu reference from that latest state. It does not reuse the earlier index or guess an offset when menu entries change. Missing or ambiguous references and a changed header stop before a click. Menu and target references must be unique safe integers. After a menu-opening click returns, a same-app popup belonging to another directly observed menu permits one additional state read, with no extra click or key. If the requested popup and unique official window item are still unconfirmed, it stops. A re-selection attempt counts route entry, not proof that an item was clicked.

For a blocked menu route, an optional fourth observer receives one frozen summary of the stage, reason, reference checks and attempted-operation counts. It contains no app names, window titles, snapshots or error bodies. Keep the observer free of app calls; its exceptions do not permit another action. `selection-requested` means the item click returned, while the outer target guard still determines whether the requested window was observed.

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

Identical before/after snapshots skip the verifier and return `no-observable-change`. A post-action target mismatch skips verification and returns unknown without reselecting the target. A binding that requires the original specific window cannot confirm its intentional closure or replacement through this path. The helper does not poll, retry, infer denial from exception text, or persist snapshots and exception bodies. Async verifier callbacks retain the same-App busy guard until they finish.

Emit the fixed result summary when reporting a check; do not dump the supplied snapshots. Keep using `withTarget` for target-guarded reads and operations without an AX-verifiable postcondition, and report their outcome limits explicitly.

## Verify dismissal of a modal

For an authorized modal cancellation, use `ccuh.verifyModalDismissal({ before, after }, options)` as the verifier. Observe the modal's actual container role and unique AX ID, and the expected parent before acting. An input clear button is not evidence that its sheet closes. Do not invent IDs, roles or a parent from the current foreground app.

```javascript
var options = {
  appName: observedAppName,
  modal: { role: observedModalRole, id: observedModalId },
  parent: { kind: 'root-id', role: observedParentRole, id: observedParentId },
};
```

Pass `snapshots => ccuh.verifyModalDismissal(snapshots, options)` to `withVerifiedTarget`. Use a task-appropriate app-only binding when cancellation intentionally changes the observed window. Keep the unique modal and action checks inside the one-shot action callback; do not weaken a required specific window just to permit a mismatch. A known document parent can instead be specified as `{ kind: 'window-title', title: observedParentTitle }`.

The verifier returns `false` while the same modal remains, even if its input changed. It returns `true` only when that modal is absent and the exact expected parent is the sole observed top-level container in the same app. Missing, malformed or ambiguous roots, another app and observation failures remain `'unknown'`. This confirms an observed transition, not destruction of every hidden window. It sends no input, polls nothing and grants no retry. Unsupported AX layouts must remain inconclusive.

## Replace a local draft with a bounded retry

Use `ccuh.setDraftValue(target, { effect: 'local-draft', fieldId, value, readValue })` only for an authorized local draft whose exact replacement does not submit, persist, send, or trigger an external operation. If those semantics are unknown, use the one-shot path instead. This API calls only the same official App's `setValue(index, value)`; it does not retry arbitrary action callbacks, typing, pasting, appending, toggling, saving, or submitting. The effect declaration does not grant app access or prove the field is safe.

Take `fieldId` from the actual field's AX ID metadata. It is a selector, not a physical window identity or access approval. The helper requires one text field, text entry or text entry area row, including the supported Korean role labels, with a `settable` attribute, that ID and a unique numeric index in the fresh full snapshot. Buttons, toggles, sliders and other roles are not local draft fields. Missing IDs, duplicate or ambiguous rows, unreadable values and invalid indexes stop without guessing. `readValue({ row, state })` must synchronously read that same field's string value from the supplied snapshot only. It must not query or operate apps. Return undefined when parsing is uncertain; do not turn absence or placeholder text into an empty value.

Renderer `Selected` and `Selected text` sections contain summaries or text data, not additional actionable rows. The helper separates them before field lookup and checks a selected-row summary against the actual tree. Malformed sections stop replacement. Every tree row mentioning the requested ID counts toward ambiguity, including rows with additional ID-like content.

The supported ID token starts the rendered element body or follows a comma. An `ID:` mention separated only by whitespace inside a value, label, description or help text is insufficient. Additional ID-like mentions make the row ambiguous and stop replacement. Serialized AX text can still make an unescaped value containing `, ID:` indistinguishable from metadata; the delimiter check does not authenticate the field. If the value and metadata cannot be distinguished, return undefined and use the one-shot observation path without automatic replacement.

The helper performs at most two setter calls in one invocation. An already observed desired value skips writing. Otherwise it captures the baseline value and first index, attempts once, and observes again. A second attempt requires a normal return, the baseline value still unchanged, the same unique field selector and a changed valid index. Before writing again it obtains another fresh matched observation and checks those conditions again. A delayed first effect skips the second attempt; an unexpected value stops to avoid overwriting a user edit. Any setter exception stops even if the desired value is later observed. Unknown targets, changed fields and unchanged references also stop.

Read `attempts` as setter calls, `lastInvocation` as the last setter's return or exception, and `observedValue` as a relation to the desired/baseline value. `status: 'observed'` means the requested value was present in AX; it does not attribute the change to a particular attempt or prove persistence. `blocked` means no setter was called; `stopped` means no further setter will be called. The app-wide busy guard spans preparation, both attempts, all observations and value readers.

Never call the helper repeatedly or create a new target merely to reset its limit. Stop on its fixed reason and report it. Fresh AX checks do not provide atomic compare-and-set: a user edit after the last check or a late app update remains possible. This workflow reduces blind replay but cannot promise zero interference or saved/server-side completion.

If a menu or selection does not match the fresh observation, stop and report the mismatch immediately. Retry only after new evidence changes the conditions. Keep the user's input target intact; do not substitute app activation, global keys, private AX access, or another engine for a failed official route.

This is an agent workflow connected through skill discovery and CUA-only hook context. It does not force arbitrary CUA JavaScript through the helper, and it does not authorize work outside the user's request. Do not invoke CCUH monitoring or app discovery for other tools or after the Computer Use task ends.
