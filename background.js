﻿importScripts('idb.js');

// Keep the service worker alive by pinging storage periodically
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    chrome.storage.local.get('lastCheck').then(() => { }).catch(() => { });
  }
  if (alarm.name === 'poll') {
    forwardCheckToContent();
  }
});

// Track consecutive errors to implement exponential backoff
let consecutiveErrors = 0;
const MAX_BACKOFF_MULTIPLIER = 8;

function schedulePollAlarm() {
  chrome.storage.local.get('pollIntervalSeconds').then(({ pollIntervalSeconds }) => {
    const baseSec = Math.max(5, Math.min(60, parseInt(pollIntervalSeconds, 10) || 30));
    const multiplier = Math.min(MAX_BACKOFF_MULTIPLIER, Math.pow(2, consecutiveErrors));
    const delaySec = baseSec * multiplier;
    chrome.alarms.create('poll', { delayInMinutes: delaySec / 60 });
  }).catch(() => {
    chrome.alarms.create('poll', { delayInMinutes: 0.5 });
  });
}

schedulePollAlarm();

const DEFAULT_CONFIG = {
  pollIntervalSeconds: 30,
  soundEnabled: true,
  alertDurationSeconds: 15,
  completedStatuses: [
    'PC', 'COMPLETED', 'PICKED', 'CANCELLED', 'DELIVERED', 'HANDED OVER',
    'VALMIS', 'NOUDETTU', 'TOIMITETTU', 'PERUTTU', 'LUOVUTETTU',
    'LASKUTETTU', 'ARCHIVED', 'ARKISTOITU', 'DONE'
  ],
  collectKeywords: ['collect', 'pickup', 'pick-up', 'store', 'click & collect'],
  collectCodes: ['collect', 'pickup', 'zcs', 'c&c', 'cac', 'cas'],
  shippingKeywords: ['home delivery', 'ship', 'hd', 'home'],
  woltKeywords: ['express delivery', 'express', 'ad-hoc', 'adhoc', 'fast', 'wolt', 'pikatilaus', 'pikatoimitus', 'same day', 'sameday', 'nopea', 'quick', 'rapid', 'instant'],
  woltCodes: ['express', 'adhoc', 'fast', 'wolt', 'exp', 'sd', 'pike', 'quick', 'rapid'],
  alertOverlay: {
    position: 'center',
    mainTitle: 'Collect@Store!',
    subTitle: '',
    brandTag: '',
    counterLabel: '',
    fontSize: 'massive',
    emphasisAnim: true
  },
  tts: {
    enabled: false,
    volume: 1.0,
    collectText: '{count} uutta Collect@Store tilausta!',
    woltText: '{count} uutta Wolt tilausta!'
  },
  darkMode: false,
  shiftHistory: {
    enabled: true,
    sessionStart: null,
    orders: []
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const settings = await chrome.storage.local.get('configInitialized');
    if (!settings.configInitialized) {
      await chrome.storage.local.set({ ...DEFAULT_CONFIG, configInitialized: true });
    }
  } catch (e) { console.warn('onInstalled error:', e); }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'checkNow':
          await forwardCheckToContent();
          sendResponse({ success: true });
          break;

        case 'updateOrders':
          await handleOrderUpdate(message.data);
          sendResponse({ success: true });
          break;

        case 'updateSettings':
          sendResponse({ success: true });
          break;

        case 'getConfig': {
          const config = await chrome.storage.local.get([
            'completedStatuses', 'collectKeywords', 'collectCodes',
            'shippingKeywords', 'woltKeywords', 'woltCodes', 'alertOverlay',
            'tts', 'darkMode', 'shiftHistory'
          ]);
          sendResponse({
            success: true,
            config: {
              completedStatuses: config.completedStatuses || DEFAULT_CONFIG.completedStatuses,
              collectKeywords: config.collectKeywords || DEFAULT_CONFIG.collectKeywords,
              collectCodes: config.collectCodes || DEFAULT_CONFIG.collectCodes,
              shippingKeywords: config.shippingKeywords || DEFAULT_CONFIG.shippingKeywords,
              woltKeywords: config.woltKeywords || DEFAULT_CONFIG.woltKeywords,
              woltCodes: config.woltCodes || DEFAULT_CONFIG.woltCodes,
              alertOverlay: config.alertOverlay || DEFAULT_CONFIG.alertOverlay,
              tts: config.tts || DEFAULT_CONFIG.tts,
              darkMode: config.darkMode || DEFAULT_CONFIG.darkMode,
              shiftHistory: config.shiftHistory || DEFAULT_CONFIG.shiftHistory
            }
          });
          break;
        }

        case 'getDashboardData': {
          const data = await getDashboardData();
          sendResponse({ success: true, data });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();
  return true;
});

