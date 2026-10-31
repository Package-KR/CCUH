import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function body(result: any) {
  const text = result.content?.find((c: any) => c.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  return JSON.parse(text);
}

test('official SDK client completes stdio discovery, event ingestion and diagnostics', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ccuh-mcp-'));
  const client = new Client({ name: 'ccuh-local-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.ts', import.meta.url))],
    env: { CCUH_STATE_DIR: dir },
    stderr: 'pipe',
  });
  t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['ccuh_observe_event', 'ccuh_recent_calls', 'ccuh_status']);
  const initial = body(await client.callTool({ name: 'ccuh_status', arguments: {} }));
  assert.equal(initial.evidence.mcp_connection, 'responding');
  assert.equal(initial.evidence.hook_records, 'no_records');
  assert.equal(initial.evidence.computer_use_binding, 'not_verified');

  const event = {
    session_id: 'private-session-id', tool_use_id: 'private-call-id',
    tool_name: 'mcp__cua_repl__js',
    tool_input: { code: 'SECRET_CODE_AND_CHAT_BODY', app: 'PRIVATE_APP_TITLE', password: 'SECRET_PASSWORD' },
  };
  for (const phase of ['PreToolUse', 'PostToolUse']) {
    const result = await client.callTool({ name: 'ccuh_observe_event', arguments: {
      event: { ...event, hook_event_name: phase, tool_response: { isError: false, content: 'SECRET_RESPONSE' } },
    } });
    assert.equal(body(result).recorded, true);
  }
  const after = body(await client.callTool({ name: 'ccuh_status', arguments: {} }));
  assert.equal(after.evidence.mcp_event_records, 2);
  assert.equal(after.evidence.hook_records, 'no_records');
  assert.equal(after.evidence.paired_candidate_calls, 1);
  assert.equal(after.evidence.native_app_selection, 'not_implemented');
  const recent = body(await client.callTool({ name: 'ccuh_recent_calls', arguments: { limit: 1 } }));
  assert.equal(recent.calls.length, 1);
  assert.equal(recent.calls[0].status, 'paired');
  const stored = await readFile(join(dir, 'events.jsonl'), 'utf8');
  for (const value of ['SECRET_CODE_AND_CHAT_BODY','PRIVATE_APP_TITLE','SECRET_PASSWORD','SECRET_RESPONSE','private-session-id','private-call-id']) {
    assert.equal(stored.includes(value), false);
  }

  const excluded = await client.callTool({ name: 'ccuh_observe_event', arguments: {
    event: { ...event, hook_event_name: 'PreToolUse', tool_name: 'mcp__ccuh__ccuh_status' },
  } });
  assert.equal(excluded.isError, true);
  assert.equal(body(excluded).recorded, false);
});
