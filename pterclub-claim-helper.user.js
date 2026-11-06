// ==UserScript==
// @name         PT 种子认领助手（pterclub）
// @namespace    https://pterclub.net/
// @version      2.1.0
// @description  做种列表批量认领（默认 >100MB，已认领自动跳过）／批量取消认领，覆盖全部分页；支持勾选本页多选操作。
// @author       Bard
// @match        https://pterclub.net/getusertorrentlist.php*
// @match        https://www.pterclub.net/getusertorrentlist.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.__PTC_CLAIM_HELPER__) return;
  window.__PTC_CLAIM_HELPER__ = true;

  /* ============================================================
   * 可调参数
   * ============================================================ */
  const CFG = {
    minSizeMB: 100,      // 一键认领的体积门槛（MB）
    intervalMs: 320,     // 每个认领请求之间的基础间隔
    jitterMs: 220,       // 随机抖动上限
    pageDelayMs: 260,    // 翻页抓取之间的间隔
    maxPages: 40,        // 最多翻多少页，防失控
    maxLog: 300,
  };

  const SIZE_UNIT = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };

  const state = {
    running: false,
    abort: false,
    multi: false,
    checkCells: [],
    allRows: [],       // 全站（跨页）解析结果
    pageRows: [],      // 当前页
    total: 0,          // 页面声明的总数「共 N 个」
    pageCount: 0,
    failedPages: 0,
    scanned: false,
    scanning: false,
  };

  /* ============================================================
   * 工具
   * ============================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const minBytes = () => CFG.minSizeMB * 1024 * 1024;

  function parseSize(text) {
    if (!text) return null;
    const m = String(text).match(/([\d.]+)\s*([KMGTP]?)i?B(?![A-Za-z])/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    return n * (SIZE_UNIT[(m[2] || '').toUpperCase()] || 1);
  }

  function fmtSize(bytes) {
    if (bytes == null) return '未知';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)} ${u[i]}`;
  }

  const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  /* ============================================================
   * 解析：从 document（当前页或 fetch 来的页）抽取种子行
   * 认领按钮是唯一可靠锚点：
   *   <a data-url="viewclaims.php?...&add_torrent_id=891957" class="claim-confirm">认领种子</a>
   *   <a data-url="viewclaims.php?...&del_torrent_id=900870" class="remove-confirm">取消认领</a>
   * ============================================================ */
  const sizeColCache = new WeakMap();

  function sizeCol(table) {
    if (sizeColCache.has(table)) return sizeColCache.get(table);
    let idx = -1;
    const head = table.rows[0];
    if (head) {
      const cells = Array.from(head.cells);
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        // 表头是图标：<img class="size" alt="size" title="大小">
        if (c.querySelector('img[alt="size"], img.size, img[title="大小"]')) { idx = i; break; }
        if (/^(大小|体积|檔案大小|文件大小|容量|size)$/i.test((c.textContent || '').trim())) { idx = i; break; }
      }
    }
    sizeColCache.set(table, idx);
    return idx;
  }

  function sizeFromRow(tr, col) {
    if (col >= 0 && tr.cells[col]) return parseSize(tr.cells[col].textContent);
    // 没有表头线索时的兜底：只看前 6 格，避开「上传 / 下载」两列
    const cells = Array.from(tr.cells).slice(0, 6);
    for (const cell of cells) {
      const t = (cell.textContent || '').trim();
      if (!t || t.length > 40) continue;
      const v = parseSize(t);
      if (v) return v;
    }
    return null;
  }

  function rowTitle(tr) {
    const a = tr.querySelector('a[href*="details.php?id="]:not([href*="userdetails"])');
    const t = (a ? a.textContent : '') || '';
    return t.replace(/\s+/g, ' ').trim().slice(0, 30);
  }

  function parseDoc(doc, withNode) {
    const out = [];
    const seen = new Set();
    doc.querySelectorAll('tr').forEach((tr) => {
      // 真正的种子行有 9 个单元格；导航行、嵌套表格的外层行都远小于这个数
      if (tr.cells.length < 6) return;

      const link = tr.querySelector('a.claim-confirm, a.remove-confirm');
      if (!link) return;
      const url = link.getAttribute('data-url') || '';
      const m = url.match(/(?:add|del)_torrent_id=(\d+)/);
      if (!m) return;

      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);

      const table = tr.closest('table');
      const col = table ? sizeCol(table) : -1;
      out.push({
        id,
        claimed: link.classList.contains('remove-confirm'),
        size: sizeFromRow(tr, col),
        title: rowTitle(tr),
        tr: withNode ? tr : null,
      });
    });
    return out;
  }

  function currentPageNo() {
    const p = new URL(location.href).searchParams.get('page');
    const n = parseInt(p, 10);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function pageUrl(p) {
    const u = new URL(location.href);
    if (p <= 0) u.searchParams.delete('page');
    else u.searchParams.set('page', p);
    return u.toString();
  }

  function maxPageOf(doc) {
    let max = 0;
    doc.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!/(getusertorrentlist\.php|type=seeding)/.test(href) && href.charAt(0) !== '?') return;
      const m = href.match(/[?&]page=(\d+)/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return max;
  }

  /** 页面上写着「loongx 正在做种的种子 (共 128 个)」 */
  function totalCountOf(doc) {
    const text = doc.body ? doc.body.textContent : '';
    const m = text.match(/共\s*([\d,]+)\s*个/);
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    return isFinite(n) && n > 0 ? n : null;
  }

  /** 每页条数：从分页链接「101 - 126」反推，默认 100 */
  function perPageOf(doc) {
    let per = 100;
    doc.querySelectorAll('a').forEach((a) => {
      const m = (a.textContent || '').trim().match(/^(\d+)\s*[-–~]\s*(\d+)$/);
      if (m) {
        const start = parseInt(m[1], 10);
        if (start > 1) per = start - 1;
      }
    });
    return per;
  }

  function pageCountOf(doc, total) {
    const byLink = maxPageOf(doc) + 1;
    if (!total) return Math.max(1, byLink);
    return Math.max(byLink, Math.ceil(total / perPageOf(doc)));
  }

  async function fetchPage(p, retry = 1) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retry; attempt++) {
      try {
        const res = await fetch(pageUrl(p), { credentials: 'same-origin' });
        if (res.redirected && /login\.php/i.test(res.url)) throw new Error('登录状态失效，请刷新页面');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        if (/Forbidden|Access Denied|cf-error/i.test(html) && !/claim-confirm|remove-confirm/.test(html)) {
          throw new Error('被站点防火墙拦截');
        }
        return new DOMParser().parseFromString(html, 'text/html');
      } catch (e) {
        lastErr = e;
        if (/登录状态失效/.test(e.message)) break;
        if (attempt < retry) await sleep(700);
      }
    }
    throw lastErr || new Error('未知错误');
  }

  /** iframe 兜底：真实页面导航，带完整请求头，能过大多数 WAF */
  function fetchPageViaIframe(p) {
    return new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;border:0';
      let done = false;
      const timer = setTimeout(() => finish(new Error('iframe 加载超时')), 20000);

      function finish(err, doc) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (f.parentNode) f.parentNode.removeChild(f);
        err ? reject(err) : resolve(doc);
      }

      f.onload = () => {
        try {
          const d = f.contentDocument;
          if (!d || !d.body) throw new Error('无法读取 iframe 内容');
          finish(null, d.cloneNode(true));
        } catch (e) {
          finish(e);
        }
      };
      f.onerror = () => finish(new Error('iframe 加载失败'));
      f.src = pageUrl(p);
      document.body.appendChild(f);
    });
  }

  async function loadPage(p) {
    try {
      return await fetchPage(p);
    } catch (e) {
      log(`第 ${p + 1} 页 fetch 失败（${e.message}），改用 iframe 重试…`, 'skip');
      return await fetchPageViaIframe(p);
    }
  }

  /** 扫描全部分页，返回 {rows, pages, total, failed} */
  async function scanAll(onProgress) {
    const here = currentPageNo();
    const total = totalCountOf(document);
    const pageRows = parseDoc(document, true);
    const map = new Map();
    pageRows.forEach((r) => map.set(r.id, r));
    let failed = 0;

    let pages = pageCountOf(document, total);
    if (pages > CFG.maxPages) {
      log(`分页过多（${pages} 页），只处理前 ${CFG.maxPages} 页`, 'err');
      pages = CFG.maxPages;
    }

    for (let p = 0; p < pages; p++) {
      if (p === here) continue;
      if (onProgress) onProgress(p, pages);
      try {
        const doc = await loadPage(p);
        const rows = parseDoc(doc, false);
        log(`第 ${p + 1} 页：${rows.length} 个`, rows.length ? 'info' : 'err');
        if (!rows.length) {
          const t = doc.querySelector('title');
          log(`第 ${p + 1} 页解析到 0 行（页面标题：${t ? t.textContent.trim().slice(0, 30) : '无'}）`, 'err');
        }
        rows.forEach((r) => { if (!map.has(r.id)) map.set(r.id, r); });
      } catch (e) {
        failed++;
        log(`第 ${p + 1} 页抓取失败：${e.message}`, 'err');
      }
      await sleep(CFG.pageDelayMs);
    }

    return { rows: Array.from(map.values()), pages, total, failed };
  }

  /* ============================================================
   * 认领 / 取消认领
   * ============================================================ */
  function classify(msg) {
    const s = String(msg || '');
    if (/已被认领|已经被认领|已认领|已認領|重复|尚未认领|未认领|没有认领|already|not\s*claimed/i.test(s)) return 'skip';
    if (/上限|超出|已达|达到|limit|exceed|过多|full|次数/i.test(s)) return 'stop';
    if (/权限|禁止|无权|permission|ban/i.test(s)) return 'stop';
    return 'fail';
  }

  function claimUrl(id, wantClaim) {
    const key = wantClaim ? 'add_torrent_id' : 'del_torrent_id';
    return new URL(`viewclaims.php?do_ajax=1&${key}=${id}`, location.href).toString();
  }

  async function submitForm(form) {
    const action = new URL(form.getAttribute('action') || location.pathname, location.href).toString();
    const method = (form.getAttribute('method') || 'get').toUpperCase();
    const data = new URLSearchParams();
    form.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
      const type = (el.type || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return;
      if ((type === 'checkbox' || type === 'radio') && !el.checked) return;
      data.append(el.name, el.value);
    });
    try {
      const res = method === 'POST'
        ? await fetch(action, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: data.toString(),
          })
        : await fetch(action + (action.includes('?') ? '&' : '?') + data.toString(), {
            credentials: 'same-origin',
          });
      const text = await res.text();
      if (/成功|已认领|已取消|success/i.test(text)) return { ok: true, via: 'form' };
      return { ok: false, msg: '表单提交后返回：' + stripTags(text).slice(0, 100) };
    } catch (e) {
      return { ok: false, msg: '表单提交失败：' + e.message };
    }
  }

  async function claimOne(id, wantClaim) {
    let text;
    try {
      const res = await fetch(claimUrl(id, wantClaim), {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (res.redirected && /login\.php/i.test(res.url)) {
        return { ok: false, kind: 'stop', msg: '登录状态失效，请刷新页面' };
      }
      text = await res.text();
    } catch (e) {
      return { ok: false, msg: '网络错误：' + e.message };
    }

    const trimmed = text.trim();

    // JSON
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      try {
        const j = JSON.parse(trimmed);
        const ret = j.ret !== undefined ? j.ret : j.code;
        if (ret === 0 || ret === '0' || j.success === true) return { ok: true, via: 'json' };
        const msg = j.msg || j.message || j.error || trimmed.slice(0, 100);
        return { ok: false, kind: classify(msg), msg };
      } catch (e) { /* 继续往下判断 */ }
    }

    if (/login\.php|请先登录|請先登入/i.test(text)) {
      return { ok: false, kind: 'stop', msg: '登录状态失效，请刷新页面' };
    }

    // 返回了确认表单 —— 提交它
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const form = doc.querySelector('form');
    if (form) return await submitForm(form);

    if (/成功|已认领|已取消|success/i.test(text)) return { ok: true, via: 'text' };
    if (/错误|失败|不能|无法|上限|权限/i.test(text)) {
      const msg = stripTags(text).slice(0, 110);
      return { ok: false, kind: classify(msg), msg };
    }
    return { ok: false, unknown: true, msg: '无法判断返回：' + stripTags(text).slice(0, 110) };
  }

  /* ============================================================
   * UI
   * ============================================================ */
  const CSS = `
#ptc-panel{position:fixed;top:14px;right:14px;width:330px;z-index:2147483000;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  color:#e8edf5;background:rgba(26,31,42,.96);border:1px solid rgba(255,255,255,.12);
  border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.45);backdrop-filter:blur(10px);
  overflow:hidden;user-select:none}
#ptc-panel .ptc-head{display:flex;align-items:center;justify-content:space-between;
  padding:9px 12px;cursor:move;background:rgba(255,255,255,.05)}
#ptc-panel .ptc-head b{font-size:13px;font-weight:600;letter-spacing:.3px}
#ptc-panel .ptc-head span{font-size:11px;opacity:.6}
#ptc-panel .ptc-body{padding:10px 12px 12px}
#ptc-panel.ptc-collapsed .ptc-body{display:none}
#ptc-panel .ptc-stat{font-size:12px;color:#9fb0c8;margin-bottom:9px;line-height:1.7}
#ptc-panel .ptc-stat em{font-style:normal;color:#fff;font-weight:600}
#ptc-panel .ptc-row{display:flex;gap:7px;margin-bottom:8px}
#ptc-panel button{flex:1;padding:7px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.07);color:#e8edf5;font-size:12.5px;cursor:pointer;
  transition:.15s;font-family:inherit;white-space:nowrap}
#ptc-panel button:hover:not(:disabled){background:rgba(255,255,255,.15)}
#ptc-panel button:disabled{opacity:.42;cursor:not-allowed}
#ptc-panel button.ptc-primary{background:#2f7fe0;border-color:#2f7fe0}
#ptc-panel button.ptc-primary:hover:not(:disabled){background:#3d8ff0}
#ptc-panel button.ptc-danger{background:#c9403f;border-color:#c9403f}
#ptc-panel button.ptc-danger:hover:not(:disabled){background:#d9504f}
#ptc-panel button.ptc-on{background:#2f7fe0;border-color:#2f7fe0}
#ptc-panel .ptc-prog{height:5px;border-radius:3px;background:rgba(255,255,255,.1);
  overflow:hidden;margin:2px 0 8px;display:none}
#ptc-panel .ptc-prog.on{display:block}
#ptc-panel .ptc-prog i{display:block;height:100%;width:0;background:#2f7fe0;transition:width .2s}
#ptc-panel .ptc-log{max-height:180px;overflow:auto;font-size:11.5px;line-height:1.65;
  font-family:ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.28);
  border-radius:7px;padding:7px 8px;display:none;user-select:text}
#ptc-panel .ptc-log.on{display:block}
#ptc-panel .ptc-log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ptc-panel .ptc-log .ok{color:#5bd68a}
#ptc-panel .ptc-log .skip{color:#8b9bb4}
#ptc-panel .ptc-log .err{color:#ff7b72}
#ptc-panel .ptc-log .info{color:#7fb2ee}
#ptc-panel .ptc-hint{font-size:11px;color:#7d8ca3;margin-top:7px;line-height:1.5}
#ptc-panel input[type=number]{width:52px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);
  color:#fff;border-radius:5px;padding:2px 5px;font-size:12px;font-family:inherit;user-select:text}
.ptc-pick{width:26px;text-align:center}
.ptc-pick input{width:15px;height:15px;cursor:pointer;accent-color:#2f7fe0}
tr.ptc-picked > td{background:rgba(47,127,224,.16)!important}
`;

  const HTML = `
<div class="ptc-head"><b>PT 认领助手</b><span class="ptc-toggle">收起</span></div>
<div class="ptc-body">
  <div class="ptc-stat" id="ptc-stat">正在扫描…</div>
  <div class="ptc-row">
    <button id="ptc-claim" class="ptc-primary">一键认领</button>
    <button id="ptc-unclaim" class="ptc-danger">一键取消</button>
    <button id="ptc-multi">多选</button>
  </div>
  <div class="ptc-row" id="ptc-multi-row" style="display:none">
    <button id="ptc-pick-claim" class="ptc-primary">认领选中</button>
    <button id="ptc-pick-unclaim" class="ptc-danger">取消选中</button>
  </div>
  <div class="ptc-row" id="ptc-multi-row2" style="display:none">
    <button id="ptc-all">全选</button>
    <button id="ptc-invert">反选</button>
    <button id="ptc-none">清空</button>
  </div>
  <div class="ptc-prog" id="ptc-prog"><i></i></div>
  <div class="ptc-log" id="ptc-log"></div>
  <div class="ptc-hint">门槛 <input type="number" id="ptc-min" value="${CFG.minSizeMB}" min="0" step="10"> MB（大于该体积才认领）</div>
</div>`;

  let panel, elStat, elLog, elProg, elBar, btnClaim, btnUnclaim, btnMulti;

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'ptc-panel';
    panel.innerHTML = HTML;
    document.body.appendChild(panel);

    elStat = $('#ptc-stat', panel);
    elLog = $('#ptc-log', panel);
    elProg = $('#ptc-prog', panel);
    elBar = $('#ptc-prog i', panel);
    btnClaim = $('#ptc-claim', panel);
    btnUnclaim = $('#ptc-unclaim', panel);
    btnMulti = $('#ptc-multi', panel);

    makeDraggable();

    $('#ptc-min', panel).addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      CFG.minSizeMB = isFinite(v) && v >= 0 ? v : 100;
      e.target.value = CFG.minSizeMB;
      renderStat();
    });

    btnClaim.onclick = () => onClaimAll();
    btnUnclaim.onclick = () => onUnclaimAll();
    btnMulti.onclick = toggleMulti;
    $('#ptc-pick-claim', panel).onclick = () => onPicked(true);
    $('#ptc-pick-unclaim', panel).onclick = () => onPicked(false);
    $('#ptc-all', panel).onclick = () => setAllPicked(true);
    $('#ptc-invert', panel).onclick = () => invertPicked();
    $('#ptc-none', panel).onclick = () => setAllPicked(false);
  }

  function makeDraggable() {
    const head = $('.ptc-head', panel);
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false;

    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      dragging = true; moved = false;
      panel.style.right = 'auto';
      panel.style.left = ox + 'px';
      panel.style.top = oy + 'px';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      moved = true;
      const maxL = Math.max(0, window.innerWidth - panel.offsetWidth - 4);
      const maxT = Math.max(0, window.innerHeight - 44);
      panel.style.left = Math.min(Math.max(0, ox + dx), maxL) + 'px';
      panel.style.top = Math.min(Math.max(0, oy + dy), maxT) + 'px';
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (moved) return;
      panel.classList.toggle('ptc-collapsed');
      $('.ptc-toggle', panel).textContent = panel.classList.contains('ptc-collapsed') ? '展开' : '收起';
    });
  }

  function log(msg, cls = 'info') {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = msg;
    elLog.appendChild(d);
    while (elLog.childElementCount > CFG.maxLog) elLog.removeChild(elLog.firstChild);
    elLog.scrollTop = elLog.scrollHeight;
    elLog.classList.add('on');
  }

  function setProgress(done, total, label) {
    if (!total) { elProg.classList.remove('on'); return; }
    elProg.classList.add('on');
    elBar.style.width = Math.round((done / total) * 100) + '%';
    elStat.innerHTML = `<em>${label}</em> ${done}/${total}`;
  }

  function renderStat() {
    const rows = state.allRows.length ? state.allRows : state.pageRows;
    const claimed = rows.filter((r) => r.claimed).length;
    const big = rows.filter((r) => !r.claimed && r.size != null && r.size > minBytes()).length;
    const unknown = rows.filter((r) => r.size == null).length;

    let head;
    if (state.scanned) {
      head = `全站 <em>${state.total || rows.length}</em> 个 · ${state.pageCount} 页`;
      if (state.total && rows.length !== state.total) {
        head += ` · <span style="color:#ff7b72">已读 ${rows.length}</span>`;
      }
    } else {
      head = `本页 <em>${rows.length}</em> 个` +
        (state.total ? ` · 全站 <em>${state.total}</em> 个（${state.pageCount} 页）` : '');
    }

    elStat.innerHTML =
      `${head} · 已认领 <em>${claimed}</em> · ≥${CFG.minSizeMB}MB 待认领 <em>${big}</em>` +
      (unknown ? ` · 体积未知 <em>${unknown}</em>` : '') +
      (state.scanned ? '' : ' <span style="opacity:.55">扫描中…</span>');
  }

  /* ============================================================
   * 多选（只作用于当前页）
   * ============================================================ */
  function toggleMulti() {
    state.multi = !state.multi;
    btnMulti.classList.toggle('ptc-on', state.multi);
    $('#ptc-multi-row', panel).style.display = state.multi ? 'flex' : 'none';
    $('#ptc-multi-row2', panel).style.display = state.multi ? 'flex' : 'none';

    if (state.multi) {
      const rows = parseDoc(document, true);
      const doneTables = new Set();
      rows.forEach((r) => {
        const table = r.tr.closest('table');
        if (table && !doneTables.has(table)) {
          addHeadCell(table);
          sizeColCache.delete(table);
          doneTables.add(table);
        }
        addPickCell(r.tr);
      });
      log(`多选模式：本页 ${rows.length} 个种子已插入勾选框`, 'info');
    } else {
      state.checkCells.forEach((c) => c.remove());
      state.checkCells = [];
      document.querySelectorAll('tr.ptc-picked').forEach((tr) => tr.classList.remove('ptc-picked'));
      log('已退出多选模式', 'info');
    }
  }

  function addHeadCell(table) {
    const head = table.rows[0];
    if (!head || head.querySelector('a.claim-confirm, a.remove-confirm')) return;
    if (head.cells.length <= 1) return;
    const td = document.createElement('td');
    td.className = 'ptc-pick';
    head.insertBefore(td, head.cells[0] || null);
    state.checkCells.push(td);
  }

  function addPickCell(tr) {
    if (tr.querySelector('.ptc-pick input')) return;
    const td = document.createElement('td');
    td.className = 'ptc-pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => tr.classList.toggle('ptc-picked', cb.checked));
    td.appendChild(cb);
    tr.insertBefore(td, tr.cells[0] || null);
    state.checkCells.push(td);
  }

  function pickedRows() {
    return parseDoc(document, true).filter((r) => {
      const cb = r.tr.querySelector('.ptc-pick input');
      return cb && cb.checked;
    });
  }

  function setAllPicked(on) {
    parseDoc(document, true).forEach((r) => {
      const cb = r.tr.querySelector('.ptc-pick input');
      if (cb) { cb.checked = on; r.tr.classList.toggle('ptc-picked', on); }
    });
  }

  function invertPicked() {
    parseDoc(document, true).forEach((r) => {
      const cb = r.tr.querySelector('.ptc-pick input');
      if (cb) { cb.checked = !cb.checked; r.tr.classList.toggle('ptc-picked', cb.checked); }
    });
  }

  /* ============================================================
   * 执行
   * ============================================================ */
  function setBusy(on) {
    state.running = on;
    btnUnclaim.disabled = on;
    btnMulti.disabled = on;
    if (on) {
      btnClaim.textContent = '停止';
      btnClaim.onclick = () => { state.abort = true; log('收到停止指令，处理完当前请求后中断…', 'err'); };
    } else {
      btnClaim.textContent = '一键认领';
      btnClaim.onclick = () => onClaimAll();
      elProg.classList.remove('on');
    }
  }

  async function runQueue(items, wantClaim, label) {
    if (!items.length) { log('没有需要处理的种子', 'skip'); return; }
    setBusy(true);
    state.abort = false;
    log(`开始${label}：共 ${items.length} 个`, 'info');

    let ok = 0, skip = 0, fail = 0, unknown = 0, stopped = false;

    for (let i = 0; i < items.length; i++) {
      if (state.abort) break;
      const it = items[i];
      setProgress(i, items.length, label);

      const r = await claimOne(it.id, wantClaim);

      if (r.ok) {
        ok++;
        markRow(it, wantClaim);
        log(`${it.id} ${it.title} — 成功`, 'ok');
      } else if (r.kind === 'skip') {
        skip++;
        log(`${it.id} ${it.title} — ${r.msg || '已认领，跳过'}`, 'skip');
      } else if (r.kind === 'stop') {
        fail++;
        log(`${it.id} ${it.title} — ${r.msg}`, 'err');
        log('触发站点限制，已自动中断', 'err');
        stopped = true;
        break;
      } else {
        fail++;
        if (r.unknown) unknown++;
        log(`${it.id} ${it.title} — ${r.msg || '失败'}`, 'err');
        if (unknown >= 3) {
          log('连续返回无法识别的内容，已中断。请手动点一次「认领种子」，把弹窗或请求内容发我。', 'err');
          stopped = true;
          break;
        }
      }

      await sleep(CFG.intervalMs + Math.random() * CFG.jitterMs);
    }

    setProgress(items.length, items.length, label);
    log(`${state.abort ? '已中止' : stopped ? '已中断' : '完成'}：成功 ${ok} · 跳过 ${skip} · 失败 ${fail}`, 'info');
    setBusy(false);

    items.forEach((x) => { x.claimed = wantClaim; });
    state.pageRows = parseDoc(document, true);
    renderStat();
  }

  /** 认领成功后把行内按钮就地翻面，免得页面状态和脚本对不上 */
  function markRow(item, wantClaim) {
    if (!item.tr) return;
    if (wantClaim) {
      const el = item.tr.querySelector('a.claim-confirm');
      if (!el) return;
      el.className = 'remove-confirm';
      el.innerHTML = '<b><font color="red">取消认领</font></b>';
      el.setAttribute('data-url', (el.getAttribute('data-url') || '').replace('add_torrent_id', 'del_torrent_id'));
    } else {
      const el = item.tr.querySelector('a.remove-confirm');
      if (!el) return;
      el.className = 'claim-confirm';
      el.textContent = '认领种子';
      el.setAttribute('data-url', (el.getAttribute('data-url') || '').replace('del_torrent_id', 'add_torrent_id'));
    }
  }

  /* ============================================================
   * 三个按钮
   * ============================================================ */
  async function ensureScanned() {
    if (state.scanned) return true;
    if (state.scanning) {
      log('还在扫描其他分页，稍等几秒再点…', 'skip');
      return false;
    }
    state.scanning = true;
    elLog.classList.add('on');
    log('正在扫描全部分页…', 'info');
    try {
      const { rows, pages, total, failed } = await scanAll((p, max) => setProgress(p + 1, max, '扫描分页'));
      state.allRows = rows;
      state.pageCount = pages;
      state.total = total;
      state.scanned = true;
      state.failedPages = failed;
      log(`扫描完成：${pages} 页，读到 ${rows.length} 个${failed ? `（${failed} 页失败）` : ''}`, 'info');
      if (total && total !== rows.length) {
        log(`注意：页面显示共 ${total} 个，只读到 ${rows.length} 个，差 ${total - rows.length} 个`, 'err');
      }
    } catch (e) {
      log('扫描失败：' + e.message, 'err');
      state.allRows = state.pageRows;
    } finally {
      state.scanning = false;
      elProg.classList.remove('on');
      renderStat();
    }
    return true;
  }

  async function onClaimAll() {
    if (state.running) return;
    elLog.classList.add('on');
    if (!(await ensureScanned())) return;

    const rows = state.allRows;
    if (!rows.length) { log('没找到任何种子', 'err'); return; }

    // 解析数量对不上时先提醒
    if (state.total && rows.length < state.total) {
      const ok = confirm(
        `页面显示共 ${state.total} 个种子，但只读取到 ${rows.length} 个` +
        (state.failedPages ? `（${state.failedPages} 个分页抓取失败）` : '') +
        `。\n\n继续只会处理已读取的这部分，确定吗？`
      );
      if (!ok) return;
    }

    // 体积未知的补查
    const unknown = rows.filter((r) => r.size == null && !r.claimed);
    if (unknown.length) {
      log(`有 ${unknown.length} 个体积未知，正在补查…`, 'info');
      for (let i = 0; i < unknown.length; i++) {
        unknown[i].size = await fetchSizeFromDetails(unknown[i].id);
        setProgress(i + 1, unknown.length, '查询体积');
        await sleep(180);
      }
      elProg.classList.remove('on');
    }

    const todo = rows.filter((r) => !r.claimed && r.size != null && r.size > minBytes());
    const small = rows.filter((r) => r.size != null && r.size <= minBytes()).length;
    const claimedCnt = rows.filter((r) => r.claimed).length;
    const unknownLeft = rows.filter((r) => r.size == null && !r.claimed).length;

    if (!todo.length) {
      log(`没有符合条件的种子（全站 ${rows.length} 个，已认领 ${claimedCnt}，不足 ${CFG.minSizeMB}MB 的 ${small}）`, 'skip');
      return;
    }

    const msg =
      `将认领 ${todo.length} 个种子\n\n` +
      `范围：全站 ${rows.length} 个（${state.pageCount} 页）\n` +
      `体积门槛：> ${CFG.minSizeMB}MB\n` +
      `已认领跳过：${claimedCnt} 个\n` +
      `体积不足跳过：${small} 个\n` +
      (unknownLeft ? `体积查不到跳过：${unknownLeft} 个\n` : '') +
      `\n确认开始？`;
    if (!confirm(msg)) return;

    await runQueue(todo, true, '认领');
  }

  async function onUnclaimAll() {
    if (state.running) return;
    elLog.classList.add('on');
    if (!(await ensureScanned())) return;

    const todo = state.allRows.filter((r) => r.claimed);
    if (!todo.length) { log('全站没有已认领的种子', 'skip'); return; }

    const msg =
      `将取消 ${todo.length} 个已认领种子\n\n` +
      `范围：全站 ${state.total || state.allRows.length} 个（${state.pageCount} 页）\n` +
      (state.total && state.allRows.length < state.total
        ? `警告：只读取到 ${state.allRows.length} 个，可能漏掉部分已认领种子\n` : '') +
      `\n注意：取消后如果没人做种，种子可能被系统删除。\n\n确认继续？`;
    if (!confirm(msg)) return;

    await runQueue(todo, false, '取消认领');
  }

  async function onPicked(wantClaim) {
    if (state.running) return;
    const rows = pickedRows();
    if (!rows.length) { log('还没勾选任何种子', 'skip'); return; }
    const todo = rows.filter((r) => (wantClaim ? !r.claimed : r.claimed));
    if (!todo.length) {
      log(wantClaim ? '选中的都已认领' : '选中的都没认领', 'skip');
      return;
    }
    if (!confirm(`将对选中的 ${todo.length} 个种子执行${wantClaim ? '认领' : '取消认领'}（本页范围，不检查体积），确认？`)) return;
    await runQueue(todo, wantClaim, wantClaim ? '认领选中' : '取消选中');
  }

  async function fetchSizeFromDetails(id) {
    try {
      const res = await fetch(`details.php?id=${id}&hit=1`, { credentials: 'same-origin' });
      if (!res.ok) return null;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const cell of doc.querySelectorAll('td, th')) {
        if (/^(大小|体积|檔案大小|文件大小|容量|size)$/i.test((cell.textContent || '').trim())) {
          let next = cell.nextElementSibling;
          while (next) {
            const v = parseSize(next.textContent);
            if (v) return v;
            next = next.nextElementSibling;
          }
        }
      }
      const m = html.match(/(?:大小|体积|Size)[^\d]{0,80}?([\d.]+\s*[KMGTP]?i?B)/i);
      return m ? parseSize(m[1]) : null;
    } catch (e) {
      return null;
    }
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  function boot() {
    buildUI();
    state.pageRows = parseDoc(document, true);
    state.allRows = state.pageRows.slice();
    state.total = totalCountOf(document);
    state.pageCount = pageCountOf(document, state.total);
    renderStat();

    console.log('[PT认领助手] 本页解析', state.pageRows.length, '个种子，全站', state.total, '个 /', state.pageCount, '页', state.pageRows.slice(0, 3));

    if (!state.pageRows.length) {
      log('本页没识别到种子行（找不到 .claim-confirm / .remove-confirm 按钮）', 'err');
      return;
    }
    log(`本页 ${state.pageRows.length} 个 · 全站 ${state.total || '?'} 个（${state.pageCount} 页）· 正在读取其他分页…`, 'info');

    (async () => {
      state.scanning = true;
      try {
        const { rows, pages, total, failed } = await scanAll(null);
        state.allRows = rows;
        state.pageCount = pages;
        state.total = total || state.total;
        state.scanned = true;
        state.failedPages = failed;
        log(`扫描完成：${pages} 页，读到 ${rows.length} 个${failed ? `（${failed} 页失败）` : ''}`, 'info');
        if (state.total && state.total !== rows.length) {
          log(`注意：页面显示共 ${state.total} 个，只读到 ${rows.length} 个，差 ${state.total - rows.length} 个`, 'err');
        }
      } catch (e) {
        state.allRows = state.pageRows;
        log('扫描失败：' + e.message, 'err');
      } finally {
        state.scanning = false;
        renderStat();
      }
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
