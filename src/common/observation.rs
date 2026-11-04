use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use std::collections::HashMap;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallMetadata {
    pub request_hash: String,
    pub kind: String,
    #[serde(deserialize_with = "required_nullable")]
    pub receiver: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub app_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub method: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub recovery_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_recovery_token: Option<String>,
    pub allow_fallback: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub recovery_outcome: Option<String>,
    pub blocked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    #[serde(deserialize_with = "observation_version")]
    pub version: u8,
    pub event: String,
    pub session_id: String,
    pub turn_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub observed_at_ms: f64,
    pub uptime_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monotonic_ms: Option<f64>,
    #[serde(deserialize_with = "required_nullable")]
    pub budget_ms: Option<f64>,
    pub explicit_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<CallMetadata>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationClock {
    pub observed_at_ms: f64,
    pub uptime_ms: f64,
    pub monotonic_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOptions {
    pub delay_after_ms: Option<f64>,
    pub ended_turn_ids: Option<Vec<String>>,
    pub now: Option<ObservationClock>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallObservation {
    pub session_id: String,
    pub turn_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub status: String,
    pub start_observed: bool,
    pub return_observed: bool,
    pub elapsed_ms: Option<f64>,
    pub delay_after_ms: Option<f64>,
}

static APP_ID_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A[\p{L}\p{N} ._()-]+\z").expect("The application identifier pattern is valid.")
});
static RECEIVER_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z_$][A-Za-z0-9_$]*$").expect("The receiver identifier pattern is valid.")
});

// 필수 nullable 필드 역직렬화
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

// 기존 JSON 관측 버전 해석
fn observation_version<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.as_f64() == Some(1.0) {
        Ok(1)
    } else {
        Err(serde::de::Error::custom(
            "The observation version is invalid.",
        ))
    }
}

// 공식 Computer Use 도구 확인
fn is_computer_use_tool(value: &str) -> bool {
    matches!(value, "mcp__cua_repl__js" | "mcp__cua_repl__js_reset")
}

// 호출 식별자 확인
fn is_identifier(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty() && text.encode_utf16().count() <= 256)
}

// 양수 시간값 확인
fn positive_number(value: Option<f64>) -> Option<f64> {
    value.filter(|number| number.is_finite() && *number > 0.0)
}

// JSON 양수 시간값 추출
fn positive_json_number(value: Option<&Value>) -> Option<f64> {
    positive_number(value.and_then(Value::as_f64))
}