async function forwardCheckToContent() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://launchpad.elkjop.com/*' });
    if (tabs.length === 0) {
      consecutiveErrors++;
      await chrome.storage.local.set({ connectionStatus: 'error', lastError: 'Avaa Launchpad', lastCheck: Date.now() });
      schedulePollAlarm();
      return;
    }

    let successCount = 0;
    for (const tab of tabs) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'triggerCheck' });
        if (response?.success) successCount++;
      } catch (e) { // initial send failed
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['overlay.css'] });
          await new Promise(r => setTimeout(r, 500));
          const retry = await chrome.tabs.sendMessage(tab.id, { action: 'triggerCheck' });
          if (retry?.success) successCount++;
        } catch (injectError) { console.warn('inject retry failed:', injectError); }
      }
    }

    if (successCount > 0) {
      consecutiveErrors = 0;
      await chrome.storage.local.set({ connectionStatus: 'connected', lastError: null, lastCheck: Date.now() });
    } else {
      consecutiveErrors++;
      await chrome.storage.local.set({ connectionStatus: 'error', lastError: 'Tab ei vastaa', lastCheck: Date.now() });
    }
  } catch (error) {
    consecutiveErrors++;
    throw error;
  } finally {
    schedulePollAlarm();
  }
}

async function handleOrderUpdate(data) {
  try {
    const incomingCollect = parseInt(data?.collectCount, 10) || 0;
    const incomingWolt = parseInt(data?.woltCount, 10) || 0;
    const storeName = data?.storeName || '';
    const pendingOrders = Array.isArray(data?.pendingOrders) ? data.pendingOrders : [];

    const prev = await chrome.storage.local.get([
      'collectCount', 'woltCount', 'notifiedCount', 'notifiedWoltCount', 'tts', 'shiftHistory',
      'consecutiveCollectZeros', 'consecutiveWoltZeros'
    ]);

    const prevCollect = parseInt(prev.collectCount, 10) || 0;
    const prevWolt = parseInt(prev.woltCount, 10) || 0;
    let consecutiveCollectZeros = parseInt(prev.consecutiveCollectZeros, 10) || 0;
    let consecutiveWoltZeros = parseInt(prev.consecutiveWoltZeros, 10) || 0;

    // Protect against count loss during subpage navigation:
    // If incoming is 0, we delay accepting it until 2 consecutive zero readings 
    // to prevent drops when subpages temporarily lose order context.
    let collectCount, woltCount;
    if (incomingCollect === 0 && prevCollect > 0) {
      consecutiveCollectZeros++;
      collectCount = consecutiveCollectZeros >= 2 ? 0 : prevCollect;
    } else {
      consecutiveCollectZeros = 0;
      collectCount = incomingCollect;
    }
    if (incomingWolt === 0 && prevWolt > 0) {
      consecutiveWoltZeros++;
      woltCount = consecutiveWoltZeros >= 2 ? 0 : prevWolt;
    } else {
      consecutiveWoltZeros = 0;
      woltCount = incomingWolt;
    }

    const notifiedCount = parseInt(prev.notifiedCount, 10) || 0;
    const notifiedWoltCount = parseInt(prev.notifiedWoltCount, 10) || 0;

    const hasNewCollect = collectCount > notifiedCount;
    const hasNewWolt = woltCount > notifiedWoltCount;

    if (hasNewWolt) {
      const newWoltOrders = woltCount - notifiedWoltCount;
      await chrome.storage.local.set({ alertWoltOrderCount: newWoltOrders });
      await showContentAlert(woltCount, newWoltOrders, 'wolt');
      if (prev.tts?.enabled) {
        const ttsText = buildTtsText(newWoltOrders, prev.tts.woltText, 'Wolt');
        const vol = Math.min(1, (prev.tts.volume || 80) / 100);
        speakText(ttsText, vol);
      }
      await addToShiftHistory(newWoltOrders, 'wolt', prev.shiftHistory);
    }

    if (hasNewCollect) {
      const newOrders = collectCount - notifiedCount;
      await chrome.storage.local.set({ alertOrderCount: newOrders });
      await showContentAlert(collectCount, newOrders, 'collect');
      if (prev.tts?.enabled) {
        const ttsText = buildTtsText(newOrders, prev.tts.collectText, 'Collect');
        const vol = Math.min(1, (prev.tts.volume || 80) / 100);
        speakText(ttsText, vol);
      }
      await addToShiftHistory(newOrders, 'collect', prev.shiftHistory);
    }

    await chrome.storage.local.set({
      collectCount,
      woltCount,
      notifiedCount: collectCount,
      notifiedWoltCount: woltCount,
      storeName,
      connectionStatus: 'connected',
      lastCheck: Date.now(),
      lastError: null,
      pendingOrders,
      oldestOrderTimestamp: data?.oldestOrderTimestamp || data?.collectOldestTimestamp || null,
      consecutiveCollectZeros,
      consecutiveWoltZeros
    });

    updateBadge(collectCount, woltCount);

  } catch (error) {
    throw error;
  }
}

function updateBadge(collectCount, woltCount) {
  try {
    const total = collectCount + woltCount;
    chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
    if (collectCount > 0 && woltCount > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#E74C3C' });
    } else if (woltCount > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#00B2E3' });
    } else {
      chrome.action.setBadgeBackgroundColor({ color: '#27AE60' });
    }
  } catch (e) { console.warn('updateBadge error:', e); }
}

