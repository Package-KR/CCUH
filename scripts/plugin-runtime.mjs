import { fork, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class PluginRuntimeError extends Error {}

export class PluginRuntimeInterruptedError extends PluginRuntimeError {
  constructor(signal) {
    super(
      "Runtime dependency preparation was interrupted. Restart CCUH to retry.",
    );
    this.signal = signal;
  }
}

/** MCP and hook processes use the same location, independent of their CWD. */
export function pluginStateDirectory(env = process.env, home = homedir()) {
  if (env.CCUH_STATE_DIR !== undefined) {
    if (!isAbsolute(env.CCUH_STATE_DIR))
      throw new PluginRuntimeError("CCUH_STATE_DIR must be an absolute path.");
    return env.CCUH_STATE_DIR;
  }
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  if (!isAbsolute(codexHome))
    throw new PluginRuntimeError("CODEX_HOME must be an absolute path.");
  return join(codexHome, "ccuh", "state");
}

export function configurePluginState(env = process.env, home = homedir()) {
  const directory = pluginStateDirectory(env, home);
  env.CCUH_STATE_DIR = directory;
  return directory;
}

function dependenciesReady(root) {
  const require = createRequire(join(root, "package.json"));
  try {
    for (const name of [
      "@modelcontextprotocol/server",
      "@modelcontextprotocol/server/stdio",
      "zod/v4",
    ])
      require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/** Read-only identity and destination lookup; the Codex plugin cache must stay immutable. */
export async function resolvePluginRuntimePaths(options = {}) {
  const root = resolve(
    options.root ?? fileURLToPath(new URL("../", import.meta.url)),
  );
  const env = options.env ?? process.env;
  const codexHome =
    env.CODEX_HOME ?? join(options.homeDir ?? homedir(), ".codex");
  if (!isAbsolute(codexHome))
    throw new PluginRuntimeError("CODEX_HOME must be an absolute path.");
  const files = ["package.json"];
  if (await exists(join(root, "package-lock.json")))
    files.push("package-lock.json");
  async function collect(directory) {
    for (const entry of await readdir(join(root, directory), {
      withFileTypes: true,
    })) {
      const relative = directory + "/" + entry.name;
      if (entry.isDirectory()) await collect(relative);
      else if (entry.isFile() && entry.name.endsWith(".js"))
        files.push(relative);
    }
  }
  await collect("dist");
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const bytes = await readFile(join(root, file));
    hash.update(file + "\0" + bytes.length + "\0").update(bytes);
  }
  const identity = hash.digest("hex");
  const prefix = join(
    options.runtimeBaseDirectory ?? join(codexHome, "ccuh", "plugin-runtime"),
    identity,
  );
  return {
    root,
    identity,
    prefix,
    packageRoot: join(prefix, "node_modules", "ccuh"),
    lockPath: join(prefix, ".ccuh-bootstrap.lock"),
    incompletePath: join(prefix, ".ccuh-bootstrap.incomplete"),
  };
}

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

const noncePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function installerPid(name, nonce) {
  const match = new RegExp(
    "^installer-" + nonce + "-([1-9][0-9]*)\\.json$",
  ).exec(name);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) ? pid : undefined;
}

async function validInstallerMarker(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && info.size === 0;
  } catch {
    return false;
  }
}

async function readOwner(path, nonce) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 512) return undefined;
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      value.version === 1 &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      value.nonce === nonce
    )
      return value;
  } catch {
    /* Unknown or changing metadata must not be treated as a stale owner. */
  }
  return undefined;
}

/** Each owner has an immutable, unique filename. A stale remover cannot unlink a new owner's metadata. */
async function releaseLock(lockPath, nonce) {
  try {
    for (const name of await readdir(lockPath)) {
      const pid = installerPid(name, nonce);
      if (pid === undefined) continue;
      if (
        !(await validInstallerMarker(join(lockPath, name))) ||
        processIsAlive(pid)
      )
        return;
      await unlink(join(lockPath, name));
    }
  } catch {
    return;
  }
  try {
    await unlink(join(lockPath, nonce + ".json"));
  } catch {
    return;
  }
  try {
    await rmdir(lockPath);
  } catch {
    /* A replacement directory is nonempty and cannot be removed. */
  }
}

