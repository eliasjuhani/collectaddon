(function () {
  'use strict';

  let orderCountEl, refreshBtn,
    pollIntervalInput, alertDurationInput, soundEnabledInput,
    connectionDot, connectionText, soundFileInput, imageFileInput,
    soundFileName, imageFileName, testAlertBtn, woltCountEl;

  let woltSoundFileInput, woltImageFileInput, woltSoundFileName, woltImageFileName;

  let zenModeEnabled, splitModeEnabled;

  let monitorFrame, monitorLeft, monitorRight, monitorDivider;
  let splitRatioLeft, splitRatioRight;
  let currentSplitRatio = 50;


  let ttsEnabledInput, ttsVolumeInput, ttsVolumeValue, ttsCollectTextInput, ttsWoltTextInput;


  let darkModeInput;


  let sessionStartEl, totalOrdersEl, historyCollectEl, historyWoltEl, busiestHourEl;

  let pollIntervalValue, alertDurationValue;
  let alertStyleSelect;

  let domReady = false;
  let oldestTimerInterval = null;

  const DEFAULT_ALERT_OVERLAY = {
    position: 'center',
    mainTitle: 'Uusia collecteja!',
    subTitle: '',
    brandTag: '',
    counterLabel: '',
    fontSize: 'massive',
    emphasisAnim: true
  };
  const DEFAULT_WOLT_OVERLAY = {
    position: 'center',
    mainTitle: 'Uusia Wolt-tilauksia!',
    subTitle: '',
    brandTag: '',
    counterLabel: '',
    fontSize: 'massive',
    emphasisAnim: true
  };
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && domReady) {
      if (changes.collectCount || changes.woltCount || changes.lastCheck || changes.connectionStatus ||
        changes.storeName) {
        loadState();
      }
      if (changes.shiftHistory) {
        loadHistoryStats();
      }
    }
  });

  document.addEventListener('DOMContentLoaded', initPopup);

  async function initPopup() {
    try {
      orderCountEl = document.getElementById('order-count');
      woltCountEl = document.getElementById('wolt-count');
      refreshBtn = document.getElementById('refresh-btn');
      pollIntervalInput = document.getElementById('poll-interval');
      alertDurationInput = document.getElementById('alert-duration');
      soundEnabledInput = document.getElementById('sound-enabled');
      connectionDot = document.getElementById('connection-status');
      connectionText = document.getElementById('connection-text');
      soundFileInput = document.getElementById('sound-file');
      imageFileInput = document.getElementById('image-file');
      soundFileName = document.getElementById('sound-file-name');
      imageFileName = document.getElementById('image-file-name');
      testAlertBtn = document.getElementById('test-alert');
      const testWoltAlertBtn = document.getElementById('test-wolt-alert');

      woltSoundFileInput = document.getElementById('wolt-sound-file');
      woltImageFileInput = document.getElementById('wolt-image-file');
      woltSoundFileName = document.getElementById('wolt-sound-file-name');
      woltImageFileName = document.getElementById('wolt-image-file-name');

      zenModeEnabled = document.getElementById('zen-mode-enabled');
      splitModeEnabled = document.getElementById('split-mode-enabled');

      monitorFrame = document.getElementById('monitor-frame');
      monitorLeft = document.getElementById('monitor-left');
      monitorRight = document.getElementById('monitor-right');
      monitorDivider = document.getElementById('monitor-divider');
      splitRatioLeft = document.getElementById('split-ratio-left');
      splitRatioRight = document.getElementById('split-ratio-right');

      pollIntervalValue = document.getElementById('poll-interval-value');
      alertDurationValue = document.getElementById('alert-duration-value');
      alertStyleSelect = document.getElementById('alert-style');

      // TTS
      ttsEnabledInput = document.getElementById('tts-enabled');
      ttsVolumeInput = document.getElementById('tts-volume');
      ttsVolumeValue = document.getElementById('tts-volume-value');
      ttsCollectTextInput = document.getElementById('tts-collect-text');
      ttsWoltTextInput = document.getElementById('tts-wolt-text');

      // dark mode
      darkModeInput = document.getElementById('dark-mode-enabled');


      sessionStartEl = document.getElementById('session-start');
      totalOrdersEl = document.getElementById('total-orders');
      historyCollectEl = document.getElementById('history-collect');
      historyWoltEl = document.getElementById('history-wolt');
      busiestHourEl = document.getElementById('busiest-hour');

      domReady = true;

      // Read all settings at once to optimize storage access
      const allData = await chrome.storage.local.get([
        'collectCount', 'woltCount', 'storeName', 'lastCheck', 'lastError', 'connectionStatus',
        'pollIntervalSeconds', 'alertDurationSeconds', 'soundEnabled', 'soundFileName', 'imageFileName',
        'woltSoundFileName', 'woltImageFileName',
        'splitRatio', 'splitModeEnabled', 'zenModeEnabled',
        'tts', 'darkMode', 'uiTheme', 'shiftHistory', 'alertStyle'
      ]);
      if (alertStyleSelect) alertStyleSelect.value = allData.alertStyle || 'default';
      loadStateFromData(allData);
      loadSettingsFromData(allData);
      loadWoltSettingsFromData(allData);
      loadSplitSettingsFromData(allData);
      loadTtsSettingsFromData(allData);
      loadDarkModeFromData(allData);
      loadHistoryStatsFromData(allData);
      setupEventListeners();
      setupTabNavigation();
      setupSplitControl();

    } catch (error) {
      console.warn('initPopup error:', error);
    }
  }

  function loadStateFromData(state) {
    updateUI(state);
  }

  async function loadState() {
    try {
      const state = await chrome.storage.local.get([
        'collectCount', 'woltCount', 'storeName', 'lastCheck', 'lastError', 'connectionStatus'
      ]);
      loadStateFromData(state);
    } catch (error) {
      console.warn('loadState error:', error);
    }
  }

  function loadSettingsFromData(settings) {
    const pollInterval = settings.pollIntervalSeconds || 30;
    const alertDuration = settings.alertDurationSeconds || 10;

    if (pollIntervalInput) {
      pollIntervalInput.value = String(Math.min(60, Math.max(1, pollInterval)));
      if (pollIntervalValue) pollIntervalValue.textContent = String(Math.min(60, Math.max(1, pollInterval)));
    }
    if (alertDurationInput) {
      alertDurationInput.value = String(Math.min(20, Math.max(1, alertDuration)));
      if (alertDurationValue) alertDurationValue.textContent = String(Math.min(20, Math.max(1, alertDuration)));
    }
    if (soundEnabledInput) soundEnabledInput.checked = settings.soundEnabled !== false;
    if (soundFileName && settings.soundFileName) soundFileName.textContent = settings.soundFileName;
    if (imageFileName && settings.imageFileName) imageFileName.textContent = settings.imageFileName;
  }

  async function loadSettings() {
    try {
      const settings = await chrome.storage.local.get([
        'pollIntervalSeconds', 'alertDurationSeconds', 'soundEnabled',
        'soundFileName', 'imageFileName'
      ]);
      loadSettingsFromData(settings);
    } catch (error) {
      console.warn('loadSettings error:', error);
    }
  }

  function updateUI(state) {
    const count = parseInt(state.collectCount, 10) || 0;
    const woltCount = parseInt(state.woltCount, 10) || 0;

    if (orderCountEl) orderCountEl.textContent = String(count);
    if (woltCountEl) woltCountEl.textContent = String(woltCount);

    updateConnectionStatus(state.connectionStatus, state.lastError);
  }

  function updateConnectionStatus(status, error) {
    if (!connectionDot || !connectionText) return;
    connectionDot.className = 'status-indicator';
    switch (status) {
      case 'connected':
        connectionDot.classList.add('connected');
        connectionText.textContent = 'Yhdistetty';
        break;
      case 'error':
        connectionDot.classList.add('disconnected');
        connectionText.textContent = error || 'Virhe';
        break;
      default:
        connectionDot.classList.add('unknown');
        connectionText.textContent = 'Tuntematon';
    }
  }

  async function handleFileChange(event, storageKey, fileNameKey, displayElement, mediaType) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (displayElement) displayElement.textContent = 'Tallennetaan...';

    try {
      const maxSize = 50 * 1024 * 1024;
      if (file.size > maxSize) {
        throw new Error('Tiedosto on liian suuri (Max 50MB)');
      }

      const blob = new Blob([file], { type: file.type });
      await MediaDB.saveMedia(storageKey, blob, mediaType, file.name);

      await chrome.storage.local.set({
        [fileNameKey]: file.name,
        [`${storageKey}Exists`]: true
      });

      if (displayElement) {
        displayElement.textContent = `${file.name} (${MediaDB.formatBytes(file.size)})`;
      }

    } catch (err) {
      if (displayElement) displayElement.textContent = 'Virhe: ' + err.message;
      alert('Virhe: ' + err.message);
    }
  }

  function setupEventListeners() {
    if (refreshBtn) refreshBtn.addEventListener('click', handleRefreshClick);

    const dashboardBtn = document.getElementById('dashboard-btn');
    if (dashboardBtn) dashboardBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    });

    if (pollIntervalInput) {
      pollIntervalInput.addEventListener('input', (e) => {
        if (pollIntervalValue) pollIntervalValue.textContent = e.target.value;
      });
      pollIntervalInput.addEventListener('change', autoSaveSettings);
    }

    if (alertDurationInput) {
      alertDurationInput.addEventListener('input', (e) => {
        if (alertDurationValue) alertDurationValue.textContent = e.target.value;
      });
      alertDurationInput.addEventListener('change', autoSaveSettings);
    }

    if (soundEnabledInput) soundEnabledInput.addEventListener('change', autoSaveSettings);

    if (soundFileInput) soundFileInput.addEventListener('change', (e) => handleFileChange(e, 'soundData', 'soundFileName', soundFileName, 'audio'));
    if (imageFileInput) imageFileInput.addEventListener('change', (e) => handleFileChange(e, 'imageData', 'imageFileName', imageFileName, 'image'));

    if (woltSoundFileInput) woltSoundFileInput.addEventListener('change', (e) => handleFileChange(e, 'woltSoundData', 'woltSoundFileName', woltSoundFileName, 'audio'));
    if (woltImageFileInput) woltImageFileInput.addEventListener('change', (e) => handleFileChange(e, 'woltImageData', 'woltImageFileName', woltImageFileName, 'image'));

    if (zenModeEnabled) zenModeEnabled.addEventListener('change', saveSplitSettingsAndApply);
    if (splitModeEnabled) {
      splitModeEnabled.addEventListener('change', () => {
        saveSplitSettingsAndApply();
      });
    }

    if (testAlertBtn) testAlertBtn.addEventListener('click', handleTestAlert);


    if (ttsEnabledInput) ttsEnabledInput.addEventListener('change', saveTtsSettings);
    if (ttsVolumeInput) {
      ttsVolumeInput.addEventListener('input', () => {
        if (ttsVolumeValue) ttsVolumeValue.textContent = String(Math.round(parseInt(ttsVolumeInput.value, 10)));
        saveTtsSettings();
      });
    }
    if (ttsCollectTextInput) ttsCollectTextInput.addEventListener('input', debounce(saveTtsSettings, 500));
    if (ttsWoltTextInput) ttsWoltTextInput.addEventListener('input', debounce(saveTtsSettings, 500));


    if (darkModeInput) darkModeInput.addEventListener('change', toggleDarkMode);


    document.querySelectorAll('input[name="ui-theme"]').forEach(radio => {
      radio.addEventListener('change', handleThemeChange);
    });

    // Alert style selector
    if (alertStyleSelect) {
      alertStyleSelect.addEventListener('change', () => {
        chrome.storage.local.set({ alertStyle: alertStyleSelect.value }).catch(() => { });
      });
    }

    // Media reset buttons
    setupMediaResetButtons();


    updateOldestTimer();
    if (oldestTimerInterval) clearInterval(oldestTimerInterval);
    oldestTimerInterval = setInterval(updateOldestTimer, 30000);

    // Clean up interval when popup closes
    window.addEventListener('unload', () => {
      if (oldestTimerInterval) { clearInterval(oldestTimerInterval); oldestTimerInterval = null; }
    });


    const csvBtn = document.getElementById('export-csv');
    if (csvBtn) csvBtn.addEventListener('click', handleCsvExport);


    const resetHistBtn = document.getElementById('reset-history');
    if (resetHistBtn) resetHistBtn.addEventListener('click', handleHistoryReset);
  }

  function setupSplitControl() {
    if (!monitorDivider || !monitorFrame || !monitorLeft) return;

    let isDragging = false;

    const startDrag = (e) => {
      isDragging = true;
      monitorDivider.classList.add('dragging');
      e.preventDefault();
    };

    const doDrag = (e) => {
      if (!isDragging) return;

      const rect = monitorFrame.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const x = clientX - rect.left;
      const percentage = Math.max(20, Math.min(80, (x / rect.width) * 100));

      currentSplitRatio = Math.round(percentage);
      updateSplitVisual(currentSplitRatio);

      sendSplitPreview(currentSplitRatio);
    };

    const endDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      monitorDivider.classList.remove('dragging');

      saveSplitSettingsAndApply();
    };

    monitorDivider.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', doDrag);
    document.addEventListener('mouseup', endDrag);

    monitorDivider.addEventListener('touchstart', startDrag);
    document.addEventListener('touchmove', doDrag);
    document.addEventListener('touchend', endDrag);
  }

  function updateSplitVisual(ratio) {
    if (monitorLeft) {
      monitorLeft.style.width = `${ratio}%`;
    }
    if (splitRatioLeft) {
      splitRatioLeft.textContent = String(Math.round(ratio));
    }
    if (splitRatioRight) {
      splitRatioRight.textContent = String(Math.round(100 - ratio));
    }
  }

  async function sendSplitPreview(ratio) {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://launchpad.elkjop.com/*' });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'previewSplit',
          data: { splitRatio: ratio }
        }).catch(() => { });
      }
    } catch (e) {
      console.warn('sendSplitPreview error:', e);
    }
  }

  async function saveSplitSettingsAndApply() {
    try {
      await saveSplitSettings();

      const tabs = await chrome.tabs.query({ url: 'https://launchpad.elkjop.com/*' });
      for (const tab of tabs) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'applySplit',
          data: {
            splitRatio: currentSplitRatio,
            splitModeEnabled: splitModeEnabled?.checked || false,
            zenModeEnabled: zenModeEnabled?.checked || false
          }
        }).catch(() => { });
      }
    } catch (e) {
      console.warn('saveSplitSettingsAndApply error:', e);
    }
  }

  function toggleEditorControls() {
    // Deprecated editor panel stub
  }

  function setupTabNavigation() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    // Restore previously active tab
    chrome.storage.local.get('lastActiveTab').then(({ lastActiveTab }) => {
      if (lastActiveTab) {
        const btn = document.querySelector(`.tab-btn[data-tab="${lastActiveTab}"]`);
        const panel = document.querySelector(`[data-panel="${lastActiveTab}"]`);
        if (btn && panel) {
          tabBtns.forEach(b => b.classList.remove('active'));
          tabPanels.forEach(p => p.classList.remove('active'));
          btn.classList.add('active');
          panel.classList.add('active');
        }
      }
    }).catch(() => { });

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;

        tabBtns.forEach(b => b.classList.remove('active'));
        tabPanels.forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        const targetPanel = document.querySelector(`[data-panel="${targetTab}"]`);
        if (targetPanel) targetPanel.classList.add('active');

        // Persist active tab selection
        chrome.storage.local.set({ lastActiveTab: targetTab }).catch(() => { });
      });
    });
  }

  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }


  function loadWoltSettingsFromData(settings) {
    if (woltSoundFileName && settings.woltSoundFileName) {
      woltSoundFileName.textContent = settings.woltSoundFileName;
    }
    if (woltImageFileName && settings.woltImageFileName) {
      woltImageFileName.textContent = settings.woltImageFileName;
    }
  }

  async function loadWoltSettings() {
    try {
      const settings = await chrome.storage.local.get([
        'woltSoundFileName', 'woltImageFileName'
      ]);
      loadWoltSettingsFromData(settings);
    } catch (error) {
      console.warn('loadWoltSettings error:', error);
    }
  }

  function loadSplitSettingsFromData(settings) {
    currentSplitRatio = settings.splitRatio || 50;
    updateSplitVisual(currentSplitRatio);
    if (splitModeEnabled) splitModeEnabled.checked = settings.splitModeEnabled || false;
    if (zenModeEnabled) zenModeEnabled.checked = settings.zenModeEnabled || false;
  }

  async function loadSplitSettings() {
    try {
      const settings = await chrome.storage.local.get(['splitRatio', 'splitModeEnabled', 'zenModeEnabled']);
      loadSplitSettingsFromData(settings);
    } catch (error) {
      console.warn('loadSplitSettings error:', error);
    }
  }

  async function saveSplitSettings() {
    try {
      const settings = {
        splitRatio: currentSplitRatio,
        splitModeEnabled: splitModeEnabled?.checked || false,
        zenModeEnabled: zenModeEnabled?.checked || false
      };

      await chrome.storage.local.set(settings);

      try {
        const tabs = await chrome.tabs.query({ url: 'https://launchpad.elkjop.com/*' });
        for (const tab of tabs) {
          await chrome.tabs.sendMessage(tab.id, { action: 'updateModes', data: settings }).catch(() => { });
        }
      } catch (e) {
        console.warn('saveSplitSettings tab send error:', e);
      }

    } catch (error) {
      console.warn('saveSplitSettings error:', error);
    }
  }

  async function autoSaveSettings() {
    try {
      const pollIntervalSeconds = Math.max(1, Math.min(60, parseInt(pollIntervalInput?.value, 10) || 30));
      const alertDurationSeconds = Math.max(1, Math.min(20, parseInt(alertDurationInput?.value, 10) || 10));

      await chrome.storage.local.set({
        pollIntervalSeconds,
        alertDurationSeconds,
        soundEnabled: soundEnabledInput?.checked || false
      });
      await chrome.runtime.sendMessage({ action: 'updateSettings' });
    } catch (e) {
      console.warn('autoSaveSettings error:', e);
    }
  }

  async function handleRefreshClick() {
    if (!refreshBtn) return;
    refreshBtn.disabled = true;

    try {
      await chrome.runtime.sendMessage({ action: 'checkNow' });
      await new Promise(r => setTimeout(r, 1000));
      await loadState();
    } catch (e) {
      console.warn('refresh error:', e);
    }
    refreshBtn.disabled = false;
  }

  async function handleTestAlert() {
    const btn = document.getElementById('test-alert');
    if (btn) btn.disabled = true;

    try {
      const tabs = await chrome.tabs.query({ url: 'https://launchpad.elkjop.com/*' });
      const settings = await chrome.storage.local.get(['alertOverlay', 'woltOverlay', 'splitModeEnabled', 'alertDurationSeconds', 'alertStyle']);
      const isSplitMode = settings.splitModeEnabled || false;
      const alertDuration = (parseInt(settings.alertDurationSeconds, 10) || 10) * 1000;
      const alertStyle = settings.alertStyle || 'default';

      if (tabs.length > 0) {
        if (isSplitMode) {
          const [woltSoundData, woltVideoData, woltImageData] = await Promise.all([
            MediaDB.getMediaAsDataURL('woltSoundData'),
            MediaDB.getMediaAsDataURL('woltVideoData'),
            MediaDB.getMediaAsDataURL('woltImageData')
          ]);

          await chrome.tabs.sendMessage(tabs[0].id, {
            action: 'showAlert',
            data: {
              count: 3,
              orderType: 'wolt',
              soundData: woltSoundData,
              videoData: woltVideoData,
              imageData: woltImageData,
              alertOverlay: settings.alertOverlay || DEFAULT_ALERT_OVERLAY,
              woltOverlay: settings.woltOverlay || DEFAULT_WOLT_OVERLAY,
              alertStyle
            }
          });

          await new Promise(r => setTimeout(r, alertDuration));

          const [soundData, videoData, imageData] = await Promise.all([
            MediaDB.getMediaAsDataURL('soundData'),
            MediaDB.getMediaAsDataURL('videoData'),
            MediaDB.getMediaAsDataURL('imageData')
          ]);

          await chrome.tabs.sendMessage(tabs[0].id, {
            action: 'showAlert',
            data: {
              count: 5,
              soundData: soundData,
              videoData: videoData,
              imageData: imageData,
              alertOverlay: settings.alertOverlay || DEFAULT_ALERT_OVERLAY,
              woltOverlay: settings.woltOverlay || DEFAULT_WOLT_OVERLAY,
              alertStyle
            }
          });
        } else {
          const [soundData, videoData, imageData] = await Promise.all([
            MediaDB.getMediaAsDataURL('soundData'),
            MediaDB.getMediaAsDataURL('videoData'),
            MediaDB.getMediaAsDataURL('imageData')
          ]);

          await chrome.tabs.sendMessage(tabs[0].id, {
            action: 'showAlert',
            data: {
              count: 5,
              soundData: soundData,
              videoData: videoData,
              imageData: imageData,
              alertOverlay: settings.alertOverlay || DEFAULT_ALERT_OVERLAY,
              woltOverlay: settings.woltOverlay || DEFAULT_WOLT_OVERLAY,
              alertStyle
            }
          });
        }

        chrome.tabs.update(tabs[0].id, { active: true });
      } else {
        const url = isSplitMode ? 'alert.html?split=true' : 'alert.html';
        await chrome.tabs.create({ url });
      }

      // Evaluate TTS playback
      const ttsSettings = await chrome.storage.local.get('tts');
      const tts = ttsSettings.tts;
      if (tts?.enabled) {
        const vol = Math.min(1, (tts.volume || 80) / 100);
        // Prevent proper noun inflection in Finnish TTS
        const raw = tts.collectText?.trim() || '';
        const parts = raw ? raw.split('{count}') : [];
        let text;
        if (parts.length >= 2) {
          const before = parts[0].trimEnd();
          const after = parts[1].trimStart();
          const afterCap = after ? after.charAt(0).toUpperCase() + after.slice(1) : '';
          text = before ? `${before}! Viisi! ${afterCap}` : `Viisi! ${afterCap}`;
        } else {
          text = 'Viisi! Collect tilausta.';
        }
        chrome.tts.speak(text, { lang: 'fi-FI', rate: 0.95, pitch: 1.0, volume: vol });
      }

    } catch (error) {
      alert('Testi epäonnistui: ' + error.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }


  function loadTtsSettingsFromData(settings) {
    const tts = settings.tts || { enabled: false, volume: 80, collectText: '', woltText: '' };
    if (ttsEnabledInput) ttsEnabledInput.checked = tts.enabled || false;
    if (ttsVolumeInput) {
      // volume is 0-100, not 0.0-1.0
      const vol = tts.volume !== undefined ? tts.volume : 80;
      ttsVolumeInput.value = vol;
      if (ttsVolumeValue) ttsVolumeValue.textContent = String(Math.round(vol));
    }
    if (ttsCollectTextInput) ttsCollectTextInput.value = tts.collectText || '';
    if (ttsWoltTextInput) ttsWoltTextInput.value = tts.woltText || '';
    updateTtsVisibility();
  }

  async function loadTtsSettings() {
    try {
      const settings = await chrome.storage.local.get(['tts']);
      loadTtsSettingsFromData(settings);
    } catch (error) {
      console.warn('loadTtsSettings error:', error);
    }
  }

  async function saveTtsSettings() {
    try {
      const tts = {
        enabled: ttsEnabledInput?.checked || false,
        volume: ttsVolumeInput ? parseInt(ttsVolumeInput.value, 10) : 80,
        collectText: ttsCollectTextInput?.value || '',
        woltText: ttsWoltTextInput?.value || ''
      };

      await chrome.storage.local.set({ tts });
      updateTtsVisibility();
    } catch (error) {
      // silent
    }
  }

  // dark mode + theme
  function loadDarkModeFromData(settings) {
    const darkMode = settings.darkMode || false;
    const theme = settings.uiTheme || 'launchpad';
    if (darkModeInput) darkModeInput.checked = darkMode;
    if (darkMode) document.body.classList.add('dark-mode');
    applyTheme(theme);
  }

  async function loadDarkMode() {
    try {
      const settings = await chrome.storage.local.get(['darkMode', 'uiTheme']);
      loadDarkModeFromData(settings);
    } catch (error) {
      console.warn('popup: loadDarkMode err', error);
    }
  }

  async function toggleDarkMode() {
    try {
      const darkMode = darkModeInput?.checked || false;
      await chrome.storage.local.set({ darkMode });
      document.body.classList.toggle('dark-mode', darkMode);
    } catch (error) {
      console.warn('popup: toggleDarkMode err', error);
    }
  }

  function applyTheme(theme) {
    document.body.classList.toggle('wolt-theme', theme === 'wolt');
    const radio = document.getElementById(`theme-${theme}`);
    if (radio) radio.checked = true;
  }

  function handleThemeChange(e) {
    const theme = e.target.value;
    applyTheme(theme);
    chrome.storage.local.set({ uiTheme: theme }).catch(() => { });
  }

  // history stats
  function loadHistoryStatsFromData(settings) {
    const history = settings.shiftHistory || { enabled: true, sessionStart: null, orders: [] };

    if (!history.sessionStart) {
      if (sessionStartEl) sessionStartEl.textContent = 'Ei tilauksia';
    } else {
      const today = new Date();
      if (sessionStartEl) sessionStartEl.textContent = today.toLocaleDateString('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric' });
    }

    const orders = history.orders || [];
    let collectTotal = 0;
    let woltTotal = 0;
    const hourCounts = {};

    orders.forEach(order => {
      if (order.type === 'collect') collectTotal += order.count;
      else if (order.type === 'wolt') woltTotal += order.count;
      const hour = order.hour;
      if (hour !== undefined) hourCounts[hour] = (hourCounts[hour] || 0) + order.count;
    });

    if (totalOrdersEl) totalOrdersEl.textContent = collectTotal + woltTotal;
    if (historyCollectEl) historyCollectEl.textContent = collectTotal;
    if (historyWoltEl) historyWoltEl.textContent = woltTotal;

    let busiestHour = null;
    let maxCount = 0;
    for (const [hour, count] of Object.entries(hourCounts)) {
      if (count > maxCount) { maxCount = count; busiestHour = hour; }
    }
    if (busiestHourEl) busiestHourEl.textContent = busiestHour !== null ? `${busiestHour}:00` : '-';
    renderPopupChart(hourCounts, maxCount);
  }

  async function loadHistoryStats() {
    try {
      const settings = await chrome.storage.local.get(['shiftHistory']);
      loadHistoryStatsFromData(settings);
    } catch (error) {
      console.warn('loadHistoryStats error:', error);
    }
  }

  function renderPopupChart(hourCounts, maxCount) {
    const chartEl = document.getElementById('history-chart');
    if (!chartEl) return;

    chartEl.innerHTML = '';
    const startHour = 6;
    const endHour = 23;

    for (let h = startHour; h <= endHour; h++) {
      const count = hourCounts[h] || 0;
      const bar = document.createElement('div');
      bar.className = 'history-bar';

      if (count > 0 && maxCount > 0) {
        const heightPct = Math.max(10, (count / maxCount) * 100);
        bar.style.height = heightPct + '%';
        bar.setAttribute('data-tooltip', `${h}:00 → ${count}`);
      } else {
        bar.style.height = '2px';
        bar.style.background = 'var(--border)';
      }

      chartEl.appendChild(bar);
    }

    // x labels
    const labelsEl = document.getElementById('history-chart-labels');
    if (labelsEl) {
      labelsEl.innerHTML = '';
      for (let h = startHour; h <= endHour; h++) {
        const lbl = document.createElement('span');
        lbl.textContent = h;
        labelsEl.appendChild(lbl);
      }
    }
  }

  // Initialize media reset controls
  function setupMediaResetButtons() {
    const resetMap = [
      { btnId: 'reset-sound', mediaKey: 'soundData', fileNameKey: 'soundFileName', displayEl: soundFileName },
      { btnId: 'reset-image', mediaKey: 'imageData', fileNameKey: 'imageFileName', displayEl: imageFileName },
      { btnId: 'reset-wolt-sound', mediaKey: 'woltSoundData', fileNameKey: 'woltSoundFileName', displayEl: woltSoundFileName },
      { btnId: 'reset-wolt-image', mediaKey: 'woltImageData', fileNameKey: 'woltImageFileName', displayEl: woltImageFileName }
    ];

    for (const { btnId, mediaKey, fileNameKey, displayEl } of resetMap) {
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.addEventListener('click', async () => {
          try {
            await MediaDB.deleteMedia(mediaKey);
            await chrome.storage.local.remove([fileNameKey, `${mediaKey}Exists`]);
            if (displayEl) displayEl.textContent = 'Ei valittu';
          } catch (e) { console.warn('resetMedia error:', e); }
        });
      }
    }
  }


  async function updateOldestTimer() {
    try {
      const { oldestOrderTimestamp, collectCount, woltCount } = await chrome.storage.local.get([
        'oldestOrderTimestamp', 'collectCount', 'woltCount'
      ]);
      const timerEl = document.getElementById('oldest-timer');
      const valueEl = document.getElementById('oldest-value');
      if (!timerEl || !valueEl) return;

      const totalCount = (parseInt(collectCount, 10) || 0) + (parseInt(woltCount, 10) || 0);
      if (totalCount > 0 && oldestOrderTimestamp) {
        const ageMs = Date.now() - oldestOrderTimestamp;
        const ageMin = Math.floor(ageMs / 60000);
        timerEl.style.display = 'flex';
        valueEl.textContent = ageMin < 1 ? '< 1 min' : `${ageMin} min`;
        valueEl.style.color = ageMin >= 10 ? '#E74C3C' : ageMin >= 5 ? '#F39C12' : '#27AE60';
      } else {
        timerEl.style.display = 'none';
      }
    } catch (e) { console.warn('updateOldestTimer error:', e); }
  }

  // Toggle TTS settings visibility
  function updateTtsVisibility() {
    const ttsOn = ttsEnabledInput?.checked || false;
    const collectGroup = document.getElementById('tts-collect-group');
    const woltGroup = document.getElementById('tts-wolt-group');
    const volumeGroup = document.getElementById('tts-volume-group');

    if (collectGroup) collectGroup.style.display = ttsOn ? 'block' : 'none';
    if (woltGroup) woltGroup.style.display = ttsOn ? 'block' : 'none';
    if (volumeGroup) volumeGroup.style.display = ttsOn ? 'block' : 'none';
  }


  async function handleCsvExport() {
    try {
      const { shiftHistory } = await chrome.storage.local.get('shiftHistory');
      const orders = shiftHistory?.orders || [];
      if (orders.length === 0) { alert('Ei tilauksia vietäväksi.'); return; }

      let csv = 'Aika,Tyyppi,Määrä,Tunti\n';
      orders.forEach(o => {
        const time = o.timestamp ? new Date(o.timestamp).toLocaleString('fi-FI') : '-';
        csv += `${time},${o.type || '-'},${o.count || 0},${o.hour ?? '-'}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      // Trigger file download
      if (chrome.downloads) {
        chrome.downloads.download({
          url: url,
          filename: `tilaushistoria_${new Date().toISOString().slice(0, 10)}.csv`,
          saveAs: true
        }, () => {
          // Cleanup object URL
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        });
      } else {
        chrome.tabs.create({ url: url });
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (e) { console.warn('CSV export error:', e); }
  }

  async function handleHistoryReset() {
    if (!confirm('Haluatko varmasti nollata päivän tilaushistorian?')) return;
    try {
      const todayKey = new Date().toISOString().slice(0, 10);
      await chrome.storage.local.set({
        shiftHistory: { dayKey: todayKey, sessionStart: null, orders: [] }
      });
      loadHistoryStats();
    } catch (e) { console.warn('history reset error:', e); }
  }

})();
