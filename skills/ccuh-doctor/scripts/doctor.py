#!/usr/bin/env python3
"""Read-only CCUH environment inspection and supplied-response classification."""

import argparse
import json
import os
import platform
import plistlib
import re
import sys
from pathlib import Path


MAX_INPUT_BYTES = 1024 * 1024
MAX_NODES = 20000
OFFICIAL_BINARY = Path("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")

# These are response heuristics, not proof of a product's underlying cause.
# Specific unresolved-operation/capability signals take precedence over generic
# tool and timeout text. Authentication/permission failures precede startup text.
RULES = (
    ("operation_unresolved", r"\bccuh\s*:\s*a previous native operation still has no confirmed completion\b",
     "Identify the original request and target, then confirm its state and outcome. Do not reset the session, bypass authentication, or repeat the same mutation while completion is unconfirmed."),
    ("capability_unavailable", r"\bcapability is not available\b",
     "Check optional capability support during preflight and preserve the existing target. Do not recreate tabs or windows to force an unsupported option."),
    ("authentication_failed", r"sender process is not authenticated|missing-code-signing-identity|"
     r"\bunauthenticated\b|authentication (?:failed|failure)|native pipe rejected|"
     r"peer (?:authorization failed|rejected)",
     "Report the runtime authentication failure. Use the approved official runtime; do not bypass authentication or retry UI actions."),
    ("permission_denied", r"permission (?:denied|not granted|required)|access (?:is )?denied|"
     r"not authorized|screen recording.{0,40}(?:denied|disabled|not granted)|"
     r"accessibility.{0,40}(?:denied|disabled|not granted)",
     "Identify the denied app or OS permission without broadening access automatically."),
    ("startup_failed", r"no such file or directory|\benoent\b|mcp startup failed|"
     r"native pipe startup failed|(?:server|process).{0,40}failed to start|"
     r"failed to (?:start|launch).{0,40}(?:server|process)",
     "Check the configured executable path and official app installation. Do not rewrite settings or restart apps automatically."),
    ("tool_unavailable", r"\bunknown tool\b|\btool not found\b|no (?:available )?computer use tool|"
     r"(?:computer use|browser).{0,50}(?:not available|unavailable|not exposed|not loaded)",
     "Confirm that this session exposes a documented official entry point. Installation alone does not prove availability."),
    ("timeout", r"\btimeout\b|\btimed out\b|result[_ ]unknown|outcome[_ ]unknown",
     "The operation outcome is unknown. Check the original target before repeating any mutation or window-creation request."),
    ("browser_setup_unavailable", r"\bcua_repl_enabled_surfaces\s+is required\b",
     "Confirm that this session provides the official browser runtime setup. CLI override repair does not provide missing host browser initialization."),
    ("target_lookup_failed", r"(?:failed|unable|could not|cannot) to (?:find|resolve|query|list|determine|look up)|"
     r"(?:target|window|tab).{0,40}(?:lookup|query|enumeration).{0,25}(?:failed|error)|"
     r"\b(?:target|window|tab) (?:was |is )?not found\b|"
     r"\bno (?:matching |such )?(?:target|window|tab)(?:s)? (?:exists|found|available)\b",
     "A lookup failure is not target absence. Recheck the same target once with minimal metadata; do not create a replacement window."),
    ("target_absent", r"\b(?:target|window|tab) (?:was |is )?(?:no longer exists|closed)\b",
     "Report that the selected target is unavailable. Do not guess another target or open a replacement."),
    ("capture_failed", r"(?:screenshot|screen capture|window capture|capture).{0,50}(?:failed|unavailable|error|blank)|"
     r"(?:cannot|could not|unable to) capture|window is minimized",
     "Keep the same target and report the capture limitation. Do not change the user's Space or activate another window as a fallback."),
)


