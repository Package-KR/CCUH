# CCUH

CCUH (Codex Computer Use Helpers)는 Codex 데스크톱의 공식 Computer Use가 앱이나 브라우저를 조작할 때 작업 보호 지침을 연결합니다. 두 스킬은 올바른 작업 대상과 입력 경로를 확인하고, 오류가 나면 가능한 복구와 사용자 조치를 구분합니다.

## 설치

macOS의 Codex 데스크톱에서 공식 Computer Use를 활성화하고 Python 3.9 이상을 준비하세요. 아래 명령은 Codex CLI에서 실행합니다.

```sh
codex plugin marketplace add dijeungi/CCUH --ref release
codex plugin add ccuh@ccuh-preview
```

[릴리스 ZIP](https://github.com/dijeungi/CCUH/archive/refs/heads/release.zip)으로 설치하려면 압축을 푼 뒤 첫 명령의 GitHub 주소와 버전 옵션 대신 압축을 푼 폴더의 절대 경로를 넣으세요.

Codex의 **Settings → Hooks**에서 CCUH 훅을 검토하고 신뢰한 뒤 새 채팅을 시작하세요. 이후 평소처럼 공식 Computer Use로 작업을 요청하세요.

## 사용

- 기본 모드에서는 현재 환경이 지원하는 사용자 작업 보호 경로를 선택합니다.
- 작업 창을 보려면 요청에 “작업 중인 창도 보여줘”를 추가하세요. 창 표시와 백그라운드 입력은 대상 앱과 Codex 환경의 지원 범위에 따릅니다.
- 훅은 지원되는 호출 경로에서 작업 전에 스킬 지침을 연결합니다. 실제 조작과 권한 요청은 Codex의 공식 Computer Use가 처리합니다.

[Codex 플러그인 설치](https://developers.openai.com/plugins/build/plugins) | [훅 검토와 신뢰](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
