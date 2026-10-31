export const OBSERVATION_HOOKS = {
  PreToolUse: "pretooluse",
  PostToolUse: "posttooluse",
} as const;

export function isToolName(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
}

export function exactToolMatcher(toolName: string): string {
  if (!isToolName(toolName)) throw new Error("Invalid tool name");
  return "^" + toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function createCommandHook(options: {
  nodePath: string;
  scriptPath: string;
  statusMessage: string;
  stateDir?: string;
}) {
  const state =
    options.stateDir === undefined
      ? ""
      : "CCUH_STATE_DIR=" + shellQuote(options.stateDir) + " ";
  return {
    type: "command",
    command:
      state + shellQuote(options.nodePath) + " " + shellQuote(options.scriptPath),
    timeout: 3,
    statusMessage: options.statusMessage,
  };
}
