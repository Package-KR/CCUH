import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import type { ChildProcess } from 'node:child_process';

export type EnvironmentCollectorPrepareOptions = { timeoutMs: number; force?: boolean };
export type EnvironmentCollectorPrepareReason =
  | 'unsupported-platform'
  | 'compiler-unavailable'
  | 'prepare-timeout'
  | 'prepare-failed'
  | 'cache-unavailable';
export type EnvironmentCollectorPrepareResult =
  | { status: 'ready'; path: string; sourceHash: string }
  | { status: 'unavailable'; reason: EnvironmentCollectorPrepareReason; sourceHash?: string };

type RunResult = { status: 'succeeded' | 'failed' | 'timed-out'; stdout: string };
type Compiler = { developer: string; clang: string; linker: string; sdk: string };
type CompilerResult =
  | { status: 'ready'; compiler: Compiler }
  | { status: 'unavailable'; reason: EnvironmentCollectorPrepareReason };
type CacheState = 'ready' | 'missing' | 'invalid';
type LockIdentity = { dev: number; ino: number };

const FAILURE_TTL_MS = 5 * 60 * 1000;
const SOURCE_LIMIT_BYTES = 512 * 1024;
const FAILURE_REASONS = new Set<EnvironmentCollectorPrepareReason>([
  'compiler-unavailable',
  'prepare-timeout',
  'prepare-failed',
  'cache-unavailable',
]);

// 원문 없는 준비 실패 결과 구성
function unavailable(
  reason: EnvironmentCollectorPrepareReason,
  sourceHash?: string,
): EnvironmentCollectorPrepareResult {
  return { status: 'unavailable', reason, ...(sourceHash === undefined ? {} : { sourceHash }) };
}

// 오류 코드의 파일 부재 여부 확인
function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

// 준비 작업의 남은 시간 계산
function remaining(deadline: number): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

// 사용자 전용 캐시 디렉터리 생성과 검증
async function privateDirectory(path: string, uid: number): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o700) {
    throw new Error('Cache directory unavailable');
  }
}

// 캐시 실행 파일의 소유권과 실행 형식 확인
async function cachedBinary(path: string, uid: number, arch: 'arm64' | 'x64'): Promise<CacheState> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o700 || info.size < 32) return 'invalid';
    const header = Buffer.alloc(8);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const cpu = arch === 'arm64' ? 0x0100000c : 0x01000007;
    if (bytesRead !== header.length || header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== cpu)
      return 'invalid';
    await access(path, constants.X_OK);
    return 'ready';
  } catch (error) {
    return missing(error) ? 'missing' : 'invalid';
  } finally {
    await file?.close().catch(() => {});
  }
}

// 같은 소스의 최근 준비 실패 확인
async function recentFailure(
  path: string,
  uid: number,
  sourceHash: string,
  arch: string,
): Promise<EnvironmentCollectorPrepareReason | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.size > 1024) return;
    const value: unknown = JSON.parse(await file.readFile('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const age = Date.now() - Number(record.failedAt);
    if (
      record.schemaVersion !== 1 ||
      record.sourceHash !== sourceHash ||
      record.arch !== arch ||
      typeof record.failedAt !== 'number' ||
      !Number.isFinite(record.failedAt) ||
      age < 0 ||
      age >= FAILURE_TTL_MS ||
      typeof record.reason !== 'string' ||
      !FAILURE_REASONS.has(record.reason as EnvironmentCollectorPrepareReason)
    )
      return;
    return record.reason as EnvironmentCollectorPrepareReason;
  } catch {
    return;
  } finally {
    await file?.close().catch(() => {});
  }
}

// 고정 사유의 실패 래치를 원자적으로 저장
async function rememberFailure(
  directory: string,
  reason: EnvironmentCollectorPrepareReason,
  sourceHash: string,
  arch: string,
): Promise<void> {
  const temporary = join(directory, `.failure-${randomUUID()}.pending`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ schemaVersion: 1, sourceHash, arch, reason, failedAt: Date.now() }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    await rename(temporary, join(directory, 'failure.json'));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

// 이번 호출이 시작한 프로세스 그룹만 종료
function killOwned(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

// 설치 유도 없이 절대 경로의 프로세스 실행
async function runOwned(
  command: string,
  args: string[],
  timeoutMs: number,
  captureBytes = 0,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  if (timeoutMs <= 0) return { status: 'timed-out', stdout: '' };
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env ? { env } : {}),
      });
    } catch {
      resolve({ status: 'failed', stdout: '' });
      return;
    }
    let timedOut = false;
    let failed = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      killOwned(child);
    }, timeoutMs);
    child.stdout?.on('data', chunk => {
      if (captureBytes === 0 || failed) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > captureBytes) {
        failed = true;
        chunks.length = 0;
        killOwned(child);
      } else chunks.push(bytes);
    });
    child.stderr?.resume();
    child.once('error', () => {
      failed = true;
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 'timed-out' : !failed && code === 0 ? 'succeeded' : 'failed',
        stdout: !failed && !timedOut ? Buffer.concat(chunks).toString('utf8') : '',
      });
    });
  });
}

