"""Inject CCUH guidance through the documented Codex hook protocol.

Protocol: https://learn.chatgpt.com/docs/hooks
This hook supplies instructions; it does not intercept SDK internals.
"""

import json
from pathlib import Path
import re
import sys


PLUGIN_ROOT = Path(__file__).resolve().parent.parent
ENTRY = PLUGIN_ROOT / "skills" / "ccuh" / "SKILL.md"
LIFECYCLE_EVENTS = {"SessionStart", "UserPromptSubmit", "SubagentStart"}
UI_TOOL = re.compile(
    r"^(mcp__computer_use__.*|mcp__cua_repl(?:__|\.)js|mcp__node_repl__js)$"
)


def context_output(event, context):
    return {
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": context,
        }
    }


def render(payload):
    if not isinstance(payload, dict):
        raise ValueError("Hook input must be a JSON object")
    event = payload.get("hook_event_name")
    if event == "PreToolUse":
        tool = payload.get("tool_name")
        if not isinstance(tool, str) or not UI_TOOL.fullmatch(tool):
            return {}
    elif event not in LIFECYCLE_EVENTS:
        return {}

    try:
        entry = ENTRY.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        reason = "CCUH 진입 스킬을 읽을 수 없습니다. 설치 묶음을 확인하세요."
        # Node REPL also runs ordinary code, so missing UI guidance must not ban it.
        if event == "PreToolUse" and tool != "mcp__node_repl__js":
            return {
                "hookSpecificOutput": {
                    "hookEventName": event,
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        return {"systemMessage": reason}

    location = f"CCUH 진입 문서: {ENTRY}\n참조 경로 기준: {ENTRY.parent}\n"
    if event == "PreToolUse":
        return context_output(event, location + "\n" + entry)

    return context_output(
        event,
        location
        + "Computer Use의 첫 UI 관찰과 입력 전에 공식 Computer Use 지침과 "
        + "CCUH 진입 문서를 읽고 필요한 보조 지침을 적용하세요. "
        + "사용자가 CCUH를 따로 지정할 필요는 없습니다. "
        + "일반 질문과 Computer Use 없는 코드 작업에는 적용하지 않습니다. "
        + "요약과 재개 뒤에도 필요한 원문이 현재 맥락에 있는지 확인하세요. "
        + "하위 에이전트는 현재 호스트의 UI 실행 주체 제한을 지켜야 합니다.",
    )


def main():
    try:
        output = render(json.load(sys.stdin))
    except (ValueError, TypeError):
        print("CCUH hook: invalid JSON input", file=sys.stderr)
        return 1
    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
