/* ============================================================
   瓦片地图引擎：拖拽 / 滚轮缩放 / 双指缩放 / 瓦片按需加载
   ============================================================ */
(function (w) {
  const { clamp } = w.GEL;
  const TILE = 256;
  const CDN = 'https://act-webstatic.hoyoverse.com/map_manage/map';

  class AtlasMap {
    constructor(opts) {
      this.viewport = opts.viewport;
      this.world = opts.world;
      this.baseLayer = opts.baseLayer;
      this.detailLayer = opts.detailLayer;
      this.markerLayer = opts.markerLayer;
      this.onSelect = opts.onSelect || function () {};
      this.onReady = opts.onReady || function () {};

      this.meta = null;
      this.markers = [];
      this.zoom = 0; this.cx = 0; this.cy = 0;
      this.w = 1; this.h = 1;
      this.baseTiles = new Map();
      this.detailTiles = new Map();
      this.cdnOk = true;
      this.cdnErr = 0;
      this.minZoom = -6; this.maxZoom = 0.9;
      this._raf = 0; this._tween = 0;
      this._drag = null;
      this._pointers = new Map();
      this._pinch = null;
      this._readyOnce = false;
      this._moved = 0;
      /* 性能：viewport 偏移缓存（resize/scroll 时刷新），手势热路径不再强制布局 */
      this._vpLeft = 0; this._vpTop = 0;
      this._markerMapId = null;   /* 当前已挂载标记所属的地图（DOM 池复用） */
      this._sr = '';              /* 上次写入 --s 的值（避免每帧 setProperty） */
      /* 框选 / 画笔选择：选区画在屏幕坐标层，位于标记之下（不遮挡标记） */
      this.selectMode = null;   // 'rect' | 'brush' | null
      this._sel = null;
      this.selSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.selSvg.setAttribute('class', 'sel-svg');
      this.selSvg.setAttribute('aria-hidden', 'true');
      if (opts.markerLayer && opts.markerLayer.parentNode === this.viewport) {
        this.viewport.insertBefore(this.selSvg, opts.markerLayer);
      } else {
        this.viewport.appendChild(this.selSvg);
      }
      this._bind();
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.viewport);
      this.resize();
    }

    /* ---------------- 基础 ---------------- */
    resize() {
      const r = this.viewport.getBoundingClientRect();
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this._vpLeft = r.left;
      this._vpTop = r.top;
      if (this.meta) {
        this._limits();
        this._clampView();
        this._frame();
      }
    }

    _limits() {
      const [cw, ch] = this.meta.content;
      const fit = Math.log2(Math.min(this.w / cw, this.h / ch));
      this.minZoom = fit - 0.35;
      this.maxZoom = Math.max(0.55, fit + 2.6);
    }

    setMap(meta) {
      const changed = !this.meta || this.meta.id !== meta.id;
      this.meta = meta;
      if (changed) {
        this._clearTiles(this.baseLayer, this.baseTiles);
        this._clearTiles(this.detailLayer, this.detailTiles);
        this._readyOnce = false;
        this.cdnOk = true; this.cdnErr = 0;
      }
      this._limits();
    }

    /* 标记 DOM 由 app.js 的池管理（构建一次、复用）：
       - recs：本层全部标记（含被筛选隐藏的）
       - layerKey：所属图层标识（⚠ 不是地图 id——蒙德/须弥地表共用地图 2）
       - frag：本层新建、尚未入 DOM 的元素碎片（可直接为空） */
    setMarkers(recs, layerKey, frag) {
      if (this._markerMapId !== layerKey) {
        this.markerLayer.innerHTML = '';
        this._markerMapId = layerKey;
      }
      if (frag && frag.childNodes.length) this.markerLayer.appendChild(frag);
      this.markers = recs;
      this._frame();
    }

    /* ---------------- 坐标换算 ---------------- */
    worldToScreen(x, y) {
      const s = Math.pow(2, this.zoom);
      return { x: (x - this.cx) * s + this.w / 2, y: (y - this.cy) * s + this.h / 2 };
    }

    screenToWorld(px, py) {
      const s = Math.pow(2, this.zoom);
      return { x: this.cx + (px - this.w / 2) / s, y: this.cy + (py - this.h / 2) / s };
    }

    /* ---------------- 框选 / 画笔 ---------------- */
    setSelectMode(mode) {
      this.selectMode = mode || null;
      this.viewport.classList.toggle('is-select', !!this.selectMode);
      if (!this.selectMode) this._clearSelect();
    }

    _selPoint(e, rect) {
      return [e.clientX - rect.left, e.clientY - rect.top];
    }

    _startSelect(e) {
      const rect = this.viewport.getBoundingClientRect();
      this._selRect = rect;
      this._sel = { mode: this.selectMode, pts: [this._selPoint(e, rect)] };
      this.viewport.classList.add('is-selecting');
      this._drawSelect();
    }

    _moveSelect(e) {
      if (!this._sel || !this._selRect) return;
      const p = this._selPoint(e, this._selRect);
      const pts = this._sel.pts;
      /* 累计位移：让 viewport 上「拖拽后抑制误点击」的逻辑一样生效，
         这样从标记上拖出去框选时不会顺手把详情打开 */
      const first = pts[0];
      if (first) this._moved = Math.abs(p[0] - first[0]) + Math.abs(p[1] - first[1]);
      if (this._sel.mode === 'rect') {
        pts[1] = p;
      } else {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 3) pts.push(p);
      }
      this._drawSelect();
    }

    _endSelect() {
      if (!this._sel) return;
      const sel = this._sel;
      this._sel = null;
      this._selRect = null;
      this.viewport.classList.remove('is-selecting');
      this._clearSelect();

      /* 收成世界坐标多边形；矩形直接用两个对角点扩成 4 点 */
      let poly;
      if (sel.mode === 'rect') {
        const [a, b] = sel.pts.length >= 2 ? [sel.pts[0], sel.pts[1]] : [sel.pts[0], sel.pts[0]];
        const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
        const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
        if (x1 - x0 < 4 && y1 - y0 < 4) return;   // 只是点了一下，不当选区
        poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([px, py]) => this.screenToWorld(px, py));
      } else {
        if (sel.pts.length < 3) return;
        poly = sel.pts.map(([px, py]) => this.screenToWorld(px, py));
      }
      if (typeof this.onSelect === 'function') this.onSelect(poly, sel.mode);
    }

    _drawSelect() {
      const sel = this._sel;
      if (!sel || !sel.pts.length) { this._clearSelect(); return; }
      const NS = 'http://www.w3.org/2000/svg';
      this.selSvg.innerHTML = '';
      if (sel.mode === 'rect') {
        const a = sel.pts[0];
        const b = sel.pts[1] || sel.pts[0];
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', Math.min(a[0], b[0]));
        r.setAttribute('y', Math.min(a[1], b[1]));
        r.setAttribute('width', Math.abs(b[0] - a[0]));
        r.setAttribute('height', Math.abs(b[1] - a[1]));
        r.setAttribute('class', 'sel-shape');
        this.selSvg.appendChild(r);
      } else {
        const d = sel.pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') + ' Z';
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', 'sel-shape');
        this.selSvg.appendChild(path);
      }
    }

    _clearSelect() {
      if (this.selSvg) this.selSvg.innerHTML = '';
    }

    /* ---------------- 视图 ---------------- */
    _clampView() {
      if (!this.meta) return;
      const s = Math.pow(2, this.zoom);
      const hw = this.w / 2 / s, hh = this.h / 2 / s;
      const [cw, ch] = this.meta.content;
      this.cx = clamp(this.cx, -hw * 0.55, cw + hw * 0.55);
      this.cy = clamp(this.cy, -hh * 0.55, ch + hh * 0.55);
    }

    setView(cx, cy, zoom, animate) {
      if (!this.meta) return;
      zoom = clamp(zoom, this.minZoom, this.maxZoom);
      if (animate) {
        this._tweenTo(cx, cy, zoom);
        return;
      }
      cancelAnimationFrame(this._tween);
      this.cx = cx; this.cy = cy; this.zoom = zoom;
      this._clampView();
      this._frame();
    }

    fitBounds(b, animate) {
      if (!this.meta) return;
      let box = b;
      if (!box) box = [0, 0, this.meta.content[0], this.meta.content[1]];
      const [x0, y0, x1, y1] = box;
      const bw = Math.max(24, x1 - x0), bh = Math.max(24, y1 - y0);
      const pad = 0.1;
      const zx = Math.log2((this.w * (1 - 2 * pad)) / bw);
      const zy = Math.log2((this.h * (1 - 2 * pad)) / bh);
      const z = clamp(Math.min(zx, zy), this.minZoom, this.maxZoom);
      this.setView((x0 + x1) / 2, (y0 + y1) / 2, z, animate);
    }

    focus(x, y, zoom, offsetX) {
      const s = Math.pow(2, zoom);
      this.setView(x + (offsetX || 0) / s, y, zoom, true);
    }

    zoomBy(dz, px, py) {
      this.zoomAt(this.zoom + dz, px, py);
    }

    zoomAt(targetZoom, px, py) {
      if (!this.meta) return;
      const z1 = clamp(targetZoom, this.minZoom, this.maxZoom);
      if (Math.abs(z1 - this.zoom) < 0.0005) return;
      if (px == null) { px = this.w / 2; py = this.h / 2; }
      const s0 = Math.pow(2, this.zoom), s1 = Math.pow(2, z1);
      const wx = this.cx + (px - this.w / 2) / s0;
      const wy = this.cy + (py - this.h / 2) / s0;
      this.zoom = z1;
      this.cx = wx - (px - this.w / 2) / s1;
      this.cy = wy - (py - this.h / 2) / s1;
      this._clampView();
      /* 连续缩放期间先不换细节层（见 _tiles），停稳 200ms 后再换 */
      this._zooming = true;
      clearTimeout(this._zoomT);
      this._zoomT = setTimeout(() => { this._zooming = false; this._schedule(); }, 200);
      this._frame();
    }

    /* 保证某点可见（避免被详情面板/图例遮挡） */
    ensureVisible(x, y, insetRight) {
      if (!this.meta) return;
      const s = Math.pow(2, this.zoom);
      const sx = (x - this.cx) * s + this.w / 2;
      const sy = (y - this.cy) * s + this.h / 2;
      const maxX = this.w - (insetRight || 0);
      let dx = 0, dy = 0;
      if (sx > maxX - 24) dx = sx - maxX + 42;
      else if (sx < 40) dx = sx - 40;
      if (sy > this.h - 70) dy = sy - this.h + 110;
      else if (sy < 110) dy = sy - 110;
      if (!dx && !dy) return;
      this.cx += dx / s;
      this.cy += dy / s;
      this._clampView();
      this._tweenTo(this.cx, this.cy, this.zoom);
    }

    _tweenTo(cx, cy, zoom) {
      cancelAnimationFrame(this._tween);
      const t0 = performance.now();
      const dur = 460;
      const from = { cx: this.cx, cy: this.cy, z: this.zoom };
      const ease = (t) => 1 - Math.pow(1 - t, 3);
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = ease(k);
        this.cx = from.cx + (cx - from.cx) * e;
        this.cy = from.cy + (cy - from.cy) * e;
        this.zoom = from.z + (zoom - from.z) * e;
        this._frame();
        if (k < 1) this._tween = requestAnimationFrame(step);
      };
      this._tween = requestAnimationFrame(step);
    }

    /* ---------------- 渲染 ---------------- */
    _frame() {
      if (!this.meta) return;
      const s = Math.pow(2, this.zoom);
      const tx = this.w / 2 - this.cx * s;
      const ty = this.h / 2 - this.cy * s;
      const tf = `translate3d(${tx.toFixed(2)}px,${ty.toFixed(2)}px,0) scale(${s.toFixed(5)})`;
      this.world.style.transform = tf;
      /* 标记层与世界共用同一变换：平移/缩放由「一次」父 transform 带动，
         不再逐标记重定位（旧实现每帧 N 次字符串拼接 + 样式写入）。
         数学对齐：标记 left/top 为世界坐标，屏幕位置 = tx + s*m.x = (m.x-cx)*s + w/2，与旧公式一致；
         图标视觉尺寸由 .mk 的 scale(1/--s) 反向抵消（见 style.css）。 */
      this.markerLayer.style.transform = tf;
      const sr = s.toFixed(5);
      if (this._sr !== sr) {
        this._sr = sr;
        this.markerLayer.style.setProperty('--s', sr);
      }

      // 标记随缩放整体缩放（密度自适应）
      const k = clamp(0.62 + (this.zoom - this.meta.baseZ - 0.9) * 0.38, 0.62, 1);
      const kr = Math.round(k * 100) / 100;
      if (this._k !== kr) {
        this._k = kr;
        this.markerLayer.style.setProperty('--k', kr);
      }

      /* 视口剔除：只切 visibility，稳态零样式写入（边界翻转才写） */
      const cx = this.cx, cy = this.cy, w = this.w, h = this.h;
      for (const m of this.markers) {
        const sx = (m.x - cx) * s + w / 2;
        const sy = (m.y - cy) * s + h / 2;
        if (sx < -70 || sy < -90 || sx > w + 70 || sy > h + 90) {
          if (m.shown) { m.el.style.visibility = 'hidden'; m.shown = false; }
        } else if (!m.shown) {
          m.el.style.visibility = '';
          m.shown = true;
        }
      }
      this._tiles();
      /* 预热视口外两圈瓦片：改在浏览器空闲时跑（旧实现每帧重建 setTimeout），
         不挤占手势帧；timeout 兜底保证持续拖动时也有机会预热 */
      if (!this._warmPending) {
        this._warmPending = true;
        const kick = () => { this._warmPending = false; this._warm(); };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(kick, { timeout: 400 });
        else setTimeout(kick, 260);
      }
      if (this.onFrame) this.onFrame();
    }

    /* 预热：只请求、不挂 DOM（响应会进 SW 缓存，真正拖过去时秒出） */
    _warm() {
      if (!this.meta) return;
      const L = this.meta.baseZ;
      const scale = Math.pow(2, L);
      const u = TILE / scale;
      const pad = this.meta.padding;
      const s = Math.pow(2, this.zoom);
      const hw = this.w / 2 / s, hh = this.h / 2 / s;
      const x0 = this.cx - hw - 2 * u, x1 = this.cx + hw + 2 * u;
      const y0 = this.cy - hh - 2 * u, y1 = this.cy + hh + 2 * u;
      const k = scale / TILE;
      const total = this.meta.total;
      let tx0 = Math.max(0, Math.floor((x0 + pad[0]) * k));
      let ty0 = Math.max(0, Math.floor((y0 + pad[1]) * k));
      let tx1 = Math.min(Math.floor(total[0] * k) - 1, Math.floor((x1 + pad[0]) * k));
      let ty1 = Math.min(Math.floor(total[1] * k) - 1, Math.floor((y1 + pad[1]) * k));
      if (tx1 < tx0 || ty1 < ty0) return;
      this._warmSet = this._warmSet || new Set();
      let budget = 48;                       // 一次最多预取 48 张，别抢当前视口的带宽
      for (let x = tx0; x <= tx1 && budget > 0; x++) {
        for (let y = ty0; y <= ty1 && budget > 0; y++) {
          const key = x + '_' + y;
          if (this.baseTiles.has(key) || this._warmSet.has(key)) continue;
          this._warmSet.add(key);
          budget -= 1;
          const img = new Image();
          img.fetchPriority = 'low';
          img.decoding = 'async';
          const done = () => this._warmSet.delete(key);
          img.onload = done;
          img.onerror = done;
          img.src = this._tileUrl(L, x, y, false);
        }
      }
    }

    /* 内容坐标 -> 屏幕坐标 */
    toScreen(x, y) {
      const s = Math.pow(2, this.zoom);
      return { x: (x - this.cx) * s + this.w / 2, y: (y - this.cy) * s + this.h / 2 };
    }

    _schedule() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._frame(); });
    }

    _tileUrl(L, tx, ty, cdn) {
      if (!cdn) return `tiles/${this.meta.id}/${L}/${tx}_${ty}.webp`;
      const zz = (L < 0 ? 'N' : 'P') + Math.abs(L);
      return `${CDN}/${this.meta.id}/${this.meta.version}/${tx}_${ty}_${zz}.webp`;
    }

    _tiles() {
      const L0 = this.meta.baseZ;
      this._renderLevel(this.baseLayer, this.baseTiles, L0, false);

      const Ld = Math.round(this.zoom);
      const wantDetail = this.cdnOk && Ld > L0 && Ld <= this.meta.cdnMaxZ && Ld >= this.meta.cdnMinZ;
      if (wantDetail) {
        /* 缩放中跨到新层级时先不换：每换一次就是整批销毁 + 重新请求，
           新图还没到，等于先把看得清的画面拆成空白。等手势停稳再换。 */
        if (this._zooming && this._detailL !== undefined && this._detailL !== Ld) return;
        this._detailL = Ld;
        this._renderLevel(this.detailLayer, this.detailTiles, Ld, true);
      } else if (this.detailTiles.size) {
        this._clearTiles(this.detailLayer, this.detailTiles);
        this._detailL = undefined;
      }
    }

    _renderLevel(layer, cache, L, cdn) {
      const scale = Math.pow(2, L);
      const u = TILE / scale;
      const pad = this.meta.padding;
      const s = Math.pow(2, this.zoom);
      const hw = this.w / 2 / s, hh = this.h / 2 / s;
      const x0 = this.cx - hw - u, x1 = this.cx + hw + u;
      const y0 = this.cy - hh - u, y1 = this.cy + hh + u;
      const k = scale / TILE;
      const total = this.meta.total;
      let tx0 = Math.floor((x0 + pad[0]) * k), tx1 = Math.floor((x1 + pad[0]) * k);
      let ty0 = Math.floor((y0 + pad[1]) * k), ty1 = Math.floor((y1 + pad[1]) * k);
      tx0 = Math.max(0, tx0); ty0 = Math.max(0, ty0);
      tx1 = Math.min(Math.floor(total[0] * k) - 1, tx1);
      ty1 = Math.min(Math.floor(total[1] * k) - 1, ty1);
      if (tx1 < tx0 || ty1 < ty0) return;

      /* 视口每次只挪 1–2px 时，需要的那批瓦片其实没变：
         直接跳过建/删 DOM 与 Set 构造。拖动时的帧开销主要省在这里。 */
      const sig = L + '|' + tx0 + ',' + ty0 + ',' + tx1 + ',' + ty1;
      if (cache._sig === sig) return;
      cache._sig = sig;

      const need = new Set();
      let added = 0;
      for (let x = tx0; x <= tx1; x++) {
        for (let y = ty0; y <= ty1; y++) {
          const key = x + '_' + y;
          need.add(key);
          if (cache.has(key)) continue;
          const img = new Image();
          img.className = 'tile';
          img.decoding = 'async';
          img.style.width = u + 'px';
          img.style.height = u + 'px';
          img.style.left = (TILE * x / scale - pad[0]) + 'px';
          img.style.top = (TILE * y / scale - pad[1]) + 'px';
          if (cdn) {
            img.onerror = () => {
              img.classList.add('is-missing');
              this._cdnFail();
            };
          } else {
            img.onerror = () => img.classList.add('is-missing');
          }
          img.src = this._tileUrl(L, x, y, cdn);
          if (!cdn && !this._readyOnce) {
            img.addEventListener('load', () => {
              if (this._readyOnce) return;
              this._readyOnce = true;
              this.onReady();
            }, { once: true });
          }
          layer.appendChild(img);
          cache.set(key, img);
          added++;
        }
      }
      for (const [key, img] of cache) {
        if (!need.has(key)) { img.remove(); cache.delete(key); }
      }
      if (added && !this._readyOnce) {
        // 保底：即便图片加载失败也解除 loading
        clearTimeout(this._readyT);
        this._readyT = setTimeout(() => {
          if (!this._readyOnce) { this._readyOnce = true; this.onReady(); }
        }, 2600);
      }
    }

    _clearTiles(layer, cache) {
      for (const img of cache.values()) img.remove();
      cache.clear();
      cache._sig = null;          // 清空后必须让下一次渲染重新计算
    }

    _cdnFail() {
      this.cdnErr++;
      if (this.cdnErr >= 4 && this.cdnOk) {
        this.cdnOk = false;
        this._clearTiles(this.detailLayer, this.detailTiles);
      }
    }

    /* ---------------- 交互 ---------------- */
    _bind() {
      const vp = this.viewport;
      // 注意：不要对视口 setPointerCapture —— 那会把随后的 click 重定向到视口，
      // 导致标记（.mk）上的点击事件永远收不到。改用 window 级 move/up 监听。
      vp.addEventListener('pointerdown', (e) => this._down(e));
      window.addEventListener('pointermove', (e) => this._move(e), { passive: true });
      window.addEventListener('pointerup', (e) => this._up(e));
      window.addEventListener('pointercancel', (e) => this._up(e));
      vp.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
      vp.addEventListener('dblclick', (e) => this._dbl(e));
      vp.addEventListener('contextmenu', (e) => e.preventDefault());
      /* 页面滚动会改变 viewport 的视口位置（尺寸不变，ResizeObserver 不触发）：
         滚动时布局是干净的，这里补一次 rect 缓存很便宜 */
      window.addEventListener('scroll', () => {
        const r = this.viewport.getBoundingClientRect();
        this._vpLeft = r.left;
        this._vpTop = r.top;
      }, { passive: true });
      // 拖拽后抑制误点击
      vp.addEventListener('click', (e) => {
        if (this._moved > 10) { e.stopPropagation(); e.preventDefault(); }
      }, true);
    }

    _down(e) {
      if (e.button !== undefined && e.button > 0) return;
      /* 选择模式：左键拖拽画选区，不平移地图（滚轮缩放照常）。
         只放过工具条/浮层这类控件（否则它们的 click 会被吃），标记本身不拦：
         从标记上拖依然能框选，单击标记也照常能打开详情（靠 _moved 抑制误点击）。 */
      if (this.selectMode) {
        const t = e.target;
        if (t && t.closest && t.closest('.map-tools, .sel-bar, .map-hud, .map-legend')) return;
        this._startSelect(e);
        return;
      }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 1) {
        this._drag = { x: e.clientX, y: e.clientY };
        this._moved = 0;
        this._tapTarget = e.target && e.target.closest ? e.target.closest('.mk') : null;
        this.viewport.classList.add('is-dragging');
        cancelAnimationFrame(this._tween);
      } else if (this._pointers.size === 2) {
        const [a, b] = Array.from(this._pointers.values());
        this._pinch = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          mx: (a.x + b.x) / 2,
          my: (a.y + b.y) / 2,
          zoom: this.zoom,
        };
        this._drag = null;
      }
    }

    _move(e) {
      if (this._sel) { this._moveSelect(e); return; }
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size >= 2 && this._pinch) {
        const [a, b] = Array.from(this._pointers.values());
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        /* 用缓存的 viewport 偏移（_vpLeft/_vpTop）：双指事件每帧都来，
           每次都 getBoundingClientRect 会强制同步布局（layout thrashing） */
        const mx = (a.x + b.x) / 2 - this._vpLeft;
        const my = (a.y + b.y) / 2 - this._vpTop;
        if (this._pinch.dist > 10) {
          const z = clamp(this._pinch.zoom + Math.log2(dist / this._pinch.dist), this.minZoom, this.maxZoom);
          this.zoomAt(z, mx, my);
        }
        return;
      }

      if (!this._drag) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      this._moved += Math.abs(dx) + Math.abs(dy);
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      const s = Math.pow(2, this.zoom);
      this.cx -= dx / s;
      this.cy -= dy / s;
      this._clampView();
      this._schedule();
    }

    _up(e) {
      if (this._sel) {
        this._endSelect();
        /* 和普通拖拽一样，等这一轮 click 派发完再清零。
           不清零的话「拖拽后抑制误点」会一直生效，之后所有点击（工具按钮、
           Ctrl 点选标记）都会被吃掉 —— 这是最难查的一个坑。 */
        setTimeout(() => { this._moved = 0; }, 0);
        return;
      }
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinch = null;
      if (this._pointers.size === 0) {
        this._drag = null;
        this._tapTarget = null;
        this.viewport.classList.remove('is-dragging');
        setTimeout(() => { this._moved = 0; }, 0);
      }
    }

    _wheel(e) {
      e.preventDefault();
      /* 缓存偏移：resize/scroll 时刷新（见 _bind），热路径不强制布局 */
      const px = e.clientX - this._vpLeft;
      const py = e.clientY - this._vpTop;
      const unit = e.deltaMode === 1 ? 0.05 : 0.0016;
      const dz = clamp(-e.deltaY * unit, -0.6, 0.6);
      this.zoomAt(this.zoom + dz, px, py);
    }

    _dbl(e) {
      this.zoomAt(this.zoom + 0.7, e.clientX - this._vpLeft, e.clientY - this._vpTop);
    }
  }

  w.AtlasMap = AtlasMap;
})(window);
