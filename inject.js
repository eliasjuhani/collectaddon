(function () {
  'use strict';
  if (window._collectStoreInit) return;
  window._collectStoreInit = true;

  // Deduplicate outgoing telemetry to prevent redundant IPC traffic
  let lastSentCollect = -1;
  let lastSentWolt = -1;

  const isInIframe = window.self !== window.top;
  const frameId = isInIframe ? 'iframe' : 'main';

  // Indicate initialization state for dynamic parameters
  let configReady = false;
  // Queue early XHR payloads until initialization parameters arrive
  let pendingResponses = [];

  let CONFIG = {
    completedStatuses: [
      'PC', 'COMPLETED', 'PICKED', 'CANCELLED', 'DELIVERED', 'HANDED OVER',
      'VALMIS', 'NOUDETTU', 'TOIMITETTU', 'PERUTTU', 'LUOVUTETTU',
      'LASKUTETTU', 'ARCHIVED', 'ARKISTOITU', 'DONE'
    ],
    collectKeywords: ['collect', 'pickup', 'pick-up', 'store', 'click & collect'],
    collectCodes: ['collect', 'pickup', 'zcs', 'c&c', 'cac', 'cas'],
    shippingKeywords: ['home delivery', 'ship', 'hd', 'home'],
    woltKeywords: ['express delivery', 'express', 'ad-hoc', 'adhoc', 'fast', 'wolt', 'pikatilaus', 'pikatoimitus', 'same day', 'sameday', 'nopea', 'quick', 'rapid', 'instant'],
    woltCodes: ['express', 'adhoc', 'fast', 'wolt', 'exp', 'sd', 'pike', 'quick', 'rapid']
  };

  window.postMessage({ type: 'COLLECT_STORE_READY', frameId }, '*');

  function processPendingResponses() {
    for (const response of pendingResponses) {
      processXhrResponse(response);
    }
    pendingResponses = [];
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'COLLECT_STORE_TRIGGER_REFRESH') clickRefreshButton();
    if (event.data?.type === 'COLLECT_STORE_CONFIG_UPDATE' && event.data.config) {
      CONFIG = { ...CONFIG, ...event.data.config };
      if (!configReady) {
        configReady = true;
        processPendingResponses();
      }
    }
  });

  function sendToContentScript(data) {
    try {
      window.postMessage({ type: 'COLLECT_STORE_DATA', data, frameId }, '*');
    } catch (e) { console.warn('sendToContentScript error:', e); }
  }

  function clickRefreshButton() {
    try {
      if (typeof sap !== 'undefined' && sap.ui?.getCore) {
        const core = sap.ui.getCore();
        const knownIds = [
          '__jsview0--BtnRefresh', '__jsview1--BtnRefresh', '__jsview2--BtnRefresh',
          '__jsview3--BtnRefresh', '__jsview4--BtnRefresh', '__jsview5--BtnRefresh'
        ];
        for (const id of knownIds) {
          const btn = core.byId(id);
          if (btn?.firePress) { btn.firePress(); return true; }
        }
        const all = core.byFieldGroupId('');
        if (all) {
          for (const el of all) {
            const elId = el.getId?.() || '';
            if ((elId.includes('BtnRefresh') || elId.includes('btnRefresh') || elId.includes('refresh')) && el.firePress) {
              el.firePress(); return true;
            }
          }
        }
      }
    } catch (e) { console.warn('SAP refresh error:', e); }
    return tryDOMRefresh();
  }

  function tryDOMRefresh() {
    try {
      const btns = document.querySelectorAll('[id*="Refresh"], [id*="refresh"], button[title*="Refresh"], button[title*="refresh"], button[title*="Päivitä"]');
      for (const btn of btns) {
        if (btn.offsetParent !== null) { btn.click(); return true; }
      }
    } catch (e) { console.warn('DOM refresh error:', e); }
    return false;
  }

  function isCollectOrder(typeText, typeCode) {
    const text = (typeText || '').toLowerCase().trim();
    const code = (typeCode || '').toLowerCase().trim();
    if (['order', 'orders', '', 'standard'].includes(text)) return false;
    const hasCollect = CONFIG.collectKeywords.some(k => text.includes(k)) || CONFIG.collectCodes.some(c => code.includes(c));
    const isShipping = CONFIG.shippingKeywords.some(k => text.includes(k));
    return hasCollect && !isShipping;
  }

  function isWoltOrder(typeText, typeCode) {
    const text = (typeText || '').toLowerCase().trim();
    const code = (typeCode || '').toLowerCase().trim();
    return CONFIG.woltKeywords.some(k => text.includes(k)) || CONFIG.woltCodes.some(c => code.includes(c));
  }

  function countOrdersFromResponse(response) {
    try {
      const data = response.modellistItemsData;
      if (!data || !Array.isArray(data)) return null;
      // Treat empty array as a valid zero-state response
      if (data.length === 0) {
        return { collectCount: 0, collectOldestTimestamp: null, woltCount: 0, woltOldestTimestamp: null, woltOrders: [] };
      }

      const numCols = data[0];
      if (typeof numCols !== 'number' || numCols < 1 || numCols > 200) return null;
      if (data.length < numCols + 2) return null; // Ensure structural integrity (header + minimum 1 row)

      const headers = data.slice(1, numCols + 1);
      const col = (name) => headers.indexOf(name);

      const orderTypeTextIdx = col('ORDER_TYPE_TEXT') !== -1 ? col('ORDER_TYPE_TEXT') :
        ['ACTUAL_ORDER_TYPE', 'ORDER_TYPE', 'DELIVERY_TYPE'].reduce((a, n) => a !== -1 ? a : col(n), -1);
      const orderTypeCodeIdx = col('ORDER_TYPE');
      const statusIdx = ['STATUS_TEXT', 'TXT_STATUS', 'GBSTK', 'OVERALL_STATUS', 'STATUS'].reduce((a, n) => a !== -1 ? a : col(n), -1);
      const orderIdIdx = col('ORDER_ID') !== -1 ? col('ORDER_ID') : col('SALES_ORDER');
      const isHeaderIdx = col('IS_HEADER');
      const dateTimeIdx = ['WADAT_IST', 'PICK_DATE', 'TIME_STAMP', 'CREATED_AT', 'DATE', 'TIME', 'CREATED_DATE'].reduce((a, n) => a !== -1 ? a : col(n), -1);
      const customerIdx = ['CUSTOMER_NAME', 'NAME', 'PARTNER_NAME', 'BUYER_NAME', 'KUNNR_NAME'].reduce((a, n) => a !== -1 ? a : col(n), -1);

      const dataStart = numCols + 1;
      const numRows = Math.floor((data.length - dataStart) / numCols);

      const collectOrders = new Set();
      const woltOrders = new Set();
      const woltOrderDetails = [];
      let collectOldestTimestamp = null;
      let woltOldestTimestamp = null;

      for (let row = 0; row < numRows; row++) {
        const base = dataStart + row * numCols;

        if (isHeaderIdx !== -1) {
          const isH = data[base + isHeaderIdx];
          if (isH === true || isH === 'X' || isH === 'true') continue;
        }

        const orderId = orderIdIdx !== -1 ? data[base + orderIdIdx] : `row-${row}`;
        if (collectOrders.has(orderId) || woltOrders.has(orderId)) continue;

        const typeText = orderTypeTextIdx !== -1 ? data[base + orderTypeTextIdx] : '';
        const typeCode = orderTypeCodeIdx !== -1 ? data[base + orderTypeCodeIdx] : '';
        const statusVal = statusIdx !== -1 ? data[base + statusIdx] : '';
        const statusNorm = String(statusVal).toUpperCase().trim();

        const isCompleted = CONFIG.completedStatuses.some(s => statusNorm === s || statusNorm.includes(s));
        if (isCompleted || statusNorm === '') continue;

        let orderTimestamp = null;
        if (dateTimeIdx !== -1 && data[base + dateTimeIdx]) {
          const ts = new Date(data[base + dateTimeIdx]).getTime();
          if (!isNaN(ts)) orderTimestamp = ts;
        }

        const customerName = customerIdx !== -1 ? data[base + customerIdx] : null;

        if (isWoltOrder(typeText, typeCode)) {
          woltOrders.add(orderId);
          woltOrderDetails.push({
            orderId: String(orderId),
            timestamp: orderTimestamp || Date.now(),
            shippingType: typeText || typeCode || 'Express',
            customerName: customerName || ''
          });
          if (orderTimestamp && (woltOldestTimestamp === null || orderTimestamp < woltOldestTimestamp)) {
            woltOldestTimestamp = orderTimestamp;
          }
        } else if (isCollectOrder(typeText, typeCode)) {
          collectOrders.add(orderId);
          if (orderTimestamp && (collectOldestTimestamp === null || orderTimestamp < collectOldestTimestamp)) {
            collectOldestTimestamp = orderTimestamp;
          }
        }
      }

      return {
        collectCount: collectOrders.size,
        collectOldestTimestamp,
        woltCount: woltOrders.size,
        woltOldestTimestamp,
        woltOrders: woltOrderDetails
      };
    } catch (e) {
      console.warn('countOrdersFromResponse error:', e);
      return null;
    }
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._csUrl = url;
    return originalOpen.apply(this, arguments);
  };

  function processXhrResponse(response) {
    const result = countOrdersFromResponse(response);
    if (result !== null) {
      lastSentCollect = result.collectCount;
      lastSentWolt = result.woltCount;
      sendToContentScript({
        collectCount: result.collectCount,
        oldestOrderTimestamp: result.collectOldestTimestamp,
        woltCount: result.woltCount,
        woltOldestTimestamp: result.woltOldestTimestamp,
        woltOrders: result.woltOrders || [],
        storeName: '',
        pendingOrders: result.woltOrders || []
      });
    }
  }

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    xhr.addEventListener('load', function () {
      if (!xhr._csUrl) return;
      const url = xhr._csUrl.toLowerCase();
      if (!(url.includes('zelk') && (url.includes('pick') || url.includes('ship') || url.includes('order') || url.includes('delivery')))) return;

      try {
        const response = JSON.parse(xhr.responseText);
        if (!configReady) {
          // Defer payload processing pending initialization config
          pendingResponses.push(response);
        } else {
          processXhrResponse(response);
        }
      } catch (e) { console.warn('XHR response parse error:', e); }
    });
    return originalSend.apply(this, arguments);
  };

  setTimeout(clickRefreshButton, 3000);
})();