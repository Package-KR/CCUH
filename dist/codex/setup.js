import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, rename, unlink, writeFile, } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OBSERVATION_HOOKS, createCommandHook } from "./hooks.js";
import { DEFAULT_COMPUTER_USE_TOOL, COMPUTER_USE_TOOL_NAME_HINT, computerUseToolMatcher, isComputerUseTool, } from "./computer-use.js";
export class SetupError extends Error {
}
class SetupCommandError extends Error {
    reason;
    code;
    constructor(reason, code) {
        super(reason);
        this.reason = reason;
        this.code = code;
    }
}
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validateSetupToolName(value) {
    if (!isComputerUseTool(value))
        throw new SetupError(COMPUTER_USE_TOOL_NAME_HINT);
}
function ownedHook(value) {
    if (!object(value))
        return false;
    if (typeof value.statusMessage === "string" &&
        value.statusMessage.startsWith("CCUH:"))
        return true;
    return (typeof value.command === "string" &&
        /[/\\]ccuh[/\\](?:hooks[/\\]codex[/\\](?:pretooluse|posttooluse)\.mjs|dist[/\\]hooks[/\\](?:pretooluse|posttooluse)\.js)/i.test(value.command));
}
/** 다른 이벤트와 배열 위치를 보존해 기존 훅의 신뢰 기록을 유지합니다. */
export function mergeSetupHooks(existing, paths) {
    if (!object(existing))
        throw new SetupError("hooks.json must contain a JSON object; no settings were changed.");
    validateSetupToolName(paths.toolName);
    const result = structuredClone(existing);
    if (result.hooks !== undefined && !object(result.hooks))
        throw new SetupError("The hooks field must be an object; no settings were changed.");
    const hooks = object(result.hooks) ? result.hooks : {};
    result.hooks = hooks;
    const matcher = computerUseToolMatcher(paths.toolName);
    for (const [phase, stem] of Object.entries(OBSERVATION_HOOKS)) {
        const current = hooks[phase] ?? [];
        if (!Array.isArray(current))
            throw new SetupError(`${phase} must be an array; no settings were changed.`);
        const matches = [];
        for (const [index, group] of current.entries()) {
            if (!object(group) || !Array.isArray(group.hooks))
                throw new SetupError(`${phase} contains an unsupported group; no settings were changed.`);
            if (group.hooks.some(ownedHook)) {
                if (group.hooks.length !== 1)
                    throw new SetupError("A CCUH handler shares a group with other hooks. Separate it before running setup.");
                matches.push(index);
            }
        }
        if (matches.length > 1)
            throw new SetupError("Multiple CCUH hook groups exist. Keep one CCUH group per event before running setup.");
        const handler = createCommandHook({
            nodePath: paths.nodePath,
            scriptPath: join(paths.runtimePackage, "dist", "hooks", stem + ".js"),
            stateDir: paths.stateDir,
            statusMessage: "CCUH: observing Computer Use metadata",
        });
        const index = matches[0];
        if (index === undefined)
            current.push({ matcher, hooks: [handler] });
        else
            current[index] = { ...current[index], matcher, hooks: [handler] };
        hooks[phase] = current;
    }
    return result;
}
async function snapshot(path) {
    try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new SetupError("Setup only modifies regular config files; check the selected Codex home.");
        return { content: await readFile(path), mode: stat.mode & 0o777 };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
function same(a, b) {
    return a === null ? b === null : b !== null && a.content.equals(b.content);
}
async function atomicWrite(path, content, mode = 0o600) {
    const temp = path + ".ccuh-" + randomBytes(8).toString("hex");
    try {
        await writeFile(temp, content, { mode, flag: "wx" });
        await rename(temp, path);
    }
    finally {
        await unlink(temp).catch(() => { });
    }
}
async function restoreIfUnchanged(path, expected, original) {
    if (!same(await snapshot(path), expected))
        return false;
    if (original)
        await atomicWrite(path, original.content, original.mode);
    else
        await unlink(path).catch((error) => {
            if (error.code !== "ENOENT")
                throw error;
        });
    return true;
}
async function executable(name, env) {
    const paths = (env.PATH ?? "")
        .split(delimiter)
        .filter(isAbsolute)
        .map((dir) => join(dir, name));
    if (name === "codex")
        paths.push("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
    for (const path of paths) {
        try {
            await access(path, constants.X_OK);
            return path;
        }
        catch {
            // 다음 명시 경로 후보 확인
        }
    }
    return null;
}
const runCommand = async (command, args, options) => {
    await new Promise((done, reject) => {
        const child = spawn(command, args, {
            ...options,
            stdio: ["ignore", "ignore", "ignore"],
        });
        let timedOut = false;
        let forceKill;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
            forceKill.unref();
        }, 120_000);
        timer.unref();
        const cleanup = () => {
            clearTimeout(timer);
            if (forceKill)
                clearTimeout(forceKill);
        };
        child.once("error", () => {
            cleanup();
            reject(new SetupCommandError("start"));
        });
        child.once("close", (code) => {
            cleanup();
            if (timedOut)
                reject(new SetupCommandError("timeout"));
            else if (code === 0)
                done();
            else
                reject(new SetupCommandError("exit", code));
        });
    });
};
function commandFailure(stage, error) {
    const subject = stage === "install"
        ? "CCUH runtime installation"
        : "Codex MCP registration";
    const detail = error instanceof SetupCommandError
        ? error.reason === "timeout"
            ? " timed out after two minutes"
            : error.reason === "start"
                ? " could not start"
                : ` exited unsuccessfully${error.code === null ? "" : ` (code ${error.code})`}`
        : " failed";
    const advice = stage === "install"
        ? "Check npm and network access, then retry."
        : "Check the Codex installation and configuration, then retry.";
    return new SetupError(subject + detail + ". " + advice);
}
function parseArgs(args) {
    const parsed = {
        dryRun: false,
        toolName: DEFAULT_COMPUTER_USE_TOOL,
    };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--dry-run")
            parsed.dryRun = true;
        else if (arg === "--codex-home" || arg === "--tool-name") {
            const value = args[++index];
            if (!value || value.startsWith("--"))
                throw new SetupError(`Missing value for ${arg}.`);
            if (arg === "--codex-home")
                parsed.codexHome = value;
            else
                parsed.toolName = value;
        }
        else
            throw new SetupError("Use setup [--dry-run] [--codex-home PATH] [--tool-name NAME].");
    }
    validateSetupToolName(parsed.toolName);
    return parsed;
}
export async function runSetup(args = [], options = {}) {
    const parsed = parseArgs(args);
    if ((options.platform ?? process.platform) !== "darwin")
        throw new SetupError("CCUH setup supports macOS only.");
    if (Number((options.nodeVersion ?? process.versions.node).split(".")[0]) < 24)
        throw new SetupError("CCUH setup requires Node.js 24 or later.");
    const env = options.env ?? process.env;
    const codexHome = resolve(parsed.codexHome ??
        env.CODEX_HOME ??
        join(options.homeDir ?? homedir(), ".codex"));
    const source = resolve(options.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url)));
    const runtime = join(codexHome, "ccuh", "runtime");
    const runtimePackage = join(runtime, "node_modules", "ccuh");
    const stateDir = join(codexHome, "ccuh", "state");
    const nodePath = options.nodePath ?? process.execPath;
    const find = options.resolveExecutable ?? ((name) => executable(name, env));
    const [npm, codex] = await Promise.all([find("npm"), find("codex")]);
    if (!npm)
        throw new SetupError("npm was not found. Install Node.js 24 or later and retry.");
    if (!codex)
        throw new SetupError("Codex was not found. Install Codex App or make Codex CLI available and retry.");
    for (const file of [
        "server.js",
        "hooks/pretooluse.js",
        "hooks/posttooluse.js",
    ]) {
        try {
            await access(join(source, "dist", file), constants.R_OK);
        }
        catch {
            throw new SetupError("The package is missing its built runtime. Use a complete CCUH release or build the source package first.");
        }
    }
    const configPath = join(codexHome, "config.toml");
    const hooksPath = join(codexHome, "hooks.json");
    const originalConfig = await snapshot(configPath);
    const originalHooks = await snapshot(hooksPath);
    let existing = {};
    if (originalHooks) {
        try {
            existing = JSON.parse(originalHooks.content.toString("utf8"));
        }
        catch {
            throw new SetupError("hooks.json is not valid JSON; no settings were changed.");
        }
    }
    const merged = mergeSetupHooks(existing, {
        runtimePackage,
        stateDir,
        nodePath,
        toolName: parsed.toolName,
    });
    const hooksContent = JSON.stringify(merged, null, 2) + "\n";
    const installArgs = [
        "install",
        "--prefix",
        runtime,
        "--omit=dev",
        "--ignore-scripts",
        "--install-links",
        "--no-audit",
        "--no-fund",
        "file:" + source,
    ];
    const registerArgs = [
        "mcp",
        "add",
        "ccuh",
        "--env",
        "CCUH_STATE_DIR=" + stateDir,
        "--",
        nodePath,
        join(runtimePackage, "dist", "server.js"),
    ];
    const report = {
        dry_run: parsed.dryRun,
        codex_home: codexHome,
        runtime_path: runtimePackage,
        state_directory: stateDir,
        mcp_server: "ccuh",
        tool_name: parsed.toolName,
        files: { config: configPath, hooks: hooksPath },
        commands: [
            { command: npm, args: installArgs },
            { command: codex, args: registerArgs },
        ],
        backup_directory: null,
        manual_trust_required: true,
        restart_required: true,
        next_steps: [
            "Review and trust the two CCUH hooks using /hooks in Codex CLI.",
            "Restart the Codex client you use: Codex App or your Codex CLI session.",
        ],
    };
    if (parsed.dryRun)
        return report;
    const ownerDir = join(codexHome, "ccuh");
    await mkdir(ownerDir, { recursive: true, mode: 0o700 });
    const lockPath = join(ownerDir, "setup.lock");
    let lock;
    try {
        lock = await open(lockPath, "wx", 0o600);
    }
    catch {
        throw new SetupError("Another CCUH setup may be running. Check the CCUH setup.lock file before retrying.");
    }
    const run = options.runCommand ?? runCommand;
    let wroteHooks = false;
    let registrationStarted = false;
    try {
        if (!same(await snapshot(configPath), originalConfig) ||
            !same(await snapshot(hooksPath), originalHooks)) {
            throw new SetupError("Codex settings changed during setup. Retry after those changes are complete.");
        }
        const backupRoot = join(ownerDir, "backups");
        await mkdir(backupRoot, { recursive: true, mode: 0o700 });
        report.backup_directory = await mkdtemp(join(backupRoot, "setup-"));
        if (originalConfig)
            await writeFile(join(report.backup_directory, "config.toml"), originalConfig.content, { mode: 0o600, flag: "wx" });
        if (originalHooks)
            await writeFile(join(report.backup_directory, "hooks.json"), originalHooks.content, { mode: 0o600, flag: "wx" });
        if (source !== runtimePackage) {
            try {
                await run(npm, installArgs, { env, cwd: source });
            }
            catch (error) {
                throw commandFailure("install", error);
            }
        }
        try {
            const stat = await lstat(runtimePackage);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error("not a stable package");
            for (const file of [
                "server.js",
                "hooks/pretooluse.js",
                "hooks/posttooluse.js",
            ])
                await access(join(runtimePackage, "dist", file), constants.R_OK);
        }
        catch {
            throw new SetupError("The stable CCUH runtime was not installed completely; Codex settings were not changed.");
        }
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        if (!same(await snapshot(configPath), originalConfig) ||
            !same(await snapshot(hooksPath), originalHooks)) {
            throw new SetupError("Codex settings changed during installation. Retry after those changes are complete.");
        }
        registrationStarted = true;
        try {
            await run(codex, registerArgs, {
                env: { ...env, CODEX_HOME: codexHome },
                cwd: source,
            });
        }
        catch (error) {
            throw commandFailure("register", error);
        }
        const writtenConfig = await snapshot(configPath);
        if (!writtenConfig)
            throw new SetupError("Codex did not write its MCP configuration. Existing hooks were not changed.");
        if (!same(await snapshot(hooksPath), originalHooks))
            throw new SetupError("hooks.json changed during registration. The concurrent edit was preserved; retry setup.");
        if (!originalHooks ||
            !originalHooks.content.equals(Buffer.from(hooksContent))) {
            await atomicWrite(hooksPath, hooksContent, originalHooks?.mode ?? 0o600);
            wroteHooks = true;
        }
        return report;
    }
    catch (error) {
        let recoveryNeeded = false;
        let uncertainRegistration = false;
        if (wroteHooks) {
            try {
                recoveryNeeded = !(await restoreIfUnchanged(hooksPath, { content: Buffer.from(hooksContent), mode: 0o600 }, originalHooks));
            }
            catch {
                recoveryNeeded = true;
            }
        }
        if (registrationStarted) {
            // 등록 성공 후에도 동시 수정된 사용자 설정이 포함될 수 있습니다.
            // CCUH 항목만 바뀌었다는 증거가 없으면 전체 복원 대신 백업을 안내합니다.
            try {
                uncertainRegistration = !same(await snapshot(configPath), originalConfig);
            }
            catch {
                uncertainRegistration = true;
            }
        }
        const message = error instanceof SetupError
            ? error.message
            : "CCUH setup could not finish.";
        const recovery = recoveryNeeded
            ? " Concurrent settings were preserved; use the private backup to review recovery."
            : "";
        const partial = uncertainRegistration
            ? " MCP settings may remain partially changed; the current file was preserved for review."
            : "";
        throw new SetupError(message +
            recovery +
            partial +
            (report.backup_directory ? " Backup: " + report.backup_directory : ""));
    }
    finally {
        await lock.close();
        await unlink(lockPath).catch(() => { });
    }
}
