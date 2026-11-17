"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../skills/ccuh/scripts/target-discovery.js"), "utf8");
const TASK_URL = "http://127.0.0.1:8765/target";
function runtime(overrides = {}) {
  const context = vm.createContext({URL, setTimeout, clearTimeout, ...overrides});
  vm.runInContext(source, context);
  return context;
}
function policy(extra = {}) { return {allowedUrls: [TASK_URL], timeoutMs: 100, ...extra}; }
function fixture(overrides = {}) {
  const calls = [];
  const tab = {id: "cua-target-7", async url() { return TASK_URL; }};
  const metadata = {id: 71, windowId: 9, active: false, url: TASK_URL};
  const adapter = {
    async queryExact(url) { calls.push(["query", url]); return [metadata]; },
    async metadata(id) { calls.push(["metadata", id]); return metadata; },
    async bind(id) { calls.push(["bind", id]); return tab; },
    async identity(bound) { calls.push(["identity", bound.id]); return {targetId: bound.id, url: await bound.url()}; },
    async create() { calls.push(["FORBIDDEN_CREATE"]); },
    async activate() { calls.push(["FORBIDDEN_ACTIVATE"]); },
    async restore() { calls.push(["FORBIDDEN_RESTORE"]); },
    async click() { calls.push(["FORBIDDEN_MUTATION"]); },
    ...overrides,
  };
  return {adapter, calls, tab, metadata};
}
async function rejectsCode(promise, code) { await assert.rejects(promise, failure => failure.code === code); }

test("exact source installs without I/O and same revision reload preserves namespace", () => {
  const context = runtime();
  const original = context.CCUHDiscovery;
  vm.runInContext(source, context);
  assert.equal(context.CCUHDiscovery, original);
  assert.equal(original.runtimeRevision, 1);
  assert.equal(Object.isFrozen(original), true);
});

test("source copying changes fail before installation", () => {
  const context = vm.createContext({URL, setTimeout, clearTimeout});
  assert.throws(() => vm.runInContext(source.replace("rediscoveries === 1", "rediscoveries === 2"), context), /integrity mismatch/);
  assert.equal(Object.hasOwn(context, "CCUHDiscovery"), false);
});

test("unique inactive existing target binds without any creation or page reads", async () => {
  const {adapter, calls, tab} = fixture();
  const result = await runtime().CCUHDiscovery.discoverExisting(adapter, policy());
  assert.equal(result.tab, tab);
  assert.equal(result.providerTabId, "71");
  assert.equal(result.targetId, "cua-target-7");
  assert.equal(result.windowId, 9);
  assert.equal(result.active, false);
  assert.equal(result.rediscoveries, 0);
  assert.equal(result.connection, "available");
  assert.deepEqual(calls.map(call => call[0]), ["query", "metadata", "bind", "identity"]);
  assert.equal(JSON.stringify(result.audit).includes(TASK_URL), false);
  assert.equal(JSON.stringify(result.audit).includes("cua-target"), false);
});

test("missing and ambiguous targets fail without binding", async () => {
  for (const [rows, expected] of [[[], "target_missing"], [[
    {id: 1, windowId: 9, url: TASK_URL}, {id: 2, windowId: 10, url: TASK_URL},
  ], "target_ambiguous"]]) {
    const {adapter, calls} = fixture({async queryExact() { return rows; }});
    await rejectsCode(runtime().CCUHDiscovery.discoverExisting(adapter, policy()), expected);
    assert.equal(calls.length, 0);
  }
});

test("known provider ID selects only that existing target among equal URLs", async () => {
  const {adapter, metadata} = fixture();
  adapter.queryExact = async () => [{...metadata, id: 72}, metadata];
  const result = await runtime().CCUHDiscovery.discoverExisting(adapter, policy({knownProviderTabId: "71"}));
  assert.equal(result.providerTabId, "71");
  await rejectsCode(runtime().CCUHDiscovery.discoverExisting(adapter, policy({knownProviderTabId: "73"})), "target_missing");
});

test("host overmatches cannot select an unauthorized URL or read its title", async () => {
  const {adapter, metadata} = fixture();
  adapter.queryExact = async () => [{id: 72, url: "https://unrelated.invalid/video",
    get title() { throw new Error("unrelated title read"); }}, metadata];
  const result = await runtime().CCUHDiscovery.discoverExisting(adapter, policy());
  assert.equal(result.providerTabId, "71");
});

test("wildcard, credentialed and non-http URLs are rejected before calls", async () => {
  for (const url of ["*", "https://task.invalid/*", "file:///tmp/a", "https://name:password@task.invalid/"]) {
    const {adapter, calls} = fixture();
    await rejectsCode(runtime().CCUHDiscovery.discoverExisting(adapter, policy({allowedUrls: [url]})), "invalid_policy");
    assert.equal(calls.length, 0);
  }
});

