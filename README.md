# CCUH

**Codex Computer Use Helper**

A companion skill for Codex Computer Use that helps locate UI targets, verify actions, and recover from failures with fewer retries and less waiting.

CCUH는 macOS에서 Codex가 원하는 앱과 창을 작업 대상으로 확보하는 과정을 개선하기 위한 프로젝트다. 우선 측정하는 구간은 앱 선택 요청부터 정확한 창의 첫 관측까지다.

현재 버전은 **M1 관측 골격**이다. MCP 연결, Codex 호출 전후 기록과 진단을 구현했다. 실제 앱 선택과 창 활성화, 기존 Computer Use의 창 연결 제어는 아직 구현하지 않았다. 속도 개선 수치도 아직 측정하지 않았다.

## M1에 들어 있는 것

| 구성          | 기능                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| 로컬 MCP 서버 | 공식 MCP TypeScript SDK의 stdio 서버와 진단 도구                           |
| Codex 관측 훅 | 호출 전후 메타데이터를 로컬 JSONL에 기록                                   |
| 호출 연결     | 같은 출처, 세션과 tool_use_id로 전후 이벤트 연결                           |
| 진단 CLI      | 기록과 설정 예시 확인. 파일을 전역 설정에 자동 적용하지 않음               |
| CCUH 스킬     | macOS 앱과 창 확보에 집중하는 보조 지침                                    |
| 테스트        | 기록의 정보 최소화, 호출 연결, 훅 실패 처리, 실제 SDK 클라이언트 연결 검사 |

## 실행 환경

- macOS
- Node.js 24 이상
- npm

Node.js의 TypeScript 실행 기능을 사용하므로 별도의 빌드 단계는 없다. Node는 실행할 때 타입을 검사하지 않으므로, `npm run typecheck`로 소스와 테스트의 타입을 별도로 검사한다. `tsconfig.json`은 편집기와 타입 검사에 사용하며 Node 전역과 `node:*` 모듈은 개발 의존성인 `@types/node`로 인식한다.

패키지는 로컬 프로젝트에 설치한다.

```bash
npm install
npm run typecheck
npm test
```

M1은 OpenAI API를 호출하지 않으며 API 키가 필요하지 않다. 설치된 Computer Use를 대체하지도 않는다.

## 먼저 상태 보기

```bash
npm run status
npm run recent
```

이 CLI는 저장된 기록을 읽는다. `status`를 실행하는 것만으로 MCP 연결이나 Codex의 자동 훅 실행이 확인되는 것은 아니다. 기록이 없을 때도 실패 원인을 단정하지 않고 `no_records`로 표시한다.

`npm start`는 MCP 클라이언트가 stdio로 연결할 서버를 실행한다. 일반적인 안내를 stdout으로 출력하지 않으며, 입력을 기다리는 동작이 정상이다. 서버 연결 검증은 `npm run test:mcp`로 수행할 수 있다.

## MCP 도구

| 이름                 | 역할                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `ccuh_status`        | MCP 응답, 기록 출처, Computer Use로 추정되는 도구 이름과 미구현 상태 확인 |
| `ccuh_recent_calls`  | 최근 호출의 전후 기록, 불완전한 연결, 관측 시간 확인                      |
| `ccuh_observe_event` | Codex 이벤트에서 허용된 메타데이터만 추출해 기록                          |

`ccuh_observe_event`의 기록 성공은 자동 훅이 실행됐다는 증명이 아니다. 일반 MCP 호출이나 수동 제출로도 기록을 만들 수 있다. Command hook 기록은 `source=hook`, MCP 도구로 받은 기록은 `source=mcp`, 테스트 모드는 `source=synthetic`으로 구분한다.

진단에서 `evidence.hook_records`는 command hook 출처만 센다. 네이티브 MCP tool hook 예시로 기록하면 `mcp_event_records`에서 확인한다. 합성 기록은 실제 호출 후보의 증거에 포함하지 않는다.

## Codex 연결을 위한 설정 출력

**이 저장소를 만든 것만으로 전역 MCP나 훅이 설치되지는 않는다.** 다음 명령은 현재 Node 실행 파일과 프로젝트 경로를 반영한 텍스트를 stdout으로 출력한다.

```bash
node src/cli.ts config mcp
node src/cli.ts config hooks-discovery
```

