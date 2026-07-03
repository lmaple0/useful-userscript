// ==UserScript==
// @name         SteamDB Table Exporter
// @namespace    https://github.com/local/steamdb-table-export
// @version      0.1.0
// @description  Export the table on the current SteamDB page with page-specific configs.
// @author       local
// @match        https://steamdb.info/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PAGE_CONFIGS = [
    {
      id: 'search',
      label: 'Search',
      match: ({ pathname }) => pathname.startsWith('/search/'),
      tableSelector: '#table-sortable',
      filename: () => `steamdb-search-${dateStamp()}`,
      mountButton: ({ table }) => insertBeforeTable(table),
      columns: [
        { key: 'appid', label: 'AppID', getValue: ({ row }) => matchLink(row, /\/app\/(\d+)/) },
        { key: 'type', label: 'Type', getValue: ({ cells }) => text(cells[0]) },
        { key: 'name', label: 'Name', getValue: ({ row, cells }) => text(row.querySelector('a[href^="/app/"]')) || text(cells[1]) },
        { key: 'last_update', label: 'Last Update', getValue: ({ cells }) => timeValue(cells[cells.length - 1]) },
      ],
      fallbackColumns: true,
    },
    {
      id: 'sales',
      label: 'Sales',
      match: ({ pathname }) => pathname.startsWith('/sales/'),
      tableSelector: '#DataTables_Table_0',
      filename: () => `steamdb-sales-${dateStamp()}`,
      mountButton: ({ table }) => {
        const filter = document.querySelector('#DataTables_Table_0_filter');
        return filter || insertBeforeTable(table);
      },
      prepareRow: async ({ row }) => {
        row.scrollIntoView({ block: 'center', inline: 'nearest' });
        await waitForTimeTitles(row, 600);
      },
      columns: [
        { key: 'appid', label: 'AppID', getValue: ({ row }) => matchLink(row, /\/app\/(\d+)/) },
        { key: 'name', label: 'Name', getValue: ({ row, cells }) => text(row.querySelector('a[href^="/app/"]')) || text(cells[1]) },
        { key: 'discount', label: 'Discount', getValue: ({ row, cells }) => text(row.querySelector('.price-discount')) || findCellText(cells, /%/) },
        { key: 'price', label: 'Price', getValue: ({ row, cells }) => text(row.querySelector('.price-final')) || findCellText(cells, /[$€£¥]|free/i) },
        { key: 'rating', label: 'Rating', getValue: ({ cells }) => findCellText(cells, /%/) },
        { key: 'ends', label: 'Ends', getValue: ({ row, cells }) => timeValue(row.querySelector('[title]')) || timeValue(cells[cells.length - 1]) },
      ],
      fallbackColumns: true,
    },
  ];

  const state = {
    exporting: false,
  };

  init();

  function init() {
    const config = PAGE_CONFIGS.find((item) => item.match(window.location));
    if (!config) {
      return;
    }

    waitForElement(config.tableSelector, 15_000)
      .then((table) => addExportControls(config, table))
      .catch(() => {});
  }

  function addExportControls(config, table) {
    if (document.querySelector(`[data-steamdb-exporter="${config.id}"]`)) {
      return;
    }

    const wrapper = document.createElement('span');
    wrapper.dataset.steamdbExporter = config.id;
    wrapper.style.display = 'inline-flex';
    wrapper.style.gap = '6px';
    wrapper.style.margin = '6px';
    wrapper.style.verticalAlign = 'middle';

    const csvButton = button(`Export ${config.label} CSV`, () => exportTable(config, table, 'csv', csvButton, jsonButton));
    const jsonButton = button(`Export ${config.label} JSON`, () => exportTable(config, table, 'json', csvButton, jsonButton));

    wrapper.append(csvButton, jsonButton);

    const mount = config.mountButton ? config.mountButton({ table }) : insertBeforeTable(table);
    if (mount instanceof Element) {
      mount.append(wrapper);
    }
  }

  async function exportTable(config, table, format, ...buttons) {
    if (state.exporting) {
      return;
    }

    state.exporting = true;
    setBusy(buttons, true);

    try {
      const rows = getRows(table);
      const records = [];

      for (const row of rows) {
        if (config.prepareRow) {
          await config.prepareRow({ row, table, config });
        }

        const cells = Array.from(row.cells || []);
        const record = await getRowData(config, { row, cells, table });
        if (Object.values(record).some((value) => String(value || '').trim())) {
          records.push(record);
        }
      }

      const filename = `${config.filename()}-${records.length}.${format}`;
      const content = format === 'json' ? JSON.stringify(records, null, 2) : toCsv(records);
      const type = format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8';
      download(filename, content, type);
    } finally {
      setBusy(buttons, false);
      state.exporting = false;
    }
  }

  async function getRowData(config, context) {
    if (config.getRowData) {
      return config.getRowData(context);
    }

    const record = {};
    const usedLabels = new Set();

    for (const column of config.columns || []) {
      record[column.key] = await column.getValue(context);
      usedLabels.add(column.label);
    }

    if (config.fallbackColumns) {
      const headers = getHeaders(context.table);
      context.cells.forEach((cell, index) => {
        const label = headers[index] || `Column ${index + 1}`;
        const key = slug(label);
        if (!usedLabels.has(label) && !(key in record)) {
          record[key] = timeValue(cell) || text(cell);
        }
      });
    }

    return record;
  }

  function getRows(table) {
    const dt = window.jQuery && window.jQuery.fn && window.jQuery.fn.dataTable && window.jQuery.fn.dataTable.isDataTable(table)
      ? window.jQuery(table).DataTable()
      : null;

    if (dt) {
      return Array.from(dt.rows({ search: 'applied' }).nodes());
    }

    return Array.from(table.tBodies)
      .flatMap((tbody) => Array.from(tbody.rows))
      .filter((row) => row.offsetParent !== null);
  }

  function getHeaders(table) {
    return Array.from(table.tHead ? table.tHead.querySelectorAll('th') : table.querySelectorAll('thead th'))
      .map((header) => text(header))
      .filter(Boolean);
  }

  function waitForElement(selector, timeoutMs) {
    const existing = document.querySelector(selector);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          resolve(element);
        } else if (Date.now() > deadline) {
          observer.disconnect();
          reject(new Error(`Timed out waiting for ${selector}`));
        }
      });

      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for ${selector}`));
      }, timeoutMs);
    });
  }

  async function waitForTimeTitles(row, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (row.querySelector('time[title], [data-time][title], [title]')) {
        return;
      }
      await delay(50);
    }
  }

  function insertBeforeTable(table) {
    const container = document.createElement('div');
    container.style.margin = '8px 0';
    table.parentElement.insertBefore(container, table);
    return container;
  }

  function button(label, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.className = 'btn btn-sm';
    element.addEventListener('click', onClick);
    return element;
  }

  function setBusy(buttons, busy) {
    buttons.forEach((item) => {
      item.disabled = busy;
      item.dataset.originalText ||= item.textContent;
      item.textContent = busy ? 'Exporting...' : item.dataset.originalText;
    });
  }

  function text(element) {
    return (element && element.textContent ? element.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function timeValue(element) {
    if (!element) {
      return '';
    }

    const time = element.matches && element.matches('[title]') ? element : element.querySelector('[title]');
    return (time && time.getAttribute('title')) || text(element);
  }

  function matchLink(row, pattern) {
    const link = Array.from(row.querySelectorAll('a[href]')).find((item) => pattern.test(item.getAttribute('href')));
    return link ? link.getAttribute('href').match(pattern)[1] : '';
  }

  function findCellText(cells, pattern) {
    const cell = cells.find((item) => pattern.test(text(item)));
    return cell ? text(cell) : '';
  }

  function toCsv(records) {
    const headers = Array.from(records.reduce((set, record) => {
      Object.keys(record).forEach((key) => set.add(key));
      return set;
    }, new Set()));

    const lines = [headers.map(csvEscape).join(',')];
    records.forEach((record) => {
      lines.push(headers.map((key) => csvEscape(record[key] ?? '')).join(','));
    });

    return lines.join('\r\n');
  }

  function csvEscape(value) {
    const string = String(value);
    return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function slug(value) {
    return String(value || 'column')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'column';
  }

  function dateStamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
