const TOOL_NAMES = [
  "mcp__cua_repl__js",
  "mcp__cua_repl__js_reset",
] as const;

type ComputerUseTool = (typeof TOOL_NAMES)[number];

export const DEFAULT_COMPUTER_USE_TOOL = TOOL_NAMES[0];
export const COMPUTER_USE_TOOL_NAME_HINT =
  "Use " + TOOL_NAMES.join(" or ") + " for --tool-name.";

// 플러그인의 정적 hooks.json과 같은 매처 유지
export const COMPUTER_USE_TOOL_MATCHER =
  "^(?:" + TOOL_NAMES.map(escapeToolName).join("|") + ")$";

function escapeToolName(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 줄바꿈 접미사도 거절하도록 정규식 대신 정확히 비교
export function isComputerUseTool(value: unknown): value is ComputerUseTool {
  return TOOL_NAMES.some((name) => name === value);
}

export function computerUseToolMatcher(toolName?: string): string {
  if (toolName === undefined) return COMPUTER_USE_TOOL_MATCHER;
  if (!isComputerUseTool(toolName))
    throw new Error("Use a supported bundled Computer Use tool name");
  return "^" + escapeToolName(toolName) + "$";
}
