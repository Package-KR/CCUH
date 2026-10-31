import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupCalls, readEvents } from '../src/codex/store.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
function invoke(name: string, input: string, dir: string) {
  return spawnSync(process.execPath, [join(root, 'hooks/codex', name + '.mjs')], {
    input, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, CCUH_STATE_DIR: dir, CCUH_TEST_MODE: '1' },
  });
}

test('pre and post hooks are silent, metadata-only and correlate through local storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccuh-hook-'));
  try {
    const common = { session_id: 'raw-session', tool_use_id: 'raw-call', tool_name: 'mcp__cua_repl__js',
      tool_input: { code: 'PRIVATE_CODE_SENTINEL' }, tool_response: { content: [{ text: 'PRIVATE_RESPONSE_SENTINEL' }] } };
    for (const [name, phase] of [['pretooluse', 'PreToolUse'], ['posttooluse', 'PostToolUse']]) {
      const result = invoke(name, JSON.stringify({ ...common, hook_event_name: phase }), dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
    const events = await readEvents({ stateDir: dir });
    assert.equal(events.length, 2);
    assert.equal(events.every(event => event.source === 'synthetic'), true);
    assert.equal(groupCalls(events)[0].status, 'paired');
    const disk = await readFile(join(dir, 'events.jsonl'), 'utf8');
    assert.equal(/PRIVATE_|raw-session|raw-call/.test(disk), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('malformed, missing-identity and oversized payloads fail open without stdout or raw leaks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccuh-hook-bad-'));
  try {
    for (const input of ['PRIVATE_INVALID_JSON', '{}', 'x'.repeat(1024 * 1024 + 1)]) {
      const result = invoke('pretooluse', input, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.includes('PRIVATE_INVALID_JSON'), false);
    }
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('storage errors cannot block the observed call or expose its arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccuh-hook-io-'));
  try {
    const raw = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_use_id: 'c',
      tool_name: 'Bash', tool_input: { command: 'PRIVATE_IO_SENTINEL' } });
    const result = invoke('pretooluse', raw, join(dir, 'events.jsonl', 'impossible'));
    // A valid path can be created; use a known regular file as a directory on the second call.
    assert.equal(result.stdout, '');
    const second = invoke('pretooluse', raw, join(dir, 'events.jsonl', 'impossible', 'events.jsonl', 'child'));
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '');
    assert.equal(second.stderr, 'CCUH: observation could not be recorded\n');
    assert.equal(second.stderr.includes('PRIVATE_IO_SENTINEL'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
