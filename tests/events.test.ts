import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isComputerUseCandidate, isSanitizedEvent, normalizeEvent } from '../src/codex/event.ts';
import { appendEvent, groupCalls, readEvents, stateDirectory, summarizeEvents } from '../src/codex/store.ts';

const payload = (overrides = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'session-1', turn_id: 'turn-1',
  tool_use_id: 'call-1', tool_name: 'mcp__cua_repl__js', ...overrides,
});

test('normalization retains shape and hashes identity without persisting content', () => {
  const secret = 'PRIVATE_SENTINEL';
  const event = normalizeEvent(payload({
    session_id: secret + '-session', tool_use_id: secret + '-call',
    cwd: '/private/' + secret, transcript_path: secret,
    tool_input: { code: secret, window_title: secret, [secret]: secret },
    tool_response: { content: [{ text: secret }] },
  }), { nowMs: 1000 });
  assert.ok(event && isSanitizedEvent(event));
  assert.equal(JSON.stringify(event).includes(secret), false);
  assert.deepEqual(event.input_shape, { code: 'string', window_title: 'string' });
  assert.equal(event.other_input_key_count, 1);
  assert.equal(event.code_length, secret.length);
  assert.equal(event.target_info, 'explicit_fields');
  assert.match(event.session_hash, /^[a-f0-9]{64}$/);
});

test('opaque REPL code does not claim a selected target', () => {
  const event = normalizeEvent(payload({ tool_input: { code: 'await app.click(1)' } }));
  assert.equal(event?.target_info, 'opaque_code');
  assert.equal(event?.computer_use_candidate, true);
});

test('invalid identity, conflicting phase and own tools are rejected', () => {
  for (const raw of [null, {}, payload({ session_id: '' }), payload({ tool_use_id: undefined }),
    payload({ tool_name: 'bad tool name' }), payload({ tool_name: 'mcp__ccuh__ccuh_status' })]) {
    assert.equal(normalizeEvent(raw), null);
  }
  assert.equal(normalizeEvent(payload(), { phase: 'post' }), null);
  assert.equal(normalizeEvent(payload({ hook_event_name: 'PermissionRequest' }), { phase: 'pre' }), null);
  assert.equal(normalizeEvent(payload(), { nowMs: NaN }), null);
});

test('Computer Use candidate names are a bounded heuristic', () => {
  assert.equal(isComputerUseCandidate('mcp__cua_repl__js'), true);
  assert.equal(isComputerUseCandidate('mcp__cua_repl.js'), true);
  assert.equal(isComputerUseCandidate('mcp__computer_use__observe'), true);
  assert.equal(isComputerUseCandidate('mcp__ccuh__computer_use'), false);
  assert.equal(isComputerUseCandidate('some_unrelated_js'), false);
});

test('post outcome only reports explicit tool error evidence', () => {
  const post = payload({ hook_event_name: 'PostToolUse' });
  assert.equal(normalizeEvent({ ...post, tool_response: { isError: true } })?.reported_tool_error, true);
  assert.equal(normalizeEvent({ ...post, tool_response: { isError: false } })?.reported_tool_error, false);
  assert.equal(normalizeEvent({ ...post, tool_response: { error: false } })?.reported_tool_error, null);
  assert.equal(normalizeEvent({ ...post, tool_response: { content: [{ text: 'Success!' }] } })?.reported_tool_error, null);
});

test('pairing uses session plus call ID and keeps synthetic sources separate', () => {
  const events = [
    normalizeEvent(payload(), { nowMs: 100 }),
    normalizeEvent(payload({ hook_event_name: 'PostToolUse' }), { nowMs: 225 }),
    normalizeEvent(payload({ session_id: 'session-2', hook_event_name: 'PostToolUse' }), { nowMs: 500 }),
    normalizeEvent(payload(), { nowMs: 50, source: 'synthetic' }),
  ].filter(Boolean) as NonNullable<ReturnType<typeof normalizeEvent>>[];
  const groups = groupCalls(events);
  assert.equal(groups.length, 3);
  assert.equal(groups.find(call => call.status === 'paired')?.observed_span_ms, 125);
  assert.deepEqual(groups.map(call => call.status).sort(), ['paired', 'post_only', 'pre_only']);
  const summary = summarizeEvents(events);
  assert.equal(summary.hook_computer_use_candidate_calls, 2);
  assert.equal(summary.paired_hook_computer_use_candidate_calls, 1);
  assert.equal(summary.task_success, 'not_measured');
  assert.equal(summary.computer_use_binding, 'not_verified');
});

