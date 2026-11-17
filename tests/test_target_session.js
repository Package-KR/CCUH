"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../skills/ccuh/scripts/target-session.js"), "utf8");
const TARGET = "tab-existing-7";
const URL = "http://127.0.0.1:8765/target";

function runtime(overrides = {}) {
  const context = vm.createContext({URL: global.URL, setTimeout, clearTimeout, ...overrides});
  vm.runInContext(source, context, {filename: "target-session.js"});
  return context;
}

function fixture(overrides = {}) {
  const calls = [];
  const adapter = {
    async identity() { calls.push("identity"); return {targetId: TARGET, url: URL}; },
    async observe(options) { calls.push(["observe", options]); return "visible target state"; },
    async fill(locator, value) { calls.push(["fill", locator, value]); },
    async click(locator) { calls.push(["click", locator]); },
    async check(locator, checked) { calls.push(["check", locator, checked]); },
    ...overrides,
  };
  return {adapter, calls};
}

function policy(extra = {}) {
  return {targetId: TARGET, allowedUrls: [URL], timeoutMs: 1000, mutationTimeoutMs: 1000, ...extra};
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error.code === code);
}

test("the module does no I/O until a supplied adapter is bound", () => {
  const context = runtime();
  assert.equal(context.CCUH.protocolVersion, 1);
  assert.equal(context.CCUH.runtimeRevision, 4);
  assert.equal(typeof context.CCUH.bindExisting, "function");
  assert.equal(Object.isFrozen(context.CCUH), true);
  assert.equal(Object.keys(context.CCUH).join(","), "protocolVersion,runtimeRevision,bindExisting,bindBrowserTab");
});

test("successful operations call only the supplied existing-target adapter", async () => {
  const {adapter, calls} = fixture();
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  assert.equal(await session.observe(), "visible target state");
  assert.equal(calls.find(call => Array.isArray(call) && call[0] === "observe")[1].emit, false);
  assert.equal((await session.fill("Worker name", "ccuh-demo")).outcome, "returned");
  assert.equal((await session.check("Enabled", true)).identityChecksPassed, true);
  assert.equal((await session.click("Save")).action, "click");
  assert.equal(calls.filter(call => Array.isArray(call)).length, 4);
  assert.equal(session.status().mutationOutcome, "returned");
  assert.equal(Object.isFrozen(session), true);
  for (const forbidden of ["create", "createTab", "createWindow", "activate", "restore", "pressKey", "target", "adapter", "goto"]) {
    assert.equal(session[forbidden], undefined, forbidden);
  }
});

test("source integrity rejects reordered stop statements before namespace access or installation", () => {
  const statements = [
    '      reasonCode = accepted.has(reason) ? reason : "unspecified";',
    '      record(nextState === "interference" ? "interference_detected" : "session_suspended", "request", null, {code: reasonCode});',
  ];
  const swapped = source.replace(statements.join("\n"), statements.slice().reverse().join("\n"));
  assert.notEqual(swapped, source);
  let namespaceReads = 0;
  const {adapter, calls} = fixture();
  const context = vm.createContext({
    URL: global.URL, setTimeout, clearTimeout, adapter, policy: policy(),
    get CCUH() { namespaceReads += 1; return undefined; },
  });
  assert.throws(() => vm.runInContext(swapped + "\nCCUH.bindExisting(adapter, policy);", context), /source integrity mismatch/);
  assert.equal(namespaceReads, 0);
  assert.equal(Object.getOwnPropertyDescriptor(context, "CCUH").set, undefined);
  assert.equal(calls.length, 0);
});

test("source integrity rejects a same-length body change before any adapter call", () => {
  const modified = source.replace("let lookupRetriesRemaining = 1;", "let lookupRetriesRemaining = 2;");
  assert.notEqual(modified, source);
  assert.equal(modified.length, source.length);
  const {adapter, calls} = fixture();
  const context = vm.createContext({URL: global.URL, setTimeout, clearTimeout, adapter, policy: policy()});
  assert.throws(() => vm.runInContext(modified + "\nCCUH.bindExisting(adapter, policy);", context), /source integrity mismatch/);
  assert.equal(Object.hasOwn(context, "CCUH"), false);
  assert.equal(calls.length, 0);
});

