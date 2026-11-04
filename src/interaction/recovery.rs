use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::common::observation::{CallMetadata, Observation, observe_hook, read_session_events};
use crate::interaction::operation::{
    MAX_READ_WAIT_MS, MAX_TOOL_WAIT_MS, Operation, classify_operation, read_recovery_outcome,
    wrap_read_with_budget, wrap_settlement_probe,
};

struct HookInput<'a> {
    raw: &'a Value,
    session_id: &'a str,
    turn_id: &'a str,
    tool_use_id: &'a str,
    tool_name: &'a str,
    hook_event_name: &'a str,
    tool_input: &'a Map<String, Value>,
    tool_response: Option<&'a Value>,
}

// Computer Use 도구 이름 확인
fn is_target_tool(tool_name: &str) -> bool {
    matches!(tool_name, "mcp__cua_repl__js" | "mcp__cua_repl__js_reset")
}

// 호출 식별자 길이 확인
fn is_identifier(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 256
}

// Computer Use 훅 입력 확인
fn parse_input(input: &Value) -> Option<HookInput<'_>> {
    let tool_name = input.get("tool_name")?.as_str()?;
    let hook_event_name = input.get("hook_event_name")?.as_str()?;
    if !is_target_tool(tool_name) || !matches!(hook_event_name, "PreToolUse" | "PostToolUse") {
        return None;
    }
    let session_id = input.get("session_id")?.as_str()?;
    let turn_id = input.get("turn_id")?.as_str()?;
    let tool_use_id = input.get("tool_use_id")?.as_str()?;
    let tool_input = input.get("tool_input")?.as_object()?;
    if ![session_id, turn_id, tool_use_id]
        .into_iter()
        .all(is_identifier)
    {
        return None;
    }
    Some(HookInput {
        raw: input,
        session_id,
        turn_id,
        tool_use_id,
        tool_name,
        hook_event_name,
        tool_input,
        tool_response: input.get("tool_response"),
    })
}

// JavaScript 공백 문자 확인
fn is_javascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

// JavaScript 기준 앞뒤 공백 제거
fn trim_javascript(value: &str) -> &str {
    value.trim_matches(is_javascript_whitespace)
}

// 요청 식별 해시 생성
fn fingerprint(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

// 복구 예산 저장 경로 생성
fn reservation_directory(data_directory: &Path, input: &HookInput<'_>) -> PathBuf {
    data_directory
        .join("recovery")
        .join(fingerprint(input.session_id))
        .join(fingerprint(input.turn_id))
}

// 회차당 한 번의 읽기 복구 예약
fn reserve_fallback(
    data_directory: &Path,
    input: &HookInput<'_>,
    token: &str,
) -> Result<bool, String> {
    let directory = reservation_directory(data_directory, input);
    let parent = directory
        .parent()
        .ok_or_else(|| "Recovery directory is unavailable.".to_owned())?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)
        .map_err(|error| error.to_string())?;
    match DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(error.to_string()),
    }
    if let Err(error) = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join(token))
    {
        fs::remove_dir(&directory).map_err(|cleanup_error| cleanup_error.to_string())?;
        return Err(error.to_string());
    }
    Ok(true)
}

// 사용하지 않은 읽기 복구 예약 해제
fn release_fallback(
    data_directory: &Path,
    input: &HookInput<'_>,
    token: &str,
) -> Result<(), String> {
    let directory = reservation_directory(data_directory, input);
    match fs::remove_file(directory.join(token)) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    }
    fs::remove_dir(directory).map_err(|error| error.to_string())
}

// 호출 전후 관측 연결
fn returned_event<'a>(events: &'a [Observation], start: &Observation) -> Option<&'a Observation> {
    events.iter().find(|event| {
        event.event == "PostToolUse"
            && event.tool_use_id == start.tool_use_id
            && event.turn_id == start.turn_id
            && event.tool_name == start.tool_name
    })
}

