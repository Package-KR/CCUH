# Confirm the work target

Apply this guidance before selecting the initial target or observing the UI. Recheck if the requested target, window, document, or tab changes. Use the official tool's targeting and inspection contract. Do not introduce a separate target identification scheme.

## Request scope and existing targets

- Use the app, browser, window, document, tab, and scope specified by the user. If the user provided an official reference or identifier, resolve it using the procedure for that host. Keep the specified target even if another name or URL is similar.
- For work inside a browser page, use the browser and profile the user specified. If none was specified, prefer an existing external browser session that fits the task. Check for its official connection and use tab-scoped actions when available. Use app-wide controls for browser interface work only when they can address the intended target safely.
- Use the Codex in-app browser only when the user explicitly requests it. If the selected browser or profile is unavailable through official tools, report the limitation and keep the selected target.
- If the user asks to work on an open target, reuse it. If it cannot be located, do not conceal that by switching apps or browsers or by creating a new window, tab, or duplicate document.
- Opening an app, creating a document, or navigating to a page is in scope when the user requests it. Distinguish these actions from creating a substitute because the existing target could not be found. If an official recovery procedure creates a new target, first check that the original request authorizes it.

## Select the target before observing content

1. Narrow the scope using the host's official metadata and targeting APIs. Start from the known app or browser and query only the lists you need. Keep the content of unrelated apps and tabs outside the search.
2. Compare the current identifiers, titles, URLs, and window or document details returned by the official tool against the request. Require platform-specific values such as PIDs or start tokens only where the current path requires them. Matching titles or URLs alone are insufficient to choose among multiple candidates.
3. If the candidates are indistinguishable, identify what information is still needed to tell them apart. Avoid guessing by broadening content capture to the full screen or another app. Limit the first observation that requires UI content to the selected target.

For a browser tab mention, use the official procedure to match the current browser and tab information. Keep the explicitly specified browser or profile. In native apps, verify the requested window and document in addition to the app.

When the user identifies a window by state, focus, or recency, verify that qualifier through the official window metadata and confirm that the tab or document belongs to that window before opening, claiming, or reading it. For browser content, use the browser connection's window and tab metadata where available. A matching title or URL in a browser-wide list cannot verify which window the user meant. If the qualifier cannot be verified, report which part of the target is unconfirmed without returning another window's contents as the result.

Reuse target information from the selected official connection and the latest observation when available. Gather a fresh full list only when needed.

## Target changes and result verification

- Before observing or sending input, confirm that the current connection points to a target within the requested scope. Follow [Input target](input-target.md) to select and refresh the input element.
- After an operation, use the latest official tool state to verify the target and the requested effect. Check user-requested navigation or document switches against the expected destination. Treat a title or URL change as a mismatch only when it conflicts with the expected target.
- If you detect an unexpected target change, stop further observation and input. Do not report content from another target as the result. Keep the explanation to the mismatch and the last verified step.
- Stay within the original request scope when finding the target again or recovering the connection. Rediscovery alone provides no evidence that the previous change failed. Follow [Execution state](execution-state.md) to determine whether a dispatched change ran and whether it can be retried.
- Before-and-after checks confirm the target at those points only. Apply [User work protection](user-work-protection.md) for interference and display decisions.

## Window state and support

Check whether the selected official path supports accurate observation and the required input when windows are hidden, minimized, or multiple windows are open. Base the decision on verified support for the required operation in that state.

If an official alternative works on the same target, choose it within the requested scope and user-work protection requirements. Apply [User work protection](user-work-protection.md) to assess interference from window display, focus changes, and input. Consult [Doctor](../../ccuh-doctor/SKILL.md) if the target cannot be confirmed or the task cannot proceed through a supported method.