// 선택된 개발 도구 안에 있는 경로인지 확인
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith('../') && !isAbsolute(part);
}

// 선택된 Xcode 또는 Command Line Tools의 실제 도구 확인
async function compilerPaths(deadline: number): Promise<CompilerResult> {
  const selection = await runOwned('/usr/bin/xcode-select', ['-p'], remaining(deadline), 8192);
  if (selection.status === 'timed-out') return { status: 'unavailable', reason: 'prepare-timeout' };
  if (selection.status !== 'succeeded') return { status: 'unavailable', reason: 'compiler-unavailable' };
  const selected = selection.stdout.trim();
  if (!isAbsolute(selected) || /[\r\n\u0000]/u.test(selected))
    return { status: 'unavailable', reason: 'compiler-unavailable' };
  try {
    const developer = await realpath(selected);
    const commandLineTools = developer.endsWith('/CommandLineTools');
    if (!commandLineTools && !developer.endsWith('.app/Contents/Developer'))
      return { status: 'unavailable', reason: 'compiler-unavailable' };
    const clang = await realpath(
      join(developer, commandLineTools ? 'usr/bin/clang' : 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang'),
    );
    const linker = await realpath(join(dirname(clang), 'ld'));
    const sdk = await realpath(
      join(developer, commandLineTools ? 'SDKs/MacOSX.sdk' : 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'),
    );
    if (![clang, linker, sdk].every(path => inside(developer, path)))
      return { status: 'unavailable', reason: 'compiler-unavailable' };
    const [clangInfo, linkerInfo, sdkInfo] = await Promise.all([lstat(clang), lstat(linker), lstat(sdk)]);
    if (!clangInfo.isFile() || !linkerInfo.isFile() || !sdkInfo.isDirectory())
      return { status: 'unavailable', reason: 'compiler-unavailable' };
    await Promise.all([access(clang, constants.X_OK), access(linker, constants.X_OK)]);
    return { status: 'ready', compiler: { developer, clang, linker, sdk } };
  } catch {
    return { status: 'unavailable', reason: 'compiler-unavailable' };
  }
}

// 캐시 준비 경합의 제한된 대기
async function pause(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

// 自分が取得した空のロックだけ解除
async function releaseLock(path: string, identity: LockIdentity | undefined): Promise<void> {
  if (!identity) return;
  try {
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink() && info.dev === identity.dev && info.ino === identity.ino)
      await rmdir(path);
  } catch {}
}

// 소스와 아키텍처에 맞는 읽기 전용 수집기 준비
export async function ensureEnvironmentCollector(
  options: EnvironmentCollectorPrepareOptions,
): Promise<EnvironmentCollectorPrepareResult> {
  if (process.platform !== 'darwin' || (process.arch !== 'arm64' && process.arch !== 'x64'))
    return unavailable('unsupported-platform');
  if (
    !options ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    (options.force !== undefined && typeof options.force !== 'boolean')
  )
    return unavailable('prepare-failed');
  const deadline = performance.now() + Math.min(options.timeoutMs, 30000);
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) return unavailable('cache-unavailable');
  const arch = process.arch;
  let source: Buffer;
  let sourceHash: string;
  try {
    const sourcePath = fileURLToPath(new URL('./collector.m', import.meta.url));
    const sourceInfo = await lstat(sourcePath);
    if (
      !sourceInfo.isFile() ||
      sourceInfo.isSymbolicLink() ||
      sourceInfo.size === 0 ||
      sourceInfo.size > SOURCE_LIMIT_BYTES
    )
      return unavailable('prepare-failed');
    source = await readFile(sourcePath);
    if (source.length !== sourceInfo.size) return unavailable('prepare-failed');
    sourceHash = createHash('sha256').update(source).digest('hex');
  } catch {
    return unavailable('prepare-failed');
  }
  let directory: string;
  try {
    const base = join(await realpath(tmpdir()), `ccuh-environment-${uid}`);
    await privateDirectory(base, uid);
    directory = join(base, `${sourceHash}-${arch}`);
    await privateDirectory(directory, uid);
  } catch {
    return unavailable('cache-unavailable', sourceHash);
  }
  const binary = join(directory, 'collector');
  const failureFile = join(directory, 'failure.json');
  const lock = join(directory, 'build.lock');
  let lockIdentity: LockIdentity | undefined;
  let work: string | undefined;
  // 같은 소스의 실패를 짧은 기간만 공유
  async function fail(reason: EnvironmentCollectorPrepareReason): Promise<EnvironmentCollectorPrepareResult> {
    await rememberFailure(directory, reason, sourceHash, arch).catch(() => {});
    return unavailable(reason, sourceHash);
  }
  try {
    while (true) {
      const cached = await cachedBinary(binary, uid, arch);
      if (cached === 'ready') return { status: 'ready', path: binary, sourceHash };
      if (cached === 'invalid') return await fail('cache-unavailable');
      if (!options.force) {
        const reason = await recentFailure(failureFile, uid, sourceHash, arch);
        if (reason) return unavailable(reason, sourceHash);
      }
      if (remaining(deadline) <= 0) return await fail('prepare-timeout');
      try {
        await mkdir(lock, { mode: 0o700 });
        const info = await lstat(lock);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o700)
          return await fail('cache-unavailable');
        lockIdentity = { dev: info.dev, ino: info.ino };
        break;
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'))
          return await fail('cache-unavailable');
        let info;
        try {
          info = await lstat(lock);
        } catch (error) {
          if (missing(error)) continue;
          return await fail('cache-unavailable');
        }
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o700)
          return await fail('cache-unavailable');
        if (options.force) break;
        await pause(Math.min(25, remaining(deadline)));
      }
    }
    const claimed = await cachedBinary(binary, uid, arch);
    if (claimed === 'ready') return { status: 'ready', path: binary, sourceHash };
    if (claimed === 'invalid') return await fail('cache-unavailable');
    if (!options.force) {
      const reason = await recentFailure(failureFile, uid, sourceHash, arch);
      if (reason) return unavailable(reason, sourceHash);
    }
    if (remaining(deadline) <= 0) return await fail('prepare-timeout');
    const selected = await compilerPaths(deadline);
    if (selected.status !== 'ready') return await fail(selected.reason);
    if (remaining(deadline) <= 0) return await fail('prepare-timeout');
    work = await mkdtemp(join(directory, '.build-'));
    await chmod(work, 0o700);
    const copiedSource = join(work, 'collector.m');
    const temporaryBinary = join(work, 'collector');
    await writeFile(copiedSource, source, { flag: 'wx', mode: 0o600 });
    const cpu = arch === 'arm64' ? 'arm64' : 'x86_64';
    const { compiler } = selected;
    const args = [
      '-fobjc-arc',
      '-O2',
      '-arch',
      cpu,
      '-isysroot',
      compiler.sdk,
      `-fuse-ld=${compiler.linker}`,
      '-framework',
      'Foundation',
      '-framework',
      'AppKit',
      '-framework',
      'CoreGraphics',
      copiedSource,
      '-o',
      temporaryBinary,
    ];
    const compilation = await runOwned(compiler.clang, args, remaining(deadline), 0, {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      DEVELOPER_DIR: compiler.developer,
      SDKROOT: compiler.sdk,
      TMPDIR: work,
      LANG: 'C',
      LC_ALL: 'C',
    });
    if (compilation.status === 'timed-out') return await fail('prepare-timeout');
    if (compilation.status !== 'succeeded') return await fail('prepare-failed');
    await chmod(temporaryBinary, 0o700);
    if ((await cachedBinary(temporaryBinary, uid, arch)) !== 'ready') return await fail('prepare-failed');
    if (remaining(deadline) <= 0) return await fail('prepare-timeout');
    const published = await cachedBinary(binary, uid, arch);
    if (published === 'invalid') return await fail('cache-unavailable');
    if (published === 'missing') await rename(temporaryBinary, binary);
    if ((await cachedBinary(binary, uid, arch)) !== 'ready') return await fail('cache-unavailable');
    await unlink(failureFile).catch(() => {});
    return { status: 'ready', path: binary, sourceHash };
  } catch {
    return await fail('cache-unavailable');
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
    await releaseLock(lock, lockIdentity);
  }
}