async function showContentAlert(totalCount, newCount, orderType = 'collect') {
  try {
    const settings = await chrome.storage.local.get(['soundEnabled', 'alertOverlay', 'alertStyle']);
    if (settings.soundEnabled === false) return;

    const isWolt = orderType === 'wolt';
    let soundData, imageData, videoData;

    // Fetch all 6 media keys in one round-trip
    const [
      collectSound, collectImage, collectVideo,
      woltSound, woltImage, woltVideo
    ] = await Promise.all([
      MediaDB.getMediaAsDataURL('soundData'),
      MediaDB.getMediaAsDataURL('imageData'),
      MediaDB.getMediaAsDataURL('videoData'),
      MediaDB.getMediaAsDataURL('woltSoundData'),
      MediaDB.getMediaAsDataURL('woltImageData'),
      MediaDB.getMediaAsDataURL('woltVideoData')
    ]);

    if (isWolt) {
      soundData = woltSound || collectSound;
      imageData = woltImage || collectImage;
      videoData = woltVideo || collectVideo;
    } else {
      soundData = collectSound;
      imageData = collectImage;
      videoData = collectVideo;
    }

    let alertOverlay = settings.alertOverlay || DEFAULT_CONFIG.alertOverlay;
    if (isWolt) {
      alertOverlay = { ...alertOverlay, mainTitle: 'Wolt!', subTitle: '', brandTag: 'WOLT' };
    }

    const tabs = await chrome.tabs.query({ url: 'https://launchpad.elkjop.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'showAlert',
          data: { count: totalCount, newCount, orderType, soundData, videoData, imageData, alertOverlay, alertStyle: settings.alertStyle || 'default' }
        });
        return;
      } catch (e) { console.warn('showContentAlert tab send error:', e); }
    }
  } catch (e) { console.warn('showContentAlert error:', e); }
}

async function getDashboardData() {
  try {
    const storage = await chrome.storage.local.get(['collectCount', 'woltCount', 'pendingOrders']);
    const collectCount = parseInt(storage.collectCount, 10) || 0;
    const woltCount = parseInt(storage.woltCount, 10) || 0;
    const pendingOrders = storage.pendingOrders || [];

    let oldestOrderTime = null;
    if (pendingOrders.length > 0) {
      const timestamps = pendingOrders.map(o => o.timestamp).filter(t => t && !isNaN(t));
      if (timestamps.length > 0) oldestOrderTime = Math.min(...timestamps);
    }

    return { collectCount, woltCount, totalCount: collectCount + woltCount, oldestOrderTime };
  } catch (e) {
    return { collectCount: 0, woltCount: 0, totalCount: 0, oldestOrderTime: null };
  }
}

// Map numbers to Finnish words to avoid unnatural TTS inflection
const FI_NUMBERS = {
  1: 'Yksi', 2: 'Kaksi', 3: 'Kolme', 4: 'Neljä', 5: 'Viisi',
  6: 'Kuusi', 7: 'Seitsemän', 8: 'Kahdeksan', 9: 'Yhdeksän', 10: 'Kymmenen'
};

function buildTtsText(count, customTemplate, orderType) {
  // Format the number as a standalone sentence (e.g. "Viisi!") to prevent proper noun inflection
  const numWord = FI_NUMBERS[count] || String(count);
  if (customTemplate && customTemplate.trim()) {
    const parts = customTemplate.split('{count}');
    const before = (parts[0] || '').trimEnd();
    const after = (parts[1] || '').trimStart();
    const afterCap = after ? after.charAt(0).toUpperCase() + after.slice(1) : '';
    if (before && afterCap) return `${before}! ${numWord}! ${afterCap}`;
    if (afterCap) return `${numWord}! ${afterCap}`;
    if (before) return `${before} ${numWord}!`;
    return `${numWord}!`;
  }
  if (count === 1) return `${numWord}! Uusi ${orderType} tilaus.`;
  return `${numWord}! ${orderType} tilausta.`;
}

function speakText(text, volume = 1.0) {
  try {
    chrome.tts.speak(text, { lang: 'fi-FI', rate: 0.95, pitch: 1.0, volume: Math.min(1, volume) });
  } catch (e) { console.warn('speakText error:', e); }
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}



async function addToShiftHistory(count, orderType, currentHistory) {
  try {
    const todayKey = getTodayKey();
    let history = currentHistory && typeof currentHistory === 'object' ? currentHistory : null;

    // Initialize history if a new day has started
    if (!history || !history.dayKey || history.dayKey !== todayKey) {
      history = { dayKey: todayKey, sessionStart: Date.now(), orders: [] };
    }

    if (!history.sessionStart) history.sessionStart = Date.now();

    history.orders = Array.isArray(history.orders) ? history.orders : [];
    history.orders.push({
      timestamp: Date.now(),
      count,
      type: orderType,
      hour: new Date().getHours()
    });

    if (history.orders.length > 500) history.orders = history.orders.slice(-500);

    await chrome.storage.local.set({ shiftHistory: history });
  } catch (e) { console.warn('addToShiftHistory error:', e); }
}