# Protecting the user's work

Read this before the first UI observation. Reapply it when the input method or visibility changes. Stay within the scope confirmed by the [target](target.md) and [execution state](execution-state.md) guidance.

## Default mode

Choose a method that lets the user keep using the keyboard and mouse on the same computer. Use a default input method that does not rely on showing the work window or taking the user's focus.

1. When the task needs a new surface, prefer a separate work window or tab that the official tool can open and address in the background. Keep the user's existing windows, tabs, and focus in place. Use a minimized work window when the host supports opening and operating it without taking focus. For an existing target, preserve the window or tab the user requested.
2. Check which official actions work for the chosen target and window state, including observation, clicking, scrolling, and value changes as needed. Choose actions that leave the user's input and screen undisturbed. Distinguish documented support from what has been verified in practice.
3. If that method cannot produce the requested effect, diagnose the limitations of the current approach. Do not silently switch to activating a window, sending global keystrokes, or using another app. Report completion only for work whose support has been confirmed.

Every supported task must be possible in default mode. Mark support for a platform or app as confirmed only after verifying that it meets this requirement.

## What to protect during input and observation

| Area | How to choose a method |
| --- | --- |
| Keyboard and input focus | Prefer an official method that sends input to the exact element. Avoid global keystrokes if they could reach the app the user is using. Taking focus and restoring it still counts as interference. |
| Mouse | Prefer an official method that targets the intended element without moving the pointer or sending a global click. Use coordinate-based input only through a supported method that leaves the user's actions undisturbed, and only after confirming the actual receiving window and current coordinate system. |
| Screen and workspace | In default mode, preserve the user's foreground window and active workspace. For hidden, minimized, or obscured windows, check the tool's actual observation and input support for the current window state before proceeding. |
| Clipboard | Leave the user's shared clipboard unread and unchanged as an input method unless the user has asked you to work with the clipboard itself. If the official tool provides per-target clipboard isolation, verify what it guarantees. If direct input fails, avoid falling back to paste from the shared clipboard. Saving and restoring it still does not establish that the user's work was undisturbed. |

Before sending the next input, check the [input target](input-target.md). If the API replaces the existing value, construct the new value within the requested scope and preserve unrelated edits made by the user.

## Watch mode

- Watch mode is off by default. Enable it only at the user's request. Show the actual app or browser window you are working in using the official display feature.
- Show the actual work window. If the host lacks support for displaying it, state the limitation and avoid presenting a recreation, a set of screenshots, or another window as the work window.
- Watch mode changes visibility only. The input permissions, target scope, stopping conditions, and supported tasks are the same as in default mode. Do not introduce user intervention or step-by-step approval as a requirement of watch mode.
- Prefer a display method that preserves the user's focus and workspace. Preserve fullscreen and the existing window layout. A request to see the work does not authorize restoring a fullscreen window to normal, resizing it, or moving a tab to another window.

For an external browser, use a documented display or tab selection action for the identified work tab. Confirm that the work tab is selected in the same visible window and that its window state is unchanged. Focusing a window or capturing a tab screenshot is insufficient evidence that the work tab is visible. If no supported method can display and verify that tab within these limits, report the limitation.

When the user explicitly requests the Codex in-app browser, show its work tab with the official visibility controls available on the current host. Use the bound tab's `providerTabId` if the app can show that tab in the current chat's panel. A request marked `queued` indicates acceptance. Confirm that the same work tab is actually visible before reporting success. If the work tab cannot be addressed or its display remains unconfirmed, report the limitation and leave the selected target in place.

## When input conflicts with the user's work

Continue through a separately addressable work target while the user uses another app, window, or tab, including a different window or tab in the same app. If the official tool asks for a fresh observation, recheck the work target and any previous action before continuing. Treat an explicit interruption, control handoff, or confirmed input conflict according to the tool's recovery procedure.

Stop further input if you confirm interference or interruption. Follow the [execution state](execution-state.md) guidance to check the outcome of any input already sent. Do not resend input whose outcome is unclear. While the user is still entering input, avoid overwriting the same element or taking back control from the user.

## Verify the result

Check the requested effect and any observable signs of interference on the same target. Matching before-and-after states are insufficient evidence that focus, mouse, screen, or clipboard activity stayed unchanged throughout the task. Treat any protection that was not independently measured as unverified.
