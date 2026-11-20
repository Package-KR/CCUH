# Execution ownership and task state

`codex-computer-use-helpers` and `ccuh-doctor` share these rules. Read them before the first UI observation or input, and reapply them when the connection, execution owner, or task state changes. Doctor can analyze an error response without accessing the UI. Apply the same prerequisites before making a new UI observation or sending input during recovery.

Use official tool responses and supported status checks to determine whether an operation ran. Do not add separate authentication for the execution owner, a connection manager, a global ledger, or a permanent locking mechanism.

## Execution ownership and connections

1. Check the current host's official initialization instructions for the permitted chat, execution owner, and session scope. If the host restricts native UI operations to the main chat that requested them, perform them only in that chat. Respect the restriction when considering a subagent or a different chat.
2. Assign one execution owner to make changes for the current task. Do not send conflicting changes to the same target in parallel. Check the progress and outcome of the preceding change before sending the next one.
3. Reuse the selected connection. Verify the target independently of the connection or variable name. Follow the [target guidance](target.md) to confirm the exact target and scope.
4. Carry forward the original request scope and the last confirmed state whenever the execution owner or connection changes. Keep tracking any change in progress without resending it as new work.

If the tool reports that another task is using the target, that input is in progress, or that a connection is duplicated, stop sending changes and follow the documented status and waiting procedures. Do not send the same change through another alias, connection, browser, or chat, or forcibly release another task's control. These rules serialize the current task's operations and address confirmed conflicts. Avoid promising detection or blocking of activity in chats outside your observation.

## How to respond to tool status

Classify an error by whether the change reached the tool and whether its outcome can be confirmed.

| Confirmed evidence | Next action |
| --- | --- |
| The tool rejected the change before sending it and confirmed that it sent no input | Resolve the reason for rejection and recheck the current target and input details. Try again if existing authorization and the official procedure permit it. A generic error or timeout alone is insufficient evidence of rejection before dispatch. |
| The tool reports that work is in progress | Hold the same change and any conflicting follow-up. Use supported waiting and status checks to confirm that the operation has settled. |
| The change call returns normally | Check the requested effect again on the same target. Report completion only after confirming the effect. If you cannot confirm it, keep the outcome marked as unclear. |
| The response to a dispatched change is interrupted or its outcome is unclear | Do not resend the change. Use supported status and cancellation procedures and hand off to doctor. A timeout alone is insufficient evidence of cancellation or non-execution. |
| Only a query failed and it sent no change | Follow the official error procedure for queries on the selected connection. Avoid creating a permanent lock based on a query failure alone. If the outcome of an earlier change was unclear, preserve that state. |

Preserve the earlier change's execution state if a status query fails. The failed query and an unchanged screen are each insufficient evidence that the change was never sent. If the tool has restricted observation or reconnection, honor that safeguard. Do not bypass it with a separate tool to guess the outcome.

## When the outcome is unclear

- Stop further changes. Distinguish the last confirmed target, the step attempted, the evidence of dispatch, the status reported by the tool, and the effects you have yet to confirm. Carry that state into [doctor](../../ccuh-doctor/SKILL.md) and preserve the progress of the original task.
- Do not use a reset, reconnection, change of execution owner, or deletion of existing safeguard records to make the same change eligible for replay. Carry any change with an unclear outcome into a handoff to another chat.
- A late response or the return from a cancellation request is insufficient to resolve an unclear outcome on its own. Check what the official tool confirms, then use supported methods to compare the actual effect on the original target with the work that remains.
- Skip steps whose effects the status check confirms. Repeat a necessary step only if you confirm that it never ran and the tool's safeguards and official procedures permit a retry. If you cannot determine whether it ran, keep the outcome marked as unclear and report the action needed.

Doctor determines who can diagnose or recover the task and what authorization applies. Avoid repeating a failing action without new evidence or investigating apps, chats, or logs outside the request under the guise of checking status.

## Normal cleanup and reconnection

1. Before reporting completion, confirm the requested effect on the same target. Follow the [target guidance](target.md) for the target and scope of that check.
2. Check for changes still in progress or with unclear outcomes. While any remain, preserve the safeguards and treat the task as incomplete.
3. When work finishes normally, follow the host's documented cleanup procedure. Clean up only the connections and resources owned by the current task. If the tool offers no separate shutdown API, avoid inventing a shutdown call or a procedure for releasing your own reservation.
4. If you confirm a disconnect, reconnect through the official recovery procedure and verify the original target and scope. A missing variable reference, absent tab, or failed query alone is insufficient evidence of a disconnect. Do not reconnect in a way that bypasses safeguards for changes with unclear outcomes.
5. After recovery or a user action, check the current state and continue with the unfinished work. Confirm any earlier change's success or cancellation independently of connection recovery.

## Related guidance

- Follow the [target guidance](target.md) for app, window, document, and tab identification, request scope, and supported window states.
- Follow the [user work protection guidance](user-work-protection.md) for keyboard, mouse, screen, and clipboard protection and for handling confirmed interference.
- Follow the [input target guidance](input-target.md) to use a fresh observation and the correct target for each input. Avoid adding custom reference tokens or expiry storage.
- Hand off to [doctor](../../ccuh-doctor/SKILL.md) when an error blocks work or the user requests a separate diagnosis. Keep diagnosis conditional during normal work.
