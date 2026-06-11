/**
 * YouTube AI Channel Filter - Content Script
 */

let blockedChannels = [];
let lastClickedChannel = null;
let lastClickedChannelDisplayName = null;
let lastInjectedChannel = null;

// 0. 익스텐션 컨텍스트 유효성 확인 헬퍼
function isContextValid() {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
}

// 1. chrome.storage.local에서 차단 채널 목록 불러오기
function loadBlockedChannels() {
  return new Promise((resolve) => {
    if (!isContextValid()) {
      resolve([]);
      return;
    }
    chrome.storage.local.get({ blockedChannels: [] }, (result) => {
      blockedChannels = result.blockedChannels;
      resolve(blockedChannels);
    });
  });
}

// 2. 채널 차단 추가 함수
function blockChannel(channelIdentifier, displayName) {
  if (!channelIdentifier) return;
  if (!isContextValid()) return;
  
  let cleaned = channelIdentifier.trim();
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch (e) {}

  if (cleaned && !blockedChannels.includes(cleaned)) {
    blockedChannels.push(cleaned);
    chrome.storage.local.get({ channelDisplayNames: {} }, (result) => {
      const displayNames = result.channelDisplayNames || {};
      if (displayName) {
        displayNames[cleaned] = displayName.trim();
      }
      chrome.storage.local.set({ blockedChannels, channelDisplayNames: displayNames }, () => {
        console.log(`[AI Filter] 차단된 채널: ${cleaned} (${displayName || ''})`);
        applyFiltering();
        updateSettingModalList();
      });
    });
  }
}

// 3. 채널 차단 해제 함수
function unblockChannel(channelIdentifier) {
  if (!isContextValid()) return;
  const cleaned = channelIdentifier.trim();
  blockedChannels = blockedChannels.filter(ch => ch !== cleaned);
  chrome.storage.local.get({ channelDisplayNames: {} }, (result) => {
    const displayNames = result.channelDisplayNames || {};
    delete displayNames[cleaned];
    chrome.storage.local.set({ blockedChannels, channelDisplayNames: displayNames }, () => {
      console.log(`[AI Filter] 차단 해제된 채널: ${cleaned}`);
      applyFiltering(true);
      updateSettingModalList();
    });
  });
}

// 4. 유튜브 비디오 요소를 찾아서 필터링 적용
function applyFiltering(resetVisibility = false) {
  const videoElements = document.querySelectorAll(
    'ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer'
  );

  videoElements.forEach(video => {
    // Shorts 탭 또는 광고(sponsored) 비디오 제외
    if (video.querySelector('ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"]') || 
        video.querySelector('.ytd-display-ad-renderer') ||
        video.querySelector('.ytd-ad-slot-renderer') ||
        video.querySelector('#sponsored-badge-label')) {
      return;
    }

    const channelId = extractChannelIdentifier(video);
    if (channelId) {
      if (blockedChannels.includes(channelId)) {
        video.style.setProperty('display', 'none', 'important');
      } else if (resetVisibility) {
        video.style.setProperty('display', '', '');
      }
    }
  });
}

// 5. 비디오 엘리먼트 내에서 고유 채널 식별자(@핸들명 또는 구형 /channel/ID) 추출
function extractChannelIdentifier(videoElement) {
  const channelAnchor = videoElement.querySelector(
    '#channel-info ytd-channel-name a, ' +
    'ytd-video-meta-block #channel-name a, ' +
    '#metadata-line #channel-name a, ' +
    '#channel-name a, ' +
    '#channel-info a, ' +
    '.ytd-channel-name a'
  );
  if (channelAnchor) {
    const href = channelAnchor.getAttribute('href');
    if (href) {
      // 1) 고유 핸들 매치 (예: /@codingapple)
      const handleMatch = href.match(/\/(@[^\/\?]+)/);
      if (handleMatch) {
        try {
          return decodeURIComponent(handleMatch[1]);
        } catch (e) {
          return handleMatch[1]; // "@codingapple"
        }
      }
      // 2) 구형 채널 주소 매치 (예: /channel/UC...)
      const channelIdMatch = href.match(/\/channel\/([^\/\?]+)/);
      if (channelIdMatch) {
        try {
          return decodeURIComponent(`/channel/${channelIdMatch[1]}`);
        } catch (e) {
          return `/channel/${channelIdMatch[1]}`;
        }
      }
    }
    // Fallback: 식별자가 없으면 텍스트 앞에 @를 붙여 식별용 키로 삼음
    const textName = channelAnchor.textContent.trim();
    if (textName) {
      return textName.startsWith('@') ? textName : `@${textName}`;
    }
  }
  return null;
}

