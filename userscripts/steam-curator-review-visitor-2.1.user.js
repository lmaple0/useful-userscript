// ==UserScript==
// @name:zh-CN               鉴赏家评测访问助手
// @name                     Steam Curator Review Visitor
// @version                  2.1
// @description              检测鉴赏家主页中的评测并自动批量访问 - 直接走 Steam ajaxgetcuratorrecommendations 接口拉取全部评测，无需手动滚动
// @description:zh-CN        检测鉴赏家主页中的评测并自动批量访问 - 直接走 Steam ajaxgetcuratorrecommendations 接口拉取全部评测，无需手动滚动
// @author                   Maple with Claude
// @match                    https://store.steampowered.com/curator/*
// @license                  AGPL-3.0
// @icon                     https://store.steampowered.com/favicon.ico
// @grant                    GM_addStyle
// @grant                    GM_xmlhttpRequest
// @grant                    GM_setValue
// @grant                    GM_getValue
// @connect                  store.steampowered.com
// @run-at                   document-idle
// ==/UserScript==


(function() {
    'use strict';


    // ============ 路径检测：仅鉴赏家公开主页（首页根路径） ============
    // 允许：/curator/44174077, /curator/44174077-name, /curator/44174077/, /curator/44174077-name/
    // 拒绝：/curator/XXX/admin/..., /curator/XXX/about, /curator/XXX/reviews, /curator/XXX/list/... 等子页面
    const PATH_RE = /^\/curator\/(\d+)(?:-[^/]*)?\/?$/;
    const pathMatch = location.pathname.match(PATH_RE);
    if (!pathMatch) return;


    // ============ 常量 ============
    const VERSION    = '2.1';
    const CLAN_ID    = pathMatch[1];
    const MAX_LOG    = 60;            // 进度日志保留条数
    const PAGE_SIZE  = 50;            // Steam 服务端最大 pagesize
    const KV_PREFIX  = 'scv_';
    const AJAX_URL   = `https://store.steampowered.com/curator/${CLAN_ID}/ajaxgetcuratorrecommendations/`;


    // ============ 持久化 ============
    function kvGet(k, d) { try { return GM_getValue(KV_PREFIX + k, d); } catch (e) { return d; } }
    function kvSet(k, v) { try { GM_setValue(KV_PREFIX + k, v); } catch (e) {} }


    // ============ 状态 ============
    const state = {
        reviews: new Map(),   // appid -> { appid, name, url, slug }
        selected: new Set(kvGet('selected_' + CLAN_ID, [])),
        loading: false,
        running: false,
        abort: false,
        totalAvailable: 0,
        stats: { success: 0, fail: 0, total: 0, done: 0 }
    };


    let g_LogCount = 0;


    // ============ 工具 ============
    function log(...args) { console.log('%c[SCV]', 'color:#67c1f5;font-weight:bold', ...args); }
    function warn(...args) { console.warn('[SCV]', ...args); }


    function ts() {
        const d = new Date();
        const p = n => n < 10 ? '0' + n : n;
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }


    function buildVisitURL(appid, slug) {
        const path = slug ? `/app/${appid}/${slug}/` : `/app/${appid}/`;
        return `https://store.steampowered.com${path}?snr=1_5_9__302&curator_clanid=${CLAN_ID}`;
    }


    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }


    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }


    // ============ 通过 GM_xmlhttpRequest 取一页评测（绕过 CORS） ============
    function fetchPage(start) {
        return new Promise((resolve, reject) => {
            const params = new URLSearchParams({
                query: '',
                start: String(start),
                count: String(PAGE_SIZE),
                dynamic_data: '',
                tagids: '',
                sort: 'recent',
                app_types: '',
                curations: '',
                reset: start === 0 ? 'true' : 'false'
            });
            GM_xmlhttpRequest({
                method: 'GET',
                url: AJAX_URL + '?' + params.toString(),
                timeout: 20000,
                headers: {
                    'Accept': '*/*',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': location.href
                },
                onload: r => {
                    try {
                        const data = JSON.parse(r.responseText);
                        if (data && data.success === 1) resolve(data);
                        else reject(new Error('success != 1'));
                    } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('xhr error')),
                ontimeout: () => reject(new Error('xhr timeout'))
            });
        });
    }


    // 从 HTML 字符串解析评测列表
    function parseResultsHtml(html) {
        const out = [];
        // 用 DOMParser 比正则更可靠
        const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
        const cards = doc.querySelectorAll('div.recommendation');
        cards.forEach(card => {
            // 优先用 data-ds-appid（AJAX 返回的卡片直接挂在 div.recommendation 上）
            let appid = card.getAttribute('data-ds-appid');
            // 兜底：从内部 store_capsule 取
            if (!appid) {
                const cap = card.querySelector('[data-ds-appid]');
                if (cap) appid = cap.getAttribute('data-ds-appid');
            }
            if (!appid) {
                // 最终兜底：从任意 href 中提取 /app/数字
                const a = card.querySelector('a[href*="/app/"]');
                if (a) {
                    const m = /\/app\/(\d+)/.exec(a.href);
                    if (m) appid = m[1];
                }
            }
            if (!appid) return;


            // 从 URL 提取 slug（用作显示名兜底）
            let slug = '';
            const link = card.querySelector('a[href*="/app/"]');
            if (link) {
                const m = /\/app\/\d+\/([^/?#]+)/.exec(link.getAttribute('href') || '');
                if (m) {
                    slug = decodeURIComponent(m[1]).replace(/_+/g, ' ').trim();
                    if (slug === '_' || /^[\s_]*$/.test(slug)) slug = '';
                }
            }


            out.push({
                appid: appid,
                slug: slug,
                name: slug || ('App #' + appid),
                url: buildVisitURL(appid, slug && /^[A-Za-z0-9 _-]+$/.test(slug) ? slug.replace(/\s+/g, '_') : '')
            });
        });
        return out;
    }


    // ============ 拉取全部评测（分页） ============
    async function loadAllReviews() {
        if (state.loading) return;
        state.loading = true;
        toggleControls(true);


        try {
            addLog('开始加载评测列表…', 'info');
            // 首页
            const first = await fetchPage(0);
            state.totalAvailable = first.total_count || 0;
            ingestReviews(parseResultsHtml(first.results_html || ''));
            updateCount();
            addLog(`共 ${state.totalAvailable} 条评测，正在分页拉取…`, 'info');


            // 余下分页
            const totalPages = Math.ceil(state.totalAvailable / PAGE_SIZE);
            for (let p = 1; p < totalPages; p++) {
                if (state.abort) { addLog('加载被中止', 'warn'); break; }
                try {
                    const data = await fetchPage(p * PAGE_SIZE);
                    ingestReviews(parseResultsHtml(data.results_html || ''));
                    updateCount();
                    if (p % 4 === 0) addLog(`已加载 ${state.reviews.size}/${state.totalAvailable}`, 'info');
                    // 节流（避免触发频控）
                    await delay(120);
                } catch (e) {
                    warn('第', p, '页失败：', e);
                    addLog(`第 ${p + 1} 页加载失败：${e.message}`, 'warn');
                }
            }
            addLog(`加载完成：${state.reviews.size}/${state.totalAvailable}`, state.reviews.size === state.totalAvailable ? 'ok' : 'warn');
        } catch (e) {
            warn('加载失败', e);
            addLog('加载失败：' + e.message, 'err');
        } finally {
            state.loading = false;
            state.abort = false;
            toggleControls(false);
            const filterEl = document.getElementById('scv_filter');
            if (filterEl && filterEl.value) applyFilter(filterEl.value.toLowerCase());
        }
    }


    function ingestReviews(list) {
        if (!list || !list.length) return;
        const frag = document.createDocumentFragment();
        let added = 0;
        for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (state.reviews.has(r.appid)) continue;
            state.reviews.set(r.appid, r);
            frag.appendChild(makeRow(r));
            added++;
        }
        if (added > 0) {
            const listEl = document.getElementById('scv_list');
            if (listEl) listEl.appendChild(frag);
        }
    }


    // ============ DOM 行 ============
    function makeRow(review) {
        const row = document.createElement('label');
        row.className = 'scv_row';
        row.dataset.appid = review.appid;
        const checked = state.selected.has(review.appid);
        row.innerHTML =
            '<input type="checkbox" class="scv_cb"' + (checked ? ' checked' : '') + '>' +
            '<span class="scv_appid">' + review.appid + '</span>' +
            '<span class="scv_name" title="' + escapeHtml(review.name) + '">' + escapeHtml(review.name) + '</span>' +
            '<a class="scv_link" href="' + escapeHtml(review.url) + '" target="_blank" rel="noopener">访问↗</a>' +
            '<span class="scv_state" data-appid="' + review.appid + '"></span>';
        return row;
    }


    function setRowState(appid, txt, color) {
        const el = document.querySelector('.scv_state[data-appid="' + appid + '"]');
        if (!el) return;
        el.textContent = txt;
        el.style.color = color || '';
    }


    // ============ UI ============
    function mountPanel() {
        if (document.getElementById('scv_panel')) return;


        const rounds = kvGet('rounds', 1);
        const delayMs = kvGet('delay', 1500);
        const concurrency = kvGet('concurrency', 2);
        const filter = kvGet('filter_' + CLAN_ID, '');


        const panel = document.createElement('div');
        panel.id = 'scv_panel';
        panel.className = 'scv_panel';
        panel.innerHTML =
            '<div class="scv_titlebar">' +
                '<span class="scv_title">鉴赏家评测访问助手 <span class="scv_ver">v' + VERSION + '</span></span>' +
                '<span class="scv_clan">Clan ' + CLAN_ID + '</span>' +
                '<a class="scv_minbtn" id="scv_min" title="折叠">▾</a>' +
            '</div>' +
            '<div class="scv_body" id="scv_body">' +
                '<div class="scv_row_in">' +
                    '<span class="scv_label">轮次</span>' +
                    '<input id="scv_rounds" type="number" min="1" max="50" value="' + rounds + '">' +
                    '<span class="scv_label">间隔ms</span>' +
                    '<input id="scv_delay" type="number" min="0" max="60000" step="100" value="' + delayMs + '">' +
                    '<span class="scv_label">并发</span>' +
                    '<input id="scv_conc" type="number" min="1" max="5" value="' + concurrency + '">' +
                    '<a class="scv_btn scv_btn_ghost" id="scv_reload" title="重新拉取全部评测"><span>↻</span></a>' +
                '</div>' +
                '<div class="scv_row_in">' +
                    '<input id="scv_filter" type="text" placeholder="搜索 AppID 或 slug…" value="' + escapeHtml(filter) + '">' +
                    '<a class="scv_btn" id="scv_selall"><span>全选</span></a>' +
                    '<a class="scv_btn scv_btn_ghost" id="scv_seln"><span>反选</span></a>' +
                    '<a class="scv_btn scv_btn_ghost" id="scv_clear"><span>清空</span></a>' +
                '</div>' +
                '<div class="scv_list" id="scv_list"></div>' +
                '<div class="scv_row_in scv_action">' +
                    '<a class="scv_btn scv_btn_blue" id="scv_start"><span>开始访问</span></a>' +
                    '<a class="scv_btn scv_btn_ghost" id="scv_stop"><span>停止</span></a>' +
                    '<span class="scv_stats" id="scv_stats">已选 <b id="scv_selcnt">0</b> / 共 <b id="scv_total">0</b></span>' +
                '</div>' +
                '<div class="scv_progress" id="scv_progress"></div>' +
            '</div>';
        document.body.appendChild(panel);


        bindEvents();
    }


    function bindEvents() {
        const $ = id => document.getElementById(id);


        $('scv_min').addEventListener('click', () => {
            const body = $('scv_body');
            const btn = $('scv_min');
            const collapsed = body.style.display === 'none';
            body.style.display = collapsed ? '' : 'none';
            btn.textContent = collapsed ? '▾' : '▴';
        });


        $('scv_list').addEventListener('change', e => {
            if (!e.target.classList.contains('scv_cb')) return;
            const appid = e.target.closest('.scv_row').dataset.appid;
            if (e.target.checked) state.selected.add(appid);
            else state.selected.delete(appid);
            persistSelected();
            updateCount();
        });


        $('scv_filter').addEventListener('input', e => {
            const q = e.target.value.trim().toLowerCase();
            kvSet('filter_' + CLAN_ID, q);
            applyFilter(q);
        });


        $('scv_selall').addEventListener('click', () => batchSelect('all'));
        $('scv_seln').addEventListener('click', () => batchSelect('invert'));
        $('scv_clear').addEventListener('click', () => batchSelect('clear'));


        $('scv_rounds').addEventListener('change', e => kvSet('rounds', +e.target.value || 1));
        $('scv_delay').addEventListener('change', e => kvSet('delay', +e.target.value || 1500));
        $('scv_conc').addEventListener('change', e => kvSet('concurrency', +e.target.value || 2));


        $('scv_reload').addEventListener('click', () => {
            if (state.running) {
                addLog('请先停止访问任务', 'warn');
                return;
            }
            // 清空已有列表并重新加载
            state.reviews.clear();
            document.getElementById('scv_list').innerHTML = '';
            updateCount();
            loadAllReviews();
        });


        $('scv_start').addEventListener('click', startVisiting);
        $('scv_stop').addEventListener('click', () => {
            if (!state.running && !state.loading) return;
            state.abort = true;
            addLog('收到停止请求，等待当前请求结束…', 'warn');
        });
    }


    function applyFilter(q) {
        const rows = document.querySelectorAll('#scv_list .scv_row');
        if (!q) {
            for (let i = 0; i < rows.length; i++) rows[i].style.display = '';
            return;
        }
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const id = r.dataset.appid.toLowerCase();
            const name = r.querySelector('.scv_name').textContent.toLowerCase();
            r.style.display = (id.indexOf(q) >= 0 || name.indexOf(q) >= 0) ? '' : 'none';
        }
    }


    function batchSelect(mode) {
        const rows = document.querySelectorAll('#scv_list .scv_row');
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].style.display === 'none') continue;
            const cb = rows[i].querySelector('.scv_cb');
            const id = rows[i].dataset.appid;
            if (mode === 'all') { cb.checked = true; state.selected.add(id); }
            else if (mode === 'clear') { cb.checked = false; state.selected.delete(id); }
            else if (mode === 'invert') {
                cb.checked = !cb.checked;
                if (cb.checked) state.selected.add(id);
                else state.selected.delete(id);
            }
        }
        persistSelected();
        updateCount();
    }


    function persistSelected() {
        kvSet('selected_' + CLAN_ID, Array.from(state.selected));
    }


    function updateCount() {
        const sel = document.getElementById('scv_selcnt');
        const tot = document.getElementById('scv_total');
        if (sel) sel.textContent = state.selected.size;
        if (tot) tot.textContent = state.reviews.size;
    }


    function toggleControls(loading) {
        const startBtn = document.getElementById('scv_start');
        const reloadBtn = document.getElementById('scv_reload');
        if (startBtn) startBtn.classList.toggle('scv_btn_disabled', loading);
        if (reloadBtn) reloadBtn.classList.toggle('scv_btn_disabled', loading);
    }


    function toggleRunButtons(running) {
        const s = document.getElementById('scv_start');
        const t = document.getElementById('scv_stop');
        const r = document.getElementById('scv_reload');
        if (s) s.classList.toggle('scv_btn_disabled', running);
        if (t) t.classList.toggle('scv_btn_disabled', !running);
        if (r) r.classList.toggle('scv_btn_disabled', running);
    }


    // ============ 日志 ============
    function addLog(text, level) {
        const box = document.getElementById('scv_progress');
        if (!box) return;
        const line = document.createElement('div');
        line.className = 'scv_log scv_log_' + (level || 'info');
        line.textContent = '[' + ts() + '] ' + text;
        box.appendChild(line);
        g_LogCount++;
        while (g_LogCount > MAX_LOG && box.firstChild) {
            box.removeChild(box.firstChild);
            g_LogCount--;
        }
        box.scrollTop = box.scrollHeight;
    }


    function clearLog() {
        const box = document.getElementById('scv_progress');
        if (box) box.innerHTML = '';
        g_LogCount = 0;
    }


    // ============ 队列执行器 ============
    function runQueue(items, concurrency, worker) {
        return new Promise(resolve => {
            let inFlight = 0;
            let idx = 0;
            let done = 0;
            const total = items.length;
            function pump() {
                if (state.abort) {
                    if (inFlight === 0) resolve();
                    return;
                }
                while (inFlight < concurrency && idx < total) {
                    const cur = items[idx++];
                    inFlight++;
                    Promise.resolve(worker(cur)).catch(() => {}).finally(() => {
                        inFlight--; done++;
                        if (done >= total || (state.abort && inFlight === 0)) resolve();
                        else pump();
                    });
                }
            }
            pump();
        });
    }


    // ============ 执行访问 ============
    async function startVisiting() {
        if (state.running) return;
        if (state.loading) { addLog('请等待评测加载完成', 'warn'); return; }
        if (state.selected.size === 0) { addLog('请先勾选要访问的评测', 'warn'); return; }


        const rounds = Math.max(1, parseInt(document.getElementById('scv_rounds').value) || 1);
        const delayMs = Math.max(0, parseInt(document.getElementById('scv_delay').value) || 1500);
        const concurrency = Math.min(5, Math.max(1, parseInt(document.getElementById('scv_conc').value) || 2));


        const targets = [];
        state.selected.forEach(appid => {
            const r = state.reviews.get(appid);
            if (r) targets.push(r);
        });
        if (!targets.length) { addLog('没有有效目标', 'warn'); return; }


        state.running = true;
        state.abort = false;
        state.stats = { success: 0, fail: 0, total: targets.length * rounds, done: 0 };


        toggleRunButtons(true);
        clearLog();
        addLog(`开始：${rounds} 轮 × ${targets.length} 项 = ${state.stats.total} 次，并发 ${concurrency}，间隔 ${delayMs}ms`, 'info');


        for (let round = 1; round <= rounds; round++) {
            if (state.abort) break;
            addLog(`—— 第 ${round}/${rounds} 轮 ——`, 'info');
            targets.forEach(t => setRowState(t.appid, '排队', '#8f98a0'));


            await runQueue(targets, concurrency, async target => {
                if (state.abort) return;
                setRowState(target.appid, '请求中', '#67c1f5');
                const ok = await visit(target);
                if (ok) state.stats.success++;
                else state.stats.fail++;
                state.stats.done++;
                setRowState(target.appid, ok ? '✓' : '✗', ok ? '#a4d007' : '#ff5151');
                const pct = ((state.stats.done / state.stats.total) * 100).toFixed(0);
                addLog(`[${pct}%] ${ok ? '✓' : '✗'} ${target.appid} ${target.name}`, ok ? 'ok' : 'err');
                if (delayMs > 0 && !state.abort) await delay(delayMs);
            });
        }


        const tag = state.abort ? '已中止' : '完成';
        addLog(`${tag}：成功 ${state.stats.success}，失败 ${state.stats.fail}`, state.stats.fail ? 'warn' : 'ok');
        state.running = false;
        state.abort = false;
        toggleRunButtons(false);
    }


    function visit(target) {
        return new Promise(resolve => {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: target.url,
                    timeout: 15000,
                    headers: { 'Referer': location.href },
                    onload: r => resolve(r.status >= 200 && r.status < 400),
                    onerror: () => resolve(false),
                    ontimeout: () => resolve(false),
                    onabort: () => resolve(false)
                });
            } catch (e) { resolve(false); }
        });
    }


    // ============ 启动 ============
    function init() {
        log('启动 v' + VERSION + '，clan=' + CLAN_ID);
        mountPanel();
        const rICb = window.requestIdleCallback || (cb => setTimeout(cb, 50));
        rICb(() => {
            addLog('就绪，点击右上角 ↻ 或直接开始 - 将通过接口拉取所有评测', 'info');
            loadAllReviews();
        });
    }


    // ============ 样式（Steam 原生风格） ============
    GM_addStyle(
        '.scv_panel{position:fixed;right:16px;bottom:16px;width:400px;max-height:80vh;display:flex;flex-direction:column;background:rgba(23,26,33,.96);border:1px solid #000;box-shadow:0 6px 24px rgba(0,0,0,.5),inset 1px 1px 0 rgba(255,255,255,.04);border-radius:3px;color:#c6d4df;font-family:"Motiva Sans",Arial,sans-serif;font-size:12px;z-index:99999}' +
        '.scv_titlebar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(to bottom,#3d4450 0%,#23272f 100%);border-bottom:1px solid #000;border-radius:3px 3px 0 0;user-select:none}' +
        '.scv_title{flex:1;color:#67c1f5;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}' +
        '.scv_ver{color:#8f98a0;font-size:10px;font-weight:400;letter-spacing:0;margin-left:4px}' +
        '.scv_clan{color:#8f98a0;font-size:10px;font-family:Consolas,monospace}' +
        '.scv_minbtn{cursor:pointer;color:#67c1f5;padding:2px 8px;font-size:14px;text-decoration:none}' +
        '.scv_minbtn:hover{color:#fff}' +
        '.scv_body{padding:10px 12px;overflow:hidden;display:flex;flex-direction:column;gap:8px;flex:1;min-height:0}' +
        '.scv_row_in{display:flex;align-items:center;gap:6px;flex-wrap:wrap}' +
        '.scv_label{color:#8f98a0;font-size:11px}' +
        '.scv_row_in input[type=number],.scv_row_in input[type=text]{background-color:#316282;background-image:linear-gradient(to bottom,#417a9b 5%,#1f3346 95%);border:1px solid rgba(0,0,0,.5);color:#fff;padding:4px 6px;border-radius:2px;font-size:12px;font-family:inherit;outline:none;width:64px}' +
        '.scv_row_in input[type=text]{flex:1;width:auto;min-width:120px}' +
        '.scv_row_in input:hover{background-image:linear-gradient(to bottom,#4d8bb0 5%,#25405c 95%)}' +
        '.scv_btn{display:inline-block;cursor:pointer;text-decoration:none;padding:1px;border-radius:2px;color:#67c1f5;background:rgba(103,193,245,.2);line-height:18px;transition:background .15s;user-select:none}' +
        '.scv_btn>span{display:block;padding:4px 10px;font-size:11px;color:inherit}' +
        '.scv_btn:hover{background:#67c1f5;color:#fff}' +
        '.scv_btn:hover>span{color:#fff}' +
        '.scv_btn_blue{background:linear-gradient(to right,#47bfff 0,#1a44c2 100%);color:#fff}' +
        '.scv_btn_blue>span{color:#fff}' +
        '.scv_btn_ghost{background:rgba(255,255,255,.05);color:#8f98a0}' +
        '.scv_btn_ghost>span{color:inherit}' +
        '.scv_btn_disabled{opacity:.35;pointer-events:none}' +
        '.scv_list{max-height:260px;overflow-y:auto;overflow-x:hidden;background:rgba(0,0,0,.25);border:1px solid rgba(0,0,0,.5);border-radius:2px;padding:2px;contain:layout style}' +
        '.scv_list::-webkit-scrollbar{width:8px}' +
        '.scv_list::-webkit-scrollbar-thumb{background:#316282;border-radius:4px}' +
        '.scv_list::-webkit-scrollbar-track{background:transparent}' +
        '.scv_row{display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;border-radius:2px;line-height:1.3;content-visibility:auto;contain-intrinsic-size:auto 30px}' +
        '.scv_row:hover{background:rgba(103,193,245,.08)}' +
        '.scv_cb{margin:0;cursor:pointer;accent-color:#67c1f5;flex:none}' +
        '.scv_appid{font-family:Consolas,monospace;color:#67c1f5;font-size:11px;flex:none;min-width:62px}' +
        '.scv_name{flex:1;color:#c6d4df;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}' +
        '.scv_link{flex:none;color:#67c1f5;text-decoration:none;font-size:11px;padding:0 4px}' +
        '.scv_link:hover{color:#fff;text-decoration:underline}' +
        '.scv_state{flex:none;min-width:40px;font-size:11px;text-align:right;font-family:Consolas,monospace}' +
        '.scv_action{margin-top:2px}' +
        '.scv_stats{margin-left:auto;color:#8f98a0;font-size:11px}' +
        '.scv_stats b{color:#67c1f5;font-weight:600}' +
        '.scv_progress{max-height:120px;overflow-y:auto;background:rgba(0,0,0,.35);border:1px solid rgba(0,0,0,.5);border-radius:2px;padding:6px 8px;font-family:Consolas,monospace;font-size:11px;line-height:1.5}' +
        '.scv_progress::-webkit-scrollbar{width:8px}' +
        '.scv_progress::-webkit-scrollbar-thumb{background:#316282;border-radius:4px}' +
        '.scv_log{color:#8f98a0}' +
        '.scv_log_ok{color:#a4d007}' +
        '.scv_log_err{color:#ff7373}' +
        '.scv_log_warn{color:#ffc83d}' +
        '.scv_log_info{color:#c6d4df}'
    );


    init();
})();

