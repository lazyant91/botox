document.addEventListener('DOMContentLoaded', () => {
  const channelInput = document.getElementById('channel-input');
  const addBtn = document.getElementById('add-btn');
  const countSpan = document.getElementById('count');
  const blockedList = document.getElementById('blocked-list');

  // 토스트 메시지 표시 함수
  function showToast(message) {
    let toast = document.querySelector('.toast-message');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast-message';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  }

  // 차단된 채널 목록 로드
  function loadChannels() {
    chrome.storage.local.get({ blockedChannels: [], channelDisplayNames: {} }, (result) => {
      const channels = result.blockedChannels;
      const displayNames = result.channelDisplayNames || {};
      countSpan.textContent = channels.length;
      blockedList.innerHTML = '';

      if (channels.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty-msg';
        li.textContent = '차단된 채널이 없습니다.';
        blockedList.appendChild(li);
        return;
      }

      channels.forEach((channel) => {
        const li = document.createElement('li');
        
        const span = document.createElement('span');
        span.className = 'channel-name link-style';
        
        const displayName = displayNames[channel];
        let safeChannel = channel;
        try {
          safeChannel = decodeURIComponent(channel);
        } catch (e) {}

        span.textContent = displayName ? `${displayName}(${safeChannel})` : safeChannel;
        span.title = '이 채널로 이동';
        
        span.addEventListener('click', () => {
          const url = channel.startsWith('@') 
            ? `https://www.youtube.com/${channel}` 
            : `https://www.youtube.com/${channel.replace(/^\//, '')}`;
          chrome.tabs.create({ url: url });
        });
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.textContent = '×';
        deleteBtn.title = '차단 해제';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeChannel(channel);
        });

        li.appendChild(span);
        li.appendChild(deleteBtn);
        blockedList.appendChild(li);
      });
    });
  }

  // HTML에서 고유 핸들명 추출
  function getChannelHandleFromHTML(htmlText) {
    const matchUrl = htmlText.match(/<link\s+itemprop="url"\s+href="[^"]*\/(@[^\/"]+)"/i) ||
                     htmlText.match(/itemprop="url"\s+href="[^"]*\/(@[^\/"]+)"/i);
    if (matchUrl && matchUrl[1]) {
      return decodeHTMLEntities(matchUrl[1]);
    }

    const matchChannelId = htmlText.match(/<link\s+itemprop="url"\s+href="[^"]*\/channel\/([^\/"]+)"/i) ||
                           htmlText.match(/itemprop="url"\s+href="[^"]*\/channel\/([^\/"]+)"/i);
    if (matchChannelId && matchChannelId[1]) {
      return `/channel/${decodeHTMLEntities(matchChannelId[1])}`;
    }
    
    const matchAuthor = htmlText.match(/"author"\s*:\s*"([^"]+)"/i);
    if (matchAuthor && matchAuthor[1]) {
      const name = decodeHTMLEntities(matchAuthor[1]);
      return name.startsWith('@') ? name : `@${name}`;
    }

    return null;
  }

  // HTML에서 실제 채널 표시명 추출
  function getChannelNameFromHTML(htmlText) {
    const matchAuthor = htmlText.match(/"author"\s*:\s*"([^"]+)"/i);
    if (matchAuthor && matchAuthor[1]) {
      return decodeHTMLEntities(matchAuthor[1]);
    }
    const matchMeta = htmlText.match(/<meta\s+itemprop="name"\s+content="([^"]+)"/i) ||
                      htmlText.match(/itemprop="name"\s+content="([^"]+)"/i);
    if (matchMeta && matchMeta[1]) {
      return decodeHTMLEntities(matchMeta[1]);
    }
    return null;
  }

  function decodeHTMLEntities(text) {
    const javaText = text.replace(/\\u0026/g, '&');
    const textArea = document.createElement('textarea');
    textArea.innerHTML = javaText;
    return textArea.value;
  }

  // 실제 스토리지 추가 및 전파 핸들러
  function proceedAdding(validName, displayName) {
    chrome.storage.local.get({ blockedChannels: [], channelDisplayNames: {} }, (result) => {
      const channels = result.blockedChannels;
      const displayNames = result.channelDisplayNames || {};
      if (!channels.includes(validName)) {
        channels.push(validName);
        if (displayName) {
          displayNames[validName] = displayName;
        }
        chrome.storage.local.set({ blockedChannels: channels, channelDisplayNames: displayNames }, () => {
          channelInput.value = '';
          loadChannels();
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, {
                action: "UPDATE_BLOCKED_CHANNELS",
                blockedChannels: channels
              });
            }
          });
        });
      } else {
        showToast('이미 차단된 채널입니다.');
      }
    });
  }

  // 채널 추가 (엔터/차단 단추 클릭 시 일괄 파싱 및 존재 검증 수행)
  function addChannel() {
    const trimmed = channelInput.value.trim();
    if (!trimmed) return;

    // 1) URL 형태인지 정규식 검사
    const urlRegex = /^(https?:\/\/)?([\w\-]+\.)+[\w\-]+(\/[^\s]*)?$/i;
    const isUrlFormat = urlRegex.test(trimmed);

    // 2) 유튜브 도메인 검사
    const isYoutubeDomain = /youtube\.com|youtu\.be/i.test(trimmed);

    // 만약 URL 포맷인데 유튜브 도메인이 아니면 오탈자 링크이므로 차단
    if (isUrlFormat && !isYoutubeDomain) {
      showToast("올바른 유튜브 링크가 아닙니다.");
      channelInput.value = "";
      return;
    }

    // 3) 수기 입력 차단값 디코딩 가드 및 도메인 유효성 체크
    let testName = trimmed;
    try {
      testName = decodeURIComponent(trimmed);
    } catch (e) {}

    if (testName.includes('http') || testName.includes('www') || testName.includes('.com')) {
      showToast("올바른 유튜브 링크가 아닙니다.");
      channelInput.value = "";
      return;
    }

    // 4) 비동기 파싱 및 검증 수행 분기
    channelInput.disabled = true;
    addBtn.disabled = true;
    const originalPlaceholder = channelInput.placeholder;
    channelInput.placeholder = "채널 정보를 분석하고 있습니다...";

    let targetFetchUrl = "";
    let isChannelHome = false;
    let isVideoUrl = false;
    let preParsedHandle = null;

    if (!isUrlFormat) {
      // 수기 입력 채널명
      let handle = trimmed;
      if (!handle.startsWith('@') && !handle.startsWith('/channel/')) {
        handle = `@${handle}`;
      }
      preParsedHandle = handle;
      targetFetchUrl = `https://www.youtube.com/${preParsedHandle}`;
      isChannelHome = true;
    } else {
      // 유튜브 정식 주소
      let decodedUrl = trimmed;
      try {
        decodedUrl = decodeURIComponent(trimmed);
      } catch (e) {}

      const videoRegex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\s\?]+)/i;
      const videoMatch = decodedUrl.match(videoRegex);

      if (videoMatch) {
        const videoId = videoMatch[1];
        targetFetchUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
        isVideoUrl = true;
      } else {
        const handleMatch = decodedUrl.match(/\/(@[^\/\s\?]+)/);
        const channelIdMatch = decodedUrl.match(/\/channel\/([^\/\s\?]+)/);
        
        if (handleMatch) {
          preParsedHandle = handleMatch[1];
          targetFetchUrl = `https://www.youtube.com/${preParsedHandle}`;
          isChannelHome = true;
        } else if (channelIdMatch) {
          preParsedHandle = `/channel/${channelIdMatch[1]}`;
          targetFetchUrl = `https://www.youtube.com/channel/${channelIdMatch[1]}`;
          isChannelHome = true;
        } else {
          const genericChannelMatch = decodedUrl.match(/\/(c\/[^\/\s\?]+|user\/[^\/\s\?]+)/);
          if (genericChannelMatch) {
            targetFetchUrl = decodedUrl;
            isChannelHome = true;
          } else {
            showToast("올바른 유튜브 링크가 아닙니다.");
            channelInput.disabled = false;
            addBtn.disabled = false;
            channelInput.placeholder = originalPlaceholder;
            return;
          }
        }
      }
    }

    console.log(`[AI Filter] 채널 유효성 일괄 검증 기동: ${targetFetchUrl}`);

    fetch(targetFetchUrl)
      .then(response => {
        if (!response.ok) {
          return Promise.reject("HTTP error " + response.status);
        }
        if (isVideoUrl) {
          return response.json();
        }
        return response.text();
      })
      .then(data => {
        let channelHandle = null;
        let displayName = null;

        if (isVideoUrl) {
          displayName = data.author_name;
          const authorUrl = data.author_url;
          if (authorUrl) {
            const decodedAuthorUrl = decodeURIComponent(authorUrl);
            const authorHandleMatch = decodedAuthorUrl.match(/\/(@[^\/\s\?]+)/);
            const authorChannelIdMatch = decodedAuthorUrl.match(/\/channel\/([^\/\s\?]+)/);
            
            if (authorHandleMatch) {
              channelHandle = authorHandleMatch[1];
            } else if (authorChannelIdMatch) {
              channelHandle = `/channel/${authorChannelIdMatch[1]}`;
            }
          }
        } else {
          const htmlText = data;
          displayName = getChannelNameFromHTML(htmlText);

          if (isChannelHome && preParsedHandle) {
            channelHandle = preParsedHandle;
          } else {
            channelHandle = getChannelHandleFromHTML(htmlText);
          }

          if (!displayName) {
            const ogTitleMatch = htmlText.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                                 htmlText.match(/property="og:title"\s+content="([^"]+)"/i);
            if (ogTitleMatch && ogTitleMatch[1]) {
              displayName = decodeHTMLEntities(ogTitleMatch[1]).replace(/\s*-\s*YouTube/i, '').trim();
            }
          }
        }

        if (channelHandle) {
          let finalHandle = channelHandle;
          try {
            finalHandle = decodeURIComponent(channelHandle);
          } catch (e) {}
          
          proceedAdding(finalHandle, displayName);
        } else {
          return Promise.reject("채널 식별자 추출 실패");
        }
      })
      .catch(err => {
        console.log("[AI Filter] 채널 일괄 검증 실패(미존재 채널 또는 차단 오류):", err);
        showToast("존재하지 않는 유튜브 채널입니다.");
      })
      .finally(() => {
        channelInput.disabled = false;
        addBtn.disabled = false;
        channelInput.placeholder = originalPlaceholder;
        channelInput.focus();
      });
  }

  // 채널 해제
  function removeChannel(channelName) {
    chrome.storage.local.get({ blockedChannels: [], channelDisplayNames: {} }, (result) => {
      const channels = result.blockedChannels.filter(c => c !== channelName);
      const displayNames = result.channelDisplayNames || {};
      delete displayNames[channelName];
      chrome.storage.local.set({ blockedChannels: channels, channelDisplayNames: displayNames }, () => {
        loadChannels();
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs && tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: "UPDATE_BLOCKED_CHANNELS",
              blockedChannels: channels
            });
          }
        });
      });
    });
  }

  // 이벤트 바인딩
  addBtn.addEventListener('click', addChannel);
  
  channelInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addChannel();
  });

  // Shorts 토글 스위치 처리 추가
  const shortsToggle = document.getElementById('shorts-toggle');
  if (shortsToggle) {
    // 로컬 스토리지에서 상태 로드
    chrome.storage.local.get({ blockShorts: true }, (result) => {
      shortsToggle.checked = result.blockShorts;
    });

    // 변경 시 저장 및 탭 전파
    shortsToggle.addEventListener('change', () => {
      const blockShorts = shortsToggle.checked;
      chrome.storage.local.set({ blockShorts: blockShorts }, () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs && tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: "UPDATE_BLOCK_SHORTS",
              blockShorts: blockShorts
            });
          }
        });
      });
    });
  }

  // 초기 실행
  loadChannels();
});

