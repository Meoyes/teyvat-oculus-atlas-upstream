/* ============================================================
   上游增量更新（GitHub 资源仓库）
   - 打开页面后每 24 小时检查一次 manifest
   - 按文件 sha256 对比，只下载「新增 / 修改」的文件，删除已过时的缓存
   - 版本、更新时间、上次检查时间全部落在 localStorage
   ============================================================ */
(function () {
  const CACHE = 'gel-upstream-v1';
  const KEY = 'gel.upstream.v1';

  const DEFAULTS = {
    owner: 'Meoyes',
    repo: 'teyvat-oculus-atlas-upstream',
    branch: 'main',
    bases: [
      'https://raw.githubusercontent.com/{o}/{r}/{b}/',
      'https://cdn.jsdelivr.net/gh/{o}/{r}@{b}/',
    ],
    interval: 24 * 60 * 60 * 1000,   // 1 天
    autoApply: true,
    timeout: 15000,
  };

  const CFG = Object.assign({}, DEFAULTS, window.GEL_UPSTREAM_CONFIG || {});
  // 测试/调试：?noupd=1 关闭自动检查，只保留手动入口
  const NO_AUTO = new URLSearchParams(location.search).has('noupd');

  const Local = {
    read() {
      try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
    },
    write(v) {
      try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ }
    },
  };

  let state = Local.read();
  let baseline = null;          // 站点内置基线 manifest
  let pending = null;           // 待应用的 manifest
  let base = state.base || null;
  let running = false;
  let lastInfo = null;

  /* ------------------------------------------------ 工具 */
  const now = () => Date.now();

  function baseUrl() {
    // 本地测试：?upstream=http://127.0.0.1:8901/
    const q = new URLSearchParams(location.search).get('upstream');
    if (q) return q.endsWith('/') ? q : q + '/';
    if (base) return base;
    return CFG.bases[0].replace('{o}', CFG.owner).replace('{r}', CFG.repo).replace('{b}', CFG.branch);
  }

  function abs(path) { return new URL(path, location.href).href; }

  // 版本号 YYYY.MM.DD.N 按段比较，用于防止 CDN 缓存旧清单导致「降级」
  function cmpVersion(a, b) {
    if (!a) return -1;
    if (!b) return 1;
    const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  async function fetchJSON(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.timeout);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadManifest() {
    const tried = [];
    const list = [baseUrl()].concat(CFG.bases.map((b) => b.replace('{o}', CFG.owner).replace('{r}', CFG.repo).replace('{b}', CFG.branch)));
    const uniq = Array.from(new Set(list));
    for (const b of uniq) {
      if (!b) continue;
      tried.push(b);
      try {
        const m = await fetchJSON(b + 'manifest.json?t=' + Math.floor(now() / 60000));
        if (m && m.files) { base = b; state.base = b; Local.write(state); return m; }
      } catch (e) { /* 换下一个镜像 */ }
    }
    throw new Error('上游不可达：' + tried.join(' , '));
  }

  async function getBaseline() {
    if (baseline) return baseline;
    try {
      baseline = await (await fetch('data/upstream-manifest.json', { cache: 'no-cache' })).json();
    } catch (e) {
      baseline = { version: null, files: {} };
    }
    return baseline;
  }

  function normalizeState(b) {
    const s = Local.read();
    if (!s.version) {
      s.version = b.version || null;
      s.files = b.files || {};
      s.checkedAt = s.checkedAt || 0;
      s.changelog = s.changelog || b.changelog || [];
      Local.write(s);
      state = s;
    }
    return s;
  }

  /* ------------------------------------------------ 差异计算 */
  function diff(manifest, installed) {
    const cur = installed || {};
    const next = manifest.files || {};
    const added = [], changed = [], removed = [];
    let bytes = 0;
    Object.keys(next).forEach((p) => {
      const rec = next[p];
      const old = cur[p];
      if (!old) { added.push(p); bytes += rec[0] || 0; }
      else if (old[1] !== rec[1]) { changed.push(p); bytes += rec[0] || 0; }
    });
    Object.keys(cur).forEach((p) => { if (!next[p]) removed.push(p); });
    return { added, changed, removed, bytes, total: added.length + changed.length };
  }

  /* ------------------------------------------------ 检查 */
  async function check(opts) {
    opts = opts || {};
    if (running) return { busy: true };
    const b = await getBaseline();
    const s = normalizeState(b);

    if (!opts.force && s.checkedAt && now() - s.checkedAt < CFG.interval) {
      const info = { skipped: true, version: s.version, checkedAt: s.checkedAt, nextAt: s.checkedAt + CFG.interval };
      lastInfo = info;
      renderStatus();
      return info;
    }

    let manifest;
    try {
      manifest = await loadManifest();
    } catch (e) {
      s.lastError = String(e.message || e);
      Local.write(s);
      renderStatus();
      return { error: s.lastError };
    }

    s.manifestVersion = manifest.version;
    // 旧清单（CDN 滞后 / 回滚）不应用，直接当作「已是最新」
    if (s.version && cmpVersion(manifest.version, s.version) <= 0) {
      s.checkedAt = now();
      s.lastError = null;
      s.changelog = manifest.changelog || s.changelog || [];
      Local.write(s);
      const info0 = { version: s.version, installed: s.version, updated: false, stale: manifest.version !== s.version };
      lastInfo = info0;
      renderStatus();
      return publicInfo(info0);
    }
    const d = diff(manifest, s.files);
    const info = {
      version: manifest.version,
      installed: s.version,
      added: d.added, changed: d.changed, removed: d.removed,
      bytes: d.bytes, total: d.total, updated: d.total > 0 || d.removed.length > 0,
      changelog: manifest.changelog || [],
      manifest,
    };
    lastInfo = info;
    if (info.updated) {
      pending = manifest;
    } else {
      s.version = manifest.version;
      s.files = manifest.files;
      s.changelog = manifest.changelog || [];
    }
    s.checkedAt = now();
    s.lastError = null;
    Local.write(s);
    renderStatus();
    window.dispatchEvent(new CustomEvent('gel:upstream-check', { detail: publicInfo(info) }));
    return publicInfo(info);
  }

  function publicInfo(info) {
    if (!info) return null;
    return {
      version: info.version, installed: info.installed, updated: !!info.updated,
      added: info.added ? info.added.length : 0,
      changed: info.changed ? info.changed.length : 0,
      removed: info.removed ? info.removed.length : 0,
      bytes: info.bytes || 0, skipped: !!info.skipped, error: info.error || null,
      changelog: info.changelog || [],
      sample: (info.added || []).slice(0, 5).concat((info.changed || []).slice(0, 5)),
    };
  }

  /* ------------------------------------------------ 应用（增量下载） */
  async function apply(opts) {
    opts = opts || {};
    if (!pending) {
      const r = await check({ force: true });
      if (!r || !r.updated) return { nothing: true };
    }
    if (running) return { busy: true };
    running = true;
    const manifest = pending;
    const s = Local.read();
    const d = diff(manifest, s.files);
    const b = base || baseUrl();
    const list = d.added.concat(d.changed);

    showCard('正在获取新内容', 0, list.length, '');
    const cache = await caches.open(CACHE);
    let done = 0, bytes = 0, failed = [];
    const appChanged = list.some((p) => p.startsWith('js/') || p.startsWith('css/'));
    const dataChanged = list.some((p) => p.startsWith('data/'));

    for (const path of list) {
      try {
        const url = b + path + '?t=' + Math.floor(now() / 60000);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CFG.timeout);
        let res;
        try {
          res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
        } finally { clearTimeout(timer); }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await res.arrayBuffer();
        bytes += buf.byteLength;
        // 以站内绝对地址为键，Service Worker / 页面请求可直接命中
        await cache.put(abs(path), new Response(buf, {
          headers: { 'Content-Type': res.headers.get('Content-Type') || guessType(path) },
        }));
      } catch (e) {
        failed.push(path);
      }
      done++;
      showCard('正在获取新内容', done, list.length, path);
    }

    // 删除已过时内容
    for (const path of d.removed) {
      try { await cache.delete(abs(path)); } catch (e) { /* ignore */ }
    }

    running = false;
    if (failed.length) {
      showCard('部分内容未能获取', done, list.length, `${failed.length} 个文件失败，下次打开重试`);
      s.lastError = 'failed:' + failed.slice(0, 3).join(',');
      Local.write(s);
      return { error: s.lastError, failed };
    }

    s.version = manifest.version;
    s.files = manifest.files;
    s.changelog = manifest.changelog || [];
    s.checkedAt = now();
    s.updatedAt = now();
    Local.write(s);
    pending = null;
    lastInfo = null;
    showCard('已更新到 ' + manifest.version, list.length, list.length,
      `新增 ${d.added.length} · 修改 ${d.changed.length} · 删除 ${d.removed.length}`);
    renderStatus();
    window.dispatchEvent(new CustomEvent('gel:upstream-applied', {
      detail: { version: manifest.version, added: d.added.length, changed: d.changed.length, removed: d.removed.length, bytes },
    }));

    if (opts.reload !== false && (appChanged || dataChanged)) {
      setTimeout(() => location.reload(), 900);
    }
    return { version: manifest.version, added: d.added.length, changed: d.changed.length, removed: d.removed.length, bytes, appChanged, dataChanged };
  }

  function guessType(path) {
    if (/\.json$/.test(path)) return 'application/json; charset=utf-8';
    if (/\.js$/.test(path)) return 'text/javascript; charset=utf-8';
    if (/\.css$/.test(path)) return 'text/css; charset=utf-8';
    if (/\.webp$/.test(path)) return 'image/webp';
    if (/\.png$/.test(path)) return 'image/png';
    if (/\.jpe?g$/.test(path)) return 'image/jpeg';
    if (/\.svg$/.test(path)) return 'image/svg+xml';
    return 'application/octet-stream';
  }

  /* ------------------------------------------------ 自动检查 */
  async function auto() {
    let r;
    try { r = await check(); } catch (e) { return; }
    if (!r || r.error || r.skipped) return;
    if (r.updated) {
      if (CFG.autoApply) {
        const res = await apply();
        if (res && res.version) toastLocal(`资源已更新到 ${res.version}`);
      } else {
        showCard('发现新内容 ' + r.version, 0, r.total, `${r.added} 新增 · ${r.changed} 修改 · ${r.removed} 删除`);
      }
    }
  }

  function toastLocal(msg) {
    if (window.GEL && window.GEL.toast) window.GEL.toast(msg);
    else console.log('[upstream]', msg);
  }

  /* ------------------------------------------------ UI */
  function renderStatus() {
    const el = document.getElementById('updStatus');
    if (!el) return;
    const s = Local.read();
    if (!s.version) { el.textContent = '尚未检查'; return; }
    const when = s.checkedAt ? timeAgo(s.checkedAt) : '未检查';
    el.textContent = `资源 ${s.version} · ${when}检查`;
  }

  function timeAgo(ts) {
    const d = now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  function showCard(title, i, total, sub) {
    let card = document.getElementById('updCard');
    if (!card) return;
    card.hidden = false;
    card.classList.add('is-show');
    const t = card.querySelector('.upd-title');
    const p = card.querySelector('.upd-bar i');
    const m = card.querySelector('.upd-meta');
    const txt = card.querySelector('.upd-sub');
    if (t) t.textContent = title;
    if (p) p.style.width = (total ? Math.min(100, (i / total) * 100) : 100) + '%';
    if (m) m.textContent = total ? `${i} / ${total}` : '';
    if (txt) txt.textContent = sub || '';
  }

  function hideCard() {
    const card = document.getElementById('updCard');
    if (card) card.classList.remove('is-show');
  }

  /* 更新日志抽屉 */
  async function openChangelog() {
    const wrap = document.getElementById('changelogWrap');
    const body = document.getElementById('changelogBody');
    if (!wrap || !body) return;
    wrap.setAttribute('aria-hidden', 'false');
    body.innerHTML = '<p class="cl-empty">正在读取更新日志…</p>';
    const s = Local.read();
    let idx = (pending && pending.changelog) || s.changelog || [];
    if (!idx.length) {
      try {
        const m = await loadManifest();
        idx = m.changelog || [];
        s.changelog = idx;
        Local.write(s);
      } catch (e) { /* 离线时保持空 */ }
    }
    if (!idx.length) { body.innerHTML = '<p class="cl-empty">暂无更新记录</p>'; return; }
    idx = idx.slice(0, 12);
    const files = Array.from(new Set(idx.map((e) => e.file)));
    const docs = {};
    await Promise.all(files.map(async (f) => {
      try { docs[f] = await fetchJSON((base || baseUrl()) + f + '?t=' + Math.floor(now() / 60000)); }
      catch (e) { docs[f] = null; }
    }));
    const rows = [];
    idx.forEach((e) => {
      const doc = docs[e.file];
      const entry = doc && (doc.entries || []).find((x) => x.version === e.version);
      const tags = (e.tags || []).map((t) => `<span class="cl-tag">${t}</span>`).join('');
      const items = entry ? []
        .concat((entry.added || []).map((p) => `<li class="is-add">+ ${p}</li>`))
        .concat((entry.changed || []).map((p) => `<li class="is-mod">~ ${p}</li>`))
        .concat((entry.removed || []).map((p) => `<li class="is-del">- ${p}</li>`)).slice(0, 14).join('') : '';
      rows.push(`<article class="cl-item">
        <div class="cl-top"><b>${e.version}</b><span>${(e.date || '').replace(/-/g, '/')}</span>${tags}</div>
        <p class="cl-title">${e.title || ''}</p>
        ${entry && entry.note ? `<p class="cl-note">${entry.note}</p>` : ''}
        ${e.summary ? `<p class="cl-sum">${e.summary}</p>` : ''}
        ${items ? `<ul class="cl-list">${items}</ul>` : ''}
      </article>`);
    });
    body.innerHTML = rows.join('') || '<p class="cl-empty">暂无更新记录</p>';
  }

  function closeChangelog() {
    const wrap = document.getElementById('changelogWrap');
    if (wrap) wrap.setAttribute('aria-hidden', 'true');
  }

  const isChangelogOpen = () => {
    const w = document.getElementById('changelogWrap');
    return !!w && w.getAttribute('aria-hidden') === 'false';
  };

  /* ------------------------------------------------ 绑定 */
  async function bind() {
    // 首访先把内置基线写进本地状态，界面立刻能显示版本
    try { normalizeState(await getBaseline()); } catch (e) { /* ignore */ }
    renderStatus();
    const btn = document.getElementById('btnUpdate');
    if (btn) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '检查中…';
        const r = await check({ force: true });
        btn.disabled = false;
        btn.textContent = '检查更新';
        if (r.error) { toastLocal('检查失败：网络或仓库不可达'); return; }
        if (!r.updated) { toastLocal(`已是最新版本 ${r.version || '资源'}`); return; }
        const res = await apply();
        if (res && res.version) toastLocal(`已更新到 ${res.version}`);
      });
    }
    const clBtn = document.getElementById('btnChangelog');
    if (clBtn) clBtn.addEventListener('click', openChangelog);
    const closeEls = document.querySelectorAll('[data-close="changelog"]');
    closeEls.forEach((el) => el.addEventListener('click', closeChangelog));
    const cardClose = document.querySelector('#updCard .upd-close');
    if (cardClose) cardClose.addEventListener('click', hideCard);
  }

  window.__GEL_UP = {
    config: CFG, check, apply, openChangelog, closeChangelog, isChangelogOpen,
    diff, cmpVersion, state: () => Local.read(), pending: () => pending,
    reset() { localStorage.removeItem(KEY); state = {}; pending = null; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // 页面打开后延迟检查（不阻塞首屏）
  window.addEventListener('load', () => {
    if (!NO_AUTO) setTimeout(() => { auto(); }, 2500);
  });
})();
