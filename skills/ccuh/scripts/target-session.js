/*
 * CCUH guarded existing-target session, protocol 1, runtime revision 4.
 * Paste this self-contained file into the documented CUA JavaScript runtime
 * after its required first binding call. It performs no I/O on its own.
 *
 * Adapter contract (all methods must use the SAME already-bound target):
 *   identity() -> Promise<{targetId: string, url: string}>
 *   observe({emit: false}) -> Promise<observation>
 *   fill(locator: string, value: string) -> Promise<void>
 *   click(locator: string) -> Promise<void>
 *   check(locator: string, checked: boolean) -> Promise<void>
 * Use only methods actually documented by the current CUA/browser session.
 * Locators are adapter-defined strings grounded in the observed target UI.
 * bindBrowserTab(tab, policy) supplies the documented browser adapter: fill
 * uses an exact accessibility label; click uses an exact button name; check
 * uses an exact checkbox name. Its locator strings are not CSS selectors.
 * Browser observations use only playwright.domSnapshot(), returning its string
 * without printing it. There is no native AX/screenshot fallback.
 *
 * This guard limits calls made through its facade. It cannot block raw tools,
 * prevent implicit OS focus changes inside the host, or make URL pre/post
 * checks atomic with capture/input. emit:false must be honored by the adapter;
 * it is not an assertion that the underlying host never collected other data.
 * Each target ID is reserved once in this runtime, even after a failed binding
 * or unknown mutation. There is no reset/rebind API. Reservations cannot extend
 * across CUA runtime resets or separate chats, and do not block raw tool use.
 * Before installation, a source length and FNV-1a 64-bit check detects accidental
 * copy/reordering errors. FNV is noncryptographic; this is not adversarial code
 * attestation. It requires BigInt and does not attest the adapter or host.
 * Binding requires URL, Promise, Map, WeakSet and working JavaScript timers.
 * Runtime/capability rejection occurs before an adapter call is scheduled.
 */