test("a runtime without BigInt fails integrity preflight before installation", () => {
  const {adapter, calls} = fixture();
  const context = vm.createContext({URL: global.URL, setTimeout, clearTimeout, BigInt: undefined, adapter, policy: policy()});
  assert.throws(() => vm.runInContext(source + "\nCCUH.bindExisting(adapter, policy);", context), /requires BigInt/);
  assert.equal(Object.hasOwn(context, "CCUH"), false);
  assert.equal(calls.length, 0);
});

test("a mismatched target is rejected before any observation or action", async () => {
  const {adapter, calls} = fixture({async identity() { return {targetId: "different-tab", url: URL}; }});
  await rejectsCode(runtime().CCUH.bindExisting(adapter, policy()), "target_mismatch");
  assert.equal(calls.length, 0);
});

test("a forbidden URL is rejected even on the expected tab", async () => {
  const {adapter, calls} = fixture({async identity() { return {targetId: TARGET, url: "https://example.invalid/private"}; }});
  await rejectsCode(runtime().CCUH.bindExisting(adapter, policy()), "url_not_allowed");
  assert.equal(calls.length, 0);
});

test("missing identity gets one same-target recheck and never creates a fallback", async () => {
  let identities = 0;
  let creations = 0;
  const {adapter, calls} = fixture({
    async identity() { identities += 1; throw new Error("native pipe closed secret-value"); },
    async create() { creations += 1; },
  });
  await assert.rejects(runtime().CCUH.bindExisting(adapter, policy()), error => {
    assert.equal(error.code, "identity_unavailable");
    assert.equal(JSON.stringify(error.audit).includes("secret-value"), false);
    return true;
  });
  assert.equal(identities, 2);
  assert.equal(creations, 0);
  assert.equal(calls.length, 0);
});

test("the one metadata retry is a session-wide budget", async () => {
  let count = 0;
  const {adapter, calls} = fixture({
    async identity() {
      count += 1;
      if (count === 1 || count === 3) throw new Error("lookup failed");
      return {targetId: TARGET, url: URL};
    },
  });
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  assert.equal(session.status().lookupRetriesRemaining, 0);
  await rejectsCode(session.click("Save"), "identity_unavailable");
  assert.equal(count, 3);
  assert.equal(calls.length, 0);
  await rejectsCode(session.observe(), "session_locked");
  assert.equal(count, 3);
});

test("a target changed after binding is blocked before dispatch", async () => {
  let current = {targetId: TARGET, url: URL};
  const {adapter, calls} = fixture({async identity() { return current; }});
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  current = {targetId: "reused-tab-id", url: URL};
  await rejectsCode(session.fill("Worker name", "new value"), "target_mismatch");
  assert.equal(calls.length, 0);
  assert.equal(session.status().state, "locked");
});

test("observation is withheld when navigation happens during capture", async () => {
  let currentUrl = URL;
  let observations = 0;
  const {adapter} = fixture({
    async identity() { return {targetId: TARGET, url: currentUrl}; },
    async observe(options) {
      assert.equal(options.emit, false);
      observations += 1;
      currentUrl = "https://example.invalid/private?token=do-not-log";
      return "PRIVATE_CAPTURE_DO_NOT_RETURN";
    },
  });
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  await assert.rejects(session.observe(), error => {
    assert.equal(error.code, "url_not_allowed");
    assert.equal(JSON.stringify(error).includes("PRIVATE_CAPTURE"), false);
    assert.equal(JSON.stringify(error).includes("do-not-log"), false);
    return true;
  });
  assert.equal(observations, 1);
  assert.equal(session.status().state, "locked");
});