// 공식 연결이 확인된 App 변수 조회
fn confirmed_bindings(events: &[Observation], turn_id: &str) -> HashMap<String, String> {
    let mut bindings = HashMap::new();
    for event in events.iter().filter(|event| event.turn_id == turn_id) {
        let Some(metadata) = &event.metadata else {
            if event.event == "PreToolUse" {
                bindings.clear();
            }
            continue;
        };
        if metadata.blocked {
            continue;
        }
        if event.event == "PreToolUse" && matches!(metadata.kind.as_str(), "other" | "reset") {
            bindings.clear();
        }
        if event.event == "PreToolUse"
            && metadata.kind == "connect"
            && let Some(receiver) = &metadata.receiver
        {
            bindings.remove(receiver);
        }
        if event.event != "PostToolUse" || event.explicit_error || metadata.kind != "connect" {
            continue;
        }
        let (Some(receiver), Some(app_id)) = (&metadata.receiver, &metadata.app_id) else {
            continue;
        };
        let Some(connection_start) = events.iter().find(|start| {
            start.event == "PreToolUse"
                && start.tool_use_id == event.tool_use_id
                && start.turn_id == event.turn_id
                && start.tool_name == event.tool_name
        }) else {
            continue;
        };
        let invalidated = events.iter().any(|other| {
            other.turn_id == turn_id
                && other.event == "PreToolUse"
                && other.tool_use_id != event.tool_use_id
                && other.observed_at_ms >= connection_start.observed_at_ms
                && !other.metadata.as_ref().is_some_and(|value| value.blocked)
                && other.metadata.as_ref().is_none_or(|value| {
                    matches!(value.kind.as_str(), "other" | "reset")
                        || (value.kind == "connect" && value.receiver.as_ref() == Some(receiver))
                })
        });
        if !invalidated {
            bindings.insert(receiver.clone(), app_id.clone());
        }
    }
    bindings
}

