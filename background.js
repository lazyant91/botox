// 백그라운드 서비스 워커 - 스토리지 동기화 전파
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "local" && changes.blockedChannels) {
    // 열려 있는 모든 유튜브 탭에 차단 목록 업데이트 브로드캐스트
    chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, {
          action: "UPDATE_BLOCKED_CHANNELS",
          blockedChannels: changes.blockedChannels.newValue
        }).catch((err) => {
          // 콘텐트 스크립트가 로드되지 않은 탭은 예외 무시
        });
      });
    });
  }
});