test("a mutation timeout locks the session and cannot be repeated", async () => {
  let clicks = 0;
  const {adapter} = fixture({async click() { clicks += 1; return new Promise(() => {}); }});
  const session = await runtime().CCUH.bindExisting(adapter, policy({mutationTimeoutMs: 10}));
  await rejectsCode(session.click("Save"), "operation_timeout");
  assert.equal(session.status().state, "locked");
  assert.equal(session.status().mutationOutcome, "unknown");
  assert.equal(session.status().mutationAttempted, true);
  await rejectsCode(session.click("Save"), "session_locked");
  assert.equal(clicks, 1);
});

test("a rejected mutation has an unknown outcome and sanitized failure", async () => {
  const {adapter} = fixture({async fill() { throw new Error("token=secret-input"); }});
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  await assert.rejects(session.fill("Worker name", "sensitive-text"), error => {
    assert.equal(error.code, "mutation_result_unknown");
    assert.equal(error.message.includes("secret-input"), false);
    return true;
  });
  const audit = JSON.stringify(session.audit());
  for (const secret of ["sensitive-text", "secret-input", "Worker name", TARGET, URL]) assert.equal(audit.includes(secret), false);
  assert.equal(session.status().mutationOutcome, "unknown");
  assert.equal(session.status().mutationAttempted, true);
});

test("an explicit MCP error result does not produce a completed receipt", async () => {
  const {adapter} = fixture({async click() { return {result: {isError: true}}; }});
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  await rejectsCode(session.click("Save"), "mutation_result_unknown");
  assert.equal(session.status().mutationOutcome, "unknown");
});

test("concurrent mutations are rejected without dispatching a second action", async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let fills = 0;
  let clicks = 0;
  const {adapter} = fixture({
    async fill() { fills += 1; entered(); await new Promise(resolve => { release = resolve; }); },
    async click() { clicks += 1; },
  });
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  const first = session.fill("Worker name", "value");
  await started;
  await rejectsCode(session.click("Save"), "session_busy");
  release();
  assert.equal((await first).outcome, "returned");
  assert.equal(fills, 1);
  assert.equal(clicks, 0);
  assert.equal(session.status().state, "active");
});

test("explicit suspension blocks subsequent UI calls", async () => {
  const {adapter, calls} = fixture();
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  session.suspend("user_space_changed");
  await rejectsCode(session.click("Save"), "session_suspended");
  assert.equal(calls.filter(Array.isArray).length, 0);
  assert.equal(session.status().reasonCode, "user_space_changed");
});

test("interference while a read is pending suppresses its result", async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const {adapter} = fixture({
    async observe() { entered(); return new Promise(resolve => { release = resolve; }); },
  });
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  const reading = session.observe();
  await started;
  session.interference("focus_changed");
  release("must not reach caller");
  await rejectsCode(reading, "interference_detected");
  await rejectsCode(session.observe(), "interference_detected");
  assert.equal(session.status().state, "interference");
});

test("unknown suspension reasons never enter the audit verbatim", async () => {
  const session = await runtime().CCUH.bindExisting(fixture().adapter, policy());
  session.suspend("https://private.invalid/?key=secret");
  assert.equal(session.status().reasonCode, "unspecified");
  assert.equal(JSON.stringify(session.audit()).includes("secret"), false);
});

test("policy snapshots cannot be broadened by mutating the original object", async () => {
  let currentUrl = URL;
  const allowed = [URL];
  const input = policy({allowedUrls: allowed});
  const {adapter, calls} = fixture({async identity() { return {targetId: TARGET, url: currentUrl}; }});
  const session = await runtime().CCUH.bindExisting(adapter, input);
  currentUrl = "https://example.invalid/private";
  allowed.push(currentUrl);
  input.targetId = "changed";
  await rejectsCode(session.click("Save"), "url_not_allowed");
  assert.equal(calls.length, 0);
});

test("metadata timeout consumes at most one retry and yields no observation", async () => {
  let identities = 0;
  const {adapter, calls} = fixture({identity() { identities += 1; return new Promise(() => {}); }});
  await assert.rejects(runtime().CCUH.bindExisting(adapter, policy({timeoutMs: 5})), error => {
    assert.equal(error.code, "identity_unavailable");
    assert.equal(error.audit.filter(entry => entry.event === "identity_unavailable")
      .every(entry => entry.causeCode === "metadata_timeout"), true);
    return true;
  });
  assert.equal(identities, 2);
  assert.equal(calls.length, 0);
});

