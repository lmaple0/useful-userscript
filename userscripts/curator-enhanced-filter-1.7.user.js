// ==UserScript==
// @name:zh-CN               鉴赏家增强筛选工具
// @name                     Curator Enhanced Filter
// @version                  1.7
// @description              增强Steam鉴赏家已接受游戏的筛选功能：状态、接受/评测时间排序、接收者筛选
// @author                   Maple
// @match                    https://store.steampowered.com/curator/*/admin/accepted*
// @match                    https://store.steampowered.com/curator/*/admin/accepted/*
// @license                  AGPL-3.0
// @icon                     https://store.steampowered.com/favicon.ico
// @grant                    GM_addStyle
// @run-at                   document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ============ 常量 / 状态 ============
    const VERSION = '1.7';

    // 仅支持 中 / 英 / 日 三语日期解析（其他语言不保证准确）
    // 英文月份缩写/全称 → 0-11
    const EN_MONTHS = {
        jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
        jul:6, aug:7, sep:8, sept:8, oct:9, nov:10, dec:11,
        january:0, february:1, march:2, april:3, june:5,
        july:6, august:7, september:8, october:9, november:10, december:11
    };

    // 解析中英日三语日期，返回 timestamp 或 null
    // 支持：
    //   zh / ja: "2024 年 7 月 26 日", "2024年7月26日"（年可省，省略时按当年）
    //   en:      "26 Jul, 2024", "Jul 26, 2024", "26 Jul 2024",
    //            "26 Jul"（当年）, "Jul 26"（当年）
    //   ISO:     "2024-07-26", "2024/7/26"
    function parseDate(s) {
        if (!s) return null;
        s = s.trim();
        if (!s) return null;

        const curYear = new Date().getFullYear();

        // 1) 中日：(YYYY 年)? M 月 D 日
        let m = s.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        if (m) {
            const y = m[1] ? +m[1] : curYear;
            const mo = +m[2], d = +m[3];
            if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
                return new Date(y, mo - 1, d).getTime();
            }
        }

        // 2) ISO：YYYY-MM-DD / YYYY/M/D / YYYY.M.D
        m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
        if (m) {
            const mo = +m[2], d = +m[3];
            if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
                return new Date(+m[1], mo - 1, d).getTime();
            }
        }

        // 3) 英文：DD Mon[,] [YYYY]
        m = s.match(/(\d{1,2})\s+([A-Za-z]+)\.?(?:[\s,]+(\d{4}))?/);
        if (m) {
            const monIdx = EN_MONTHS[m[2].toLowerCase()];
            if (monIdx != null) {
                const y = m[3] ? +m[3] : curYear;
                const d = +m[1];
                if (d >= 1 && d <= 31) return new Date(y, monIdx, d).getTime();
            }
        }

        // 4) 英文：Mon DD[,] [YYYY]
        m = s.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:[\s,]+(\d{4}))?/);
        if (m) {
            const monIdx = EN_MONTHS[m[1].toLowerCase()];
            if (monIdx != null) {
                const y = m[3] ? +m[3] : curYear;
                const d = +m[2];
                if (d >= 1 && d <= 31) return new Date(y, monIdx, d).getTime();
            }
        }

        return null;
    }

    // "评测于"前缀（中英日繁），从评测块文本中切出日期片段
    // 日语正则统一为年份可选的 C/M/D 日格式，靠 parseDate 的 CJK 解析器兜底
    const REVIEW_PREFIXES = [
        /已于\s*(.+?)\s*评测/,                                  // zh-CN
        /已於\s*(.+?)\s*評測/,                                  // zh-TW
        /Reviewed\s+on\s+(.+?)(?:\s+Read\b|\s*$)/i,             // en
        /(\d{4}\s*年\s*)?(\d{1,2}\s*月\s*\d{1,2}\s*日)\s*に(?:レビュー|評価)/  // ja (年份可选)
    ];

    function extractReviewDate(text) {
        if (!text) return null;
        for (let i = 0; i < REVIEW_PREFIXES.length; i++) {
            const m = REVIEW_PREFIXES[i].exec(text);
            if (m) {
                // 日语格式年份可选时，m[1] 可能为 undefined，传递 m[2]（月日部分）
                const dateStr = m[2] || m[1];
                const t = dateStr ? parseDate(dateStr) : null;
                if (t != null) return t;
            }
        }
        // 全文兜底
        return parseDate(text);
    }

    let g_CuratorID    = null;
    let g_GameData     = [];
    let g_Reviewers    = null;       // Array (排好序，避免每次 from(Set))
    let g_Filter       = 'all';
    let g_Sort         = 'accept_desc';
    let g_LastSort     = null;       // 上一次排序，用于跳过相同排序的 reflow
    let g_Reviewer     = 'all';
    let g_PanelMounted = false;
    let g_LastMountedPath = null;
    let g_ApplyScheduled = false;

    const rICb = window.requestIdleCallback || function(cb) { return setTimeout(() => cb({ timeRemaining: () => 50 }), 0); };

    function log(...args) { console.log('%c[CEF]', 'color:#67c1f5;font-weight:bold', ...args); }
    function warn(...args) { console.warn('[CEF]', ...args); }

    // ============ 解析 ============
    function buildGameData() {
        const t0 = performance.now();
        const container = document.getElementById('apps_all');
        if (!container) { warn('apps_all 缺失'); return; }

        const reviewersSet = new Set();
        const data = [];
        // 用 children 比 querySelectorAll('#apps_all > .app_ctn') 快很多
        const children = container.children;
        const len = children.length;

        for (let i = 0; i < len; i++) {
            const el = children[i];
            if (!el.id || !el.id.startsWith('app-ctn-')) continue;

            // appid 直接从 id 切片，不用正则
            const appid = el.id.slice(8); // 'app-ctn-' 长度 8

            // 用 classList.contains 比 className 字符串匹配快
            const isReviewed = el.classList.contains('app_reviewed');

            // 名字 - 直接 getElementsByClassName 比 querySelector 快
            const nameEls = el.getElementsByClassName('app_name');
            const name = nameEls.length ? nameEls[0].textContent : '';

            // 评测日期：从评测块文本中提取（多语言兼容）
            // 评测文本通常在 .app_name_ctn 直接子文本里，例如：
            //   zh: "已于 2024 年 7 月 26 日 评测"
            //   en: "Reviewed on 26 Jul, 2024 Read review"
            let reviewDate = null;
            if (isReviewed) {
                const ctn = el.getElementsByClassName('app_name_ctn');
                if (ctn.length) {
                    // 只取直接文本节点（跳过 .app_name 和 .accepted_list 等子树），避免吃到接收者日期
                    let txt = '';
                    const kids = ctn[0].childNodes;
                    for (let k = 0; k < kids.length; k++) {
                        if (kids[k].nodeType === 3 /* TEXT_NODE */) txt += kids[k].nodeValue;
                    }
                    // 如果直接文本里没找到日期，再回退到 textContent（可能多吃到接收者日期，但至少能拿到东西）
                    reviewDate = extractReviewDate(txt) || extractReviewDate(ctn[0].textContent);
                }
            }

            // 接收者：直接从 .accepted_list 拿子元素，避免 querySelectorAll
            const reviewers = [];
            let acceptDate = null;
            const lists = el.getElementsByClassName('accepted_list');
            if (lists.length) {
                const rDivs = lists[0].children;
                for (let j = 0, jl = rDivs.length; j < jl; j++) {
                    const rDiv = rDivs[j];
                    const headEls = rDiv.getElementsByClassName('action_head');
                    if (!headEls.length) continue;
                    const dateEls = rDiv.getElementsByClassName('action_date');
                    const rName = headEls[0].textContent.trim();
                    const rDate = dateEls.length ? parseDate(dateEls[0].textContent) : null;
                    reviewers.push({ name: rName, date: rDate });
                    reviewersSet.add(rName);
                    if (rDate != null && (acceptDate == null || rDate > acceptDate)) {
                        acceptDate = rDate;
                    }
                }
            }

            data.push({
                element: el, appid, name, isReviewed,
                reviewDate, acceptDate, reviewers,
                originalIndex: i
            });
        }

        g_GameData = data;
        g_Reviewers = Array.from(reviewersSet).sort();

        // 诊断：日期解析成功率
        let acceptOk = 0, reviewOk = 0, reviewedTotal = 0;
        for (let i = 0; i < data.length; i++) {
            if (data[i].acceptDate != null) acceptOk++;
            if (data[i].isReviewed) {
                reviewedTotal++;
                if (data[i].reviewDate != null) reviewOk++;
            }
        }
        log(`解析完成 ${(performance.now()-t0).toFixed(1)}ms: 总=${data.length} 已评测=${reviewedTotal} 接收者=${g_Reviewers.length}`);
        log(`日期解析成功率: 接受时间 ${acceptOk}/${data.length}, 评测时间 ${reviewOk}/${reviewedTotal}`);
        if (acceptOk < data.length * 0.5 || (reviewedTotal > 0 && reviewOk < reviewedTotal * 0.5)) {
            warn('日期解析成功率偏低！请把以下样本贴给开发者：');
            for (let i = 0; i < Math.min(5, data.length); i++) {
                const el = data[i].element;
                const ctn = el.getElementsByClassName('app_name_ctn');
                const date = el.getElementsByClassName('action_date');
                warn('  样本' + i + ':',
                    ctn.length ? ctn[0].textContent.replace(/\s+/g,' ').slice(0,120) : '',
                    '| 接收者日期:', date.length ? date[0].textContent.trim() : '');
            }
        }
    }

    // ============ 筛选 / 排序（高效版） ============
    // 关键策略：
    //  1) 操作前把 #apps_all 从布局树脱离（display:none），浏览器不会做中间布局
    //  2) 一次性修改所有元素的 class（cef_hide / 不带），让 CSS 决定显示
    //  3) 仅排序变化时才 appendChild 重排
    //  4) 用 content-visibility:auto 让不在视口的卡片跳过 layout/paint
    function applyFilters() {
        const t0 = performance.now();
        const container = document.getElementById('apps_all');
        if (!container) return;

        const data = g_GameData;
        const filter = g_Filter;
        const reviewerName = g_Reviewer;
        const reviewerAll = reviewerName === 'all';
        const dataLen = data.length;

        // 1) 计算每个元素是否可见
        let visible = 0;
        const visMap = new Uint8Array(dataLen);
        for (let i = 0; i < dataLen; i++) {
            const g = data[i];
            let show = true;
            if (filter === 'unreviewed' && g.isReviewed) show = false;
            else if (filter === 'reviewed' && !g.isReviewed) show = false;
            if (show && !reviewerAll) {
                const rs = g.reviewers;
                let has = false;
                for (let k = 0, kl = rs.length; k < kl; k++) {
                    if (rs[k].name === reviewerName) { has = true; break; }
                }
                if (!has) show = false;
            }
            visMap[i] = show ? 1 : 0;
            if (show) visible++;
        }

        // 2) 把容器从渲染树脱离 - 关键性能技巧
        //    脱离后浏览器不会做中间布局/绘制，所有 DOM 操作合并成最终一次 layout
        const prevDisplay = container.style.display;
        container.style.display = 'none';

        try {
            // 3) 一次性应用 class（避免逐个写 inline style 触发样式失效）
            for (let i = 0; i < dataLen; i++) {
                const el = data[i].element;
                // 清掉原生 jQuery 留下的 inline display
                if (el.style.display) el.style.display = '';
                if (visMap[i]) {
                    if (el.classList.contains('cef_hide')) el.classList.remove('cef_hide');
                } else {
                    if (!el.classList.contains('cef_hide')) el.classList.add('cef_hide');
                }
            }

            // 4) 仅排序变化时才重排
            if (g_Sort !== g_LastSort) {
                const isAsc = g_Sort.endsWith('_asc');
                const isAccept = g_Sort.startsWith('accept');
                const isReview = g_Sort.startsWith('review');

                const indexed = new Array(dataLen);
                for (let i = 0; i < dataLen; i++) {
                    let v;
                    if (isAccept) v = data[i].acceptDate;
                    else if (isReview) v = data[i].reviewDate;
                    else v = data[i].originalIndex;
                    indexed[i] = { v: v == null ? (isAsc ? Infinity : -Infinity) : v, el: data[i].element };
                }
                indexed.sort(isAsc ? (a, b) => a.v - b.v : (a, b) => b.v - a.v);

                const frag = document.createDocumentFragment();
                for (let i = 0; i < dataLen; i++) frag.appendChild(indexed[i].el);
                suspendObserver(() => container.appendChild(frag));
                g_LastSort = g_Sort;
            }
        } finally {
            // 5) 恢复显示 - 浏览器在这一刻做唯一一次 layout/paint
            container.style.display = prevDisplay;
        }

        updateCount(visible, dataLen);
        const dt = (performance.now() - t0).toFixed(1);
        updateStatus(`筛选完成 (${dt}ms)`);
    }

    // 节流：连续点击合并到下一帧
    function scheduleApply() {
        if (g_ApplyScheduled) return;
        g_ApplyScheduled = true;
        requestAnimationFrame(() => {
            g_ApplyScheduled = false;
            applyFilters();
        });
    }

    // ============ 与原生 select 同步 ============
    function syncFromNativeSelect() {
        const sel = document.getElementById('filter_selector');
        if (!sel) return;
        const v = sel.value;
        if (v === g_Filter) return;
        g_Filter = v;
        updateFilterButtons();
        scheduleApply();
    }

    function hijackNativeApplyFilter() {
        try {
            if (typeof unsafeWindow !== 'undefined') {
                unsafeWindow.applyFilter = syncFromNativeSelect;
            } else {
                window.applyFilter = syncFromNativeSelect;
            }
        } catch (e) { /* 忽略 */ }
        const sel = document.getElementById('filter_selector');
        if (sel && !sel.dataset.cefHooked) {
            sel.addEventListener('change', syncFromNativeSelect);
            sel.dataset.cefHooked = '1';
        }
    }

    // ============ MutationObserver 暂停辅助 ============
    let g_ObserverDisconnected = false;
    let g_Observer = null;
    function suspendObserver(fn) {
        if (g_Observer) {
            g_Observer.disconnect();
            g_ObserverDisconnected = true;
        }
        try { fn(); }
        finally {
            if (g_Observer && g_ObserverDisconnected) {
                const sub = document.getElementById('subpage_container');
                if (sub) g_Observer.observe(sub, { childList: true });
                g_ObserverDisconnected = false;
            }
        }
    }

    // ============ UI ============
    function mountPanel() {
        if (g_PanelMounted) return;
        const nativeFilter = document.querySelector('.app_filter');
        if (!nativeFilter) return;

        const panel = document.createElement('div');
        panel.id = 'cef_panel';
        panel.className = 'cef_panel';
        panel.innerHTML =
            '<div class="cef_title">增强筛选工具 <span class="cef_ver">v' + VERSION + '</span></div>' +
            '<div class="cef_row">' +
                '<span class="cef_label">状态:</span>' +
                '<div class="cef_btn_group" id="cef_filter_group">' +
                    '<a class="cef_btn cef_active" data-val="all"><span>全部</span></a>' +
                    '<a class="cef_btn" data-val="unreviewed"><span>未评测</span></a>' +
                    '<a class="cef_btn" data-val="reviewed"><span>已评测</span></a>' +
                '</div>' +
                '<span class="cef_label">排序:</span>' +
                '<select id="cef_sort">' +
                    '<option value="accept_desc">接受时间（最新→最旧）</option>' +
                    '<option value="accept_asc">接受时间（最旧→最新）</option>' +
                    '<option value="review_desc">评测时间（最新→最旧）</option>' +
                    '<option value="review_asc">评测时间（最旧→最新）</option>' +
                    '<option value="none">原始顺序</option>' +
                '</select>' +
                '<span class="cef_label">接收者:</span>' +
                '<select id="cef_reviewer"><option value="all">全部接收者</option></select>' +
                '<a id="cef_reload" class="cef_btn cef_btn_blue"><span>重新解析</span></a>' +
            '</div>' +
            '<div class="cef_row cef_meta">' +
                '<span id="cef_status">就绪</span>' +
                '<span id="cef_count"></span>' +
            '</div>';
        nativeFilter.parentNode.insertBefore(panel, nativeFilter.nextSibling);

        // 用事件委托：一个监听器代替 3 个
        panel.querySelector('#cef_filter_group').addEventListener('click', e => {
            const btn = e.target.closest('.cef_btn');
            if (!btn) return;
            g_Filter = btn.dataset.val;
            updateFilterButtons();
            const native = document.getElementById('filter_selector');
            if (native && native.value !== g_Filter) native.value = g_Filter;
            scheduleApply();
        });
        panel.querySelector('#cef_sort').addEventListener('change', e => {
            g_Sort = e.target.value;
            scheduleApply();
        });
        panel.querySelector('#cef_reviewer').addEventListener('change', e => {
            g_Reviewer = e.target.value;
            scheduleApply();
        });
        panel.querySelector('#cef_reload').addEventListener('click', () => {
            updateStatus('重新解析中...');
            buildGameData();
            refreshReviewerSelect();
            g_LastSort = null; // 强制重排
            scheduleApply();
        });

        g_PanelMounted = true;
    }

    function updateFilterButtons() {
        const grp = document.getElementById('cef_filter_group');
        if (!grp) return;
        const btns = grp.children;
        for (let i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('cef_active', btns[i].dataset.val === g_Filter);
        }
    }

    function refreshReviewerSelect() {
        const sel = document.getElementById('cef_reviewer');
        if (!sel) return;
        const prev = sel.value;
        // 用 innerHTML 一次性写入，比 appendChild 循环快
        let html = '<option value="all">全部接收者</option>';
        const list = g_Reviewers || [];
        for (let i = 0; i < list.length; i++) {
            const n = list[i];
            html += '<option>' + escapeHtml(n) + '</option>';
        }
        sel.innerHTML = html;
        sel.value = (prev && (prev === 'all' || list.indexOf(prev) >= 0)) ? prev : 'all';
        g_Reviewer = sel.value;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function updateStatus(s) {
        const el = document.getElementById('cef_status');
        if (el) el.textContent = s;
    }
    function updateCount(v, t) {
        const el = document.getElementById('cef_count');
        if (el) el.textContent = '显示 ' + v + ' / 共 ' + t + ' 个游戏';
    }

    // ============ 入口 ============
    function init() {
        const m = location.pathname.match(/\/curator\/([^/]+)\/admin\/accepted/);
        if (!m) return;
        g_CuratorID = m[1];
        log('启动 v' + VERSION);

        const sub = document.getElementById('subpage_container');
        if (sub) {
            // 只关心 children 直接变化（页面切换），不监听 subtree
            g_Observer = new MutationObserver(() => {
                // 只有 URL 真正发生变化时才重挂载
                if (location.pathname === g_LastMountedPath) return;
                if (!location.pathname.includes('/admin/accepted')) return;
                clearTimeout(init._t);
                init._t = setTimeout(tryMount, 250);
            });
            g_Observer.observe(sub, { childList: true });
        }
        tryMount();
    }

    function tryMount(retries) {
        retries = retries || 0;
        if (!document.querySelector('#apps_all')) {
            if (retries < 30) return setTimeout(() => tryMount(retries + 1), 300);
            warn('等待 #apps_all 超时');
            return;
        }

        g_PanelMounted = false;
        g_LastSort = null;
        const old = document.getElementById('cef_panel');
        if (old) old.remove();

        // 优先挂面板，让用户立刻看到 UI
        mountPanel();
        hijackNativeApplyFilter();

        // 给所有图片加 lazy loading + async decode（减少初次加载时的并发请求和主线程阻塞）
        rICb(() => {
            const imgs = document.querySelectorAll('#apps_all .app_capsule img');
            for (let i = 0; i < imgs.length; i++) {
                const img = imgs[i];
                if (!img.loading) img.loading = 'lazy';
                if (!img.decoding) img.decoding = 'async';
                // Steam 标准 capsule 尺寸 292x136，预设可避免懒加载完成时撑高引发 reflow
                if (!img.width) img.width = 292;
                if (!img.height) img.height = 136;
            }
        });

        // 解析放到下一空闲时段，不阻塞
        rICb(() => {
            buildGameData();
            refreshReviewerSelect();
            applyFilters();
            g_LastMountedPath = location.pathname;
        });
    }

    // ============ 样式 ============
    GM_addStyle(
        // 关键性能样式：
        // - cef_hide：用 class 隐藏，比 inline display 切换样式失效更轻
        // - content-visibility:auto：浏览器跳过非视口卡片的 layout/paint
        // - contain-intrinsic-size：给跳过渲染的卡片预设占位高度，避免滚动条跳动
        // - contain:layout style：限制 reflow 在卡片内部，不影响兄弟和父级
        '#apps_all > .app_ctn{content-visibility:auto;contain-intrinsic-size:auto 220px;contain:layout style}' +
        '#apps_all > .app_ctn.cef_hide{display:none!important}' +
        '.cef_panel{background:rgba(0,0,0,.2);border:1px solid #000;box-shadow:inset 1px 1px 0 rgba(255,255,255,.04);padding:12px 14px;margin:8px 0 14px;color:#c6d4df;font-family:"Motiva Sans",Arial,sans-serif;font-size:13px}' +
        '.cef_title{color:#67c1f5;font-size:14px;font-weight:300;text-transform:uppercase;letter-spacing:1px;padding-bottom:8px;border-bottom:1px solid rgba(103,193,245,.15);margin-bottom:10px}' +
        '.cef_ver{font-size:11px;color:#8f98a0;margin-left:6px;letter-spacing:0}' +
        '.cef_row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:6px}' +
        '.cef_label{color:#8f98a0;font-size:12px;margin-left:4px}' +
        '.cef_btn_group{display:inline-flex;gap:4px}' +
        '.cef_btn{display:inline-block;cursor:pointer;text-decoration:none;color:#67c1f5;background:rgba(103,193,245,.2);padding:1px;border-radius:2px;line-height:18px;transition:background .15s}' +
        '.cef_btn>span{display:block;padding:4px 12px;font-size:12px;color:inherit}' +
        '.cef_btn:hover{background:#67c1f5;color:#fff}' +
        '.cef_btn.cef_active{background:linear-gradient(to right,#47bfff 0,#1a44c2 100%);color:#fff}' +
        '.cef_btn_blue{background:linear-gradient(to right,#47bfff 0,#1a44c2 100%);color:#fff;margin-left:auto}' +
        '#cef_sort,#cef_reviewer{background-color:#316282;background-image:linear-gradient(to bottom,#417a9b 5%,#1f3346 95%);border:1px solid rgba(0,0,0,.5);color:#fff;padding:4px 6px;border-radius:2px;font-size:12px;font-family:inherit;outline:none;cursor:pointer}' +
        '#cef_sort:hover,#cef_reviewer:hover{background-image:linear-gradient(to bottom,#4d8bb0 5%,#25405c 95%)}' +
        '#cef_reviewer{min-width:160px}' +
        '.cef_meta{color:#8f98a0;font-size:11px;padding-top:6px;border-top:1px solid rgba(255,255,255,.04)}' +
        '#cef_count{margin-left:auto;color:#67c1f5}'
    );

    init();
})();
