/**
 * YouTube AI Channel & Shorts Filter - Content Script
 * 
 * [Botox 확장 프로그램 코어 아키텍처 사양]
 * 1. 0ms 즉각 차단 (CSS 엔진 연동)
 * 2. O(1) 초고속 필터 캐싱 (WeakSet 주소 대조)
 * 3. MutationObserver 핀포인트 추가 노드(addedNodes)만 선택 감시
 * 4. 무한 로딩 폭주 방어 (Continuation Lock 및 가상 높이 보정 지지대)
 */

// ==========================================
// [1] 전역 설정 및 상태 변수 정의
// ==========================================

let blockedChannels = []; // 차단 채널 목록 (@핸들명 또는 /channel/ID 규격)
let blockShorts = true;    // Shorts 차단 On/Off 플래그 (기본값: true)

let lastClickedChannel = null;            // 드롭다운 메뉴용 클릭 타겟 채널 식별자
let lastClickedChannelDisplayName = null; // 클릭한 채널 표시명
let lastInjectedChannel = null;           // 현재 드롭다운에 추가된 마지막 차단 타겟

// ==========================================
// [2] 렌더링 필터 구조 매핑 정의 (플랫폼 맞춤 선택자)
// ==========================================

const CARD_SELECTOR = [
  'ytd-video-renderer',        // 검색결과 / 채널 홈 비디오 카드
  'ytd-rich-item-renderer',     // 홈 피드 그리드 비디오 카드
  'ytd-compact-video-renderer',  // 추천 동영상 사이드바 카드
  'ytd-reel-shelf-renderer',     // Shorts 가로 선반 (섹션)
  'ytd-reel-item-renderer',      // Shorts 개별 아이템 카드
  'ytd-shelf-renderer',          // 유튜브 일반 묶음 선반
  'grid-shelf-view-model'        // 최신 그리드형 쇼츠 선반
].join(',');

let processed = new WeakSet();   // 이미 필터 검증이 끝난 DOM 노드 캐싱 (O_1 성능)
let pending = new Set();         // 필터 처리를 대기하는 비동기 후보 노드 큐
let filterTimer = null;          // 디바운스 필터링용 타이머
let continuationTimer = null;    // 유튜브 추가 페이지 로드 센서(continuation) 락 타이머

// ==========================================
// [3] 익스텐션 환경 및 데이터 로드 모듈
// ==========================================

// 익스텐션 런타임 만료 방어를 위한 컨텍스트 유효성 헬퍼
function isContextValid() {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
}

// 스토리지에서 차단 채널 목록 및 Shorts 필터 설정 로드
function loadBlockedChannels() {
  return new Promise((resolve) => {
    if (!isContextValid()) {
      resolve([]);
      return;
    }
    chrome.storage.local.get({ blockedChannels: [], blockShorts: true }, (result) => {
      blockedChannels = result.blockedChannels;
      blockShorts = result.blockShorts;
      
      // 초고속 CSS 필터링을 동기화하기 위한 클래스 토글
      toggleCssShortsActive(blockShorts);
      resolve(blockedChannels);
    });
  });
}

// CSS 선제 차단용 body 클래스 주입/제거 제어
function toggleCssShortsActive(active) {
  if (active) {
    document.body.classList.add('botox-shorts-active');
  } else {
    document.body.classList.remove('botox-shorts-active');
  }
}

// ==========================================
// [4] 핵심 필터링 및 감지 가동 엔진
// ==========================================

// 대상 노드가 쇼츠(Shorts) 관련 콘텐츠인지 검출하는 경량 감지기
function isShortsCard(card) {
  const tagName = card.tagName.toLowerCase();
  
  // 1. 쇼츠 전용 선반 및 개별 쇼츠 렌더러 판정
  if (
    tagName === 'ytd-reel-shelf-renderer' ||
    tagName === 'ytd-reel-item-renderer' ||
    tagName === 'grid-shelf-view-model'
  ) {
    return true;
  }

  // 2. 일반 선반 내부 쇼츠 묶음 판정
  if (tagName === 'ytd-shelf-renderer') {
    return Boolean(
      card.querySelector('a[href*="/shorts/"]') ||
      card.querySelector('a[href*="/shorts?"]') ||
      card.querySelector('a[href$="/shorts"]')
    );
  }

  // 3. 개별 비디오 렌더러에 쇼츠 링크가 달린 경우 판정
  return Boolean(
    card.querySelector('a[href*="/shorts/"]') ||
    card.querySelector('a[href*="/shorts?"]') ||
    card.querySelector('a[href$="/shorts"]') ||
    card.querySelector('ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"]')
  );
}