test("unsupported runtime globals reject binding before any adapter call", async () => {
  for (const name of ["URL", "Promise", "Map", "WeakSet", "setTimeout", "clearTimeout"]) {
    const {adapter, calls} = fixture();
    const context = runtime({[name]: undefined});
    await rejectsCode(context.CCUH.bindExisting(adapter, policy()), "unsupported_runtime");
    assert.equal(calls.length, 0, name);
  }
});

test("a timer setup failure never queues metadata or consumes a retry", async () => {
  const {adapter, calls} = fixture();
  const context = runtime({setTimeout() { throw new Error("private timer failure"); }});
  await assert.rejects(context.CCUH.bindExisting(adapter, policy()), error => {
    assert.equal(error.code, "unsupported_runtime");
    assert.equal(error.audit.some(entry => entry.event === "same_target_recheck"), false);
    assert.equal(JSON.stringify(error).includes("private timer failure"), false);
    return true;
  });
  await Promise.resolve();
  assert.equal(calls.length, 0);
});

test("metadata failure audit distinguishes static causes without raw values", async () => {
  const cases = [
    [async () => { throw new Error("secret-metadata-rejection"); }, "metadata_rejected"],
    [async () => null, "metadata_invalid_identity"],
    [async () => ({targetId: 7, url: URL}), "metadata_invalid_identity"],
    [async () => ({isError: true, message: "secret-reported-error"}), "metadata_reported_error"],
    [async () => ({result: {isError: true}, secret: "secret-nested-error"}), "metadata_reported_error"],
    [async () => ({targetId: TARGET}), "metadata_url_missing"],
    [async () => ({targetId: TARGET, url: null}), "metadata_url_missing"],
    [async () => ({targetId: TARGET, url: ""}), "metadata_url_missing"],
    [async () => ({targetId: TARGET, url: "secret-invalid-url"}), "metadata_url_invalid"],
    [async () => ({targetId: TARGET, url: "file:///secret-private-path"}), "metadata_url_invalid"],
  ];
  for (const [identity, expected] of cases) {
    let identities = 0;
    const {adapter, calls} = fixture({async identity() { identities += 1; return identity(); }});
    await assert.rejects(runtime().CCUH.bindExisting(adapter, policy()), error => {
      assert.equal(error.code, "identity_unavailable");
      const failures = error.audit.filter(entry => entry.event === "identity_unavailable");
      assert.equal(failures.length, 2);
      assert.equal(failures.every(entry => entry.causeCode === expected), true, expected);
      const serialized = JSON.stringify(error);
      for (const secret of ["secret-", TARGET, URL]) assert.equal(serialized.includes(secret), false);
      return true;
    });
    assert.equal(identities, 2);
    assert.equal(calls.length, 0);
  }
});

test("incomplete adapters and broad or credentialed URL policies fail closed", async () => {
  await rejectsCode(runtime().CCUH.bindExisting({}, policy()), "invalid_adapter");
  for (const allowedUrls of [[], ["*"], ["file:///tmp/a"], ["https://name:password@example.invalid/"]]) {
    await rejectsCode(runtime().CCUH.bindExisting(fixture().adapter, policy({allowedUrls})), "invalid_policy");
  }
});

test("reloading the code does not reset an existing session", async () => {
  const context = runtime();
  const session = await context.CCUH.bindExisting(fixture().adapter, policy());
  session.suspend("manual");
  const original = context.CCUH;
  vm.runInContext(source, context);
  assert.equal(context.CCUH, original);
  await rejectsCode(session.observe(), "session_suspended");
  const replacement = fixture();
  await rejectsCode(context.CCUH.bindExisting(replacement.adapter, policy()), "target_already_bound");
  assert.equal(replacement.calls.length, 0);
});

