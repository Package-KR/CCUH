# Codex 앱 연결 확인

확인 날짜: 2026-10-31 KST. 현재 결과는 **앱 MCP 연결 성공, 실제 Computer Use의 호출 전 기록 확인, 최종 설정은 Pre=modified 및 Post=untrusted로 신뢰 승인 필요**다.

## 완료한 작업

- 사용자 설정 `~/.codex/config.toml`에 `mcp_servers.ccuh`를 추가했다.
- `~/.codex/hooks.json`의 PreToolUse와 PostToolUse에 CCUH command hook을 하나씩 추가했다.
- 기존 context-mode 훅은 원래 배열 위치와 정의를 유지했다. 기존 MCP 설정과 신뢰 기록도 변경하지 않았다.
- 변경 전 설정은 프로젝트의 비공개 `.ccuh/setup-backups/20261031-live/`에 보관했다. 이 폴더는 Git 추적 대상이 아니며 백업 파일은 소유자만 읽고 쓸 수 있다.
- Codex 설정 조회에서 CCUH가 enabled 상태로 등록된 것을 확인했다. 이는 현재 앱 세션의 MCP 연결 성공을 의미하지 않는다.
- 독립 SDK 클라이언트로 등록된 서버를 실행해 `ccuh_status`, `ccuh_recent_calls`, `ccuh_observe_event` 세 도구를 조회하고 상태 응답을 받았다. 이 확인은 실제 Codex 앱의 도구 호출과 구별한다.

## 실제 Computer Use 시험

설정 등록 후 `2026-10-31T14:11:12Z`에 Computer Use의 `cua.listApps({emit:false})`를 호출했다. 실행 중인 앱 개수만 반환했고 앱 입력이나 메시지 전송은 하지 않았다.

첫 시험 뒤에는 관측 이벤트가 0건이었다. 사용자가 앱을 완전히 종료하고 재시작한 다음 실제 대화에서 CCUH MCP 도구 세 개가 노출됐고 `ccuh_status` 호출에 서버가 응답했다.

재시작 후 `2026-10-31T14:16:29Z`에 실제 Computer Use의 `cua.getState()`를 호출했다. 결과는 정상 반환됐고 다음 자동 기록을 확인했다. 이 시험을 위해 MCP로 가짜 관측 이벤트를 제출하지 않았다.

| 항목 | 결과 |
| --- | --- |
| Computer Use 읽기 호출 | 정상 반환 |
| 실제 canonical tool name | `mcp__cua_repl__js` |
| 호출 전 기록 | source=hook, pre=1, target_info=opaque_code |
| 호출 후 기록 | post=0, pre_only |
| 현재 대화의 CCUH MCP 도구 노출 | 세 도구 노출과 상태 응답 성공 |
| 실제 앱과 창 선택 속도 개선 | 이번 시험 대상이 아님 |

짧게 실행한 공식 app-server의 읽기 전용 `hooks/list`에서도 상태를 확인했다. 당시 CCUH PreToolUse는 `trusted`, PostToolUse는 `untrusted`였고 둘 다 enabled=true, source=user였다. 훅 탐색 오류는 0개였다. 이를 통해 후처리 훅의 신뢰 승인이 빠진 것을 확인했다. 진단용 자식 프로세스는 종료했고, 데몬이나 새 대화와 모델 작업은 만들지 않았다.

## 사용자 화면에서 필요한 작업

사용자의 실제 앱에는 안내했던 MCP servers 메뉴가 없었다. 설정 파일로 등록한 뒤 **앱을 완전히 종료하고 재시작하는 방식**으로 MCP 연결을 확인했다. 해당 메뉴를 다시 찾도록 안내하지 않는다.

공식 문서상 새로운 비관리 훅은 정의별 신뢰 검토 전까지 건너뛴다. 문서에 명시된 검토 경로는 CLI의 `/hooks`이며, 현재 조사에서 앱 안의 동일한 승인 경로는 확인하지 못했다. MCP 재시작만으로 훅 신뢰 승인까지 완료됐다고 가정하지 않는다. 신뢰 검토를 위해 CLI를 한 번 사용하는 것은 앱 대신 CLI로 작업을 옮기는 것이 아니며, 두 클라이언트는 같은 사용자 설정을 공유한다.

실제 도구명을 확인한 뒤 CCUH의 두 matcher를 `^mcp__cua_repl__js$`로 좁혔다. 최종 설정은 전체 도구에 대한 임시 discovery 설정 대신 Computer Use 호출만 대상으로 한다. matcher 변경도 훅 정의 변경이므로 최종 설정의 두 훅을 다시 검토하고 신뢰 승인한 뒤 앱에 재적용해야 한다. 기존 앱 세션에 즉시 반영됐다고 가정하지 않는다. 신뢰 해시는 직접 수정하지 않았다.

### 최종 설정 재확인

사용자의 직접 확인 요청 후 실제 Computer Use를 다시 호출하고 공식 `hooks/list`로 최종 정의를 재검사했다.

- 최신 기록에는 Computer Use 호출이 3건 있으며 모두 pre=1, post=0인 `pre_only`다. 한 건은 Terminal 앱을 선택하려다 도구 정책상 거절된 호출이므로 성공한 앱 선택 사례로 세지 않는다.
- 최종 PreToolUse는 `modified`, enabled=true이며 이전에 저장된 신뢰 해시가 현재 정의와 일치하지 않는다.
- 최종 PostToolUse는 `untrusted`, enabled=true이며 일치하는 신뢰 승인이 없다.
- 실행 중인 앱 세션에서 관측된 이전 Pre 기록을 최종 정의의 승인이나 재적용 성공으로 해석하지 않는다.
- Computer Use는 `com.openai.codex`뿐 아니라 `com.apple.Terminal` 선택도 안전상의 이유로 거절했다. 따라서 승인 화면을 대신 클릭할 수 없었다. 다른 앱 이름이나 UI 자동화 기술로 이 제한을 우회하지 않았다.

MCP 서버 연결은 정상이며, 남은 차단 지점은 최종 두 훅의 공식 신뢰 검토다. 실제 Post 기록이나 전후 연결이 확인되기 전까지 라이브 훅 검증 완료로 표시하지 않는다.

Computer Use는 Codex 앱 `com.openai.codex` 조작을 안전상의 이유로 거절했다. 앱 화면 조작을 다른 기술로 우회하지 않았다. 공식 app-server proxy의 기본 제어 소켓도 존재하지 않아 현재 앱 세션을 그 경로로 갱신하지 못했다. 새 데몬을 시작하거나 신뢰 해시를 직접 기록하거나 신뢰 우회 옵션을 사용하지 않았다.

## 다음 검증

1. 최종 설정의 CCUH PreToolUse와 PostToolUse를 검토하고 신뢰 승인한다.
2. 앱을 재시작한 뒤 Computer Use로 앱 목록을 한 번 읽는다.
3. source=hook과 같은 세션 및 tool_use_id를 가진 pre/post 기록이 paired로 연결되는지 확인한다.
4. Computer Use 외의 도구 호출에는 CCUH 관측 기록이 늘지 않는지 확인한다.

## 공식 근거

- [MCP의 데스크톱 설정과 공유 설정](https://learn.chatgpt.com/docs/extend/mcp)
- [훅 신뢰 검토와 지원되는 도구 경로](https://learn.chatgpt.com/docs/hooks)
- [App-server의 MCP 재적용 인터페이스](https://learn.chatgpt.com/docs/app-server)
