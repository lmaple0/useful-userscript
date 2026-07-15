// ==UserScript==
// @name         Steam 令牌验证器（轻量版）
// @namespace    https://github.com/lmaple0/useful-userscript
// @version      1.0.0
// @description  轻量 Steam Guard TOTP + 批量交易/市场确认。无第三方依赖，支持多账号与批量导入
// @author       lmaple0
// @license      MIT
// @homepageURL  https://github.com/lmaple0/useful-userscript
// @supportURL   https://github.com/lmaple0/useful-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/lmaple0/useful-userscript/main/userscripts/steam-guard-authenticator.user.js
// @updateURL    https://raw.githubusercontent.com/lmaple0/useful-userscript/main/userscripts/steam-guard-authenticator.user.js
// @compatible   chrome >= 105
// @compatible   edge >= 105
// @compatible   firefox >= 121
// @compatible   safari >= 15.4
// @match        https://store.steampowered.com/*
// @match        https://help.steampowered.com/*
// @match        https://checkout.steampowered.com/*
// @match        https://steamcommunity.com/*
// @exclude      https://*.steampowered.com/login/transfer
// @exclude      https://*.steampowered.com/login/logout/
// @exclude      https://steamcommunity.com/login/transfer
// @exclude      https://steamcommunity.com/login/logout/
// @exclude      https://store.steampowered.com/widget/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      steampowered.com
// @connect      steamcommunity.com
// @connect      api.steampowered.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // =====================================================================
    // 0. 常量 / 工具
    // =====================================================================
    const KV_ACCOUNTS = 'accounts';
    const KV_TIMEOFFSET_AT = 'timeoffset_at';
    const KV_TIMEOFFSET = 'timeoffset_v1';
    const TOTP_PERIOD = 30;
    const TOTP_DIGITS = 5;
    const TOTP_CHARS  = '23456789BCDFGHJKMNPQRTVWXY';
    const TIME_REFRESH_MS = 30 * 60 * 1000; // 每 30 分钟刷新一次 timeOffset
    const REQUEST_TIMEOUT_MS = 15000;
    const MAX_IMPORT_CHARS = 2 * 1024 * 1024;

    const $J = unsafeWindow.$J || window.$J;          // 沿用 Steam 注入的 jQuery
    const _BuildDialog = unsafeWindow._BuildDialog;
    const _BuildDialogButton = unsafeWindow._BuildDialogButton;
    const ShowAlertDialog = unsafeWindow.ShowAlertDialog;
    const ShowConfirmDialog = unsafeWindow.ShowConfirmDialog;
    const ShowBlockingWaitDialog = unsafeWindow.ShowBlockingWaitDialog;
    const BindTooltips = unsafeWindow.BindTooltips;
    const AlignMenu = unsafeWindow.AlignMenu;

    if (!$J || !_BuildDialog) {
        console.warn('[SGuard] Steam jQuery/Dialog 未就绪，脚本退出');
        return;
    }

    function warn(...a) { console.warn('[SGuard]', ...a); }

    function isPlainObject(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    }

    function isSteamID(value) {
        return /^7656\d{13}$/.test(String(value || ''));
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    }

    // base64 ↔ Uint8Array
    function b64ToBytes(b64) {
        if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
            throw new Error('base64 格式不正确');
        }
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function bytesToB64(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }
    function hexToBytes(hex) {
        if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
            throw new Error('hex 格式不正确');
        }
        const out = new Uint8Array(hex.length >> 1);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i << 1, 2), 16);
        return out;
    }
    function bytesToHex(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
        return s;
    }

    // 智能解析 secret：长度 40 hex / 28 base64
    function parseSecret(s) {
        if (!s) throw new Error('密钥为空');
        s = s.trim();
        if (/^[0-9a-fA-F]{40}$/.test(s)) return hexToBytes(s);
        try {
            const bytes = b64ToBytes(s);
            if (bytes.length === 20) return bytes;
        } catch (e) { /* fallthrough */ }
        throw new Error('密钥格式不正确（需 40 字符 hex 或 base64 后 20 字节）');
    }

    function normalizeAccount(raw) {
        if (!isPlainObject(raw)) throw new Error('账户格式不正确');
        const account = {
            name: String(raw.name || '').trim().slice(0, 128) || '无名氏',
            secret: String(raw.secret || '').trim(),
            steamID: String(raw.steamID || '').trim(),
            identitySecret: String(raw.identitySecret || '').trim()
        };
        parseSecret(account.secret);
        if (account.steamID && !isSteamID(account.steamID)) throw new Error('SteamID 格式不正确');
        if (account.identitySecret) parseSecret(account.identitySecret);
        if (account.identitySecret && !account.steamID) throw new Error('身份密钥必须配合 SteamID 使用');
        return account;
    }

    function normalizeAccounts(values) {
        const accounts = [];
        let skipped = 0;
        for (const value of values) {
            try { accounts.push(normalizeAccount(value)); }
            catch (e) { skipped++; }
        }
        if (skipped) warn(`已忽略 ${skipped} 条无效账户记录`);
        return accounts;
    }

    // =====================================================================
    // 1. Web Crypto: HMAC-SHA1 / SHA1
    // =====================================================================
    async function hmacSha1(keyBytes, dataBytes) {
        const key = await crypto.subtle.importKey(
            'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
        );
        const sig = await crypto.subtle.sign('HMAC', key, dataBytes);
        return new Uint8Array(sig);
    }

    async function sha1(bytes) {
        const out = await crypto.subtle.digest('SHA-1', bytes);
        return new Uint8Array(out);
    }

    // 8 字节 BigEndian 写入
    function writeUInt64BE(value) {
        const buf = new Uint8Array(8);
        const v = BigInt(value);
        for (let i = 7; i >= 0; i--) {
            buf[i] = Number((v >> BigInt((7 - i) * 8)) & 0xffn);
        }
        return buf;
    }

    // =====================================================================
    // 2. TOTP / 确认密钥 / DeviceID
    // =====================================================================
    async function generateAuthCode(secretBytes, offset) {
        const time = Math.floor(Date.now() / 1000) + (offset || 0);
        const counter = writeUInt64BE(Math.floor(time / TOTP_PERIOD));
        const mac = await hmacSha1(secretBytes, counter);
        const start = mac[19] & 0x0F;
        let full = ((mac[start] & 0x7f) << 24) | (mac[start + 1] << 16) | (mac[start + 2] << 8) | mac[start + 3];
        let code = '';
        for (let i = 0; i < TOTP_DIGITS; i++) {
            code += TOTP_CHARS[full % TOTP_CHARS.length];
            full = Math.floor(full / TOTP_CHARS.length);
        }
        return code;
    }

    async function generateConfirmationKey(identitySecretBytes, time, tag) {
        const tagBytes = tag ? new TextEncoder().encode(tag.length > 32 ? tag.substr(0, 32) : tag) : new Uint8Array(0);
        const data = new Uint8Array(8 + tagBytes.length);
        data.set(writeUInt64BE(time), 0);
        if (tagBytes.length) data.set(tagBytes, 8);
        const mac = await hmacSha1(identitySecretBytes, data);
        return bytesToB64(mac);
    }

    async function getDeviceID(steamID) {
        const hash = await sha1(new TextEncoder().encode(String(steamID)));
        const hex = bytesToHex(hash);
        return 'android:' + hex.replace(/^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12}).*$/, '$1-$2-$3-$4-$5');
    }

    async function generateConfirmationQueryParams(account, tag) {
        if (!isSteamID(account.steamID)) throw new Error('SteamID 格式不正确');
        if (typeof tag !== 'string' || !/^[a-z0-9]{1,64}$/i.test(tag)) throw new Error('确认标签格式不正确');
        const time = Math.floor(Date.now() / 1000) + (state.timeOffset || 0);
        const idSecret = parseSecret(account.identitySecret);
        const key = await generateConfirmationKey(idSecret, time, tag);
        const deviceId = await getDeviceID(account.steamID);
        return 'a=' + encodeURIComponent(account.steamID)
            + '&tag=' + encodeURIComponent(tag)
            + '&l=schinese&m=react&t=' + time
            + '&p=' + encodeURIComponent(deviceId)
            + '&k=' + encodeURIComponent(key);
    }

    // =====================================================================
    // 3. 账户存储
    // =====================================================================
    async function loadAccounts() {
        const stored = await GM_getValue(KV_ACCOUNTS, []);
        if (!Array.isArray(stored)) throw new Error('账户存储格式不正确');
        return normalizeAccounts(stored);
    }

    async function saveAccounts(accounts) {
        const normalized = accounts.map(normalizeAccount);
        await GM_setValue(KV_ACCOUNTS, normalized);
        state.secretCache.clear();
        state.codeCache.clear();
    }

    // =====================================================================
    // 4. 状态
    // =====================================================================
    const state = {
        accounts: [],
        timeOffset: 0,
        userSteamID: null,
        secretCache: new Map(),     // accountId -> Uint8Array (避免每次重新解析)
        codeCache: new Map(),       // accountId -> {window, code}
    };

    function accountId(acc) {
        return acc.steamID ? 'steam:' + acc.steamID : 'secret:' + acc.secret;
    }

    function getSecretBytes(acc) {
        const id = accountId(acc);
        let b = state.secretCache.get(id);
        if (!b) {
            b = parseSecret(acc.secret);
            state.secretCache.set(id, b);
        }
        return b;
    }

    async function getCachedCode(acc) {
        const id = accountId(acc);
        const time = Math.floor(Date.now() / 1000) + state.timeOffset;
        const win = Math.floor(time / TOTP_PERIOD);
        const cached = state.codeCache.get(id);
        if (cached && cached.window === win) return cached.code;
        const code = await generateAuthCode(getSecretBytes(acc), state.timeOffset);
        state.codeCache.set(id, { window: win, code });
        return code;
    }

    function totpRemaining() {
        const time = Math.floor(Date.now() / 1000) + state.timeOffset;
        return TOTP_PERIOD - (time % TOTP_PERIOD);
    }

    function gmRequest(options) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                timeout: REQUEST_TIMEOUT_MS,
                ...options,
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status}`));
                        return;
                    }
                    resolve(response);
                },
                onerror: () => reject(new Error('网络请求失败')),
                ontimeout: () => reject(new Error('网络请求超时')),
                onabort: () => reject(new Error('网络请求已取消'))
            });
        });
    }

    // =====================================================================
    // 5. timeOffset 管理（首次 + 定期刷新）
    // =====================================================================
    async function refreshTimeOffset() {
        try {
            const r = await gmRequest({
                method: 'POST',
                url: 'https://api.steampowered.com/ITwoFactorService/QueryTime/v0001',
                responseType: 'json'
            });
            const t = Number(r.response && r.response.response && r.response.response.server_time);
            if (!Number.isSafeInteger(t)) throw new Error('服务器时间响应无效');
            const offset = t - Math.floor(Date.now() / 1000);
            if (Math.abs(offset) > 86400) throw new Error('服务器时间偏移异常');
            state.timeOffset = offset;
            await GM_setValue(KV_TIMEOFFSET, offset);
            await GM_setValue(KV_TIMEOFFSET_AT, Date.now());
        } catch (e) {
            warn('刷新服务器时间失败', e);
        }
    }

    function scheduleTimeRefresh() {
        setInterval(refreshTimeOffset, TIME_REFRESH_MS);
    }

    // =====================================================================
    // 6. UI 通用：确认列表 checkbox 行为（之前重复 2 处，现抽出）
    // =====================================================================
    function bindCheckboxBehavior(onAllow, onCancel) {
        $J(document).on('click.sguard', '.mobileconf_list_checkbox', function (e) {
            e.stopPropagation();
            const nChecked = $J('.mobileconf_list_checkbox input:checked').length;
            const $btns = $J('#mobileconf_buttons');
            if (nChecked > 0) {
                const $cancel = $J('#mobileconf_buttons .mobileconf_button_cancel');
                const $accept = $J('#mobileconf_buttons .mobileconf_button_accept');
                $cancel.off('click.sguard').text('取消选择').on('click.sguard', onCancel);
                $accept.off('click.sguard').text('确认已选择').on('click.sguard', onAllow);
                if ($btns.is(':hidden')) {
                    $btns.css('bottom', -$btns.height() + 'px').show();
                }
                requestAnimationFrame(() => $btns.css('bottom', '0'));
            } else {
                $btns.css('bottom', -$btns.height() + 'px');
            }
        });
    }

    // =====================================================================
    // 7. 主菜单 / 弹窗
    // =====================================================================
    let $authMenu, $authLink, $authDropdown;

    function setupTooltips(sel) {
        const host = location.hostname;
        const cls = host.indexOf('community') >= 0 ? 'community_tooltip'
                  : host.indexOf('help') >= 0 ? 'help_tooltip'
                  : 'store_tooltip';
        try { BindTooltips(sel, { tooltipCSSClass: cls }); } catch (e) {}
    }

    function openAddAccountDialog() {
        const $body = $J('<form/>');
        const $name = $J('<input type="text">');
        const $secret = $J('<input type="text">');
        const $sid = $J('<input type="text">');
        const $isec = $J('<input type="text">');
        const $totp = $J('<div style="font-family:monospace;color:#67c1f5;margin-top:6px;font-size:14px"></div>');

        function row(label, tip, $input) {
            $body.append($J('<div class="newmodal_prompt_description" style="margin-top:8px"></div>')
                .append(label + (tip ? `<span data-tooltip-text="${tip}"> (?)</span>` : '')));
            $body.append($J('<div class="newmodal_prompt_input gray_bevel for_text_input fullwidth"></div>').append($input));
        }
        row('Steam 帐户名称', '非个人资料名称，用于自动填写令牌验证码', $name);
        row('共享密钥', 'shared_secret，用于生成 TOTP', $secret);
        row('64 位 Steam ID', '"7656" 开头的 17 位数字', $sid);
        row('身份密钥', 'identity_secret，用于确认交易/市场（可选）', $isec);
        $body.append($totp);

        // 密钥仅在输入变化时解析；验证码仅在 30 秒窗口切换时重新计算。
        let previewBytes = null;
        let previewWindow = -1;
        let previewCode = '';
        let previewBusy = false;
        async function updatePreview() {
            if (!previewBytes) return;
            const win = Math.floor((Math.floor(Date.now() / 1000) + state.timeOffset) / TOTP_PERIOD);
            if (win !== previewWindow && !previewBusy) {
                previewBusy = true;
                try {
                    previewCode = await generateAuthCode(previewBytes, state.timeOffset);
                    previewWindow = win;
                } finally {
                    previewBusy = false;
                }
            }
            if (previewCode) $totp.text(`实时验证码: ${previewCode} (${totpRemaining()}s)`).css('color', '#67c1f5');
        }
        $secret.on('input', () => {
            previewWindow = -1;
            previewCode = '';
            const value = $secret.val().trim();
            if (!value) {
                previewBytes = null;
                $totp.text('');
                return;
            }
            try {
                previewBytes = parseSecret(value);
                updatePreview().catch(e => warn('验证码预览失败', e));
            } catch (e) {
                previewBytes = null;
                $totp.text('密钥格式错误：' + e.message).css('color', '#ff7373');
            }
        });
        const liveTimer = setInterval(() => updatePreview().catch(e => warn('验证码预览失败', e)), 1000);

        return new Promise((resolve, reject) => {
            let settled = false;
            const $ok = _BuildDialogButton('确定', true);
            const $cancel = _BuildDialogButton('取消');
            const dlg = _BuildDialog('添加账户', $body, [$ok, $cancel], () => {
                clearInterval(liveTimer);
                if (!settled) { settled = true; reject(new Error('dialog dismissed')); }
            });

            $ok.click(() => {
                const name = $name.val().trim() || '无名氏';
                const secret = $secret.val().trim();
                const sid = $sid.val().trim();
                const isec = $isec.val().trim();
                if (!secret) { ShowAlertDialog('错误', '请输入共享密钥', '确定'); return; }
                try { parseSecret(secret); }
                catch (e) { ShowAlertDialog('错误', '共享密钥格式不正确：' + e.message, '确定'); return; }
                if (sid && !isSteamID(sid)) {
                    ShowAlertDialog('错误', '64 位 SteamID 必须以 7656 开头且为 17 位', '确定'); return;
                }
                if (isec) {
                    try { parseSecret(isec); }
                    catch (e) { ShowAlertDialog('错误', '身份密钥格式不正确：' + e.message, '确定'); return; }
                    if (!sid) { ShowAlertDialog('错误', '填写身份密钥时必须同时填写 SteamID', '确定'); return; }
                }
                clearInterval(liveTimer);
                settled = true;
                resolve({ name, secret, steamID: sid, identitySecret: isec });
                dlg.Dismiss();
            });
            $cancel.click(() => {
                clearInterval(liveTimer);
                if (!settled) { settled = true; reject(new Error('cancelled')); }
                dlg.Dismiss();
            });
            dlg.Show();
            setupTooltips($body);
            $name.focus();
        });
    }

    // 从一个 maFile-like 对象提取账户字段
    function extractOneAccount(data, fallbackSteamID) {
        if (!data || typeof data !== 'object') return null;
        const secret = data.shared_secret || data.SharedSecret || data.sharedSecret || '';
        if (!secret) return null;
        // 校验密钥能解析
        try { parseSecret(secret); } catch (e) { return null; }
        try {
            return normalizeAccount({
                name: data.account_name || data.AccountName || data.accountName || data.name || '无名氏',
                secret,
                steamID: String(data.steamid || data.SteamID || data.steamID
                              || (data.Session && data.Session.SteamID)
                              || fallbackSteamID || ''),
                identitySecret: data.identity_secret || data.IdentitySecret || data.identitySecret || ''
            });
        } catch (e) {
            return null;
        }
    }

    // 通用 JSON → 账户列表（支持 4 种格式）
    function extractAccountsFromJson(text) {
        if (text.length > MAX_IMPORT_CHARS) throw new Error('导入内容不能超过 2 MB');
        // 修复 SteamID 数字未加引号的旧格式
        const fixed = text.replace(/("(?:steamid|SteamID|steamID)"\s*:\s*)(\d{17})(?=\s*[,}])/g, '$1"$2"');
        const data = JSON.parse(fixed);
        const out = [];

        // 1) 直接数组 [maFile, maFile, ...]
        if (Array.isArray(data)) {
            data.forEach(d => {
                const a = extractOneAccount(d);
                if (a) out.push(a);
            });
            return out;
        }

        if (data && typeof data === 'object') {
            // 2) 嵌套 accounts 数组
            //    {accounts: [{name, shared_secret, steamid, identity_secret}, ...]}
            if (Array.isArray(data.accounts)) {
                data.accounts.forEach(d => {
                    const a = extractOneAccount(d);
                    if (a) out.push(a);
                });
                if (out.length) return out;
            }

            // 3) 嵌套 accounts object（Steam Tools 之类的格式）
            //    {accounts: {"76561199...": {shared_secret,...}, ...}, uuid_key:...}
            if (data.accounts && typeof data.accounts === 'object' && !Array.isArray(data.accounts)) {
                const keys = Object.keys(data.accounts);
                keys.forEach(k => {
                    const sub = data.accounts[k];
                    // key 可能是 SteamID，作为 fallback
                    const a = extractOneAccount(sub, /^\d+$/.test(k) ? k : null);
                    if (a) out.push(a);
                });
                if (out.length) return out;
            }

            // 4) 单个 maFile 对象
            const single = extractOneAccount(data);
            if (single) out.push(single);
        }

        return out;
    }

    function openImportDialog() {
        const $body = $J('<form/>');
        const $ta = $J('<textarea class="newmodal_prompt_textarea" placeholder="支持 4 种格式：\n• 单个 maFile JSON\n• accounts 数组格式 {accounts: [...]}\n• Steam Tools 格式 {accounts: {steamid: {...}}}\n• maFile 数组 [{...}, {...}]" style="min-height:200px"></textarea>');
        $body.append($J('<div class="newmodal_prompt_with_textarea gray_bevel fullwidth"></div>').append($ta));
        const $hint = $J('<div class="newmodal_prompt_description" style="margin-top:6px;color:#8f98a0;font-size:11px"></div>');
        $body.append($hint);

        // 输入停止 300ms 后解析，避免反复解析大型 JSON。
        let parseTimer = null;
        const updateImportHint = () => {
            const raw = $ta.val().trim();
            if (!raw) { $hint.text(''); return; }
            try {
                const accs = extractAccountsFromJson(raw);
                if (accs.length === 0) {
                    $hint.text('⚠️ 未识别到有效账户').css('color', '#ffc83d');
                } else {
                    const withConf = accs.filter(a => a.steamID && a.identitySecret).length;
                    $hint.text(`✓ 识别到 ${accs.length} 个账户（${withConf} 个支持交易/市场确认）`).css('color', '#a4d007');
                }
            } catch (e) {
                $hint.text('JSON 解析错误：' + e.message).css('color', '#ff7373');
            }
        };
        $ta.on('input', () => {
            clearTimeout(parseTimer);
            parseTimer = setTimeout(updateImportHint, 300);
        });

        return new Promise((resolve, reject) => {
            let settled = false;   // ← 防止 dismiss 回调和 resolve 竞态
            const $ok = _BuildDialogButton('确定', true);
            const $cancel = _BuildDialogButton('取消');
            const dlg = _BuildDialog('导入账户', $body, [$ok, $cancel], () => {
                clearTimeout(parseTimer);
                if (!settled) { settled = true; reject(new Error('dialog dismissed')); }
            });
            $body.submit(e => {
                e.preventDefault();
                $ok.click();
            });
            $ok.click(() => {
                const raw = $ta.val();
                let accs;
                try {
                    accs = extractAccountsFromJson(raw);
                } catch (e) {
                    ShowAlertDialog('错误', 'JSON 解析失败：' + e.message, '确定');
                    return;
                }
                if (!accs.length) {
                    ShowAlertDialog('错误', '未识别到有效账户。请确认 JSON 中包含 shared_secret 字段。', '确定');
                    return;
                }
                clearTimeout(parseTimer);
                settled = true;       // 先标记
                resolve(accs);        // 再 resolve
                dlg.Dismiss();        // 最后 dismiss（这时 dismiss 回调会看到 settled=true 跳过 reject）
            });
            $cancel.click(() => {
                clearTimeout(parseTimer);
                if (!settled) { settled = true; reject(new Error('cancelled')); }
                dlg.Dismiss();
            });
            dlg.Show();
            $ta.focus();
        });
    }

    async function addAccount() {
        try {
            const acc = await openAddAccountDialog();
            await persistAccount(acc, '添加');
        } catch (e) { /* 用户取消 */ }
    }
    async function importAccount() {
        try {
            const accs = await openImportDialog();
            if (!accs || !accs.length) return;
            // 去重
            const current = await loadAccountsForWrite();
            const exists = new Set(current.map(a => accountId(a)));
            let added = 0, skipped = 0;
            const fresh = current.slice();
            for (const acc of accs) {
                const id = accountId(acc);
                if (exists.has(id)) { skipped++; continue; }
                exists.add(id);
                fresh.push(acc);
                added++;
            }
            state.accounts = fresh;
            await saveAccounts(fresh);
            const withConf = accs.filter(a => a.steamID && a.identitySecret).length;
            if ($authMenu) refreshMenu();
            else warn('[import] $authMenu 不存在！菜单未挂载');
            ShowAlertDialog(
                '导入完成',
                `新增 ${added} 个账户${skipped ? `，跳过 ${skipped} 个重复` : ''}${withConf ? `，其中 ${withConf} 个支持交易/市场确认` : ''}。`,
                '确定'
            );
        } catch (e) { /* 用户取消 */ }
    }

    async function persistAccount(acc, action) {
        // 多窗口安全：每次都重新读取最新
        const fresh = await loadAccountsForWrite();
        if (fresh.some(existing => accountId(existing) === accountId(acc))) {
            ShowAlertDialog(action + '账户', '该账户已存在。', '确定');
            return;
        }
        fresh.push(acc);
        state.accounts = fresh;
        await saveAccounts(fresh);
        const supportConf = !!(acc.steamID && acc.identitySecret);
        // 立即刷新菜单显示新账户
        if ($authMenu) refreshMenu();
        ShowAlertDialog(action + '账户', `${action}成功${supportConf ? '，支持确认交易/市场' : '，仅 TOTP'}。`, '确定');
    }

    // 写操作前读取最新快照，降低多标签页互相覆盖的概率。
    async function loadAccountsForWrite() {
        return loadAccounts();
    }

    async function deleteAccountByUid(uid) {
        const ok = await new Promise(res => {
            ShowConfirmDialog('删除账户', '确定删除？', '确定', '取消').done(() => res(true)).fail(() => res(false));
        });
        if (!ok) return;
        const current = await loadAccountsForWrite();
        state.accounts = current.filter(a => accountId(a) !== uid);
        await saveAccounts(state.accounts);
        if ($authMenu) refreshMenu();
    }

    async function copyCode(uid, $el) {
        const acc = state.accounts.find(a => accountId(a) === uid);
        if (!acc) return;
        try {
            const code = await getCachedCode(acc);
            GM_setClipboard(code);
            const orig = $el.text();
            const w = unsafeWindow.getComputedStyle($el[0]).width;
            $el.css('width', w).text(`已复制 ${code} (${totpRemaining()}s)`).addClass('sg_copy_ok');
            setTimeout(() => $el.text(orig).removeClass('sg_copy_ok'), 1500);
        } catch (e) {
            ShowAlertDialog('错误', '生成验证码失败：' + e.message, '确定');
        }
    }

    function refreshMenu() {
        if (!$authMenu || !$authMenu.length) {
            warn('[refreshMenu] $authMenu 不存在或为空，跳过');
            return;
        }

        // 清理旧 timer，避免多次刷新累积
        const oldTimer = $authMenu.data('timerHandle');
        if (oldTimer) clearInterval(oldTimer);

        $authMenu.empty();
        // 倒计时
        const $timer = $J('<div class="sg_timer"></div>');
        $authMenu.append($timer);
        function tickTimer() {
            const left = totpRemaining();
            $timer.text(`下一码倒计时 ${left}s`);
            $timer.css('color', left <= 5 ? '#ff7373' : '#8f98a0');
        }
        tickTimer();
        const timerHandle = setInterval(tickTimer, 1000);
        $authMenu.data('timerHandle', timerHandle);

        // 账户行
        state.accounts.forEach(acc => {
            const uid = accountId(acc);
            const $row = $J(`<a class="popup_menu_item sg_row"></a>`);
            const $name = $J(`<span class="sg_name" data-tooltip-text="点击复制验证码"></span>`).text(acc.name);
            const $del = $J(`<span class="sg_del" data-tooltip-text="删除"></span>`);
            $row.append($name, $del);
            $authMenu.append($row);
            $name.on('click', e => { e.stopPropagation(); copyCode(uid, $name); });
            $del.on('click', e => { e.stopPropagation(); deleteAccountByUid(uid); });
        });

        // 通用操作
        const $actions = $J('<div class="sg_actions"></div>');
        const mk = (label, fn) => {
            const $a = $J('<a class="popup_menu_item sg_action_item"></a>').text(label);
            $a.on('click', () => {
                Promise.resolve().then(fn).catch(e => {
                    warn(label + '失败', e);
                    ShowAlertDialog('错误', escapeHtml(e && e.message || '操作失败'), '确定');
                });
            });
            $actions.append($a);
            return $a;
        };
        mk('添加账户', addAccount);
        mk('导入账户', importAccount);
        $authMenu.append($actions);

        if (state.userSteamID) appendConfirmationLink(state.userSteamID);
        setupTooltips($authMenu);
    }

    function appendConfirmationLink(steamID) {
        const acc = state.accounts.find(a => a.steamID && a.identitySecret && a.steamID == steamID);
        if (!acc) return;
        const $link = $J('<a class="popup_menu_item sg_conf_link"></a>').text('确认交易与市场');
        $authMenu.append($link);
        $link.on('click', () => openConfirmationsDialog(acc));
    }

    // =====================================================================
    // 8. 批量确认
    // =====================================================================
    async function fetchConfirmations(acc) {
        const qs = await generateConfirmationQueryParams(acc, 'conf');
        const r = await gmRequest({
            method: 'GET',
            url: 'https://steamcommunity.com/mobileconf/getlist?' + qs,
            responseType: 'json'
        });
        return r.response;
    }

    async function sendMultiConfirm(acc, op, modal, $scope) {
        if (op !== 'allow' && op !== 'cancel') return;
        const $checked = $scope.find('.mobileconf_list_checkbox input:checked');
        if (!$checked.length) return;
        const wait = ShowBlockingWaitDialog('确认交易与市场', '执行中…');
        try {
            const qsBase = await generateConfirmationQueryParams(acc, op);
            let body = 'op=' + op + '&' + qsBase;
            $checked.each(function () {
                const $t = $J(this);
                body += '&cid[]=' + encodeURIComponent(String($t.data('confid')));
                body += '&ck[]=' + encodeURIComponent(String($t.data('key')));
            });
            const response = await gmRequest({
                method: 'POST',
                url: 'https://steamcommunity.com/mobileconf/multiajaxop',
                data: body,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                responseType: 'json'
            });
            const res = response.response;
            if (res && res.success) {
                $checked.each(function () { $J('#conf' + $J(this).data('confid')).remove(); });
                if (!$scope.find('.mobileconf_list_entry').length) modal && modal.Dismiss();
                else modal && modal.AdjustSizing && modal.AdjustSizing();
            } else {
                ShowAlertDialog('错误', escapeHtml(res && res.message || '操作失败'), '确定');
            }
        } catch (e) {
            ShowAlertDialog('错误', '网络错误：' + (e && e.message || ''), '确定');
        } finally {
            wait.Dismiss();
        }
    }

    function openConfirmationsDialog(acc) {
        const wait = ShowBlockingWaitDialog('确认交易与市场', '获取列表中…');
        fetchConfirmations(acc).then(res => {
            wait.Dismiss();
            if (!res || !res.success) {
                ShowAlertDialog('错误', escapeHtml(res && res.message || '获取失败'), '确定');
                return;
            }
            const list = Array.isArray(res.conf) ? res.conf.slice(0, 500) : [];
            if (!list.length) { ShowAlertDialog('确认交易与市场', '当前没有待确认项', '确定'); return; }
            renderConfirmDialog(acc, list);
        }).catch(() => {
            wait.Dismiss();
            ShowAlertDialog('错误', '获取确认信息失败', '确定');
        });
    }

    function renderConfirmDialog(acc, list) {
        const $body = $J('<div style="position:relative;overflow:hidden;padding-bottom:66px"></div>');
        const $list = $J('<div id="mobileconf_list"></div>');

        // 类型筛选
        const types = [...new Set(list.map(v => String(v.type_name || '未知类型')))];
        if (types.length > 1) {
            const $filterBar = $J('<div class="sg_type_filter"></div>');
            $filterBar.append($J('<a class="sg_chip sg_chip_active" data-t="">全部</a>'));
            types.forEach(t => $filterBar.append($J('<a class="sg_chip"></a>').attr('data-t', t).text(t)));
            $filterBar.on('click', '.sg_chip', function () {
                const t = $J(this).data('t');
                $filterBar.find('.sg_chip').removeClass('sg_chip_active');
                $J(this).addClass('sg_chip_active');
                $list.find('.mobileconf_list_entry').each(function () {
                    const $e = $J(this);
                    $e.toggle(!t || $e.data('type-name') === t);
                });
            });
            $body.append($filterBar);
        }

        list.forEach(v => {
            if (!v || !/^\d+$/.test(String(v.id || '')) || !/^\d+$/.test(String(v.nonce || ''))) return;
            const $entry = $J('<div class="mobileconf_list_entry"></div>')
                .attr({ id: 'conf' + v.id, 'data-confid': v.id, 'data-key': v.nonce, 'data-type-name': v.type_name });
            const $content = $J('<div class="mobileconf_list_entry_content"></div>');
            let iconUrl = '';
            try {
                const parsed = new URL(String(v.icon || ''), 'https://steamcommunity.com');
                if (parsed.protocol === 'https:') iconUrl = parsed.href;
            } catch (e) { /* 不加载无效 URL */ }
            const $icon = $J('<div class="mobileconf_list_entry_icon"></div>');
            if (iconUrl) $icon.append($J('<img>').attr({ src: iconUrl, alt: '' }));
            const $summary = $J('<div></div>');
            (Array.isArray(v.summary) ? v.summary : []).forEach((line, index) => {
                if (index) $summary.append(document.createElement('br'));
                $summary.append(document.createTextNode(String(line)));
            });
            const $desc = $J('<div class="mobileconf_list_entry_description"></div>')
                .append($J('<div></div>').text(String(v.headline || '')))
                .append($summary)
                .append($J('<div></div>').text(v.type_name + ' - ' + new Date(v.creation_time * 1000).toLocaleString()));
            const $cb = $J('<div class="mobileconf_list_checkbox"></div>')
                .append($J('<input type="checkbox" value="1">').attr({ id: 'multiconf_' + v.id, 'data-confid': v.id, 'data-key': v.nonce }));
            $content.append($icon, $desc, $cb);
            $entry.append($content, $J('<div class="mobileconf_list_entry_sep"></div>'));
            $entry.on('click', async () => {
                const qs = await generateConfirmationQueryParams(acc, 'details' + v.id);
                unsafeWindow.open(
                    'https://steamcommunity.com/mobileconf/detailspage/' + v.id + '?' + qs,
                    '_blank', 'height=790,width=600,resizable=yes,scrollbars=yes,noopener,noreferrer'
                );
            });
            $list.append($entry);
        });

        const $btns = $J('<div id="mobileconf_buttons" style="display:none"></div>')
            .append($J('<div></div>')
                .append($J('<div class="mobileconf_button mobileconf_button_cancel"></div>'))
                .append($J('<div class="mobileconf_button mobileconf_button_accept"></div>')));
        $body.append($list, $btns);

        const $ok = _BuildDialogButton('全选可见', true);
        const $cancel = _BuildDialogButton('关闭');
        const modal = _BuildDialog('确认交易与市场', $body, [$ok, $cancel], () => modal.Dismiss());
        $ok.click(() => {
            $list.find('.mobileconf_list_entry:visible .mobileconf_list_checkbox input:not(:checked)').prop('checked', true);
            $list.find('.mobileconf_list_checkbox:visible').first().click();
        });
        $cancel.click(() => modal.Dismiss());

        modal.Show();

        // 行内 checkbox 行为
        $list.on('click', '.mobileconf_list_checkbox', function (e) {
            e.stopPropagation();
            const nChecked = $J('.mobileconf_list_checkbox input:checked').length;
            const $bb = $J('#mobileconf_buttons');
            if (nChecked > 0) {
                $bb.find('.mobileconf_button_cancel').off('click').text('取消选择').on('click', () => sendMultiConfirm(acc, 'cancel', modal, $list));
                $bb.find('.mobileconf_button_accept').off('click').text('确认已选择').on('click', () => sendMultiConfirm(acc, 'allow', modal, $list));
                if ($bb.is(':hidden')) { $bb.css('bottom', -$bb.height() + 'px').show(); }
                requestAnimationFrame(() => $bb.css('bottom', '0'));
            } else {
                $bb.css('bottom', -$bb.height() + 'px');
            }
        });
    }

    // =====================================================================
    // 9. 自动填码（替代原 mutationObserver 全局监听）
    //    思路：document delegate 'input' 事件，找 2FA 输入框就算它在哪个 React 容器都能 catch
    //    + 仅在 mutation 里发现"二步验证容器"时才启动 IntersectionObserver
    // =====================================================================
    const TWOFA_INPUT_SELECTORS = [
        '#twofactorcode_entry',
        '[class^="login_AuthenticatorInputcontainer"] input.DialogInput',
        '[class^="newlogindialog_SegmentedCharacterInput"] input',
        '[class^="segmentedinputs_SegmentedCharacterInput"] input',
        ':has(> a[href="https://help.steampowered.com/wizard/HelpWithLoginInfo?lost=8&issueid=402"]) :nth-child(2) input'
    ].join(', ');

    const TWOFA_LINK_SELECTORS = [
        '[class^="newlogindialog_EnterCodeInsteadLink"] [class^="newlogindialog_TextLink"]',
        ':has(> a[href="https://help.steampowered.com/wizard/HelpWithLoginInfo?lost=8&issueid=402"]):not(:has(input))'
    ].join(', ');

    function getLoginAccountName() {
        // 多种 Steam 登录界面下选择器拼一起
        return $J('#login_twofactorauth_message_entercode_accountname, [class^="login_SigningInAccountName"], [class^="newlogindialog_AccountName"], :has(> a[href="https://help.steampowered.com/wizard/HelpWithLoginInfo?lost=8&issueid=402"]) :nth-child(1) span').text().trim();
    }

    let g_FilledInput = null;
    let g_FilledAccount = '';

    async function tryFillCode($input) {
        const name = getLoginAccountName();
        if (!name) return;
        const input = $input[0];
        if (!input || (g_FilledInput === input && g_FilledAccount === name)) return;
        // name 可能是 account_name 也可能是 persona name；同时大小写无关比较
        const nameLower = name.toLowerCase();
        const acc = state.accounts.find(a => a.name && a.name.toLowerCase() === nameLower);
        if (!acc) return;
        try {
            const code = await getCachedCode(acc);
            try {
                const dt = new DataTransfer();
                dt.setData('text/plain', code);
                input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            } catch (e) { /* 部分浏览器不允许构造 ClipboardEvent，下面使用 input 事件兜底 */ }
            if (!String(input.value || '').includes(code)) {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                setter.call(input, code);
                input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: code }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            g_FilledInput = input;
            g_FilledAccount = name;
        } catch (e) { warn('填码失败', e); }
    }

    function setupAutoFill() {
        // 只在 body 上监听 childList，且节流
        let scheduled = false;
        const scan = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                const $linkSwitch = $J(TWOFA_LINK_SELECTORS);
                if ($linkSwitch.length) {
                    // "改用验证码" 的开关，自动点
                    $linkSwitch[0].click();
                }
                const $input = $J(TWOFA_INPUT_SELECTORS).first();
                if ($input.length && $input[0].isConnected && $input[0].getClientRects().length) tryFillCode($input);
            });
        };
        const obs = new MutationObserver(scan);
        obs.observe(document.body, { childList: true, subtree: true });
        scan();
    }

    // =====================================================================
    // 10. /mobileconf/conf 页面增强
    // =====================================================================
    function enhanceMobileConfPage() {
        const acc = state.accounts.find(a => a.steamID && a.identitySecret && a.steamID == unsafeWindow.g_steamID);
        if (!acc) return;

        // 注入 GetValueFromLocalURL，保留原引用
        const orig = unsafeWindow.GetValueFromLocalURL;
        unsafeWindow.GetValueFromLocalURL = async function (url, timeout, success, error, fatal) {
            const matches = {
                allow:   '/op=conftag&arg1=allow/',
                cancel:  '/op=conftag&arg1=cancel/',
                details: '/op=conftag&arg1=details/'
            };
            for (const [tag] of Object.entries(matches)) {
                if (url.indexOf('steammobile://steamguard?op=conftag&arg1=' + tag) !== -1) {
                    success(await generateConfirmationQueryParams(acc, tag));
                    return;
                }
            }
            // fallback
            if (orig) orig(url, timeout, success, error, fatal);
        };

        $J('html').removeClass('force_desktop').addClass('responsive');
        unsafeWindow.V_SetCookie('strResponsiveViewPrefs', null, -1);

        // 给现有列表项加 checkbox
        $J('.mobileconf_list_entry').each(function () {
            const $this = $J(this);
            if ($this.has('.mobileconf_list_checkbox').length) return;
            const $cb = $J('<div class="mobileconf_list_checkbox"></div>')
                .append($J('<input type="checkbox" value="1">').attr({
                    id: 'multiconf_' + $this.data('confid'),
                    'data-confid': $this.data('confid'),
                    'data-key': $this.data('key')
                }));
            $this.find('.mobileconf_list_entry_icon').after($cb);
        });

        bindCheckboxBehavior(
            () => unsafeWindow.ActionForAllSelected('allow'),
            () => unsafeWindow.ActionForAllSelected('cancel')
        );

        const $hdr = $J('.responsive_header_content');
        const $all = $J('<div class="btn_green_steamui btn_medium"><span>全选</span></div>');
        const $refresh = $J('<div class="btn_blue_steamui btn_medium"><span>刷新</span></div>');
        $hdr.append($J('<div style="position:absolute;top:15px;right:8px"></div>').append($all, ' ', $refresh));
        $all.on('click', () => {
            if ($J('#mobileconf_list').is(':visible') && $J('#mobileconf_details').is(':hidden')) {
                $J('.mobileconf_list_checkbox input:not(:checked)').click();
            }
        });
        $refresh.on('click', async () => {
            const qs = await generateConfirmationQueryParams(acc, 'conf');
            unsafeWindow.location.replace('https://steamcommunity.com/mobileconf/conf?' + qs);
        });
    }

    // =====================================================================
    // 11. 启动
    // =====================================================================
    function mountTopBar() {
        const $bar = $J('#global_action_menu');
        if (!$bar.length) return false;
        $authLink = $J('<span class="pulldown global_action_link sg_link">Steam 令牌验证器</span>');
        $authLink.on('click', function () {
            if (typeof unsafeWindow.ShowMenu === 'function') unsafeWindow.ShowMenu(this, 'authenticator_dropdown', 'right');
        });
        $authDropdown = $J('<div class="popup_block_new" id="authenticator_dropdown" style="display:none"></div>');
        $authMenu = $J('<div class="popup_body popup_menu sg_menu"></div>');
        $bar.prepend($authDropdown.append($authMenu));
        $bar.prepend($authLink);
        return true;
    }

    async function detectUserSteamID() {
        if (typeof unsafeWindow.g_steamID !== 'undefined' && unsafeWindow.g_steamID) {
            state.userSteamID = unsafeWindow.g_steamID;
            return;
        }
        try {
            const r = await gmRequest({
                method: 'GET',
                url: 'https://steamcommunity.com/my/?xml=1'
            });
            const xml = r.responseXML || new DOMParser().parseFromString(r.responseText || '', 'application/xml');
            const sid = $J(xml).find('steamID64').text();
            if (isSteamID(sid)) state.userSteamID = sid;
        } catch (e) {
            warn('检测当前 SteamID 失败', e);
        }
    }

    async function init() {

        // 1. 先恢复上次校准的时钟偏移，再加载账户。
        const storedOffset = Number(await GM_getValue(KV_TIMEOFFSET, 0));
        const hasStoredOffset = Number.isSafeInteger(storedOffset) && Math.abs(storedOffset) <= 86400;
        if (hasStoredOffset) state.timeOffset = storedOffset;
        const lastAt = Number(await GM_getValue(KV_TIMEOFFSET_AT, 0));
        if (!Number.isFinite(lastAt) || Date.now() - lastAt > TIME_REFRESH_MS) {
            if (hasStoredOffset) refreshTimeOffset();
            else await refreshTimeOffset();
        }

        // 2. 加载账户
        state.accounts = await loadAccounts();

        // 3. 顶栏挂载
        const hasAccountDropdown = $J('#account_dropdown .persona, #account_dropdown .account_name').length;
        if (hasAccountDropdown) {
            const mounted = mountTopBar();
            if (!mounted) {
                warn('[init] 未找到 #global_action_menu，仅启用自动填码');
            } else {
                refreshMenu();
                await detectUserSteamID();
                if (state.userSteamID) refreshMenu();
            }
        } else {
            warn('[init] 未登录或 #account_dropdown 缺失，跳过顶栏挂载（自动填码仍工作）');
        }

        // 4. 跨窗口同步
        try {
            GM_addValueChangeListener(KV_ACCOUNTS, (n, ov, nv) => {
                if (Array.isArray(nv)) {
                    state.accounts = normalizeAccounts(nv);
                    state.secretCache.clear();
                    state.codeCache.clear();
                    if ($authMenu) refreshMenu();
                    AlignMenu && AlignMenu($authLink, 'authenticator_dropdown', 'right');
                }
            });
        } catch (e) {}

        // 5. 自动填码
        setupAutoFill();

        // 6. /mobileconf/conf 页面增强
        if (location.pathname === '/mobileconf/conf') {
            enhanceMobileConfPage();
        }

        // 7. 定期校准服务器时间
        scheduleTimeRefresh();
    }

    // =====================================================================
    // 12. 样式
    // =====================================================================
    GM_addStyle(`
        .sg_menu { min-width: 220px; }
        .sg_timer { padding: 6px 12px; font-size: 11px; color: #8f98a0; border-bottom: 1px solid #2a2a2a; }
        .sg_row { position: relative; padding: 0 !important; }
        .sg_name { display: block; padding: 6px 32px 6px 12px; cursor: pointer; }
        .sg_del {
            position: absolute; right: 0; top: 0; width: 24px; height: 100%;
            cursor: pointer; opacity: 0.4;
            background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path fill="%23ff5151" d="M3 3l6 6m0-6l-6 6" stroke="%23ff5151" stroke-width="1.5"/></svg>') center/12px no-repeat;
        }
        .sg_del:hover { opacity: 1; background-color: rgba(255,80,80,0.1); }
        .sg_actions { border-top: 1px solid #2a2a2a; margin-top: 4px; }
        .sg_action_item { padding: 6px 12px !important; font-size: 12px; color: #67c1f5; }
        .sg_conf_link { padding: 6px 12px !important; color: #a4d007 !important; border-top: 1px solid #2a2a2a; }
        .sg_copy_ok { color: #57cbde; }

        .sg_type_filter { padding: 8px 12px; border-bottom: 1px solid #303030; display: flex; gap: 6px; flex-wrap: wrap; }
        .sg_chip {
            padding: 3px 10px; border-radius: 12px; cursor: pointer;
            background: rgba(103,193,245,0.15); color: #67c1f5; font-size: 11px;
        }
        .sg_chip:hover { background: rgba(103,193,245,0.3); }
        .sg_chip_active { background: linear-gradient(to right,#47bfff,#1a44c2); color: #fff; }

        #mobileconf_list { overflow-y: auto; max-width: 600px; max-height: calc(100vh - 270px); }
        .mobileconf_list_entry { cursor: default; font-size: 15px; text-shadow: none; width: 100%;
            transition: opacity 0.1s, top 0.4s; }
        .mobileconf_list_entry_content { display: flex; padding: 10px 20px; }
        .mobileconf_list_entry_icon { height: 3.5em; margin-right: 10px; }
        .mobileconf_list_entry_icon > img { width: 32px; }
        .mobileconf_list_entry_description { flex: 1; min-width: 0; margin-right: 10px; }
        .mobileconf_list_entry_description > div { color: #7a7a7a; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .mobileconf_list_entry_description > div:first-of-type { color: #fff; }
        .mobileconf_list_checkbox { overflow: hidden; vertical-align: middle; display: inline-block;
            color: #fff; width: 3em; height: 3em; transform: scale(1.5); transition: transform 0.1s; }
        .mobileconf_list_checkbox input { width: 3em; height: 3em; }
        .mobileconf_list_entry_sep { border-top: 1px solid #303030; }
        #mobileconf_buttons {
            position: absolute; display: inline-block; vertical-align: middle;
            height: 3.3em; line-height: 3.3em; width: 100%; font-size: 20px;
            background: #324056;
            background-image: radial-gradient(ellipse farthest-corner at 50% 0,#4a6b98 0,transparent 50%);
            bottom: -3em; left: 0; z-index: 10; transition: bottom 0.4s;
        }
        .mobileconf_button { width: 50%; display: inline-block; overflow: hidden; text-align: center;
            vertical-align: middle; line-height: normal; cursor: pointer; }
    `);

    init().catch(e => {
        warn('init 失败', e);
        ShowAlertDialog('Steam 令牌验证器启动失败', escapeHtml(e && e.message || '未知错误'), '确定');
    });
})();