// 5-2. 비디오 엘리먼트 내에서 실제 표시되는 채널명 텍스트 추출
function extractChannelDisplayName(videoElement) {
  const channelAnchor = videoElement.querySelector(
    '#channel-info ytd-channel-name a, ' +
    'ytd-video-meta-block #channel-name a, ' +
    '#metadata-line #channel-name a, ' +
    '#channel-name a, ' +
    '#channel-info a, ' +
    '.ytd-channel-name a'
  );
  if (channelAnchor) {
    return channelAnchor.textContent.trim();
  }
  return null;
}

// 6. 페이지 전역 클릭 이벤트를 감지하여 마지막으로 클릭한 비디오 카드의 채널을 저장
document.addEventListener('click', (e) => {
  const menuBtn = e.target.closest(
    'ytd-menu-renderer yt-icon-button, ytd-menu-renderer button, yt-icon-button.ytd-menu-renderer'
  );
  if (menuBtn) {
    const videoCard = menuBtn.closest(
      'ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer'
    );
    if (videoCard) {
      const channelId = extractChannelIdentifier(videoCard);
      const displayName = extractChannelDisplayName(videoCard);
      if (channelId) {
        lastClickedChannel = channelId;
        lastClickedChannelDisplayName = displayName;
        console.log(`[AI Filter] 메뉴 타겟 채널 식별자 감지: ${lastClickedChannel} (${lastClickedChannelDisplayName || ''})`);
      }
    }
  }
}, true); // Capture phase로 이벤트 우선 캐치

// 7. 더보기 팝업 메뉴 감시
function watchMenuPopup() {
  const menuObserver = new MutationObserver(() => {
    const popup = document.querySelector('ytd-menu-popup-renderer');
    // 팝업이 렌더링되고 화면에 보이는 상태(offsetHeight > 0)일 때만 처리
    if (popup && popup.offsetHeight > 0) {
      const itemsContainer = popup.querySelector('#items');
      if (itemsContainer && itemsContainer.children.length > 0) {
        const existingBtn = popup.querySelector('.yt-ai-filter-menu-item');
        // 기존 버튼이 없거나, 클릭한 타겟 채널이 바뀐 경우 재주입
        if (!existingBtn || lastInjectedChannel !== lastClickedChannel) {
          injectMenuButton(popup);
        }
      }
    }
  });

  menuObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'opened', 'class']
  });
}

