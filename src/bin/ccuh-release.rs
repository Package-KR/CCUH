use std::env;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Output};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

struct Document {
    path: PathBuf,
    content: String,
    version_range: Option<Range<usize>>,
}

struct Metadata {
    version: Version,
    documents: Vec<Document>,
}

static VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z")
        .expect("The static version pattern must be valid.")
});
static TABLE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^[\t ]*(\[\[[^\]\r\n]+\]\]|\[[^\]\r\n]+\])[\t ]*(?:#[^\r\n]*)?\r?$")
        .expect("The static TOML table pattern must be valid.")
});
static LOCK_SOURCE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^[\t ]*source[\t ]*=").expect("The static Cargo source pattern must be valid.")
});
static BREAKING_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A[A-Za-z][A-Za-z0-9_-]*(?:\([^()\r\n]+\))?!:")
        .expect("The static breaking-commit pattern must be valid.")
});
static BREAKING_FOOTER_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^BREAKING(?: CHANGE|-CHANGE):")
        .expect("The static breaking-footer pattern must be valid.")
});
static FEATURE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\Afeat(?:\([^()\r\n]+\))?:")
        .expect("The static feature-commit pattern must be valid.")
});
static RELEASE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\Achore: release v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*) \[skip ci\]\z",
    )
    .expect("The static release-commit pattern must be valid.")
});
static PLUGIN_VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:\{|,)[\t\r\n ]*"version"[\t\r\n ]*:[\t\r\n ]*"([^"\\]*)""#)
        .expect("The static plugin-version pattern must be valid.")
});

// 버전 구성 숫자 조회
fn version_component(captures: &regex::Captures<'_>, index: usize) -> Result<u64, String> {
    captures
        .get(index)
        .ok_or_else(|| "A version component is missing.".to_owned())?
        .as_str()
        .parse::<u64>()
        .map_err(|_| "A version component is too large.".to_owned())
}

impl Version {
    // 안정 버전 문자열 확인
    fn parse(value: &str) -> Result<Self, String> {
        let captures = VERSION_PATTERN
            .captures(value)
            .ok_or_else(|| format!("A stable MAJOR.MINOR.PATCH version is required: {value}"))?;
        Ok(Self {
            major: version_component(&captures, 1)?,
            minor: version_component(&captures, 2)?,
            patch: version_component(&captures, 3)?,
        })
    }

    // 선택한 범위의 버전 증가
    fn increment(self, bump: &str) -> Result<Self, String> {
        match bump {
            "major" => Ok(Self {
                major: self
                    .major
                    .checked_add(1)
                    .ok_or("The version increment exceeds the supported range.")?,
                minor: 0,
                patch: 0,
            }),
            "minor" => Ok(Self {
                major: self.major,
                minor: self
                    .minor
                    .checked_add(1)
                    .ok_or("The version increment exceeds the supported range.")?,
                patch: 0,
            }),
            "patch" => Ok(Self {
                major: self.major,
                minor: self.minor,
                patch: self
                    .patch
                    .checked_add(1)
                    .ok_or("The version increment exceeds the supported range.")?,
            }),
            _ => Err("The version increment must be patch, minor, or major.".to_owned()),
        }
    }
}

