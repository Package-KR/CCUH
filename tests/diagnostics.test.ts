import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatus, recentCalls } from '../src/diagnostics.ts';
import { normalizeEvent } from '../src/codex/event.ts';
import { commandHooks, mcpConfig } from '../src/codex/config.ts';

const raw = { session_id: 'session', tool_use_id: 'call', tool_name: 'mcp__cua_repl__js', tool_input: { code: 'private body' } };
test('CLI status never claims it tested the MCP connection or target binding', () => {
  const s = buildStatus([], 'cli');
  assert.equal(s.evidence.mcp_connection, 'not_tested_by_cli');
  assert.equal(s.evidence.native_app_selection, 'not_implemented');
  assert.equal(s.evidence.computer_use_binding, 'not_verified');
});
test('synthetic records do not prove real hook evidence', () => {
  const e = normalizeEvent(raw, { phase: 'pre', source: 'synthetic', nowMs: 1 })!;
  const s = buildStatus([e], 'mcp');
  assert.equal(s.evidence.mcp_connection, 'responding');
  assert.equal(s.evidence.hook_records, 'no_records');
  assert.equal(s.evidence.computer_use_calls, 'not_observed');
});
test('MCP-submitted records are separate from command-hook records', () => {
  const e = normalizeEvent(raw, { phase: 'pre', source: 'mcp', nowMs: 1 })!;
  const s = buildStatus([e], 'mcp');
  assert.equal(s.evidence.hook_records, 'no_records');
  assert.equal(s.evidence.mcp_event_records, 1);
  assert.equal(s.evidence.computer_use_calls, 'candidate_names_observed');
});
test('paired calls and error=false never imply app acquisition or task success', () => {
  const pre = normalizeEvent(raw, { phase: 'pre', source: 'hook', nowMs: 1 })!;
  const post = normalizeEvent({ ...raw, tool_response: { isError: false } }, { phase: 'post', source: 'hook', nowMs: 9 })!;
  const s = buildStatus([pre, post], 'mcp', 'darwin');
  assert.equal(s.evidence.paired_candidate_calls, 1);
  assert.equal(s.summary.task_success, 'not_measured');
  assert.equal(s.evidence.computer_use_binding, 'not_verified');
});
test('recent calls return a bounded empty state and reject invalid limits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ccuh-diagnostics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual((await recentCalls(1, { stateDir: dir })).calls, []);
  await assert.rejects(() => recentCalls(101, { stateDir: dir }));
});
test('configuration generation is inspectable, quotes paths and does not activate anything', () => {
  const h = commandHooks('mcp__cua_repl__js');
  assert.equal(h.hooks.PreToolUse[0].matcher, 'mcp__cua_repl__js');
  assert.equal(h.hooks.PostToolUse[0].hooks[0].type, 'command');
  assert.ok(h.hooks.PreToolUse[0].hooks[0].command.startsWith("'"));
  assert.throws(() => commandHooks('name; echo injected'));
  assert.match(mcpConfig(), /\[mcp_servers\.ccuh\]/);
  assert.match(mcpConfig(), /src\/server\.ts/);
});