TEXT_GUIDANCE = {
    "environment_checked": (
        "설치 환경 점검 완료",
        "앱 설치·버전·공식 실행 파일 존재와 실행 경로 재정의 설정 유무만 확인했습니다.",
        "대상을 지정한 뒤 공식 도구로 실제 상태를 확인하세요. 설치 정보만으로 인증·권한·포커스 보존을 판단할 수 없습니다.",
    ),
    "operation_unresolved": (
        "이전 요청 완료 미확인",
        "앞선 네이티브 요청의 완료가 확인되지 않았다는 응답입니다. 지연 요청이 취소된 것으로 볼 수 없습니다.",
        "원래 요청과 대상을 식별한 뒤 상태·결과를 확인하세요. 확인 전 임의 초기화, 인증 우회, 같은 변경의 중복 요청을 하지 마세요.",
    ),
    "capability_unavailable": (
        "선택 기능 사용 불가",
        "요청한 선택 기능을 사용할 수 없다는 응답입니다. 기본 연결 실패 여부는 이 결과만으로 판단하지 않습니다.",
        "선택 옵션의 지원 여부를 사전에 확인하세요. 기존 대상을 유지하고, 기능을 쓰기 위해 탭이나 창을 다시 만들지 마세요.",
    ),
    "authentication_failed": (
        "호출 프로세스 인증 실패",
        "제공된 응답에서 인증 거절을 감지했습니다. 현재 연결을 새로 시도한 것은 아닙니다.",
        "공식 실행 경로와 서명 신원을 확인하세요. 인증을 우회하거나 UI 조작을 반복하지 마세요.",
    ),
    "permission_denied": (
        "접근 권한 거부",
        "제공된 응답에서 앱 또는 OS 접근 권한 거부를 감지했습니다.",
        "거부된 권한 종류와 대상 앱을 확인하세요. 허용 범위를 임의로 넓히지 마세요.",
    ),
    "startup_failed": (
        "서버 시작 또는 실행 경로 오류",
        "제공된 응답에서 실행 파일 조회 또는 프로세스 시작 실패를 감지했습니다.",
        "설정된 실행 경로와 공식 앱 설치 상태를 확인하세요. 설정 변경이나 앱 재시작은 자동으로 수행하지 않습니다.",
    ),
    "tool_unavailable": (
        "필요한 도구 사용 불가",
        "제공된 응답은 필요한 도구 진입점을 사용할 수 없다고 보고합니다.",
        "현재 세션에 공식 Computer Use 진입점이 제공되는지 확인하세요. 설치 여부만으로 사용 가능하다고 판단하지 마세요.",
    ),
    "timeout": (
        "시간 초과·결과 불확실",
        "시간 초과 응답을 감지했습니다. 작업이 취소됐는지는 확인하지 못했습니다.",
        "기존 대상에서 원래 요청의 결과를 먼저 확인하세요. 결과 확인 없이 새 창 생성이나 변경 요청을 반복하지 마세요.",
    ),
    "browser_setup_unavailable": (
        "호스트 브라우저 초기화 설정 미제공",
        "공식 브라우저 런타임 초기화에 필요한 호스트 설정이 제공되지 않았다는 응답입니다. 선택 기능 지원 여부와는 별개입니다.",
        "현재 세션의 공식 브라우저 런타임 지원을 확인하세요. CLI 실행 경로 복구로 이 초기화 오류가 해결됐다고 판단하지 마세요.",
    ),
    "target_lookup_failed": (
        "기존 대상 조회 실패",
        "대상 조회가 실패했습니다. 기존 창이 없어졌다는 뜻은 아닙니다.",
        "같은 대상의 최소 메타데이터를 한 번 재확인하고, 실패하면 보류하세요. 대신 새 창을 만들지 마세요.",
    ),
    "target_absent": (
        "선택 대상 종료·소실 보고",
        "제공된 응답은 선택한 대상의 종료·소실을 보고합니다. 현재 화면을 직접 확인한 것은 아닙니다.",
        "선택 대상을 사용할 수 없다는 점을 알리세요. 다른 대상을 추측하거나 대체 창을 열지 마세요.",
    ),
    "capture_failed": (
        "대상 화면 관찰 제한·실패",
        "제공된 응답에서 대상 캡처 제한 또는 실패를 감지했습니다.",
        "같은 대상을 유지하고 관찰 제한을 알리세요. 사용자 Space를 바꾸거나 다른 창을 활성화하지 마세요.",
    ),
    "tool_error": (
        "분류되지 않은 도구 오류",
        "오류 표시는 감지했지만 구체적인 오류 종류를 확인하지 못했습니다.",
        "구조화된 오류 종류를 확인하세요. 자동 재시작·대상 교체·성공 선언을 하지 마세요.",
    ),
    "response_unverified": (
        "응답에서 알려진 오류 미검출",
        "제공된 응답에서 알려진 오류를 찾지 못했습니다. 연결이나 작업 성공이 확인된 것은 아닙니다.",
        "공식 도구로 정확한 대상 상태를 확인한 뒤 연결 또는 작업 성공 여부를 판단하세요.",
    ),
    "input_error": (
        "진단 입력 확인 필요",
        "진단 입력을 읽거나 처리하지 못했습니다. 연결 점검은 수행하지 않았습니다.",
        "읽을 수 있는 비어 있지 않은 UTF-8 오류 응답을 제공하세요. 입력 크기는 최대 1 MiB입니다.",
    ),
}