// 요청의 최소 메타데이터 생성
fn metadata_for(
    input: &HookInput<'_>,
    operation: &Operation,
    bindings: &HashMap<String, String>,
) -> CallMetadata {
    let code = trim_javascript(
        input
            .tool_input
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let (kind, receiver, app_id, method) = match operation {
        Operation::Inventory => ("inventory", None, None, None),
        Operation::Connect { receiver, app_id } => {
            ("connect", receiver.clone(), Some(app_id.clone()), None)
        }
        Operation::Read(reading) => (
            "read",
            Some(reading.receiver.clone()),
            bindings.get(&reading.receiver).cloned(),
            Some(reading.method.clone()),
        ),
        Operation::Reset => ("reset", None, None, None),
        Operation::Other => ("other", None, None, None),
    };
    CallMetadata {
        request_hash: fingerprint(&format!("{}\n{}", input.tool_name, code)),
        kind: if is_completion(input) {
            "completion"
        } else {
            kind
        }
        .to_owned(),
        receiver,
        app_id,
        method,
        recovery_token: None,
        parent_recovery_token: None,
        allow_fallback: false,
        recovery_outcome: None,
        blocked: false,
    }
}

// 앱 선택자 비교
fn same_app(left: Option<&str>, right: Option<&str>) -> bool {
    let (Some(left), Some(right)) = (left, right) else {
        return false;
    };
    let left: String = left.nfc().collect();
    let right: String = right.nfc().collect();
    trim_javascript(&left).to_lowercase() == trim_javascript(&right).to_lowercase()
}

// 불확실한 호출 이후의 재실행 제한
fn blocking_reason(
    events: &[Observation],
    input: &HookInput<'_>,
    metadata: &CallMetadata,
) -> Option<&'static str> {
    let starts: Vec<_> = events
        .iter()
        .filter(|event| {
            event.event == "PreToolUse"
                && event.turn_id == input.turn_id
                && !event.metadata.as_ref().is_some_and(|value| value.blocked)
        })
        .collect();
    let unresolved_attempts = starts
        .iter()
        .filter(|start| {
            let Some(prior) = &start.metadata else {
                return false;
            };
            if start.tool_use_id == input.tool_use_id
                || !matches!(prior.kind.as_str(), "read" | "connect")
            {
                return false;
            }
            let end = returned_event(events, start);
            let outcome = end
                .and_then(|event| event.metadata.as_ref())
                .and_then(|value| value.recovery_outcome.as_deref());
            end.is_none()
                || end.is_some_and(|event| event.explicit_error)
                || outcome == Some("fallback_returned")
                || (prior.recovery_token.is_some() && outcome.is_none())
        })
        .count();
    if unresolved_attempts >= 2 && metadata.kind != "inventory" {
        return Some(
            "CCUH: two app connection or read attempts in this turn have failed or remain unconfirmed. Stop further attempts and report the unresolved result. Do not switch tools to bypass this limit.",
        );
    }
    for start in starts {
        if start.tool_use_id == input.tool_use_id {
            continue;
        }
        let prior = start.metadata.as_ref();
        let end = returned_event(events, start);
        let outcome = end
            .and_then(|event| event.metadata.as_ref())
            .and_then(|value| value.recovery_outcome.as_deref());
        let prior_has_token = prior.is_some_and(|value| value.recovery_token.is_some());
        let uncertain = end.is_none()
            || end.is_some_and(|event| event.explicit_error)
            || (prior_has_token && outcome.is_none());
        if uncertain
            && prior.is_some_and(|value| value.kind == "connect")
            && metadata.kind == "connect"
            && same_app(
                prior.and_then(|value| value.app_id.as_deref()),
                metadata.app_id.as_deref(),
            )
        {
            return Some(
                "CCUH: connection to this app already failed or is unconfirmed. Changing the variable name does not permit another connection attempt.",
            );
        }
        if prior_has_token
            && metadata.kind == "connect"
            && same_app(
                prior.and_then(|value| value.app_id.as_deref()),
                metadata.app_id.as_deref(),
            )
            && (end.is_none()
                || end.is_some_and(|event| event.explicit_error)
                || outcome != Some("primary_returned"))
        {
            return Some(
                "CCUH: the read fallback budget is spent or unconfirmed. Do not reconnect or reselect an app to restart attempts. Use an existing verified observation or report the unresolved result.",
            );
        }
        if uncertain && matches!(metadata.kind.as_str(), "other" | "reset") {
            return Some(
                "CCUH: a previous operation has an unconfirmed or failed result. Do not continue with input, clicks, submission, or reset. Verify through an approved read-only path or report the unresolved result.",
            );
        }
        if uncertain && prior.is_some_and(|value| value.request_hash == metadata.request_hash) {
            return Some(
                "CCUH: the previous identical call has no confirmed successful return. Do not repeat it. Use a read-only check or report the unresolved result; do not switch to another engine.",
            );
        }
        if prior_has_token
            && metadata.kind == "read"
            && same_app(
                prior.and_then(|value| value.app_id.as_deref()),
                metadata.app_id.as_deref(),
            )
        {
            if end.is_none() || end.is_some_and(|event| event.explicit_error) || outcome.is_none() {
                return Some(
                    "CCUH: this app read recovery is exhausted or unconfirmed. Stop further reads for this app and report what could not be verified. Do not reset, raise, or reselect the app.",
                );
            }
            if outcome == Some("fallback_returned")
                && prior.is_some_and(|value| value.method == metadata.method)
            {
                return Some(
                    "CCUH: this read method already failed in this turn and the alternate read returned. Use the alternate observation instead of retrying the failed method under another App variable or selector.",
                );
            }
        }
        if uncertain
            && prior.is_none_or(|value| value.kind == "other")
            && !matches!(metadata.kind.as_str(), "inventory" | "connect")
            && (metadata.kind != "read" || metadata.app_id.is_none())
        {
            return Some(
                "CCUH: an earlier call may have changed the app but its result is unconfirmed. Do not repeat input, clicks, submission, or reset. Verify the existing result through an approved read-only path or stop.",
            );
        }
    }
    None
}

// 실행 전 차단 결과 생성
fn deny(reason: &str) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })
}

// 코드 실행의 공식 대기 상한 적용
fn bounded_input(input: &HookInput<'_>) -> Result<Map<String, Value>, String> {
    let mut updated = input.tool_input.clone();
    if input.tool_name == "mcp__cua_repl__js" && updated.get("code").is_some() {
        let budget = match updated.get("timeout_ms") {
            Some(value) => value
                .as_u64()
                .filter(|value| *value > 0)
                .ok_or_else(|| "The Computer Use wait budget is invalid.".to_owned())?,
            None => MAX_TOOL_WAIT_MS,
        };
        updated.insert(
            "timeout_ms".to_owned(),
            Value::from(budget.min(MAX_TOOL_WAIT_MS)),
        );
    }
    Ok(updated)
}

