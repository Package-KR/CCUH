import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { Script } from 'node:vm';

// 자체 데이터 필드로 된 도구 인수 복제
export function toolArguments(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return;
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(fields).some(
      key => typeof key !== 'string' || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable,
    ) ||
    !Object.hasOwn(fields, 'code') ||
    typeof fields.code.value !== 'string'
  )
    return;
  return { ...input };
}

// 고정 생성물의 제한된 바이트와 구문 및 해시 검사
export async function runtimeSource(url: URL, limit: number) {
  const file = await open(url, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size === 0 || stat.size > limit) return;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) return;
    const bytes = buffer.subarray(0, stat.size);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return;
    const code = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(code, 'utf8').equals(bytes)) return;
    const hashes = [...code.matchAll(/\bsourceHash:\s*(['"])([a-f0-9]{64})\1/gu)];
    if (hashes.length !== 1) return;
    new Script(code);
    return { code, runtimeHash: createHash('sha256').update(bytes).digest('hex'), sourceHash: hashes[0][2] };
  } finally {
    await file.close();
  }
}
