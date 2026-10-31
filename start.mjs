#!/usr/bin/env node
import { PluginRuntimeError, PluginRuntimeInterruptedError, preparePluginRuntime } from './scripts/plugin-runtime.mjs';

try {
  const { serverUrl } = await preparePluginRuntime();
  const { startServer } = await import(serverUrl);
  await startServer();
} catch (error) {
  const message = error instanceof PluginRuntimeError ? error.message : 'The CCUH MCP server could not start. Check the plugin installation.';
  process.stderr.write('CCUH: ' + message + '\n');
  process.exitCode = error instanceof PluginRuntimeInterruptedError ? (error.signal === 'SIGINT' ? 130 : 143) : 1;
}