출력을 검토한 뒤 사용 중인 Codex 설정에 병합한다.

- MCP 설정은 기존 `config.toml`의 다른 서버 설정을 유지하면서 추가한다.
- 훅은 기존 `hooks.json`의 해당 이벤트 배열에 추가한다.
- context-mode 등 이미 작동 중인 훅을 덮어쓰거나 삭제하지 않는다.
- Codex의 훅 지원, 신뢰 승인과 실제 이벤트 발생 여부는 사용 중인 런타임에서 확인해야 한다.
- 이 프로젝트에는 전역 설정을 자동 변경하는 설치 프로그램을 넣지 않았다.

직접 병합하기 전 참고할 정적 예시는 [MCP 설정](configs/codex/mcp.example.toml)과 [관측 훅 설정](configs/codex/hooks.example.json)에 있다. 예시의 절대경로는 그대로 사용할 수 없으므로, 가능하면 위 CLI로 실제 경로가 반영된 출력을 얻는다.

### 첫 연결은 짧은 discovery 관측

`hooks-discovery`는 `matcher: "*"`를 사용해 실제로 들어오는 도구 이름과 입력의 형태를 관찰한다. 아직 모르는 Computer Use 도구 이름을 추측해서 고정하지 않기 위한 임시 진단 방식이다.

여러 도구 호출마다 Node 프로세스와 기록 I/O가 추가되므로 상시 속도 개선 설정으로 사용하면 안 된다. 몇 번의 무해한 앱 관측을 통해 실제 도구 이름을 확인한 뒤, 해당 이름만 대상으로 좁힌다.

```bash
node src/cli.ts config hooks-targeted mcp__cua_repl__js
```

위 도구 이름은 예시다. **실제 관측한 canonical tool name으로 바꿔야 한다.** 일부 특수 도구 경로는 훅을 내보내지 않을 수 있다. 연결된 MCP가 응답하는 것과 Computer Use 호출이 훅에 들어오는 것은 별도의 검증이다.

### MCP를 훅에서 직접 호출하는 대안

Codex가 네이티브 `mcp_tool` 훅을 지원하고 CCUH 서버가 이미 연결돼 있다면 [MCP tool hook 예시](configs/codex/hooks.mcp.example.json)도 검토할 수 있다.

이 예시도 도구 이름은 검증 전 가정이다. 입력과 응답 본문을 전달하지 않고 이벤트 ID와 도구명만 보내므로 `target_info`는 `none`, 도구 자체 오류 여부는 미확인일 수 있다. 자동 트리거 여부를 확인하는 최소 연결 시험용이다.

동일한 호출에 command hook과 MCP tool hook을 동시에 적용하면 중복 관측이 생긴다. 처음에는 한 경로를 선택해 검증한다. 훅에서 호출한 MCP는 현재 Codex 문서상 재귀적으로 다른 훅을 발생시키지 않지만, 실제 호스트 지원 여부를 먼저 확인한다.

## 기록에 남기는 정보

기본 위치는 프로젝트의 `.ccuh/events.jsonl`이다. 이 경로는 호출자의 현재 디렉터리에 따라 달라지지 않는다. `CCUH_STATE_DIR`로 절대경로를 지정할 수 있다.

- 단계, 관측 시각과 도구 이름
- SHA-256으로 변환한 세션, 호출과 선택적 turn 식별자
- 허용된 입력 필드의 이름과 자료형
- 코드가 있으면 길이만 기록
- 도구명 기반 Computer Use 후보 여부
- 직접 대상 필드가 있는지, 코드 안에 숨겨져 있는지, 정보가 없는지
- 응답에 명시된 도구 오류 신호가 있는지

코드 원문, URL 값, 앱과 창 이름 값, 대화 내용, 입력 인자 값, 스크린샷, 응답 본문, 인증값과 원본 식별자는 기록하지 않는다. 필드 이름도 허용 목록 밖의 이름은 버리고 개수만 센다.

Command hook 입력은 최대 1 MiB까지 처리한다. 기록 파일은 읽을 때 마지막 5 MiB와 10,000개 완전한 이벤트로 제한한다. 기존 기록을 자동으로 삭제하거나 회전시키지는 않으므로 장기 사용 전 보관 정책을 별도로 정해야 한다.

## 진단 결과를 읽는 방법