test("version conflicts refuse replacement and preserve existing session state", async () => {
  const context = runtime();
  const {adapter, calls} = fixture();
  const locked = await context.CCUH.bindExisting(adapter, policy());
  locked.interference("focus_changed");
  const priorAudit = JSON.stringify(locked.audit());
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let clicks = 0;
  const pendingTarget = "different-pending-target";
  const pending = await context.CCUH.bindExisting(fixture({
    async identity() { return {targetId: pendingTarget, url: URL}; },
    async click() {
    clicks += 1;
    entered();
    await new Promise(resolve => { release = resolve; });
  }}).adapter, policy({targetId: pendingTarget}));
  const action = pending.click("Save");
  await started;
  context.CCUH = Object.freeze({...context.CCUH, runtimeRevision: 2});
  const oldNamespace = context.CCUH;
  assert.throws(() => vm.runInContext(source, context), /different CCUH runtime/);
  assert.equal(context.CCUH, oldNamespace);
  assert.equal(context.CCUH.runtimeRevision, 2);
  assert.equal(JSON.stringify(locked.audit()), priorAudit);
  await rejectsCode(locked.observe(), "interference_detected");
  assert.equal(calls.filter(Array.isArray).length, 0);
  assert.equal(pending.status().busy, true);
  await rejectsCode(pending.click("Save"), "session_busy");
  release();
  assert.equal((await action).outcome, "returned");
  assert.equal(clicks, 1);
});

test("a target is reserved while its first binding is still pending", async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const first = fixture({async identity() {
    entered();
    return new Promise(resolve => { release = resolve; });
  }});
  const context = runtime();
  const binding = context.CCUH.bindExisting(first.adapter, policy());
  await started;
  const second = fixture();
  await rejectsCode(context.CCUH.bindExisting(second.adapter, policy()), "target_already_bound");
  assert.equal(second.calls.length, 0);
  release({targetId: TARGET, url: URL});
  assert.equal((await binding).status().state, "active");
});

test("a duplicate binding cannot bypass a pending mutation", async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const first = fixture({async click() {
    entered();
    await new Promise(resolve => { release = resolve; });
  }});
  const context = runtime();
  const session = await context.CCUH.bindExisting(first.adapter, policy());
  const clicking = session.click("Save");
  await started;
  const second = fixture();
  await rejectsCode(context.CCUH.bindExisting(second.adapter, policy()), "target_already_bound");
  assert.equal(second.calls.length, 0);
  assert.equal(session.status().busy, true);
  release();
  assert.equal((await clicking).outcome, "returned");
});

test("an unknown mutation keeps its target reserved without another dispatch", async () => {
  let clicks = 0;
  const context = runtime();
  const first = fixture({async click() { clicks += 1; throw new Error("unknown"); }});
  const session = await context.CCUH.bindExisting(first.adapter, policy());
  await rejectsCode(session.click("Save"), "mutation_result_unknown");
  const second = fixture();
  await rejectsCode(context.CCUH.bindExisting(second.adapter, policy()), "target_already_bound");
  assert.equal(second.calls.length, 0);
  assert.equal(clicks, 1);
  assert.equal(session.status().mutationOutcome, "unknown");
});

test("a failed identity binding retains its target reservation", async () => {
  let identities = 0;
  const context = runtime();
  const first = fixture({async identity() { identities += 1; throw new Error("missing target"); }});
  await rejectsCode(context.CCUH.bindExisting(first.adapter, policy()), "identity_unavailable");
  const second = fixture();
  await rejectsCode(context.CCUH.bindExisting(second.adapter, policy()), "target_already_bound");
  assert.equal(identities, 2);
  assert.equal(second.calls.length, 0);
});

test("generic and concrete factories share the same target reservation", async () => {
  for (const firstKind of ["generic", "browser"]) {
    for (const secondKind of ["generic", "browser"]) {
      const context = runtime();
      const first = firstKind === "generic" ? fixture() : browserFixture();
      await (firstKind === "generic" ? context.CCUH.bindExisting(first.adapter, policy()) :
        context.CCUH.bindBrowserTab(first.tab, policy()));
      const second = secondKind === "generic" ? fixture() : browserFixture();
      await rejectsCode(secondKind === "generic" ? context.CCUH.bindExisting(second.adapter, policy()) :
        context.CCUH.bindBrowserTab(second.tab, policy()), "target_already_bound");
      assert.equal(second.calls.length, 0, firstKind + " then " + secondKind);
    }
  }
});