test('duplicates, identity mismatch and negative clocks never claim a valid span', () => {
  const pre = normalizeEvent(payload(), { nowMs: 200 })!;
  const post = normalizeEvent(payload({ hook_event_name: 'PostToolUse' }), { nowMs: 100 })!;
  assert.equal(groupCalls([pre, post])[0].status, 'clock_inconsistent');
  assert.equal(groupCalls([pre, post])[0].observed_span_ms, null);
  assert.equal(groupCalls([pre, pre, post])[0].status, 'duplicate_events');
  const other = normalizeEvent(payload({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }), { nowMs: 400 })!;
  assert.equal(groupCalls([pre, other])[0].status, 'identity_mismatch');
});

test('post input omission preserves the original call target evidence', () => {
  for (const [input, expected] of [
    [{ code: 'await app.getAXState()' }, 'opaque_code'],
    [{ app: 'TextEdit', window_id: 123 }, 'explicit_fields'],
  ] as const) {
    const pre = normalizeEvent(payload({ tool_input: input }), { nowMs: 100 })!;
    const post = normalizeEvent(payload({ hook_event_name: 'PostToolUse' }), { nowMs: 200 })!;
    assert.equal(post.target_info, 'none');
    assert.equal(groupCalls([pre, post])[0].target_info, expected);
    assert.equal(summarizeEvents([pre, post]).candidate_target_info[expected], 1);
  }
});

test('pre input evidence takes precedence, with post evidence used only if pre has none', () => {
  const pre = normalizeEvent(payload({ tool_input: { app: 'TextEdit' } }), { nowMs: 100 })!;
  const post = normalizeEvent(payload({ hook_event_name: 'PostToolUse', tool_input: { code: 'different shape' } }), { nowMs: 200 })!;
  assert.equal(groupCalls([pre, post])[0].target_info, 'explicit_fields');
  const emptyPre = normalizeEvent(payload(), { nowMs: 100 })!;
  assert.equal(groupCalls([emptyPre, post])[0].target_info, 'opaque_code');
});

test('state is independent from caller CWD and a missing trace is read-only', async () => {
  assert.ok(stateDirectory().endsWith('/.ccuh/'));
  const parent = await mkdtemp(join(tmpdir(), 'ccuh-missing-'));
  const missing = join(parent, 'not-created');
  try {
    assert.deepEqual(await readEvents({ stateDir: missing }), []);
    await assert.rejects(stat(missing), { code: 'ENOENT' });
    assert.throws(() => stateDirectory({ stateDir: 'relative' }));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('store rejects raw payloads and tolerates corrupt/incomplete appended records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccuh-store-'));
  try {
    await assert.rejects(appendEvent(payload() as never, { stateDir: dir }));
    const event = normalizeEvent(payload({ tool_input: { code: 'SECRET_NEVER_ON_DISK' } }), { nowMs: 1000 })!;
    await appendEvent(event, { stateDir: dir });
    const text = await readFile(join(dir, 'events.jsonl'), 'utf8');
    assert.equal(text.includes('SECRET_NEVER_ON_DISK'), false);
    assert.equal((await stat(join(dir, 'events.jsonl'))).mode & 0o777, 0o600);
    await writeFile(join(dir, 'events.jsonl'), text + '{bad}\n' + JSON.stringify({ ...event, raw: 'secret' }) + '\n' + '{incomplete');
    assert.deepEqual(await readEvents({ stateDir: dir }), [event]);
    await assert.rejects(readEvents({ stateDir: dir, limit: 0 }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
