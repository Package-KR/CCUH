use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadOperation {
    pub receiver: String,
    pub method: String,
    pub expression: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Operation {
    Inventory,
    Connect {
        receiver: Option<String>,
        app_id: String,
    },
    Read(ReadOperation),
    Reset,
    Other,
}

const IDENTIFIER: &str = "[A-Za-z_$][A-Za-z0-9_$]*";
pub const MAX_TOOL_WAIT_MS: u64 = 30_000;
pub const MAX_READ_WAIT_MS: u64 = 20_000;
const JS_WHITESPACE: &str = r"[\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

static INVENTORY_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    operation_pattern(r"\A\s*await\s+cua\.getState\(\s*(?:\{\s*\})?\s*\)\s*;?\s*\z")
});
static CONNECT_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    operation_pattern(&format!(
        r#"\A\s*(?:(?:(?:var|let|const)\s+)?({IDENTIFIER})\s*=\s*)?await\s+cua\.getApp\(\s*(['"])([\p{{L}}\p{{N}} ._()-]+)(['"])\s*\)\s*;?\s*\z"#,
    ))
});
static READ_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    operation_pattern(&format!(
        r"\A\s*await\s+(({IDENTIFIER})\.(getAXState|getScreenshot|getAXStateAndScreenshot)\(\s*(\{{\s*disableDiffing\s*:\s*(?:true|false)\s*\}})?\s*\))\s*;?\s*\z",
    ))
});
static LINE_BREAK_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\r?\n").expect("The static line-break pattern must be valid."));

// JavaScript 공백 규칙을 유지하는 작업 패턴 생성
fn operation_pattern(pattern: &str) -> Regex {
    Regex::new(&pattern.replace(r"\s", JS_WHITESPACE))
        .expect("The static operation pattern must be valid.")
}

// 단순 변수 이름 확인
fn is_receiver(value: &str) -> bool {
    let mut characters = value.chars();
    let starts_as_identifier = characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || matches!(character, '_' | '$'));

    starts_as_identifier
        && characters
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '$'))
        && value != "nodeRepl"
        && !matches!(
            value,
            "await"
                | "break"
                | "case"
                | "catch"
                | "class"
                | "const"
                | "continue"
                | "debugger"
                | "default"
                | "delete"
                | "do"
                | "else"
                | "enum"
                | "export"
                | "extends"
                | "false"
                | "finally"
                | "for"
                | "function"
                | "if"
                | "implements"
                | "import"
                | "in"
                | "instanceof"
                | "interface"
                | "let"
                | "new"
                | "null"
                | "package"
                | "private"
                | "protected"
                | "public"
                | "return"
                | "static"
                | "super"
                | "switch"
                | "this"
                | "throw"
                | "true"
                | "try"
                | "typeof"
                | "var"
                | "void"
                | "while"
                | "with"
                | "yield"
        )
}

// 복구 식별 표식 확인
fn is_token(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, b'_' | b'-'))
}

// 복구 결과 표식 확인
fn is_outcome(value: &str) -> bool {
    matches!(
        value,
        "primary_returned"
            | "fallback_returned"
            | "fallback_failed"
            | "failed"
            | "wait_expired"
            | "native_pending"
            | "late_settled"
            | "state_missing"
            | "host_wait_expired"
    )
}

// JavaScript 문자열 공백 확인
fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

