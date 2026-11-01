<div align="center">

<h1>CCUH</h1>
<p><strong>Codex Computer Use Helper</strong></p>
<p>A macOS companion for reliable app and window targeting in Codex Computer Use.</p>

<p><a href="./README.md">English</a> | <a href="./README.ko.md">한국어</a></p>

</div>

> [!WARNING]
> **현재 개발 중입니다.**

## The Problem

Computer Use에 작업을 맡긴 동안에도 사용자는 컴퓨터를 평소처럼 이용할 수 있어야 합니다. 작업 대상인 앱과 창을 제대로 인식하지 못하면 다음과 같은 문제가 발생할 수 있습니다.

- 선택한 앱과 실제로 관측하는 창이 일치하지 않습니다.
- 사용자가 창을 전환하면 Computer Use의 작업 대상이 어긋납니다.
- 대상을 찾지 못한 상태에서도 사용자에게 알리지 않고 같은 시도를 반복합니다.

**CCUH는 사용자가 컴퓨터를 계속 사용하면서도 Computer Use에 작업을 안정적으로 맡길 수 있도록 만드는 프로젝트입니다.** 원하는 앱과 창을 정확히 확인하고, 문제가 발생하면 즉시 알리며, 대상을 다시 확인한 뒤 작업을 이어갈 수 있도록 하는 것을 목표로 합니다.

## How It Works

CCUH 플러그인은 로컬 MCP 서버, Codex 훅, 보조 스킬을 함께 제공합니다.

1. **호출 기록 수집** — 훅이 Computer Use 호출 전후의 시각과 메타데이터를 기록합니다.
2. **전후 기록 연결** — 세션과 호출 식별자를 기준으로 같은 호출의 전후 기록을 연결합니다.
3. **Codex에서 조회** — MCP 도구를 통해 연결 상태와 최근 호출 기록을 확인할 수 있습니다.
4. **작업 지침 제공** — 포함된 스킬이 대상 앱과 창을 확인하고 실패를 알리는 기준을 안내합니다.

진단 도구는 MCP가 제공하며, 호출 시점의 자동 실행은 훅이 담당합니다. Codex App과 CLI는 같은 사용자 설정을 공유하고, CCUH는 Mac에서 Node 프로세스로 실행됩니다.

CCUH 훅과 보조 스킬은 기본 Computer Use를 사용하는 작업에만 적용됩니다. 일반 코딩, 터미널 명령, 웹 검색과 다른 MCP 도구 호출은 관측하지 않습니다. Codex가 MCP 연결을 미리 유지하더라도 창 제어나 배경 감시가 시작되지는 않습니다.

## Get Started

**macOS, Node.js 24 이상, Computer Use를 사용할 수 있는 Codex App 또는 Codex CLI**가 필요합니다. Codex 프로세스에서 Node.js를 실행할 수 있어야 합니다. CCUH는 Node.js를 포함하지 않으며 Mac에 설치된 Node.js를 사용합니다.

### 1. 마켓플레이스 추가

```bash
codex plugin marketplace add Package-KR/CCUH
```

### 2. 플러그인 설치

Codex App의 **Plugins** 또는 Codex CLI의 `/plugins`에서 `ccuh` 마켓플레이스의 **CCUH**를 찾아 설치합니다.

MCP 서버, Computer Use 훅, 보조 스킬이 함께 제공됩니다. MCP 서버 설정이나 사용자 훅 설정 파일을 직접 편집할 필요가 없습니다.

### 3. 훅 검토와 재시작

Codex가 훅 검토를 요청하면 사용 중인 클라이언트에서 CCUH 훅을 검토하고 신뢰 승인합니다. Codex CLI에서는 `/hooks`를 사용합니다.

사용 중인 Codex App 또는 Codex CLI 세션을 재시작합니다. 이후 Computer Use 작업에서 CCUH를 함께 사용합니다.

<details>
<summary>수동 등록 대안</summary>

등록 방식은 하나만 사용합니다. 기본 플러그인과 수동 등록을 동시에 활성화하지 않습니다.

플러그인 방식을 사용할 수 없다면 다음 명령을 실행합니다.

```bash
npx --yes github:Package-KR/CCUH setup
```

