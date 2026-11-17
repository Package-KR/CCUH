/*
 * CCUH exact-URL existing Chrome target discovery, runtime revision 1.
 * Paste after the required CUA first call and after reading the current
 * browser management documentation. No import, file I/O or UI mutation occurs.
 *
 * Public concrete API:
 *   result = await CCUHDiscovery.discoverChrome(management, cua, {
 *     allowedUrls: ["https://task.example/settings"],
 *     knownProviderTabId: "123", // optional, only a documented returned ID
 *     previousSession: guardedSession, // optional; never replace blocked work
 *     timeoutMs: 10000 // optional, per read/binding deadline
 *   });
 *   session = await CCUH.bindBrowserTab(result.tab, {
 *     targetId: result.targetId, allowedUrls: [result.url]
 *   });
 * The existing session guard remains required for observations and actions.
 *
 * Management follows documented Chrome tabs.query({url}) / tabs.get(id).
 * Query-returned numeric tab IDs are provider IDs, not guessed CUA IDs.
 * The concrete binder uses public cua.getTab(String(providerId),
 * {browser: "chrome"}), then checks that bound tab's documented id/url().
 * Discovery queries read metadata only. Binding via cua.getTab may return its
 * automatic initial target observation; URL pre/post checks cannot make that
 * observation atomic. It does not list all tabs, request extra page snapshots,
 * create, activate, restore, change profiles or replay a mutation.
 * Inactive tabs are not filtered out.
 * A windowId is metadata; minimized/Space/focus state is never inferred.
 *
 * Only a rejected or invalid metadata lookup permits one exact rediscovery.
 * An unresolved timeout, query failure or binding failure is not retried.
 * Deadline expiry cannot cancel a host call. The caller must not replace an
 * unknown/pending operation; previousSession checks this when provided.
 * Query/binding cannot make URL checks atomic with host initial-state capture.
 * Reservations in target-session.js still apply; no reset/unlock is provided.
 * The source fingerprint catches accidental copy errors, not adversarial code.
 * FNV-1a is noncryptographic and does not attest the adapter or host.
 */
