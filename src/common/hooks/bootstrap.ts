import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

import { runtimeSource, toolArguments } from './runtime-source.ts';

export const CUA_BOOTSTRAP_MARKER = '// CCUH_BOOTSTRAP_V1';
export type BootstrapPlan =
  | { status: 'not-requested' }
  | { status: 'unavailable' }
  | { status: 'proposed'; input: Record<string, unknown>; intendedCodeHash: string; runtimeHash: string };

const MAX_RUNTIME_BYTES = 256 * 1024;
const MAX_BOOTSTRAP_BYTES = 64_000;
const REQUIRED_FUNCTIONS = [
  'getMode',
  'setMode',
  'acquireApp',
  'createTarget',
  'prepareTarget',
  'withTarget',
  'withVerifiedTarget',
  'setDraftValue',
  'selectWindowFromMenu',
  'verifyModalDismissal',
  'observeBrowserTabWindow',
];

// 정확한 표식과 자체 데이터 필드로 된 도구 인수 복제
function markerArguments(input: unknown): Record<string, unknown> | undefined {
  const args = toolArguments(input);
  return args?.code === CUA_BOOTSTRAP_MARKER ? args : undefined;
}

// 원본 런타임을 보존하는 멱등 로드 셀 구성
function bootstrapCode(runtime: string, runtimeHash: string, sourceHash: string): string {
  return `(() => {
  const previous = typeof ccuh === 'undefined' ? undefined : ccuh;

  // 동결된 런타임 도우미의 자체 데이터 필드 확인
  function validHelper(helper) {
    if (helper === null || typeof helper !== 'object' || !Object.isFrozen(helper)) return false;
    const fields = Object.getOwnPropertyDescriptors(helper);
    return Object.hasOwn(fields, 'sourceHash') && Object.hasOwn(fields.sourceHash, 'value') &&
      fields.sourceHash.value === '${sourceHash}' &&
      ${JSON.stringify(REQUIRED_FUNCTIONS)}.every(name => Object.hasOwn(fields, name) &&
        Object.hasOwn(fields[name], 'value') && typeof fields[name].value === 'function');
  }

  let keep = false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__ccuhBootstrapRecord');
    const record = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    const fields = record && typeof record === 'object' ? Object.getOwnPropertyDescriptors(record) : undefined;
    keep = !!(fields && Object.isFrozen(record) && Reflect.ownKeys(fields).length === 2 &&
      Object.hasOwn(fields, 'runtimeHash') && Object.hasOwn(fields.runtimeHash, 'value') &&
      fields.runtimeHash.value === '${runtimeHash}' &&
      Object.hasOwn(fields, 'helper') && Object.hasOwn(fields.helper, 'value') &&
      fields.helper.value === previous && validHelper(previous));
  } catch {}
  const helper = keep ? previous : (() => {
${runtime}
    return typeof ccuh === 'undefined' ? undefined : ccuh;
  })();
  if (!validHelper(helper) || (!keep && helper === previous)) {
    throw new Error('CCUH bootstrap validation failed');
  }
  Object.defineProperty(globalThis, 'ccuh', {
    value: helper, writable: true, configurable: true, enumerable: false,
  });
  Object.defineProperty(globalThis, '__ccuhBootstrapRecord', {
    value: Object.freeze({ runtimeHash: '${runtimeHash}', helper }),
    writable: true, configurable: true, enumerable: false,
  });
  ccuh = helper;
  nodeRepl.write({ ccuhBootstrap: 'ready', state: keep ? 'kept' : 'loaded', runtimeHash: '${runtimeHash}', sourceHash: helper.sourceHash });
})();
`;
}

// 순수 부트스트랩 표식만 고정 런타임으로 치환 준비
export async function prepareBootstrap(toolName: string, input: unknown): Promise<BootstrapPlan> {
  if (toolName !== 'mcp__cua_repl__js') return { status: 'not-requested' };
  let args: Record<string, unknown> | undefined;
  try {
    args = markerArguments(input);
  } catch {
    return { status: 'not-requested' };
  }
  if (!args) return { status: 'not-requested' };
  try {
    const runtime = await runtimeSource(
      new URL('../../../dist/recognition/runtime.js', import.meta.url),
      MAX_RUNTIME_BYTES,
    );
    if (!runtime) return { status: 'unavailable' };
    const { runtimeHash } = runtime;
    const code = bootstrapCode(runtime.code, runtimeHash, runtime.sourceHash);
    if (Buffer.byteLength(code, 'utf8') > MAX_BOOTSTRAP_BYTES) return { status: 'unavailable' };
    new Script(code);
    return {
      status: 'proposed',
      input: { ...args, code },
      intendedCodeHash: createHash('sha256').update(code).digest('hex'),
      runtimeHash,
    };
  } catch {
    return { status: 'unavailable' };
  }
}
