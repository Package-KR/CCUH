import { closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_FILES = ['package.json', 'package-lock.json', '.codex-plugin/plugin.json'];

class ReleaseError extends Error {}

// 메타데이터 객체 판별
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 안정 버전 형식과 범위 검사
function parseVersion(value) {
  const match = typeof value === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match || match[0] !== value) throw new ReleaseError('Expected a stable MAJOR.MINOR.PATCH version.');
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new ReleaseError('Version exceeds the safe integer limit.');
  return parts;
}

// 릴리스 메타데이터 파일 읽기
function readInput(root, file) {
  const path = join(root, file);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error('Not a regular file');
    const text = readFileSync(path, 'utf8');
    const value = JSON.parse(text);
    if (!isRecord(value) || value.name !== 'ccuh') throw new Error('Invalid metadata');
    return { path, file, text, value, mode: stat.mode & 0o777 };
  } catch {
    throw new ReleaseError(`Could not read regular CCUH metadata in ${file}.`);
  }
}

// 릴리스 파일의 버전 일치 확인
function readReleaseInputs(root) {
  const inputs = SOURCE_FILES.map(file => readInput(resolve(root), file));
  const [pkg, lock, plugin] = inputs.map(input => input.value);
  if (
    lock.lockfileVersion !== 3 ||
    !isRecord(lock.packages) ||
    !isRecord(lock.packages['']) ||
    lock.packages[''].name !== 'ccuh'
  )
    throw new ReleaseError('Expected a v3 package lock with CCUH root metadata.');
  const versions = [pkg.version, lock.version, lock.packages[''].version, plugin.version];
  for (const version of versions) parseVersion(version);
  if (versions.some(version => version !== pkg.version)) throw new ReleaseError('Release versions do not match.');
  return { inputs, pkg, lock, plugin, version: pkg.version };
}

// 현재 릴리스 버전 조회
export function checkRelease(root = REPOSITORY_ROOT) {
  return readReleaseInputs(root).version;
}

// 커밋 메시지의 버전 증가 폭 판정
export function classifyCommitBump(message) {
  if (typeof message !== 'string') throw new ReleaseError('Expected a commit message string.');
  const [subject, ...body] = message.replace(/\r\n/g, '\n').split('\n');
  if (/^BREAKING(?: |-)CHANGE:[ \t]+\S/m.test(body.join('\n'))) return 'major';
  const header = /^([a-z][a-z0-9-]*)(?:\([^()\r\n]+\))?(!)?:[ \t]+\S.*$/i.exec(subject);
  if (!header) return 'patch';
  if (header[2]) return 'major';
  return header[1].toLowerCase() === 'feat' ? 'minor' : 'patch';
}

// 로컬 릴리스 이력 조회
function readGit(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: resolve(root),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new ReleaseError('Could not inspect a complete local release history.');
  }
}

// 현재 버전 이후 커밋의 가장 큰 증가 폭 선택
export function detectReleaseBump(kind = 'auto', root = REPOSITORY_ROOT) {
  if (!['auto', 'patch', 'minor', 'major'].includes(kind))
    throw new ReleaseError('Release kind must be auto, patch, minor or major.');
  if (kind !== 'auto') return kind;
  const version = checkRelease(root);
  let base;
  try {
    base = readGit(root, ['rev-parse', '--verify', `refs/tags/v${version}^{commit}`]).trim();
    readGit(root, ['merge-base', '--is-ancestor', base, 'HEAD']);
  } catch {
    throw new ReleaseError('The current version tag must exist and be an ancestor of HEAD.');
  }
  const messages = readGit(root, ['log', '-z', '--format=%B', `${base}..HEAD`, '--']).split('\0');
  let bump = 'patch';
  for (const message of messages) {
    if (!message) continue;
    const candidate = classifyCommitBump(message);
    if (candidate === 'major') return 'major';
    if (candidate === 'minor') bump = 'minor';
  }
  return bump;
}

// 검증한 메타데이터 파일 교체
function replaceInputs(inputs) {
  const staged = [];
  try {
    for (const input of inputs) {
      const temporary = join(dirname(input.path), `.${basename(input.path)}.ccuh-release-${randomUUID()}.tmp`);
      const handle = openSync(temporary, 'wx', input.mode);
      staged.push({ temporary, input });
      try {
        writeFileSync(handle, JSON.stringify(input.value, null, 2) + '\n', 'utf8');
      } finally {
        closeSync(handle);
      }
    }
    for (const input of inputs) {
      if (readFileSync(input.path, 'utf8') !== input.text)
        throw new ReleaseError('Release inputs changed during preparation.');
    }
    for (const { temporary, input } of staged) renameSync(temporary, input.path);
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError('Could not update release files. Do not publish this checkout.');
  } finally {
    let cleanupFailed = false;
    for (const { temporary } of staged) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== 'ENOENT') cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new ReleaseError('Could not remove release staging files.');
  }
}

// 릴리스 버전 증가
export function bumpReleaseVersion(kind, root = REPOSITORY_ROOT) {
  if (!['patch', 'minor', 'major'].includes(kind))
    throw new ReleaseError('Release kind must be patch, minor or major.');
  const { inputs, pkg, lock, plugin, version } = readReleaseInputs(root);
  const parts = parseVersion(version);
  const index = { major: 0, minor: 1, patch: 2 }[kind];
  parts[index] += 1;
  for (let next = index + 1; next < parts.length; next++) parts[next] = 0;
  if (!parts.every(Number.isSafeInteger)) throw new ReleaseError('Next version exceeds the safe integer limit.');
  const nextVersion = parts.join('.');
  pkg.version = nextVersion;
  lock.version = nextVersion;
  lock.packages[''].version = nextVersion;
  plugin.version = nextVersion;
  replaceInputs(inputs);
  return nextVersion;
}

// 릴리스 명령 처리
function run() {
  const [command, kind, ...extra] = process.argv.slice(2);
  if (command === 'check' && kind === undefined) return checkRelease();
  if (command === 'detect' && extra.length === 0) return detectReleaseBump(kind);
  if (command === 'bump' && kind !== undefined && extra.length === 0) return bumpReleaseVersion(kind);
  throw new ReleaseError('Usage: release.mjs check | detect [auto|patch|minor|major] | bump patch|minor|major');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(run() + '\n');
  } catch (error) {
    process.stderr.write(
      'CCUH: ' + (error instanceof ReleaseError ? error.message : 'Release operation failed.') + '\n',
    );
    process.exitCode = 1;
  }
}
