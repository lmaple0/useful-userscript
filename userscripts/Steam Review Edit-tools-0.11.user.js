// ==UserScript==
// @name         Steam Review Edit-tools
// @version      0.11
// @description  Minimal BBCode toolbar for Steam review editor: B/I/U/S, link, list, quote, code, table, headings, preview, MD→BBCode.
// @author       sffxzzp / Maple with Claude
// @match        *://store.steampowered.com/app/*
// @match        *://steamcommunity.com/*/recommended/*
// @icon         https://store.steampowered.com/favicon.ico
// @connect      steamcommunity.com
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    // ---------- 网络（GM_xmlhttpRequest 包成 Promise） ----------
    function xhr(opts) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: opts.method || 'get',
                url: opts.url,
                data: opts.data,
                headers: opts.headers || {},
                responseType: opts.type || '',
                timeout: 30000,
                onload: function (res) { resolve(res.response); },
                onerror: reject,
                ontimeout: reject
            });
        });
    }

    // ---------- 样式（Steam 原生蓝灰，单段 ~30 行） ----------
    GM_addStyle([
        '.sre-bar{display:flex;flex-wrap:wrap;gap:2px;padding:4px 6px;margin:0 0 8px;background:#2a3f5a;border:1px solid #000;border-radius:2px;box-shadow:1px 1px 0 0 rgba(91,132,181,.15) inset;font:13px/1 "Motiva Sans",Arial,sans-serif}',
        '.sre-btn{display:inline-flex;align-items:center;gap:4px;height:28px;min-width:28px;padding:0 10px;color:#8f98a0;background:transparent;border:0;border-radius:2px;cursor:pointer;text-decoration:none!important;font:500 13px/1 inherit;user-select:none;transition:background-color .12s,color .12s}',
        '.sre-btn:hover{background:#67c1f5;color:#171a21}',
        '.sre-btn svg{width:15px;height:15px}',
        '.sre-btn b,.sre-btn i,.sre-btn u,.sre-btn s{font-style:normal;font-weight:700;font-size:14px;display:inline-block;width:15px;text-align:center}',
        '.sre-btn i{font-style:italic;font-family:Georgia,serif}',
        '.sre-btn u{text-decoration:underline}',
        '.sre-btn s{text-decoration:line-through}',
        '.sre-btn--accent{background:#67c1f5;color:#fff}',
        '.sre-btn--accent:hover{background:#8ed1ff;color:#fff}',
        '.sre-spacer{flex:1}',
        '#preview_body{padding:14px 16px;background:rgba(0,0,0,.2);border:1px solid #000;border-radius:2px;box-shadow:1px 1px 0 0 rgba(91,132,181,.2) inset;line-height:1.6;color:#8f98a0;margin-bottom:8px;font-family:"Motiva Sans",Arial,sans-serif}',
        '#preview_body .bb_ul>li,#preview_body ol{list-style-position:inside}',
        '#preview_body table{border-collapse:collapse;margin:8px 0;border:1px solid #000;border-radius:2px;overflow:hidden}',
        '#preview_body table td,#preview_body table th{border-bottom:1px solid #000;border-right:1px solid #000;padding:6px 12px;color:#8f98a0}',
        '#preview_body table th{background:#3d5a80;color:#c6d4df;font-weight:600;text-align:left}',
        '#preview_body table tr:last-child td{border-bottom:0}',
        '#preview_body table td:last-child,#preview_body table th:last-child{border-right:0}',
        '#preview_body blockquote{border-left:2px solid #67c1f5;margin:8px 0;padding:6px 14px;background:rgba(0,0,0,.15);color:#8f98a0}',
        '#preview_body .bb_code,#preview_body code,#preview_body pre{background:rgba(0,0,0,.25);border:1px solid #000;border-radius:2px;padding:8px 12px;color:#9fdfb1;font:12.5px/1.6 Consolas,monospace;white-space:pre;box-shadow:1px 1px 0 0 rgba(91,132,181,.2) inset}',
        '.widestore #review_create .content,.widestore .review_controls,.widestore .review_controls_subctn{display:block}',
        '.widestore #review_create .input_box{width:100%!important}',
        /* MD 转换 modal */
        '.sre-mask{position:fixed;inset:0;background:rgba(11,16,22,.75);display:flex;align-items:center;justify-content:center;z-index:99999}',
        '.sre-modal{background:#223345;border:1px solid #000;border-radius:3px;padding:18px 20px;min-width:420px;max-width:560px;color:#c6d4df;font:13px/1.5 "Motiva Sans",Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5)}',
        '.sre-modal h3{margin:0 0 12px;font-size:14px;font-weight:600;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.08)}',
        '.sre-modal textarea{width:100%;box-sizing:border-box;background:rgba(0,0,0,.2);color:#c6d4df;border:1px solid #000;border-radius:2px;padding:10px 12px;font:13px/1.55 Consolas,monospace;resize:vertical;outline:none;box-shadow:1px 1px 0 0 rgba(91,132,181,.2) inset}',
        '.sre-modal textarea:focus{border-color:#67c1f5}',
        '.sre-modal .actions{margin-top:12px;display:flex;gap:8px;justify-content:flex-end}'
    ].join(''));

    // ---------- 文本操作 ----------
    function wrap(el, start, end) {
        var s = el.selectionStart, e = el.selectionEnd, v = el.value;
        el.value = v.slice(0, s) + start + v.slice(s, e) + end + v.slice(e);
        el.selectionStart = s + start.length;
        el.selectionEnd = e + start.length;
        el.focus();
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function wrapList(el, open, close, item) {
        var s = el.selectionStart, e = el.selectionEnd, v = el.value;
        var sel = v.slice(s, e);
        var body = '\n' + item + sel.split('\n').join('\n' + item) + '\n';
        el.value = v.slice(0, s) + open + body + close + v.slice(e);
        el.focus();
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function insertAt(el, text) {
        var s = el.selectionStart, e = el.selectionEnd;
        el.value = el.value.slice(0, s) + text + el.value.slice(e);
        el.selectionStart = el.selectionEnd = s + text.length;
        el.focus();
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ---------- 链接（A1：极简 prompt） ----------
    function insertLink(el) {
        var s = el.selectionStart, e = el.selectionEnd;
        var sel = el.value.slice(s, e);
        var url = window.prompt('链接 URL:', sel && /^https?:\/\//i.test(sel) ? sel : 'https://');
        if (!url) return;
        url = url.trim();
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^mailto:/i.test(url)) url = 'https://' + url;
        var text = sel || url;
        var v = el.value;
        el.value = v.slice(0, s) + '[url=' + url + ']' + text + '[/url]' + v.slice(e);
        el.focus();
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ---------- 表格（B1：固定 3×3 模板） ----------
    function insertTable(el) {
        var t = [
            '',
            '[table]',
            '    [tr][th]列1[/th][th]列2[/th][th]列3[/th][/tr]',
            '    [tr][td]内容[/td][td]内容[/td][td]内容[/td][/tr]',
            '    [tr][td]内容[/td][td]内容[/td][td]内容[/td][/tr]',
            '[/table]',
            ''
        ].join('\n');
        insertAt(el, t);
    }

    // ---------- Markdown → BBCode ----------
    function mdToBB(md) {
        if (!md) return '';
        var ph = [];
        var save = function (s) { ph.push(s); return '\u0001PH' + (ph.length - 1) + '\u0001'; };
        var out = md.replace(/\r\n/g, '\n');
        out = out.replace(/```([\s\S]*?)```/g, function (_, t) { return save('[code]' + t.replace(/^\n+|\n+$/g, '') + '[/code]'); });
        out = out.replace(/`([^`\n]+?)`/g, function (_, t) { return save('[code]' + t + '[/code]'); });
        out = out.replace(/^###\s+(.+)$/gm, '[h3]$1[/h3]');
        out = out.replace(/^##\s+(.+)$/gm, '[h2]$1[/h2]');
        out = out.replace(/^#\s+(.+)$/gm, '[h1]$1[/h1]');
        out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (_, t, u) { return save('[url=' + u + ']' + t + '[/url]'); });
        out = out.replace(/^>\s+(.+)$/gm, '[quote]$1[/quote]');
        out = out.replace(/(?:^[ \t]*\d+\.[ \t]+.+(?:\n|$))+/gm, function (b) {
            return '[olist]\n' + b.replace(/\n+$/, '').split('\n').map(function (l) { return '    [*] ' + l.replace(/^[ \t]*\d+\.[ \t]+/, ''); }).join('\n') + '\n[/olist]\n';
        });
        out = out.replace(/(?:^[ \t]*[*\-][ \t]+.+(?:\n|$))+/gm, function (b) {
            return '[list]\n' + b.replace(/\n+$/, '').split('\n').map(function (l) { return '    [*] ' + l.replace(/^[ \t]*[*\-][ \t]+/, ''); }).join('\n') + '\n[/list]\n';
        });
        out = out.replace(/~~([^~\n]+?)~~/g, '[strike]$1[/strike]');
        out = out.replace(/\*\*([^*\n][^*]*?)\*\*/g, function (_, t) { return save('[b]' + t + '[/b]'); });
        out = out.replace(/(^|[^\w])_([^_\n]+?)_(?=[^\w]|$)/g, '$1[u]$2[/u]');
        out = out.replace(/(^|[^*\w])\*([^*\n]+?)\*(?=[^*\w]|$)/g, '$1[i]$2[/i]');
        out = out.replace(/^[\-*_]{3,}\s*$/gm, '[hr][/hr]');
        return out.replace(/\u0001PH(\d+)\u0001/g, function (_, i) { return ph[+i]; });
    }

    function showMdConverter(el) {
        var mask = document.createElement('div');
        mask.className = 'sre-mask';
        mask.innerHTML =
            '<div class="sre-modal">' +
              '<h3>Markdown → BBCode</h3>' +
              '<textarea rows="10" placeholder="# 标题\n**加粗** _下划线_ *斜体*\n* 列表项\n> 引用\n`代码`"></textarea>' +
              '<div class="actions">' +
                '<a class="sre-btn" data-act="cancel">关闭</a>' +
                '<a class="sre-btn" data-act="conv">转换</a>' +
                '<a class="sre-btn sre-btn--accent" data-act="ins">插入</a>' +
              '</div>' +
            '</div>';
        document.body.appendChild(mask);
        var ta = mask.querySelector('textarea');
        setTimeout(function () { ta.focus(); }, 30);
        mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
        mask.querySelector('[data-act="cancel"]').onclick = function () { mask.remove(); };
        mask.querySelector('[data-act="conv"]').onclick = function () { ta.value = mdToBB(ta.value); };
        mask.querySelector('[data-act="ins"]').onclick = function () { insertAt(el, '\n' + mdToBB(ta.value) + '\n'); mask.remove(); };
    }

    // ---------- 图标（仅给非 BIUS 的按钮） ----------
    var ICON = {
        link:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9a3 3 0 0 0 4 0l2-2a3 3 0 1 0-4-4L8 4"/><path d="M9 7a3 3 0 0 0-4 0L3 9a3 3 0 1 0 4 4l1-1"/></svg>',
        olist: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 4h8M6 8h8M6 12h8"/><text x="0" y="5" font-size="4" fill="currentColor" font-family="sans-serif" font-weight="700">1.</text><text x="0" y="9" font-size="4" fill="currentColor" font-family="sans-serif" font-weight="700">2.</text><text x="0" y="13" font-size="4" fill="currentColor" font-family="sans-serif" font-weight="700">3.</text></svg>',
        list:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 4h8M6 8h8M6 12h8"/><circle cx="3" cy="4" r="1" fill="currentColor"/><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/></svg>',
        quote: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5h2.5a1.5 1.5 0 0 1 1.5 1.5V8a1.5 1.5 0 0 1-1.5 1.5H5"/><path d="M8 5h2.5a1.5 1.5 0 0 1 1.5 1.5V8a1.5 1.5 0 0 1-1.5 1.5H10"/></svg>',
        code:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 4L2 8l3 4M11 4l3 4-3 4M8 3l1 10"/></svg>',
        table: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M2 6h12M2 10h12M6 2v12M10 2v12"/></svg>'
    };

    function btn(html, title, onClick, accent) {
        var b = document.createElement('button');
        b.className = 'sre-btn' + (accent ? ' sre-btn--accent' : '');
        b.title = title || '';
        b.innerHTML = html;
        b.onclick = onClick;
        return b;
    }

    // ---------- 主流程 ----------
    function build(community) {
        var target, input, ctlAnchor;
        if (community) {
            target = document.querySelector('#ReviewEdit');
            if (!target) return;
            input = target.querySelector('#ReviewEditTextArea');
            ctlAnchor = target.querySelector('.review_edit_received_compensation');
        } else {
            target = document.querySelector('#review_container .content');
            if (!target) return;
            input = target.querySelector('#game_recommendation');
            ctlAnchor = target.querySelector('.controls');
        }
        if (!input) return;

        var preview = document.createElement('div');
        preview.id = 'preview_body';
        preview.className = 'body_text';
        target.insertBefore(preview, ctlAnchor);

        var bar = document.createElement('div');
        bar.className = 'sre-bar';

        // BIUS 用文字
        bar.appendChild(btn('<b>B</b>',  '加粗 [b]',     function () { wrap(input, '[b]', '[/b]'); }));
        bar.appendChild(btn('<i>I</i>',  '斜体 [i]',     function () { wrap(input, '[i]', '[/i]'); }));
        bar.appendChild(btn('<u>U</u>',  '下划线 [u]',   function () { wrap(input, '[u]', '[/u]'); }));
        bar.appendChild(btn('<s>S</s>',  '删除线 [strike]', function () { wrap(input, '[strike]', '[/strike]'); }));
        bar.appendChild(btn(ICON.link,   '链接 [url]',   function () { insertLink(input); }));
        bar.appendChild(btn(ICON.olist,  '有序列表',     function () { wrapList(input, '[olist]', '[/olist]', '[*] '); }));
        bar.appendChild(btn(ICON.list,   '无序列表',     function () { wrapList(input, '[list]',  '[/list]',  '[*] '); }));
        bar.appendChild(btn(ICON.quote,  '引用 [quote]', function () { wrap(input, '[quote=作者]', '[/quote]'); }));
        bar.appendChild(btn(ICON.code,   '代码 [code]',  function () { wrap(input, '[code]', '[/code]'); }));
        bar.appendChild(btn(ICON.table,  '插入 3×3 表格', function () { insertTable(input); }));
        bar.appendChild(btn('H<sub>1</sub>', '一级标题', function () { wrap(input, '[h1]', '[/h1]'); }));
        bar.appendChild(btn('H<sub>2</sub>', '二级标题', function () { wrap(input, '[h2]', '[/h2]'); }));
        bar.appendChild(btn('H<sub>3</sub>', '三级标题', function () { wrap(input, '[h3]', '[/h3]'); }));
        bar.appendChild(btn('帮助', '格式帮助', function () {
            window.open('https://steamcommunity.com/comment/Recommendation/formattinghelp', 'fmt', 'height=640,width=640,resize=yes,scrollbars=yes');
        }));
        bar.appendChild(btn('MD→BB', 'Markdown 转 BBCode', function () { showMdConverter(input); }));

        var spacer = document.createElement('div');
        spacer.className = 'sre-spacer';
        bar.appendChild(spacer);

        var prevBtn = btn('预览', '预览渲染效果', async function () {
            if (prevBtn._loading) return;
            prevBtn._loading = true;
            var orig = prevBtn.innerHTML;
            prevBtn.textContent = '加载中…';
            try {
                var sid = localStorage.getItem('sre_sessionID');
                var data = await xhr({
                    url: 'https://steamcommunity.com/groups/keylol-player-club/announcements/preview',
                    method: 'post',
                    type: 'json',
                    data: 'sessionID=' + sid + '&action=preview&headline=&body=' + encodeURIComponent(input.value),
                    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }
                });
                preview.innerHTML = (data && data.body) || '';
            } catch (e) {
                preview.innerHTML = '<span style="color:#ff6c7c">预览失败</span>';
            } finally {
                prevBtn.innerHTML = orig;
                prevBtn._loading = false;
            }
        }, true);
        bar.appendChild(prevBtn);

        target.insertBefore(bar, input);
    }

    async function run() {
        if (location.href.match('steamcommunity.com')) {
            localStorage.setItem('sre_sessionID', unsafeWindow.g_sessionID);
            build(true);
            return;
        }
        if (location.href.match('store.steampowered.com')) {
            try {
                var html = await xhr({ url: 'https://steamcommunity.com/' });
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var m = /g_sessionID = "(.*?)";/g.exec(doc.querySelector('.responsive_page_content > script').innerHTML);
                if (m && m[1]) {
                    localStorage.setItem('sre_sessionID', m[1]);
                    build(false);
                } else {
                    alert('未登录社区');
                }
            } catch (e) { /* ignore */ }
        }
    }

    run();
})();
