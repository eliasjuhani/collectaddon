(function () {
  'use strict';

  if (window.__csContentLoaded) return;
  window.__csContentLoaded = true;

  const isInIframe = window.self !== window.top;
  const isSplitIframe = isInIframe && (window.name === 'cs-split-right-iframe' || window.name === 'cs-split-left-iframe');

  let pollInterval = null;
  let injected = false;
  let injectScriptReady = false;
  let currentOverlay = null;
  let alertCountdownInterval = null;
  let alertAudio = null;
  let escKeyHandler = null;
  let zenModeStyleElement = null;
  let splitModeStyleElement = null;

  // Await DOM readiness before initializing UI modifications
  function waitForSapUI(callback, maxAttempts = 50) {
    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      const found = document.querySelector(
        '.sapUshellApplicationContainer, #__jsview1--pageOrderView-cont, [id*="--pageOrderView-cont"], .sapMShellContent'
      );
      if (found) { clearInterval(check); callback(); }
      else if (attempts >= maxAttempts) clearInterval(check);
    }, 200);
  }

  init();

  async function init() {
    const isSimulator = window.location.protocol === 'chrome-extension:';
    const settings = await chrome.storage.local.get(['pollIntervalSeconds', 'alertDurationSeconds', 'alertOverlay', 'alertStyle']);

    if (!settings.alertDurationSeconds) {
      await chrome.storage.local.set({ alertDurationSeconds: 10 });
    }

    if (isSimulator) {
      let soundDataUrl = null, videoDataUrl = null, imageDataUrl = null;
      if (typeof MediaDB !== 'undefined') {
        try {
          [soundDataUrl, videoDataUrl, imageDataUrl] = await Promise.all([
            MediaDB.getMediaAsDataURL('soundData'),
            MediaDB.getMediaAsDataURL('videoData'),
            MediaDB.getMediaAsDataURL('imageData')
          ]);
        } catch (e) { console.warn('media load error:', e); }
      }
      setTimeout(() => {
        showAlertOverlay({
          count: 5,
          soundData: soundDataUrl,
          videoData: videoDataUrl,
          imageData: imageDataUrl,
          oldestOrderTimestamp: Date.now() - (8 * 60 * 1000),
          isSimulator: true,
          alertOverlay: settings.alertOverlay,
          alertStyle: settings.alertStyle
        });
      }, 500);
      chrome.storage.onChanged.addListener(handleStorageChange);
      window.addEventListener('beforeunload', cleanup);
      return;
    }

    injectPageScript();
    startPolling(settings.pollIntervalSeconds || 30);

    const modeSettings = await chrome.storage.local.get(['zenModeEnabled', 'splitModeEnabled', 'splitRatio']);
    if (modeSettings.zenModeEnabled === true) {
      waitForSapUI(() => applyZenMode(true));
    }
    if (modeSettings.splitModeEnabled === true) {
      waitForSapUI(() => applySplitMode(true, modeSettings.splitRatio || 50));
    }

    chrome.storage.onChanged.addListener(handleStorageChange);
    window.addEventListener('beforeunload', cleanup);
  }

  function handleStorageChange(changes, area) {
    if (area !== 'local') return;
    if (changes.pollIntervalSeconds) startPolling(changes.pollIntervalSeconds.newValue);
    if (changes.zenModeEnabled) applyZenMode(!!changes.zenModeEnabled.newValue);
    if (changes.splitModeEnabled || changes.splitRatio) {
      chrome.storage.local.get(['splitModeEnabled', 'splitRatio']).then(s => {
        applySplitMode(!!s.splitModeEnabled, s.splitRatio || 50);
      });
    }
  }

  function cleanup() {
    if (pollInterval) clearInterval(pollInterval);
    closeAlertOverlay();
  }

  function startPolling(seconds) {
    const intervalSec = Math.max(1, Math.min(60, parseInt(seconds, 10) || 30));
    if (pollInterval) clearInterval(pollInterval);
    triggerPageRefresh();
    pollInterval = setInterval(triggerPageRefresh, intervalSec * 1000);
  }

  function injectPageScript() {
    if (injected) return;
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('inject.js');
      script.onload = function () { injected = true; this.remove(); };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) { console.warn('inject error:', e); }
  }

  async function sendConfigToInject() {
    if (!injectScriptReady) return;
    try {
      if (!chrome.runtime?.id) return; // Terminate gracefully if extension context is invalidated
      const response = await chrome.runtime.sendMessage({ action: 'getConfig' });
      if (response?.success && response.config) {
        window.postMessage({ type: 'COLLECT_STORE_CONFIG_UPDATE', config: response.config }, '*');
      }
    } catch (e) { console.warn('sendConfig error:', e); }
  }

  function triggerPageRefresh() {
    if (!injectScriptReady) {
      injectPageScript();
      setTimeout(() => window.postMessage({ type: 'COLLECT_STORE_TRIGGER_REFRESH' }, '*'), 500);
      return;
    }
    window.postMessage({ type: 'COLLECT_STORE_TRIGGER_REFRESH' }, '*');
  }

  let dataBatchTimer = null;
  let batchData = null;

  function submitOrdersToBackground(data) {
    if (!chrome.runtime?.id) return;

    // Accumulate the highest count seen in this burst to counteract false-zero overwrites from simultaneous iframe loads
    if (!batchData || (data.collectCount + data.woltCount) > (batchData.collectCount + batchData.woltCount)) {
      batchData = data;
    }

    if (!dataBatchTimer) {
      dataBatchTimer = setTimeout(() => {
        if (chrome.runtime?.id && batchData) {
          chrome.runtime.sendMessage({ action: 'updateOrders', data: batchData }).catch(() => { });
        }
        batchData = null;
        dataBatchTimer = null;
      }, 1500);
    }
  }

  window.addEventListener('message', (event) => {
    if (!isInIframe && event.data?.type === 'COLLECT_STORE_IFRAME_DATA') {
      const incomingData = event.data.data || {};
      submitOrdersToBackground(incomingData);
      return;
    }

    if (event.source !== window) return;
    // Enforce strict origin validation
    const validOrigin = event.origin === 'https://launchpad.elkjop.com' ||
      event.origin.startsWith('chrome-extension://');
    if (!validOrigin) return;

    if (event.data?.type === 'COLLECT_STORE_DATA') {
      const incomingData = event.data.data || {};
      if (!isInIframe) {
        submitOrdersToBackground(incomingData);
      } else {
        try {
          window.parent.postMessage({ type: 'COLLECT_STORE_IFRAME_DATA', data: incomingData }, '*');
        } catch (e) { console.warn('iframe forward error:', e); }
      }
    }

    if (event.data?.type === 'COLLECT_STORE_READY') {
      injectScriptReady = true;
      sendConfigToInject();
    }

    if (event.data?.type === 'COLLECT_STORE_SYNC_MODES' && isSplitIframe) {
      applyZenMode(event.data.zenMode);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'triggerCheck') {
      triggerPageRefresh();
      sendResponse({ success: true });
    } else if (message.action === 'showAlert') {
      showAlertOverlay(message.data);
      sendResponse({ success: true });
    } else if (message.action === 'updateModes') {
      if (message.data) {
        applyZenMode(!!message.data.zenModeEnabled);
        applySplitMode(!!message.data.splitModeEnabled, message.data.splitRatio || 50);
      }
      sendResponse({ success: true });
    } else if (message.action === 'applySplit') {
      if (message.data) {
        applyZenMode(!!message.data.zenModeEnabled);
        applySplitMode(!!message.data.splitModeEnabled, message.data.splitRatio || 50);
      }
      sendResponse({ success: true });
    } else if (message.action === 'previewSplit') {
      if (message.data) {
        applySplitMode(true, message.data.splitRatio || 50);
      }
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Unknown action in content script' });
    }
    return false; // Returns synchronously
  });

  function applyZenMode(enabled) {
    // Apply Zen Mode strictly to target environments, including split iframes
    if (isInIframe && !isSplitIframe) return;
    if (enabled) {
      if (zenModeStyleElement) return;
      zenModeStyleElement = document.createElement('style');
      zenModeStyleElement.id = 'cs-zen-mode-styles';
      zenModeStyleElement.textContent = `
        div#toolTopMenu, div#screenMenu, div#topCenterMenu,
        #shell-header, .sapUshellShellHead, #shell-hdr,
        .sapMPageHeader, .sapUshellShellHeadSearchContainer {
          display: none !important;
          visibility: hidden !important;
          height: 0 !important;
          overflow: hidden !important;
        }
        section[id*="pageOrderView-cont"], section[id*="PageMain-cont"],
        .sapMPage:not(.sapMMessagePage) {
          position: fixed !important;
          top: 0 !important; left: 0 !important;
          right: 0 !important; bottom: 0 !important;
          width: 100vw !important; height: 100vh !important;
          margin: 0 !important; padding: 0 !important; z-index: 100 !important;
        }
        #pageShell, div#pageShell { padding: 0 !important; margin: 0 !important; }
        .sapMPageFooter {
          position: fixed !important; bottom: 0 !important;
          left: 0 !important; width: 100% !important; z-index: 101 !important;
        }
      `;
      document.head.appendChild(zenModeStyleElement);
    } else {
      if (zenModeStyleElement) { zenModeStyleElement.remove(); zenModeStyleElement = null; }
    }
  }

  let splitRightIframe = null;
  let splitLeftIframe = null;

  function applySplitMode(enabled, ratio) {
    // Prevent recursive rendering within the generated split iframe
    if (isInIframe || isSplitIframe) return;
    if (enabled) {
      const leftPct = Math.max(20, Math.min(80, ratio));
      const rightPct = 100 - leftPct;
      const css = `

        body, html {
          overflow: hidden !important;
        }
        
        /* Hide native SAP Fiori to replace with dual iframes */
        #shell-hdr, .sapUshellShell, #shell-container, #canvas {
          display: none !important;
        }

        #cs-split-left-iframe {
          width: ${leftPct}vw !important;
          min-width: ${leftPct}vw !important;
          height: 100vh !important;
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          z-index: 2147480000 !important;
          border: none !important;
          box-sizing: border-box !important;
          background: #EDEFF0 !important;
        }

        #cs-split-right-iframe {
          width: ${rightPct}vw !important;
          min-width: ${rightPct}vw !important;
          height: 100vh !important;
          position: fixed !important;
          top: 0 !important;
          right: 0 !important;
          z-index: 2147480000 !important;
          border: none !important;
          border-left: 3px solid #E74C3C !important;
          box-sizing: border-box !important;
          background: #EDEFF0 !important;
        }
      `;
      if (splitModeStyleElement) {
        splitModeStyleElement.textContent = css;
      } else {
        splitModeStyleElement = document.createElement('style');
        splitModeStyleElement.id = 'cs-split-mode-styles';
        splitModeStyleElement.textContent = css;
        document.head.appendChild(splitModeStyleElement);
      }

      // Initialize split view target frames
      if (!splitRightIframe || !document.body.contains(splitRightIframe)) {
        splitRightIframe = document.createElement('iframe');
        splitRightIframe.id = 'cs-split-right-iframe';
        splitRightIframe.name = 'cs-split-right-iframe';
        splitRightIframe.src = window.location.href;
        document.body.appendChild(splitRightIframe);
      }

      if (!splitLeftIframe || !document.body.contains(splitLeftIframe)) {
        splitLeftIframe = document.createElement('iframe');
        splitLeftIframe.id = 'cs-split-left-iframe';
        splitLeftIframe.name = 'cs-split-left-iframe';
        splitLeftIframe.src = window.location.href;
        document.body.appendChild(splitLeftIframe);
      }

      // Sync Zen mode state to iframes shortly after creation to allow load
      setTimeout(() => {
        chrome.storage.local.get(['settings'], (res) => {
          const zenEnabled = res.settings?.zenMode === true;
          if (splitLeftIframe?.contentWindow) {
            splitLeftIframe.contentWindow.postMessage({ type: 'COLLECT_STORE_SYNC_MODES', zenMode: zenEnabled }, '*');
          }
          if (splitRightIframe?.contentWindow) {
            splitRightIframe.contentWindow.postMessage({ type: 'COLLECT_STORE_SYNC_MODES', zenMode: zenEnabled }, '*');
          }
        });
      }, 1000);
    } else {
      if (splitModeStyleElement) {
        splitModeStyleElement.remove();
        splitModeStyleElement = null;
      }
      if (splitRightIframe) {
        splitRightIframe.remove();
        splitRightIframe = null;
      }
      if (splitLeftIframe) {
        splitLeftIframe.remove();
        splitLeftIframe = null;
      }
    }
  }

  function createElement(tag, options = {}) {
    const el = document.createElement(tag);
    if (options.classes) options.classes.forEach(c => el.classList.add(c));
    if (options.text) el.textContent = options.text;
    if (options.id) el.id = options.id;
    if (options.styles) Object.assign(el.style, options.styles);
    if (options.attrs) Object.entries(options.attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }

  function closeAlertOverlay() {
    if (alertCountdownInterval) { cancelAnimationFrame(alertCountdownInterval); alertCountdownInterval = null; }
    // Ensure audio playback halts completely before deallocation
    const audioToStop = alertAudio;
    alertAudio = null;
    if (audioToStop) {
      try { audioToStop.pause(); audioToStop.currentTime = 0; } catch (e) { /* already gone */ }
    }
    if (escKeyHandler) { document.removeEventListener('keydown', escKeyHandler); escKeyHandler = null; }
    if (currentOverlay) {
      const fadingOverlay = currentOverlay;
      currentOverlay = null;
      fadingOverlay.style.opacity = '0';
      setTimeout(() => { fadingOverlay.remove(); }, 300);
    }
  }

  async function showAlertOverlay(data) {
    if (isInIframe) return;
    closeAlertOverlay();

    if (data.soundData?.startsWith('data:audio/')) {
      alertAudio = new Audio(data.soundData);
      alertAudio.play().catch(() => { });
    }

    const settings = await chrome.storage.local.get(['alertDurationSeconds', 'alertOverlay', 'alertStyle']);
    const seconds = parseInt(settings.alertDurationSeconds, 10) || 10;
    const isWoltOrder = data.orderType === 'wolt';
    const alertStyle = data.alertStyle || settings.alertStyle || 'default';

    const customization = data.alertOverlay || settings.alertOverlay || {
      position: 'bottom-center',
      mainTitle: 'Uusia collecteja!',
      subTitle: '',
      brandTag: 'C@S',
      counterLabel: 'Odottaa keräystä',
      fontSize: 'large'
    };

    // Render dynamic order typography for explicit context
    if (customization.mainTitle && customization.mainTitle.toLowerCase().includes('collect@store')) {
      customization.mainTitle = isWoltOrder ? 'WOLT!' : 'COLLECT!';
    }

    // Forcefully remove legacy default subtitles if they exist in the user's storage
    if (customization.subTitle === 'Nyt keräämään!!' || customization.subTitle === 'Nyt toimittamaan!!') {
      customization.subTitle = '';
    }

    const overlay = createElement('div', { id: 'cs-modern-overlay' });
    overlay.classList.add('cs-alert-overlay');
    overlay.setAttribute('data-order-type', isWoltOrder ? 'wolt' : 'collect');
    if (alertStyle !== 'default') overlay.setAttribute('data-alert-style', alertStyle);
    currentOverlay = overlay;
    if (isWoltOrder) overlay.classList.add('wolt-alert');

    // Style-specific rendering
    if (alertStyle !== 'default') {
      buildStyledAlert(overlay, data, customization, isWoltOrder, alertStyle);
    } else {
      buildDefaultAlert(overlay, data, customization, isWoltOrder);
    }

    // Bind close handler to overlay container
    overlay.addEventListener('click', closeAlertOverlay);


    const track = createElement('div', { classes: ['cs-progress-track'] });
    const bar = createElement('div', { classes: ['cs-progress-bar'] });
    track.appendChild(bar);
    overlay.appendChild(track);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });

    // Initialize animated countdown sequence
    bar.style.width = '100%';
    const startTime = performance.now();
    const totalMs = seconds * 1000;

    function updateProgressBar(now) {
      const elapsed = now - startTime;
      const remaining = Math.max(0, 1 - elapsed / totalMs);
      bar.style.width = `${remaining * 100}%`;

      if (remaining > 0) {
        alertCountdownInterval = requestAnimationFrame(updateProgressBar);
      } else {
        alertCountdownInterval = null;
        if (data.isSimulator) showSimulatorPostAlert();
        else closeAlertOverlay();
      }
    }
    bar.style.transition = 'none';
    alertCountdownInterval = requestAnimationFrame(updateProgressBar);

    escKeyHandler = (e) => { if (e.key === 'Escape') closeAlertOverlay(); };
    document.addEventListener('keydown', escKeyHandler);
  }

  function buildDefaultAlert(overlay, data, customization, isWoltOrder) {
    const bgLayer = createElement('div', { classes: ['cs-bg-layer'] });
    let hasMedia = false;

    if (data.videoData?.startsWith('data:video/')) {
      const vid = createElement('video', { classes: ['cs-media'], attrs: { autoplay: '', loop: '', playsinline: '', muted: '' } });
      vid.src = data.videoData;
      bgLayer.appendChild(vid);
      hasMedia = true;
      vid.play().catch(() => { });
    } else if (data.imageData?.startsWith('data:image/')) {
      const img = createElement('img', { classes: ['cs-media'] });
      img.src = data.imageData;
      bgLayer.appendChild(img);
      hasMedia = true;
    }

    if (!hasMedia) bgLayer.style.background = 'radial-gradient(circle at center, #2C3E50 0%, #000000 100%)';

    overlay.appendChild(bgLayer);
    overlay.appendChild(createElement('div', { classes: ['cs-gradient-overlay'] }));

    const hud = createElement('div', { classes: ['cs-hud-container', `pos-${customization.position || 'bottom-center'}`] });
    const sizeClass = `size-${customization.fontSize || 'large'}`;
    const textGroup = createElement('div', { classes: ['cs-text-group', sizeClass] });

    if (customization.brandTag) textGroup.appendChild(createElement('div', { classes: ['cs-brand-tag'], text: customization.brandTag }));
    if (customization.mainTitle) textGroup.appendChild(createElement('div', { classes: ['cs-main-title'], text: customization.mainTitle }));
    if (customization.subTitle) textGroup.appendChild(createElement('div', { classes: ['cs-sub-title'], text: customization.subTitle }));
    if (textGroup.children.length > 0) hud.appendChild(textGroup);

    const counterCard = createElement('div', { classes: ['cs-counter-card', sizeClass] });
    counterCard.appendChild(createElement('span', { classes: ['cs-count-num'], text: String(data.count || 1) }));
    if (customization.counterLabel) counterCard.appendChild(createElement('span', { classes: ['cs-count-label'], text: customization.counterLabel }));
    hud.appendChild(counterCard);
    overlay.appendChild(hud);
  }

  function buildStyledAlert(overlay, data, customization, isWoltOrder, style) {
    const count = data.count || 1;
    const brandColor = isWoltOrder ? '#00B2E3' : '#27AE60';

    // Base background rendering; individual style profiles govern further modifications
    const bgLayer = createElement('div', { classes: ['cs-bg-layer'] });
    let hasImage = false;
    if (data.imageData?.startsWith('data:image/')) {
      const img = createElement('img', { classes: ['cs-media'] });
      img.src = data.imageData;
      bgLayer.appendChild(img);
      hasImage = true;
    }
    overlay.appendChild(bgLayer);

    switch (style) {
      case 'scoreboard':
        buildScoreboard(overlay, bgLayer, data, customization, count, brandColor, hasImage, isWoltOrder);
        break;
      case 'emergency':
        buildEmergency(overlay, bgLayer, data, customization, count, brandColor, hasImage, isWoltOrder);
        break;
      case 'slotmachine':
        buildSlotMachine(overlay, bgLayer, data, customization, count, brandColor, hasImage, isWoltOrder);
        break;
      case 'shockwave':
        buildShockwave(overlay, bgLayer, data, customization, count, brandColor, hasImage, isWoltOrder);
        break;
      case 'tvstatic':
        buildTvStatic(overlay, bgLayer, data, customization, count, brandColor, hasImage, isWoltOrder);
        break;
      case 'matrix':
        buildMatrix(overlay, bgLayer, data, customization, count, brandColor, hasImage, isWoltOrder);
        break;
      case 'tetris':
        buildTetris(overlay, bgLayer, data, customization, count, brandColor, hasImage, isWoltOrder);
        break;
    }
  }

  // Initialize Scoreboard visual schema
  function buildScoreboard(overlay, bgLayer, data, cust, count, color, hasImg, isWolt) {
    if (hasImg) {
      const img = bgLayer.querySelector('.cs-media');
      if (img) {
        img.style.opacity = '0.35';
        img.style.filter = 'brightness(0.5) saturate(0.7)';
      }
    } else {
      bgLayer.style.background = 'linear-gradient(180deg, #0a0a2e 0%, #1a1a3e 40%, #0d1b2a 100%)';
    }
    overlay.classList.add('cs-style-scoreboard');

    // Generate ambient background spotlights
    for (let i = 0; i < 4; i++) {
      const beam = createElement('div', { classes: ['cs-scoreboard-beam'] });
      beam.style.cssText = `
        position: absolute;
        top: -20%;
        left: 50%;
        width: 8px;
        height: 140%;
        background: linear-gradient(180deg, rgba(255,215,0,0.3) 0%, transparent 70%);
        transform-origin: top center;
        z-index: 2;
        pointer-events: none;
        filter: blur(4px);
        animation: cs-scoreboard-beam-sweep ${4 + i * 0.5}s ease-in-out infinite alternate;
        animation-delay: ${i * -1}s;
      `;
      overlay.appendChild(beam);
    }


    const border = createElement('div', { classes: ['cs-scoreboard-border'] });
    overlay.appendChild(border);

    // Instantiate physical scoreboard panel
    const panel = createElement('div', { classes: ['cs-scoreboard-panel'] });
    panel.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: linear-gradient(180deg, #1a1a1a 0%, #0d0d0d 100%);
      border: 4px solid #333;
      border-radius: 12px;
      padding: 40px 80px;
      box-shadow: 0 0 60px rgba(255,200,0,0.2), 0 20px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.1);
      z-index: 10;
      text-align: center;
      min-width: 400px;
    `;

    // Generate LED header display
    const header = createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #333;
      padding-bottom: 15px;
      margin-bottom: 20px;
    `;

    const teamName = createElement('div', { text: isWolt ? 'WOLT' : 'COLLECT' });
    teamName.style.cssText = `
      font-size: 20px;
      font-weight: 700;
      color: ${color};
      letter-spacing: 4px;
      font-family: 'Courier New', monospace;
      text-shadow: 0 0 10px ${color};
    `;

    const liveWrap = createElement('div');
    liveWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const liveDot = createElement('div');
    liveDot.style.cssText = `
      width: 8px; height: 8px; border-radius: 50%; background: #ff0000;
      box-shadow: 0 0 6px #ff0000;
      animation: cs-emergency-flash 1s ease-in-out infinite;
    `;
    const liveText = createElement('div', { text: 'LIVE' });
    liveText.style.cssText = 'font-size:14px;font-weight:700;color:#ff0000;letter-spacing:2px;';
    liveWrap.appendChild(liveDot);
    liveWrap.appendChild(liveText);

    header.appendChild(teamName);
    header.appendChild(liveWrap);
    panel.appendChild(header);

    if (cust.mainTitle) {
      const title = createElement('div', { classes: ['cs-scoreboard-title'], text: cust.mainTitle });
      panel.appendChild(title);
    }

    // Render score tally interface
    const scoreWrap = createElement('div');
    scoreWrap.style.cssText = `
      background: #000;
      border-radius: 8px;
      padding: 20px 40px;
      margin: 15px 0;
      border: 2px solid #222;
      box-shadow: inset 0 0 20px rgba(0,0,0,0.8);
    `;
    const numEl = createElement('div', { classes: ['cs-scoreboard-num'], text: '0' });
    scoreWrap.appendChild(numEl);
    panel.appendChild(scoreWrap);

    // Execute tally animation sequence
    let counterFrame = 0;
    const counterDuration = 800;
    const counterStart = performance.now();
    function animateCounter(now) {
      const elapsed = now - counterStart;
      const progress = Math.min(1, elapsed / counterDuration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(eased * count);
      numEl.textContent = String(current);
      if (progress < 1) requestAnimationFrame(animateCounter);
    }
    requestAnimationFrame(animateCounter);

    if (cust.subTitle) {
      const sub = createElement('div', { classes: ['cs-scoreboard-sub'], text: cust.subTitle });
      panel.appendChild(sub);
    }

    // Initialize live broadcast ticker
    const ticker = createElement('div');
    ticker.style.cssText = `
      margin-top: 20px;
      padding-top: 15px;
      border-top: 1px solid #333;
      overflow: hidden;
      position: relative;
      height: 20px;
    `;
    const tickerText = createElement('div', { text: `${isWolt ? 'WOLT EXPRESS' : 'COLLECT@STORE'}  ●  ${count} ${isWolt ? 'pikatoimitusta' : 'noutotilausta'}  ●  LIVE  ●  ` });
    tickerText.style.cssText = `
      position: absolute;
      white-space: nowrap;
      font-size: 13px;
      font-family: 'Courier New', monospace;
      color: ${color};
      letter-spacing: 2px;
      animation: cs-scoreboard-ticker 10s linear infinite;
    `;
    ticker.appendChild(tickerText);
    panel.appendChild(ticker);

    overlay.appendChild(panel);

    // Render perimeter stadium lights
    for (let i = 0; i < 8; i++) {
      const light = createElement('div');
      const angle = (i / 8) * Math.PI * 2;
      const x = 50 + Math.cos(angle) * 45;
      const y = 50 + Math.sin(angle) * 45;
      light.style.cssText = `
        position: absolute;
        left: ${x}%;
        top: ${y}%;
        width: 6px;
        height: 6px;
        background: #FFD700;
        border-radius: 50%;
        z-index: 4;
        box-shadow: 0 0 20px 8px rgba(255,215,0,0.3);
        animation: cs-scoreboard-strobe 0.4s ease-in-out infinite alternate;
        animation-delay: ${i * 0.08}s;
      `;
      overlay.appendChild(light);
    }

    // Trigger confetti particle explosion
    for (let i = 0; i < 30; i++) {
      const confetti = createElement('div');
      const confettiColors = ['#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', color];
      const cColor = confettiColors[Math.floor(Math.random() * confettiColors.length)];
      const startX = 40 + Math.random() * 20;
      const endX = startX + (Math.random() - 0.5) * 60;
      const rotEnd = Math.random() * 720 - 360;
      confetti.style.cssText = `
        position: absolute;
        left: ${startX}%;
        top: 50%;
        width: ${4 + Math.random() * 6}px;
        height: ${4 + Math.random() * 6}px;
        background: ${cColor};
        z-index: 12;
        pointer-events: none;
        border-radius: ${Math.random() > 0.5 ? '50%' : '0'};
        animation: cs-scoreboard-confetti ${1.5 + Math.random() * 1.5}s cubic-bezier(0.2, 0.8, 0.3, 1) ${0.6 + Math.random() * 0.3}s both;
        --confetti-x: ${endX - startX}vw;
        --confetti-rot: ${rotEnd}deg;
      `;
      overlay.appendChild(confetti);
    }
  }

  // Initialize Emergency Broadcast visual schema
  function buildEmergency(overlay, bgLayer, data, cust, count, color, hasImg, isWolt) {
    if (hasImg) {
      const img = bgLayer.querySelector('.cs-media');
      if (img) {
        img.style.opacity = '0.2';
        img.style.filter = 'brightness(0.3) saturate(0) contrast(1.5)';
      }
    }
    bgLayer.style.background = hasImg ? 'rgba(200,0,0,0.7)' : '#cc0000';
    overlay.classList.add('cs-style-emergency');

    // Render hazard stripes
    const topStripe = createElement('div', { classes: ['cs-emergency-stripe'] });
    topStripe.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; height: 40px; z-index: 12;
      background: repeating-linear-gradient(
        -45deg, #000 0px, #000 20px, #FFD700 20px, #FFD700 40px
      );
      background-size: 200% 100%;
      animation: cs-emergency-stripe-scroll 2s linear infinite;
    `;
    const bottomStripe = topStripe.cloneNode(true);
    bottomStripe.style.top = 'auto';
    bottomStripe.style.bottom = '0';
    overlay.appendChild(topStripe);
    overlay.appendChild(bottomStripe);

    // Generate ambient alarm sweep
    const alarmLight = createElement('div');
    alarmLight.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 6;
      pointer-events: none;
      background: conic-gradient(from 0deg, transparent 0deg, rgba(255,0,0,0.15) 20deg, transparent 40deg);
      animation: cs-emergency-alarm-sweep 2s linear infinite;
    `;
    overlay.appendChild(alarmLight);

    // Apply CRT scanline overlay
    const scanLines = createElement('div');
    scanLines.style.cssText = `
      position: absolute; inset: 0; z-index: 7; pointer-events: none;
      background: repeating-linear-gradient(
        0deg, transparent 0px, transparent 2px, rgba(0,0,0,0.1) 2px, rgba(0,0,0,0.1) 4px
      );
    `;
    overlay.appendChild(scanLines);

    const border = createElement('div', { classes: ['cs-emergency-border'] });
    overlay.appendChild(border);

    const center = createElement('div', { classes: ['cs-emergency-center'] });


    const header = createElement('div', { classes: ['cs-emergency-header'], text: '⚠ ALERT ⚠' });
    center.appendChild(header);

    const numEl = createElement('div', { classes: ['cs-emergency-num'], text: String(count) });
    center.appendChild(numEl);

    const msg = createElement('div', { classes: ['cs-emergency-msg'], text: cust.mainTitle || 'Uusia tilauksia!' });
    center.appendChild(msg);

    if (cust.subTitle) {
      center.appendChild(createElement('div', { classes: ['cs-emergency-sub'], text: cust.subTitle }));
    }

    overlay.appendChild(center);
  }

  // Initialize Slot Machine visual schema
  function buildSlotMachine(overlay, bgLayer, data, cust, count, color, hasImg, isWolt) {
    if (hasImg) {
      const img = bgLayer.querySelector('.cs-media');
      if (img) {
        img.style.opacity = '0.2';
        img.style.filter = 'brightness(0.3) saturate(0.6) blur(3px)';
      }
    }
    bgLayer.style.background = hasImg
      ? 'linear-gradient(135deg, rgba(26,26,46,0.8) 0%, rgba(22,33,62,0.8) 50%, rgba(15,52,96,0.8) 100%)'
      : 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)';
    overlay.classList.add('cs-style-slotmachine');

    // Machine frame with marquee lights
    const machine = createElement('div', { classes: ['cs-slot-machine-frame'] });
    machine.style.cssText = `
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: linear-gradient(180deg, #2a1a3e 0%, #1a0a2e 100%);
      border: 6px solid #FFD700;
      border-radius: 20px;
      padding: 50px 60px 40px;
      box-shadow: 0 0 80px rgba(255,215,0,0.15), 0 30px 80px rgba(0,0,0,0.6), inset 0 0 40px rgba(255,215,0,0.05);
      z-index: 10;
      text-align: center;
      min-width: 500px;
    `;

    // Initialize chasing light sequence along machine perimeter
    for (let i = 0; i < 20; i++) {
      const bulb = createElement('div');
      // Distribute bulbs geometrically along border
      const perimeter = 2 * (500 + 400);
      const pos = (i / 20) * perimeter;
      let bx, by;
      if (pos < 500) { bx = pos; by = 0; }
      else if (pos < 500 + 400) { bx = 500; by = pos - 500; }
      else if (pos < 1000 + 400) { bx = 500 - (pos - 900); by = 400; }
      else { bx = 0; by = 400 - (pos - 1400); }
      const pctX = (bx / 500) * 100;
      const pctY = (by / 400) * 100;
      bulb.style.cssText = `
        position: absolute;
        left: ${pctX}%; top: ${pctY}%;
        width: 8px; height: 8px;
        background: #FFD700;
        border-radius: 50%;
        z-index: 11;
        box-shadow: 0 0 6px 2px rgba(255,215,0,0.6);
        animation: cs-slot-bulb-chase 1.5s ease-in-out infinite;
        animation-delay: ${i * 0.075}s;
      `;
      machine.appendChild(bulb);
    }

    // Initialize heading marquee
    if (cust.mainTitle) {
      const banner = createElement('div', { classes: ['cs-slot-title'], text: cust.mainTitle });
      banner.style.cssText += `;background: linear-gradient(90deg, transparent, rgba(255,215,0,0.15), transparent);
        padding: 8px 20px; border-radius: 8px; margin-bottom: 25px;`;
      machine.appendChild(banner);
    }

    const slotContainer = createElement('div', { classes: ['cs-slot-container'] });
    const digits = String(count).split('');

    digits.forEach((digit, i) => {
      const reel = createElement('div', { classes: ['cs-slot-reel'] });
      // Render horizontal reel indicator
      const highlightLine = createElement('div');
      highlightLine.style.cssText = `
        position: absolute; top: 50%; left: 0; right: 0; transform: translateY(-50%);
        height: 280px; border-top: 2px solid rgba(255,215,0,0.4);
        border-bottom: 2px solid rgba(255,215,0,0.4); z-index: 5; pointer-events: none;
      `;
      reel.appendChild(highlightLine);

      const strip = createElement('div', { classes: ['cs-slot-strip'] });
      // Interleaved digits for extended spin duration
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let n = 0; n <= 9; n++) {
          strip.appendChild(createElement('div', { classes: ['cs-slot-digit'], text: String(n) }));
        }
      }
      strip.appendChild(createElement('div', { classes: ['cs-slot-digit', 'cs-slot-final'], text: digit }));
      reel.appendChild(strip);
      strip.style.animationDelay = `${i * 0.3}s`;
      strip.style.animationDuration = `${1.5 + i * 0.3}s`;
      slotContainer.appendChild(reel);
    });

    machine.appendChild(slotContainer);

    if (cust.subTitle) {
      const sub = createElement('div', { classes: ['cs-slot-sub'], text: cust.subTitle });
      machine.appendChild(sub);
    }

    // Render deferred jackpot banner
    const jackpot = createElement('div', { text: isWolt ? 'WOLT!' : 'COLLECT!' });
    jackpot.style.cssText = `
      font-size: 28px; font-weight: 900; color: #FFD700; letter-spacing: 6px;
      text-shadow: 0 0 20px rgba(255,215,0,0.8);
      margin-top: 20px; opacity: 0;
      animation: cs-slot-jackpot-reveal 0.5s ease-out ${1.5 + digits.length * 0.3}s both;
    `;
    machine.appendChild(jackpot);

    overlay.appendChild(machine);

    // Trigger payload confetti upon reel cessation
    const burstDelay = 1.5 + digits.length * 0.3;
    for (let i = 0; i < 24; i++) {
      const coin = createElement('div');
      const angle = (i / 24) * Math.PI * 2;
      const distance = 100 + Math.random() * 200;
      coin.style.cssText = `
        position: absolute; left: 50%; top: 50%;
        width: ${10 + Math.random() * 8}px; height: ${10 + Math.random() * 8}px;
        background: ${Math.random() > 0.5 ? '#FFD700' : '#FFA500'};
        border-radius: 50%; z-index: 12; pointer-events: none;
        box-shadow: inset -2px -2px 0 rgba(0,0,0,0.3), 0 0 8px rgba(255,215,0,0.4);
        animation: cs-slot-coin-burst 1.2s cubic-bezier(0.2, 0.8, 0.3, 1) ${burstDelay}s both;
        --coin-x: ${Math.cos(angle) * distance}px;
        --coin-y: ${Math.sin(angle) * distance - 100}px;
        --coin-rot: ${Math.random() * 720}deg;
      `;
      overlay.appendChild(coin);
    }
  }

  // Initialize Shockwave visual schema
  function buildShockwave(overlay, bgLayer, data, cust, count, color, hasImg, isWolt) {
    if (hasImg) {
      const img = bgLayer.querySelector('.cs-media');
      if (img) {
        img.style.opacity = '0.25';
        img.style.filter = 'brightness(0.3) saturate(0.5)';
      }
    } else {
      bgLayer.style.background = '#0a0a0a';
    }
    overlay.classList.add('cs-style-shockwave');

    // Apply impact displacement
    overlay.style.animation = 'cs-shockwave-shake 0.4s ease-out';

    // Render focal impact burst
    const flash = createElement('div');
    flash.style.cssText = `
      position: absolute; inset: 0; z-index: 15; pointer-events: none;
      background: radial-gradient(circle, ${color} 0%, transparent 70%);
      animation: cs-shockwave-flash 0.3s ease-out forwards;
    `;
    overlay.appendChild(flash);

    const center = createElement('div', { classes: ['cs-shockwave-center'] });

    const numEl = createElement('div', { classes: ['cs-shockwave-num'], text: String(count) });
    numEl.style.color = color;
    numEl.style.textShadow = `0 0 80px ${color}, 0 0 160px ${color}`;
    center.appendChild(numEl);

    if (cust.mainTitle) center.appendChild(createElement('div', { classes: ['cs-shockwave-title'], text: cust.mainTitle }));
    if (cust.subTitle) center.appendChild(createElement('div', { classes: ['cs-shockwave-sub'], text: cust.subTitle }));

    overlay.appendChild(center);

    // Generate expanding energy rings
    for (let i = 0; i < 5; i++) {
      const ring = createElement('div', { classes: ['cs-shockwave-ring'] });
      ring.style.borderColor = color;
      ring.style.animationDelay = `${i * 0.2}s`;
      ring.style.borderWidth = `${4 - i * 0.5}px`;
      overlay.appendChild(ring);
    }

    // Trigger outward particle debris
    for (let i = 0; i < 40; i++) {
      const particle = createElement('div');
      const angle = Math.random() * Math.PI * 2;
      const distance = 200 + Math.random() * 500;
      const size = 2 + Math.random() * 4;
      particle.style.cssText = `
        position: absolute; left: 50%; top: 50%;
        width: ${size}px; height: ${size}px;
        background: ${color};
        border-radius: ${Math.random() > 0.3 ? '50%' : '0'};
        z-index: 9; pointer-events: none;
        box-shadow: 0 0 ${size * 2}px ${color};
        opacity: 0;
        animation: cs-shockwave-debris 1.5s cubic-bezier(0.1, 0.8, 0.2, 1) ${0.05 + Math.random() * 0.1}s both;
        --debris-x: ${Math.cos(angle) * distance}px;
        --debris-y: ${Math.sin(angle) * distance}px;
      `;
      overlay.appendChild(particle);
    }

    // Render structural fissure lines
    for (let i = 0; i < 8; i++) {
      const crack = createElement('div');
      const angle = (i / 8) * 360;
      crack.style.cssText = `
        position: absolute; top: 50%; left: 50%;
        width: 2px; height: 0;
        background: linear-gradient(180deg, ${color}, transparent);
        transform-origin: top center;
        transform: translate(-50%, 0) rotate(${angle}deg);
        z-index: 8; pointer-events: none; opacity: 0.4;
        animation: cs-shockwave-crack 0.6s ease-out 0.05s both;
      `;
      overlay.appendChild(crack);
    }

    // Initialize ambient afterglow
    const glow = createElement('div');
    glow.style.cssText = `
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 300px; height: 300px; border-radius: 50%;
      background: radial-gradient(circle, ${color}33 0%, transparent 70%);
      z-index: 7; pointer-events: none;
      animation: cs-shockwave-glow 2s ease-in-out 0.5s infinite alternate;
    `;
    overlay.appendChild(glow);
  }

  // Initialize TV Static visual schema
  function buildTvStatic(overlay, bgLayer, data, cust, count, color, hasImg, isWolt) {
    overlay.classList.add('cs-style-tvstatic');

    if (hasImg) {
      const img = bgLayer.querySelector('.cs-media');
      if (img) {
        img.style.opacity = '0.3';
        img.style.filter = 'brightness(0.4) saturate(0.6)';
        img.style.animation = 'cs-tv-cut-in 0.05s step-end 0.5s forwards';
        img.style.opacity = '0';
      }
    } else {
      bgLayer.style.background = '#111';
    }

    // Render CRT bevel curvature
    const crt = createElement('div');
    crt.style.cssText = `
      position: absolute; inset: 0; z-index: 20; pointer-events: none;
      box-shadow: inset 0 0 100px rgba(0,0,0,0.5), inset 0 0 200px rgba(0,0,0,0.3);
      border-radius: 20px;
    `;
    overlay.appendChild(crt);

    // Apply ambient CRT scan lines
    const scanLines = createElement('div');
    scanLines.style.cssText = `
      position: absolute; inset: 0; z-index: 18; pointer-events: none;
      background: repeating-linear-gradient(
        0deg, transparent 0px, transparent 1px, rgba(0,0,0,0.08) 1px, rgba(0,0,0,0.08) 2px
      );
    `;
    overlay.appendChild(scanLines);

    // Render VHS tracking band
    const vhsTrack = createElement('div');
    vhsTrack.style.cssText = `
      position: absolute; left: 0; right: 0;
      height: 8px; z-index: 19; pointer-events: none;
      background: linear-gradient(90deg, transparent 10%, rgba(255,255,255,0.3) 30%, rgba(255,255,255,0.5) 50%, rgba(255,255,255,0.3) 70%, transparent 90%);
      animation: cs-tv-vhs-tracking 3s linear infinite;
    `;
    overlay.appendChild(vhsTrack);

    // Apply static interference
    const staticEl = createElement('div', { classes: ['cs-tv-static'] });
    overlay.appendChild(staticEl);

    // Render overlay channel beacon
    const channelNum = createElement('div');
    channelNum.style.cssText = `
      position: absolute; top: 40px; right: 50px; z-index: 16; pointer-events: none;
      font-family: 'Courier New', monospace; font-size: 40px; font-weight: 900;
      color: #0f0; text-shadow: 0 0 10px #0f0;
      opacity: 0;
      animation: cs-tv-channel-flash 0.5s step-end 0.5s both;
    `;
    channelNum.textContent = `CH ${isWolt ? '02' : '01'}`;
    overlay.appendChild(channelNum);

    // Initialize focal alert container
    const content = createElement('div', { classes: ['cs-tv-content'] });

    const center = createElement('div', { classes: ['cs-tv-center'] });

    if (cust.brandTag) center.appendChild(createElement('div', { classes: ['cs-tv-brand'], text: cust.brandTag }));

    const numEl = createElement('div', { classes: ['cs-tv-num'], text: String(count) });
    // Apply phosphor bloom
    numEl.style.textShadow = '0 0 40px rgba(255,255,255,0.3), 0 0 80px rgba(255,255,255,0.1)';
    center.appendChild(numEl);

    if (cust.mainTitle) center.appendChild(createElement('div', { classes: ['cs-tv-title'], text: cust.mainTitle }));
    if (cust.subTitle) center.appendChild(createElement('div', { classes: ['cs-tv-sub'], text: cust.subTitle }));

    // Initialize recording indicator
    const rec = createElement('div');
    rec.style.cssText = `
      display: flex; align-items: center; gap: 8px; margin-top: 30px;
      justify-content: center;
    `;
    const recDot = createElement('div');
    recDot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#f00;box-shadow:0 0 8px #f00;animation:cs-emergency-flash 1s ease-in-out infinite;';
    const recText = createElement('div', { text: 'REC' });
    recText.style.cssText = 'font-family:"Courier New",monospace;font-size:16px;color:#f00;font-weight:700;letter-spacing:3px;';
    rec.appendChild(recDot);
    rec.appendChild(recText);
    center.appendChild(rec);

    content.appendChild(center);
    overlay.appendChild(content);
  }

  // Initialize Matrix visual schema
  function buildMatrix(overlay, bgLayer, data, cust, count, color, hasImg, isWolt) {
    if (hasImg) {
      // Establish darkened matrix backdrop
      const img = bgLayer.querySelector('.cs-media');
      if (img) {
        img.style.opacity = '0.25';
        img.style.filter = 'brightness(0.4) saturate(0.5)';
      }
    } else {
      bgLayer.style.background = '#000';
    }
    overlay.classList.add('cs-style-matrix');

    // Render digital rain vertical axes
    const rainContainer = createElement('div', { classes: ['cs-matrix-rain'] });
    const chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEF';
    const columns = Math.floor(window.innerWidth / 20);

    for (let i = 0; i < Math.min(columns, 80); i++) {
      const col = createElement('div', { classes: ['cs-matrix-col'] });
      col.style.left = `${(i / columns) * 100}%`;
      col.style.animationDuration = `${1.5 + Math.random() * 2}s`;
      col.style.animationDelay = `${Math.random() * 2}s`;
      // Populate column with obfuscated glyphs
      let text = '';
      for (let j = 0; j < 30; j++) {
        text += chars[Math.floor(Math.random() * chars.length)] + '\n';
      }
      col.textContent = text;
      rainContainer.appendChild(col);
    }
    overlay.appendChild(rainContainer);

    // Render focal count spotlight
    const center = createElement('div', { classes: ['cs-matrix-center'] });
    const numEl = createElement('div', { classes: ['cs-matrix-num'], text: String(count) });
    numEl.style.color = color;
    center.appendChild(numEl);
    if (cust.mainTitle) center.appendChild(createElement('div', { classes: ['cs-matrix-title'], text: cust.mainTitle }));
    if (cust.subTitle) center.appendChild(createElement('div', { classes: ['cs-matrix-sub'], text: cust.subTitle }));
    overlay.appendChild(center);
  }

  // Initialize Tetris visual schema
  function buildTetris(overlay, bgLayer, data, cust, count, color, hasImg, isWolt) {
    if (hasImg) {
      const img = bgLayer.querySelector('.cs-media');
      if (img) {
        img.style.opacity = '0.15';
        img.style.filter = 'brightness(0.3) saturate(0.4)';
      }
    } else {
      bgLayer.style.background = '#0a0a1a';
    }
    overlay.classList.add('cs-style-tetris');

    // Calculate viewport-relative board dimensions
    const COLS = 20;
    const ROWS = 22;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cellSize = Math.min(Math.floor(vw / (COLS + 4)), Math.floor(vh / ROWS));
    const boardW = cellSize * COLS;
    const boardH = cellSize * ROWS;

    // Initialize focal board container
    const board = createElement('div', { classes: ['cs-tetris-board'] });
    board.style.width = boardW + 'px';
    board.style.height = boardH + 'px';
    board.style.position = 'absolute';
    board.style.left = '50%';
    board.style.top = '50%';
    board.style.transform = 'translate(-50%, -50%)';
    board.style.zIndex = '5';

    // Render background grid lattice
    const gridCanvas = createElement('canvas', { classes: ['cs-tetris-grid-canvas'] });
    gridCanvas.width = boardW;
    gridCanvas.height = boardH;
    gridCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;pointer-events:none;';
    board.appendChild(gridCanvas);
    const gctx = gridCanvas.getContext('2d');
    gctx.strokeStyle = 'rgba(255,255,255,0.05)';
    gctx.lineWidth = 1;
    for (let x = 0; x <= COLS; x++) {
      gctx.beginPath(); gctx.moveTo(x * cellSize, 0); gctx.lineTo(x * cellSize, boardH); gctx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
      gctx.beginPath(); gctx.moveTo(0, y * cellSize); gctx.lineTo(boardW, y * cellSize); gctx.stroke();
    }

    // Board border (Tetris frame)
    board.style.border = '3px solid rgba(255,255,255,0.2)';
    board.style.borderRadius = '4px';
    board.style.boxShadow = '0 0 40px rgba(0,0,0,0.5), inset 0 0 20px rgba(0,0,0,0.3)';
    board.style.overflow = 'hidden';
    board.style.background = 'rgba(0,0,0,0.6)';

    overlay.appendChild(board);

    // Instantiate Tetromino payload configurations (Standard 7)
    const SHAPES = {
      I: { blocks: [[0, 0], [1, 0], [2, 0], [3, 0]], color: '#00F0F0' },
      O: { blocks: [[0, 0], [1, 0], [0, 1], [1, 1]], color: '#F0F000' },
      T: { blocks: [[0, 0], [1, 0], [2, 0], [1, 1]], color: '#A000F0' },
      S: { blocks: [[1, 0], [2, 0], [0, 1], [1, 1]], color: '#00F000' },
      Z: { blocks: [[0, 0], [1, 0], [1, 1], [2, 1]], color: '#F00000' },
      J: { blocks: [[0, 0], [0, 1], [1, 1], [2, 1]], color: '#0000F0' },
      L: { blocks: [[2, 0], [0, 1], [1, 1], [2, 1]], color: '#F0A000' }
    };
    const shapeKeys = Object.keys(SHAPES);

    // Map digit formations across 5x7 block grid structure
    const DIGIT_PATTERNS = {
      '0': [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 1, 1],
        [1, 0, 1, 0, 1],
        [1, 1, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0]
      ],
      '1': [
        [0, 0, 1, 0, 0],
        [0, 1, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 1, 1, 1, 0]
      ],
      '2': [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [0, 0, 0, 0, 1],
        [0, 0, 1, 1, 0],
        [0, 1, 0, 0, 0],
        [1, 0, 0, 0, 0],
        [1, 1, 1, 1, 1]
      ],
      '3': [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [0, 0, 0, 0, 1],
        [0, 0, 1, 1, 0],
        [0, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0]
      ],
      '4': [
        [0, 0, 0, 1, 0],
        [0, 0, 1, 1, 0],
        [0, 1, 0, 1, 0],
        [1, 0, 0, 1, 0],
        [1, 1, 1, 1, 1],
        [0, 0, 0, 1, 0],
        [0, 0, 0, 1, 0]
      ],
      '5': [
        [1, 1, 1, 1, 1],
        [1, 0, 0, 0, 0],
        [1, 1, 1, 1, 0],
        [0, 0, 0, 0, 1],
        [0, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0]
      ],
      '6': [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 0],
        [1, 0, 0, 0, 0],
        [1, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0]
      ],
      '7': [
        [1, 1, 1, 1, 1],
        [0, 0, 0, 0, 1],
        [0, 0, 0, 1, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0]
      ],
      '8': [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0]
      ],
      '9': [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 1],
        [0, 0, 0, 0, 1],
        [0, 0, 0, 0, 1],
        [0, 1, 1, 1, 0]
      ]
    };

    const countStr = String(count);
    const digitCount = countStr.length;
    // Calculate centered block placement coordinates
    const digitWidth = 5;
    const digitHeight = 7;
    const gap = 2;
    const totalWidth = digitCount * digitWidth + (digitCount - 1) * gap;
    const offsetX = Math.floor((COLS - totalWidth) / 2);
    const offsetY = Math.floor((ROWS - digitHeight) / 2);

    // Accumulate target payload coordinates
    const targetCells = [];
    countStr.split('').forEach((digit, dIdx) => {
      const pattern = DIGIT_PATTERNS[digit] || DIGIT_PATTERNS['0'];
      const dx = offsetX + dIdx * (digitWidth + gap);
      for (let row = 0; row < digitHeight; row++) {
        for (let col = 0; col < digitWidth; col++) {
          if (pattern[row][col]) {
            targetCells.push({ x: dx + col, y: offsetY + row });
          }
        }
      }
    });

    // Distribute ambient filler geometry for organic aesthetic
    const fillerCells = [];
    for (let y = ROWS - 3; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        // Exclude active target payload positions
        const isTarget = targetCells.some(c => c.x === x && c.y === y);
        if (!isTarget && Math.random() < 0.6) {
          fillerCells.push({ x, y });
        }
      }
    }

    // Orchestrate cascading deployment sequence
    const allBlocks = [];
    const BLOCK_COLORS = ['#00F0F0', '#F0F000', '#A000F0', '#00F000', '#F00000', '#0000F0', '#F0A000'];

    // Deploy ambient filler geometry
    fillerCells.forEach((cell, i) => {
      const block = createElement('div', { classes: ['cs-tetris-cell'] });
      block.style.cssText = `
        position: absolute;
        left: ${cell.x * cellSize}px;
        top: ${cell.y * cellSize}px;
        width: ${cellSize - 1}px;
        height: ${cellSize - 1}px;
        background: ${BLOCK_COLORS[Math.floor(Math.random() * BLOCK_COLORS.length)]};
        border-radius: 2px;
        z-index: 2;
        opacity: 0.4;
        box-shadow: inset 1px 1px 0 rgba(255,255,255,0.3), inset -1px -1px 0 rgba(0,0,0,0.3);
        animation: cs-tetris-drop ${0.3 + Math.random() * 0.2}s cubic-bezier(0.22, 1, 0.36, 1) ${i * 0.01}s both;
      `;
      board.appendChild(block);
    });

    // Sequence target payload column drops vertically
    const columnGroups = {};
    targetCells.forEach(cell => {
      if (!columnGroups[cell.x]) columnGroups[cell.x] = [];
      columnGroups[cell.x].push(cell);
    });
    const sortedColumns = Object.keys(columnGroups).map(Number).sort((a, b) => a - b);

    sortedColumns.forEach((colX, colIdx) => {
      const colCells = columnGroups[colX].sort((a, b) => a.y - b.y);
      // Assign monochromatic mapping per payload column
      const colColor = BLOCK_COLORS[colIdx % BLOCK_COLORS.length];
      colCells.forEach((cell, rowIdx) => {
        const block = createElement('div', { classes: ['cs-tetris-cell'] });
        // Execute staggered drop kinetics
        const delay = 0.3 + colIdx * 0.12 + rowIdx * 0.02;
        block.style.cssText = `
          position: absolute;
          left: ${cell.x * cellSize}px;
          top: ${cell.y * cellSize}px;
          width: ${cellSize - 1}px;
          height: ${cellSize - 1}px;
          background: ${colColor};
          border-radius: 2px;
          z-index: 3;
          box-shadow: inset 2px 2px 0 rgba(255,255,255,0.4), inset -2px -2px 0 rgba(0,0,0,0.3);
          animation: cs-tetris-drop 0.35s cubic-bezier(0.22, 1, 0.36, 1) ${delay}s both;
        `;
        board.appendChild(block);
      });
    });

    // Animate background descending tetromino elements
    const columnSlots = [];
    for (let c = 0; c < COLS - 3; c += 4) columnSlots.push(c);
    // Randomize column trajectory distributions
    for (let i = columnSlots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [columnSlots[i], columnSlots[j]] = [columnSlots[j], columnSlots[i]];
    }

    const usedSlots = columnSlots.slice(0, Math.min(8, columnSlots.length));
    usedSlots.forEach((startX, t) => {
      // Cycle overlapping payloads
      for (let cycle = 0; cycle < 2; cycle++) {
        const shapeKey = shapeKeys[(t + cycle) % shapeKeys.length];
        const shape = SHAPES[shapeKey];
        const tetro = createElement('div', { classes: ['cs-tetris-falling-piece'] });
        const fallDuration = 2.5 + (t % 3) * 0.8;
        const delay = cycle * fallDuration + t * 0.3;
        tetro.style.cssText = `
          position: absolute;
          left: ${startX * cellSize}px;
          top: -${cellSize * 4}px;
          z-index: 1;
          opacity: 0.2;
          animation: cs-tetris-bg-fall ${fallDuration}s linear ${delay}s infinite;
        `;
        shape.blocks.forEach(([bx, by]) => {
          const b = createElement('div');
          b.style.cssText = `
            position: absolute;
            left: ${bx * cellSize}px;
            top: ${by * cellSize}px;
            width: ${cellSize - 1}px;
            height: ${cellSize - 1}px;
            background: ${shape.color};
            border-radius: 2px;
            box-shadow: inset 1px 1px 0 rgba(255,255,255,0.2);
          `;
          tetro.appendChild(b);
        });
        board.appendChild(tetro);
      }
    });

    // Render typography layer
    const textOverlay = createElement('div', { classes: ['cs-tetris-text-overlay'] });
    const boardTop = (vh - boardH) / 2;
    textOverlay.style.cssText = `position:absolute;top:${Math.max(10, boardTop - 70)}px;left:0;right:0;text-align:center;z-index:15;`;

    if (cust.mainTitle) {
      const title = createElement('div', { classes: ['cs-tetris-title'], text: cust.mainTitle });
      textOverlay.appendChild(title);
    }
    if (cust.subTitle) {
      const sub = createElement('div', { classes: ['cs-tetris-sub'], text: cust.subTitle });
      textOverlay.appendChild(sub);
    }
    overlay.appendChild(textOverlay);

    // Initialize ambient 'Next Piece' preview panel
    const sidePanel = createElement('div', { classes: ['cs-tetris-side-panel'] });
    const sidePanelLeft = (vw + boardW) / 2 + 20;
    sidePanel.style.cssText = `
      position: absolute;
      left: ${sidePanelLeft}px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 6;
      padding: 15px;
      background: rgba(0,0,0,0.5);
      border: 2px solid rgba(255,255,255,0.15);
      border-radius: 8px;
    `;
    const nextLabel = createElement('div', { text: 'NEXT' });
    nextLabel.style.cssText = 'color:rgba(255,255,255,0.5);font-size:14px;font-weight:700;letter-spacing:3px;text-align:center;margin-bottom:10px;font-family:monospace;';
    sidePanel.appendChild(nextLabel);

    // Render randomized sequence projection
    for (let p = 0; p < 3; p++) {
      const sk = shapeKeys[Math.floor(Math.random() * shapeKeys.length)];
      const sh = SHAPES[sk];
      const previewWrap = createElement('div');
      previewWrap.style.cssText = `position:relative;width:${cellSize * 4}px;height:${cellSize * 3}px;margin-bottom:10px;`;
      sh.blocks.forEach(([bx, by]) => {
        const b = createElement('div');
        const ps = Math.floor(cellSize * 0.8);
        b.style.cssText = `
          position:absolute;
          left:${bx * ps}px;top:${by * ps}px;
          width:${ps - 1}px;height:${ps - 1}px;
          background:${sh.color};border-radius:2px;
          box-shadow: inset 1px 1px 0 rgba(255,255,255,0.3);
        `;
        previewWrap.appendChild(b);
      });
      sidePanel.appendChild(previewWrap);
    }

    // Render score tally interface
    const scoreEl = createElement('div');
    scoreEl.style.cssText = 'color:#fff;font-family:monospace;font-size:14px;margin-top:15px;text-align:center;';
    scoreEl.innerHTML = `<div style="color:rgba(255,255,255,0.5);font-size:12px;letter-spacing:2px;">SCORE</div><div style="font-size:24px;font-weight:700;color:#F0F000;">${count * 1000}</div>`;
    sidePanel.appendChild(scoreEl);

    // Enforce responsive panel visibility
    if (sidePanelLeft + 120 < vw) {
      overlay.appendChild(sidePanel);
    }

    // Compile and inject dynamic CSS payload
    const tetrisExtraStyle = document.createElement('style');
    tetrisExtraStyle.textContent = `
      @keyframes cs-tetris-bg-fall {
        0% { transform: translateY(0); }
        100% { transform: translateY(${boardH + cellSize * 8}px); }
      }
    `;
    overlay.appendChild(tetrisExtraStyle);
  }

  function showSimulatorPostAlert() {
    if (!currentOverlay) return;
    if (alertCountdownInterval) { clearInterval(alertCountdownInterval); alertCountdownInterval = null; }

    const progressTrack = currentOverlay.querySelector('.cs-progress-track');
    if (progressTrack) progressTrack.style.opacity = '0';

    const hud = currentOverlay.querySelector('.cs-hud-container');
    if (hud) {
      hud.innerHTML = '';
      hud.className = 'cs-hud-container pos-center';
      const replayBtn = createElement('button', {
        text: '↺ Toista uudelleen',
        classes: ['cs-close-fab'],
        styles: {
          position: 'relative', top: 'auto', right: 'auto',
          width: 'auto', height: 'auto', padding: '12px 24px',
          borderRadius: '8px', fontSize: '16px', marginTop: '20px', cursor: 'pointer'
        }
      });
      replayBtn.onclick = () => { closeAlertOverlay(); setTimeout(() => location.reload(), 300); };
      hud.appendChild(replayBtn);
    }
  }
})();