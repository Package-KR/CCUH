<div align="center">

# CCUH

**Codex Computer Use Helpers**

기존 Chrome 탭 작업과 지원되는 Codex Computer Use 오류 복구를 돕는 macOS 플러그인입니다.

[English](README.md) | [한국어](README.ko.md)

</div>

> [!WARNING]
> **공개 프리뷰입니다.**
>
> 호스트가 제공하는 브라우저 Computer Use 연결이 필요합니다. OS 포커스·Space 전환 차단과 무관 콘텐츠 수집 자체의 원자적 차단은 보장하지 않습니다.

## 프로젝트 소개

CCUH에는 다음 구성이 있습니다.

- **ccuh:** 정확한 URL로 기존 탭을 재사용하고, 지원되는 작업을 해당 대상으로 제한하며 결과가 불확실하면 새 창을 만들지 않고 중단하는 가드.
- **ccuh-doctor:** 연결 진단, 되돌릴 수 있는 CLI 복구, 작업 상태 저장·유휴 확인 후 Codex 재시작.
- **개발 도구:** 더미 화면, 입력 측정, 자동 테스트. 배포 ZIP에는 포함하지 않습니다.

macOS와 현재 채팅에서 작동하는 Chrome Computer Use 연결이 필요하며, Doctor에는 Python 3.9 이상이 필요합니다. CCUH가 호스트 브라우저 기능을 설치하지는 않습니다. 관련 요청에서 스킬이 자동 선택될 수 있지만 모든 Computer Use 호출에 강제 적용되지는 않습니다.

Codex CLI가 설치된 터미널에서 실행하세요.

```sh
codex plugin marketplace add dijeungi/CCUH --ref v0.0.10
codex plugin add ccuh@ccuh
```

새 채팅에서 Chrome과 `ccuh` 스킬을 선택하고 “기존 `https://example.com/settings` 탭에서 …을 변경해줘. 현재 포커스를 유지하고, 지원되는 백그라운드 경로가 없으면 중단해줘”처럼 요청하세요. 연결이 막히면 `ccuh-doctor`로 진단할 수 있습니다. [공식 Chrome 연결 안내](https://learn.chatgpt.com/docs/chrome-extension)

실제 Chrome에서 비활성 탭·최소화 창·다른 Desktop에서의 직접 타이핑과, 실제 Codex 재시작 후 네이티브 인증 복구를 시험했습니다. 이는 시험한 사례이며 모든 환경의 보장은 아닙니다. URL 확인으로 캡처 후 비허용 결과 반환을 막을 수 있지만, 호스트의 캡처·입력을 원자적으로 제한하지는 못합니다. [검증 기록과 현재 호환 범위](https://github.com/dijeungi/CCUH/blob/v0.0.10/lab/results/release-0.0.10.json)

## 라이선스

[MIT](LICENSE)