async function recoverDeadLock(lockPath) {
  try {
    if (!(await lstat(lockPath)).isDirectory()) return false;
    const entries = await readdir(lockPath);
    const owners = entries.filter(
      (name) => name.endsWith(".json") && noncePattern.test(name.slice(0, -5)),
    );
    if (owners.length !== 1) return false;
    const nonce = owners[0].slice(0, -5);
    const installers = entries.filter(
      (name) => installerPid(name, nonce) !== undefined,
    );
    if (
      installers.length > 1 ||
      entries.some((name) => name !== owners[0] && !installers.includes(name))
    )
      return false;
    const owner = await readOwner(join(lockPath, owners[0]), nonce);
    if (!owner || processIsAlive(owner.pid)) return false;
    if (installers.length) {
      if (
        !(await validInstallerMarker(join(lockPath, installers[0]))) ||
        processIsAlive(installerPid(installers[0], nonce))
      )
        return false;
    }
    await releaseLock(lockPath, nonce);
    return true;
  } catch {
    return false;
  }
}

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        /* Already closed. */
      }
    }
  }
}

/** The worker survives long enough to stop npm if its parent is killed or its IPC connection closes. */
async function runInstallWorker() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("disconnect", cancel);
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  const config = await new Promise((done) => {
    process.once("message", done);
    if (!process.connected) done(undefined);
    else process.once("disconnect", () => done(undefined));
  });
  if (!config || config.type === "cancel" || controller.signal.aborted) {
    if (process.connected) process.disconnect();
    return;
  }
  process.on("message", (message) => {
    if (message?.type === "cancel") cancel();
  });
  const marker = join(
    config.lockPath,
    "installer-" + config.nonce + "-" + process.pid + ".json",
  );
  try {
    const owner = await readOwner(
      join(config.lockPath, config.nonce + ".json"),
      config.nonce,
    );
    if (!owner || owner.pid !== process.ppid || !process.connected) return;
    // The parent publishes this complete marker before sending permission to launch npm.
    if (!(await validInstallerMarker(marker))) return;
    if (
      !process.connected ||
      controller.signal.aborted ||
      !processIsAlive(owner.pid)
    )
      return;
    await new Promise((done, reject) => {
      if (controller.signal.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      const child = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: process.env,
        stdio: "ignore",
        detached: true,
      });
      let forced;
      const stop = () => {
        killGroup(child, "SIGTERM");
        if (!forced) {
          forced = setTimeout(() => killGroup(child, "SIGKILL"), 5_000);
          forced.unref();
        }
      };
      controller.signal.addEventListener("abort", stop, { once: true });
      if (child.pid && process.connected)
        process.send?.({ type: "started", pid: child.pid }, () => {});
      const cleanup = () => {
        controller.signal.removeEventListener("abort", stop);
        if (forced) clearTimeout(forced);
      };
      child.once("error", () => {
        cleanup();
        reject(new Error("start"));
      });
      child.once("close", (code) => {
        if (controller.signal.aborted) killGroup(child, "SIGKILL");
        cleanup();
        if (controller.signal.aborted) reject(new Error("cancelled"));
        else if (code !== 0) reject(new Error("failed"));
        else done();
      });
      if (controller.signal.aborted) stop();
    });
    if (process.connected)
      process.send?.({ type: "result", ok: true }, () => {});
  } catch (error) {
    if (process.connected)
      process.send?.(
        {
          type: "result",
          ok: false,
          kind: error.message === "start" ? "start" : "failed",
        },
        () => {},
      );
  } finally {
    try {
      await unlink(marker);
    } catch {
      /* Only this worker's nonce is addressed. */
    }
    if (process.connected) process.disconnect();
    process.removeListener("disconnect", cancel);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}