// 제한된 Computer Use 작업 분류
pub fn classify_operation(tool_name: &str, code: Option<&str>) -> Operation {
    if tool_name == "mcp__cua_repl__js_reset" {
        return Operation::Reset;
    }
    let Some(code) = code else {
        return Operation::Other;
    };
    if tool_name != "mcp__cua_repl__js" || code.encode_utf16().count() > 4096 {
        return Operation::Other;
    }
    if INVENTORY_PATTERN.is_match(code) {
        return Operation::Inventory;
    }

    if let Some(connection) = CONNECT_PATTERN.captures(code) {
        let receiver = connection.get(1).map(|value| value.as_str());
        let opening_quote = connection.get(2).map(|value| value.as_str());
        let closing_quote = connection.get(4).map(|value| value.as_str());
        if let Some(app_id) = connection.get(3).map(|value| value.as_str())
            && opening_quote == closing_quote
            && app_id.encode_utf16().count() <= 256
            && receiver.is_none_or(is_receiver)
        {
            return Operation::Connect {
                receiver: receiver.map(str::to_owned),
                app_id: app_id.to_owned(),
            };
        }
    }

    if let Some(reading) = READ_PATTERN.captures(code)
        && let (Some(expression), Some(receiver), Some(method)) =
            (reading.get(1), reading.get(2), reading.get(3))
    {
        let receiver = receiver.as_str();
        let method = method.as_str();
        if is_receiver(receiver) && (method != "getScreenshot" || reading.get(4).is_none()) {
            return Operation::Read(ReadOperation {
                receiver: receiver.to_owned(),
                method: method.to_owned(),
                expression: expression.as_str().to_owned(),
            });
        }
    }

    Operation::Other
}

// 같은 앱 객체의 제한된 대체 읽기 생성
pub fn wrap_read(
    operation: &ReadOperation,
    token: &str,
    allow_fallback: bool,
) -> Result<String, String> {
    wrap_read_with_budget(operation, token, allow_fallback, MAX_READ_WAIT_MS)
}

// 전체 대기 시간을 제한한 같은 앱 읽기 생성
pub fn wrap_read_with_budget(
    operation: &ReadOperation,
    token: &str,
    allow_fallback: bool,
    wait_budget_ms: u64,
) -> Result<String, String> {
    let parsed = classify_operation(
        "mcp__cua_repl__js",
        Some(&format!("await {};", operation.expression)),
    );
    if !is_token(token)
        || parsed != Operation::Read(operation.clone())
        || !(1..=MAX_READ_WAIT_MS).contains(&wait_budget_ms)
    {
        return Err("The read operation or recovery token is invalid.".to_owned());
    }

    let counterpart = if operation.method == "getScreenshot" {
        "getAXState"
    } else {
        "getScreenshot"
    };
    let primary_expression = format!(
        "__ccuhApp{}",
        &operation.expression[operation.receiver.len()..]
    );
    let fallback = if allow_fallback {
        format!(
            r#"const __ccuhName = typeof __ccuhError?.name === 'string' ? __ccuhError.name : '';
    const __ccuhCode = typeof __ccuhError?.code === 'string' ? __ccuhError.code : '';
    const __ccuhMessage = typeof __ccuhError?.message === 'string' ? __ccuhError.message : '';
    const __ccuhText = __ccuhName + ' ' + __ccuhCode + ' ' + __ccuhMessage;
    const __ccuhDenied = /denied|permission|authori[sz]|authenticat|forbidden|not.?allowed|not.?permitted|revoked|cancel|abort|EACCES|EPERM|권한|거부|취소/i.test(__ccuhText);
    const __ccuhTimedOut = __ccuhName === 'TimeoutError' || __ccuhCode === 'ETIMEDOUT' || __ccuhCode === 'timeoutReached' || /\btimeoutReached\b/.test(__ccuhMessage);
    if (__ccuhState.expired || performance.now() >= __ccuhEndsAt || __ccuhDenied || !__ccuhTimedOut) {{
      return {{ outcome: 'failed' }};
    }}
    try {{
      __ccuhResult = await __ccuhApp.{counterpart}();
    }} catch {{
      return {{ outcome: 'fallback_failed' }};
    }}
    return {{ outcome: 'fallback_returned', value: __ccuhResult }};"#,
        )
    } else {
        "return { outcome: 'failed' };".to_owned()
    };

    Ok(format!(
        r#"await (async (__ccuhApp) => {{
  const __ccuhRegistryKey = Symbol.for('ccuh.pendingReads.v1');
  const __ccuhRegistry = globalThis[__ccuhRegistryKey] ??= new Map();
  if (!(__ccuhRegistry instanceof Map)) {{
    nodeRepl.write('CCUH_READ_RESULT {token} state_missing');
    return;
  }}
  for (const [__ccuhKey, __ccuhOld] of __ccuhRegistry) {{
    if (__ccuhOld?.settled === true) __ccuhRegistry.delete(__ccuhKey);
  }}
  if (__ccuhRegistry.size >= 128) {{
    nodeRepl.write('CCUH_READ_RESULT {token} state_missing');
    return;
  }}
  const __ccuhState = {{ expired: false, settled: false }};
  const __ccuhEndsAt = performance.now() + {wait_budget_ms};
  __ccuhRegistry.set('{token}', __ccuhState);
  let __ccuhTimer;
  const __ccuhDeadline = new Promise((resolve) => {{
    __ccuhTimer = setTimeout(() => {{
      __ccuhState.expired = true;
      resolve({{ outcome: 'wait_expired' }});
    }}, {wait_budget_ms});
  }});
  const __ccuhRun = (async () => {{
    let __ccuhResult;
    try {{
      __ccuhResult = await {primary_expression};
    }} catch (__ccuhError) {{
      {fallback}
    }}
    return {{ outcome: 'primary_returned', value: __ccuhResult }};
  }})();
  __ccuhRun.then(() => {{ __ccuhState.settled = true; }}, () => {{ __ccuhState.settled = true; }});
  let __ccuhReply = await Promise.race([__ccuhRun, __ccuhDeadline]);
  clearTimeout(__ccuhTimer);
  if (__ccuhState.expired || performance.now() >= __ccuhEndsAt) {{
    __ccuhState.expired = true;
    __ccuhReply = {{ outcome: 'wait_expired' }};
  }}
  nodeRepl.write('CCUH_READ_RESULT {token} ' + __ccuhReply.outcome);
  if (!__ccuhState.expired) __ccuhRegistry.delete('{token}');
  return __ccuhReply.value;
}})({receiver});"#,
        receiver = operation.receiver,
    ))
}

