# Confirm and refresh the input target

Apply this guidance before sending UI input such as clicking, typing, changing a value, or scrolling. Use the latest official Computer Use observation and follow its input-target contract. Do not create separate reference tokens or an expiration store.

## Select the input target

- Use [Work target](target.md) to confirm the requested window, document, or tab before selecting the input target. Use element numbers and coordinates from the current target and connection only.
- Use an element number, node ID, semantic locator, or coordinates supported by the current official API. Use only numbers, roles, names, and locations you can verify from the latest observation. Base coordinate input on the latest view of the target and its current layout.
- If several fields or buttons are present, use the visible label and surrounding context to identify the requested element. A previously seen number or the first position in a list is insufficient to select it.
- Consider the current value and the scope of the requested edit. Replacing the entire value, inserting at the cursor, and editing the selection are distinct operations. Apply [User work protection](user-work-protection.md) to any effects on the user's input and clipboard.

## When to refresh the observation

- After navigation, a document or window switch, a dialog opening, a layout change, or a connection change, identify the input target from the current state. An unchanged number or coordinate may now refer to another element.
- After an action, request only the official state information needed for the next decision. If text state confirms the target and result, omit the full-screen capture. Inspect the target's screen when its position or layout matters.
- Group consecutive operations when the official tool supports batching and the intermediate state does not change the next input target. If an action changes the next target or screen, check the result before choosing the next action. Reserve a full observation for when it is needed instead of repeating it on every keystroke.
- Refreshing the observation alone does not establish that an earlier change with an unclear outcome was canceled or failed. Apply [Execution state](execution-state.md) when user intervention, a timeout, or a connection change affects execution state.

## Input failures and effect verification

If you cannot find the element or the input has no effect, use the current target and screen to investigate. Do not immediately repeat the same input or switch to coordinates to hide the failure. Use the actual screen changes and the official tool's error to choose a supported method.

Verify the requested change in the latest state of the same target before reporting success. A return from the input call alone is insufficient. Once the effect is verified, do not send the input again to prove the same result.

If the outcome is unclear after dispatching a change, finding a new element is insufficient reason to resend it. Preserve the last confirmed state according to [Execution state](execution-state.md) and consult [Doctor](../../ccuh-doctor/SKILL.md).
