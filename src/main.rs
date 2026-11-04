use std::env;
use std::io::{self, Read, Write};
use std::path::PathBuf;

use ccuh::interaction::recovery::process_hook;
use serde_json::{Value, json};

const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;

// 크기를 제한한 훅 입력 수신
fn read_input() -> Result<Value, String> {
    let mut buffer = [0_u8; 8192];
    let mut input = Vec::new();
    let mut oversized = false;
    let mut stdin = io::stdin().lock();

    loop {
        let count = stdin
            .read(&mut buffer)
            .map_err(|_| "Hook input could not be read.")?;
        if count == 0 {
            break;
        }
        if oversized {
            continue;
        }
        if input.len().saturating_add(count) > MAX_INPUT_BYTES {
            input.clear();
            oversized = true;
            continue;
        }
        input.extend_from_slice(&buffer[..count]);
    }

    if oversized {
        return Err("Hook input exceeds the observation limit.".into());
    }
    serde_json::from_slice(&input).map_err(|_| "Hook input is not valid JSON.".into())
}

// 공식 Computer Use 도구 이름 확인
fn is_computer_use_tool(input: &Value) -> bool {
    matches!(
        input.get("tool_name").and_then(Value::as_str),
        Some("mcp__cua_repl__js" | "mcp__cua_repl__js_reset")
    )
}

// 실행 실패 시 호출 전 차단 결과 생성
fn error_output(phase: Option<&str>, input: Option<&Value>) -> Value {
    let targeted_pre = phase == Some("PreToolUse")
        || input.is_some_and(|value| {
            value.get("hook_event_name").and_then(Value::as_str) == Some("PreToolUse")
                && is_computer_use_tool(value)
        });

    if targeted_pre {
        json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "CCUH could not validate the recovery state. This call was stopped before execution. Do not bypass the guard with another tool."
            }
        })
    } else {
        json!({ "systemMessage": "CCUH could not record this invocation." })
    }
}

// 등록된 단계와 입력 이벤트 확인
fn validate_phase(phase: Option<&str>, input: &Value) -> Result<(), String> {
    if !matches!(phase, Some("PreToolUse" | "PostToolUse")) {
        return Ok(());
    }
    if input.get("hook_event_name").and_then(Value::as_str) != phase
        || !input
            .get("tool_name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty())
    {
        return Err("Hook event does not match the registered phase.".into());
    }
    Ok(())
}

// Rust 훅의 관측과 복구 판정 실행
fn main() {
    let phase = env::args().nth(1);
    let data_directory = env::var_os("PLUGIN_DATA").map(PathBuf::from);
    let mut input = None;
    std::panic::set_hook(Box::new(|_| {}));

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let value = read_input()?;
        input = Some(value);
        let value = input.as_ref().ok_or("Hook input is unavailable.")?;
        validate_phase(phase.as_deref(), value)?;
        process_hook(value, data_directory.as_deref())
    }));

    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(_)) | Err(_) => Some(error_output(phase.as_deref(), input.as_ref())),
    };

    if let Some(output) = output {
        let mut stdout = io::stdout().lock();
        if serde_json::to_writer(&mut stdout, &output).is_err() || stdout.flush().is_err() {
            std::process::exit(1);
        }
    }
}
