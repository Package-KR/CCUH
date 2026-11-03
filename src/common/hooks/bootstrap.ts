import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { Script } from 'node:vm';

export const CUA_BOOTSTRAP_MARKER = '// CCUH_BOOTSTRAP_V1';
export type BootstrapPlan =
  | { status: 'not-requested' }
  | { status: 'unavailable' }
  | { status: 'proposed'; input: Record<string, unknown>; intendedCodeHash: string; runtimeHash: string };

const MAX_RUNTIME_BYTES = 256 * 1024;
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
];

// 정확한 표식과 자체 데이터 필드로 된 도구 인수 복제
function markerArguments(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return;
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(fields).some(
      key => typeof key !== 'string' || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable,
    ) ||
    !Object.hasOwn(fields, 'code') ||
    fields.code.value !== CUA_BOOTSTRAP_MARKER
  )
    return;
  return { ...input };
}

// 고정 런타임 파일을 상한 안에서 한 번 읽기
async function runtimeBytes(): Promise<Buffer | undefined> {
  const file = await open(new URL('../../../dist/recognition/runtime.js', import.meta.url), 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size === 0 || stat.size > MAX_RUNTIME_BYTES) return;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead === stat.size ? buffer.subarray(0, stat.size) : undefined;
  } finally {
    await file.close();
  }
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
    const bytes = await runtimeBytes();
    if (!bytes || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) return { status: 'unavailable' };
    const runtime = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(runtime, 'utf8').equals(bytes)) return { status: 'unavailable' };
    const hashes = [...runtime.matchAll(/\bsourceHash:\s*(['"])([a-f0-9]{64})\1/gu)];
    if (hashes.length !== 1) return { status: 'unavailable' };
    new Script(runtime);
    const runtimeHash = createHash('sha256').update(bytes).digest('hex');
    const code = bootstrapCode(runtime, runtimeHash, hashes[0][2]);
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
