import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_FILES = [
  "package.json",
  "package-lock.json",
  ".codex-plugin/plugin.json",
  "src/diagnostics.ts",
];
const VERSION_LITERAL =
  /^(export[ \t]+const[ \t]+VERSION[ \t]*=[ \t]*)(["'])([^"'\r\n]*)\2([ \t]*;)/gm;

class ReleaseError extends Error {}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseVersion(value, location) {
  const match =
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match || match[0] !== value) {
    throw new ReleaseError(`Invalid stable version in ${location}.`);
  }
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    throw new ReleaseError(`Version exceeds the safe integer limit in ${location}.`);
  }
  return parts;
}

function readFile(root, file) {
  const path = join(root, file);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("Not a regular file");
    return { file, path, text: readFileSync(path, "utf8"), mode: stat.mode & 0o777 };
  } catch {
    throw new ReleaseError(`Could not read regular release file ${file}.`);
  }
}

function readJson(input) {
  let value;
  try {
    value = JSON.parse(input.text);
  } catch {
    throw new ReleaseError(`Invalid JSON in ${input.file}.`);
  }
  if (!object(value) || value.name !== "ccuh") {
    throw new ReleaseError(`Invalid CCUH metadata in ${input.file}.`);
  }
  return value;
}

function readLiteral(input) {
  const matches = [...input.text.matchAll(VERSION_LITERAL)];
  if (matches.length !== 1) {
    throw new ReleaseError(`Expected one VERSION string literal in ${input.file}.`);
  }
  parseVersion(matches[0][3], input.file);
  return matches[0][3];
}

function readReleaseInputs(root) {
  const inputs = SOURCE_FILES.map((file) => readFile(resolve(root), file));
  const [packageInput, lockInput, pluginInput, sourceInput] = inputs;
  const pkg = readJson(packageInput);
  const lock = readJson(lockInput);
  const plugin = readJson(pluginInput);
  if (
    lock.lockfileVersion !== 3 ||
    !object(lock.packages) ||
    !object(lock.packages[""]) ||
    lock.packages[""].name !== "ccuh"
  ) {
    throw new ReleaseError("Expected a v3 package lock with CCUH root metadata.");
  }
  const versions = [
    [pkg.version, "package.json"],
    [lock.version, "package-lock.json"],
    [lock.packages[""].version, "package-lock.json root package"],
    [plugin.version, ".codex-plugin/plugin.json"],
    [readLiteral(sourceInput), "src/diagnostics.ts"],
  ];
  for (const [version, location] of versions) parseVersion(version, location);
  if (versions.some(([version]) => version !== pkg.version)) {
    throw new ReleaseError("Release source versions do not match.");
  }
  return { inputs, pkg, lock, plugin, version: pkg.version };
}

export function readReleaseVersion(root = REPOSITORY_ROOT) {
  return readReleaseInputs(root).version;
}

export function bumpReleaseVersion(kind = "patch", root = REPOSITORY_ROOT) {
  if (!["patch", "minor", "major"].includes(kind)) {
    throw new ReleaseError("Release kind must be patch, minor or major.");
  }
  const { inputs, pkg, lock, plugin, version } = readReleaseInputs(root);
  const parts = parseVersion(version, "package.json");
  const index = { major: 0, minor: 1, patch: 2 }[kind];
  parts[index] += 1;
  for (let next = index + 1; next < parts.length; next++) parts[next] = 0;
  if (!parts.every(Number.isSafeInteger)) {
    throw new ReleaseError("Next release version exceeds the safe integer limit.");
  }
  const nextVersion = parts.join(".");
  pkg.version = nextVersion;
  lock.version = nextVersion;
  lock.packages[""].version = nextVersion;
  plugin.version = nextVersion;
  const replacements = [pkg, lock, plugin].map(
    (value) => JSON.stringify(value, null, 2) + "\n",
  );
  replacements.push(
    inputs[3].text.replace(
      VERSION_LITERAL,
      (_match, prefix, quote, _version, suffix) =>
        prefix + quote + nextVersion + quote + suffix,
    ),
  );
  const staged = [];
  try {
    // 모든 입력 검증과 임시 파일 준비가 끝난 뒤 원본을 교체합니다.
    for (const [index, input] of inputs.entries()) {
      const temporary = join(
        dirname(input.path),
        `.${basename(input.path)}.ccuh-release-${randomUUID()}.tmp`,
      );
      const handle = openSync(temporary, "wx", input.mode);
      staged.push({ temporary, input });
      try {
        writeFileSync(handle, replacements[index], "utf8");
      } finally {
        closeSync(handle);
      }
    }
    for (const input of inputs) {
      if (readFile(resolve(root), input.file).text !== input.text) {
        throw new ReleaseError("Release inputs changed during preparation.");
      }
    }
    for (const { temporary, input } of staged) renameSync(temporary, input.path);
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError("Could not update release files. Do not publish this checkout.");
  } finally {
    let cleanupFailed = false;
    for (const { temporary } of staged) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      throw new ReleaseError("Could not remove release staging files.");
    }
  }
  return nextVersion;
}

export function checkRelease(root = REPOSITORY_ROOT) {
  const version = readReleaseVersion(root);
  if (readLiteral(readFile(resolve(root), "dist/diagnostics.js")) !== version) {
    throw new ReleaseError("Compiled release version does not match source metadata.");
  }
  return version;
}

function isDirectRun() {
  try {
    return (
      process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    const [command, kind, ...extra] = process.argv.slice(2);
    const version =
      command === "check" && kind === undefined
        ? checkRelease()
        : command === "bump" && kind !== undefined && extra.length === 0
          ? bumpReleaseVersion(kind)
          : null;
    if (version === null) {
      throw new ReleaseError("Usage: release.mjs check | bump patch|minor|major");
    }
    process.stdout.write(version + "\n");
  } catch (error) {
    process.stderr.write(
      "CCUH: " +
        (error instanceof ReleaseError ? error.message : "Release operation failed.") +
        "\n",
    );
    process.exitCode = 1;
  }
}