test("setup absence and live connection rejection are distinct sanitized results", async () => {
  await rejectsCode(runtime().CCUHDiscovery.discoverExisting({}, policy()), "setup_unavailable");
  const {adapter, calls} = fixture({async queryExact() { throw new Error("secret-connection-token"); }});
  await assert.rejects(runtime().CCUHDiscovery.discoverExisting(adapter, policy()), failure => {
    assert.equal(failure.code, "connection_unavailable");
    assert.equal(JSON.stringify(failure).includes("secret-connection-token"), false);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("one exact rediscovery recovers a rejected metadata lookup", async () => {
  const {adapter, calls, metadata} = fixture();
  let lookups = 0;
  adapter.metadata = async id => {
    calls.push(["metadata", id]);
    if (++lookups === 1) throw new Error("stale metadata");
    return metadata;
  };
  const result = await runtime().CCUHDiscovery.discoverExisting(adapter, policy());
  assert.equal(result.rediscoveries, 1);
  assert.deepEqual(calls.map(call => call[0]), ["query", "metadata", "query", "metadata", "bind", "identity"]);
  assert.equal(calls.filter(call => call[0] === "query").every(call => call[1] === TASK_URL), true);
});

test("failed recovery has a strict one-rediscovery budget and no fallback", async () => {
  const {adapter, calls} = fixture({async metadata(id) { calls.push(["metadata", id]); throw new Error("missing"); }});
  await rejectsCode(runtime().CCUHDiscovery.discoverExisting(adapter, policy()), "metadata_unavailable");
  assert.deepEqual(calls.map(call => call[0]), ["query", "metadata", "query", "metadata"]);
});

test("metadata timeout is unresolved and does not trigger a second lookup", async () => {
  const {adapter, calls} = fixture({metadata(id) { calls.push(["metadata", id]); return new Promise(() => {}); }});
  await rejectsCode(runtime().CCUHDiscovery.discoverExisting(adapter, policy({timeoutMs: 5})), "metadata_timeout");
  assert.deepEqual(calls.map(call => call[0]), ["query", "metadata"]);
});

test("binding rejection and wrong bound URL never retry or return the target", async () => {
  for (const override of [
    {async bind() { throw new Error("binding secret"); }},
    {async identity() { return {targetId: "wrong", url: "https://unrelated.invalid/"}; }},
  ]) {
    const {adapter, calls} = fixture(override);
    await rejectsCode(runtime().CCUHDiscovery.discoverExisting(adapter, policy()), "binding_unavailable");
    assert.equal(calls.filter(call => call[0] === "query").length, 1);
    assert.equal(calls.some(call => call[0].startsWith("FORBIDDEN")), false);
  }
});

test("previous pending, unknown, suspended and locked sessions cannot be replaced", async () => {
  for (const status of [
    {state: "active", busy: true, mutationOutcome: "not_attempted"},
    {state: "active", busy: false, mutationOutcome: "unknown"},
    {state: "locked", busy: false, mutationOutcome: "not_attempted"},
    {state: "suspended", busy: false, mutationOutcome: "returned"},
  ]) {
    const {adapter, calls} = fixture();
    await rejectsCode(runtime().CCUHDiscovery.discoverExisting(adapter,
      policy({previousSession: {status() { return status; }}})), "previous_session_blocked");
    assert.equal(calls.length, 0);
  }
});

test("concrete Chrome route uses exact query, returned native ID and public CUA binding only", async () => {
  const calls = [];
  const row = {id: 321, windowId: 12, active: false, url: TASK_URL};
  const tab = {id: "actual-cua-id", async url() { assert.equal(this, tab); return TASK_URL; }};
  const management = {tabs: {
    async query(options) { assert.equal(this, management.tabs); calls.push(["query", options]); return [row]; },
    async get(id) { assert.equal(this, management.tabs); calls.push(["get", id]); return row; },
    async create() { throw new Error("forbidden create"); },
    async update() { throw new Error("forbidden update"); },
  }};
  const cua = {async getTab(id, options) { assert.equal(this, cua); calls.push(["getTab", id, options]); return tab; }};
  const result = await runtime().CCUHDiscovery.discoverChrome(management, cua, policy());
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["query", {url: TASK_URL}], ["get", 321], ["getTab", "321", {browser: "chrome"}],
  ]);
  assert.equal(result.tab, tab);
  assert.equal(result.targetId, "actual-cua-id");
  assert.equal(result.providerTabId, "321");
});

test("missing concrete APIs and unavailable runtime timers dispatch nothing", async () => {
  await rejectsCode(runtime().CCUHDiscovery.discoverChrome({}, {}, policy()), "setup_unavailable");
  const {adapter, calls} = fixture();
  await rejectsCode(runtime({setTimeout: undefined}).CCUHDiscovery.discoverExisting(adapter, policy()), "runtime_unavailable");
  await rejectsCode(runtime({setTimeout() { throw new Error("timer failed"); }}).CCUHDiscovery.discoverExisting(adapter, policy()), "runtime_unavailable");
  await Promise.resolve();
  assert.equal(calls.length, 0);
});