// 개별 동영상 카드에 필터(Shorts 은닉 / 채널 차단)를 적용하는 함수
function filterCard(card, resetVisibility = false) {
  if (!(card instanceof HTMLElement)) return false;
  
  // 전체 가시성 복구 요청 시 (스위치 OFF)
  if (resetVisibility) {
    card.classList.remove('botox-hidden-short');
    card.style.setProperty('display', '', '');
    return false;
  }

  // WeakSet 캐시 조회 (이미 스캔이 완료된 경우 연산 스킵)
  if (processed.has(card)) return false;
  processed.add(card);

  // A. Shorts 감지 및 클래스 분리 격리
  if (isShortsCard(card)) {
    if (blockShorts) {
      card.classList.add('botox-hidden-short');
      return true;
    }
    return false;
  }

  // B. 광고 동영상 예외 처리
  if (card.querySelector('.ytd-display-ad-renderer') ||
      card.querySelector('.ytd-ad-slot-renderer') ||
      card.querySelector('#sponsored-badge-label')) {
    return false;
  }

  // C. 채널 식별자 추출 및 차단 비교
  const channelId = extractChannelIdentifier(card);
  if (channelId) {
    if (blockedChannels.includes(channelId)) {
      card.style.setProperty('display', 'none', 'important');
      return true;
    }
  }

  return false;
}

// 디바운스 대기열 필터링 개시
function applyFiltering(resetVisibility = false) {
  if (resetVisibility) {
    processed = new WeakSet();
    const allCards = document.querySelectorAll(CARD_SELECTOR);
    allCards.forEach(card => filterCard(card, true));
    return;
  }

  // 초기 렌더링된 전체 노드 검사 대기열(pending)에 추가
  const allElements = document.querySelectorAll(CARD_SELECTOR);
  scheduleFilter(allElements);
}

// 150ms 프레임 디바운싱을 통해 스캔 비용 및 레이아웃 충돌 방지
function scheduleFilter(candidates) {
  for (const item of candidates) {
    pending.add(item);
  }

  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    let processedCount = 0;
    let hiddenCount = 0;

    for (const card of pending) {
      processedCount++;
      if (filterCard(card)) {
        hiddenCount++;
      }
    }

    pending.clear();

    // 숨겨진 요소가 발생한 경우 로딩 속도 제어 및 높이 보정 가동
    if (hiddenCount > 0) {
      const ratio = hiddenCount / Math.max(1, processedCount);
      lockContinuation(ratio > 0.4 ? 1200 : 600);
      stabilizeFeedHeight(hiddenCount);
    }
  }, 150);
}

// ==========================================
// [5] 렉 방지를 위한 레이아웃 지지 및 로더 제어
// ==========================================

// 쇼츠 제거로 발생한 세로 높이 공백 보정 (Layout Shift 방지 가상 스페이서)
function stabilizeFeedHeight(hiddenCount) {
  const feed = document.querySelector('ytd-section-list-renderer') ||
               document.querySelector('ytd-rich-grid-renderer') ||
               document.querySelector('#contents');

  if (!feed) return;

  const estimatedCardHeight = 140; // 개별 비디오 카드의 추정 높이
  const extraHeight = Math.min(hiddenCount * estimatedCardHeight, 3000);

  feed.style.setProperty('--botox-extra-height', `${extraHeight}px`);
  feed.classList.add('botox-feed-stabilized');

  // API 추가 패치가 완료된 후 높이 보정용 가상 클래스 자동 걷어내기
  setTimeout(() => {
    feed.classList.remove('botox-feed-stabilized');
    feed.style.removeProperty('--botox-extra-height');
  }, 1500);
}