/** Keep npm output away from the MCP protocol and do not print environment values. */
async function installDependencies(
  command,
  args,
  { cwd, env, timeoutMs, signal, lockPath, nonce },
) {
  await new Promise((done, reject) => {
    const worker = fork(
      fileURLToPath(import.meta.url),
      ["--ccuh-install-worker"],
      {
        cwd,
        env,
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let expired = false;
    let result;
    let npmPid;
    let forced;
    let markerFailure = false;
    let workerFailure = false;
    const markerTask = worker.pid
      ? writeFile(
          join(lockPath, "installer-" + nonce + "-" + worker.pid + ".json"),
          "",
          { flag: "wx", mode: 0o600 },
        )
      : Promise.reject(new Error("worker unavailable"));
    const stop = () => {
      if (worker.connected) worker.send({ type: "cancel" }, () => {});
      if (!forced) {
        forced = setTimeout(() => {
          if (npmPid) killGroup({ pid: npmPid }, "SIGKILL");
          worker.kill("SIGKILL");
        }, 6_000);
        forced.unref();
      }
    };
    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, timeoutMs);
    timer.unref();
    signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (forced) clearTimeout(forced);
      signal.removeEventListener("abort", stop);
    };
    worker.on("message", (message) => {
      if (message?.type === "result") result = message;
      else if (
        message?.type === "started" &&
        Number.isSafeInteger(message.pid) &&
        message.pid > 0
      )
        npmPid = message.pid;
    });
    worker.once("error", () => {
      workerFailure = true;
    });
    worker.once("close", async () => {
      await markerTask.catch(() => {});
      if (!result?.ok && npmPid) killGroup({ pid: npmPid }, "SIGKILL");
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else if (expired)
        reject(
          new PluginRuntimeError(
            "Runtime dependency installation timed out. Check network access and restart CCUH.",
          ),
        );
      else if (workerFailure)
        reject(
          new PluginRuntimeError(
            "Could not start the dependency installer. Check the CCUH plugin installation.",
          ),
        );
      else if (markerFailure)
        reject(
          new PluginRuntimeError(
            "Could not prepare the dependency installer. Check runtime directory permissions.",
          ),
        );
      else if (result?.ok) done();
      else if (result?.kind === "start")
        reject(
          new PluginRuntimeError(
            "Could not start npm. Make npm available to the Codex process and restart CCUH.",
          ),
        );
      else
        reject(
          new PluginRuntimeError(
            "Runtime dependency installation failed. Check npm permissions and network access, then restart CCUH.",
          ),
        );
    });
    markerTask.then(
      () => {
        if (signal.aborted || expired) stop();
        else if (worker.connected)
          worker.send({ command, args, cwd, lockPath, nonce }, () => {});
      },
      () => {
        markerFailure = true;
        stop();
      },
    );
    if (signal.aborted) stop();
  });
}