(function installCCUH(root) {
  "use strict";
  const EXPECTED_SOURCE_LENGTH = 15797;
  const EXPECTED_SOURCE_FNV1A64 = "40546de245a69ab4";
  if (typeof BigInt !== "function") {
    throw new Error("CCUH source integrity check requires BigInt.");
  }
  const normalizedSource = installCCUH.toString()
    .replace(/^  const EXPECTED_SOURCE_LENGTH = \d+;$/m,
      "  const EXPECTED_SOURCE_LENGTH = <length>;")
    .replace(/^  const EXPECTED_SOURCE_FNV1A64 = \"[0-9a-f]{16}\";$/m,
      "  const EXPECTED_SOURCE_FNV1A64 = <checksum>;");
  let sourceFingerprint = BigInt("14695981039346656037");
  const fnvPrime = BigInt("1099511628211");
  const uint64Mask = BigInt("18446744073709551615");
  for (let index = 0; index < normalizedSource.length; index += 1) {
    const code = normalizedSource.charCodeAt(index);
    if (code > 127) throw new Error("CCUH source integrity mismatch.");
    sourceFingerprint = ((sourceFingerprint ^ BigInt(code)) * fnvPrime) & uint64Mask;
  }
  if (normalizedSource.length !== EXPECTED_SOURCE_LENGTH ||
      sourceFingerprint.toString(16).padStart(16, "0") !== EXPECTED_SOURCE_FNV1A64) {
    throw new Error("CCUH source integrity mismatch.");
  }
  const RUNTIME_REVISION = 4;

  if (root.CCUH !== undefined) {
    if (!root.CCUH || root.CCUH.protocolVersion !== 1 ||
        root.CCUH.runtimeRevision !== RUNTIME_REVISION ||
        typeof root.CCUH.bindBrowserTab !== "function") {
      throw new Error("A different CCUH runtime is already installed.");
    }
    // Reuse the existing namespace and its reservations. Different revisions
    // must not replace it and create a fresh path around existing session locks.
    return;
  }

  class SessionError extends Error {
    constructor(code, stage) {
      super("CCUH rejected the operation: " + code + ".");
      this.name = "CCUHSessionError";
      this.code = code;
      this.stage = stage;
    }
  }

  // Only our concrete adapter can certify that a capability check failed
  // before the actual locator mutation method was called.
  const knownPreDispatchFailures = typeof WeakSet === "function" ? new WeakSet() : null;
  const targetReservations = typeof Map === "function" ? new Map() : null;

  function runtimeFailure(stage) {
    const failure = new SessionError("unsupported_runtime", stage);
    if (knownPreDispatchFailures) knownPreDispatchFailures.add(failure);
    return failure;
  }

  function requireRuntime(stage) {
    if (typeof URL !== "function" || typeof Promise !== "function" ||
        typeof Promise.resolve !== "function" || typeof Promise.race !== "function" ||
        !knownPreDispatchFailures || !targetReservations || typeof setTimeout !== "function" ||
        typeof clearTimeout !== "function") {
      throw runtimeFailure(stage);
    }
  }

  function unsupportedBeforeDispatch() {
    const failure = new SessionError("unsupported_browser_api", "dispatch");
    knownPreDispatchFailures.add(failure);
    return failure;
  }

  function canonicalUrl(value) {
    if (typeof value !== "string") throw new Error("Invalid URL");
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username || parsed.password) throw new Error("Invalid URL");
    return parsed.href;
  }

  function timeoutValue(value, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > 120000) {
      throw new SessionError("invalid_policy", "binding");
    }
    return value;
  }

  function parsePolicy(policy) {
    if (!policy || typeof policy.targetId !== "string" ||
        !policy.targetId || policy.targetId.length > 512 ||
        !Array.isArray(policy.allowedUrls) || !policy.allowedUrls.length ||
        policy.allowedUrls.length > 32) {
      throw new SessionError("invalid_policy", "binding");
    }
    let allowed;
    try {
      allowed = new Set(policy.allowedUrls.map(canonicalUrl));
    } catch (_) {
      throw new SessionError("invalid_policy", "binding");
    }
    return {
      targetId: policy.targetId,
      allowed,
      timeoutMs: timeoutValue(policy.timeoutMs, 10000),
      mutationTimeoutMs: timeoutValue(policy.mutationTimeoutMs, 15000),
    };
  }

  function copyAdapter(adapter) {
    const result = {};
    for (const method of ["identity", "observe", "fill", "click", "check"]) {
      if (!adapter || typeof adapter[method] !== "function") {
        throw new SessionError("invalid_adapter", "binding");
      }
      result[method] = adapter[method].bind(adapter);
    }
    return result;
  }

  function withDeadline(call, milliseconds, stage) {
    requireRuntime(stage);
    let timer;
    let rejectTimeout;
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
    try {
      // Set up the deadline before queuing any host call. A missing or rejected
      // timer must not leave a metadata/action call running without its guard.
      timer = setTimeout(() => rejectTimeout(new SessionError("operation_timeout", stage)), milliseconds);
    } catch (_) {
      throw runtimeFailure(stage);
    }
    const work = Promise.resolve().then(call);
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  function reportedError(value) {
    return value && typeof value === "object" &&
      (value.isError === true ||
       (value.result && typeof value.result === "object" && value.result.isError === true));
  }

  async function bindExisting(adapter, requestedPolicy) {
    requireRuntime("binding");
    const policy = parsePolicy(requestedPolicy);
    if (targetReservations.has(policy.targetId)) {
      throw new SessionError("target_already_bound", "binding");
    }
    const ports = copyAdapter(adapter);
    // Reserve synchronously before the first host call. Keep the reservation
    // even if binding or an operation fails: rebinding must not bypass a lock.
    targetReservations.set(policy.targetId, true);
    const events = [];
    let state = "active";
    let reasonCode = null;
    let busy = false;
    let lookupRetriesRemaining = 1;
    let mutationOutcome = "not_attempted";
    let mutationAttempted = false;

    function record(event, stage, action, extra) {
      const entry = {sequence: events.length + 1, event, stage};
      if (action) entry.action = action;
      if (extra) Object.assign(entry, extra);
      events.push(Object.freeze(entry));
    }

    function audit() {
      return events.map(entry => Object.freeze(Object.assign({}, entry)));
    }

    function error(code, stage) {
      const failure = new SessionError(code, stage);
      failure.audit = Object.freeze(audit());
      return failure;
    }

    function lock(code, stage, action) {
      if (state === "active") state = "locked";
      reasonCode = code;
      record("session_locked", stage, action, {code});
    }

    function ensureActive(stage) {
      if (state === "active") return;
      const code = state === "suspended" ? "session_suspended" :
        state === "interference" ? "interference_detected" : "session_locked";
      throw error(code, stage);
    }

    async function verifyIdentity(stage, action) {
      while (true) {
        ensureActive(stage);
        let targetId;
        let url;
        let causeCode = "metadata_rejected";
        try {
          const identity = await withDeadline(ports.identity, policy.timeoutMs, stage);
          ensureActive(stage);
          causeCode = "metadata_invalid_identity";
          if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
            throw new Error("Identity unavailable");
          }
          if (reportedError(identity)) {
            causeCode = "metadata_reported_error";
            throw new Error("Identity unavailable");
          }
          targetId = identity.targetId;
          if (typeof targetId !== "string" || !targetId) throw new Error("Identity unavailable");
          const rawUrl = identity.url;
          causeCode = rawUrl === undefined || rawUrl === null || rawUrl === "" ?
            "metadata_url_missing" : "metadata_url_invalid";
          url = canonicalUrl(rawUrl);
        } catch (failure) {
          ensureActive(stage);
          if (knownPreDispatchFailures.has(failure)) {
            lock("unsupported_runtime", stage, action);
            throw error("unsupported_runtime", stage);
          }
          if (failure instanceof SessionError && failure.code === "operation_timeout") {
            causeCode = "metadata_timeout";
          }
          record("identity_unavailable", stage, action, {causeCode});
          if (lookupRetriesRemaining > 0) {
            lookupRetriesRemaining -= 1;
            record("same_target_recheck", stage, action);
            continue;
          }
          lock("identity_unavailable", stage, action);
          throw error("identity_unavailable", stage);
        }
        const idMatches = targetId === policy.targetId;
        const urlMatches = policy.allowed.has(url);
        record("identity_checked", stage, action, {idMatches, urlMatches});
        if (!idMatches || !urlMatches) {
          const code = !idMatches ? "target_mismatch" : "url_not_allowed";
          lock(code, stage, action);
          throw error(code, stage);
        }
        return;
      }
    }

    function validateLocator(locator) {
      if (typeof locator !== "string" || !locator.trim() || locator.length > 2048) {
        throw error("invalid_request", "request");
      }
    }

    async function run(action, args, mutating) {
      ensureActive("request");
      if (busy) {
        record("operation_rejected", "request", action, {code: "session_busy"});
        throw error("session_busy", "request");
      }
      busy = true;
      let dispatched = false;
      let payload;
      if (mutating) {
        mutationAttempted = false;
        mutationOutcome = "not_attempted";
      }
      record("operation_started", "before", action);
      try {
        await verifyIdentity("before", action);
        ensureActive("dispatch");
        dispatched = true;
        if (mutating) {
          mutationAttempted = true;
          mutationOutcome = "unverified";
        }
        try {
          payload = await withDeadline(
            () => ports[action].apply(undefined, args),
            mutating ? policy.mutationTimeoutMs : policy.timeoutMs,
            "dispatch"
          );
          if (reportedError(payload)) throw new Error("Adapter reported failure");
        } catch (failure) {
          const notDispatched = knownPreDispatchFailures.has(failure);
          if (notDispatched) dispatched = false;
          if (mutating) {
            mutationAttempted = !notDispatched;
            mutationOutcome = notDispatched ? "not_attempted" : "unknown";
          }
          const code = notDispatched ? failure.code :
            failure instanceof SessionError && failure.code === "operation_timeout"
            ? "operation_timeout" : mutating ? "mutation_result_unknown" : "observation_failed";
          lock(code, "dispatch", action);
          const sanitized = error(code, "dispatch");
          sanitized.mutationAttempted = mutating && mutationAttempted;
          throw sanitized;
        }
        ensureActive("after");
        await verifyIdentity("after", action);
        ensureActive("return");
        record("operation_returned", "return", action);
        if (mutating) {
          // A returned adapter call and matching identity checks do not establish
          // the user's requested UI effect. Observe the target to verify it.
          mutationOutcome = "returned";
          return Object.freeze({action, outcome: "returned", identityChecksPassed: true});
        }
        return payload;
      } catch (failure) {
        if (mutating && dispatched) mutationOutcome = "unknown";
        payload = undefined;
        record("result_withheld", failure instanceof SessionError ? failure.stage : "unknown", action);
        if (failure instanceof SessionError) {
          failure.audit = Object.freeze(audit());
          throw failure;
        }
        lock("operation_failed", "unknown", action);
        throw error("operation_failed", "unknown");
      } finally {
        busy = false;
        payload = undefined;
      }
    }

    function stop(nextState, reason) {
      if (state !== "active") return status();
      state = nextState;
      const accepted = new Set(["manual", "user_space_changed", "user_input_detected", "focus_changed", "target_hidden"]);
      reasonCode = accepted.has(reason) ? reason : "unspecified";
      record(nextState === "interference" ? "interference_detected" : "session_suspended", "request", null, {code: reasonCode});
      return status();
    }

    function status() {
      return Object.freeze({state, busy, reasonCode, lookupRetriesRemaining, mutationOutcome, mutationAttempted});
    }

    record("binding_started", "binding");
    await verifyIdentity("binding", null);
    record("binding_completed", "binding");

    return Object.freeze({
      observe() {
        return run("observe", [{emit: false}], false);
      },
      async fill(locator, value) {
        validateLocator(locator);
        if (typeof value !== "string" || value.length > 1048576) {
          return Promise.reject(error("invalid_request", "request"));
        }
        return run("fill", [locator, value], true);
      },
      async click(locator) {
        validateLocator(locator);
        return run("click", [locator], true);
      },
      async check(locator, checked) {
        validateLocator(locator);
        if (typeof checked !== "boolean") {
          return Promise.reject(error("invalid_request", "request"));
        }
        return run("check", [locator, checked], true);
      },
      suspend(reason) { return stop("suspended", reason); },
      interference(reason) { return stop("interference", reason); },
      status,
      audit,
    });
  }

  async function bindBrowserTab(tab, policy) {
    let url;
    let snapshot;
    let getByLabel;
    let getByRole;
    try {
      if (!tab || typeof tab.id !== "string" || !tab.id ||
          typeof tab.url !== "function" || !tab.playwright ||
          typeof tab.playwright.domSnapshot !== "function" ||
          typeof tab.playwright.getByLabel !== "function" ||
          typeof tab.playwright.getByRole !== "function") {
        throw new Error("Unsupported browser interface");
      }
      url = tab.url.bind(tab);
      snapshot = tab.playwright.domSnapshot.bind(tab.playwright);
      getByLabel = tab.playwright.getByLabel.bind(tab.playwright);
      getByRole = tab.playwright.getByRole.bind(tab.playwright);
    } catch (_) {
      throw new SessionError("unsupported_browser_api", "binding");
    }

    function locatorMethod(locator, method) {
      if (!locator || typeof locator[method] !== "function") {
        throw unsupportedBeforeDispatch();
      }
      return locator[method].bind(locator);
    }

    return bindExisting({
      async identity() {
        return {targetId: tab.id, url: await url()};
      },
      async observe() {
        const text = await snapshot();
        if (typeof text !== "string") throw new Error("Invalid DOM snapshot");
        return text;
      },
      fill(label, value) {
        return locatorMethod(getByLabel(label, {exact: true}), "fill")(value);
      },
      click(name) {
        return locatorMethod(getByRole("button", {name, exact: true}), "click")();
      },
      check(name, checked) {
        return locatorMethod(getByRole("checkbox", {name, exact: true}), "setChecked")(checked);
      },
    }, policy);
  }

  root.CCUH = Object.freeze({protocolVersion: 1, runtimeRevision: RUNTIME_REVISION, bindExisting, bindBrowserTab});
})(globalThis);
