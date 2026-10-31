import { createHash } from "node:crypto";
import { isComputerUseTool } from "./computer-use.js";
// 이전 이벤트 판별 함수명과의 호환 유지
export { isComputerUseTool as isComputerUseCandidate } from "./computer-use.js";
const TARGET_KEYS = new Set([
    "app",
    "app_name",
    "appName",
    "application",
    "bundle_id",
    "bundleId",
    "window_id",
    "windowId",
    "window_title",
    "windowTitle",
    "browser",
    "browser_id",
    "browserId",
    "tab_id",
    "tabId",
    "target",
]);
const INPUT_KEYS = new Set([...TARGET_KEYS, "code", "url", "title"]);
const HASH = /^[a-f0-9]{64}$/;
const SOURCES = ["hook", "mcp", "synthetic"];
const INPUT_TYPES = [
    "string",
    "number",
    "boolean",
    "object",
    "array",
    "null",
];
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identity(value) {
    return (typeof value === "string" && value.trim().length > 0 && value.length <= 1024);
}
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function inputType(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    return typeof value;
}
/** 입력 값과 응답 본문을 제외하고 메타데이터만 추출합니다. */
export function normalizeEvent(payload, options = {}) {
    if (!object(payload))
        return null;
    const eventPhase = payload.hook_event_name === "PreToolUse"
        ? "pre"
        : payload.hook_event_name === "PostToolUse"
            ? "post"
            : undefined;
    if (payload.hook_event_name !== undefined && !eventPhase)
        return null;
    const phase = options.phase ?? eventPhase;
    if (!phase || !["pre", "post"].includes(phase))
        return null;
    if (eventPhase && options.phase && eventPhase !== options.phase)
        return null;
    if (!identity(payload.session_id) || !identity(payload.tool_use_id))
        return null;
    if (!isComputerUseTool(payload.tool_name))
        return null;
    const source = options.source ?? "hook";
    if (!SOURCES.includes(source))
        return null;
    const now = options.nowMs ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
        return null;
    const input = object(payload.tool_input) ? payload.tool_input : {};
    const shape = {};
    let otherKeys = 0;
    for (const [key, value] of Object.entries(input)) {
        if (!INPUT_KEYS.has(key)) {
            otherKeys++;
            continue;
        }
        const type = inputType(value);
        if (INPUT_TYPES.includes(type))
            shape[key] = type;
    }
    const hasTarget = [...TARGET_KEYS].some((key) => Object.hasOwn(input, key) &&
        input[key] !== null &&
        input[key] !== undefined);
    const result = object(payload.tool_response) ? payload.tool_response : {};
    let reportedError = null;
    if (phase === "post") {
        if (typeof result.isError === "boolean")
            reportedError = result.isError;
        else if (typeof result.is_error === "boolean")
            reportedError = result.is_error;
        else if (Object.hasOwn(result, "error") && Boolean(result.error))
            reportedError = true;
    }
    const event = {
        schema_version: 1,
        phase,
        recorded_at: new Date(now).toISOString(),
        time_ms: now,
        session_hash: hash(payload.session_id),
        tool_use_hash: hash(payload.tool_use_id),
        tool_name: payload.tool_name,
        source,
        computer_use_candidate: isComputerUseTool(payload.tool_name),
        input_shape: shape,
        other_input_key_count: otherKeys,
        target_info: hasTarget
            ? "explicit_fields"
            : typeof input.code === "string"
                ? "opaque_code"
                : "none",
        reported_tool_error: reportedError,
    };
    if (identity(payload.turn_id))
        event.turn_hash = hash(payload.turn_id);
    if (typeof input.code === "string")
        event.code_length = input.code.length;
    return event;
}
/** 원본 페이로드가 저장되지 않도록 허용되지 않은 필드를 거절합니다. */
export function isSanitizedEvent(value) {
    if (!object(value))
        return false;
    const allowed = new Set([
        "schema_version",
        "phase",
        "recorded_at",
        "time_ms",
        "session_hash",
        "tool_use_hash",
        "turn_hash",
        "tool_name",
        "source",
        "computer_use_candidate",
        "input_shape",
        "other_input_key_count",
        "code_length",
        "target_info",
        "reported_tool_error",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
        return false;
    if (value.schema_version !== 1 ||
        !["pre", "post"].includes(value.phase))
        return false;
    if (typeof value.time_ms !== "number" ||
        !Number.isSafeInteger(value.time_ms) ||
        value.time_ms < 0 ||
        value.time_ms > 8_640_000_000_000_000)
        return false;
    if (value.recorded_at !== new Date(value.time_ms).toISOString())
        return false;
    if (typeof value.session_hash !== "string" || !HASH.test(value.session_hash))
        return false;
    if (typeof value.tool_use_hash !== "string" ||
        !HASH.test(value.tool_use_hash))
        return false;
    if (value.turn_hash !== undefined &&
        (typeof value.turn_hash !== "string" || !HASH.test(value.turn_hash)))
        return false;
    if (!isComputerUseTool(value.tool_name))
        return false;
    if (!SOURCES.includes(value.source) ||
        typeof value.computer_use_candidate !== "boolean")
        return false;
    if (value.computer_use_candidate !== isComputerUseTool(value.tool_name))
        return false;
    if (!object(value.input_shape) ||
        Object.keys(value.input_shape).some((key) => !INPUT_KEYS.has(key)))
        return false;
    if (Object.values(value.input_shape).some((type) => !INPUT_TYPES.includes(type)))
        return false;
    if (!Number.isSafeInteger(value.other_input_key_count) ||
        value.other_input_key_count < 0)
        return false;
    if (value.code_length !== undefined &&
        (!Number.isSafeInteger(value.code_length) ||
            value.code_length < 0))
        return false;
    if (!["opaque_code", "explicit_fields", "none"].includes(value.target_info))
        return false;
    return (value.reported_tool_error === null ||
        typeof value.reported_tool_error === "boolean");
}