// 8. 팝업 메뉴 내부에 채널 차단 버튼 주입
function injectMenuButton(popupElement) {
  if (!lastClickedChannel) return;

  const menuItemsContainer = popupElement.querySelector('#items');
  if (!menuItemsContainer) return;

  // 기존 항목이 존재하면 먼저 깔끔하게 제거
  const existingItem = popupElement.querySelector('.yt-ai-filter-menu-item');
  if (existingItem) {
    existingItem.remove();
  }

  const menuList = popupElement.querySelectorAll(
    'ytd-menu-navigation-item-renderer, ytd-menu-service-item-renderer'
  );
  let referenceMenu = null;
  
  menuList.forEach(item => {
    const text = item.textContent || '';
    if (text.includes('신고') || text.toLowerCase().includes('report') || 
        text.includes('공유') || text.toLowerCase().includes('share')) {
      referenceMenu = item;
    }
  });

  if (!referenceMenu) return;

  // 100% 스타일 복제
  const newMenuItem = referenceMenu.cloneNode(true);
  newMenuItem.className = 'yt-ai-filter-menu-item ' + referenceMenu.className;

  // 클릭 이벤트 핸들러 (캡처 페이즈 적용하여 유튜브 Polymer 자체 버블링 차단)
  const channelToBlock = lastClickedChannel;
  const displayNameToBlock = lastClickedChannelDisplayName;
  newMenuItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    
    document.body.click(); // 드롭다운 닫기

    const confirmMsg = displayNameToBlock
      ? `"${displayNameToBlock}(${channelToBlock})" 채널을 검색 결과에서 제외하시겠습니까?`
      : `"${channelToBlock}" 채널을 검색 결과에서 제외하시겠습니까?`;

    if (confirm(confirmMsg)) {
      blockChannel(channelToBlock, displayNameToBlock);
    }
  }, true);

  newMenuItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, false);

  // [핵심 변경]: cloneNode된 노드는 DOM에 부착되기 전에는 Shadow Root가 존재하지(연결되지) 않으므로, 
  // 먼저 DOM에 삽입하여 브라우저가 Shadow DOM 커넥션을 하도록 유도합니다.
  const targetReportMenu = Array.from(menuList).find(
    item => item.textContent.includes('신고') || item.textContent.toLowerCase().includes('report')
  );
  if (targetReportMenu && targetReportMenu.nextSibling) {
    menuItemsContainer.insertBefore(newMenuItem, targetReportMenu.nextSibling);
  } else {
    menuItemsContainer.appendChild(newMenuItem);
  }

  // ---------------- DOM 부착 후 Shadow DOM 요소 조작 진행 ----------------

  // 텍스트 라벨 변경 (DOM 부착 후 Shadow DOM 관통 조작)
  let textLabel = newMenuItem.querySelector('yt-formatted-string');
  if (!textLabel && newMenuItem.shadowRoot) {
    textLabel = newMenuItem.shadowRoot.querySelector('yt-formatted-string');
  }
  if (textLabel) {
    textLabel.textContent = displayNameToBlock ? `"${displayNameToBlock}(${channelToBlock})" 채널 차단` : `"${channelToBlock}" 채널 차단`;
  }

  // 아이콘 교체 (DOM 부착 후 Shadow DOM 관통 조작)
  let iconElement = newMenuItem.querySelector('yt-icon');
  if (!iconElement && newMenuItem.shadowRoot) {
    iconElement = newMenuItem.shadowRoot.querySelector('yt-icon');
  }
  if (iconElement) {
    while (iconElement.firstChild) {
      iconElement.removeChild(iconElement.firstChild);
    }
    const span = document.createElement('span');
    span.style.display = 'flex';
    span.style.alignItems = 'center';
    span.style.justifyContent = 'center';
    span.style.width = '100%';
    span.style.height = '100%';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.style.width = '20px';
    svg.style.height = '20px';

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '4.93');
    line.setAttribute('y1', '4.93');
    line.setAttribute('x2', '19.07');
    line.setAttribute('y2', '19.07');

    svg.appendChild(circle);
    svg.appendChild(line);
    span.appendChild(svg);
    iconElement.appendChild(span);
  }

  // Polymer 기본 이벤트 바인딩 해제
  newMenuItem.command = null;
  newMenuItem.service = null;
  newMenuItem.__data = null;
  if (newMenuItem.data) {
    newMenuItem.data = null;
  }

  // Shadow DOM 내부의 투명도 설정을 무시하고 강제 노출시키기 위한 핵심 조치
  if (newMenuItem.shadowRoot) {
    const style = document.createElement('style');
    style.textContent = `
      :host {
        opacity: 1 !important;
        display: flex !important;
        visibility: visible !important;
      }
      tp-yt-paper-item {
        opacity: 1 !important;
        display: flex !important;
        visibility: visible !important;
      }
      yt-formatted-string {
        opacity: 1 !important;
        display: inline-block !important;
        visibility: visible !important;
      }
    `;
    newMenuItem.shadowRoot.appendChild(style);
  }

  // 높이 제한 해제하여 잘림 현상 제거
  forceResizeDropdown(popupElement);

  // 현재 주입된 채널명을 기록
  lastInjectedChannel = lastClickedChannel;
}

// 9. 드롭다운 관련 컴포넌트의 높이 제한을 오버라이드하여 노출 보장
function forceResizeDropdown(popupElement) {
  const ironDropdown = popupElement.closest('tp-yt-iron-dropdown');
  if (ironDropdown) {
    ironDropdown.style.setProperty('max-height', 'none', 'important');
    ironDropdown.style.setProperty('height', 'auto', 'important');
    ironDropdown.style.setProperty('overflow', 'visible', 'important');
    
    const wrapper = ironDropdown.querySelector('#contentWrapper');
    if (wrapper) {
      wrapper.style.setProperty('max-height', 'none', 'important');
      wrapper.style.setProperty('height', 'auto', 'important');
      wrapper.style.setProperty('overflow', 'visible', 'important');
    }
  }

  const paperListbox = popupElement.querySelector('tp-yt-paper-listbox');
  if (paperListbox) {
    paperListbox.style.setProperty('max-height', 'none', 'important');
    paperListbox.style.setProperty('height', 'auto', 'important');
    paperListbox.style.setProperty('overflow', 'visible', 'important');
  }

  popupElement.style.setProperty('max-height', 'none', 'important');
  popupElement.style.setProperty('height', 'auto', 'important');
  popupElement.style.setProperty('overflow', 'visible', 'important');
}

