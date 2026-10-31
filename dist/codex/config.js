import { fileURLToPath } from "node:url";
import { join } from "node:path";
export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const compiled = import.meta.url.endsWith("/config.js");
function shellQuote(value) {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}
function commandHook(file) {
    return {
        type: "command",
        command: shellQuote(process.execPath) +
            " " +
            shellQuote(compiled
                ? join(PROJECT_ROOT, "dist/hooks", file.replace(/\.mjs$/, ".js"))
                : join(PROJECT_ROOT, "hooks/codex", file)),
        timeout: 3,
        statusMessage: "CCUH: observing tool metadata",
    };
}
export function commandHooks(toolName) {
    if (toolName !== undefined && !/^[A-Za-z0-9_.:-]{1,200}$/.test(toolName))
        throw new Error("Invalid tool name");
    const matcher = toolName ?? "*";
    return {
        hooks: {
            PreToolUse: [{ matcher, hooks: [commandHook("pretooluse.mjs")] }],
            PostToolUse: [{ matcher, hooks: [commandHook("posttooluse.mjs")] }],
        },
    };
}
export function mcpConfig() {
    // JSON strings are also valid TOML basic strings for these path values.
    return ("[mcp_servers.ccuh]\ncommand = " +
        JSON.stringify(process.execPath) +
        "\nargs = [" +
        JSON.stringify(join(PROJECT_ROOT, compiled ? "dist/server.js" : "src/server.ts")) +
        "]\n");
}