// 소문자 16진수 식별자 확인
fn is_hex_identifier(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// 앱 선택자의 문자와 길이 확인
fn is_app_identifier(value: &str) -> bool {
    !value.is_empty() && value.chars().take(257).count() <= 256 && APP_ID_PATTERN.is_match(value)
}

// 필수 nullable 문자열 확인
fn nullable_string_matches(value: Option<&Value>, predicate: impl Fn(&str) -> bool) -> bool {
    match value {
        Some(Value::Null) => true,
        Some(Value::String(text)) => predicate(text),
        _ => false,
    }
}

// 관측 식별자 해시 생성
fn digest(parts: &[&str]) -> Result<String, String> {
    let encoded = serde_json::to_vec(parts).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct MachTimebaseInfo {
    numer: u32,
    denom: u32,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    // macOS 연속 시간 조회
    fn mach_continuous_time() -> u64;
    // macOS 시간 단위 조회
    fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
}

// Node와 같은 macOS 단조 시간 조회
#[cfg(target_os = "macos")]
fn monotonic_milliseconds() -> Result<f64, String> {
    let mut info = MachTimebaseInfo { numer: 0, denom: 0 };
    let code = unsafe { mach_timebase_info(&mut info) };
    if code != 0 || info.denom == 0 {
        return Err("The macOS monotonic clock is unavailable.".to_owned());
    }
    let ticks = unsafe { mach_continuous_time() };
    let nanoseconds = u128::from(ticks) * u128::from(info.numer) / u128::from(info.denom);
    Ok(nanoseconds as f64 / 1_000_000.0)
}

// 지원하지 않는 플랫폼의 시간 조회 차단
#[cfg(not(target_os = "macos"))]
fn monotonic_milliseconds() -> Result<f64, String> {
    Err("Observation clocks are supported only on macOS.".to_owned())
}

// Node와 같은 macOS 부팅 경과시간 조회
#[cfg(target_os = "macos")]
fn uptime_milliseconds() -> Result<f64, String> {
    let mut boot_time = libc::timeval {
        tv_sec: 0,
        tv_usec: 0,
    };
    let mut length = std::mem::size_of::<libc::timeval>();
    let mut query = [libc::CTL_KERN, libc::KERN_BOOTTIME];
    let code = unsafe {
        libc::sysctl(
            query.as_mut_ptr(),
            query.len() as u32,
            (&mut boot_time as *mut libc::timeval).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if code != 0 {
        return Err("The macOS uptime clock is unavailable.".to_owned());
    }
    let now = unsafe { libc::time(std::ptr::null_mut()) };
    Ok((now - boot_time.tv_sec) as f64 * 1000.0)
}

// 지원하지 않는 플랫폼의 부팅 시간 조회 차단
#[cfg(not(target_os = "macos"))]
fn uptime_milliseconds() -> Result<f64, String> {
    Err("Observation clocks are supported only on macOS.".to_owned())
}

// 서로 비교 가능한 관측 시간 수집
fn capture_clock() -> Result<ObservationClock, String> {
    let observed_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as f64;
    let uptime_ms = uptime_milliseconds()?;
    let monotonic_ms = Some(monotonic_milliseconds()?);
    Ok(ObservationClock {
        observed_at_ms,
        uptime_ms,
        monotonic_ms,
    })
}

// 대상 호출 메타데이터 추출
fn parse_hook(input: &Value) -> Result<Option<Observation>, String> {
    let Some(object) = input.as_object() else {
        return Ok(None);
    };
    let Some(tool_name) = object.get("tool_name").and_then(Value::as_str) else {
        return Ok(None);
    };
    if !is_computer_use_tool(tool_name) {
        return Ok(None);
    }
    let Some(event @ ("PreToolUse" | "PostToolUse")) =
        object.get("hook_event_name").and_then(Value::as_str)
    else {
        return Ok(None);
    };
    if !is_identifier(object.get("session_id"))
        || !is_identifier(object.get("turn_id"))
        || !is_identifier(object.get("tool_use_id"))
    {
        return Err("Required invocation identifiers are missing.".to_owned());
    }
    let clock = capture_clock()?;
    let tool_input = object.get("tool_input").and_then(Value::as_object);
    let response = object.get("tool_response").and_then(Value::as_object);
    Ok(Some(Observation {
        version: 1,
        event: event.to_owned(),
        session_id: object["session_id"].as_str().unwrap_or_default().to_owned(),
        turn_id: object["turn_id"].as_str().unwrap_or_default().to_owned(),
        tool_use_id: object["tool_use_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        tool_name: tool_name.to_owned(),
        observed_at_ms: clock.observed_at_ms,
        uptime_ms: clock.uptime_ms,
        monotonic_ms: clock.monotonic_ms,
        budget_ms: if event == "PreToolUse" {
            positive_json_number(tool_input.and_then(|value| value.get("timeout_ms")))
        } else {
            None
        },
        explicit_error: event == "PostToolUse"
            && response
                .and_then(|value| value.get("isError"))
                .and_then(Value::as_bool)
                == Some(true),
        metadata: None,
    }))
}

// 관측 저장 경로 확인
fn session_directory(data_directory: Option<&Path>, session_id: &str) -> Result<PathBuf, String> {
    let directory = data_directory
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "Plugin data directory is unavailable.".to_owned())?;
    Ok(directory.join("observations").join(digest(&[session_id])?))
}

// 중복 없는 관측 이벤트 저장
fn save_observation(directory: &Path, observation: &Observation) -> Result<bool, String> {
    let key = digest(&[
        &observation.session_id,
        &observation.turn_id,
        &observation.tool_use_id,
        &observation.tool_name,
    ])?;
    let destination = directory.join(format!("{key}.{}.json", observation.event));
    let temporary = directory.join(format!(".{}.tmp", Uuid::new_v4()));
    let encoded = serde_json::to_vec(observation).map_err(|error| error.to_string())?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
        .map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        file.write_all(&encoded)
            .map_err(|error| error.to_string())?;
        match fs::hard_link(&temporary, &destination) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    })();
    match fs::remove_file(&temporary) {
        Ok(()) => result,
        Err(error) if error.kind() == ErrorKind::NotFound => result,
        Err(error) => Err(error.to_string()),
    }
}

// 복구 관측 메타데이터 확인
fn is_call_metadata(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let keys = [
        "requestHash",
        "kind",
        "receiver",
        "appId",
        "method",
        "recoveryToken",
        "parentRecoveryToken",
        "allowFallback",
        "recoveryOutcome",
        "blocked",
    ];
    if object.keys().any(|key| !keys.contains(&key.as_str())) {
        return false;
    }
    object
        .get("requestHash")
        .and_then(Value::as_str)
        .is_some_and(|text| is_hex_identifier(text, 64))
        && matches!(
            object.get("kind").and_then(Value::as_str),
            Some(
                "inventory" | "connect" | "read" | "reset" | "other" | "settlement" | "completion"
            )
        )
        && nullable_string_matches(object.get("receiver"), |text| {
            RECEIVER_PATTERN.is_match(text)
        })
        && nullable_string_matches(object.get("appId"), is_app_identifier)
        && nullable_string_matches(object.get("method"), |text| {
            matches!(
                text,
                "getAXState" | "getScreenshot" | "getAXStateAndScreenshot"
            )
        })
        && nullable_string_matches(object.get("recoveryToken"), |text| {
            is_hex_identifier(text, 32)
        })
        && (!object.contains_key("parentRecoveryToken")
            || object
                .get("parentRecoveryToken")
                .and_then(Value::as_str)
                .is_some_and(|text| is_hex_identifier(text, 32)))
        && nullable_string_matches(object.get("recoveryOutcome"), |text| {
            matches!(
                text,
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
        })
        && object.get("allowFallback").is_some_and(Value::is_boolean)
        && object.get("blocked").is_some_and(Value::is_boolean)
}

// Computer Use 훅 기록
pub fn observe_hook(
    input: &Value,
    data_directory: Option<&Path>,
    metadata: Option<CallMetadata>,
) -> Result<bool, String> {
    let Some(mut observation) = parse_hook(input)? else {
        return Ok(false);
    };
    if let Some(metadata) = metadata {
        let encoded = serde_json::to_value(&metadata).map_err(|error| error.to_string())?;
        if !is_call_metadata(&encoded) {
            return Err("Invocation metadata is invalid.".to_owned());
        }
        if matches!(
            metadata.recovery_outcome.as_deref(),
            Some("failed" | "fallback_failed")
        ) {
            observation.explicit_error = true;
        }
        observation.metadata = Some(metadata);
    }
    let directory = session_directory(data_directory, &observation.session_id)?;
    save_observation(&directory, &observation)
}

// 저장된 관측 이벤트 확인
fn is_observation(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("version").and_then(Value::as_f64) == Some(1.0)
        && matches!(
            object.get("event").and_then(Value::as_str),
            Some("PreToolUse" | "PostToolUse")
        )
        && is_identifier(object.get("sessionId"))
        && is_identifier(object.get("turnId"))
        && is_identifier(object.get("toolUseId"))
        && object
            .get("toolName")
            .and_then(Value::as_str)
            .is_some_and(is_computer_use_tool)
        && positive_json_number(object.get("observedAtMs")).is_some()
        && positive_json_number(object.get("uptimeMs")).is_some()
        && (!object.contains_key("monotonicMs")
            || positive_json_number(object.get("monotonicMs")).is_some())
        && (object.get("budgetMs") == Some(&Value::Null)
            || positive_json_number(object.get("budgetMs")).is_some())
        && object.get("explicitError").is_some_and(Value::is_boolean)
        && (!object.contains_key("metadata")
            || object.get("metadata").is_some_and(is_call_metadata))
}

// 관측 파일 이름 확인
fn is_observation_filename(value: &str) -> bool {
    value
        .strip_suffix(".PreToolUse.json")
        .or_else(|| value.strip_suffix(".PostToolUse.json"))
        .is_some_and(|key| is_hex_identifier(key, 64))
}

// 세션별 관측 이벤트 조회
pub fn read_session_events(
    data_directory: &Path,
    session_id: &str,
) -> Result<Vec<Observation>, String> {
    let directory = session_directory(Some(data_directory), session_id)?;
    let entries = match fs::read_dir(&directory) {
        Ok(files) => files,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut files = entries
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    files.sort();
    let mut events = Vec::new();
    for name in files {
        let Some(name) = name.to_str().filter(|name| is_observation_filename(name)) else {
            continue;
        };
        let bytes = fs::read(directory.join(name)).map_err(|error| error.to_string())?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if !is_observation(&value)
            || value.get("sessionId").and_then(Value::as_str) != Some(session_id)
        {
            return Err("Stored observation is invalid.".to_owned());
        }
        let event: Observation =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        let key = digest(&[
            &event.session_id,
            &event.turn_id,
            &event.tool_use_id,
            &event.tool_name,
        ])?;
        if name != format!("{key}.{}.json", event.event) {
            return Err("Stored observation identifier does not match.".to_owned());
        }
        events.push(event);
    }
    events.sort_by(|left, right| {
        left.observed_at_ms
            .total_cmp(&right.observed_at_ms)
            .then_with(|| match (left.event.as_str(), right.event.as_str()) {
                ("PreToolUse", "PostToolUse") => std::cmp::Ordering::Less,
                ("PostToolUse", "PreToolUse") => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            })
    });
    Ok(events)
}

// 시간 기준이 일치하는 관측의 경과시간 계산
fn elapsed_time(
    start: Option<&Observation>,
    end: Option<&Observation>,
    now: &ObservationClock,
) -> Option<f64> {
    let start = start?;
    let (finish_wall, finish_uptime, finish_monotonic) = end.map_or(
        (now.observed_at_ms, now.uptime_ms, now.monotonic_ms),
        |event| (event.observed_at_ms, event.uptime_ms, event.monotonic_ms),
    );
    let wall_duration = finish_wall - start.observed_at_ms;
    let precise = finish_monotonic.zip(start.monotonic_ms);
    let monotonic_duration = precise.map_or(finish_uptime - start.uptime_ms, |(finish, start)| {
        finish - start
    });
    if !wall_duration.is_finite()
        || !monotonic_duration.is_finite()
        || wall_duration < 0.0
        || monotonic_duration < 0.0
        || (wall_duration - monotonic_duration).abs() > 1000.0
    {
        return None;
    }
    Some(
        if precise.is_some() {
            monotonic_duration
        } else {
            wall_duration
        }
        .round(),
    )
}

// 호출의 관측 상태 계산
fn summarize_call(
    events: &[Observation],
    options: &ReadOptions,
    completions: &[(String, f64)],
) -> Result<CallObservation, String> {
    let reference = events
        .first()
        .ok_or_else(|| "Invocation observation is empty.".to_owned())?;
    let start = events.iter().find(|event| event.event == "PreToolUse");
    let end = events.iter().find(|event| event.event == "PostToolUse");
    let now = match &options.now {
        Some(now) => now.clone(),
        None => capture_clock()?,
    };
    let elapsed_ms = elapsed_time(start, end, &now);
    let delay_after_ms = start
        .and_then(|event| event.budget_ms)
        .or_else(|| positive_number(options.delay_after_ms));
    let ended = options
        .ended_turn_ids
        .as_ref()
        .is_some_and(|turns| turns.contains(&reference.turn_id))
        || start.is_some_and(|start| {
            completions
                .iter()
                .any(|(turn_id, time)| turn_id == &start.turn_id && *time >= start.observed_at_ms)
        });
    let status = if start
        .and_then(|event| event.metadata.as_ref())
        .is_some_and(|metadata| metadata.blocked)
    {
        "blocked"
    } else if let Some(end) = end {
        let outcome = end
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.recovery_outcome.as_deref());
        let needs_marker = start
            .and_then(|event| event.metadata.as_ref())
            .is_some_and(|metadata| metadata.recovery_token.is_some());
        if (needs_marker && outcome.is_none())
            || matches!(
                outcome,
                Some("wait_expired" | "native_pending" | "state_missing" | "host_wait_expired")
            )
        {
            "result_unknown"
        } else if end.explicit_error {
            "failed"
        } else {
            "returned"
        }
    } else if ended {
        "result_unknown"
    } else if elapsed_ms
        .zip(delay_after_ms)
        .is_some_and(|(elapsed, delay)| elapsed >= delay)
    {
        "delayed"
    } else {
        "pending"
    };
    Ok(CallObservation {
        session_id: reference.session_id.clone(),
        turn_id: reference.turn_id.clone(),
        tool_use_id: reference.tool_use_id.clone(),
        tool_name: reference.tool_name.clone(),
        status: status.to_owned(),
        start_observed: start.is_some(),
        return_observed: end.is_some(),
        elapsed_ms,
        delay_after_ms,
    })
}

// 세션별 호출 상태 조회
pub fn read_session_observations(
    data_directory: &Path,
    session_id: &str,
    options: &ReadOptions,
) -> Result<Vec<CallObservation>, String> {
    let events = read_session_events(data_directory, session_id)?;
    let completions: Vec<_> = events
        .iter()
        .filter(|event| {
            event.event == "PreToolUse"
                && event
                    .metadata
                    .as_ref()
                    .is_some_and(|metadata| metadata.kind == "completion")
        })
        .map(|event| (event.turn_id.clone(), event.observed_at_ms))
        .collect();
    let mut indices: HashMap<String, usize> = HashMap::new();
    let mut calls: Vec<Vec<Observation>> = Vec::new();
    for event in events {
        let key = digest(&[
            &event.session_id,
            &event.turn_id,
            &event.tool_use_id,
            &event.tool_name,
        ])?;
        if let Some(index) = indices.get(&key).copied() {
            calls[index].push(event);
        } else {
            indices.insert(key, calls.len());
            calls.push(vec![event]);
        }
    }
    calls
        .iter()
        .map(|events| summarize_call(events, options, &completions))
        .collect()
}
