import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { OBSERVATION_HOOKS, createCommandHook } from "./hooks.ts";
import { computerUseToolMatcher } from "./computer-use.ts";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const compiled = import.meta.url.endsWith("/config.js");

function commandHook(stem: string) {
  return createCommandHook({
    nodePath: process.execPath,
    scriptPath: compiled
      ? join(PROJECT_ROOT, "dist/hooks", stem + ".js")
      : join(PROJECT_ROOT, "hooks/codex", stem + ".mjs"),
    statusMessage: "CCUH: observing Computer Use metadata",
  });
}

export function commandHooks(toolName?: string) {
  const matcher = computerUseToolMatcher(toolName);
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
  // 경로의 따옴표와 역슬래시를 보존하는 JSON/TOML 공통 문자열 인코딩
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
