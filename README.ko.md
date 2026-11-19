# CCUH

[English](README.md)

CCUH(Codex Computer Use Helpers)는 Codex가 Computer Use 작업을 시작하기 전에 대상과 입력 방법을 확인하도록 돕습니다. 실제 화면 조작은 Codex 데스크톱의 공식 Computer Use로 진행합니다.

현재 0.1.0 프리뷰는 [`release` 브랜치](https://github.com/dijeungi/CCUH/tree/release)에서 제공됩니다.

## Codex에 스킬 추가

Codex 채팅에서 아래 요청을 한 번 보내세요.

```text
$skill-installer dijeungi/CCUH의 release 브랜치에서 skills/ccuh와 skills/ccuh-doctor를 함께 설치해 줘.
```

설치 후 새 채팅의 스킬 메뉴에서 원하는 스킬을 선택하세요. 요청이 스킬 설명에 맞으면 Codex가 자동으로 선택할 수도 있습니다.

- **`ccuh`**는 작업할 앱이나 탭을 확인하고, 지원되는 관찰·입력 방법을 선택하도록 돕습니다.
- **`ccuh-doctor`**는 연결이나 권한 오류의 원인을 좁히고, 작업 결과가 불명확할 때 다음 조치를 정리합니다.

## 선택 사항인 자동 연동 훅

훅 프리뷰는 지원되는 Computer Use 호출 전에 CCUH 지침을 불러옵니다. macOS, Codex CLI, Python 3.9 이상이 필요합니다.

```sh
codex plugin marketplace add dijeungi/CCUH --ref release
codex plugin add ccuh@ccuh-preview
```

**설정 → Hooks**에서 CCUH 훅을 검토하고 신뢰한 뒤 새 채팅을 여세요. [훅 프리뷰 안내](https://github.com/dijeungi/CCUH/tree/release#설치)

## 라이선스

[MIT](LICENSE)
