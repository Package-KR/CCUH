export const OBSERVATION_HOOKS = {
    PreToolUse: "pretooluse",
    PostToolUse: "posttooluse",
};
export function isToolName(value) {
    return /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
}
export function exactToolMatcher(toolName) {
    if (!isToolName(toolName))
        throw new Error("Invalid tool name");
    return "^" + toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
}
function shellQuote(value) {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}
export function createCommandHook(options) {
    const state = options.stateDir === undefined
        ? ""
        : "CCUH_STATE_DIR=" + shellQuote(options.stateDir) + " ";
    return {
        type: "command",
        command: state + shellQuote(options.nodePath) + " " + shellQuote(options.scriptPath),
        timeout: 3,
        statusMessage: options.statusMessage,
    };
}