/** Prepare a shipped JavaScript runtime; Codex does not run npm prepare for Git plugins. */
export async function preparePluginRuntime(options = {}) {
  const root = resolve(
    options.root ?? fileURLToPath(new URL("../", import.meta.url)),
  );
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "darwin")
    throw new PluginRuntimeError("CCUH supports macOS only.");
  if (Number((options.nodeVersion ?? process.versions.node).split(".")[0]) < 24)
    throw new PluginRuntimeError("CCUH requires Node.js 24 or later.");
  const stateDirectory = configurePluginState(
    env,
    options.homeDir ?? homedir(),
  );
  const serverPath = join(root, "dist", "server.js");
  if (!(await exists(serverPath)))
    throw new PluginRuntimeError(
      "The plugin is missing its shipped JavaScript runtime. Reinstall a complete CCUH plugin package.",
    );
  const paths = await resolvePluginRuntimePaths({ ...options, root, env });
  const { prefix, packageRoot, lockPath, incompletePath } = paths;
  const ready =
    options.dependenciesReady ??
    (async () =>
      (await exists(join(packageRoot, "dist/server.js"))) &&
      dependenciesReady(packageRoot));
  const runtimeResult = () => ({
    ...paths,
    stateDirectory,
    serverUrl: pathToFileURL(join(packageRoot, "dist/server.js")).href,
  });
  const initiallyReady = await ready();
  if (
    initiallyReady &&
    !(await pathExists(lockPath)) &&
    !(await pathExists(incompletePath))
  )
    return runtimeResult();
  if (
    (!initiallyReady || (await pathExists(incompletePath))) &&
    env.CCUH_PLUGIN_NO_INSTALL === "1"
  )
    throw new PluginRuntimeError(
      "CCUH runtime dependencies are missing or incomplete and automatic installation is disabled.",
    );
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const pause =
    options.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const log = options.log ?? ((message) => process.stderr.write(message));
  const nonce = randomUUID();
  const staging = join(prefix, ".ccuh-bootstrap-" + nonce + ".pending");
  const controller = new AbortController();
  const interrupt = (signal) =>
    controller.abort(new PluginRuntimeInterruptedError(signal));
  const onSIGINT = () => interrupt("SIGINT");
  const onSIGTERM = () => interrupt("SIGTERM");
  process.on("SIGINT", onSIGINT);
  process.on("SIGTERM", onSIGTERM);
  let owned = false;
  try {
    await mkdir(prefix, { recursive: true, mode: 0o700 });
    await mkdir(staging, { mode: 0o700 });
    await writeFile(
      join(staging, nonce + ".json"),
      JSON.stringify({ version: 1, pid: process.pid, nonce }),
      { flag: "wx", mode: 0o600 },
    );
    while (!owned) {
      controller.signal.throwIfAborted();
      if (await pathExists(lockPath)) await recoverDeadLock(lockPath);
      if (!(await pathExists(lockPath))) {
        try {
          // The complete directory is published at once; live owners always have their nonce file.
          await rename(staging, lockPath);
          owned = true;
          break;
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        }
      }
      if (Date.now() >= deadline)
        throw new PluginRuntimeError(
          "Another CCUH startup is still preparing dependencies. Check the plugin bootstrap lock before retrying.",
        );
      await pause(
        Math.min(options.pollMs ?? 100, Math.max(1, deadline - Date.now())),
      );
    }
    controller.signal.throwIfAborted();
    // An interrupted install may resolve some modules without having finished the dependency tree.
    if ((await ready()) && !(await pathExists(incompletePath)))
      return runtimeResult();
    if (env.CCUH_PLUGIN_NO_INSTALL === "1")
      throw new PluginRuntimeError(
        "CCUH runtime dependencies are missing or incomplete and automatic installation is disabled.",
      );
    await writeFile(incompletePath, "", { mode: 0o600 });
    controller.signal.throwIfAborted();
    log("CCUH: preparing runtime dependencies...\n");
    const args = [
      "install",
      "--prefix",
      prefix,
      "--omit=dev",
      "--ignore-scripts",
      "--install-links",
      "--no-audit",
      "--no-fund",
      "file:" + root,
    ];
    await (options.runInstall ?? installDependencies)(
      options.npmPath ?? "npm",
      args,
      {
        cwd: prefix,
        env,
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal: controller.signal,
        lockPath,
        nonce,
      },
    );
    controller.signal.throwIfAborted();
    if (!(await ready()))
      throw new PluginRuntimeError(
        "CCUH dependencies are still unavailable after installation. Reinstall the plugin and retry.",
      );
    await unlink(incompletePath);
    return runtimeResult();
  } catch (error) {
    if (error instanceof PluginRuntimeError) throw error;
    throw new PluginRuntimeError(
      "CCUH runtime dependencies could not be prepared. Check npm permissions and network access.",
    );
  } finally {
    if (owned) await releaseLock(lockPath, nonce);
    else await releaseLock(staging, nonce);
    process.removeListener("SIGINT", onSIGINT);
    process.removeListener("SIGTERM", onSIGTERM);
  }
}

if (
  process.argv[2] === "--ccuh-install-worker" &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runInstallWorker();
}
