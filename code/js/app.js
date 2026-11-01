/* ============================================================
   应用主逻辑：数据加载 / 区域与层级 / 标记 / 详情 / 采集清单
   ============================================================ */
(function () {
  const { $, $$, clamp, fmt, hexToRgba, store, toast, GLYPHS, TYPE_DESC } = window.GEL;
  const LS = 'gel.collection.v1';
  const OSS = '?x-oss-process=image/resize,w_900/format,webp/quality,q_82';

  const App = {
    data: null,
    maps: {},
    types: {},
    regions: [],
    markers: {},
    atlas: {},
    areaRegion: {},
    mapRegion: {},
    done: new Set(),
    todo: new Set(),
    idx: new Map(),
    flat: [],
    visibleList: [],
    markerByKey: new Map(),
    multi: new Set(),          // 框选/画笔/Ctrl 点选的多选集合（存 __key）
    selectMode: null,          // 'rect' | 'brush' | null
    state: { regionId: null, layerId: null, filters: new Set(), hideDone: false, onlyTodo: false, depthOnly: false, selKey: null },
    drawerTab: 'todo',
    map: null,
    els: new Map(),
  };
  window.__GEL = App;

  /* ------------------------------------------------ 存储 */
  function loadStore() {
    const raw = store.get(LS, null) || {};
    App.done = new Set(Array.isArray(raw.done) ? raw.done : []);
    App.todo = new Set(Array.isArray(raw.todo) ? raw.todo : []);
    App.localUpdatedAt = Number(raw.t) || 0;
    App.localOwner = raw.u || null;
  }
  function saveStore(opts) {
    App.localUpdatedAt = Date.now();
    store.set(LS, {
      done: Array.from(App.done),
      todo: Array.from(App.todo),
      t: App.localUpdatedAt,
      u: App.localOwner || null,
      v: 1,
    });
    if (!opts || !opts.localOnly) scheduleCloudPush();
  }

  const mkey = (mapId, m) => mapId + ':' + m.i;

  /* ------------------------------------------------ 数据加载 */
  // 上游增量更新写入的缓存优先：本地/站点自带的同名文件仅作为兜底
  const UP_CACHE = 'gel-upstream-v1';
  async function fetchData(path) {
    try {
      const c = await caches.open(UP_CACHE);
      const hit = await c.match(new URL(path, location.href).href);
      if (hit) return hit;
    } catch (e) { /* 无 Cache API 时直连 */ }
    return fetch(path, { cache: 'no-cache' });
  }

  /* 手工覆盖层：upstream/assets/atlas/ 里的 md 发布时汇总成 data/atlas_overrides.json。
     只覆盖文案与截图，坐标始终以地图数据为准。说明可以覆盖成空（表示清空），
     截图只在填了值时才替换。 */
  function applyAtlas(m) {
    const ov = App.atlas && App.atlas[m.i];
    if (!ov) return;
    if (typeof ov.txt === 'string') m.txt = ov.txt;
    if (typeof ov.img === 'string' && ov.img) m.img = ov.img;
    if (typeof ov.title === 'string' && ov.title) m.__title = ov.title;
  }

  async function boot() {
    loadStore();
    /* 全部数据一次并发拉：原来 4 个串行 await（maps → guide → anchors → guideExtra）
       在移动网络下等于多花 3 个 RTT，首屏白等一秒多 */
    let data;
    try {
      const [mapsRes, guideRes, anchorsRes, guideExtraRes, atlasRes] = await Promise.all([
        fetchData('data/maps.json'),
        fetchData('data/guide_shadow.json').catch(() => null),
        fetchData('data/anchors.json').catch(() => null),
        fetchData('data/guide_extra.json').catch(() => null),
        fetchData('data/atlas_overrides.json').catch(() => null),
      ]);
      data = await mapsRes.json();
      const [guide, anchors, guideExtra, atlas] = await Promise.all([
        guideRes ? guideRes.json().catch(() => null) : null,
        anchorsRes ? anchorsRes.json().catch(() => null) : null,
        guideExtraRes ? guideExtraRes.json().catch(() => null) : null,
        atlasRes ? atlasRes.json().catch(() => null) : null,
      ]);
      App.guide = guide;
      App.anchors = anchors;
      App.guideExtra = guideExtra;
      /* 手工维护的神瞳文案覆盖层（upstream/assets/atlas/ 发布时生成），按点位 id 生效 */
      App.atlas = (atlas && atlas.points) || {};
    } catch (e) {
      document.getElementById('mapLoading').innerHTML = '数据加载失败，请刷新重试';
      return;
    }
    App.data = data;
    App.maps = data.maps;
    App.types = data.types;
    App.regions = data.regions;

    // 地图 -> 区域 映射
    App.regions.forEach((r) => r.layers.forEach((ly) => { App.mapRegion[ly.map] = r.id; }));
    // 主图 area -> 区域
    App.regions.forEach((r) => {
      const surface = r.layers.find((ly) => ly.map === 2);
      if (surface && surface.area != null) App.areaRegion[surface.area] = r.id;
    });

    const mapIds = Object.keys(App.maps);
    const packs = await Promise.all(
      mapIds.map((id) => fetchData(`data/markers_${id}.json`)
        .then((r) => r.json()).catch(() => ({ markers: [] })))
    );
    mapIds.forEach((id, i) => {
      App.markers[id] = packs[i].markers || [];
      App.markers[id].forEach((m) => {
        applyAtlas(m);
        m.__key = id + ':' + m.i;
        const rec = { mapId: Number(id), m };
        App.idx.set(m.__key, rec);
        App.flat.push({ key: m.__key, mapId: Number(id), m });
      });
    });

    buildRegions();
    buildLegend();
    initMap();

    const first = App.regions[0];
    selectRegion(first.id, { silent: true });
    refreshStats();

    initCloud();
  }

  // 上游补全某个地图的数据后，就地重建该地图的标记与索引
  async function reloadMarkers(mapId) {
    const id = String(mapId);
    const d = await fetchData(`data/markers_${id}.json`).then((r) => r.json()).catch(() => null);
    if (!d || !Array.isArray(d.markers)) return false;
    App.markers[id] = d.markers;
    const prefix = id + ':';
    Array.from(App.idx.keys()).forEach((k) => { if (k.indexOf(prefix) === 0) App.idx.delete(k); });
    App.flat = App.flat.filter((r) => String(r.mapId) !== id);
    d.markers.forEach((m) => {
      applyAtlas(m);
      m.__key = prefix + m.i;
      const rec = { mapId: Number(id), m };
      App.idx.set(m.__key, rec);
      App.flat.push({ key: m.__key, mapId: Number(id), m });
    });
    if (String(currentLayer().map) === id) {
      renderMarkers();
      refreshStats();
      refreshRegionCounts();
    }
    return true;
  }

  function currentMapId() { return String(currentLayer().map); }

  function regionOf(mapId, m) {
    if (mapId === 2) return App.areaRegion[m.a] || null;
    return App.mapRegion[mapId] || null;
  }
  function regionById(id) { return App.regions.find((r) => r.id === id) || App.regions[0]; }
  function layerOf(mapId, m) {
    const rid = regionOf(mapId, m);
    const r = regionById(rid);
    return r.layers.find((ly) => ly.map === mapId) || r.layers[0];
  }
  function currentRegion() { return regionById(App.state.regionId); }
  function currentLayer() {
    const r = currentRegion();
    const layers = (r && r.layers) || [];
    /* 地图数据还没到位时（例如启动即触发上游检查）不能抛错，退化成空层 */
    return layers.find((ly) => ly.id === App.state.layerId) || layers[0] || { id: '', map: '' };
  }

  /* ------------------------------------------------ 区域列表 */
  function buildRegions() {
    const wrap = $('#regionList');
    wrap.innerHTML = '';
    App.regions.forEach((r) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'region-item';
      btn.dataset.region = r.id;
      btn.style.setProperty('--c', App.types[r.element] ? App.types[r.element].color : '#999');
      btn.innerHTML = `
        <span class="region-dot"></span>
        <span class="region-name">${r.name}<small>${r.en}</small></span>
        <span class="region-count" data-count></span>
        <span class="region-bar"><i></i></span>`;
      btn.addEventListener('click', () => { selectRegion(r.id); closeRail(); });
      wrap.appendChild(btn);
    });
  }

  function refreshRegionCounts() {
    $$('.region-item').forEach((btn) => {
      const r = regionById(btn.dataset.region);
      let total = 0, doneN = 0;
      r.layers.forEach((ly) => {
        App.markers[ly.map].forEach((m) => {
          if (ly.area != null && m.a !== ly.area) return;
          total++;
          if (App.done.has(ly.map + ':' + m.i)) doneN++;
        });
      });
      const c = btn.querySelector('[data-count]');
      c.textContent = `${doneN}/${total}`;
      btn.querySelector('.region-bar i').style.width = total ? (doneN / total * 100) + '%' : '0%';
      btn.classList.toggle('is-active', r.id === App.state.regionId);
    });
  }

  /* ------------------------------------------------ 层级 tabs */
  function buildLayers() {
    const r = currentRegion();
    const wrap = $('#layerTabs');
    wrap.innerHTML = '';
    r.layers.forEach((ly) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'layer-tab' + (ly.id === App.state.layerId ? ' is-active' : '');
      btn.setAttribute('role', 'tab');
      const n = Object.values(ly.counts || {}).reduce((a, b) => a + b, 0);
      btn.innerHTML = `${ly.name}<em>${n}</em>`;
      btn.addEventListener('click', () => { selectLayer(ly.id); closeRail(); });
      wrap.appendChild(btn);
    });
    $('#layerNote').textContent = currentLayer().note || '';
  }

  /* ------------------------------------------------ 类型筛选 */
  function buildFilters() {
    const layer = currentLayer();
    const wrap = $('#typeFilters');
    wrap.innerHTML = '';
    const counts = {};
    const list = layerMarkers(layer);
    list.forEach((m) => { counts[m.t] = (counts[m.t] || 0) + 1; });
    Object.keys(counts).forEach((tk) => {
      const t = App.types[tk];
      if (!t) return;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (App.state.filters.has(tk) ? '' : ' is-off');
      chip.style.setProperty('--c', t.color);
      chip.innerHTML = `<i></i><span>${t.name}</span><b>${counts[tk]}</b>`;
      chip.addEventListener('click', () => {
        if (App.state.filters.has(tk)) App.state.filters.delete(tk);
        else App.state.filters.add(tk);
        chip.classList.toggle('is-off');
        renderMarkers();
        if (Route.on) planRoute({ fit: false, silent: true });
      });
      wrap.appendChild(chip);
    });
    // 层级筛选（仅当存在 z>0 的点）
    const hasDepth = list.some((m) => m.z > 0);
    $('#depthWrap').hidden = !hasDepth;
    if (!hasDepth) { App.state.depthOnly = false; $('#depthOnly').checked = false; }
  }

  function layerMarkers(layer) {
    const arr = App.markers[layer.map] || [];
    return layer.area == null ? arr : arr.filter((m) => m.a === layer.area);
  }

  /* ------------------------------------------------ 未采集路线规划（按传送锚点分段） */
  const Route = {
    on: false,
    keys: [],
    order: new Map(),
    pts: [],
    segments: [],
    split: store.get('gel.route.split', true) !== false,
  };
  setTimeout(() => { App.route = Route; }, 0);
  const SVGNS = 'http://www.w3.org/2000/svg';

  function dist2(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  function nearestIdx(list, x, y) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < list.length; i++) {
      const d = (list[i].x - x) ** 2 + (list[i].y - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /* 最近邻构造 + 2-opt 优化（限时 90ms） */
  function solveOrder(list, startIdx) {
    const n = list.length;
    const used = new Array(n).fill(false);
    const order = [startIdx];
    used[startIdx] = true;
    for (let k = 1; k < n; k++) {
      const prev = list[order[k - 1]];
      let best = -1, bd = Infinity;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const d = dist2(list[i], prev);
        if (d < bd) { bd = d; best = i; }
      }
      order.push(best);
      used[best] = true;
    }
    const t0 = performance.now();
    let improved = true, passes = 0;
    while (improved && passes < 24 && performance.now() - t0 < 90) {
      improved = false;
      passes++;
      for (let i = 1; i < n - 1; i++) {
        const a = list[order[i - 1]], b = list[order[i]];
        for (let j = i + 1; j < n; j++) {
          const c = list[order[j]];
          const nextI = j + 1 < n ? list[order[j + 1]] : null;
          const before = Math.sqrt(dist2(a, b)) + (nextI ? Math.sqrt(dist2(c, nextI)) : 0);
          const after = Math.sqrt(dist2(a, c)) + (nextI ? Math.sqrt(dist2(b, nextI)) : 0);
          if (after < before - 1e-6) {
            let lo = i, hi = j;
            while (lo < hi) { const t = order[lo]; order[lo] = order[hi]; order[hi] = t; lo++; hi--; }
            improved = true;
          }
        }
      }
    }
    return order;
  }

  function routeCandidates() {
    const layer = currentLayer();
    return layerMarkers(layer)
      .filter((m) => { m.__key = m.__key || layer.map + ':' + m.i; return passFilter(m); })
      .filter((m) => !App.done.has(m.__key));
  }

  /* 当前图层可用的传送锚点：主图按 area 过滤，独立图层全量 */
  function anchorsForLayer(layer) {
    const raw = (App.anchors && App.anchors[String(layer.map)]) || [];
    const all = raw.map((r) => ({ x: r[0], y: r[1], a: r[2], k: r[3] }));
    if (layer.area == null) return all;
    const inside = all.filter((a) => a.a === layer.area);
    return inside.length >= 3 ? inside : all;
  }

  /* 从锚点出发的最近邻排序；点数较多时再做一次限时 2-opt */
  function orderFromAnchor(anchor, pts) {
    const n = pts.length;
    if (n <= 1) return [0].slice(0, n);
    const used = new Array(n).fill(false);
    const order = [];
    let px = anchor.x, py = anchor.y;
    for (let k = 0; k < n; k++) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const d = (pts[i].x - px) ** 2 + (pts[i].y - py) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      order.push(best);
      used[best] = true;
      px = pts[best].x; py = pts[best].y;
    }
    if (n >= 8) return solveOrder(pts, order[0]);
    return order;
  }

  /* 把未采集点按最近锚点分簇，再在「间隔最大处」切成若干段：
     每段 = 从某个传送锚点出发连续步行的点位，段与段之间靠传送。 */
  function buildSegments(list) {
    const anchors = Route.split ? anchorsForLayer(currentLayer()) : [];
    if (!anchors.length || list.length < 3) {
      const startIdx = nearestIdx(list, App.map.cx, App.map.cy);
      return [{ anchor: null, pts: solveOrder(list, startIdx).map((i) => list[i]) }];
    }

    // 1) 每个点归属最近的锚点
    const buckets = new Map();
    list.forEach((m) => {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < anchors.length; i++) {
        const d = dist2(anchors[i], m);
        if (d < bd) { bd = d; bi = i; }
      }
      if (!buckets.has(bi)) buckets.set(bi, []);
      buckets.get(bi).push(m);
    });

    // 2) 锚点级贪心串联（从视野中心最近的锚点起步）
    const remain = Array.from(buckets.keys());
    let pos = nearestIdx(remain.map((i) => anchors[i]), App.map.cx, App.map.cy);
    const seq = [];
    while (remain.length) {
      const ai = remain.splice(pos, 1)[0];
      seq.push(ai);
      if (!remain.length) break;
      pos = nearestIdx(remain.map((i) => anchors[i]), anchors[ai].x, anchors[ai].y);
    }

    // 3) 段数按点位数量预算，在间隔最大的地方断开（段间 = 一次传送）
    const target = clamp(Math.round(list.length / 22), 1, 16);
    const gaps = [];
    for (let i = 1; i < seq.length; i++) {
      gaps.push({ i, d: Math.sqrt(dist2(anchors[seq[i - 1]], anchors[seq[i]])) });
    }
    const cuts = new Set(
      gaps.sort((a, b) => b.d - a.d).slice(0, Math.max(0, target - 1)).map((g) => g.i)
    );

    const legs = [];
    let cur = [];
    seq.forEach((ai, idx) => {
      if (idx > 0 && cuts.has(idx)) { legs.push(cur); cur = []; }
      cur.push(ai);
    });
    if (cur.length) legs.push(cur);

    // 4) 每段从自己的锚点出发重排（最近邻 + 限时 2-opt）
    return legs.map((leg) => {
      const anchor = anchors[leg[0]];
      const pts = [];
      leg.forEach((ai) => buckets.get(ai).forEach((p) => pts.push(p)));
      const ordered = orderFromAnchor(anchor, pts);
      return { anchor, pts: ordered.map((i) => pts[i]), anchors: leg.length };
    });
  }

  function planRoute(opts) {
    opts = opts || {};
    const list = routeCandidates();
    if (list.length < 2) {
      clearRoute(opts.silent);
      if (!opts.silent) toast('当前筛选下没有足够的未采集点位');
      return;
    }
    const segments = buildSegments(list);
    Route.on = true;
    Route.segments = segments;
    Route.pts = segments.reduce((acc, s) => acc.concat(s.pts), []);
    Route.keys = Route.pts.map((m) => m.__key);
    Route.order = new Map(Route.keys.map((k, i) => [k, i + 1]));
    buildRouteSvg();
    applyRouteBadges();
    $('#routeSvg').classList.add('is-on');
    const btn = document.querySelector('.map-tools [data-act="route"]');
    if (btn) btn.classList.add('is-on');
    const hud = $('#hudRoute');
    const segN = segments.filter((s) => s.anchor).length;
    hud.hidden = false;
    hud.innerHTML = `<i></i><span>未采集路线 · ${Route.pts.length} 个点 · `
      + `${segN ? segN + ' 段（传送锚点分段）' : '就近串联'}</span>`
      + `<button type="button" class="hud-toggle${Route.split ? ' is-on' : ''}" data-act="route-split"`
      + ` title="切换分段方式">${Route.split ? '分段' : '整体'}</button>`;
    routeFrame();
    if (opts.fit) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      list.forEach((m) => { x0 = Math.min(x0, m.x); x1 = Math.max(x1, m.x); y0 = Math.min(y0, m.y); y1 = Math.max(y1, m.y); });
      App.map.fitBounds([x0, y0, x1, y1], true);
    }
    if (!opts.silent) {
      toast(segN
        ? `已规划 ${Route.pts.length} 个点位 · ${segN} 段锚点路线`
        : `已规划 ${Route.pts.length} 个未采集点位的就近路线`);
    }
  }

  function clearRoute(silent) {
    Route.on = false;
    Route.keys = [];
    Route.pts = [];
    Route.segments = [];
    Route.order = new Map();
    const svg = $('#routeSvg');
    if (svg) { svg.classList.remove('is-on'); svg.innerHTML = ''; }
    const btn = document.querySelector('.map-tools [data-act="route"]');
    if (btn) btn.classList.remove('is-on');
    const hud = $('#hudRoute');
    if (hud) { hud.hidden = true; hud.innerHTML = ''; }
    $$('#mapMarkers .mk').forEach((el) => {
      el.classList.remove('has-order');
      const b = el.querySelector('.mk-order');
      if (b) b.textContent = '';
    });
    if (!silent) toast('已清除路线');
  }

  function toggleRoute() {
    if (Route.on) clearRoute();
    else planRoute({ fit: true });
  }

  function toggleRouteSplit() {
    Route.split = !Route.split;
    store.set('gel.route.split', Route.split);
    if (Route.on) planRoute({ fit: true, silent: true });
    toast(Route.split ? '路线已按传送锚点分段' : '路线改为整体就近串联');
  }

  /* 每段：锚点圆点 + 折线（锚点作为首点） */
  function buildRouteSvg() {
    const svg = $('#routeSvg');
    if (!svg) return;
    svg.innerHTML = '<g class="route-segs"></g>';
    const g = svg.querySelector('.route-segs');
    Route.segments.forEach((seg) => {
      const grp = document.createElementNS(SVGNS, 'g');
      grp.setAttribute('class', 'route-seg');
      const el = { ring: null, dot: null };
      if (seg.anchor) {
        const statue = seg.anchor.k === 0;
        const ring = document.createElementNS(SVGNS, 'circle');
        ring.setAttribute('class', 'route-anchor-ring' + (statue ? ' is-statue' : ''));
        ring.setAttribute('r', '7');
        const dot = document.createElementNS(SVGNS, 'circle');
        dot.setAttribute('class', 'route-anchor' + (statue ? ' is-statue' : ''));
        dot.setAttribute('r', '3');
        grp.appendChild(ring);
        grp.appendChild(dot);
        el.ring = ring; el.dot = dot;
      }
      const halo = document.createElementNS(SVGNS, 'polyline');
      halo.setAttribute('class', 'route-halo');
      const line = document.createElementNS(SVGNS, 'polyline');
      line.setAttribute('class', 'route-line');
      grp.appendChild(halo);
      grp.appendChild(line);
      el.halo = halo; el.line = line;
      seg.el = el;
      g.appendChild(grp);
    });
  }

  function applyRouteBadges() {
    if (!Route.on) return;
    $$('#mapMarkers .mk').forEach((el) => {
      const idx = Route.order.get(el.dataset.key);
      let badge = el.querySelector('.mk-order');
      if (idx) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'mk-order';
          el.appendChild(badge);
        }
        badge.textContent = idx;
        el.classList.add('has-order');
      } else if (badge) {
        badge.textContent = '';
        el.classList.remove('has-order');
      }
    });
  }

  function routeFrame() {
    if (!Route.on || !Route.segments.length) return;
    Route.segments.forEach((seg) => {
      if (!seg.el) return;
      const coords = [];
      if (seg.anchor) {
        const a = App.map.toScreen(seg.anchor.x, seg.anchor.y);
        coords.push(a);
      }
      seg.pts.forEach((m) => {
        if (!App.markerByKey.has(m.__key)) return;
        coords.push(App.map.toScreen(m.x, m.y));
      });
      const on = coords.length > 1;
      const d = on ? coords.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ') : '';
      seg.el.halo.setAttribute('points', d);
      seg.el.line.setAttribute('points', d);
      if (seg.el.dot) {
        const a = coords[0];
        const show = on ? '' : 'none';
        seg.el.dot.style.display = show;
        seg.el.ring.style.display = show;
        if (on) {
          seg.el.dot.setAttribute('cx', a.x.toFixed(1));
          seg.el.dot.setAttribute('cy', a.y.toFixed(1));
          seg.el.ring.setAttribute('cx', a.x.toFixed(1));
          seg.el.ring.setAttribute('cy', a.y.toFixed(1));
        }
      }
    });
  }

  /* ------------------------------------------------ 标记 */
  const GLYPH_WRAP = (key) => `<g transform="translate(9.4,8.6) scale(.47)" fill="none" stroke="#fffdf7" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[key] || GLYPHS.geo}</g>`;

  function pinSvg(t) {
    return `<svg viewBox="0 0 30 38" aria-hidden="true">
      <path d="M15 36.4C15 36.4 3 23.2 3 13.9 3 7.1 8.4 1.9 15 1.9s12 5.2 12 12c0 9.3-12 22.5-12 22.5Z" fill="${t.color}" stroke="#fffdf7" stroke-width="2.2"/>
      <path d="M15 36.4C15 36.4 3 23.2 3 13.9 3 7.1 8.4 1.9 15 1.9" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.1"/>
      <circle cx="15" cy="13.9" r="8.6" fill="rgba(255,255,255,.18)"/>
      ${GLYPH_WRAP(t.key)}
    </svg>`;
  }

  function buildMarkerEl(mapId, m) {
    const t = App.types[m.t];
    const key = mkey(mapId, m);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'mk';
    el.dataset.key = key;
    el.style.setProperty('--c', t.color);
    el.setAttribute('aria-label', `${t.name} #${m.n}`);
    el.innerHTML = `<span class="mk-pin">${pinSvg(t)}</span>
      <span class="mk-badge b-todo">+</span><span class="mk-badge b-done">✓</span>`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      /* Ctrl / ⌘ + 左键：加入或移出多选，不打开详情 */
      if (e.ctrlKey || e.metaKey) { toggleMulti(key); return; }
      selectMarker(mapId, m);
    });
    return { x: m.x, y: m.y, el, key, m, mapId };
  }

  function passFilter(m) {
    if (!App.state.filters.has(m.t)) return false;
    const key = m.__key;
    if (App.state.hideDone && App.done.has(key)) return false;
    if (App.state.onlyTodo && !App.todo.has(key)) return false;
    if (App.state.depthOnly && !(m.z > 0)) return false;
    return true;
  }

  function renderMarkers() {
    const layer = currentLayer();
    const mapId = layer.map;
    const src = layerMarkers(layer).map((m) => {
      m.__key = mapId + ':' + m.i;
      return m;
    });
    const visible = src.filter(passFilter);
    App.visibleList = visible.map((m) => ({ mapId, m }));
    const recs = visible.map((m) => buildMarkerEl(mapId, m));
    App.els.clear();
    App.markerByKey.clear();
    recs.forEach((r) => { App.els.set(r.key, r.el); App.markerByKey.set(r.key, r.m); });
    App.map.setMarkers(recs);
    applyMarkerStates();
    renderLegend(mapId, src);
    if (Route.on) { applyRouteBadges(); routeFrame(); }
  }

  function applyMarkerStates() {
    App.els.forEach((el, key) => {
      el.classList.toggle('is-done', App.done.has(key));
      el.classList.toggle('is-todo', App.todo.has(key));
      el.classList.toggle('is-active', App.state.selKey === key);
      el.classList.toggle('is-multi', App.multi.has(key));
    });
  }

  /* ------------------------------------------------ 多选（框选 / 画笔 / Ctrl 点选） */
  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function syncSelBar() {
    const bar = $('#selBar');
    if (!bar) return;
    const on = !!App.selectMode;
    bar.hidden = !on && App.multi.size === 0;
    const n = App.multi.size;
    const c = $('#selCount');
    if (c) c.textContent = n ? `已选 ${n} 个` : '拖拽框选，或 Ctrl+点击';
    bar.classList.toggle('is-on', on);
    /* 两个操作按钮按当前选中集合的状态动态切换语义：
       - 已采/未采混合或全未采 → 「标记已采集」；全已采 → 「取消采集」
       - 有可加入待采集的 → 「添加到待采集」；全部已在待采集 → 「移出待采集」 */
    let doneCnt = 0, todoCnt = 0;
    App.multi.forEach((k) => {
      if (App.done.has(k)) doneCnt++;
      if (App.todo.has(k)) todoCnt++;
    });
    const undone = n - doneCnt;
    const addable = n - todoCnt - doneCnt; /* 未采集且未在待采集 */
    const bDone = bar.querySelector('[data-act="sel-done"]');
    if (bDone) {
      const mark = undone > 0;
      bDone.dataset.selstate = mark ? 'mark' : 'undo';
      bDone.textContent = mark ? '标记已采集' : '取消采集';
    }
    const bTodo = bar.querySelector('[data-act="sel-todo"]');
    if (bTodo) {
      const add = addable > 0 || (todoCnt === 0 && doneCnt === n); /* 全已采也能加（同时取消已采集） */
      bTodo.dataset.selstate = add ? 'add' : 'remove';
      bTodo.textContent = add ? '添加到待采集' : '移出待采集';
    }
    bar.querySelectorAll('[data-act^="sel-"]').forEach((b) => {
      const act = b.dataset.act;
      if (act === 'sel-clear' || act === 'sel-exit') return;
      b.disabled = n === 0;
    });
  }

  function setSelectMode(mode) {
    const next = App.selectMode === mode ? null : mode;
    App.selectMode = next;
    if (App.map) App.map.setSelectMode(next);
    $$('.map-tools [data-act^="select-"]').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.act === 'select-' + next);
    });
    syncSelBar();
    if (next) toast(next === 'rect' ? '拖拽框选神瞳，Esc 退出' : '按住拖动画圈，Esc 退出');
  }

  function clearMulti() {
    App.multi.clear();
    applyMarkerStates();
    syncSelBar();
  }

  function toggleMulti(key) {
    if (App.multi.has(key)) App.multi.delete(key);
    else App.multi.add(key);
    applyMarkerStates();
    syncSelBar();
  }

  /* 框选/画笔结束：把落在多边形里的可见标记并入选择 */
  function onMapSelect(poly) {
    const layer = currentLayer();
    const hit = [];
    App.visibleList.forEach((r) => {
      if (String(r.mapId) !== String(layer.map)) return;
      if (pointInPoly(r.m.x, r.m.y, poly)) hit.push(mkey(r.mapId, r.m));
    });
    hit.forEach((k) => App.multi.add(k));
    applyMarkerStates();
    syncSelBar();
    if (hit.length) toast(`选中 ${hit.length} 个（共 ${App.multi.size} 个）`);
    else toast('这个范围里没有神瞳');
  }

  /* 批量改采集状态 */
  function bulkSetDone(on) {
    const keys = Array.from(App.multi);
    if (!keys.length) return;
    const prev = keys.map((k) => [k, App.done.has(k), App.todo.has(k)]);
    keys.forEach((k) => {
      if (on) { App.done.add(k); App.todo.delete(k); }
      else App.done.delete(k);
    });
    afterBulk();
    undoToast(
      on ? `已把 ${keys.length} 个标记为已采集` : `已取消 ${keys.length} 个的采集标记`,
      () => { prev.forEach(([k, d, t]) => setKeyState(k, d, t)); afterBulk(); },
    );
  }

  /* 批量加入/移出待采集（与单点 toggleTodo 同规则：加入时已采集的同时取消已采集） */
  function bulkTodo(on) {
    const keys = Array.from(App.multi);
    if (!keys.length) return;
    const prev = keys.map((k) => [k, App.done.has(k), App.todo.has(k)]);
    let undid = 0;
    keys.forEach((k) => {
      if (on) {
        App.todo.add(k);
        if (App.done.has(k)) { App.done.delete(k); undid++; }
      } else App.todo.delete(k);
    });
    afterBulk();
    const msg = on
      ? `已把 ${keys.length} 个加入待采集` + (undid ? `（同时取消 ${undid} 个的已采集）` : '')
      : `已把 ${keys.length} 个移出待采集`;
    undoToast(msg, () => { prev.forEach(([k, d, t]) => setKeyState(k, d, t)); afterBulk(); });
  }

  function afterBulk() {
    saveStore();
    refreshStats();
    /* hideDone/onlyTodo 都会改变可见集合：批量标记后重算可见列表 */
    if (App.state.hideDone || App.state.onlyTodo) renderMarkers();
    else applyMarkerStates();
    syncSelBar(); /* 按钮语义跟随选中集合的状态变化 */
    if (isDrawerOpen()) renderDrawer();
    if (Route.on) planRoute({ fit: false, silent: true });
  }

  function renderLegend(mapId, src) {
    const seen = new Map();
    src.forEach((m) => { if (!seen.has(m.t)) seen.set(m.t, (seen.get(m.t) || 0) + 1); });
    const counts = {};
    src.forEach((m) => { counts[m.t] = (counts[m.t] || 0) + 1; });
    const items = Array.from(seen.keys()).map((tk) => {
      const t = App.types[tk];
      return `<span class="legend-item" style="--c:${t.color}"><i></i>${t.name}<b>${counts[tk]}</b></span>`;
    }).join('');
    const collapsed = isLegendCollapsed();
    $('#mapLegend').classList.toggle('is-collapsed', collapsed);
    $('#mapLegend').innerHTML = `<button type="button" class="legend-toggle" aria-expanded="${!collapsed}">`
      + `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5 10 8l-5 4.5"/></svg>`
      + `图例 · 本层 ${src.length}</button><div class="legend-items">${items}</div>`;
  }

  /* 图例折叠：状态存本机，折叠后只留一个小胶囊 */
  function isLegendCollapsed() {
    return store.get('gel.legend.collapsed', false) === true;
  }
  function toggleLegend() {
    const box = $('#mapLegend');
    const next = !box.classList.contains('is-collapsed');
    store.set('gel.legend.collapsed', next);
    box.classList.toggle('is-collapsed', next);
    const btn = box.querySelector('.legend-toggle');
    if (btn) btn.setAttribute('aria-expanded', next ? 'false' : 'true');
  }

  /* ------------------------------------------------ 区域/层级切换 */
  function selectRegion(rid, opts) {
    opts = opts || {};
    App.state.regionId = rid;
    const r = regionById(rid);
    App.state.layerId = r.layers[0].id;
    resetFilters();
    clearMulti();
    buildLayers();
    loadLayer();
    refreshRegionCounts();
    if (!opts.silent) closeDetail();
  }

  function selectLayer(lid) {
    App.state.layerId = lid;
    resetFilters();
    clearMulti();
    buildLayers();
    loadLayer();
    closeDetail();
  }

  function resetFilters() {
    const layer = currentLayer();
    const list = layerMarkers(layer);
    App.state.filters = new Set(Array.from(new Set(list.map((m) => m.t))));
    App.state.depthOnly = false;
    $('#depthOnly').checked = false;
    $('#hideDone').checked = App.state.hideDone;
    $('#onlyTodo').checked = App.state.onlyTodo;
  }

  function loadLayer() {
    const layer = currentLayer();
    const meta = App.maps[String(layer.map)];
    App.map.setMap(meta);
    buildFilters();
    renderMarkers();
    const r = currentRegion();
    $('#hudRegion').innerHTML = `<i style="--c:${App.types[r.element].color}"></i>${r.name} <span style="font-size:11px;letter-spacing:.14em;color:var(--ink-3)">${r.en}</span>`;
    $('#hudLayer').textContent = layer.name;
    App.map.fitBounds(fitBoundsOf(layer), false);
    if (Route.on) planRoute({ fit: false, silent: true });
    document.getElementById('mapLoading').classList.add('is-off');
    setTimeout(() => App.map.resize(), 30);
    // 上游把非当前地图的资源延迟了：切到这个地图时再补齐
    if (window.__GEL_UP && typeof window.__GEL_UP.ensureMap === 'function') {
      setTimeout(() => { window.__GEL_UP.ensureMap(String(layer.map)).catch(() => null); }, 700);
    }
  }

  function fitBoundsOf(layer) {
    const list = layerMarkers(layer);
    if (!list.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    list.forEach((m) => {
      x0 = Math.min(x0, m.x); x1 = Math.max(x1, m.x);
      y0 = Math.min(y0, m.y); y1 = Math.max(y1, m.y);
    });
    const meta = App.maps[String(layer.map)];
    const padX = Math.max((x1 - x0) * 0.09, 90);
    const padY = Math.max((y1 - y0) * 0.09, 90);
    return [
      Math.max(-200, x0 - padX), Math.max(-200, y0 - padY),
      Math.min(meta.content[0] + 200, x1 + padX), Math.min(meta.content[1] + 200, y1 + padY),
    ];
  }

  /* ------------------------------------------------ 详情面板 */
  function selectMarker(mapId, m) {
    const key = mapId + ':' + m.i;
    App.state.selKey = key;
    applyMarkerStates();
    openDetail(mapId, m);
    const inset = window.innerWidth > 960 ? 384 : 0;
    App.map.ensureVisible(m.x, m.y, inset);
  }

  /* ------------------------------------------------ 米游社攻略（影生翼滴） */
  function guideArea(id) {
    return App.guide ? App.guide.areas.find((a) => a.id === id) : null;
  }

  function guideFigure(area, cls) {
    const cap = area.name + ' · 收集攻略';
    return `<figure class="guide-map${cls ? ' ' + cls : ''}" data-guide="${area.img}" data-cap="${cap}"
        tabindex="0" role="button" aria-label="放大查看${area.name}攻略图">
        <img src="${area.img}" alt="${area.name}影生翼滴收集攻略图" loading="lazy" decoding="async">
        <span class="guide-zoom" aria-hidden="true">放大</span>
      </figure>`;
  }

  function guideHtml(m) {
    const g = App.guide;
    if (!g || !g.byPoint) return '';
    if (g.type && g.type !== m.t) return '';
    const rec = g.byPoint[String(m.n)];
    if (!rec) return '';

    let cards = [];
    let title = '';
    let noBadge = '';
    let hint = '';
    let note = '';
    let areaName = '';

    if (rec.area) {
      const a = guideArea(rec.area);
      if (!a) return '';
      cards = [a];
      areaName = a.name;
      if (rec.no) noBadge = `<span class="guide-no">本区第 ${rec.no} 号</span>`;
      hint = rec.hint || (a.hints && a.hints[String(rec.no)]) || '';
      note = a.note || '';
    } else if (rec.group) {
      const grp = g.groups && g.groups[rec.group];
      if (!grp) return '';
      cards = (grp.cards || []).map(guideArea).filter(Boolean);
      areaName = grp.name;
      note = grp.note || '';
    } else {
      return '';
    }

    const multi = cards.length > 1;
    const body = multi
      ? `<div class="guide-multi">${cards.map((a) => `<div class="guide-thumb">${guideFigure(a, 'is-thumb')}<span class="guide-thumb-cap">${a.name}</span></div>`).join('')}</div>`
      : guideFigure(cards[0]);

    const list = multi
      ? `<ul class="guide-tips">${cards.map((a) => `<li><b>${a.name}</b>：第 ${a.nums[0]}–${a.nums[a.nums.length - 1]} 号</li>`).join('')}</ul>`
      : '';

    const src = g.source || {};
    const srcLine = `<p class="guide-src">攻略来源：${src.platform || '米游社'}
      <a href="${src.url}" target="_blank" rel="noopener noreferrer">《${src.title}》</a>
      · 作者 @${src.author}${src.design ? '（设计 ' + src.design + '）' : ''}
      ${src.team ? '· ' + src.team : ''} ${src.date || ''}</p>`;

    const tips = (g.tips || []).length
      ? `<div class="guide-tips-box"><h4>收集要点</h4><ul>${g.tips.map((t) => `<li>${t}</li>`).join('')}</ul></div>`
      : '';

    return `<section class="guide" aria-label="收集攻略">
        <div class="guide-top">
          <span class="guide-tag">攻略</span>
          <span class="guide-area">${areaName}</span>
          ${noBadge}
        </div>
        ${hint ? `<p class="guide-hint"><span>位置提示</span>${escapeHtml(hint)}</p>` : ''}
        ${note ? `<p class="guide-note">${escapeHtml(note)}</p>` : ''}
        ${body}
        ${list}
        ${tips}
        ${srcLine}
      </section>`;
  }

  function bindGuide(panel) {
    $$('.guide-map', panel).forEach((fig) => {
      const open = () => openLightbox(fig.dataset.guide, fig.dataset.cap || '');
      fig.addEventListener('click', open);
      fig.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  /* ------------------------------------------------ 区域收集物攻略图解（绯红玉髓 / 流明晶石…） */
  function guideExtraOf(tk) {
    const G = App.guideExtra;
    return G && G.types ? G.types[tk] : null;
  }

  function guideExtraHtml(m) {
    const G = guideExtraOf(m.t);
    if (!G || !G.sections || !G.sections.length) return '';
    const src = G.source || {};
    const total = G.sections.reduce((a, s) => a + (s.count || 0), 0);
    /* 本点位在当前攻略里的编号说明（由点位坐标与攻略图配准得到） */
    const hit = G.byMarker ? G.byMarker[String(m.i)] : null;
    const sec = hit ? G.sections[hit.sec - 1] : null;
    const head = hit
      ? `<p class="guide-x-tip"><span class="gx-no">${hit.no}</span>${escapeHtml(hit.text || '')}</p>`
      : `<p class="guide-x-note">按作者的分区图对照查找：每区一张实景点位图，图下为该区编号说明，点开可放大。</p>`;
    return `<section class="guide-x" aria-label="区域攻略图解">
        <div class="guide-x-top">
          <span class="guide-tag">攻略</span>
          <span class="guide-area">${hit ? `第 ${hit.sec} 区图解 · 编号 ${hit.no}` : `${G.sections.length} 个区域图解`}</span>
          ${total ? `<span class="guide-no">覆盖 ${total} 个点位</span>` : ''}
        </div>
        ${head}
        <button type="button" class="guide-x-btn" data-act="guide-extra" data-type="${m.t}"${hit ? ` data-sec="${hit.sec}"` : ''}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 3.6h3.4c.9 0 1.6.7 1.6 1.6v8.2c0-.9-.7-1.6-1.6-1.6H2.4z"/><path d="M13.6 3.6H10.2c-.9 0-1.6.7-1.6 1.6v8.2c0-.9.7-1.6 1.6-1.6h3.4z"/></svg>
          ${hit ? (sec && sec.img ? '查看图解定位' : `查看第 ${hit.sec} 区说明`) : '查看攻略图解与编号说明'}
        </button>
        <p class="guide-src">攻略来源：${src.platform || '米游社'} <a href="${src.url}" target="_blank" rel="noopener noreferrer">《${src.title}》</a> · @${src.author}${src.date ? ' ' + src.date : ''}</p>
      </section>`;
  }

  function isGuideExtraOpen() {
    const w = $('#guideExtraWrap');
    return !!w && w.getAttribute('aria-hidden') === 'false';
  }

  function openGuideExtra(tk, secNo) {
    const G = guideExtraOf(tk);
    if (!G) return;
    const t = App.types[tk] || { name: '' };
    const src = G.source || {};
    $('#guideExtraTitle').textContent = `${t.name} · 攻略图解`;
    const body = $('#guideExtraBody');
    body.innerHTML = `
      <p class="gx-intro">${G.summary || ''}<br>
        米游社 <a href="${src.url}" target="_blank" rel="noopener noreferrer">《${src.title}》</a>
        · @${src.author}${src.date ? ' · ' + src.date : ''}</p>
      ${G.sections.map((s, i) => `
        <section class="gx" id="gx-sec-${i + 1}"${secNo === i + 1 ? ' data-focus="1"' : ''}>
          <div class="gx-head"><b>${escapeHtml(s.name)}</b>${s.count ? `<span>${s.count} 个</span>` : ''}</div>
          <figure class="gx-img" tabindex="0" role="button" data-guide="${s.img}" data-cap="${escapeHtml(s.name)} · ${t.name}点位图">
            <img src="${s.img}" alt="${escapeHtml(s.name)}点位图" loading="lazy" decoding="async">
            <span class="gx-zoom" aria-hidden="true">放大</span>
          </figure>
          ${(s.tips && s.tips.length)
            ? `<ul class="gx-tips">${s.tips.map((x) => `<li><b>${x.no}</b>${escapeHtml(x.text)}</li>`).join('')}</ul>`
            : ''}
        </section>`).join('')}
      ${(G.notes || []).length
        ? `<div class="gx-notes"><b>补充说明</b><ul>${G.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`
        : ''}`;
    $$('.gx-img', body).forEach((fig) => {
      const open = () => openLightbox(fig.dataset.guide, fig.dataset.cap || '');
      fig.addEventListener('click', open);
      fig.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
    $('#guideExtraWrap').setAttribute('aria-hidden', 'false');
    body.scrollTop = 0;
    if (secNo > 0) {
      const el = body.querySelector(`#gx-sec-${secNo}`);
      if (el) {
        body.scrollTop = Math.max(0, el.offsetTop - 12);
        el.classList.add('is-focus');
        setTimeout(() => el.classList.remove('is-focus'), 1600);
      }
    }
  }

  function closeGuideExtra() {
    const w = $('#guideExtraWrap');
    if (w) w.setAttribute('aria-hidden', 'true');
  }

  /* 详情面板内的「上一个 / 下一个」：在当前图层已渲染的标记间移动 */
  function navBarHtml(key) {
    const list = App.visibleList || [];
    if (list.length < 2) return '';
    const i = list.findIndex((r) => r.mapId + ':' + r.m.i === key);
    return `<div class="detail-navbar">
      <button type="button" class="dnav" data-act="prev" aria-label="上一个">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.8 3.4 5.2 8l4.6 4.6"/></svg>上一个</button>
      <button type="button" class="dnav" data-act="next" aria-label="下一个">下一个
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.4 10.8 8l-4.6 4.6"/></svg></button>
      <span class="dnav-pos">${i >= 0 ? i + 1 : '–'} / ${list.length}</span>
    </div>`;
  }

  function navDetail(dir) {
    const list = App.visibleList || [];
    if (list.length < 2) return false;
    let i = list.findIndex((r) => r.mapId + ':' + r.m.i === App.state.selKey);
    if (i < 0) return false;
    i = (i + dir + list.length) % list.length;
    const rec = list[i];
    selectMarker(rec.mapId, rec.m);
    return true;
  }

  function isDetailOpen() {
    const p = $('#detailPanel');
    return !!p && p.classList.contains('is-open');
  }

  /* 移动端：点击或拖动把手，在半屏 / 全屏之间切换 */
  function bindSheetGrab(grab, panel) {
    let startY = null, moved = 0, suppressClick = false;
    grab.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      moved = 0;
      suppressClick = false;
      try { grab.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    grab.addEventListener('pointermove', (e) => {
      if (startY == null) return;
      moved = Math.max(moved, Math.abs(e.clientY - startY));
    });
    grab.addEventListener('pointerup', (e) => {
      if (startY == null) return;
      const dy = e.clientY - startY;
      startY = null;
      // 自己处理「点击」，不依赖浏览器补发的 click（拖动后常被抑制）
      suppressClick = true;
      try { grab.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (Math.abs(dy) >= 24) panel.classList.toggle('is-full', dy < 0);
      else if (moved < 12) panel.classList.toggle('is-full');
    });
    grab.addEventListener('pointercancel', () => { startY = null; });
    grab.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      panel.classList.toggle('is-full');
    });
  }

  function openDetail(mapId, m) {
    const key = mapId + ':' + m.i;
    const t = App.types[m.t];
    const rid = regionOf(mapId, m);
    const region = regionById(rid);
    const layer = layerOf(mapId, m);
    const isDone = App.done.has(key);
    const isTodo = App.todo.has(key);
    const panel = $('#detailPanel');
    const imgUrl = m.img ? m.img + OSS : '';
    const coord = `${Math.round(m.x)}, ${Math.round(m.y)}`;
    const variant = m.v ? ' ' + m.v : '';
    const depthTag = m.z > 0 ? `<span class="tag t-depth">水下层级 ${m.z}</span>` : '';
    const stateTag = isDone
      ? '<span class="tag t-done">已采集</span>'
      : isTodo ? '<span class="tag t-todo">待采集</span>' : '<span class="tag t-none">未采集</span>';

    panel.innerHTML = `
      <button class="detail-grab" type="button" aria-label="展开或收起详情面板"><span></span></button>
      <div class="detail-scroll">
        <div class="detail-head">
          <div class="detail-glyph" style="--c:${t.color};--c-soft:${hexToRgba(t.color, 0.13)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[t.key] || ''}</svg>
          </div>
          <div class="detail-title">
            <h2>${t.name}${variant}<span class="num">#${m.n}</span></h2>
            <p>${region.name} · ${layer.name} · ${t.kind === 'oculus' ? '神瞳' : '区域收集物'}</p>
          </div>
          <button class="icon-btn detail-close" type="button" aria-label="关闭详情">
            <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>

        ${navBarHtml(key)}

        <figure class="detail-shot" id="detailShot"${imgUrl ? ' tabindex="0" role="button" aria-label="点击放大查看实景截图"' : ''}>
          ${imgUrl ? `<img alt="${t.name}实景截图" referrerpolicy="no-referrer" loading="lazy">
          <div class="shot-skeleton"><span>加载实景截图</span></div>
          <span class="shot-zoom" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 14 14M7 5.2v3.6M5.2 7h3.6"/></svg></span>
          <figcaption>官方实景截图 · 点击放大</figcaption>`
        : `<div class="shot-skeleton is-gone"></div>
          <figcaption>暂无实景截图</figcaption>`}
        </figure>

        <dl class="detail-meta">
          <div><dt>类型</dt><dd>${t.kind === 'oculus' ? '神瞳' : '特殊收集物'}</dd></div>
          <div><dt>编号</dt><dd>${t.name} #${m.n}</dd></div>
          <div><dt>区域</dt><dd>${region.name}</dd></div>
          <div><dt>层级</dt><dd>${layer.name}</dd></div>
          <div><dt>地图坐标</dt><dd class="mono">${coord}</dd></div>
          <div><dt>状态</dt><dd id="detailState">${stateTag} ${depthTag}</dd></div>
        </dl>

        <p class="detail-desc">${TYPE_DESC[t.key] || ''}${m.txt ? '<br><br>' + escapeHtml(m.txt) : ''}</p>

        ${guideHtml(m)}
        ${guideExtraHtml(m)}

        <div class="detail-actions">
          <button class="btn act-todo${isTodo ? ' is-on' : ''}" type="button" data-act="todo"${isDone && !isTodo ? ' disabled title="已采集的神瞳无需加入待采集"' : ''}>${isTodo ? '移出待采集' : '加入待采集'}</button>
          <button class="btn act-done${isDone ? ' is-on' : ''}" type="button" data-act="done">${isDone ? '取消已采集' : '标记已采集'}</button>
        </div>
        <p class="detail-foot">进度保存在本机浏览器，可随时导出备份。若截图加载失败，请检查网络后重试。</p>
      </div>`;

    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');

    // 截图加载
    const shot = $('#detailShot', panel);
    const img = shot ? shot.querySelector('img') : null;
    if (img) {
      const onLoaded = () => {
        img.classList.add('is-loaded');
        const sk = shot.querySelector('.shot-skeleton');
        if (sk) sk.classList.add('is-gone');
      };
      // 先挂监听再赋 src，并处理「已在缓存中」的同步命中
      img.addEventListener('load', onLoaded);
      img.addEventListener('error', () => {
        shot.classList.add('is-empty');
        shot.innerHTML = `<div class="shot-fallback" style="--c:${t.color}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[t.key] || ''}</svg>
          <span>暂无实景截图</span></div>`;
      });
      img.src = imgUrl;
      if (img.complete && img.naturalWidth > 0) onLoaded();
    }

    if (imgUrl) {
      const caption = `${t.name}${variant} #${m.n} · ${region.name} · ${layer.name}`;
      const openLb = () => openLightbox(imgUrl, caption);
      shot.addEventListener('click', openLb);
      shot.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLb(); }
      });
    }

    bindGuide(panel);
    const gxBtn = panel.querySelector('[data-act="guide-extra"]');
    if (gxBtn) gxBtn.addEventListener('click', () => openGuideExtra(gxBtn.dataset.type, Number(gxBtn.dataset.sec) || 0));

    panel.querySelector('.detail-close').addEventListener('click', closeDetail);
    const btnPrev = panel.querySelector('[data-act="prev"]');
    const btnNext = panel.querySelector('[data-act="next"]');
    if (btnPrev) btnPrev.addEventListener('click', () => navDetail(-1));
    if (btnNext) btnNext.addEventListener('click', () => navDetail(1));
    const grab = panel.querySelector('.detail-grab');
    if (grab) bindSheetGrab(grab, panel);
    panel.querySelector('[data-act="todo"]').addEventListener('click', () => toggleTodo(key));
    panel.querySelector('[data-act="done"]').addEventListener('click', () => toggleDone(key));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function closeDetail() {
    const panel = $('#detailPanel');
    panel.classList.remove('is-open');
    panel.classList.remove('is-full');
    panel.setAttribute('aria-hidden', 'true');
    App.state.selKey = null;
    applyMarkerStates();
  }

  /* ------------------------------------------------ 采集状态 */
  function setKeyState(key, inDone, inTodo) {
    if (inDone) App.done.add(key); else App.done.delete(key);
    if (inTodo) App.todo.add(key); else App.todo.delete(key);
  }

  /* 带「撤销」的提示（默认 5 秒） */
  function undoToast(msg, undo, ms) {
    toast(msg, {
      action: '撤销',
      duration: ms || 5200,
      onAction: () => { undo(); toast('已撤销'); },
    });
  }

  function toggleTodo(key) {
    if (!App.todo.has(key) && App.done.has(key)) {
      toast('该收集物已标记为已采集，如需重采请先取消已采集');
      return;
    }
    const prevDone = App.done.has(key);
    const prevTodo = App.todo.has(key);
    let msg;
    if (prevTodo) {
      App.todo.delete(key);
      msg = '已移出待采集';
    } else {
      App.todo.add(key);
      if (prevDone) { App.done.delete(key); msg = '已加入待采集（同时取消已采集）'; }
      else msg = '已加入待采集';
    }
    afterToggle(key);
    undoToast(msg, () => { setKeyState(key, prevDone, prevTodo); afterToggle(key); });
  }

  function toggleDone(key) {
    const prevDone = App.done.has(key);
    const prevTodo = App.todo.has(key);
    let msg;
    if (prevDone) {
      App.done.delete(key);
      msg = '已取消标记，图标恢复颜色';
    } else {
      App.done.add(key);
      App.todo.delete(key);
      msg = '已标记为已采集';
    }
    afterToggle(key);
    undoToast(msg, () => { setKeyState(key, prevDone, prevTodo); afterToggle(key); });
  }

  /* 详情面板按钮/状态与某条记录同步（key 为空时同步当前选中的那条） */
  function syncDetailButtons(key) {
    const panel = $('#detailPanel');
    if (!panel.classList.contains('is-open') || !App.state.selKey) return;
    if (key && App.state.selKey !== key) return;
    const k = App.state.selKey;
    const isDone = App.done.has(k);
    const isTodo = App.todo.has(k);
    const btnTodo = panel.querySelector('[data-act="todo"]');
    const btnDone = panel.querySelector('[data-act="done"]');
    if (btnTodo) {
      btnTodo.classList.toggle('is-on', isTodo);
      btnTodo.textContent = isTodo ? '移出待采集' : '加入待采集';
      btnTodo.disabled = isDone && !isTodo;
      btnTodo.title = btnTodo.disabled ? '已采集的神瞳无需加入待采集' : '';
    }
    if (btnDone) { btnDone.classList.toggle('is-on', isDone); btnDone.textContent = isDone ? '取消已采集' : '标记已采集'; }
    const st = $('#detailState');
    if (st) {
      const rec = App.idx.get(k);
      const z = rec ? rec.m.z : 0;
      const depthTag = z > 0 ? `<span class="tag t-depth">水下层级 ${z}</span>` : '';
      st.innerHTML = (isDone ? '<span class="tag t-done">已采集</span>'
        : isTodo ? '<span class="tag t-todo">待采集</span>' : '<span class="tag t-none">未采集</span>') + ' ' + depthTag;
    }
  }

  function afterToggle(key) {
    saveStore();
    refreshStats();
    if (App.state.hideDone || App.state.onlyTodo) renderMarkers();
    else applyMarkerStates();
    syncDetailButtons(key);
    if (isDrawerOpen()) renderDrawer();
    if (Route.on) planRoute({ fit: false, silent: true });
  }

  /* ------------------------------------------------ 统计 */
  function refreshStats() {
    let totalOc = 0, doneOc = 0, totalSp = 0, doneSp = 0;
    Object.keys(App.markers).forEach((mid) => {
      App.markers[mid].forEach((m) => {
        const t = App.types[m.t];
        const key = mid + ':' + m.i;
        const isOc = t.kind === 'oculus';
        if (isOc) { totalOc++; if (App.done.has(key)) doneOc++; }
        else { totalSp++; if (App.done.has(key)) doneSp++; }
      });
    });
    const totalAll = totalOc + totalSp, doneAll = doneOc + doneSp;
    const pct = totalAll ? Math.round(doneAll / totalAll * 100) : 0;
    $('#globalStats').innerHTML = `
      <div class="stat"><b>${fmt(doneAll)}</b><span>已采集 / ${fmt(totalAll)}</span></div>
      <div class="divider"></div>
      <div class="stat"><b>${pct}%</b><span>总进度</span></div>
      <div class="divider"></div>
      <div class="stat"><b>${fmt(App.todo.size)}</b><span>待采集</span></div>
      <div class="divider"></div>
      <div class="stat"><b>${fmt(doneOc)}</b><span>神瞳 / ${fmt(totalOc)}</span></div>
      <div class="divider"></div>
      <div class="stat"><b>${fmt(doneSp)}</b><span>特殊收集物 / ${fmt(totalSp)}</span></div>
      <button type="button" class="stat-more" data-act="progress">进度详情</button>`;
    $('#todoCount').textContent = App.todo.size;
    $('#tabTodoCount').textContent = App.todo.size;
    $('#tabDoneCount').textContent = App.done.size;
    refreshRegionCounts();
    if (isProgressOpen()) renderProgress();
  }

  /* ------------------------------------------------ 进度总览（国度 × 类型） */
  function progressMatrix() {
    return App.regions.map((r) => {
      const per = new Map();
      let done = 0, total = 0;
      r.layers.forEach((ly) => {
        (App.markers[ly.map] || []).forEach((m) => {
          if (ly.area != null && m.a !== ly.area) return;
          const key = ly.map + ':' + m.i;
          const rec = per.get(m.t) || { done: 0, total: 0 };
          rec.total++;
          if (App.done.has(key)) { rec.done++; done++; }
          total++;
          per.set(m.t, rec);
        });
      });
      return { r, per, done, total };
    });
  }

  function isProgressOpen() {
    const w = $('#progressWrap');
    return !!w && w.getAttribute('aria-hidden') === 'false';
  }

  function openProgress() {
    renderProgress();
    $('#progressWrap').setAttribute('aria-hidden', 'false');
    closeRail();
  }

  function closeProgress() {
    const w = $('#progressWrap');
    if (w) w.setAttribute('aria-hidden', 'true');
  }

  function renderProgress() {
    const body = $('#progressBody');
    if (!body) return;
    const rows = progressMatrix();
    let ocD = 0, ocT = 0, spD = 0, spT = 0;
    rows.forEach(({ per }) => per.forEach((v, tk) => {
      const t = App.types[tk];
      if (!t) return;
      if (t.kind === 'oculus') { ocD += v.done; ocT += v.total; }
      else { spD += v.done; spT += v.total; }
    }));
    const pctStr = (d, t) => {
      if (!t) return '0%';
      const p = d / t * 100;
      return (p > 0 && p < 1) ? p.toFixed(1) + '%' : Math.round(p) + '%';
    };
    const allD = ocD + spD, allT = ocT + spT;
    const pct = allT ? Math.round(allD / allT * 100) : 0;
    let html = `<div class="pg-sum">
      <div class="pg-sum-top"><b>${fmt(allD)}</b><span>/ ${fmt(allT)} 枚收集物</span><em>${pctStr(allD, allT)}</em></div>
      <div class="pg-bar"><i style="width:${pct}%"></i></div>
      <div class="pg-sum-sub">
        <span>神瞳 <b>${fmt(ocD)}</b> / ${fmt(ocT)}</span>
        <span>特殊收集物 <b>${fmt(spD)}</b> / ${fmt(spT)}</span>
        <span>待采集 <b>${fmt(App.todo.size)}</b></span>
        <span>已采集合计 <b>${fmt(allD)}</b></span>
      </div>
    </div>`;

    rows.forEach(({ r, per, done, total }) => {
      if (!per.size) return;
      const types = Array.from(per.entries()).sort((a, b) => {
        const ka = App.types[a[0]].kind === 'oculus' ? 0 : 1;
        const kb = App.types[b[0]].kind === 'oculus' ? 0 : 1;
        if (ka !== kb) return ka - kb;
        return App.types[a[0]].name.localeCompare(App.types[b[0]].name);
      });
      html += `<section class="pg-region">
        <div class="pg-region-head" style="--c:${App.types[r.element].color}"><i></i>${r.name}<small>${r.en}</small><b>${fmt(done)}/${fmt(total)}</b></div>
        ${types.map(([tk, v]) => {
          const t = App.types[tk];
          const p = v.total ? Math.round(v.done / v.total * 100) : 0;
          return `<button type="button" class="pg-type${v.done >= v.total ? ' is-full' : ''}" data-r="${r.id}" data-t="${tk}" style="--c:${t.color}">
            <span class="pg-type-name"><i></i>${t.name}${v.total > 0 && v.done >= v.total ? '<em class="pg-done">完成</em>' : ''}</span>
            <span class="pg-type-num">${fmt(v.done)}/${fmt(v.total)} · ${p}%</span>
            <span class="pg-type-bar"><i style="width:${p}%"></i></span>
          </button>`;
        }).join('')}
      </section>`;
    });

    body.innerHTML = html + '<p class="pg-hint">点击任意类型可跳转到对应图层，并只显示该类型的标记。</p>';
    $$('.pg-type', body).forEach((b) => {
      b.addEventListener('click', () => focusTypeInRegion(b.dataset.r, b.dataset.t));
    });
  }

  function focusTypeInRegion(rid, tk) {
    const r = regionById(rid);
    if (!r) return;
    const layer = r.layers.find((ly) => ly.counts && ly.counts[tk]) || r.layers[0];
    closeProgress();
    App.state.regionId = rid;
    App.state.layerId = layer.id;
    App.state.filters = new Set([tk]);
    App.state.depthOnly = false;
    const dep = $('#depthOnly');
    if (dep) dep.checked = false;
    buildLayers();
    loadLayer();
    refreshRegionCounts();
    closeDetail();
    const first = layerMarkers(layer).find((m) => m.t === tk);
    if (first) {
      const z = Math.max(App.map.zoom, App.map.meta.baseZ + 1.2);
      App.map.focus(first.x, first.y, z, window.innerWidth > 960 ? 170 : 0);
    }
    toast(`${r.name} · 仅显示${App.types[tk].name}`);
  }

  /* ------------------------------------------------ 采集清单 */
  function isDrawerOpen() {
    return $('#drawerWrap').getAttribute('aria-hidden') === 'false';
  }

  function openDrawer(tab) {
    if (tab) App.drawerTab = tab;
    $('#drawerWrap').setAttribute('aria-hidden', 'false');
    $$('.drawer-tabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === App.drawerTab));
    renderDrawer();
  }
  function closeDrawer() { $('#drawerWrap').setAttribute('aria-hidden', 'true'); }

  function renderDrawer() {
    const set = App.drawerTab === 'todo' ? App.todo : App.done;
    const body = $('#drawerBody');
    if (!set.size) {
      body.innerHTML = `<div class="drawer-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 6h16M4 12h10M4 18h7"/></svg>
        ${App.drawerTab === 'todo' ? '还没有待采集的神瞳。<br>在地图上点击神瞳，选择「加入待采集」即可建立清单。' : '还没有已采集记录。<br>在地图上点击神瞳，选择「标记已采集」开始记录进度。'}
      </div>`;
      return;
    }
    // 按区域分组
    const groups = new Map();
    set.forEach((key) => {
      const rec = App.idx.get(key);
      if (!rec) return;
      const rid = regionOf(rec.mapId, rec.m);
      if (!groups.has(rid)) groups.set(rid, []);
      groups.get(rid).push(rec);
    });
    let html = '';
    App.regions.forEach((r) => {
      const list = groups.get(r.id);
      if (!list) return;
      const color = App.types[r.element].color;
      html += `<div class="ci-group"><div class="ci-group-head" style="--c:${color}"><i></i>${r.name}<b>${list.length}</b></div>`;
      list.sort((a, b) => (a.m.t === b.m.t ? a.m.n - b.m.n : a.m.t.localeCompare(b.m.t)));
      list.forEach((rec) => {
        const key = rec.mapId + ':' + rec.m.i;
        const t = App.types[rec.m.t];
        const layer = layerOf(rec.mapId, rec.m);
        html += `<div class="ci-item" data-key="${key}">
          <div class="ci-icon" style="--c:${t.color};--c-soft:${hexToRgba(t.color, 0.13)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[t.key] || ''}</svg>
          </div>
          <div class="ci-main">
            <div class="ci-name">${t.name}${rec.m.v ? ' ' + rec.m.v : ''}<span class="num">#${rec.m.n}</span></div>
            <div class="ci-sub">${r.name} · ${layer.name} · 坐标 ${Math.round(rec.m.x)}, ${Math.round(rec.m.y)}</div>
          </div>
          <div class="ci-acts">
            <button type="button" data-a="go" aria-label="在地图上定位">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2" stroke-linecap="round"/></svg>
            </button>
            <button type="button" data-a="del" class="is-danger" aria-label="移除">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.2 4.6h9.6M6.4 4.6V3.2h3.2v1.4M5 4.6l.6 8.2h4.8l.6-8.2"/></svg>
            </button>
          </div>
        </div>`;
      });
      html += '</div>';
    });
    body.innerHTML = html;
    body.querySelectorAll('.ci-item').forEach((item) => {
      item.querySelector('[data-a="go"]').addEventListener('click', () => {
        closeDrawer();
        goTo(item.dataset.key);
      });
      item.querySelector('[data-a="del"]').addEventListener('click', () => {
        const key = item.dataset.key;
        const wasDone = App.done.has(key);
        const wasTodo = App.todo.has(key);
        const fromTodo = App.drawerTab === 'todo';
        if (fromTodo) App.todo.delete(key); else App.done.delete(key);
        afterToggle(key);
        undoToast(fromTodo ? '已移出待采集' : '已取消采集标记',
          () => { setKeyState(key, wasDone, wasTodo); afterToggle(key); });
      });
    });
  }

  function goTo(key) {
    const rec = App.idx.get(key);
    if (!rec) return;
    const rid = regionOf(rec.mapId, rec.m);
    const layer = layerOf(rec.mapId, rec.m);
    const changed = App.state.regionId !== rid || App.state.layerId !== layer.id;
    if (changed) {
      App.state.regionId = rid;
      App.state.layerId = layer.id;
      resetFilters();
      buildLayers();
      loadLayer();
      refreshRegionCounts();
    }
    const z = Math.max(App.map.zoom, App.map.meta.baseZ + 1.3);
    const off = window.innerWidth > 960 ? 170 : 0;
    App.map.focus(rec.m.x, rec.m.y, z, off);
    setTimeout(() => selectMarker(rec.mapId, rec.m), changed ? 520 : 60);
  }

  /* ------------------------------------------------ 编号搜索 */
  let searchItems = [];
  let searchCursor = -1;

  function typeCandidates(prefix) {
    const low = prefix.toLowerCase();
    const keys = new Set();
    Object.values(App.types).forEach((t) => {
      const short = t.name.replace(/神瞳|收集物|玉髓|晶石|团块|翼滴|键纹/g, '');
      if (t.name.startsWith(prefix) || t.name.includes(prefix) || t.key.startsWith(low) || short === prefix) keys.add(t.key);
    });
    return keys;
  }

  function searchMarkers(raw) {
    const q = String(raw || '').trim().replace(/\s+/g, '');
    if (!q) return { items: [], total: 0, tip: '输入类型 + 编号，例如「岩12」「水5」「12」' };
    const m = q.match(/^([^\d]{0,10})(\d{1,4})$/);
    if (!m) return { items: [], total: 0, tip: '格式：类型 + 编号，例如 岩12 / 草25 / 12' };
    const prefix = m[1].replace(/[#＃·\-_]/g, '');
    const num = Number(m[2]);
    let typeKeys = null;
    if (prefix) {
      const set = typeCandidates(prefix);
      if (!set.size) return { items: [], total: 0, tip: `没有「${prefix}」这个类型` };
      typeKeys = set;
    }
    const cur = App.state.regionId;
    const out = [];
    for (const rec of App.flat) {
      if (rec.m.n !== num) continue;
      if (typeKeys && !typeKeys.has(rec.m.t)) continue;
      out.push(rec);
    }
    out.sort((a, b) => {
      const ra = regionOf(a.mapId, a.m) === cur ? 0 : 1;
      const rb = regionOf(b.mapId, b.m) === cur ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const ka = App.types[a.m.t].kind === 'oculus' ? 0 : 1;
      const kb = App.types[b.m.t].kind === 'oculus' ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return App.types[a.m.t].name.localeCompare(App.types[b.m.t].name);
    });
    return {
      items: out.slice(0, 30),
      total: out.length,
      tip: out.length ? '' : `没有找到编号 ${num}${prefix ? ' 的' + prefix : ''}`,
    };
  }

  function renderSearch() {
    const box = $('#searchResults');
    const input = $('#searchInput');
    const res = searchMarkers(input.value);
    searchItems = res.items;
    searchCursor = -1;
    if (!input.value.trim()) { box.hidden = true; box.innerHTML = ''; return; }
    if (!res.items.length) {
      box.innerHTML = `<div class="sr-empty">${res.tip || '没有匹配结果'}</div>`;
      box.hidden = false;
      return;
    }
    let html = `<div class="sr-tip">共 ${res.total} 个结果${res.total > res.items.length ? `（显示前 ${res.items.length} 个）` : ''}</div>`;
    res.items.forEach((rec, i) => {
      const t = App.types[rec.m.t];
      const region = regionById(regionOf(rec.mapId, rec.m));
      const layer = layerOf(rec.mapId, rec.m);
      const done = App.done.has(rec.key);
      html += `<button type="button" class="sr-item" data-i="${i}">
        <span class="sr-icon" style="--c:${t.color};--c-soft:${hexToRgba(t.color, 0.13)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[t.key] || ''}</svg>
        </span>
        <span>
          <span class="sr-name">${t.name}${rec.m.v ? ' ' + rec.m.v : ''}<span class="num">#${rec.m.n}</span>${done ? '<span class="done">已采集</span>' : ''}</span>
          <span class="sr-sub">${region.name} · ${layer.name}</span>
        </span>
      </button>`;
    });
    box.innerHTML = html;
    box.hidden = false;
    box.querySelectorAll('.sr-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', () => pickSearch(Number(el.dataset.i)));
    });
  }

  function pickSearch(i) {
    const rec = searchItems[i];
    if (!rec) return;
    closeSearch();
    goTo(rec.key);
  }

  function closeSearch() {
    const box = $('#searchResults');
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
    searchItems = [];
    searchCursor = -1;
    $('#search').classList.remove('is-open');
  }

  function initSearch() {
    const input = $('#searchInput');
    const wrap = $('#search');
    const box = $('#searchResults');
    if (!input) return;
    let timer = 0;
    input.addEventListener('input', () => {
      wrap.classList.toggle('has-value', !!input.value);
      clearTimeout(timer);
      timer = setTimeout(renderSearch, 90);
    });
    input.addEventListener('focus', () => { if (input.value.trim()) renderSearch(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); input.blur(); return; }
      if (!searchItems.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        searchCursor += e.key === 'ArrowDown' ? 1 : -1;
        if (searchCursor < 0) searchCursor = searchItems.length - 1;
        if (searchCursor >= searchItems.length) searchCursor = 0;
        const nodes = box.querySelectorAll('.sr-item');
        nodes.forEach((el, i) => el.classList.toggle('is-cursor', i === searchCursor));
        if (nodes[searchCursor]) nodes[searchCursor].scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        pickSearch(searchCursor >= 0 ? searchCursor : 0);
      }
    });
    $('#searchClear').addEventListener('click', () => {
      input.value = '';
      wrap.classList.remove('has-value');
      closeSearch();
      input.focus();
    });
    $('#searchToggle').addEventListener('click', () => {
      wrap.classList.add('is-open');
      setTimeout(() => input.focus(), 30);
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) closeSearch();
    });
  }

  /* ------------------------------------------------ 主题（深色 / 浅色） */
  const THEME_KEY = 'gel.theme';

  function applyTheme(t) {
    const dark = t === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0e181b' : '#164a51');
    const btn = $('#btnTheme');
    if (btn) {
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      btn.setAttribute('aria-label', dark ? '切换为浅色模式' : '切换为深色模式');
    }
  }

  function initTheme() {
    let t = store.get(THEME_KEY, null);
    if (!t) {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    applyTheme(t);
    const btn = $('#btnTheme');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      store.set(THEME_KEY, next);
      applyTheme(next);
      toast(next === 'dark' ? '已切换为深色模式' : '已切换为浅色模式');
    });
    // 系统主题变化时跟随（用户未手动指定过才跟随）
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (e) => { if (!store.get(THEME_KEY, null)) applyTheme(e.matches ? 'dark' : 'light'); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
  }

  /* ------------------------------------------------ PWA */
  function initPWA() {
    if ('serviceWorker' in navigator) {
      const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      if (secure) {
        window.addEventListener('load', () => {
          /* updateViaCache:'none' —— 让浏览器绕过 HTTP 缓存直接校验 sw.js，
             这样即使宿主给的 cache-control 不理想（Vercel 上 sw.js 实测是
             max-age=1800），Service Worker 的更新也不会被拖半小时 */
          navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
        });
      }
    }
    let deferred = null;
    const btn = $('#btnInstallRail');
    if (!btn) return;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      btn.hidden = false;
    });
    btn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch (err) { /* ignore */ }
      deferred = null;
      btn.hidden = true;
    });
    window.addEventListener('appinstalled', () => { btn.hidden = true; toast('已安装到桌面'); });
  }

  /* ------------------------------------------------ 导出 / 导入 */
  function exportData() {
    const payload = {
      app: 'gel',
      version: 1,
      exportedAt: new Date().toISOString(),
      done: Array.from(App.done),
      todo: Array.from(App.todo),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `神瞳图鉴-进度-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('已导出进度文件');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(String(reader.result));
        let n = 0;
        (d.done || []).forEach((k) => { if (App.idx.has(k)) { App.done.add(k); n++; } });
        (d.todo || []).forEach((k) => { if (App.idx.has(k)) { App.todo.add(k); n++; } });
        saveStore();
        refreshStats(); applyMarkerStates(); renderDrawer();
        toast(`已合并 ${n} 条记录`);
      } catch (e) {
        toast('文件解析失败');
      }
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------ 截图灯箱 */
  const LB = { s: 1, x: 0, y: 0, drag: null, moved: 0 };

  function hiResShot(url) {
    return String(url).replace('resize,w_900', 'resize,w_1800').replace('quality,q_82', 'quality,q_88');
  }

  function lbApply() {
    const img = $('#lightboxImg');
    if (!img) return;
    img.style.transform = `translate3d(${LB.x}px,${LB.y}px,0) scale(${LB.s})`;
    img.classList.toggle('is-zoomed', LB.s > 1.01);
  }

  function lbReset() {
    const img = $('#lightboxImg');
    LB.s = 1; LB.x = 0; LB.y = 0; LB.moved = 0; LB.drag = null;
    if (img) img.style.transformOrigin = '50% 50%';
    lbApply();
  }

  function isLightboxOpen() {
    const lb = $('#lightbox');
    return !!lb && lb.getAttribute('aria-hidden') === 'false';
  }

  function openLightbox(src, caption) {
    const lb = $('#lightbox');
    if (!lb || !src) return;
    const img = $('#lightboxImg');
    const loading = $('#lightboxLoading');
    lbReset();
    img.classList.remove('is-loaded');
    loading.classList.remove('is-off');
    loading.innerHTML = '<span></span>加载高清截图…';
    img.addEventListener('load', function onL() {
      lbFit();
      img.classList.add('is-loaded');
      loading.classList.add('is-off');
      img.removeEventListener('load', onL);
    });
    img.addEventListener('error', function onE() {
      loading.innerHTML = '高清截图加载失败，请检查网络';
      img.removeEventListener('error', onE);
    });
    img.src = hiResShot(src);
    if (img.complete && img.naturalWidth > 0) {
      lbFit();
      img.classList.add('is-loaded');
      loading.classList.add('is-off');
    }
    $('#lightboxCap').textContent = caption || '';
    lb.classList.add('is-open');
    lb.setAttribute('aria-hidden', 'false');
  }

  /* 源图偏小时，按视口放大显示（上限 2.2 倍，避免过度模糊） */
  function lbFit() {
    const img = $('#lightboxImg');
    if (!img || !img.naturalWidth) return;
    const k = Math.min(2.2,
      (window.innerWidth * 0.94) / img.naturalWidth,
      (window.innerHeight * 0.84) / img.naturalHeight);
    if (k > 1.05) {
      img.style.width = Math.round(img.naturalWidth * k) + 'px';
      img.style.height = Math.round(img.naturalHeight * k) + 'px';
    } else {
      img.style.width = '';
      img.style.height = '';
    }
  }

  function closeLightbox() {
    const lb = $('#lightbox');
    if (!lb) return;
    lb.classList.remove('is-open');
    lb.setAttribute('aria-hidden', 'true');
    lbReset();
    const img = $('#lightboxImg');
    if (img) { img.style.width = ''; img.style.height = ''; }
  }

  function initLightbox() {
    const lb = $('#lightbox');
    if (!lb) return;
    const img = $('#lightboxImg');
    const stage = $('#lightboxStage');

    img.addEventListener('dblclick', (e) => e.preventDefault());

    // 点击图片：在 1x 与原尺寸×2.2 之间切换（以点击点为缩放中心）
    img.addEventListener('click', (e) => {
      if (LB.moved > 8) return;
      if (LB.s > 1.01) { lbReset(); return; }
      const r = img.getBoundingClientRect();
      const ox = ((e.clientX - r.left) / r.width) * 100;
      const oy = ((e.clientY - r.top) / r.height) * 100;
      img.style.transformOrigin = `${clamp(ox, 0, 100)}% ${clamp(oy, 0, 100)}%`;
      LB.s = 2.2;
      lbApply();
    });

    // 放大后拖动查看
    img.addEventListener('pointerdown', (e) => {
      if (LB.s <= 1.01) return;
      LB.drag = { x: e.clientX, y: e.clientY, ox: LB.x, oy: LB.y };
      LB.moved = 0;
      img.classList.add('is-dragging');
      try { img.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    const endDrag = () => {
      if (!LB.drag) return;
      LB.drag = null;
      img.classList.remove('is-dragging');
      setTimeout(() => { LB.moved = 0; }, 0);
    };
    window.addEventListener('pointermove', (e) => {
      if (!LB.drag) return;
      const dx = e.clientX - LB.drag.x;
      const dy = e.clientY - LB.drag.y;
      LB.moved = Math.max(LB.moved, Math.abs(dx) + Math.abs(dy));
      LB.x = LB.drag.ox + dx;
      LB.y = LB.drag.oy + dy;
      lbApply();
    });
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => { if (isLightboxOpen()) lbFit(); });

    // 滚轮缩放
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const next = clamp(LB.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 1, 5);
      LB.s = next;
      if (next === 1) { LB.x = 0; LB.y = 0; }
      lbApply();
    }, { passive: false });
  }

  /* ------------------------------------------------ 图例 */
  function buildLegend() {
    const oculus = Object.values(App.types).filter((t) => t.kind === 'oculus');
    const special = Object.values(App.types).filter((t) => t.kind === 'special');
    const row = (t) => `<div class="legend-row" style="--c:${t.color};--c-soft:${hexToRgba(t.color, 0.13)}">
        <span class="swatch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[t.key] || ''}</svg></span>
        <span>${t.name}</span><b>${t.total}</b></div>`;
    $('#legendBody').innerHTML = `
      <section>
        <h3>神瞳 · 八大国度</h3>
        <div class="legend-grid">${oculus.map(row).join('')}</div>
      </section>
      <section>
        <h3>区域特殊收集物</h3>
        <div class="legend-grid">${special.map(row).join('')}</div>
      </section>
      <section>
        <h3>标记状态</h3>
        <div class="legend-grid">
          <div class="legend-row"><span class="swatch" style="--c:#4ec9a8;--c-soft:rgba(78,201,168,.13)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg></span><span>未采集</span></div>
          <div class="legend-row"><span class="swatch" style="--c:#b3894c;--c-soft:rgba(179,137,76,.13)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg></span><span>待采集</span></div>
          <div class="legend-row"><span class="swatch" style="--c:#8a9a96;--c-soft:rgba(138,154,150,.13)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg></span><span>已采集（置灰）</span></div>
        </div>
      </section>
      <section>
        <h3>说明</h3>
        <p class="legend-note">
          · 地图与点位数据来自米游社《原神》官方互动地图，覆盖提瓦特八大国度与全部独立层级地图。<br>
          · 已采集状态仅保存在本机浏览器（localStorage），可通过「导出进度」备份。<br>
          · 缩放层级较高时会加载官方高清瓦片；网络不佳时自动回退为本地清晰度。<br>
          · 本工具为非官方玩家工具，与米哈游无关。
        </p>
      </section>`;
  }

  /* ------------------------------------------------ 地图初始化 */
  function initMap() {
    App.map = new AtlasMap({
      viewport: $('#mapViewport'),
      world: $('#mapWorld'),
      baseLayer: $('#tileBase'),
      detailLayer: $('#tileDetail'),
      markerLayer: $('#mapMarkers'),
      onReady: () => $('#mapLoading').classList.add('is-off'),
      onSelect: (poly) => onMapSelect(poly),
    });
    App.map.onFrame = routeFrame;
    const hudRoute = $('#hudRoute');
    if (hudRoute) {
      hudRoute.addEventListener('click', (e) => {
        const b = e.target.closest && e.target.closest('[data-act="route-split"]');
        if (!b) return;
        e.stopPropagation();
        toggleRouteSplit();
      });
    }
    $$('.map-tools button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'zoom-in') App.map.zoomBy(0.6);
        else if (act === 'zoom-out') App.map.zoomBy(-0.6);
        else if (act === 'route') toggleRoute();
        else if (act === 'select-rect') setSelectMode('rect');
        else if (act === 'select-brush') setSelectMode('brush');
        else App.map.fitBounds(fitBoundsOf(currentLayer()), true);
      });
    });
  }

  /* ------------------------------------------------ 交互绑定 */
  function bindUI() {
    /* 多选操作条 */
    const selBar = $('#selBar');
    if (selBar) {
      selBar.addEventListener('click', (e) => {
        const b = e.target.closest && e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'sel-done') bulkSetDone(b.dataset.selstate !== 'undo');
        else if (act === 'sel-todo') bulkTodo(b.dataset.selstate !== 'remove');
        else if (act === 'sel-clear') clearMulti();
        else if (act === 'sel-exit') { clearMulti(); setSelectMode(null); }
      });
    }
    $('#btnCollection').addEventListener('click', () => openDrawer('todo'));
    const openLegend = () => {
      $('#legendWrap').setAttribute('aria-hidden', 'false');
      closeRail();
    };
    $('#btnLegend').addEventListener('click', openLegend);
    const legendRail = $('#btnLegendRail');
    if (legendRail) legendRail.addEventListener('click', openLegend);
    const btnProgress = $('#btnProgress');
    if (btnProgress) btnProgress.addEventListener('click', openProgress);
    const statsBox = $('#globalStats');
    if (statsBox) {
      statsBox.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="progress"]')) openProgress();
      });
    }
    const legendBox = $('#mapLegend');
    if (legendBox) {
      legendBox.addEventListener('click', (e) => {
        if (e.target.closest('.legend-toggle')) toggleLegend();
      });
    }
    initTheme();
    $$('[data-close]').forEach((el) => {
      el.addEventListener('click', () => {
        const which = el.dataset.close;
        if (which === 'drawer') closeDrawer();
        else if (which === 'lightbox') closeLightbox();
        else if (which === 'progress') closeProgress();
        else if (which === 'guideExtra') closeGuideExtra();
        else $('#legendWrap').setAttribute('aria-hidden', 'true');
      });
    });
    $$('.drawer-tabs button').forEach((b) => {
      b.addEventListener('click', () => {
        App.drawerTab = b.dataset.tab;
        $$('.drawer-tabs button').forEach((x) => x.classList.toggle('is-active', x === b));
        renderDrawer();
      });
    });
    $('#hideDone').addEventListener('change', (e) => {
      App.state.hideDone = e.target.checked;
      renderMarkers();
      if (Route.on) planRoute({ fit: false, silent: true });
    });
    $('#onlyTodo').addEventListener('change', (e) => {
      App.state.onlyTodo = e.target.checked;
      renderMarkers();
      if (Route.on) planRoute({ fit: false, silent: true });
    });
    $('#depthOnly').addEventListener('change', (e) => {
      App.state.depthOnly = e.target.checked;
      renderMarkers();
      if (Route.on) planRoute({ fit: false, silent: true });
    });
    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = '';
    });
    $('#btnClear').addEventListener('click', () => {
      const fromTodo = App.drawerTab === 'todo';
      const label = fromTodo ? '待采集' : '已采集';
      const set = fromTodo ? App.todo : App.done;
      if (!set.size) { toast(`「${label}」已经是空的`); return; }
      if (!confirm(`确定要清空全部「${label}」记录吗？5 秒内可以撤销。`)) return;
      const snapshot = new Set(set);
      if (fromTodo) App.todo = new Set(); else App.done = new Set();
      afterToggle(null);
      undoToast(`已清空${label}（${snapshot.size} 项）`, () => {
        if (fromTodo) App.todo = snapshot; else App.done = snapshot;
        afterToggle(null);
        toast('已恢复');
      }, 6000);
    });

    // 移动端抽屉
    const rail = $('#rail');
    const railScrim = document.createElement('div');
    railScrim.className = 'rail-scrim';
    document.body.appendChild(railScrim);
    const toggleRail = () => {
      const on = !rail.classList.contains('is-open');
      rail.classList.toggle('is-open', on);
      railScrim.classList.toggle('is-on', on);
    };
    $('#btnRail').addEventListener('click', toggleRail);
    railScrim.addEventListener('click', () => {
      rail.classList.remove('is-open');
      railScrim.classList.remove('is-on');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (isLightboxOpen()) closeLightbox();
        else if (isDrawerOpen()) closeDrawer();
        else if (window.__GEL_UP && window.__GEL_UP.isChangelogOpen()) window.__GEL_UP.closeChangelog();
        else if (isProgressOpen()) closeProgress();
        else if (isGuideExtraOpen()) closeGuideExtra();
        else if ($('#legendWrap').getAttribute('aria-hidden') === 'false') $('#legendWrap').setAttribute('aria-hidden', 'true');
        else if (rail.classList.contains('is-open')) { rail.classList.remove('is-open'); railScrim.classList.remove('is-on'); }
        else if (App.selectMode || App.multi.size) { clearMulti(); setSelectMode(null); }
        else closeDetail();
      }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && isDetailOpen() && !isLightboxOpen()) {
        e.preventDefault();
        navDetail(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (e.key === '+' || e.key === '=') App.map.zoomBy(0.5);
      if (e.key === '-') App.map.zoomBy(-0.5);
      if (e.key === '0') App.map.fitBounds(fitBoundsOf(currentLayer()), true);
      if (e.key === 'r' || e.key === 'R') toggleRoute();
      if (e.key === '/') { e.preventDefault(); $('#search').classList.add('is-open'); $('#searchInput').focus(); }
    });
  }

  function closeRail() {
    if (window.innerWidth > 960) return;
    $('#rail').classList.remove('is-open');
    const s = document.querySelector('.rail-scrim');
    if (s) s.classList.remove('is-on');
  }

  /* ------------------------------------------------ 云服务：账号与进度 */
  const CloudUI = { user: null, name: '', status: 'off', error: '', syncing: false, lastSync: 0 };
  let cloudPushTimer = 0;

  function timeAgo(ts) {
    if (!ts) return '刚刚';
    const d = Date.now() - ts;
    if (d < 60 * 1000) return '刚刚';
    if (d < 60 * 60 * 1000) return Math.floor(d / 60000) + ' 分钟前';
    const t = new Date(ts);
    return ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
  }

  function acctMsg(text, kind) {
    const el = $('#acctMsg');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
    el.className = 'acct-msg' + (kind ? ' is-' + kind : '');
  }

  function renderAccount() {
    const badge = $('#acctBadge');
    if (!badge) return;
    const signed = !!CloudUI.user;
    const guest = $('#acctGuest');
    const box = $('#acctUserBox');
    if (guest) guest.hidden = signed;
    if (box) box.hidden = !signed;

    let label = '未登录';
    let cls = 'acct-badge';
    if (signed) {
      label = CloudUI.syncing ? '同步中' : (CloudUI.status === 'error' ? '待重试' : '已登录');
      cls += ' is-on';
      if (CloudUI.status === 'error') cls += ' is-err';
    } else if (CloudUI.status === 'error') {
      label = '云服务异常';
      cls += ' is-err';
    }
    badge.textContent = label;
    badge.className = cls;

    if (signed) {
      const u = $('#acctUser');
      if (u) u.textContent = CloudUI.name || '已登录';
      const st = $('#acctState');
      if (st) {
        if (CloudUI.syncing) st.textContent = '正在同步…';
        else if (CloudUI.status === 'error') st.textContent = '同步失败：' + (CloudUI.error || '请稍后重试');
        else if (CloudUI.status === 'ok') st.textContent = '已同步 · ' + timeAgo(CloudUI.lastSync);
        else st.textContent = '已登录，进度保存在本机与云端';
      }
    }
  }

  /* session 形如 { user: {...} }，统一取用户对象 */
  function acctUserObj() {
    const s = CloudUI.user;
    if (!s) return null;
    return s.user || s;
  }

  function scheduleCloudPush() {
    if (!CloudUI.user) return;
    clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(() => pushCloudProgress(), 800);
  }

  async function pushCloudProgress() {
    const C = window.GEL_CLOUD;
    if (!C || !CloudUI.user) return;
    clearTimeout(cloudPushTimer);
    CloudUI.syncing = true;
    renderAccount();
    try {
      const u = acctUserObj();
      await C.saveProgress(Array.from(App.done), Array.from(App.todo),
        (u && (u.name || u.email)) || null);
      const uid = (acctUserObj() || {}).id || null;
      if (uid && App.localOwner !== uid) {
        App.localOwner = uid;
        saveStore({ localOnly: true });
      }
      CloudUI.status = 'ok';
      CloudUI.error = '';
      CloudUI.lastSync = Date.now();
      acctMsg('');
    } catch (e) {
      CloudUI.status = 'error';
      CloudUI.error = (e && e.message) || '同步失败';
      acctMsg(CloudUI.error + '（进度已存在本机，联网后可点「立即同步」重试）', 'err');
    } finally {
      CloudUI.syncing = false;
      renderAccount();
    }
  }

  /* 登录后把本地与云端进度合并（取并集，任一侧都不丢） */
  async function syncOnSignIn() {
    const C = window.GEL_CLOUD;
    if (!C || !CloudUI.user) return;
    CloudUI.syncing = true;
    CloudUI.status = 'syncing';
    renderAccount();
    try {
      const row = await C.loadProgress();
      const cloudDone = row && Array.isArray(row.done) ? row.done : [];
      const cloudTodo = row && Array.isArray(row.todo) ? row.todo : [];
      const localCount = App.done.size + App.todo.size;
      const cloudCount = cloudDone.length + cloudTodo.length;
      const uid = (acctUserObj() || {}).id || null;
      // 本机进度属于另一个账号时不能合并，避免把别人的标记带进来
      const sameOwner = !App.localOwner || !uid || App.localOwner === uid;

      if (cloudCount && (!localCount || !sameOwner)) {
        App.done = new Set(cloudDone);
        App.todo = new Set(cloudTodo);
        Array.from(App.todo).forEach((k) => { if (App.done.has(k)) App.todo.delete(k); });
        App.localOwner = uid;
        saveStore({ localOnly: true });
        refreshStats(); applyMarkerStates(); renderDrawer();
        acctMsg('已从云端恢复 ' + (App.done.size + App.todo.size) + ' 项进度', 'ok');
      } else if (localCount && sameOwner) {
        cloudDone.forEach((k) => App.done.add(k));
        cloudTodo.forEach((k) => { if (!App.done.has(k)) App.todo.add(k); });
        Array.from(App.todo).forEach((k) => { if (App.done.has(k)) App.todo.delete(k); });
        App.localOwner = uid;
        saveStore({ localOnly: true });
        refreshStats(); applyMarkerStates(); renderDrawer();
        const gained = (App.done.size + App.todo.size) - localCount;
        if (cloudCount) acctMsg(gained > 0 ? '已合并云端进度，新增 ' + gained + ' 项' : '本地进度已与云端一致', 'ok');
      }
      await pushCloudProgress();
    } catch (e) {
      CloudUI.status = 'error';
      CloudUI.error = (e && e.message) || '读取云端进度失败';
      acctMsg(CloudUI.error, 'err');
    } finally {
      CloudUI.syncing = false;
      renderAccount();
    }
  }

  async function initCloud() {
    renderAccount();
    const C = window.GEL_CLOUD;
    if (!C || !C.enabled) {
      acctMsg('云服务暂不可用，进度仍只保存在本机', 'err');
      CloudUI.status = 'error';
      renderAccount();
      return;
    }
    try {
      const r = await C.start();
      if (r && r.error) {
        CloudUI.status = 'error';
        CloudUI.error = r.error.message || '登录未完成';
        acctMsg(CloudUI.error, 'err');
      }
      CloudUI.user = (r && r.session) || (await C.currentSession());
      CloudUI.name = C.userName();
      renderAccount();
      if (CloudUI.user) await syncOnSignIn();
    } catch (e) {
      CloudUI.status = 'error';
      CloudUI.error = (e && e.message) || '云服务不可用';
      acctMsg(CloudUI.error + '（进度仍保存在本机）', 'err');
      renderAccount();
    }
    C.onChange((event, session) => {
      const had = !!CloudUI.user;
      CloudUI.user = session || null;
      CloudUI.name = session ? C.userName() : '';
      if (!CloudUI.user) {
        CloudUI.status = 'off';
        CloudUI.lastSync = 0;
      } else if (!had) {
        CloudUI.status = 'ok';
        CloudUI.lastSync = Date.now();
      }
      renderAccount();
    });
  }

  function resetAcctForm() {
    const form = $('#acctForm');
    const showBtn = $('#btnShowLogin');
    if (form) form.hidden = true;
    if (showBtn) showBtn.hidden = false;
    ['#acctPass', '#acctRegCode', '#acctRegPass', '#acctRegName'].forEach((sel) => {
      const el = $(sel);
      if (el) el.value = '';
    });
    switchAcctTab('login');
  }

  function switchAcctTab(tab) {
    const isLogin = tab !== 'signup';
    $$('.acct-tabs button').forEach((b) => {
      b.classList.toggle('is-active', (b.dataset.atab === 'signup') !== isLogin);
    });
    const pane = isLogin ? $('#acctPaneLogin') : $('#acctPaneSignup');
    const other = isLogin ? $('#acctPaneSignup') : $('#acctPaneLogin');
    if (pane) pane.hidden = false;
    if (other) other.hidden = true;
    acctMsg('');
  }

  function bindCloudUI() {
    const showBtn = $('#btnShowLogin');
    if (!showBtn || showBtn.dataset.bound === '1') return;
    showBtn.dataset.bound = '1';
    const C = window.GEL_CLOUD;
    if (!C || !C.enabled) {
      showBtn.disabled = true;
      showBtn.textContent = '云服务暂不可用';
      return;
    }

    const form = $('#acctForm');
    const hideBtn = $('#btnHideLogin');

    /* 后端能力决定表单长相：自建账号体系没有验证码 / 微信，直接藏掉对应控件 */
    const caps = C.caps || { emailCode: true, wechat: true };
    const codeEl = $('#acctRegCode');
    const nameEl = $('#acctRegName');
    if (caps.emailCode) {
      if (nameEl) nameEl.hidden = true;
    } else {
      const sendEl = $('#btnSendCode');
      if (sendEl) sendEl.hidden = true;
      if (codeEl) {
        codeEl.hidden = true;
        codeEl.value = '';
      }
      if (nameEl) nameEl.hidden = false;
    }
    if (!caps.wechat) {
      const orEl = $('#acctOr');
      const wxEl = $('#btnWeChat');
      if (orEl) orEl.hidden = true;
      if (wxEl) wxEl.hidden = true;
    }

    showBtn.addEventListener('click', () => {
      form.hidden = false;
      showBtn.hidden = true;
      const acc = $('#railAccount');
      if (acc) acc.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const e = $('#acctEmail');
      if (e) setTimeout(() => e.focus({ preventScroll: true }), 320);
    });

    if (hideBtn) {
      hideBtn.addEventListener('click', () => {
        resetAcctForm();
        acctMsg('');
      });
    }

    $$('.acct-tabs button').forEach((b) => {
      b.addEventListener('click', () => switchAcctTab(b.dataset.atab));
    });

    /* 输入时清掉旧的错误提示 */
    ['#acctEmail', '#acctPass', '#acctRegEmail', '#acctRegCode', '#acctRegPass'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('input', () => {
        const m = $('#acctMsg');
        if (m && m.classList.contains('is-err')) acctMsg('');
      });
    });

    async function afterAuth(session, okText) {
      CloudUI.user = session || (await C.currentSession());
      CloudUI.name = C.userName();
      acctMsg('');
      resetAcctForm();
      renderAccount();
      await syncOnSignIn();
      toast(okText || '已登录，进度开始同步');
    }

    /* 邮箱 + 密码登录 */
    const loginBtn = $('#btnLoginPass');
    loginBtn.addEventListener('click', async () => {
      const email = $('#acctEmail').value.trim();
      const pass = $('#acctPass').value;
      loginBtn.disabled = true;
      acctMsg('正在登录…');
      try {
        const session = await C.signInWithPassword(email, pass);
        await afterAuth(session, '已登录，进度开始同步');
      } catch (e) {
        acctMsg((e && e.message) || '登录失败', 'err');
      } finally {
        loginBtn.disabled = false;
      }
    });

    /* 注册：验证码版（BaaS）与直填版（自建账号）共用同一个按钮 */
    const sendBtn = $('#btnSendCode');
    let cdTimer = 0;
    function startCountdown(sec) {
      let left = sec;
      sendBtn.disabled = true;
      sendBtn.textContent = left + 's';
      clearInterval(cdTimer);
      cdTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(cdTimer);
          sendBtn.disabled = false;
          sendBtn.textContent = '获取验证码';
        } else {
          sendBtn.textContent = left + 's';
        }
      }, 1000);
    }

    if (caps.emailCode && sendBtn) {
      sendBtn.addEventListener('click', async () => {
        const email = $('#acctRegEmail').value.trim();
        if (!C.isEmail(email)) {
          acctMsg('请输入正确的邮箱地址', 'err');
          return;
        }
        sendBtn.disabled = true;
        acctMsg('正在发送验证码…');
        try {
          const r = await C.sendSignupCode(email);
          acctMsg(r.isExistingUser
            ? '该邮箱已有账号：填入下面收到的验证码即可直接登录'
            : '验证码已发送，请查收邮件（含垃圾邮件箱）', 'ok');
          startCountdown(60);
          if (codeEl) codeEl.focus();
        } catch (e) {
          sendBtn.disabled = false;
          acctMsg((e && e.message) || '验证码发送失败', 'err');
        }
      });
    }

    const regBtn = $('#btnRegister');
    regBtn.addEventListener('click', async () => {
      const email = $('#acctRegEmail').value.trim();
      const pass = $('#acctRegPass').value;
      regBtn.disabled = true;
      try {
        if (caps.emailCode) {
          const code = codeEl ? codeEl.value.trim() : '';
          acctMsg('正在校验…');
          const r = await C.completeSignup(email, code, pass);
          await afterAuth(r.session, r.isExistingUser ? '已用验证码登录' : '注册成功，进度开始同步');
        } else {
          acctMsg('正在注册…');
          const session = await C.signUp(email, pass, nameEl ? nameEl.value : '');
          await afterAuth(session, '注册成功，进度开始同步');
        }
      } catch (e) {
        acctMsg((e && e.message) || '注册失败', 'err');
      } finally {
        regBtn.disabled = false;
      }
    });

    /* 微信扫码（仅 BaaS 版有） */
    const wxBtn = $('#btnWeChat');
    if (caps.wechat && wxBtn) {
      wxBtn.addEventListener('click', async () => {
        wxBtn.disabled = true;
        acctMsg('正在跳转微信授权…');
        try {
          await C.signInWithWeChat();
        } catch (e) {
          wxBtn.disabled = false;
          acctMsg((e && e.message) || '微信登录发起失败', 'err');
        }
      });
    }

    /* 已登录状态 */
    $('#btnSyncNow').addEventListener('click', () => {
      if (!CloudUI.user) return;
      pushCloudProgress();
    });

    $('#btnSignOut').addEventListener('click', async () => {
      await C.signOut();
      CloudUI.user = null;
      CloudUI.name = '';
      CloudUI.status = 'off';
      CloudUI.lastSync = 0;
      acctMsg('');
      resetAcctForm();
      renderAccount();
      toast('已退出登录，进度仍保存在本机');
    });
  }

  App.currentMapId = currentMapId;
  App.reloadMarkers = reloadMarkers;

  /* ------------------------------------------------ 启动 */
  bindUI();
  bindCloudUI();
  initLightbox();
  initSearch();
  initPWA();
  /* booted 供 index.html 的代码包看门狗判定：跑完才算是好版本。
     bootError 只在出现未捕获异常时置位（数据拉取失败不算——那可能只是网络抖动，
     不应该因此把整包代码回退掉）。 */
  boot()
    .then(() => {
      App.booted = true;
      /* 这个代码包已经证明能跑起来：撤掉看门狗的待验证标记 */
      try {
        const s = JSON.parse(localStorage.getItem('gel.code.v1') || '{}');
        if (s.pendingBoot) {
          delete s.pendingBoot;
          localStorage.setItem('gel.code.v1', JSON.stringify(s));
        }
      } catch (e) { /* 隐私模式忽略 */ }
    })
    .catch((e) => {
      App.bootError = String((e && e.message) || e);
      if (window.console) console.error('[boot]', e);
    });
})();