test("different target IDs can bind independently in one runtime", async () => {
  const context = runtime();
  const first = await context.CCUH.bindExisting(fixture().adapter, policy());
  const otherTarget = "other-existing-tab";
  const second = await context.CCUH.bindExisting(fixture({async identity() {
    return {targetId: otherTarget, url: URL};
  }}).adapter, policy({targetId: otherTarget}));
  assert.equal(await first.observe(), "visible target state");
  assert.equal(await second.observe(), "visible target state");
});

test("metadata property failures cannot leak raw identity or error fields", async () => {
  const {adapter} = fixture({async identity() {
    return {targetId: TARGET, get url() { throw {stage: "private-stage-secret", message: "token-secret"}; }};
  }});
  await assert.rejects(runtime().CCUH.bindExisting(adapter, policy()), error => {
    assert.equal(error.code, "identity_unavailable");
    assert.equal(JSON.stringify(error).includes("private-stage-secret"), false);
    assert.equal(JSON.stringify(error).includes("token-secret"), false);
    return true;
  });
});

test("a mutation followed by unavailable identity remains unknown and locked", async () => {
  let reads = 0;
  let clicks = 0;
  const {adapter} = fixture({
    async identity() {
      reads += 1;
      if (reads > 2) throw new Error("lookup failed");
      return {targetId: TARGET, url: URL};
    },
    async click() { clicks += 1; },
  });
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  await rejectsCode(session.click("Save"), "identity_unavailable");
  assert.equal(reads, 4);
  assert.equal(clicks, 1);
  assert.equal(session.status().mutationOutcome, "unknown");
  await rejectsCode(session.click("Save"), "session_locked");
  assert.equal(clicks, 1);
});

test("suspending a dispatched mutation prevents a success receipt", async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const {adapter} = fixture({async click() {
    entered();
    await new Promise(resolve => { release = resolve; });
  }});
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  const clicking = session.click("Save");
  await started;
  session.suspend("user_space_changed");
  release();
  await rejectsCode(clicking, "session_suspended");
  assert.equal(session.status().mutationOutcome, "unknown");
});

test("invalid action arguments never dispatch an adapter call", async () => {
  const {adapter, calls} = fixture();
  const session = await runtime().CCUH.bindExisting(adapter, policy());
  await rejectsCode(session.click(""), "invalid_request");
  await rejectsCode(session.fill("Worker name", null), "invalid_request");
  await rejectsCode(session.check("Enabled", "yes"), "invalid_request");
  assert.equal(calls.filter(Array.isArray).length, 0);
  assert.equal(session.status().state, "active");
});

function browserFixture() {
  const calls = [];
  const tab = {
    id: TARGET,
    async url() {
      assert.equal(this, tab);
      calls.push(["url"]);
      return URL;
    },
    playwright: {
      async domSnapshot() {
        assert.equal(this, tab.playwright);
        calls.push(["observe"]);
        return "browser state";
      },
      getByLabel(label, options) {
        assert.equal(this, tab.playwright);
        calls.push(["getByLabel", label, options]);
        return {async fill(value) { calls.push(["fill", value]); }};
      },
      getByRole(role, options) {
        assert.equal(this, tab.playwright);
        calls.push(["getByRole", role, options]);
        return {
          async click() { calls.push(["click"]); },
          async setChecked(value) { calls.push(["setChecked", value]); },
        };
      },
    },
    create() { calls.push(["FORBIDDEN_CREATE"]); },
    activate() { calls.push(["FORBIDDEN_ACTIVATE"]); },
    restore() { calls.push(["FORBIDDEN_RESTORE"]); },
    getScreenshot() { calls.push(["FORBIDDEN_SCREENSHOT"]); },
    getAXState() { calls.push(["FORBIDDEN_AX"]); },
  };
  return {tab, calls};
}

