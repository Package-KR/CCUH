export const OBSERVATION_HOOKS = {
  PreToolUse: "pretooluse",
  PostToolUse: "posttooluse",
} as const;

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