// 10. 설정 플로팅 버튼 및 인페이지 모달 UI 주입
function injectSettingUI() {
  if (document.getElementById('yt-ai-filter-setting-root')) return;

  const root = document.createElement('div');
  root.id = 'yt-ai-filter-setting-root';

  const floatingBtn = document.createElement('button');
  floatingBtn.id = 'yt-ai-filter-floating-btn';
  floatingBtn.title = 'AI 필터 설정';

  const fSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  fSvg.setAttribute("viewBox", "0 0 24 24");
  fSvg.setAttribute("fill", "currentColor");
  const fPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  fPath.setAttribute("d", "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z");
  fSvg.appendChild(fPath);
  floatingBtn.appendChild(fSvg);

  const modal = document.createElement('div');
  modal.id = 'yt-ai-filter-modal';
  modal.className = 'hidden';

  const modalContent = document.createElement('div');
  modalContent.className = 'modal-content';

  const modalHeader = document.createElement('div');
  modalHeader.className = 'modal-header';

  const h2 = document.createElement('h2');
  h2.textContent = 'YouTube AI 필터 설정';

  const closeBtn = document.createElement('button');
  closeBtn.id = 'yt-ai-filter-modal-close';
  closeBtn.textContent = '×';

  modalHeader.appendChild(h2);
  modalHeader.appendChild(closeBtn);

  const modalBody = document.createElement('div');
  modalBody.className = 'modal-body';

  const p = document.createElement('p');
  p.className = 'modal-desc';
  p.textContent = '차단된 채널 목록입니다. 해제하려면 삭제 버튼을 누르세요.';

  const ul = document.createElement('ul');
  ul.id = 'yt-ai-filter-blocked-list';

  modalBody.appendChild(p);
  modalBody.appendChild(ul);

  modalContent.appendChild(modalHeader);
  modalContent.appendChild(modalBody);
  modal.appendChild(modalContent);

  root.appendChild(floatingBtn);
  root.appendChild(modal);
  document.body.appendChild(root);

  floatingBtn.addEventListener('click', () => {
    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden')) {
      updateSettingModalList();
    }
  });

  closeBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  window.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });
}

// 11. 모달 내 차단 목록 갱신
function updateSettingModalList() {
  const listContainer = document.getElementById('yt-ai-filter-blocked-list');
  if (!listContainer) return;

  listContainer.textContent = '';

  if (blockedChannels.length === 0) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'empty-msg';
    emptyLi.textContent = '차단된 채널이 없습니다.';
    listContainer.appendChild(emptyLi);
    return;
  }

  if (!isContextValid()) return;

  chrome.storage.local.get({ channelDisplayNames: {} }, (result) => {
    const displayNames = result.channelDisplayNames || {};
    blockedChannels.forEach(channelName => {
      const li = document.createElement('li');
      
      const textSpan = document.createElement('span');
      const displayName = displayNames[channelName];
      textSpan.textContent = displayName ? `${displayName}(${channelName})` : channelName;
      textSpan.className = 'channel-name-txt';

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-ch-btn';
      deleteBtn.textContent = '×';
      deleteBtn.title = '차단 해제';
      deleteBtn.addEventListener('click', () => {
        unblockChannel(channelName);
      });

      li.appendChild(textSpan);
      li.appendChild(deleteBtn);
      listContainer.appendChild(li);
    });
  });
}

// 12. 백그라운드 스크립트 통신 리스너
if (isContextValid()) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "UPDATE_BLOCKED_CHANNELS") {
      blockedChannels = message.blockedChannels;
      applyFiltering(true);
      updateSettingModalList();
    }
  });
}

// 13. 초기화 함수
async function init() {
  await loadBlockedChannels();
  applyFiltering();
  injectSettingUI();
  watchMenuPopup();

  // 유튜브 동적 로딩 대응 감시
  const observer = new MutationObserver(() => {
    applyFiltering();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
