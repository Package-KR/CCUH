---
name: ccuh
description: Find and reuse an existing browser target by exact task URL during Codex Computer Use, preserve background work, and recover supported connection failures. Use for CCUH-assisted tasks and reports of lost targets or input interference.
---

# CCUH

Keep the requested existing target bound while the user works elsewhere. Use the bundled executable target-session guard for its supported browser path, and the read-only diagnostic helper for blocked connections. The guard enforces calls through its own facade; it does not control raw host tools or implicit OS focus changes.

## Check the host browser capability

Before looking up a target, confirm that this session provides a documented browser runtime and its initialization instructions. A generic JavaScript tool or native app tool alone does not establish browser support. Follow only the host's supplied initialization procedure; if it already provides `cua`, reuse it. A non-UI `typeof cua` check may confirm an existing binding, but do not call global inventory methods to bootstrap discovery.

If the browser binding or its documented initialization is unavailable, stop this browser route and report `setup_unavailable`, the missing prerequisite, and that the requested UI change is unverified. Do not guess an import, inject runtime environment flags, switch to native whole-browser input, create a tab to test connectivity, or restart Codex to manufacture that capability. An initialization error such as `CUA_REPL_ENABLED_SURFACES is required` does not by itself establish a CLI authentication failure or authorize CLI repair. CCUH supplies guards for an available host browser interface; it does not enable a missing host surface.

## Bind the existing target

- Start with the user's exact tab mention or an already verified target reference and URL. Use the current session's documented browser interface. Follow its first-call requirements.
- Record the available browser instance, tab/window identifiers, and expected task page. A browser app name alone does not identify the user's intended tab.
- When no usable handle is available, obtain the current browser's documented management capability and define [the exact-URL discovery helper](scripts/target-discovery.js) in the same CUA runtime. Call `await CCUHDiscovery.discoverChrome(management, cua, {allowedUrls: [exactAuthorizedUrl]})`; its returned `tab` is the existing target for the guard. It queries only authorized exact URLs, checks a unique candidate's current metadata, and binds its returned provider ID. It does not require the user to supply a tab ID or bring the window forward.
- Use the narrowest documented target lookup. Do not enumerate unrelated apps/tabs or capture the whole browser. If no exact candidate exists, stop without creating a replacement. If multiple task candidates match, ask the user to choose rather than guessing.
- Initial binding can itself return page content. Choose the exact target before calling it. Keep subsequent reads, screenshots, and actions on that handle.
- Record whether the tab was user-owned or created by the agent. Follow the host's documented tab lifecycle: an ephemeral agent-created tab may close at turn end, while a released user tab may stay open. Use a documented handoff mark only for an unfinished workflow that must continue from that live page. Do not classify automatic cleanup as failure to recognize a user's existing window.
- If the tab navigates, check the permitted task page before reading content or acting. A matching tab ID alone is insufficient. If the runtime cannot guard a navigation race, disclose that strict content isolation is unverified rather than claiming it is enforced.

## Reuse rather than replace

After the host's required first call and its returned browser documentation, load [the executable target-session guard](scripts/target-session.js) in the same CUA JavaScript session. When the documented JavaScript runtime supports local file imports, import the installed helper directly instead of copying its source. This loads CCUH's helper, not a replacement host runtime:

```javascript
var ccuhSkillDirectory = "/absolute/path/to/installed/ccuh";
var ccuhFileUrl = (await import("node:url")).pathToFileURL;
await import(ccuhFileUrl(`${ccuhSkillDirectory}/scripts/target-session.js`).href);
// Only when exact-URL discovery is needed:
await import(ccuhFileUrl(`${ccuhSkillDirectory}/scripts/target-discovery.js`).href);
```

Use the actual directory containing this `SKILL.md`. If file imports are unsupported, read and define the linked self-contained source without changing its text. Both helpers perform no UI actions when loaded, and their source checks reject accidental copy changes. If loading fails, correct the helper definition before any CCUH binding or action; do not reset the runtime or its reservations. Do not import an undocumented host runtime or edit installed host code.