(function installCCUHDiscovery(root) {
  "use strict";
  const EXPECTED_SOURCE_LENGTH = 9671;
  const EXPECTED_SOURCE_FNV1A64 = "3274561545db0dc3";
  if (typeof BigInt !== "function") throw new Error("CCUH discovery integrity requires BigInt.");
  const normalizedSource = installCCUHDiscovery.toString()
    .replace(/^  const EXPECTED_SOURCE_LENGTH = \d+;$/m, "  const EXPECTED_SOURCE_LENGTH = <length>;")
    .replace(/^  const EXPECTED_SOURCE_FNV1A64 = \"[0-9a-f]{16}\";$/m, "  const EXPECTED_SOURCE_FNV1A64 = <checksum>;");
  let fingerprint = BigInt("14695981039346656037");
  const prime = BigInt("1099511628211");
  const mask = BigInt("18446744073709551615");
  for (let index = 0; index < normalizedSource.length; index += 1) {
    const code = normalizedSource.charCodeAt(index);
    if (code > 127) throw new Error("CCUH discovery source integrity mismatch.");
    fingerprint = ((fingerprint ^ BigInt(code)) * prime) & mask;
  }
  if (normalizedSource.length !== EXPECTED_SOURCE_LENGTH ||
      fingerprint.toString(16).padStart(16, "0") !== EXPECTED_SOURCE_FNV1A64) {
    throw new Error("CCUH discovery source integrity mismatch.");
  }
  if (root.CCUHDiscovery !== undefined) {
    if (root.CCUHDiscovery && root.CCUHDiscovery.runtimeRevision === 1) return;
    throw new Error("A different CCUH discovery runtime is installed.");
  }

  class DiscoveryError extends Error {
    constructor(code, stage, audit) {
      super("CCUH discovery stopped: " + code + ".");
      this.name = "CCUHDiscoveryError";
      this.code = code;
      this.stage = stage;
      this.audit = Object.freeze((audit || []).map(entry => Object.freeze(Object.assign({}, entry))));
    }
  }

  function exactUrl(value) {
    if (typeof value !== "string" || value.includes("*")) throw new Error("Invalid exact URL");
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Invalid exact URL");
    }
    return parsed.href;
  }

  function providerId(value) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))) return value;
    throw new Error("Invalid provider ID");
  }

  function reportedError(value) {
    return value && typeof value === "object" && (value.isError === true ||
      (value.result && typeof value.result === "object" && value.result.isError === true));
  }

  function policyFor(requested) {
    if (!requested || !Array.isArray(requested.allowedUrls) || !requested.allowedUrls.length ||
        requested.allowedUrls.length > 16) throw new DiscoveryError("invalid_policy", "setup");
    try {
      const urls = Array.from(new Set(requested.allowedUrls.map(exactUrl)));
      const knownId = requested.knownProviderTabId === undefined ? null : providerId(requested.knownProviderTabId);
      const timeoutMs = requested.timeoutMs === undefined ? 10000 : requested.timeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid timeout");
      if (requested.previousSession !== undefined) {
        const previous = requested.previousSession;
        if (!previous || typeof previous.status !== "function") throw new DiscoveryError("previous_session_unavailable", "setup");
        const status = previous.status();
        if (!status || status.busy || status.mutationOutcome === "unknown" || status.state !== "active") {
          throw new DiscoveryError("previous_session_blocked", "setup");
        }
      }
      return {urls, knownId, timeoutMs};
    } catch (failure) {
      if (failure instanceof DiscoveryError) throw failure;
      throw new DiscoveryError("invalid_policy", "setup");
    }
  }

  function requireRuntime() {
    if (typeof URL !== "function" || typeof Promise !== "function" ||
        typeof Promise.resolve !== "function" || typeof Promise.race !== "function" ||
        typeof setTimeout !== "function" || typeof clearTimeout !== "function") {
      throw new DiscoveryError("runtime_unavailable", "setup");
    }
  }

  function deadline(call, milliseconds, stage) {
    let rejectTimeout;
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
    let timer;
    try {
      timer = setTimeout(() => rejectTimeout(new DiscoveryError(stage + "_timeout", stage)), milliseconds);
    } catch (_) {
      throw new DiscoveryError("runtime_unavailable", "setup");
    }
    return Promise.race([Promise.resolve().then(call), timeout]).finally(() => clearTimeout(timer));
  }

  async function discoverExisting(adapter, requestedPolicy) {
    requireRuntime();
    const policy = policyFor(requestedPolicy);
    const ports = {};
    for (const method of ["queryExact", "metadata", "bind", "identity"]) {
      if (!adapter || typeof adapter[method] !== "function") throw new DiscoveryError("setup_unavailable", "setup");
      ports[method] = adapter[method].bind(adapter);
    }
    const events = [];
    function record(event, stage, extra) {
      events.push(Object.freeze(Object.assign({sequence: events.length + 1, event, stage}, extra || {})));
    }
    function fail(code, stage) { throw new DiscoveryError(code, stage, events); }

    async function queryCandidate() {
      const candidates = new Map();
      for (const url of policy.urls) {
        let rows;
        try {
          rows = await deadline(() => ports.queryExact(url), policy.timeoutMs, "query");
          if (!Array.isArray(rows) || reportedError(rows)) throw new Error("Query unavailable");
        } catch (failure) {
          record("connection_unavailable", "query");
          fail(failure instanceof DiscoveryError ? failure.code : "connection_unavailable", "query");
        }
        record("connection_available", "query");
        try {
          for (const row of rows) {
            // Read no titles or page contents. A host may overmatch a query:
            // retain only the exact authorized URL and optional known ID.
            if (!row || exactUrl(row.url) !== url) continue;
            const id = providerId(row.id);
            if (policy.knownId !== null && id !== policy.knownId) continue;
            candidates.set(id, {id, url});
          }
        } catch (_) { fail("metadata_invalid", "query"); }
      }
      record("candidates_checked", "query", {unique: candidates.size === 1});
      if (!candidates.size) fail("target_missing", "query");
      if (candidates.size !== 1) fail("target_ambiguous", "query");
      return candidates.values().next().value;
    }

    function checkedMetadata(row, candidate) {
      if (!row || reportedError(row) || providerId(row.id) !== candidate.id ||
          !policy.urls.includes(exactUrl(row.url)) ||
          !Number.isSafeInteger(row.windowId) || row.windowId < 0) throw new Error("Metadata unavailable");
      const result = {id: candidate.id, url: exactUrl(row.url), windowId: row.windowId};
      if (typeof row.active === "boolean") result.active = row.active;
      return result;
    }

    record("setup_available", "setup");
    let candidate = await queryCandidate();
    let metadata;
    let rediscoveries = 0;
    while (true) {
      try {
        const row = await deadline(() => ports.metadata(candidate.id), policy.timeoutMs, "metadata");
        metadata = checkedMetadata(row, candidate);
        record("metadata_verified", "metadata");
        break;
      } catch (failure) {
        record("metadata_unavailable", "metadata");
        if (failure instanceof DiscoveryError) fail(failure.code, failure.stage);
        if (rediscoveries === 1) fail("metadata_unavailable", "metadata");
        rediscoveries += 1;
        record("exact_rediscovery", "query");
        candidate = await queryCandidate();
      }
    }

    let tab;
    let identity;
    try {
      tab = await deadline(() => ports.bind(metadata.id), policy.timeoutMs, "binding");
      identity = await deadline(() => ports.identity(tab), policy.timeoutMs, "binding");
      if (!identity || reportedError(identity) || typeof identity.targetId !== "string" || !identity.targetId ||
          exactUrl(identity.url) !== metadata.url) throw new Error("Bound target mismatch");
    } catch (failure) {
      record("binding_unavailable", "binding");
      fail(failure instanceof DiscoveryError ? failure.code : "binding_unavailable", "binding");
    }
    record("target_bound", "binding");
    return Object.freeze({tab, targetId: identity.targetId, providerTabId: metadata.id,
      url: metadata.url, windowId: metadata.windowId, active: metadata.active,
      setup: "available", connection: "available", rediscoveries,
      audit: Object.freeze(events.slice())});
  }

  async function discoverChrome(management, cua, policy) {
    if (!management || !management.tabs || typeof management.tabs.query !== "function" ||
        typeof management.tabs.get !== "function" || !cua || typeof cua.getTab !== "function") {
      throw new DiscoveryError("setup_unavailable", "setup");
    }
    return discoverExisting({
      queryExact(url) { return management.tabs.query({url}); },
      metadata(id) { return management.tabs.get(Number(id)); },
      bind(id) { return cua.getTab(id, {browser: "chrome"}); },
      async identity(tab) {
        if (!tab || typeof tab.id !== "string" || typeof tab.url !== "function") throw new Error("Unsupported bound target");
        return {targetId: tab.id, url: await tab.url()};
      },
    }, policy);
  }

  root.CCUHDiscovery = Object.freeze({runtimeRevision: 1, discoverExisting, discoverChrome});
})(globalThis);
