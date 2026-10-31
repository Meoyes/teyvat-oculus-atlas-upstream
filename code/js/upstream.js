/* ============================================================
   上游增量更新（GitHub 资源仓库）
   - 打开页面后每 24 小时检查一次 manifest
   - 数据通路：按 sha256 对比，只下载「新增 / 修改」的文件，写 gel-upstream-v1
   - 代码通路：index.html + js/ + css/ 作为整包快照装进 /__code__/<版本>/，
     由 Service Worker 按精确键供给，装完刷新一次即生效（无需重新部署站点）
   - 版本、更新时间、上次检查时间全部落在 localStorage
   ============================================================ */
(function () {
  const CACHE = 'gel-upstream-v1';
  const KEY = 'gel.upstream.v1';
  /* 代码包专用缓存与激活指针；与数据缓存完全隔离 */
  const CODE_CACHE = 'gel-code-v1';
  const CODE_META = 'gel-code-meta';
  const CODE_ACTIVE = '/__code__/active';
  const CODE_STATE = 'gel.code.v1';        // { version, files, pendingBoot, blocked, prev }
  const CODE_KEEP = 2;                     // 当前 + 上一版（回退用）

  const DEFAULTS = {
    owner: 'Meoyes',
    repo: 'teyvat-oculus-atlas-upstream',
    branch: 'main',
    bases: [
      'https://raw.githubusercontent.com/{o}/{r}/{b}/',
      'https://cdn.jsdelivr.net/gh/{o}/{r}@{b}/',
    ],
    interval: 24 * 60 * 60 * 1000,          // 资源清单：1 天
    announceInterval: 60 * 60 * 1000,       // 公告：1 小时
    autoApply: true,
    timeout: 15000,
  };

  const CFG = Object.assign({}, DEFAULTS, window.GEL_UPSTREAM_CONFIG || {});
  // 测试/调试：?noupd=1 关闭自动检查，只保留手动入口
  const NO_AUTO = new URLSearchParams(location.search).has('noupd');

  /* 代码类路径（js/ css/）永远不属于上游资源：读状态时就地剔除，
     这样即使历史状态被写脏，diff / apply 也不会再碰它们 */
  const CODE_PATH = /^(js|css)\//;

  const Local = {
    read() {
      let v = {};
      try { v = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { v = {}; }
      if (v && v.files) {
        let dirty = false;
        Object.keys(v.files).forEach((p) => {
          if (CODE_PATH.test(p)) { delete v.files[p]; dirty = true; }
        });
        if (dirty) {
          try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* 忽略 */ }
        }
      }
      return v;
    },
    write(v) {
      try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ }
    },
  };

  // 本站脚本版本（取自自身 script 的 ?v=），用于和 manifest.minApp 比对
  const APP_VER = (function () {
    try {
      const el = document.currentScript
        || Array.from(document.scripts).find((x) => /upstream\.js/.test(x.src));
      const v = el && new URL(el.src, location.href).searchParams.get('v');
      return v || '0';
    } catch (e) { return '0'; }
  })();

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

  // 脚本版本号形如 20261031-2：日期段 + 当日序号，按数字比较
  function cmpAppVersion(a, b) {
    const pa = String(a || '0').split('-');
    const pb = String(b || '0').split('-');
    const na = parseInt(pa[0], 10) || 0, nb = parseInt(pb[0], 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
    const sa = parseInt(pa[1], 10) || 0, sb = parseInt(pb[1], 10) || 0;
    return sa === sb ? 0 : (sa < sb ? -1 : 1);
  }

  // 资源分组：按地图归类的文件可以延迟到「打开该区域」时再下载
  function mapOf(path) {
    let m = /^data\/markers_([^/]+)\.json$/.exec(path);
    if (m) return 'map:' + m[1];
    m = /^tiles\/([^/]+)\//.exec(path);
    if (m) return 'map:' + m[1];
    return null;
  }

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
    /* 内置基线与已部署代码同源：首访即视为「代码已是最新」，不会白下一遍 */
    const cs = codeState();
    if (!cs.version && b.code && b.code.files) {
      saveCodeState({ version: b.version, files: b.code.files });
    }
    return s;
  }

  /* ------------------------------------------------ 差异计算 */
  /* 数据公文包只允许放数据与素材。历史包曾经把 js/ css/ 塞进 files，
     而那条通路按 ignoreSearch 命中缓存，会「页面新、代码旧」整站崩溃。
     这里做白名单过滤，即使仓库里误放也不会生效。代码走 code 命名空间。 */
  const ALLOWED_PREFIX = ('data/ tiles/ assets/');
  /* 代码包只允许这几类：与 site/ 布局一致，且不含 sw.js */
  const CODE_OK = /^(index\.html|manifest\.webmanifest|js\/[\w.-]+\.js|css\/[\w.-]+\.css)$/;
  function sanitize(manifest) {
    if (!manifest || !manifest.files) return manifest;
    const keep = {};
    let dropped = 0;
    Object.keys(manifest.files).forEach((p) => {
      if (/^(data|tiles|assets)\//.test(p)) keep[p] = manifest.files[p];
      else dropped += 1;
    });
    const out = Object.assign({}, manifest, { files: keep });
    if (manifest.code && manifest.code.files) {
      const ck = {};
      Object.keys(manifest.code.files).forEach((p) => {
        if (CODE_OK.test(p)) ck[p] = manifest.code.files[p];
        else dropped += 1;
      });
      out.code = Object.assign({}, manifest.code, { files: ck });
    }
    if (dropped) out.dropped = dropped;
    return out;
  }

  /* 清掉历史上被塞进上游缓存的代码文件（一次性自愈） */
  async function purgeCodeCache() {
    try {
      const c = await caches.open(CACHE);
      const keys = await c.keys();
      const code = keys.filter((k) => /\/(js|css)\//.test(new URL(k.url).pathname));
      await Promise.all(code.map((k) => c.delete(k)));
      return code.length;
    } catch (e) { return 0; }
  }

  /* 把状态里残留的代码条目一并清掉，避免下次 diff 又把它们算进去 */
  async function healState() {
    const dropped = await purgeCodeCache();
    const s = Local.read();
    if (s && s.files) {
      const code = Object.keys(s.files).filter((p) => /^(js|css)\//.test(p));
      if (code.length) {
        code.forEach((p) => { delete s.files[p]; });
        Local.write(s);
        state = s;
      }
    }
    return dropped;
  }

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

  /* ------------------------------------------------ 代码包（整包快照） */
  const activeKey = () => new URL(CODE_ACTIVE, location.origin).href;
  const bundleKey = (ver, rel) => new URL('/__code__/' + ver + '/' + rel, location.origin).href;

  /* 代码状态单独一个小键：index.html 的看门狗在首屏前就要读它，
     不能去解析几十 KB 的资源配置。也避免和主状态互相覆盖。 */
  function codeState() {
    try { return JSON.parse(localStorage.getItem(CODE_STATE) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveCodeState(v) {
    try { localStorage.setItem(CODE_STATE, JSON.stringify(v)); return true; } catch (e) { return false; }
  }

  async function readActive() {
    try {
      const c = await caches.open(CODE_META);
      const r = await c.match(activeKey());
      return r ? await r.json() : null;
    } catch (e) { return null; }
  }

  async function writeActive(v) {
    try {
      const c = await caches.open(CODE_META);
      await c.put(activeKey(), new Response(JSON.stringify(v), {
        headers: { 'Content-Type': 'application/json' },
      }));
      return true;
    } catch (e) { return false; }
  }

  function codeDiff(code, installed) {
    const cur = (installed && installed.files) || {};
    const next = (code && code.files) || {};
    const added = [], changed = [], removed = [];
    let bytes = 0;
    Object.keys(next).forEach((p) => {
      const old = cur[p];
      if (!old) { added.push(p); bytes += next[p][0] || 0; }
      else if (old[1] !== next[p][1]) { changed.push(p); bytes += next[p][0] || 0; }
    });
    Object.keys(cur).forEach((p) => { if (!next[p]) removed.push(p); });
    return { added, changed, removed, bytes, total: added.length + changed.length };
  }

  /* 只保留当前与上一版，其余清掉（体积很小，但别无限增长） */
  async function pruneBundles(keep) {
    try {
      const c = await caches.open(CODE_CACHE);
      const keys = await c.keys();
      const alive = new Set(keep.filter(Boolean).map(String));
      const dead = keys.filter((r) => {
        const m = /\/__code__\/([^/]+)\//.exec(new URL(r.url).pathname);
        return m && !alive.has(m[1]);
      });
      await Promise.all(dead.map((r) => c.delete(r)));
    } catch (e) { /* 忽略 */ }
  }

  /* 把一个版本的代码装进 /__code__/<版本>/，全部落盘后才切激活指针。
     **换版本时下整包**：快照必须自洽，不能出现「包里有新 index.html、
     但某个没有变化的 js 还靠站点网络供给」这种半新半旧的组合。 */
  async function installCode(code, b) {
    if (!code || !code.files) return { nothing: true };
    const rels = Object.keys(code.files);
    if (!rels.length) return { nothing: true };

    const st = codeState();
    /* 这个版本上次装上但没启动起来：只记账，不再重试（等上游发新版本） */
    if (st.blocked && st.blocked === code.version) {
      saveCodeState(Object.assign({}, st, { version: code.version, files: code.files, pendingBoot: null }));
      renderStatus();
      return { blocked: true, version: code.version };
    }

    const prev = await readActive();
    const sameVersion = !!prev && prev.version === code.version;
    const d = codeDiff(code, st);
    if (sameVersion && !d.total && !d.removed.length) {
      saveCodeState(Object.assign({}, st, { version: code.version, files: code.files }));
      return { changed: 0, version: code.version };
    }

    const list = rels;                     // 整包下载
    const total = list.length;
    const cache = await caches.open(CODE_CACHE);
    /* 新版落盘前先清掉同名目录里的残片，避免混入上一次的同名版本 */
    if (!sameVersion) {
      try {
        const old = (await cache.keys()).filter((r) =>
          new URL(r.url).pathname.indexOf('/__code__/' + code.version + '/') === 0);
        await Promise.all(old.map((r) => cache.delete(r)));
      } catch (e) { /* 忽略 */ }
    }

    showCard('正在更新界面', 0, total, '');
    let done = 0;
    for (const rel of list) {
      const put = await download(b, 'code/' + rel, rel);
      await cache.put(bundleKey(code.version, rel), put.res);
      done += 1;
      showCard('正在更新界面', done, total, rel);
    }
    /* 激活指针：全部文件落盘后才切，中途失败仍然是旧包在跑 */
    const ok = await writeActive({
      version: code.version,
      prev: prev && prev.version && prev.version !== code.version ? prev.version : null,
      at: now(),
    });
    if (!ok) return { error: 'no-cache-api' };
    await pruneBundles([code.version, prev && prev.version]);
    saveCodeState({
      version: code.version,
      files: code.files,
      at: now(),
      prev: prev && prev.version && prev.version !== code.version ? prev.version : null,
      /* 新装上的版本还没成功启动过：下次加载由看门狗盯着，起不来就回退上一版 */
      pendingBoot: code.version,
    });
    return { changed: total, version: code.version, bytes: d.bytes };
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
      manifest = sanitize(await loadManifest());
    } catch (e) {
      s.lastError = String(e.message || e);
      Local.write(s);
      renderStatus();
      return { error: s.lastError };
    }

    s.manifestVersion = manifest.version;
    // 最低客户端版本：数据格式可能依赖新脚本，旧客户端先去刷新页面
    if (manifest.minApp && cmpAppVersion(APP_VER, manifest.minApp) < 0) {
      s.checkedAt = now();
      s.lastError = null;
      s.needsUpgrade = manifest.minApp;
      s.changelog = manifest.changelog || s.changelog || [];
      Local.write(s);
      renderStatus();
      const infoU = { version: s.version, installed: s.version, updated: false, needsUpgrade: manifest.minApp, appVer: APP_VER };
      lastInfo = infoU;
      window.dispatchEvent(new CustomEvent('gel:upstream-need-upgrade', { detail: infoU }));
      return publicInfo(infoU);
    }
    if (s.needsUpgrade) { delete s.needsUpgrade; Local.write(s); }
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
    const cd = codeDiff(manifest.code, codeState());
    const info = {
      version: manifest.version,
      installed: s.version,
      added: d.added, changed: d.changed, removed: d.removed,
      bytes: d.bytes, total: d.total,
      code: cd,
      updated: d.total > 0 || d.removed.length > 0 || cd.total > 0 || cd.removed.length > 0,
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
    const cd = info.code || {};
    return {
      version: info.version, installed: info.installed, updated: !!info.updated,
      added: info.added ? info.added.length : 0,
      changed: info.changed ? info.changed.length : 0,
      removed: info.removed ? info.removed.length : 0,
      codeAdded: (cd.added || []).length,
      codeChanged: (cd.changed || []).length,
      codeRemoved: (cd.removed || []).length,
      codeChangedTotal: (cd.total || 0) + (cd.removed || []).length,
      bytes: info.bytes || 0, skipped: !!info.skipped, error: info.error || null,
      needsUpgrade: info.needsUpgrade || null, appVer: APP_VER,
      deferred: info.deferred || 0,
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
    const all = d.added.concat(d.changed);

    // 只下「核心 + 当前地图」；其它地图的点位与瓦片留到打开该区域时再取
    const curMap = opts.scope === 'all' ? null : String(
      (window.__GEL && typeof window.__GEL.currentMapId === 'function' && window.__GEL.currentMapId()) || '');
    const list = curMap === null ? all
      : all.filter((p) => { const m = mapOf(p); return !m || m === 'map:' + curMap; });
    const parked = curMap === null ? []
      : all.filter((p) => { const m = mapOf(p); return !!m && m !== 'map:' + curMap; });

    showCard('正在获取新内容', 0, list.length, '');
    const cache = await caches.open(CACHE);
    let done = 0, bytes = 0, failed = [];
    const cd = codeDiff(manifest.code, codeState());
    const codeChanged = cd.total > 0 || cd.removed.length > 0;
    const dataChanged = list.some((p) => p.startsWith('data/'));

    for (const path of list) {
      try {
        const put = await download(b, path);
        bytes += put.size;
        await cache.put(abs(path), put.res);
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

    if (failed.length) {
      running = false;
      showCard('部分内容未能获取', done, list.length, `${failed.length} 个文件失败，下次打开重试`);
      s.lastError = 'failed:' + failed.slice(0, 3).join(',');
      Local.write(s);
      return { error: s.lastError, failed };
    }

    /* 代码包整包安装（原子）：全部落盘后才切换激活指针 */
    let codeRes = null;
    if (codeChanged) {
      try {
        codeRes = await installCode(manifest.code, b);
      } catch (e) {
        codeRes = { error: String((e && e.message) || e) };
      }
    }
    running = false;

    s.version = manifest.version;
    s.files = manifest.files;
    s.changelog = manifest.changelog || [];
    s.checkedAt = now();
    s.updatedAt = now();
    // 记下还没下载的文件（打开对应地图时补），已下载的清掉
    s.deferred = Object.assign({}, s.deferred || {});
    parked.forEach((p) => { if (manifest.files[p]) s.deferred[p] = manifest.files[p][1]; });
    list.forEach((p) => { if (s.deferred[p]) delete s.deferred[p]; });
    d.removed.forEach((p) => { if (s.deferred[p]) delete s.deferred[p]; });
    Local.write(s);
    pending = null;
    lastInfo = null;
    showCard('已更新到 ' + manifest.version, list.length, list.length,
      `新增 ${d.added.length} · 修改 ${d.changed.length} · 删除 ${d.removed.length}`
      + (codeChanged ? ` · 界面 ${cd.total} 处` : '')
      + (parked.length ? ` · ${parked.length} 个待打开对应区域` : ''));
    renderStatus();
    window.dispatchEvent(new CustomEvent('gel:upstream-applied', {
      detail: {
        version: manifest.version, added: d.added.length, changed: d.changed.length,
        removed: d.removed.length, bytes, codeChanged, code: codeRes,
      },
    }));

    const applied = !codeRes || !codeRes.error;
    if (opts.reload !== false && applied && (codeChanged || dataChanged)) {
      if (codeChanged) toastLocal('界面已更新，正在刷新…');
      setTimeout(() => location.reload(), codeChanged ? 600 : 900);
    }
    return {
      version: manifest.version, added: d.added.length, changed: d.changed.length,
      removed: d.removed.length, bytes, codeChanged, dataChanged, code: codeRes,
      parked: parked.length,
    };
  }

  // 单个文件下载（带超时），返回可直接写入缓存的 Response
  // typePath：按「站点内的真实路径」推断 MIME（raw.githubusercontent 会发 text/plain，
  //           直接沿用会让脚本/样式拿到错误类型）
  async function download(b, path, typePath) {
    const url = b + path + '?t=' + Math.floor(now() / 60000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.timeout);
    let res;
    try {
      res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const type = typePath
      ? guessType(typePath)
      : (res.headers.get('Content-Type') || guessType(path));
    return {
      size: buf.byteLength,
      res: new Response(buf, { headers: { 'Content-Type': type } }),
    };
  }

  // 打开某个地图时，把之前延迟的点位 / 瓦片补齐
  async function ensureMap(mapId) {
    const s = Local.read();
    const def = Object.assign({}, s.deferred || {});
    const paths = Object.keys(def).filter((p) => mapOf(p) === 'map:' + mapId);
    if (!paths.length) return { nothing: true };
    if (running) return { busy: true };
    running = true;
    const b = base || baseUrl();
    const cache = await caches.open(CACHE);
    let ok = 0, failed = 0;
    for (const p of paths) {
      try {
        const put = await download(b, p);
        await cache.put(abs(p), put.res);
        delete def[p];
        ok++;
      } catch (e) { failed++; }
    }
    s.deferred = def;
    Local.write(s);
    running = false;
    if (ok && window.__GEL && typeof window.__GEL.reloadMarkers === 'function') {
      try { await window.__GEL.reloadMarkers(mapId); } catch (e) { /* ignore */ }
    }
    if (ok) showCard('已补全当前区域资源', ok, ok, `${ok} 个文件`);
    return { downloaded: ok, failed, total: paths.length };
  }

  function guessType(path) {
    if (/\.json$/.test(path)) return 'application/json; charset=utf-8';
    if (/\.js$/.test(path)) return 'text/javascript; charset=utf-8';
    if (/\.css$/.test(path)) return 'text/css; charset=utf-8';
    if (/\.html$/.test(path)) return 'text/html; charset=utf-8';
    if (/\.webmanifest$/.test(path)) return 'application/manifest+json; charset=utf-8';
    if (/\.webp$/.test(path)) return 'image/webp';
    if (/\.png$/.test(path)) return 'image/png';
    if (/\.jpe?g$/.test(path)) return 'image/jpeg';
    if (/\.svg$/.test(path)) return 'image/svg+xml';
    return 'application/octet-stream';
  }

  /* ------------------------------------------------ 公告（消息更新） */
  // 公告每小时独立刷新，不等 manifest 版本变化——消息要及时
  async function refreshAnnounce(force) {
    const s = Local.read();
    if (!force && s.announceCheckedAt && now() - s.announceCheckedAt < CFG.announceInterval) {
      return s.announce || null;
    }
    let doc = null;
    try {
      doc = await fetchJSON((base || baseUrl()) + 'data/announce.json?t=' + Math.floor(now() / 60000));
    } catch (e) { doc = null; }
    if (doc && Array.isArray(doc.items)) {
      s.announce = doc;
      s.announceCheckedAt = now();
      Local.write(s);
      refreshAnnounceBadge(doc);
      return doc;
    }
    s.announceCheckedAt = now();   // 失败也记时间，避免每屏都重试
    Local.write(s);
    return s.announce || null;
  }

  async function loadAnnounce() {
    const s = Local.read();
    if (s.announce && Array.isArray(s.announce.items)) return s.announce;
    try {
      const c = await caches.open(CACHE);
      const hit = await c.match(abs('data/announce.json'), { ignoreSearch: true });
      if (hit) return await hit.json();
    } catch (e) { /* ignore */ }
    try { return await (await fetch('data/announce.json', { cache: 'no-cache' })).json(); } catch (e) { /* ignore */ }
    return null;
  }

  function unseenAnnounce(doc) {
    if (!doc || !Array.isArray(doc.items) || !doc.items.length) return [];
    const seen = Local.read().announceSeen || [];
    return doc.items.filter((it) => it && it.id && !seen.includes(it.id));
  }

  async function refreshAnnounceBadge(doc) {
    const btn = document.getElementById('btnChangelog');
    if (!btn) return;
    const d = doc || await loadAnnounce();
    const un = unseenAnnounce(d);
    btn.classList.toggle('has-dot', un.length > 0);
  }

  /* ------------------------------------------------ 自动检查 */
  async function auto() {
    refreshAnnounce().catch(() => null);
    let r;
    try { r = await check(); } catch (e) { return; }
    if (r && r.needsUpgrade) {
      toastLocal('有新内容，刷新页面后自动获取');
      return;
    }
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
    if (s.needsUpgrade) {
      el.textContent = `需刷新页面升级（要求 ${s.needsUpgrade}）`;
      el.classList.add('is-warn');
      return;
    }
    el.classList.remove('is-warn');
    const defN = Object.keys(s.deferred || {}).length;
    el.textContent = `资源 ${s.version} · ${when}检查` + (defN ? ` · ${defN} 项按需加载` : '');
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
    const ann = await loadAnnounce();
    const annHtml = ann && Array.isArray(ann.items) && ann.items.length
      ? `<section class="cl-ann"><p class="cl-ann-h">公告</p>${ann.items.map((it) =>
          `<p class="cl-ann-item"><span>${(it.date || '').replace(/-/g, '/')}</span>${it.text || ''}</p>`).join('')}</section>`
      : '';
    if (ann && ann.items && ann.items.length) {
      const seen = new Set(Local.read().announceSeen || []);
      ann.items.forEach((it) => { if (it && it.id) seen.add(it.id); });
      const st2 = Local.read();
      st2.announceSeen = Array.from(seen).slice(-50);
      Local.write(st2);
      refreshAnnounceBadge();
    }
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
    body.innerHTML = (annHtml + rows.join('')) || '<p class="cl-empty">暂无更新记录</p>';
  }

  function closeChangelog() {
    const wrap = document.getElementById('changelogWrap');
    if (wrap) wrap.setAttribute('aria-hidden', 'true');
  }

  const isChangelogOpen = () => {
    const w = document.getElementById('changelogWrap');
    return !!w && w.getAttribute('aria-hidden') === 'false';
  };

  /* 站点重新部署会清掉代码包（部署即权威）。这里把本地记录重新对齐到内置基线，
     避免「记录说有包、实际没有」导致上游一直不重新下发。 */
  async function verifyBundle() {
    const cs = codeState();
    const active = await readActive();
    if (active && active.version) {
      if (!cs.version || cs.version !== active.version) {
        saveCodeState(Object.assign({}, cs, { version: active.version }));
      }
      return;
    }
    if (!cs.version) return;
    /* 包被清掉了（站点重新部署过）：把记录对齐到内置基线，上游有新版本再下发 */
    try {
      const b = await getBaseline();
      if (b && b.code && b.code.files) saveCodeState({ version: b.version, files: b.code.files });
      else saveCodeState({});
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------ 绑定 */
  async function bind() {
    // 自愈：清掉历史上游缓存里的 js/css，并把状态里的残留条目摘掉
    healState().catch(() => null);
    verifyBundle().catch(() => null);
    // 首访先把内置基线写进本地状态，界面立刻能显示版本
    try { normalizeState(await getBaseline()); } catch (e) { /* ignore */ }
    renderStatus();
    const btn = document.getElementById('btnUpdate');
    if (btn) {
      btn.addEventListener('click', async () => {
        // 需要刷新升级时，这个按钮直接变成「刷新」
        if (Local.read().needsUpgrade) { location.reload(); return; }
        btn.disabled = true;
        btn.textContent = '检查中…';
        const r = await check({ force: true });
        btn.disabled = false;
        btn.textContent = '检查更新';
        if (r.error) { toastLocal('检查失败：网络或仓库不可达'); return; }
        if (r.needsUpgrade) { toastLocal('有新内容，但需要先刷新页面升级'); return; }
        if (!r.updated) { toastLocal(`已是最新版本 ${r.version || '资源'}`); return; }
        const res = await apply();
        if (res && res.version) {
          toastLocal(`已更新到 ${res.version}` + (res.parked ? ` · ${res.parked} 项按需加载` : ''));
        }
      });
    }
    const clBtn = document.getElementById('btnChangelog');
    if (clBtn) clBtn.addEventListener('click', openChangelog);
    refreshAnnounceBadge();
    refreshAnnounce().catch(() => null);
    // 页面常驻时也按小时刷新公告
    setInterval(() => { refreshAnnounce(true).catch(() => null); }, CFG.announceInterval);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshAnnounce().catch(() => null);
    });
    const closeEls = document.querySelectorAll('[data-close="changelog"]');
    closeEls.forEach((el) => el.addEventListener('click', closeChangelog));
    const cardClose = document.querySelector('#updCard .upd-close');
    if (cardClose) cardClose.addEventListener('click', hideCard);
  }

  window.__GEL_UP = {
    config: CFG, appVer: APP_VER, check, apply, ensureMap, openChangelog, closeChangelog,
    isChangelogOpen, diff, codeDiff, cmpVersion, cmpAppVersion, mapOf, loadAnnounce, refreshAnnounce,
    sanitize, healState, installCode, readActive, writeActive, bundleKey, codeState, saveCodeState,
    deferred: () => Object.keys(Local.read().deferred || {}),
    state: () => Local.read(), pending: () => pending,
    reset() { localStorage.removeItem(KEY); state = {}; pending = null; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // 页面打开后延迟检查（不阻塞首屏）
  window.addEventListener('load', () => {
    if (!NO_AUTO) setTimeout(() => { auto(); }, 2500);
  });
})();
