# Diagnosis and handoff

## Evidence for diagnosis

1. Start with the error type, code, failing step, and progress reported by the current official tool. A generic failure, empty response, or timeout alone does not establish an authentication error, a missing target, or whether a change ran.
2. Check the app, window, document, or tab already selected and the minimum details needed to identify the connection. Leave unrelated apps, tabs, and chats outside the investigation. Avoid collecting full logs or environment files. Never ask for secrets or repeat secrets from a raw error response.
3. Keep the last verified step, the attempted change, whether it reached the tool, and whether its actual effect was verified separate. If a status check fails, preserve the unresolved state of any earlier change.
4. If the evidence is insufficient, leave the cause unconfirmed. Limit additional checks to the official status check for the selected connection and the host's documented procedures. If documentation or tooling is unavailable, report that limitation. Do not build a separate diagnostic engine or improvise OS repairs.

Interpret error names and codes according to the current host's official contract. Treat the examples below as illustrations. Do not assume they have the same meaning on other hosts or treat them as a fixed code list.

## Failure categories

| Category | Evidence to check | What to do next |
| --- | --- | --- |
| Tool or capability unavailable | The current session lacks the required official tool or capability. | Distinguish a missing way to call the tool from a missing target app. Look for an official connection route already authorized. Before installing anything or adding a connection, verify prior approval and the official procedure. |
| Initialization issue | The official response explicitly identifies a session that has not started, a missing initialization step, or a version mismatch. | For example, do not assume `noActiveSession` means authentication failed. Check the current host's initialization sequence and support conditions. Determine whether recovery would launch another app or require access beyond the current scope. |
| Authentication issue | The official response explicitly identifies failure to authenticate the caller or to sign in to an account. | For example, distinguish `senderProcessNotAuthenticated` from account sign-in. A generic connection failure alone does not justify signing in again or asking for credentials. Identify who actually needs to act in the official recovery procedure. |
| OS permission issue | The official tool or OS explicitly reports that access permission was not granted or is pending. | For example, distinguish `permissionsNotGranted` from `permissionsPending`. Explain only which permission is required and who must grant it. Avoid resetting permissions or making broad settings changes based on a guess. |
| Connection lost | Transport closure or disconnection is confirmed for the selected connection. | Distinguish disconnection from a missing variable reference or failed target lookup. Check the official reconnection conditions while preserving the earlier change's state. Restoring a connection does not establish whether the earlier change succeeded or ran at all. |
| Target missing or unclear | An official lookup could not find the target or there is insufficient information to distinguish multiple candidates. | Distinguish the tool's failure to find a target from the app actually being absent. Verify only the identifying details needed. Keep the original target and avoid substituting a new window or duplicate document. |
| Unsupported | The current official route is confirmed to lack support for the platform, window state, element, or requested action. | Look for an official alternative for the same target that stays within the request scope and protects the user's work. An API's existence alone does not establish support. Do not substitute a separate input engine. |
| Denied by policy | The official response reports an organizational policy, a safety restriction, or an explicit denial of use. | Keep the denial distinct from a missing OS permission or a technical failure. Report the scope that was denied and respect it across apps, aliases, and connections. |
| User interruption or control handoff | The official tool confirms a user interruption, intervention, or handoff signal. | Stop further input and leave control with the user. An interruption alone does not establish that a change already sent was canceled or that the requested task is complete. |
| Unclear outcome | The response to a change already sent was interrupted or its actual effect cannot be verified. | Do not resend the same change. Determine what supported status checks and cancellation can establish, then follow the [execution-state guidance](../../ccuh/references/execution-state.md). |

More than one category can apply. If a connection drops while an earlier change's outcome is unclear, retain both states. If the error wording and the observed state conflict, keep both pieces of evidence and leave the cause unresolved.

## Who acts and what is authorized

| Who acts | Applicable actions | Limits |
| --- | --- | --- |
| AI directly | Analyze existing errors and state, check the selected connection's official status, carry out documented initialization or reconnection within the existing authorization, and resume a step confirmed not to have run. | Act only within the original request, current approval, and tool safeguards. Recovery does not justify resending input or interfering with the user's work. Reuse approvals already granted. |
| AI after additional approval | Use official tools to install, add a connection, change settings, or expand the request scope when the existing approval does not cover it and the AI can perform the action. | First check the scope of existing approval. If more is needed, explain exactly what would change, the target, and why. Get approval immediately before the action. A request for diagnosis alone does not authorize a change. |
| User directly | Complete an identity check that the service requires them to perform, enter a secret such as a password or verification code, or grant approval that the OS or tool requires them to provide directly. | Hand off only the step they have to perform. The AI handles any remaining initialization, verification, and resumption it can perform. Never ask the user to send a secret in chat. |

Do not assign an action based on its risk or name alone. If the AI has authorization and can use the official tool, it acts. Hand off steps that require the user or that the AI cannot access. Policy prohibitions still apply even if the user gives approval.

## Recovery and resumption

1. Before recovery, establish whether the work is in progress, whether any change was sent, and whether its outcome is still unclear. Use the supported wait or status check for work in progress. Starting a new execution does not serve as a status check.
2. Carry out the actions available within the official procedure and existing approval. Follow the official contract and verified state for retry conditions and when to stop. Avoid repeating a failed action without new evidence. Do not use resets, reconnects, a change of operator, or deletion of safeguard records to bypass tool restrictions.
3. If a step requires the user, give them the one action to take now and the reason, then hand over control for that step. Avoid asking them to change multiple settings at once or resubmit the original task.
4. After the user acts, use an official status check to verify whether it resolved the issue. The user's confirmation that they performed the step does not establish that the connection recovered, a change was canceled, or the requested effect occurred. Leave the state unverified if it cannot be checked.
5. Compare the effect currently visible on the same target with the remaining work and skip steps that already ran. Resume only steps confirmed not to have run and allowed by the official tool's safeguards and existing approval. If the outcome is still unclear, do not resend the same change.

If you need a new UI observation or recovery input, return to the [main skill](../../ccuh/SKILL.md) and first apply [Work target](../../ccuh/references/target.md), [User work protection](../../ccuh/references/user-work-protection.md), [Input target](../../ccuh/references/input-target.md), and [Execution state](../../ccuh/references/execution-state.md). Keep the capabilities and permissions of default and watch modes in effect during diagnosis and recovery.

## Handoff and reporting

- Briefly distinguish the confirmed error and evidence, the last verified target and step, actions attempted, and any changes with unclear outcomes. Label suspected causes as such.
- Say whether the AI can act now, the AI needs additional approval, or the user must act directly. When the user needs to act, give them only the one action to take now.
- Report diagnosis and the original task's completion separately. Classifying the cause or restoring the connection does not by itself complete the requested task.
- If official status checks or recovery are unavailable and work cannot continue, record the specific limitation and the remaining step. Carry forward any unresolved state and the restriction on resending changes in the handoff.