// 신규 추가된 Node 트리 내에서 필터링 타겟 후보군만 식별자 검출
function collectCandidates(node, candidates) {
  if (!(node instanceof HTMLElement)) return;

  if (node.matches(CARD_SELECTOR)) {
    candidates.add(node);
  }

  const childs = node.querySelectorAll(CARD_SELECTOR);
  for (const child of childs) {
    candidates.add(child);
  }
}

// 유튜브 스크롤 추가 API 호출 감지기(continuation)의 과도한 호출을 막기 위한 동적 락커
function lockContinuation(ms) {
  const loaders = document.querySelectorAll('ytd-continuation-item-renderer');
  for (const loader of loaders) {
    loader.style.setProperty('display', 'none', 'important');
    loader.dataset.botoxContinuationLocked = 'true';
  }

  clearTimeout(continuationTimer);
  continuationTimer = setTimeout(() => {
    const lockedLoaders = document.querySelectorAll(
      'ytd-continuation-item-renderer[data-botox-continuation-locked="true"]'
    );
    for (const loader of lockedLoaders) {
      loader.style.removeProperty('display');
      delete loader.dataset.botoxContinuationLocked;
    }
  }, ms);
}

// ==========================================
// [6] 비디오 노드 데이터 파싱 모듈
// ==========================================

// 비디오 카드 내 채널 고유 주소(핸들명 또는 구형 channel/ID) 정규화 파싱
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
      // 1. 고유 핸들형 주소 매칭 (예: /@codingapple)
      const handleMatch = href.match(/\/(@[^\/\?]+)/);
      if (handleMatch) {
        try {
          return decodeURIComponent(handleMatch[1]);
        } catch (e) {
          return handleMatch[1];
        }
      }
      // 2. 구형 채널 주소 매칭 (예: /channel/UC...)
      const channelIdMatch = href.match(/\/channel\/([^\/\?]+)/);
      if (channelIdMatch) {
        try {
          return decodeURIComponent(`/channel/${channelIdMatch[1]}`);
        } catch (e) {
          return `/channel/${channelIdMatch[1]}`;
        }
      }
    }
    // Fallback: 앵커 href가 없거나 깨진 경우 표시 텍스트로 보정
    const textName = channelAnchor.textContent.trim();
    if (textName) {
      return textName.startsWith('@') ? textName : `@${textName}`;
    }
  }
  return null;
}

// 비디오 카드 내 실제 노출 채널명 추출
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

// ==========================================
// [7] 채널 수동 등록 및 스토리지 핸들링
// ==========================================

// 로컬 스토리지에 새 차단 대상 채널 보존
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
        console.log(`[AI Filter] 차단 추가: ${cleaned} (${displayName || ''})`);
        applyFiltering();
        updateSettingModalList();
      });
    });
  }
}

// 차단된 채널 해제 처리
function unblockChannel(channelIdentifier) {
  if (!isContextValid()) return;
  const cleaned = channelIdentifier.trim();
  blockedChannels = blockedChannels.filter(ch => ch !== cleaned);
  chrome.storage.local.get({ channelDisplayNames: {} }, (result) => {
    const displayNames = result.channelDisplayNames || {};
    delete displayNames[cleaned];
    chrome.storage.local.set({ blockedChannels, channelDisplayNames: displayNames }, () => {
      console.log(`[AI Filter] 차단 해제: ${cleaned}`);
      applyFiltering(true);
      updateSettingModalList();
    });
  });
}

// ==========================================
// [8] 사용자 인페이지 설정 UI 관리 및 바인딩
// ==========================================

// 전역 캡처 클릭 감지 리스너 (더보기 메뉴 클릭 시 타겟 채널 정보 캐싱)
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
        console.log(`[AI Filter] 타겟 식별자 감지: ${lastClickedChannel} (${lastClickedChannelDisplayName || ''})`);
      }
    }
  }
}, true);

// 우측 하단 플로팅 관리 UI 버튼 주입
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

// 인페이지 모달 내 차단 목록 최신화
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

// ==========================================
// [9] 드롭다운 더보기 메뉴 내 차단 주입 및 감시
// ==========================================