// 실제 실행 제한을 포함한 호출 시작 기록
fn observe_start(
    input: &HookInput<'_>,
    data_directory: &Path,
    metadata: CallMetadata,
    tool_input: &Map<String, Value>,
) -> Result<bool, String> {
    let mut raw = input.raw.clone();
    raw["tool_input"] = Value::Object(tool_input.clone());
    observe_hook(&raw, Some(data_directory), Some(metadata))
}

// 코드 없는 완료 표시 호출 확인
fn is_completion(input: &HookInput<'_>) -> bool {
    input.tool_name == "mcp__cua_repl__js"
        && input.tool_input.len() == 1
        && input
            .tool_input
            .get("completion_summary")
            .and_then(Value::as_str)
            .is_some()
}

// 회차를 넘겨 남아 있는 실제 완료 미확인 호출 조회
fn pending_call(events: &[Observation]) -> Option<&Observation> {
    events.iter().find(|start| {
        let Some(metadata) = &start.metadata else {
            return false;
        };
        if start.event != "PreToolUse"
            || metadata.blocked
            || metadata.kind == "settlement"
            || metadata.request_hash == fingerprint("mcp__cua_repl__js\n")
        {
            return false;
        }
        let end = returned_event(events, start);
        let outcome = end
            .and_then(|event| event.metadata.as_ref())
            .and_then(|value| value.recovery_outcome.as_deref());
        let uncertain = end.is_none()
            || matches!(
                outcome,
                Some("wait_expired" | "state_missing" | "host_wait_expired")
            )
            || (metadata.recovery_token.is_some() && outcome.is_none());
        if !uncertain {
            return false;
        }
        let settled = metadata.recovery_token.as_ref().is_some_and(|token| {
            events.iter().any(|probe| {
                probe.event == "PostToolUse"
                    && !probe.explicit_error
                    && probe.metadata.as_ref().is_some_and(|value| {
                        value.kind == "settlement"
                            && value.parent_recovery_token.as_ref() == Some(token)
                            && value.app_id == metadata.app_id
                            && value.recovery_outcome.as_deref() == Some("late_settled")
                    })
            })
        });
        !settled
    })
}

// 원래 요청을 실행하지 않는 늦은 완료 확인 준비
fn prepare_settlement(
    input: &HookInput<'_>,
    data_directory: &Path,
    events: &[Observation],
    pending: &Observation,
    mut metadata: CallMetadata,
) -> Result<Value, String> {
    let prior = pending
        .metadata
        .as_ref()
        .ok_or("Pending metadata is missing.")?;
    let already_probed = events.iter().any(|event| {
        event.event == "PreToolUse"
            && event.turn_id == input.turn_id
            && event
                .metadata
                .as_ref()
                .is_some_and(|value| value.kind == "settlement")
    });
    if input.tool_name != "mcp__cua_repl__js"
        || input
            .tool_input
            .get("code")
            .and_then(Value::as_str)
            .is_none()
        || prior.kind != "read"
        || prior.recovery_token.is_none()
        || already_probed
    {
        metadata.blocked = true;
        observe_hook(input.raw, Some(data_directory), Some(metadata))?;
        return Ok(deny(
            "CCUH: a previous native operation still has no confirmed completion. This request was not executed. Do not repeat, reconnect, reset, or change the app; report the unresolved result. A wait deadline is not a native cancellation.",
        ));
    }
    let token = Uuid::new_v4().simple().to_string();
    let parent_token = prior
        .recovery_token
        .as_deref()
        .ok_or("The pending read token is missing.")?;
    metadata.kind = "settlement".to_owned();
    metadata.receiver = prior.receiver.clone();
    metadata.app_id = prior.app_id.clone();
    metadata.method = prior.method.clone();
    metadata.recovery_token = Some(token.clone());
    metadata.parent_recovery_token = Some(parent_token.to_owned());
    let mut updated = bounded_input(input)?;
    updated.insert(
        "code".to_owned(),
        Value::String(wrap_settlement_probe(parent_token, &token)?),
    );
    if !observe_start(input, data_directory, metadata, &updated)? {
        return Ok(deny(
            "CCUH: this invocation is already being handled. Do not replay it.",
        ));
    }
    Ok(json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "updatedInput": updated,
        }
    }))
}