// 앱에 재접근하지 않는 늦은 완료 상태 확인
pub fn wrap_settlement_probe(parent_token: &str, token: &str) -> Result<String, String> {
    if !is_token(parent_token) || !is_token(token) || parent_token == token {
        return Err("The read settlement token is invalid.".to_owned());
    }
    Ok(format!(
        r#"await (async () => {{
  const __ccuhRegistry = globalThis[Symbol.for('ccuh.pendingReads.v1')];
  const __ccuhState = __ccuhRegistry instanceof Map ? __ccuhRegistry.get('{parent_token}') : undefined;
  const __ccuhOutcome = __ccuhState?.settled === true ? 'late_settled' : __ccuhState ? 'native_pending' : 'state_missing';
  nodeRepl.write('CCUH_READ_RESULT {token} ' + __ccuhOutcome);
}})();"#
    ))
}

// MCP 텍스트에서 검증된 복구 결과 추출
pub fn read_recovery_outcome(response: &Value, token: &str) -> Option<String> {
    if !is_token(token) {
        return None;
    }
    let content = response.as_object()?.get("content")?.as_array()?;
    let prefix = format!("CCUH_READ_RESULT {token} ");
    let mut outcome = None;

    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = block.get("text").and_then(Value::as_str) else {
            continue;
        };
        let lines: Vec<_> = LINE_BREAK_PATTERN.split(text).collect();
        let terminal = lines
            .iter()
            .rposition(|line| !line.trim_matches(is_js_whitespace).is_empty());

        for (index, line) in lines.iter().enumerate() {
            let Some(candidate) = line.strip_prefix(prefix.as_str()) else {
                continue;
            };
            if Some(index) != terminal || !is_outcome(candidate) || outcome.is_some() {
                return None;
            }
            outcome = Some(candidate.to_owned());
        }
    }

    outcome
}
