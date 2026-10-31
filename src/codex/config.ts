import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  OBSERVATION_HOOKS,
  createCommandHook,
  exactToolMatcher,
} from "./hooks.ts";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const compiled = import.meta.url.endsWith("/config.js");

function commandHook(stem: string) {
  return createCommandHook({
    nodePath: process.execPath,
    scriptPath: compiled
      ? join(PROJECT_ROOT, "dist/hooks", stem + ".js")
      : join(PROJECT_ROOT, "hooks/codex", stem + ".mjs"),
    statusMessage: "CCUH: observing tool metadata",
  });
}

export function commandHooks(toolName?: string) {
  const matcher = toolName === undefined ? "*" : exactToolMatcher(toolName);
  return {
    hooks: {
      PreToolUse: [
        { matcher, hooks: [commandHook(OBSERVATION_HOOKS.PreToolUse)] },
      ],
      PostToolUse: [
        { matcher, hooks: [commandHook(OBSERVATION_HOOKS.PostToolUse)] },
      ],
    },
  };
}

export function mcpConfig(): string {
  // JSON strings are also valid TOML basic strings for these path values.
  return (
    "[mcp_servers.ccuh]\ncommand = " +
    JSON.stringify(process.execPath) +
    "\nargs = [" +
    JSON.stringify(
      join(PROJECT_ROOT, compiled ? "dist/server.js" : "src/server.ts"),
    ) +
    "]\n"
  );
}