// 호스트의 실행 대기 초과 응답 확인
fn is_host_deadline(response: &Value) -> bool {
    if response.get("isError").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let Some(content) = response.get("content").and_then(Value::as_array) else {
        return false;
    };
    content
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .any(|text| {
            let lower = text.to_lowercase();
            lower.contains("timed out")
                || lower.contains("execution timeout")
                || lower.contains("timeoutreached")
        })
}

// 호출 전 복구 경로 준비
fn prepare_read(
    input: &HookInput<'_>,
    data_directory: &Path,
    events: &[Observation],
) -> Result<Option<Value>, String> {
    let operation = classify_operation(
        input.tool_name,
        input.tool_input.get("code").and_then(Value::as_str),
    );
    let bindings = confirmed_bindings(events, input.turn_id);
    let mut metadata = metadata_for(input, &operation, &bindings);
    if events.iter().any(|event| {
        event.event == "PreToolUse"
            && event.tool_use_id == input.tool_use_id
            && event.turn_id == input.turn_id
            && event.tool_name == input.tool_name
    }) {
        return Ok(Some(deny(
            "CCUH: this invocation identifier has already been observed. Do not replay the call.",
        )));
    }
    if is_completion(input) {
        observe_hook(input.raw, Some(data_directory), Some(metadata))?;
        return Ok(None);
    }
    if let Some(pending) = pending_call(events) {
        return prepare_settlement(input, data_directory, events, pending, metadata).map(Some);
    }
    if let Some(reason) = blocking_reason(events, input, &metadata) {
        metadata.blocked = true;
        if !observe_hook(input.raw, Some(data_directory), Some(metadata))? {
            return Ok(Some(deny(
                "CCUH: this invocation is already being handled. Do not execute a duplicate call.",
            )));
        }
        return Ok(Some(deny(reason)));
    }
    if let Operation::Read(reading) = &operation
        && metadata.app_id.is_some()
    {
        let mut updated_input = bounded_input(input)?;
        let host_budget = updated_input
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .ok_or("The read wait budget is missing.")?;
        let read_budget = host_budget
            .checked_sub(1_000)
            .filter(|budget| *budget > 0)
            .ok_or("The read wait budget is too short.")?
            .min(MAX_READ_WAIT_MS);
        let token = Uuid::new_v4().simple().to_string();
        metadata.recovery_token = Some(token.clone());
        metadata.allow_fallback = reserve_fallback(data_directory, input, &token)?;
        if !observe_start(input, data_directory, metadata.clone(), &updated_input)? {
            if metadata.allow_fallback {
                release_fallback(data_directory, input, &token)?;
            }
            return Ok(Some(deny(
                "CCUH: this invocation is already being handled. Do not execute a duplicate call.",
            )));
        }
        updated_input.insert(
            "code".to_owned(),
            Value::String(wrap_read_with_budget(
                reading,
                &token,
                metadata.allow_fallback,
                read_budget,
            )?),
        );
        return Ok(Some(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": updated_input,
            }
        })));
    }
    let updated_input = bounded_input(input)?;
    if !observe_start(input, data_directory, metadata, &updated_input)? {
        return Ok(Some(deny(
            "CCUH: this invocation is already being handled. Do not execute a duplicate call.",
        )));
    }
    if updated_input != *input.tool_input {
        return Ok(Some(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": updated_input,
            }
        })));
    }
    Ok(None)
}