def format_text(report):
    """Render Korean guidance without echoing the supplied error or env values."""
    category = report.get("category")
    safe_category = category if category in TEXT_GUIDANCE else "tool_error"
    label, stage, action = TEXT_GUIDANCE[safe_category]
    lines = [
        "CCUH 연결 진단",
        "분류: {} ({})".format(label, safe_category),
        "현재 확인 단계: " + stage,
        "연결 상태: 미확인",
    ]
    if safe_category in ("timeout", "operation_unresolved"):
        lines.append("작업 결과: 불확실 (취소 여부 미확인)")
    elif report.get("mode") == "environment":
        lines.append("실제 연결·UI 조작: 시도하지 않음")
        environment = report.get("environment", {})
        for key, title in (
            ("app_present", "앱 설치"),
            ("app_metadata_readable", "앱 메타데이터 읽기"),
            ("official_binary_present", "공식 실행 파일 존재"),
        ):
            lines.append("{}: {}".format(title, "확인" if environment.get(key) else "미확인"))
        lines.append("실행 경로 재정의: {} (값 비공개)".format(
            "설정됨" if environment.get("cli_override_present") else "설정되지 않음"))
    lines.append("다음 조치: " + action)
    return "\n".join(lines)


def _result(category, is_error, action):
    return {
        "schema_version": 1,
        "mode": "response",
        "category": category,
        "connection_status": "unverified",
        "operation_outcome": "unknown" if category in ("timeout", "operation_unresolved") else "unverified",
        "is_error_detected": is_error,
        "next_action": action,
    }


def classify_response(payload):
    """Classify a supplied response, including errors nested in MCP envelopes.

    The original text is deliberately not returned: responses can contain tokens,
    URLs, screenshots, or user content. An error-free response is never readiness
    or task-completion evidence on its own.
    """
    pending = [payload]
    seen = {}
    texts = []
    has_error = False
    nodes = 0
    while pending:
        nodes += 1
        if nodes > MAX_NODES:
            return _result("input_error", True, "Supply a smaller diagnostic response.")
        value = pending.pop()
        if isinstance(value, (dict, list)):
            identity = id(value)
            if identity in seen:
                continue
            # Retain parsed containers as well as their IDs. Serialized MCP
            # envelopes can create short-lived containers whose IDs get reused.
            seen[identity] = value
        if isinstance(value, dict):
            for key, child in value.items():
                name = str(key).lower().replace("_", "")
                if name == "iserror" and child is True:
                    has_error = True
                elif name == "error" and child is not None and child is not False and child != "":
                    has_error = True
                elif name == "exitcode" and type(child) is int and child != 0:
                    has_error = True
                elif name == "status" and child in ("failed", "error", "rejected"):
                    has_error = True
                elif name in ("timeout", "timedout") and child is True:
                    texts.append("timeout")
                pending.append(child)
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str):
            texts.append(value)
            stripped = value.lstrip()
            if stripped.startswith(("{", "[")):
                try:
                    pending.append(json.loads(value))
                except (ValueError, RecursionError):
                    pass

    text = "\n".join(texts).lower()
    for category, pattern, action in RULES:
        if re.search(pattern, text, flags=re.DOTALL):
            return _result(category, True, action)
    if has_error or re.search(r"(?:^|\n)\s*(?:error|exception)\s*:|server error\s*-?\d+", text):
        return _result("tool_error", True, "Report the unclassified tool failure. Do not automatically restart, replace the target, or declare success.")
    return _result("response_unverified", False, "Verify the exact target state through the official tool before declaring a connection or task successful.")


