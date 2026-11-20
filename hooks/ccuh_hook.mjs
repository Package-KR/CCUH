import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const hookPath = realpathSync(fileURLToPath(import.meta.url));
const pluginRoot = dirname(dirname(hookPath));
const entryDirectory = join(pluginRoot, "skills", "codex-computer-use-helpers");
const entryPath = join(entryDirectory, "SKILL.md");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lifecycleEvents = new Set(["SessionStart", "UserPromptSubmit", "SubagentStart"]);
const uiToolPattern = /^(mcp__computer_use__[^\n]*|mcp__cua_repl(?:__|\.)js|mcp__node_repl__js)$/;

// Codex 훅 컨텍스트 응답 생성
function contextOutput(event, context) {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: context,
    },
  };
}

// 훅 이벤트 분류와 CCUH 지침 전달
function render(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Hook input must be a JSON object");
  }

  const { hook_event_name: event, tool_name: tool } = payload;
  if (event !== null && typeof event === "object") {
    throw new TypeError("Hook event name must be a scalar");
  }
  if (event === "PreToolUse") {
    if (typeof tool !== "string" || !uiToolPattern.test(tool)) {
      return {};
    }
  } else if (!lifecycleEvents.has(event)) {
    return {};
  }

  let entry;
  try {
    entry = utf8.decode(readFileSync(entryPath)).replace(/\r\n?/g, "\n");
  } catch {
    const reason = "CCUH 진입 스킬을 읽을 수 없습니다. 설치 묶음을 확인하세요.";
    if (event === "PreToolUse" && tool !== "mcp__node_repl__js") {
      return {
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    }
    return { systemMessage: reason };
  }

  const location = `CCUH 진입 문서: ${entryPath}\n참조 경로 기준: ${entryDirectory}\n`;
  if (event === "PreToolUse") {
    return contextOutput(event, `${location}\n${entry}`);
  }

  return contextOutput(
    event,
    location +
      "첫 진행 안내에는 요청한 작업을 바로 말하고, 후속 안내에는 실제로 확인한 상태와 결과를 짧게 설명하세요. " +
      "진행 안내에서 스킬이나 보조 지침을 읽거나 적용한다는 설명은 생략하세요. 사용자가 해당 지침을 직접 물으면 답하세요. " +
      "Computer Use의 첫 UI 관찰과 입력 전에 공식 Computer Use 지침과 " +
      "CCUH 진입 문서를 읽고 필요한 보조 지침을 적용하세요. " +
      "사용자가 CCUH를 따로 지정할 필요는 없습니다. " +
      "일반 질문과 Computer Use 없는 코드 작업에는 적용하지 않습니다. " +
      "요약과 재개 뒤에도 필요한 원문이 현재 맥락에 있는지 확인하세요. " +
      "하위 에이전트는 현재 호스트의 UI 실행 주체 제한을 지켜야 합니다.",
  );
}

// 표준 입출력을 사용하는 훅 명령 실행
function main() {
  let output;
  try {
    output = render(JSON.parse(utf8.decode(readFileSync(0))));
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) {
      throw error;
    }
    process.stderr.write("CCUH hook: invalid JSON input\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main();