For a documented browser tab that exposes `url()`, `playwright.domSnapshot()`, and Playwright locators, bind `await CCUH.bindBrowserTab(existingTab, {targetId: existingTab.id, allowedUrls: [exactAuthorizedUrl]})`. This browser adapter uses DOM snapshots and has no native AX or screenshot fallback. Its `fill(label, value)`, `click(buttonName)`, `check(checkboxName, value)`, and `observe()` methods execute against that same tab. Labels and names must come from the observed target UI. Pass only explicitly authorized exact URLs; no wildcard widening.

Use the returned facade for supported reads and mutations. It checks target identity before dispatch, withholds observations until identity is rechecked, limits metadata retry, serializes operations, and locks an uncertain mutation. It exposes no tab creation, activation, restore, or global-input method. A receipt means a method returned with identity checks passed, not that the requested UI result is complete; verify that result with `observe()`.

If the required documented methods or runtime capabilities are absent, report this guarded route as unsupported rather than pretending it executed. Keep the returned facade: the runtime rejects a second binding of the same target ID and refuses to replace a different runtime revision. Do not reset the JavaScript session or start another chat to bypass an unresolved task; reservations are local to that runtime and cannot enforce locks across those boundaries. `suspend("user_space_changed")` and `interference("focus_changed")` stop later facade calls when the user or independent observer reports interference; the JavaScript guard itself does not monitor OS Spaces. URL pre/post checks do not eliminate a navigation race or prove that the host never collected other data.

- Distinguish lookup failure, confirmed absence, capture failure, and a pending/unknown result. An error or empty screenshot does not prove that the window closed.
- After a lookup failure, allow at most one narrow recheck of the same target using current metadata. If still unresolved, stop and report the blocker.
- For an existing-target task, do not recover by creating a new tab/window, opening the URL again, launching a second browser instance, or silently switching browser profiles. An explicit request to create a new workspace is a separate task.
- A timeout does not prove an action was cancelled. Do not repeat a creation or mutation whose result is unknown. If no returned handle or narrow request metadata can resolve that outcome, report it as unknown and stop rather than searching unrelated windows.

## Preserve the user's Space and input

- Treat the user's Space switch as their choice. Keep the same target and use only the supported background path. If that path fails, pause this task with a concrete limitation.
- Do not use app activation, window raising, restoring a minimized window, tab activation, new-tab shortcuts, or global input to recover this workflow. Do not widen a failed tab-scoped operation into a whole-app capture.
- Do not take focus and then restore it as a substitute for preserving input. If the runtime takes focus during connection or an action, report the interference and stop that path.
- Visibility/background options do not establish that typing focus, the selected tab, or the current Space will remain unchanged. Keep minimized, occluded, inactive-tab, and other-Space behavior separate.

## Diagnose a blocked connection

Connection diagnosis is a user-facing optional feature included in this plugin. When a connection failure blocks the task or the user requests diagnosis, read the sibling [CCUH Doctor skill](../ccuh-doctor/SKILL.md) and use its bundled helper. Normal tasks do not need to run it. If that resource is absent, report a missing diagnostic component rather than inventing a command or installing it automatically.

Use a response already supplied by the failed call or an explicitly selected diagnostic file. Do not collect unrelated logs or dump the environment. A successful environment check is not a successful connection or UI task. For a supported repair, use the sibling skill's executable recovery workflow and preserve its backup and preconditions. Diagnosis alone does not authorize unrelated configuration changes, restarts, broader observation, or authentication bypasses.

## Finish with observable results

Verify the requested change in the target UI using the current Computer Use instructions. Report completion only when that target state is visible. Otherwise report the last confirmed stage and why the same target could not be used. Do not claim zero focus changes or zero unrelated observations unless independent measurements support that claim.