def environment_report(app_path, environ=None):
    """Inspect only installation metadata and override presence; never connect."""
    environ = os.environ if environ is None else environ
    app = Path(app_path)
    metadata = {}
    readable = False
    try:
        with (app / "Contents/Info.plist").open("rb") as handle:
            raw = handle.read(MAX_INPUT_BYTES + 1)
        if len(raw) <= MAX_INPUT_BYTES:
            parsed = plistlib.loads(raw)
            if isinstance(parsed, dict):
                metadata = parsed
                readable = True
    except (OSError, ValueError, TypeError, plistlib.InvalidFileException):
        pass

    def version(key):
        value = metadata.get(key)
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._+\-]{1,80}", value):
            return value
        return None

    return {
        "schema_version": 1,
        "mode": "environment",
        "category": "environment_checked",
        "connection_status": "unverified",
        "operation_outcome": "not_attempted",
        "is_error_detected": False,
        "environment": {
            "os": platform.system(),
            "os_release": platform.release(),
            "architecture": platform.machine(),
            "app_present": app.is_dir(),
            "app_metadata_readable": readable,
            "app_version": version("CFBundleShortVersionString"),
            "app_build": version("CFBundleVersion"),
            "official_binary_present": (app / OFFICIAL_BINARY).is_file(),
            "cli_override_present": bool(environ.get("CODEX_CLI_PATH")),
        },
        "next_action": "Installation metadata does not verify authentication, permissions, target access, or focus preservation. Test only a specifically selected dummy target through the official tool.",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Read-only CCUH diagnostics. Never opens UI, connects to services, or changes settings.",
        epilog="Exit codes: 0 = environment inspected or response without a detected error (connection remains unverified); 1 = detected response error or unknown timeout outcome; 2 = input/usage error. Error text and environment-variable values are not echoed.",
    )
    parser.add_argument("--response-file", metavar="PATH", help="Classify supplied UTF-8 JSON or plain text; use - for stdin (maximum 1 MiB).")
    parser.add_argument("--app-path", default="/Applications/ChatGPT.app", help="App bundle used for metadata inspection when no response is supplied.")
    parser.add_argument("--format", choices=("text", "json"), default="json", help="Output format: text = Korean guidance; json = structured diagnostics (default).")
    args = parser.parse_args(argv)
    if args.response_file is None:
        report = environment_report(args.app_path)
    else:
        try:
            if args.response_file == "-":
                raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
            else:
                with Path(args.response_file).open("rb") as handle:
                    raw = handle.read(MAX_INPUT_BYTES + 1)
            if not raw or not raw.strip() or len(raw) > MAX_INPUT_BYTES:
                raise ValueError("Invalid input size")
            text = raw.decode("utf-8")
            try:
                payload = json.loads(text)
            except (ValueError, RecursionError):
                payload = text
            report = classify_response(payload)
        except (OSError, UnicodeError, ValueError):
            report = _result("input_error", True, "Supply a readable nonempty UTF-8 diagnostic response of at most 1 MiB.")
    if args.format == "text":
        print(format_text(report))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["category"] == "input_error":
        return 2
    return 1 if report.get("is_error_detected") else 0


if __name__ == "__main__":
    sys.exit(main())