// 더보기 팝업의 개폐 MutationObserver 감시
function watchMenuPopup() {
  const menuObserver = new MutationObserver(() => {
    const popup = document.querySelector('ytd-menu-popup-renderer');
    if (popup && popup.offsetHeight > 0) {
      const itemsContainer = popup.querySelector('#items');
      if (itemsContainer && itemsContainer.children.length > 0) {
        const existingBtn = popup.querySelector('.yt-ai-filter-menu-item');
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

// 더보기 팝업 내 채널 차단 버튼 엘리먼트 주입
function injectMenuButton(popupElement) {
  if (!lastClickedChannel) return;

  const menuItemsContainer = popupElement.querySelector('#items');
  if (!menuItemsContainer) return;

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

  // 유튜브 폴리머 기본 아이템 스타일 복제
  const newMenuItem = referenceMenu.cloneNode(true);
  newMenuItem.className = 'yt-ai-filter-menu-item ' + referenceMenu.className;

  const channelToBlock = lastClickedChannel;
  const displayNameToBlock = lastClickedChannelDisplayName;
  
  // 클릭 이벤트 우선 바인딩
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

  // Shadow DOM 연결성 보장을 위해 선 배치 후 가공
  const targetReportMenu = Array.from(menuList).find(
    item => item.textContent.includes('신고') || item.textContent.toLowerCase().includes('report')
  );
  if (targetReportMenu && targetReportMenu.nextSibling) {
    menuItemsContainer.insertBefore(newMenuItem, targetReportMenu.nextSibling);
  } else {
    menuItemsContainer.appendChild(newMenuItem);
  }

  // 텍스트 라벨 교체
  let textLabel = newMenuItem.querySelector('yt-formatted-string');
  if (!textLabel && newMenuItem.shadowRoot) {
    textLabel = newMenuItem.shadowRoot.querySelector('yt-formatted-string');
  }
  if (textLabel) {
    textLabel.textContent = displayNameToBlock ? `"${displayNameToBlock}(${channelToBlock})" 채널 차단` : `"${channelToBlock}" 채널 차단`;
  }

  // 차단 아이콘 SVG 교체
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

  // Polymer 내부 기본 바인딩 초기화
  newMenuItem.command = null;
  newMenuItem.service = null;
  newMenuItem.__data = null;
  if (newMenuItem.data) {
    newMenuItem.data = null;
  }

  // 섀도우 돔 관통 강제 노출 스타일 룰 주입
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

  forceResizeDropdown(popupElement);
  lastInjectedChannel = lastClickedChannel;
}

// 드롭다운 관련 컴포넌트 높이 제한 해제 조치
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

// ==========================================
// [10] 브라우저 백그라운드 이벤트 리스너 연동
// ==========================================

if (isContextValid()) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 팝업으로부터 차단 채널 목록 업데이트 수신 시
    if (message.action === "UPDATE_BLOCKED_CHANNELS") {
      blockedChannels = message.blockedChannels;
      applyFiltering(true);
      updateSettingModalList();
    } 
    // 팝업으로부터 Shorts 차단 토글 설정 수신 시
    else if (message.action === "UPDATE_BLOCK_SHORTS") {
      blockShorts = message.blockShorts;
      toggleCssShortsActive(blockShorts);
      applyFiltering(true);
    }
  });
}

// ==========================================
// [11] 초기화(Bootstrap) 함수
// ==========================================

async function init() {
  await loadBlockedChannels();
  applyFiltering();
  injectSettingUI();
  watchMenuPopup();

  // 신규 노드 유입 감시를 위한 MutationObserver 구동
  const observer = new MutationObserver((mutations) => {
    const candidates = new Set();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        collectCandidates(node, candidates);
      }
    }

    if (candidates.size > 0) {
      scheduleFilter(candidates);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// SPA 라우팅 네비게이션 전환 시 WeakSet 메모리 리셋 및 재스캔 트리거
document.addEventListener("yt-navigate-finish", () => {
  processed = new WeakSet();
  applyFiltering();
});

// 진입 타이밍 분기 실행
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
