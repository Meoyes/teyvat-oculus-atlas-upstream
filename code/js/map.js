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

    setMarkers(list) {
      this.markers = [];
      this.markerLayer.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const m of list) {
        m.shown = true;
        frag.appendChild(m.el);
        this.markers.push(m);
      }
      this.markerLayer.appendChild(frag);
      this._frame();
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
      this.world.style.transform = `translate3d(${tx.toFixed(2)}px,${ty.toFixed(2)}px,0) scale(${s.toFixed(5)})`;

      // 标记随缩放整体缩放（密度自适应）
      const k = clamp(0.62 + (this.zoom - this.meta.baseZ - 0.9) * 0.38, 0.62, 1);
      const kr = Math.round(k * 100) / 100;
      if (this._k !== kr) {
        this._k = kr;
        this.markerLayer.style.setProperty('--k', kr);
      }
      for (const m of this.markers) {
        const sx = (m.x - this.cx) * s + this.w / 2;
        const sy = (m.y - this.cy) * s + this.h / 2;
        if (sx < -70 || sy < -90 || sx > this.w + 70 || sy > this.h + 90) {
          if (m.shown) { m.el.style.visibility = 'hidden'; m.shown = false; }
        } else {
          if (!m.shown) { m.el.style.visibility = ''; m.shown = true; }
          m.el.style.transform = `translate3d(${(sx - 15).toFixed(1)}px,${(sy - 38).toFixed(1)}px,0)`;
        }
      }
      this._tiles();
      /* 静止 260ms 后预热视口外两圈瓦片：拖动时才不会一片空白 */
      clearTimeout(this._warmT);
      this._warmT = setTimeout(() => this._warm(), 260);
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
      // 拖拽后抑制误点击
      vp.addEventListener('click', (e) => {
        if (this._moved > 10) { e.stopPropagation(); e.preventDefault(); }
      }, true);
    }

    _down(e) {
      if (e.button !== undefined && e.button > 0) return;
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
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size >= 2 && this._pinch) {
        const [a, b] = Array.from(this._pointers.values());
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const rect = this.viewport.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - rect.left;
        const my = (a.y + b.y) / 2 - rect.top;
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
      const rect = this.viewport.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const unit = e.deltaMode === 1 ? 0.05 : 0.0016;
      const dz = clamp(-e.deltaY * unit, -0.6, 0.6);
      this.zoomAt(this.zoom + dz, px, py);
    }

    _dbl(e) {
      const rect = this.viewport.getBoundingClientRect();
      this.zoomAt(this.zoom + 0.7, e.clientX - rect.left, e.clientY - rect.top);
    }
  }

  w.AtlasMap = AtlasMap;
})(window);