| 결과                                     | 의미                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `mcp_connection=responding`              | 실제 MCP 도구 호출에 서버가 응답함                                                       |
| CLI의 `not_tested_by_cli`                | 파일 진단만 했고 MCP 연결 시험은 하지 않음                                               |
| `local_records_observed`                 | 해당 출처의 로컬 기록이 존재함                                                           |
| `candidate_names_observed`               | 알려진 이름 패턴에 맞는 도구가 관측됨                                                    |
| `opaque_code`                            | 대상 정보가 별도 필드 없이 코드 문자열에 포함될 수 있음. 코드는 해석하거나 실행하지 않음 |
| `explicit_fields`                        | 대상 관련 필드가 있음. 값의 정확성이나 실제 창 선택 성공을 뜻하지 않음                   |
| `paired`                                 | 전후 기록을 같은 세션과 호출로 연결함                                                    |
| `pre_only` / `post_only`                 | 이 읽기 범위에서 한쪽 기록만 존재함                                                      |
| `duplicate_events` / `identity_mismatch` | 중복 또는 서로 충돌하는 관측이 있어 유효한 시간을 확정하지 않음                          |
| `native_app_selection=not_implemented`   | 실제 Mac 앱과 창을 선택하는 기능은 없음                                                  |
| `computer_use_binding=not_verified`      | 기존 Computer Use와 같은 창을 잡는지 확인하지 않음                                       |

`observed_span_ms`는 훅 기록 시각의 차이다. 훅, 프로세스와 저장소 비용이 섞이며 실제 앱 선택 시간이나 사용자 요청 전체 처리 시간이 아니다. 기록이 없다는 사실만으로 훅이 전혀 실행되지 않았다고 확정하지 않는다. 지원되지 않는 이벤트 형태, 누락된 ID, 입력 크기 제한, 저장 실패나 읽기 범위 제한도 확인해야 한다.

관측 훅은 Codex의 실행 인자를 변경하거나 승인 결정을 내리지 않는다. 잘못된 입력과 기록 오류는 원문을 노출하지 않는 고정 진단만 stderr에 남기거나 무시하고, 관측 대상 작업을 차단하지 않는 방식으로 처리한다.

## 현재 검증 범위

`npm test`는 외부 서비스나 실제 앱을 조작하지 않는다.

- 세션과 호출 ID의 올바른 연결
- 중복, 불완전한 기록과 시계 역행 처리
- 입력과 응답의 민감한 원문이 파일에 남지 않는지
- 합성 이벤트와 MCP 제출을 command hook 증거와 구별하는지
- 훅 stdout을 비우고 오류 시에도 작업을 차단하지 않는지
- 공식 SDK 클라이언트로 실제 stdio 초기화와 도구 조회, 기록과 진단까지 되는지

실제 Codex 앱을 재시작한 뒤 CCUH MCP 연결과 Computer Use의 호출 전 자동 기록을 확인했다. 공식 진단에서 호출 후 훅은 신뢰 승인 대기로 확인돼, 전후 기록 연결은 아직 검증하지 못했다. 실제 도구명에 맞춰 관측 범위를 좁혔으며 최종 설정의 두 훅은 신뢰 승인과 재적용이 필요하다. [실제 연결 확인 기록](LIVE_CONNECTION.md)에 결과와 남은 절차를 정리했다.

**Mac 앱 선택**, **창 활성화**, **기존 도구의 대상 바인딩**, **속도 개선**은 아직 검증하지 않았다. 라이브 시험은 무해한 읽기 관측으로 진행하고 실제 메시지는 전송하지 않는다.

## 다음 단계

1. 현재 Codex 호스트에서 실제 Computer Use 도구 이름과 훅 발생 여부 확인
2. 앱과 창 정보를 기존 도구에서 전달받을 수 있는지 확인
3. OS에서 선택한 창과 Computer Use가 읽은 창의 동일성 확인 방법 결정
4. 기존 도구만 쓴 경우와 CCUH를 붙인 경우의 전체 대상 확보 시간 비교
5. 필요성이 확인되면 macOS 네이티브 앱과 창 선택 헬퍼 구현

## 근거 문서

- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [OpenAI Skills](https://developers.openai.com/plugins/concepts/skills)
- [참고한 context-mode의 Codex 연동](https://github.com/mksglu/context-mode#codex-cli--mcp--hooks)