test("the concrete browser factory uses exact accessible names on the same tab", async () => {
  const {tab, calls} = browserFixture();
  const session = await runtime().CCUH.bindBrowserTab(tab, policy());
  assert.equal(await session.observe({emit: true}), "browser state");
  await session.fill("Worker name", "ccuh-browser");
  await session.check("Enabled", true);
  await session.click("Save");
  const actions = JSON.parse(JSON.stringify(calls.filter(call => call[0] !== "url")));
  assert.deepEqual(actions, [
    ["observe"],
    ["getByLabel", "Worker name", {exact: true}],
    ["fill", "ccuh-browser"],
    ["getByRole", "checkbox", {name: "Enabled", exact: true}],
    ["setChecked", true],
    ["getByRole", "button", {name: "Save", exact: true}],
    ["click"],
  ]);
  assert.equal(calls.some(call => call[0].startsWith("FORBIDDEN_")), false);
  assert.equal(session.tab, undefined);
  assert.equal(session.getScreenshot, undefined);
  assert.equal(session.status().mutationOutcome, "returned");
});

test("unsupported browser surfaces fail before metadata or content reads", async () => {
  for (const remove of [
    tab => { delete tab.url; },
    tab => { delete tab.playwright; },
    tab => { delete tab.playwright.domSnapshot; },
    tab => { delete tab.playwright.getByLabel; },
    tab => { delete tab.playwright.getByRole; },
  ]) {
    const {tab, calls} = browserFixture();
    remove(tab);
    await rejectsCode(runtime().CCUH.bindBrowserTab(tab, policy()), "unsupported_browser_api");
    assert.equal(calls.length, 0);
  }
});

test("the concrete browser factory withholds a non-string DOM observation", async () => {
  const {tab, calls} = browserFixture();
  tab.playwright.domSnapshot = async () => ({content: "PRIVATE_DOM_DO_NOT_RETURN"});
  const session = await runtime().CCUH.bindBrowserTab(tab, policy());
  await assert.rejects(session.observe(), error => {
    assert.equal(error.code, "observation_failed");
    assert.equal(JSON.stringify(error).includes("PRIVATE_DOM"), false);
    return true;
  });
  assert.equal(session.status().state, "locked");
  assert.equal(calls.some(call => call[0].startsWith("FORBIDDEN_")), false);
});

test("concrete browser identity mismatch never dispatches UI operations", async () => {
  const {tab, calls} = browserFixture();
  await rejectsCode(runtime().CCUH.bindBrowserTab(tab, policy({targetId: "another-tab"})), "target_mismatch");
  assert.equal(calls.filter(call => call[0] !== "url").length, 0);
});

test("replacing the concrete tab ID after binding locks the existing session", async () => {
  const {tab, calls} = browserFixture();
  const session = await runtime().CCUH.bindBrowserTab(tab, policy());
  tab.id = "replacement-tab";
  await rejectsCode(session.click("Save"), "target_mismatch");
  assert.equal(calls.filter(call => call[0] !== "url").length, 0);
});

test("missing concrete locator capabilities remain distinct from a pending mutation", async () => {
  for (const action of ["fill", "click", "check"]) {
    const {tab, calls} = browserFixture();
    if (action === "fill") {
      tab.playwright.getByLabel = () => ({});
    } else {
      tab.playwright.getByRole = () => ({});
    }
    const session = await runtime().CCUH.bindBrowserTab(tab, policy());
    const request = action === "fill" ? session.fill("Worker name", "value") :
      action === "click" ? session.click("Save") : session.check("Enabled", true);
    await assert.rejects(request, error => {
      assert.equal(error.code, "unsupported_browser_api");
      assert.equal(error.mutationAttempted, false);
      return true;
    });
    assert.equal(session.status().state, "locked");
    assert.equal(session.status().reasonCode, "unsupported_browser_api");
    assert.equal(session.status().mutationOutcome, "not_attempted");
    assert.equal(session.status().mutationAttempted, false);
    assert.equal(calls.some(call => ["fill", "click", "setChecked"].includes(call[0])), false);
    await rejectsCode(session.click("Save"), "session_locked");
  }
});
