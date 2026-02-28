(function () {
  'use strict';

  // dom refs
  const collectCountEl = document.getElementById('collectCount');
  const woltCountEl = document.getElementById('woltCount');
  const collectChangeEl = document.getElementById('collectChange');
  const woltChangeEl = document.getElementById('woltChange');
  const collectCard = document.getElementById('collectCard');
  const woltCard = document.getElementById('woltCard');
  const statusDot = document.getElementById('statusDot');
  const pollBar = document.getElementById('pollBar');
  const nextPollText = document.getElementById('nextPollText');
  const refreshBtn = document.getElementById('refreshBtn');

  const dashSessionStart = document.getElementById('dashSessionStart');
  const dashTotalOrders = document.getElementById('dashTotalOrders');
  const dashHistCollect = document.getElementById('dashHistoryCollect');
  const dashHistWolt = document.getElementById('dashHistoryWolt');
  const dashBusiestHour = document.getElementById('dashBusiestHour');
  const dashChart = document.getElementById('dashChart');
  const dashChartLabels = document.getElementById('dashChartLabels');

  // settings panel
  const gearBtn = document.getElementById('gearBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const dashDarkMode = document.getElementById('dashDarkMode');
  const dashSoundEnabled = document.getElementById('dashSoundEnabled');
  const dashPollInterval = document.getElementById('dashPollInterval');
  const dashPollValue = document.getElementById('dashPollValue');
  const dashThemeLaunchpad = document.getElementById('dashThemeLaunchpad');
  const dashThemeWolt = document.getElementById('dashThemeWolt');

  // state
  let prev = { collect: 0, wolt: 0 };
  let pollIntervalSec = 30;
  let pollTimerId = null;
  let pollCountdown = 0;
  let tickId = null;
  let isWritingHistory = false;

  // init
  init();

  async function init() {
    await loadAppearance();

    const settings = await chrome.storage.local.get(['pollIntervalSeconds', 'soundEnabled']);
    pollIntervalSec = Math.max(5, Math.min(60, parseInt(settings.pollIntervalSeconds, 10) || 30));

    // sync settings panel controls
    if (dashPollInterval) dashPollInterval.value = pollIntervalSec;
    if (dashPollValue) dashPollValue.textContent = pollIntervalSec + 's';
    if (dashSoundEnabled) dashSoundEnabled.checked = settings.soundEnabled !== false;

    await refresh();
    startPollCycle();

    chrome.storage.onChanged.addListener(handleStorageChange);

    if (refreshBtn) refreshBtn.addEventListener('click', handleManualRefresh);
    setupSettingsPanel();
  }

  // Synchronize background polling visually with a progress bar

  function startPollCycle() {
    stopPollCycle();
    pollCountdown = pollIntervalSec;
    updatePollUI();

    tickId = setInterval(() => {
      pollCountdown--;
      updatePollUI();

      if (pollCountdown <= 0) {
        // Animate refresh button
        if (refreshBtn) {
          refreshBtn.classList.add('spinning');
          setTimeout(() => refreshBtn.classList.remove('spinning'), 800);
        }
        refresh();
        pollCountdown = pollIntervalSec;
      }
    }, 1000);
  }

  function stopPollCycle() {
    if (tickId) { clearInterval(tickId); tickId = null; }
  }

  function updatePollUI() {
    const elapsed = pollIntervalSec - pollCountdown;
    const pct = Math.min(100, (elapsed / pollIntervalSec) * 100);
    if (pollBar) pollBar.style.width = pct + '%';
  }

  // Trigger immediate check
  async function triggerAddonRefresh() {
    try {
      // Validate context to prevent "Extension context invalidated" errors
      if (chrome.runtime?.id) {
        await chrome.runtime.sendMessage({ action: 'checkNow' });
      }
    } catch (e) { console.warn('triggerAddonRefresh error:', e); }
  }

  async function handleManualRefresh() {
    if (!refreshBtn) return;
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;

    await triggerAddonRefresh();

    // Allow background service to process the refresh request
    await new Promise(r => setTimeout(r, 800));
    await refresh();

    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;

    // Reset polling countdown
    pollCountdown = pollIntervalSec;
    updatePollUI();
  }

  // Handle incoming storage updates
  function handleStorageChange(changes, area) {
    if (area !== 'local') return;

    if (changes.collectCount || changes.woltCount) updateCounts();
    if (changes.shiftHistory) loadHistory();
    if (changes.darkMode) {
      applyDarkMode(!!changes.darkMode.newValue);
      if (dashDarkMode) dashDarkMode.checked = !!changes.darkMode.newValue;
    }

    if (changes.uiTheme) {
      applyDashTheme(changes.uiTheme.newValue || 'launchpad');
    }

    if (changes.pollIntervalSeconds) {
      pollIntervalSec = Math.max(5, Math.min(60, parseInt(changes.pollIntervalSeconds.newValue, 10) || 30));
      if (dashPollInterval) dashPollInterval.value = pollIntervalSec;
      if (dashPollValue) dashPollValue.textContent = pollIntervalSec + 's';
      pollCountdown = pollIntervalSec;
      startPollCycle();
    }

    if (changes.soundEnabled && dashSoundEnabled) {
      dashSoundEnabled.checked = changes.soundEnabled.newValue !== false;
    }

    if (changes.connectionStatus) {
      setStatus(changes.connectionStatus.newValue === 'connected' ? 'ok' : 'err');
    }
  }

  // Refresh dashboard state
  async function refresh() {
    try {
      const s = await chrome.storage.local.get(['collectCount', 'woltCount', 'connectionStatus', 'shiftHistory']);
      const c = parseInt(s.collectCount, 10) || 0;
      const w = parseInt(s.woltCount, 10) || 0;
      animateCount(collectCountEl, collectChangeEl, collectCard, c, prev.collect);
      animateCount(woltCountEl, woltChangeEl, woltCard, w, prev.wolt);
      prev = { collect: c, wolt: w };
      setStatus(s.connectionStatus === 'connected' ? 'ok' : (s.connectionStatus === 'error' ? 'err' : ''));

      if (!isWritingHistory) {
        const history = validateHistory(s.shiftHistory);
        const dayChanged = !s.shiftHistory || s.shiftHistory.dayKey !== history.dayKey;
        if (dayChanged) {
          isWritingHistory = true;
          await chrome.storage.local.set({ shiftHistory: history });
          isWritingHistory = false;
        }
        renderHistory(history);
      }
    } catch (e) {
      isWritingHistory = false;
      setStatus('err');
    }
  }

  // Appearance settings
  async function loadAppearance() {
    const { darkMode, uiTheme } = await chrome.storage.local.get(['darkMode', 'uiTheme']);
    applyDarkMode(!!darkMode);
    applyDashTheme(uiTheme || 'launchpad');
    if (dashDarkMode) dashDarkMode.checked = !!darkMode;
  }

  function applyDarkMode(on) {
    document.documentElement.classList.toggle('dark', on);
  }

  function applyDashTheme(theme) {
    document.documentElement.classList.toggle('sap-theme', theme === 'launchpad');
    document.documentElement.classList.toggle('wolt-theme', theme === 'wolt');
    if (dashThemeLaunchpad) dashThemeLaunchpad.classList.toggle('active', theme === 'launchpad');
    if (dashThemeWolt) dashThemeWolt.classList.toggle('active', theme === 'wolt');
  }

  // Settings panel initialization
  function setupSettingsPanel() {
    if (gearBtn && settingsPanel) {
      gearBtn.addEventListener('click', () => {
        const isOpen = settingsPanel.classList.toggle('open');
        gearBtn.classList.toggle('active', isOpen);
      });

      // Close panel when clicking outside
      document.addEventListener('click', (e) => {
        if (!settingsPanel.contains(e.target) && !gearBtn.contains(e.target)) {
          settingsPanel.classList.remove('open');
          gearBtn.classList.remove('active');
        }
      });
    }

    // Dark mode toggle
    if (dashDarkMode) {
      dashDarkMode.addEventListener('change', () => {
        const on = dashDarkMode.checked;
        applyDarkMode(on);
        chrome.storage.local.set({ darkMode: on }).catch(() => { });
      });
    }


    if (dashSoundEnabled) {
      dashSoundEnabled.addEventListener('change', () => {
        chrome.storage.local.set({ soundEnabled: dashSoundEnabled.checked }).catch(() => { });
      });
    }


    if (dashPollInterval) {
      dashPollInterval.addEventListener('input', () => {
        const val = parseInt(dashPollInterval.value, 10);
        if (dashPollValue) dashPollValue.textContent = val + 's';
      });
      dashPollInterval.addEventListener('change', () => {
        const val = parseInt(dashPollInterval.value, 10);
        pollIntervalSec = val;
        startPollCycle();
        chrome.storage.local.set({ pollIntervalSeconds: val }).catch(() => { });
        // Validate context to prevent "Extension context invalidated" errors
        if (chrome.runtime?.id) {
          chrome.runtime.sendMessage({ action: 'updateSettings' }).catch(() => { });
        }
      });
    }


    [dashThemeLaunchpad, dashThemeWolt].forEach(btn => {
      if (!btn) return;
      btn.addEventListener('click', () => {
        const theme = btn.dataset.theme;
        applyDashTheme(theme);
        chrome.storage.local.set({ uiTheme: theme }).catch(() => { });
      });
    });
  }


  async function updateCounts() {
    try {
      const s = await chrome.storage.local.get(['collectCount', 'woltCount', 'connectionStatus']);
      const c = parseInt(s.collectCount, 10) || 0;
      const w = parseInt(s.woltCount, 10) || 0;

      animateCount(collectCountEl, collectChangeEl, collectCard, c, prev.collect);
      animateCount(woltCountEl, woltChangeEl, woltCard, w, prev.wolt);

      prev = { collect: c, wolt: w };
      setStatus(s.connectionStatus === 'connected' ? 'ok' : (s.connectionStatus === 'error' ? 'err' : ''));
    } catch (e) {
      setStatus('err');
    }
  }

  function animateCount(numEl, changeEl, cardEl, val, oldVal) {
    if (!numEl) return;
    const cur = parseInt(numEl.textContent, 10) || 0;
    if (cur === val) return;

    numEl.textContent = val;
    numEl.classList.remove('pop');
    void numEl.offsetWidth;
    numEl.classList.add('pop');

    const diff = val - oldVal;
    if (diff !== 0 && changeEl) {
      changeEl.textContent = diff > 0 ? `+${diff}` : String(diff);
      changeEl.className = 'count-change show ' + (diff > 0 ? 'up' : 'down');
      if (cardEl && diff > 0) {
        cardEl.classList.remove('alert');
        void cardEl.offsetWidth;
        cardEl.classList.add('alert');
      }
      setTimeout(() => changeEl?.classList.remove('show'), 3000);
    }
  }

  function setStatus(s) {
    if (!statusDot) return;
    statusDot.className = 'status-dot' + (s ? ' ' + s : '');
  }


  async function loadHistory() {
    if (isWritingHistory) return;
    try {
      const { shiftHistory } = await chrome.storage.local.get('shiftHistory');
      const history = validateHistory(shiftHistory);

      const dayChanged = !shiftHistory || shiftHistory.dayKey !== history.dayKey;
      if (dayChanged) {
        isWritingHistory = true;
        await chrome.storage.local.set({ shiftHistory: history });
        isWritingHistory = false;
      }
      renderHistory(history);
    } catch (e) {
      isWritingHistory = false;
      console.warn('loadHistory error:', e);
    }
  }

  function getTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function validateHistory(raw) {
    const today = getTodayKey();
    const fresh = { dayKey: today, sessionStart: null, orders: [] };

    if (!raw || typeof raw !== 'object') return fresh;

    // Handle legacy data structure
    if (!raw.dayKey) {
      return { ...fresh, orders: Array.isArray(raw.orders) ? raw.orders : [], sessionStart: raw.sessionStart || null };
    }

    // Reset data on a new day
    if (raw.dayKey !== today) return fresh;

    // Normalize valid day data
    return {
      dayKey: today,
      sessionStart: raw.sessionStart || null,
      orders: Array.isArray(raw.orders) ? raw.orders : []
    };
  }

  function renderHistory(history) {
    const orders = history.orders || [];
    let cTotal = 0, wTotal = 0;
    const hourCounts = {};

    for (const { type, count, hour } of orders) {
      if (type === 'collect') cTotal += count;
      else if (type === 'wolt') wTotal += count;
      if (hour !== undefined) hourCounts[hour] = (hourCounts[hour] || 0) + count;
    }

    if (dashSessionStart) {
      dashSessionStart.textContent = history.sessionStart
        ? new Date().toLocaleDateString('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric' })
        : 'Ei tilauksia';
    }

    if (dashTotalOrders) dashTotalOrders.textContent = cTotal + wTotal;
    if (dashHistCollect) dashHistCollect.textContent = cTotal;
    if (dashHistWolt) dashHistWolt.textContent = wTotal;

    let bHour = null, bMax = 0;
    for (const [h, c] of Object.entries(hourCounts)) {
      if (c > bMax) { bMax = c; bHour = h; }
    }
    if (dashBusiestHour) dashBusiestHour.textContent = bHour !== null ? `${bHour}:00` : '\u2014';

    renderChart(hourCounts, bMax);
  }

  function renderChart(hourCounts, maxCount) {
    if (!dashChart || !dashChartLabels) return;
    dashChart.innerHTML = '';
    dashChartLabels.innerHTML = '';

    for (let h = 9; h <= 21; h++) {
      const count = hourCounts[h] || 0;
      const bar = document.createElement('div');

      if (count > 0 && maxCount > 0) {
        bar.className = 'dash-bar';
        bar.style.height = Math.max(8, (count / maxCount) * 100) + '%';
        bar.setAttribute('data-tooltip', `${h}:00 \u2014 ${count}`);
      } else {
        bar.className = 'dash-bar-empty';
      }
      dashChart.appendChild(bar);

      const lbl = document.createElement('span');
      lbl.textContent = h;
      dashChartLabels.appendChild(lbl);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────
  window.addEventListener('beforeunload', stopPollCycle);
})();