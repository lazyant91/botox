# Botox (보톡스) - AI 콘텐츠 필터 크롬 확장 프로그램

[![Latest Release](https://img.shields.io/github/v/release/lazyant91/botox?color=blue)](https://github.com/lazyant91/botox/releases)
[![Changelog](https://img.shields.io/badge/changelog-CHANGELOG.md-orange.svg)](./CHANGELOG.md)

피드에 넘쳐나는 AI 봇(Bot)들의 유해한 독소(Tox) 같은 콘텐츠를 필터링하고 걸러내어, 인간의 오가닉한 콘텐츠만 깨끗하게 볼 수 있도록 돕는 Chrome 확장 프로그램입니다.

---

## ✨ 핵심 기능

1. **지능형 채널 차단 필터**:
   - 유튜브 검색 결과 페이지 및 메인 피드에서 원치 않는 채널을 은닉합니다.
   - 더보기 메뉴(`...`)를 클릭하여 즉시 인페이지 차단을 등록하거나 팝업창에서 손쉽게 추가할 수 있습니다.

2. **쇼츠(Shorts) 차단 및 가시성 제어**:
   - 검색 결과 및 피드 상의 쇼츠 선반 섹션과 개별 쇼츠 비디오 카드를 완전히 차단합니다.
   - 설정 팝업 내 토글 스위치를 통해 언제든지 차단 여부를 켜고 끌 수 있습니다.

3. **고성능 스크롤 지지대 및 렉 프리 최적화**:
   - `WeakSet` 메모리 주소 매핑 및 `addedNodes` Mutation 감시 최적화로 DOM 스캔 비용 최소화.
   - 쇼츠 제거 시 발생하는 세로 수축 레이아웃 시프트 및 continuation 무한 로딩 폭주를 제어하기 위한 가상 높이 스태빌라이저 탑재.

---

## 📅 업데이트 이력 (Changelog)
최신 릴리즈 정보 및 버전별 상세 개선 사항은 아래의 경로에서 실시간으로 확인하실 수 있습니다. (원격 Releases 등록 시 버전 배지가 자동으로 업데이트됩니다.)

- [세부 변경 사항 이력 문서 (CHANGELOG.md)](./CHANGELOG.md)
- [GitHub Releases 배포 로그](https://github.com/lazyant91/botox/releases)

---

## 🛠 설치 방법
1. 본 레포지토리를 클론하거나 ZIP 파일로 다운로드합니다.
2. 크롬 브라우저에서 `chrome://extensions/` 주소로 이동합니다.
3. 우측 상단의 **'개발자 모드'**를 활성화합니다.
4. **'압축해제된 확장 프로그램을 로드합니다'** 버튼을 클릭한 뒤, 본 프로젝트 폴더를 선택하여 로드합니다.
