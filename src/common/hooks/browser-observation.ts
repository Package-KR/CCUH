import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

import { runtimeSource, toolArguments } from './runtime-source.ts';

import type { BootstrapPlan } from './bootstrap.ts';

export const CUA_BROWSER_WINDOW_MARKER = '// CCUH_BROWSER_WINDOW_V1';
const MARKER = /^\/\/ CCUH_BROWSER_WINDOW_V1 ([$A-Z_a-z][$\w]{0,63}) (0|[1-9][0-9]*)$/u;
const MAX_BROWSER_RUNTIME_BYTES = 32 * 1024;
const RESERVED_BINDINGS = new Set(['globalThis', 'cua', 'nodeRepl', 'agent', 'undefined', 'eval', 'arguments']);

// 명시한 기존 브라우저와 숫자만 사용하는 한 번의 관측 셀 구성
function observationCode(runtime: string, binding: string, tabId: number, runtimeHash: string): string {
  return `await (async (readBrowser) => {
  let selectedBrowser;
  try { selectedBrowser = readBrowser(); } catch {}
  await (
${runtime}
  )(selectedBrowser, ${tabId}, '${runtimeHash}');
})(() => ${binding});`;
}

// 브라우저 전용 표식만 읽기 전용 관측으로 치환 준비
export async function prepareBrowserObservation(toolName: string, input: unknown): Promise<BootstrapPlan> {
  if (toolName !== 'mcp__cua_repl__js') return { status: 'not-requested' };
  let args: Record<string, unknown> | undefined;
  let match: RegExpMatchArray | null;
  try {
    args = toolArguments(input);
    if (!args) return { status: 'not-requested' };
    match = (args.code as string).match(MARKER);
    if (!match || match[0] !== args.code) return { status: 'not-requested' };
  } catch {
    return { status: 'not-requested' };
  }
  try {
    const [, binding, literal] = match;
    const tabId = Number(literal);
    if (RESERVED_BINDINGS.has(binding) || !Number.isSafeInteger(tabId)) return { status: 'unavailable' };
    new Script(`"use strict"; (async (${binding}) => {})`);
    const runtime = await runtimeSource(
      new URL('../../../dist/recognition/browser-window.js', import.meta.url),
      MAX_BROWSER_RUNTIME_BYTES,
    );
    if (!runtime) return { status: 'unavailable' };
    const code = observationCode(runtime.code, binding, tabId, runtime.runtimeHash);
    new Script(`(async () => {\n${code}\n})()`);
    return {
      status: 'proposed',
      input: { ...args, code },
      intendedCodeHash: createHash('sha256').update(code).digest('hex'),
      runtimeHash: runtime.runtimeHash,
    };
  } catch {
    return { status: 'unavailable' };
  }
}
