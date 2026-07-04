// ==UserScript==
// @name         Steam Get Trading Card Info
// @namespace    https://github.com/lmaple0/useful-userscript
// @version      1.6.0
// @description  Fetch Steam trading card price, count, and estimated card income on Steam store pages and SteamDB sales pages.
// @author       lyzlyslyc / Maple
// @license      MIT
// @match        https://store.steampowered.com/app/*
// @match        https://steamdb.info/sales/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      steamcommunity.com
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const REQUEST_TIMEOUT_MS = 6000;
  const QUERY_INTERVAL_MS = 3000;
  const MARKET_URL = 'https://steamcommunity.com/market/search';
  const CARD_QUERY = 'category_cardborder=cardborder_0&category_item_class=item_class_2&appid=753';

  const state = {
    timers: [],
    lastIndex: 0,
    steamCountry: null,
    steamDBCurrency: null,
    sameCountry: true,
    showPureIncome: false,
    sortColumn: 0,
    sortAsc: false,
  };

  GM_addStyle(`
    .sgtci-store-row {
      display: flex;
      line-height: 16px;
      padding-top: 9px;
      padding-bottom: 13px;
    }
    .sgtci-store-row .column {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .sgtci-panel {
      max-width: 480px;
      margin: 15px 0;
    }
    .sgtci-options {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 10px;
      margin-top: 25px;
    }
    .sgtci-actions {
      margin-top: 10px;
    }
    .sgtci-btn {
      display: block;
      width: 100%;
      margin-top: 5px;
      padding: 8px;
      line-height: 1;
      font-size: 14px;
      border: 0;
      color: #fff !important;
      background: #338037;
      box-shadow: none;
      text-align: center;
      cursor: pointer;
    }
    .sgtci-btn[hidden] {
      display: none;
    }
    .sgtci-status-error {
      color: #ff6b6b;
    }
    .sgtci-status-empty {
      color: #ffd666;
    }
    .sgtci-positive {
      color: #5bfd00;
    }
    body.sgtci-hide-hover #js-hover {
      display: none !important;
    }
  `);

  if (location.hostname === 'steamdb.info' && location.pathname.startsWith('/sales/')) {
    initSteamDB();
    return;
  }

  if (location.hostname === 'store.steampowered.com' && location.pathname.startsWith('/app/')) {
    window.setTimeout(initStoreApp, 500);
  }

  function initStoreApp() {
    if (window.__sgtciStoreInitialized) {
      return;
    }
    window.__sgtciStoreInitialized = true;

    const appid = getAppIdFromPath(location.pathname);
    const releaseRow = document.querySelector('.release_date');
    if (!appid || !releaseRow || releaseRow.children.length < 2) {
      return;
    }

    const container = releaseRow.parentNode;
    const cardRow = findStoreCardRows(container)[0] || releaseRow.cloneNode(true);
    cardRow.className = 'card_info_row sgtci-store-row';
    cardRow.children[0].textContent = '卡牌信息:';
    cardRow.children[1].className = 'summary column';
    cardRow.children[1].textContent = '';

    const link = document.createElement('a');
    link.className = 'sgtci-store-link';
    cardRow.children[1].appendChild(link);
    if (!cardRow.parentNode) {
      container.appendChild(cardRow);
    }
    removeDuplicateStoreRows(container, cardRow);
    watchStoreRows(container, cardRow);

    getCardInfo(appid, link).catch((error) => {
      renderStatus(link, '解析结果出错', 'error');
      link.dataset.queried = 'error';
      appendRetry(link, appid, {});
      console.error('[Steam Get Trading Card Info]', error);
    });
  }

  function findStoreCardRows(container) {
    if (!container) {
      return [];
    }

    return Array.from(container.children).filter((row) => {
      const label = row.children?.[0]?.textContent?.replace(/\s+/g, '').trim();
      return /^卡牌信息[:：]?$/.test(label || '');
    });
  }

  function removeDuplicateStoreRows(container, keepRow) {
    findStoreCardRows(container).forEach((row) => {
      if (row !== keepRow) {
        row.remove();
      }
    });
  }

  function watchStoreRows(container, keepRow) {
    const observer = new MutationObserver(() => removeDuplicateStoreRows(container, keepRow));
    observer.observe(container, { childList: true });
    window.setTimeout(() => observer.disconnect(), 10000);
  }

  function initSteamDB() {
    const table = document.querySelector('#DataTables_Table_0');
    const filters = document.querySelector('div.filters-container');
    if (!table || !filters) {
      return;
    }

    if (location.hash === '#setFilter') {
      const discountHeader = document.querySelector('#DataTables_Table_0 > thead > tr > th:nth-child(5)');
      if (discountHeader) {
        window.setTimeout(() => discountHeader.click(), 0);
      }
    }

    const panel = document.createElement('div');
    panel.className = 'sgtci-panel';
    filters.prepend(panel);

    const options = document.createElement('div');
    options.className = 'sgtci-options';
    panel.appendChild(options);

    const actions = document.createElement('div');
    actions.className = 'sgtci-actions';
    panel.appendChild(actions);

    const blockHover = createToggle('屏蔽悬浮窗', (checked) => {
      document.body.classList.toggle('sgtci-hide-hover', checked);
    });
    options.appendChild(blockHover.root);

    const pureIncome = createToggle('显示净收入', (checked) => {
      state.showPureIncome = checked;
      refreshIncomeDisplay();
    });
    pureIncome.root.id = 'sgtci-show-pure-income';
    options.appendChild(pureIncome.root);

    const ignoreHighest = createToggle('忽略最高价');
    ignoreHighest.root.id = 'sgtci-ignore-highest';
    options.appendChild(ignoreHighest.root);

    const useMedian = createToggle('使用中位数');
    useMedian.root.id = 'sgtci-use-median';
    options.appendChild(useMedian.root);

    const retryButton = createButton('失败重试', () => startSteamDBQuery({ mode: 'retry' }));
    retryButton.hidden = true;
    actions.appendChild(retryButton);

    const pauseButton = createButton('停止', () => {
      if (pauseButton.textContent === '停止') {
        clearTimers();
        pauseButton.textContent = '继续';
        return;
      }
      startSteamDBQuery({ mode: 'continue' });
    });
    pauseButton.hidden = true;
    actions.appendChild(pauseButton);

    const startButton = createButton('获取卡牌信息', () => {
      clearTimers();
      retryButton.hidden = false;
      pauseButton.hidden = false;
      startButton.textContent = '全部重试';
      startSteamDBQuery({ mode: 'start' });
    });
    actions.appendChild(startButton);

    const filterButton = createButton('一键设置卡牌条件', setFilter);
    filterButton.href = '#setFilter';
    const filterHost = document.querySelector('#js-filters');
    if (filterHost) {
      filterHost.appendChild(filterButton);
    }

    const loginInfo = document.createElement('a');
    loginInfo.id = 'sgtci-login-info';
    loginInfo.href = 'https://steamcommunity.com';
    loginInfo.target = '_blank';
    loginInfo.style.marginRight = '10px';
    const headerUser = document.querySelector('.header-user.hide-small');
    if (headerUser) {
      headerUser.appendChild(loginInfo);
    }

    const lengthSelect = document.querySelector('#DataTables_Table_0_length select');
    if (lengthSelect) {
      lengthSelect.addEventListener('change', () => {
        if (pauseButton.textContent === '查询完成' && state.lastIndex + 1 < getRows().length) {
          pauseButton.textContent = '继续';
        }
      });
    }

    const paginator = document.querySelector('#DataTables_Table_0_paginate');
    if (paginator) {
      paginator.addEventListener('click', () => {
        clearTimers();
        state.lastIndex = 0;
        pauseButton.textContent = '继续';
      });
    }

    checkLoginStatus();

    function startSteamDBQuery({ mode }) {
      checkLoginStatus();
      state.steamDBCurrency = readSteamDBCurrency();
      ensureHeaders(table);

      const rows = getRows();
      if (mode === 'start') {
        state.lastIndex = 0;
      }
      if (mode === 'continue' && state.lastIndex + 1 >= rows.length) {
        pauseButton.textContent = '查询完成';
        return;
      }

      let queued = 0;
      rows.forEach((row, index) => {
        const appid = row.dataset.appid;
        if (!appid) {
          return;
        }

        const cells = ensureResultCells(row);
        const status = cells.income.querySelector('a');
        const hasQueried = status ? status.dataset.queried : '';

        if (mode === 'continue' && index <= state.lastIndex && hasQueried === 'true') {
          return;
        }
        if (mode === 'retry' && hasQueried !== 'error' && hasQueried !== 'loading') {
          return;
        }

        resetResultCells(cells);
        const priceCell = row.querySelector('td:nth-child(5)');
        const appPrice = Number.parseInt(priceCell?.dataset.sort || '0', 10) || 0;

        const timer = window.setTimeout(() => {
          getCardInfo(appid, cells.link, { index, appPrice, row }).catch((error) => {
            markError(cells.link, '解析结果出错', index);
            appendRetry(cells.link, appid, { index, appPrice, row });
            console.error('[Steam Get Trading Card Info]', error);
          });
        }, (queued + 1) * QUERY_INTERVAL_MS + Math.random() * 1000);

        state.timers.push(timer);
        queued += 1;
      });

      pauseButton.textContent = queued > 0 ? '停止' : '查询完成';
    }
  }

  async function getCardInfo(appid, infoNode, context = {}) {
    const queryUrl = `${MARKET_URL}?${CARD_QUERY}&category_Game=app_${encodeURIComponent(appid)}`;
    infoNode.href = queryUrl;
    infoNode.target = '_blank';
    renderStatus(infoNode, '读取中...');
    infoNode.dataset.queried = 'loading';

    const html = await requestText(queryUrl);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    if (isMarketRateLimited(doc)) {
      markError(infoNode, '请求过于频繁', context.index);
      appendRetry(infoNode, appid, context);
      return;
    }

    updateCountryState(doc, html);

    const cards = parseCardPrices(doc);
    if (cards.length === 0) {
      renderStatus(infoNode, '未查询到卡牌信息', 'empty');
      infoNode.dataset.queried = 'true';
      appendRetry(infoNode, appid, context);
      return;
    }

    const stats = calculateCardStats(cards, context.appPrice || 0);
    renderCardStats(infoNode, stats, context.row);
    infoNode.dataset.queried = 'true';

    if (typeof context.index === 'number' && context.index > state.lastIndex) {
      state.lastIndex = context.index;
    }
  }

  function requestText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: REQUEST_TIMEOUT_MS,
        onload: (response) => resolve(response.responseText || ''),
        ontimeout: () => reject(new Error('request timeout')),
        onerror: () => reject(new Error('request failed')),
      });
    });
  }

  function parseCardPrices(doc) {
    const candidates = Array.from(doc.querySelectorAll('.market_listing_price, span'))
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .filter((text) => /(起价|Starting at|Starts at|From)/i.test(text));

    return candidates
      .map(parsePriceText)
      .filter((price) => price && price.cents > 0);
  }

  function parsePriceText(text) {
    const cleaned = text.replace(/\s+/g, ' ').replace(/^(起价|Starting at|Starts at|From)\s*[:：]?\s*/i, '');
    const match = cleaned.match(/([^\d.,-]*)([\d.,]+)([^\d.,]*)$/);
    if (!match) {
      return null;
    }

    const numberText = match[2];
    const normalized = normalizeNumber(numberText);
    const amount = Number.parseFloat(normalized);
    if (!Number.isFinite(amount)) {
      return null;
    }

    const prefix = match[1].trim();
    const suffix = match[3].trim();
    return {
      cents: Math.round(amount * 100),
      currency: prefix || suffix || '',
      position: prefix ? 'front' : 'back',
    };
  }

  function normalizeNumber(value) {
    const lastComma = value.lastIndexOf(',');
    const lastDot = value.lastIndexOf('.');
    if (lastComma > lastDot) {
      return value.replace(/\./g, '').replace(',', '.');
    }
    return value.replace(/,/g, '');
  }

  function calculateCardStats(cards, appPrice) {
    const prices = cards.map((card) => card.cents).sort((a, b) => a - b);
    const sum = prices.reduce((total, price) => total + price, 0);
    const max = prices[prices.length - 1];
    const useMedian = document.querySelector('#sgtci-use-median')?.dataset.checked === 'true';
    const ignoreHighest = document.querySelector('#sgtci-ignore-highest')?.dataset.checked === 'true';

    let avgCents;
    if (useMedian) {
      avgCents = (prices[Math.floor(prices.length / 2)] + prices[Math.floor((prices.length - 1) / 2)]) / 2;
    } else if (ignoreHighest && prices.length > 1) {
      avgCents = (sum - max) / (prices.length - 1);
    } else {
      avgCents = sum / prices.length;
    }

    const incomeCents = calcFee(Math.round(avgCents)) * Math.ceil(cards.length / 2);
    return {
      count: cards.length,
      avg: avgCents / 100,
      income: incomeCents / 100,
      pureIncome: (incomeCents - appPrice) / 100,
      currency: state.steamDBCurrency?.currency || cards[0].currency,
      position: state.steamDBCurrency?.position || cards[0].position,
    };
  }

  function renderCardStats(infoNode, stats, row) {
    infoNode.textContent = '';
    const displayIncome = state.sameCountry && state.showPureIncome ? stats.pureIncome : stats.income;

    if (!row) {
      infoNode.append(
        `${stats.count}张`,
        document.createElement('br'),
        `均价${formatMoney(stats.avg, stats)}`,
        document.createElement('br'),
        `预计税后收入${formatMoney(stats.income, stats)}`,
      );
      return;
    }

    const incomeCell = infoNode.closest('.sgtci-card-income');
    const avgCell = row.querySelector('.sgtci-card-avgprice');
    const countCell = row.querySelector('.sgtci-card-count');

    if (incomeCell) {
      incomeCell.dataset.sort = stats.income.toFixed(2);
      incomeCell.dataset.sortPure = stats.pureIncome.toFixed(2);
      incomeCell.classList.toggle('sgtci-positive', state.sameCountry && stats.pureIncome > 0);
    }
    if (avgCell) {
      avgCell.dataset.sort = stats.avg.toFixed(2);
      avgCell.textContent = formatMoney(stats.avg, stats);
    }
    if (countCell) {
      countCell.dataset.sort = String(stats.count);
      countCell.textContent = String(stats.count);
    }

    infoNode.textContent = formatMoney(displayIncome, stats);
  }

  function formatMoney(amount, currency) {
    const value = amount.toFixed(2);
    if (currency.position === 'back') {
      return `${value}${currency.currency}`;
    }
    return `${currency.currency}${value}`;
  }

  function ensureHeaders(table) {
    const headerRow = table.querySelector('thead > tr');
    if (!headerRow || headerRow.querySelector('.sgtci-card-income-head')) {
      return;
    }

    [
      ['sgtci-card-income-head', 'CardIncome', 0],
      ['sgtci-card-avgprice-head', 'AvgPrice', 1],
      ['sgtci-card-count-head', 'Count', 2],
    ].forEach(([className, label, column]) => {
      const header = document.createElement('th');
      header.className = `sorting ${className}`;
      header.textContent = label;
      header.addEventListener('click', () => sortRows(column));
      headerRow.appendChild(header);
    });
  }

  function ensureResultCells(row) {
    let income = row.querySelector('.sgtci-card-income');
    let avg = row.querySelector('.sgtci-card-avgprice');
    let count = row.querySelector('.sgtci-card-count');

    if (!income) {
      income = document.createElement('td');
      income.className = 'sgtci-card-income';
      avg = document.createElement('td');
      avg.className = 'sgtci-card-avgprice';
      count = document.createElement('td');
      count.className = 'sgtci-card-count';
      row.append(income, avg, count);
    }

    const link = income.querySelector('a') || document.createElement('a');
    if (!link.parentNode) {
      income.appendChild(link);
    }

    return { income, avg, count, link };
  }

  function resetResultCells(cells) {
    cells.income.classList.remove('sgtci-positive');
    cells.income.dataset.sort = '0';
    cells.income.dataset.sortPure = '0';
    cells.avg.dataset.sort = '0';
    cells.count.dataset.sort = '0';
    cells.avg.textContent = '';
    cells.count.textContent = '';
    cells.link.textContent = '';
    cells.link.removeAttribute('class');
  }

  function sortRows(column) {
    const rows = getRows();
    if (rows.length === 0) {
      return;
    }

    state.sortAsc = column === state.sortColumn ? !state.sortAsc : false;
    state.sortColumn = column;

    const classNames = ['.sgtci-card-income', '.sgtci-card-avgprice', '.sgtci-card-count'];
    const selector = classNames[column];
    const tbody = rows[0].parentNode;

    rows.sort((a, b) => {
      const aCell = a.querySelector(selector);
      const bCell = b.querySelector(selector);
      const key = column === 0 && state.sameCountry && state.showPureIncome ? 'sortPure' : 'sort';
      const aValue = Number.parseFloat(aCell?.dataset[key] || '0');
      const bValue = Number.parseFloat(bCell?.dataset[key] || '0');
      return (aValue - bValue) * (state.sortAsc ? 1 : -1);
    });

    rows.forEach((row) => tbody.appendChild(row));
  }

  function refreshIncomeDisplay() {
    if (!state.sameCountry) {
      window.alert('SteamDB 和 Steam 社区货币不同，该功能无法使用。');
      state.showPureIncome = false;
      const toggle = document.querySelector('#sgtci-show-pure-income');
      if (toggle) {
        toggle.dataset.checked = 'false';
        toggle.classList.remove('checked');
      }
      return;
    }

    document.querySelectorAll('.sgtci-card-income').forEach((cell) => {
      const link = cell.querySelector('a');
      if (!link || link.dataset.queried !== 'true') {
        return;
      }
      const value = state.showPureIncome ? cell.dataset.sortPure : cell.dataset.sort;
      const currency = state.steamDBCurrency || { currency: '', position: 'front' };
      link.textContent = formatMoney(Number.parseFloat(value || '0'), currency);
    });
  }

  function readSteamDBCurrency() {
    const prices = Array.from(document.querySelectorAll('#DataTables_Table_0 > tbody td:nth-child(5)'));
    const sample = prices.find((cell) => Number.parseFloat(cell.dataset.sort || '0') > 0);
    if (!sample) {
      return null;
    }

    const text = sample.textContent.trim();
    const price = parsePriceText(text);
    if (!price) {
      return null;
    }
    return {
      currency: price.currency,
      position: price.position,
    };
  }

  function updateCountryState(doc, html) {
    if (!document.querySelector('#DataTables_Table_0')) {
      return;
    }

    const steamDBCountry = document.querySelector('#DataTables_Table_0 > thead img')?.src
      ?.replace(/.*\//, '')
      ?.replace('.svg', '')
      ?.toUpperCase();

    const countryMatch = html.match(/"wallet_country":"([A-Za-z]+)"/);
    if (countryMatch) {
      state.steamCountry = countryMatch[1].toUpperCase();
    }

    if (steamDBCountry && state.steamCountry) {
      state.sameCountry = steamDBCountry === state.steamCountry;
    }
  }

  function checkLoginStatus() {
    const loginInfo = document.querySelector('#sgtci-login-info');
    if (!loginInfo) {
      return;
    }

    requestText('https://steamcommunity.com/market/')
      .then((html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const account = doc.querySelector('#account_pulldown');
        const countryMatch = html.match(/"wallet_country":"([A-Za-z]+)"/);
        if (countryMatch) {
          state.steamCountry = countryMatch[1].toUpperCase();
        }

        if (account) {
          loginInfo.style.color = 'rgb(91, 253, 0)';
          loginInfo.textContent = `社区已登录：${account.textContent.replace(/[\n\t]/g, '').trim()}`;
          loginInfo.href = doc.querySelector('#global_actions > a')?.href || 'https://steamcommunity.com';
        } else {
          loginInfo.style.color = 'red';
          loginInfo.textContent = '社区未登录×';
          loginInfo.href = 'https://steamcommunity.com';
        }
      })
      .catch(() => {
        loginInfo.style.color = 'red';
        loginInfo.textContent = '社区连接失败×';
        loginInfo.href = 'https://steamcommunity.com';
      });
  }

  function appendRetry(infoNode, appid, context) {
    const parent = infoNode.parentNode;
    if (!parent || parent.querySelector('.sgtci-retry')) {
      return;
    }

    if (parent.dataset.sort !== undefined) {
      parent.appendChild(document.createElement('br'));
    }

    const retry = document.createElement('a');
    retry.href = '#';
    retry.className = 'sgtci-retry';
    retry.textContent = '点击重试';
    retry.addEventListener('click', (event) => {
      event.preventDefault();
      retry.remove();
      infoNode.textContent = '';
      infoNode.removeAttribute('class');
      getCardInfo(appid, infoNode, context).catch((error) => {
        markError(infoNode, '解析结果出错', context.index);
        appendRetry(infoNode, appid, context);
        console.error('[Steam Get Trading Card Info]', error);
      });
    });
    parent.appendChild(retry);
  }

  function markError(infoNode, message, index) {
    renderStatus(infoNode, message, 'error');
    infoNode.dataset.queried = 'error';
    if (typeof index === 'number') {
      state.lastIndex = Math.max(state.lastIndex, index);
    }
  }

  function renderStatus(node, message, status) {
    node.textContent = message;
    node.classList.toggle('sgtci-status-error', status === 'error');
    node.classList.toggle('sgtci-status-empty', status === 'empty');
  }

  function isMarketRateLimited(doc) {
    const title = doc.title || '';
    const message = doc.querySelector('.market_listing_table_message')?.textContent || '';
    return /错误|error|too many requests/i.test(`${title} ${message}`);
  }

  function createButton(label, onClick) {
    const button = document.createElement('a');
    button.href = '#';
    button.className = 'btn sgtci-btn';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      onClick(event);
    });
    return button;
  }

  function createToggle(label, onChange = () => {}) {
    const root = document.createElement('div');
    root.className = 'steamy-checkbox-control';
    root.dataset.checked = 'false';
    const box = document.createElement('div');
    box.className = 'steamy-checkbox';
    root.appendChild(box);

    const text = document.createElement('span');
    text.className = 'steamy-checkbox-label';
    text.textContent = label;
    root.appendChild(text);

    root.addEventListener('click', () => {
      const checked = root.dataset.checked !== 'true';
      root.dataset.checked = String(checked);
      root.classList.toggle('checked', checked);
      onChange(checked);
    });

    return { root };
  }

  function setFilter() {
    let url = 'https://steamdb.info/sales/?displayOnly=Game&min_reviews=0&tagid=-1003823&min_rating=0&min_discount=0&category=29';
    if (state.steamCountry) {
      url += `&cc=${state.steamCountry.toLowerCase()}`;
    }
    location.href = `${url}#setFilter`;
  }

  function getRows() {
    return Array.from(document.querySelectorAll('#DataTables_Table_0 > tbody > tr'));
  }

  function clearTimers() {
    state.timers.forEach((timer) => window.clearTimeout(timer));
    state.timers = [];
  }

  function getAppIdFromPath(pathname) {
    return pathname.match(/\/app\/(\d+)/)?.[1] || '';
  }

  function calcFee(priceCents) {
    let priceWithoutFee = Math.max(Math.floor(priceCents / 1.15), 1);
    let valveFee = Math.max(Math.floor(priceWithoutFee * 0.1), 1);
    let publisherFee = Math.max(Math.floor(priceWithoutFee * 0.05), 1);

    for (let i = 0; i < 100 && priceWithoutFee + valveFee + publisherFee !== priceCents; i += 1) {
      priceWithoutFee += priceWithoutFee + valveFee + publisherFee > priceCents ? -1 : 1;
      valveFee = Math.max(Math.floor(priceWithoutFee * 0.1), 1);
      publisherFee = Math.max(Math.floor(priceWithoutFee * 0.05), 1);
    }

    return priceWithoutFee;
  }
})();