이 명령은 기본 경로인 `~/.codex/ccuh/runtime`에 로컬 실행 환경을 설치하고 MCP 서버와 Computer Use 훅을 등록합니다. 기존 설정은 유지하며 변경 전에 백업합니다.

Codex가 요청하면 CCUH 훅을 검토합니다. Codex CLI에서는 `/hooks`를 사용하며, 검토 후 사용 중인 Codex App 또는 Codex CLI 세션을 재시작합니다.

</details>

## Usage

사용 중인 Codex App 또는 Codex CLI에서 다음과 같이 요청할 수 있습니다.

> Computer Use로 요청한 앱 작업을 진행하면서 CCUH로 대상 창을 확인하고, 잘못 연결되면 알려 주세요.

| 도구 | 용도 |
| --- | --- |
| `ccuh_status` | MCP 응답과 기록 수집 상태 확인 |
| `ccuh_recent_calls` | 최근 호출의 전후 기록과 연결 결과 조회 |

MCP 연결과 자동 기록은 별도로 동작합니다. `paired`는 전후 기록이 연결된 상태이며, `pre_only`와 `post_only`는 한쪽 기록만 존재하는 상태를 의미합니다.

## Updates

`main`에 변경 사항이 반영되면 GitHub Actions가 빌드를 검증하고, `github-actions[bot]`이 다음 패치 버전과 버전 커밋, 태그, GitHub Release를 발행합니다. 사용자가 개발 소스를 받거나 다시 빌드할 필요는 없습니다.

마켓플레이스와 설치된 플러그인의 갱신은 Codex가 담당합니다. CCUH는 별도의 상주 업데이트 프로그램을 추가하거나 설치 캐시를 직접 수정하지 않습니다. 새 버전이 보이지 않을 때는 마켓플레이스를 갱신합니다.

```bash
codex plugin marketplace upgrade ccuh
```

훅이 변경되면 Codex가 신뢰 검토를 요청할 수 있습니다. 갱신 후에도 이전 버전을 사용하는 경우 새 대화를 시작하거나 앱을 재시작합니다.

<details>
<summary>배포 관리</summary>

`dev`에서 개발하고 검토한 변경을 `main`에 병합합니다. **CI**는 `dev` 푸시와 `dev` 또는 `main` 대상 PR에서 타입 검사, 런타임 빌드와 네이티브 Swift 소스 검사를 수행합니다. **Release**도 `main`에서 배포하기 전에 같은 CI 워크플로를 호출합니다.

**Release** 워크플로는 공통 CI가 성공한 뒤 검증된 커밋을 그대로 사용합니다. 패키지, 잠금 파일, 플러그인 매니페스트와 런타임의 버전을 함께 올리고 다시 빌드한 뒤 저장소의 `GITHUB_TOKEN`으로 배포하므로 GitHub Actions가 `main`과 릴리스 태그에 쓸 수 있어야 합니다.

마이너 또는 메이저 버전은 **Actions → Release → Run workflow**에서 `bump`를 선택합니다. 버전 커밋과 태그 생성 후 GitHub Release 발행만 실패했다면 실패한 publish 작업을 다시 실행하거나, `repair_tag`에 기존 태그를 입력합니다. 이때는 버전을 추가로 올리지 않습니다.

동시에 들어온 푸시는 한 릴리스에 묶일 수 있습니다. CI가 최신 `main`을 검사하고 릴리스는 그 검증된 커밋을 사용합니다. 브랜치에 다른 변경이 들어와 충돌하면 강제 푸시 없이 배포를 중단합니다.

</details>

## Data

기록은 기본적으로 `~/.codex/ccuh/state/events.jsonl`에 저장됩니다. 시각, 도구명, 해시 처리한 식별자 등 메타데이터만 남기며, 코드 원문과 대화 내용, 스크린샷, 인증값은 저장하지 않습니다.

수집 대상은 `mcp__cua_repl__js`와 `mcp__cua_repl__js_reset`으로 제한합니다. 알 수 없는 도구명은 제외하며, 기존 기록 파일은 삭제하지 않고 이 범위 밖의 항목만 조회에서 제외합니다.

전후 기록의 시간 차이에는 훅 실행과 파일 저장 시간이 포함됩니다. 앱과 창 선택 속도를 비교하는 벤치마크로 사용하기에는 적합하지 않습니다.

## License

CCUH는 [MIT 라이선스](LICENSE)를 따릅니다.