impl fmt::Display for Version {
    // 안정 버전 문자열 표시
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

// TOML 패키지 테이블의 문자열 필드 조회
fn toml_field(
    content: &str,
    section: Range<usize>,
    name: &str,
) -> Result<(String, Range<usize>), String> {
    let pattern = Regex::new(&format!(
        r#"(?m)^[\t ]*{}[\t ]*=[\t ]*(['"])([^'"\r\n]*)(['"])[\t ]*(?:#[^\r\n]*)?\r?$"#,
        regex::escape(name),
    ))
    .map_err(|error| error.to_string())?;
    let values: Vec<_> = pattern.captures_iter(&content[section.clone()]).collect();
    if values.len() != 1 {
        return Err(format!(
            "Exactly one literal {name} field is required in the package table."
        ));
    }
    let value = &values[0];
    if value.get(1).map(|capture| capture.as_str()) != value.get(3).map(|capture| capture.as_str())
    {
        return Err(format!("The package {name} field has mismatched quotes."));
    }
    let matched = value
        .get(2)
        .ok_or_else(|| format!("The package {name} field is missing."))?;
    Ok((
        matched.as_str().to_owned(),
        section.start + matched.start()..section.start + matched.end(),
    ))
}

// Cargo 루트 패키지 버전 위치 조회
fn cargo_version(content: &str, lockfile: bool) -> Result<(Version, Range<usize>), String> {
    let headers: Vec<_> = TABLE_PATTERN.captures_iter(content).collect();
    let expected = if lockfile { "[[package]]" } else { "[package]" };
    let mut versions = Vec::new();

    for (index, header) in headers.iter().enumerate() {
        if header.get(1).map(|capture| capture.as_str()) != Some(expected) {
            continue;
        }
        let start = header
            .get(0)
            .ok_or_else(|| "The Cargo package table is missing.".to_owned())?
            .end();
        let end = headers
            .get(index + 1)
            .and_then(|next| next.get(0))
            .map_or(content.len(), |next| next.start());
        let section = start..end;
        if lockfile && LOCK_SOURCE_PATTERN.is_match(&content[section.clone()]) {
            continue;
        }
        let (name, _) = toml_field(content, section.clone(), "name")?;
        if name != "ccuh" {
            continue;
        }
        let (version, range) = toml_field(content, section, "version")?;
        versions.push((Version::parse(&version)?, range));
    }

    if versions.len() != 1 {
        return Err("Exactly one local ccuh package is required in Cargo metadata.".to_owned());
    }
    versions
        .pop()
        .ok_or_else(|| "The local ccuh package version is missing.".to_owned())
}

// 버전 원본 파일 조회
fn read_document(root: &Path, name: &str) -> Result<Document, String> {
    let path = root.join(name);
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    Ok(Document {
        path,
        content,
        version_range: None,
    })
}

// 플러그인 버전 값과 원본 위치 조회
fn plugin_version(content: &str) -> Result<(Version, Range<usize>), String> {
    let plugin: Value = serde_json::from_str(content)
        .map_err(|error| format!("Cannot read plugin metadata: {error}"))?;
    if plugin.get("name").and_then(Value::as_str) != Some("ccuh") {
        return Err("The plugin metadata must belong to ccuh.".to_owned());
    }
    let version = Version::parse(
        plugin
            .get("version")
            .and_then(Value::as_str)
            .ok_or_else(|| "The plugin version is missing.".to_owned())?,
    )?;
    let matches: Vec<_> = PLUGIN_VERSION_PATTERN.captures_iter(content).collect();
    if matches.len() != 1 {
        return Err("Exactly one literal plugin version field is required.".to_owned());
    }
    let matched = matches[0]
        .get(1)
        .ok_or_else(|| "The plugin version field is missing.".to_owned())?;
    if matched.as_str() != version.to_string() {
        return Err("The plugin version must be an unescaped stable version.".to_owned());
    }
    Ok((version, matched.range()))
}

// Cargo와 플러그인의 버전 일치 확인
fn metadata(root: &Path) -> Result<Metadata, String> {
    let mut manifest = read_document(root, "Cargo.toml")?;
    let mut lockfile = read_document(root, "Cargo.lock")?;
    let mut plugin_file = read_document(root, ".codex-plugin/plugin.json")?;
    let (version, manifest_range) = cargo_version(&manifest.content, false)?;
    let (locked_version, lock_range) = cargo_version(&lockfile.content, true)?;
    let (plugin_version, plugin_range) = plugin_version(&plugin_file.content)?;
    if version != locked_version || version != plugin_version {
        return Err(
            "Cargo.toml, Cargo.lock, and plugin.json must have the same version.".to_owned(),
        );
    }
    manifest.version_range = Some(manifest_range);
    lockfile.version_range = Some(lock_range);
    plugin_file.version_range = Some(plugin_range);
    Ok(Metadata {
        version,
        documents: vec![manifest, lockfile, plugin_file],
    })
}

// 로컬 Git 조회 실행
fn git(root: &Path, arguments: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(arguments)
        .current_dir(root)
        .output()
        .map_err(|error| format!("Cannot query Git history: {error}"))
}

// Git 조회 결과 확인
fn git_text(root: &Path, arguments: &[&str]) -> Result<String, String> {
    let output = git(root, arguments)?;
    if !output.status.success() {
        return Err(format!(
            "Cannot query Git history: {}",
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    String::from_utf8(output.stdout).map_err(|_| "Git history is not valid UTF-8.".to_owned())
}

// 현재 버전 태그 이후 커밋 조회
fn release_commits(root: &Path, version: Version) -> Result<String, String> {
    git_text(root, &["rev-parse", "--is-inside-work-tree"])?;
    let reference = format!("refs/tags/v{version}");
    let exists = git(root, &["show-ref", "--verify", "--quiet", &reference])?;
    let range = if exists.status.success() {
        let base = git_text(
            root,
            &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
        )?;
        let base = base.trim();
        if !git(root, &["merge-base", "--is-ancestor", base, "HEAD"])?
            .status
            .success()
        {
            return Err("The current version tag is not an ancestor of HEAD.".to_owned());
        }
        format!("{base}..HEAD")
    } else if exists.status.code() == Some(1) {
        "HEAD".to_owned()
    } else {
        return Err("Cannot determine whether the current version tag exists.".to_owned());
    };
    git_text(
        root,
        &["log", "--no-show-signature", "--format=%B%x00", &range],
    )
}

// 전체 변경에서 가장 큰 버전 증가 선택
fn detect_bump(root: &Path, version: Version, requested: &str) -> Result<&'static str, String> {
    match requested {
        "patch" => return Ok("patch"),
        "minor" => return Ok("minor"),
        "major" => return Ok("major"),
        "auto" => {}
        _ => return Err("The increment must be auto, patch, minor, or major.".to_owned()),
    }
    let commits = release_commits(root, version)?;
    let mut selected = "patch";
    for message in commits.split('\0') {
        let message = message.trim();
        let subject = message.lines().next().unwrap_or_default();
        if RELEASE_PATTERN.is_match(subject) {
            continue;
        }
        if BREAKING_PATTERN.is_match(subject) || BREAKING_FOOTER_PATTERN.is_match(message) {
            return Ok("major");
        }
        if FEATURE_PATTERN.is_match(subject) {
            selected = "minor";
        }
    }
    Ok(selected)
}

// 같은 폴더에 버전 수정 임시 파일 준비
fn stage_document(document: &Document, content: &str, index: usize) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let name = document
        .path
        .file_name()
        .ok_or_else(|| "The version file name is missing.".to_owned())?
        .to_string_lossy();
    let temporary = document.path.with_file_name(format!(
        ".{name}.ccuh-release-{}-{stamp}-{index}",
        process::id(),
    ));
    if let Err(error) = write_staged(document, &temporary, content) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot stage {}: {error}", document.path.display()));
    }
    Ok(temporary)
}

// 임시 버전 파일 내용과 권한 기록
fn write_staged(document: &Document, temporary: &Path, content: &str) -> Result<(), String> {
    let permissions = fs::metadata(&document.path)
        .map_err(|error| error.to_string())?
        .permissions();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .map_err(|error| error.to_string())?;
    file.set_permissions(permissions)
        .map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

// 준비한 버전 파일 정리
fn remove_staged(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

// 교체한 버전 원본 복원
fn restore_document(document: &Document, index: usize) -> Result<(), String> {
    let temporary = stage_document(document, &document.content, index)?;
    if let Err(error) = fs::rename(&temporary, &document.path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

// 버전 파일 교체와 실패 시 원본 복원
fn replace_documents(documents: &[Document], contents: &[String]) -> Result<(), String> {
    if documents.len() != contents.len() {
        return Err("Every version document must have replacement content.".to_owned());
    }
    let mut staged = Vec::new();
    for (index, (document, content)) in documents.iter().zip(contents).enumerate() {
        match fs::read_to_string(&document.path) {
            Ok(current) if current == document.content => {}
            _ => {
                remove_staged(&staged);
                return Err("Version metadata changed while preparing the increment.".to_owned());
            }
        }
        match stage_document(document, content, index) {
            Ok(path) => staged.push(path),
            Err(error) => {
                remove_staged(&staged);
                return Err(error);
            }
        }
    }

    for (index, temporary) in staged.iter().enumerate() {
        if let Err(error) = fs::rename(temporary, &documents[index].path) {
            let mut rollback_errors = Vec::new();
            for document in &documents[..index] {
                if let Err(failure) = restore_document(document, index) {
                    rollback_errors.push(failure);
                }
            }
            remove_staged(&staged[index..]);
            return Err(format!(
                "Cannot replace version metadata: {error}. Rollback errors: {}",
                rollback_errors.join("; "),
            ));
        }
    }
    Ok(())
}

// 모든 버전 메타데이터 갱신
fn bump_version(root: &Path, selected: &str) -> Result<Version, String> {
    let metadata = metadata(root)?;
    let next = metadata.version.increment(selected)?;
    let mut contents = Vec::new();
    for document in &metadata.documents {
        let range = document
            .version_range
            .clone()
            .ok_or_else(|| "A version field location is missing.".to_owned())?;
        let mut content = document.content.clone();
        content.replace_range(range, &next.to_string());
        contents.push(content);
    }
    replace_documents(&metadata.documents, &contents)?;
    Ok(next)
}

// 릴리스 메타데이터 명령 실행
fn run() -> Result<(), String> {
    let arguments: Vec<_> = env::args().skip(1).collect();
    let root = env::current_dir().map_err(|error| error.to_string())?;
    match arguments.as_slice() {
        [command] if command == "check" => println!("{}", metadata(&root)?.version),
        [command] if command == "detect" => {
            println!("{}", detect_bump(&root, metadata(&root)?.version, "auto")?);
        }
        [command, requested] if command == "detect" => {
            println!(
                "{}",
                detect_bump(&root, metadata(&root)?.version, requested)?
            );
        }
        [command, selected] if command == "bump" => println!("{}", bump_version(&root, selected)?),
        _ => return Err(
            "Usage: ccuh-release check | detect [auto|patch|minor|major] | bump patch|minor|major"
                .to_owned(),
        ),
    }
    Ok(())
}

// 릴리스 명령 오류 반환
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}