// 읽기 복구 결과와 예산 반영
fn finish_read(
    input: &HookInput<'_>,
    data_directory: &Path,
    events: &[Observation],
) -> Result<Option<Value>, String> {
    let start = events.iter().find(|event| {
        event.event == "PreToolUse"
            && event.tool_use_id == input.tool_use_id
            && event.turn_id == input.turn_id
            && event.tool_name == input.tool_name
    });
    if start.is_some_and(|event| returned_event(events, event).is_some()) {
        return Ok(None);
    }
    let mut metadata = start.and_then(|event| event.metadata.clone());
    if let Some(value) = &mut metadata
        && let Some(token) = &value.recovery_token
    {
        value.recovery_outcome =
            read_recovery_outcome(input.tool_response.unwrap_or(&Value::Null), token);
        if value.kind == "settlement"
            && !matches!(
                value.recovery_outcome.as_deref(),
                Some("late_settled" | "native_pending" | "state_missing")
            )
        {
            value.recovery_outcome = None;
        }
        if value.kind != "settlement"
            && matches!(
                value.recovery_outcome.as_deref(),
                Some("late_settled" | "native_pending")
            )
        {
            value.recovery_outcome = None;
        }
        if value.allow_fallback && value.recovery_outcome.as_deref() == Some("primary_returned") {
            release_fallback(data_directory, input, token)?;
        }
    }
    if let Some(value) = &mut metadata
        && value.recovery_outcome.is_none()
        && is_host_deadline(input.tool_response.unwrap_or(&Value::Null))
    {
        value.recovery_outcome = Some("host_wait_expired".to_owned());
    }
    observe_hook(input.raw, Some(data_directory), metadata.clone())?;
    let Some(metadata) = metadata else {
        return Ok(None);
    };
    if metadata.kind == "settlement" {
        let context = if metadata.recovery_outcome.as_deref() == Some("late_settled") {
            "CCUH: the earlier native read has now settled. Its original result remains unknown; this does not prove success. The operation requested in this call was not executed. A fresh approved read may now verify the current state, provided no other native operation remains unresolved."
        } else {
            "CCUH: the earlier native read is still pending or its state is unavailable. The operation requested in this call was not executed. Stop app operations and report the unresolved result; do not reconnect, reset, or switch engines."
        };
        return Ok(Some(
            json!({"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":context}}),
        ));
    }
    if metadata.recovery_outcome.as_deref() == Some("host_wait_expired") {
        return Ok(Some(
            json!({"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"CCUH: the official execution wait limit was reached. Native completion is unconfirmed; the timeout is not a cancellation acknowledgement. Do not replay the operation, reset, or change the app. Report the result as unknown."}}),
        ));
    }
    if metadata.recovery_token.is_none()
        || metadata.recovery_outcome.as_deref() == Some("primary_returned")
    {
        return Ok(None);
    }
    let context = if metadata.recovery_outcome.as_deref() == Some("wait_expired") {
        "CCUH: the bounded read wait ended without confirmed native completion. No fallback was started after the deadline. This is not a native cancellation. Report the result as unknown; do not repeat, reconnect, reset, or change the app. A later metadata-only settlement check may establish that the pending read ended."
    } else if metadata.recovery_outcome.as_deref() == Some("fallback_returned") {
        if metadata.method.as_deref() == Some("getAXStateAndScreenshot") {
            "CCUH: the combined AX and screenshot read timed out; one screenshot-only read on the same App object returned. Inspect the screenshot to answer the user. AX state remains unconfirmed, and this does not prove the requested task succeeded. The fallback budget for this turn is spent."
        } else {
            "CCUH: the primary read failed; one alternate read on the same App object returned. Inspect that observation to answer the user. This does not prove the requested task succeeded. The fallback budget for this turn is spent."
        }
    } else {
        "CCUH: the read recovery failed or its execution could not be confirmed. Stop further attempts for this app, explain what remains unknown, and do not reset, switch engines, activate, or raise a window."
    };
    Ok(Some(json!({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": context,
        }
    })))
}

// 공식 Computer Use의 제한된 복구 처리
pub fn process_hook(input: &Value, data_directory: Option<&Path>) -> Result<Option<Value>, String> {
    let Some(input) = parse_input(input) else {
        if input
            .get("tool_name")
            .and_then(Value::as_str)
            .is_some_and(is_target_tool)
        {
            return Err("Required Computer Use hook fields are missing.".to_owned());
        }
        return Ok(None);
    };
    let data_directory =
        data_directory.ok_or_else(|| "Plugin data directory is unavailable.".to_owned())?;
    let events = read_session_events(data_directory, input.session_id)?;
    if input.hook_event_name == "PreToolUse" {
        prepare_read(&input, data_directory, &events)
    } else {
        finish_read(&input, data_directory, &events)
    }
}
