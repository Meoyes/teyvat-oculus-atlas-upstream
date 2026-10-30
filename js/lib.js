/* ============================================================
   基础工具 / 图标 / 类型文案
   ============================================================ */
(function (w) {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');

  function hexToRgba(hex, a) {
    const h = (hex || '#888').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  const store = {
    get(key, def) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
      catch (e) { return def; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); return true; }
      catch (e) { return false; }
    },
  };

  let toastTimer = 0;
  /* toast(msg) / toast(msg, { action, onAction, duration }) —— 带操作按钮时默认 5 秒 */
  function toast(msg, opts) {
    const el = $('#toast');
    if (!el) return;
    opts = opts || {};
    el.innerHTML = '<i></i><span class="toast-msg"></span>';
    el.querySelector('.toast-msg').textContent = msg;
    let dur = opts.duration || 2200;
    if (opts.action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-act';
      btn.textContent = opts.action;
      btn.addEventListener('click', () => {
        clearTimeout(toastTimer);
        el.classList.remove('is-show');
        if (typeof opts.onAction === 'function') opts.onAction();
      });
      el.appendChild(btn);
      dur = opts.duration || 5200;
    }
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-show'), dur);
  }

  /* ---------- 图标（24x24，描边风格） ---------- */
  const GLYPHS = {
    anemo: '<path d="M4.4 9.6h9.4a2.8 2.8 0 1 0-2.8-2.8"/><path d="M4.4 14.4h11.6a2.8 2.8 0 1 1-2.8 2.8"/>',
    geo: '<path d="M12 4.6 20 19.2H4Z"/><path d="M8.6 13.8h6.8" opacity=".55"/>',
    electro: '<path d="M13.6 3.2 6.4 13.8h4.6L10.4 21l7.2-10.8h-4.8Z"/>',
    dendro: '<path d="M12 20.6c-4.8-3.4-6.8-8.2-5.2-13.6 5.8 1 9.6 4.8 9.6 9.6 0 1.8-.8 3.4-2 4.4Z"/><path d="M8.4 18.4c1-4.4 3.6-7 7.4-8" opacity=".55"/>',
    hydro: '<path d="M12 3.4c3.8 4.8 5.8 7.8 5.8 10.6a5.8 5.8 0 0 1-11.6 0c0-2.8 2-5.8 5.8-10.6Z"/>',
    pyro: '<path d="M12 20.8c3.8 0 6.4-2.8 6.4-6.2 0-4.8-5.4-7.6-6.4-11.4-1 3.8-2.2 5.2-3.8 7.4-1.2 1.6-2.2 2.6-2.2 4.4 0 3.4 2.6 5.8 6 5.8Z"/>',
    lunar: '<path d="M15.8 3.6a9 9 0 1 0 0 16.8 7.4 7.4 0 0 1 0-16.8Z"/>',
    cryo: '<path d="M12 3.2v17.6M4.6 7.6l14.8 8.8M19.4 7.6 4.6 16.4"/><path d="M9.4 4.6 12 7l2.6-2.4M9.4 19.4 12 17l2.6 2.4" opacity=".6"/>',
    crimson: '<path d="M12 3.4 16.6 10 12 20.6 7.4 10Z"/><path d="M7.4 10h9.2" opacity=".5"/>',
    shadow: '<path d="M12 3.2c3.4 4.4 5.4 7.4 5.4 10.2a5.4 5.4 0 0 1-10.8 0c0-2.8 2-5.8 5.4-10.2Z"/><circle cx="12" cy="13.6" r="1.7" fill="rgba(255,255,255,.65)" stroke="none"/>',
    lumenspar: '<path d="M12 3.2 13.9 9.4 20.2 11.3 13.9 13.2 12 19.4 10.1 13.2 3.8 11.3 10.1 9.4Z"/>',
    keysigil: '<circle cx="10.2" cy="10.2" r="4.4"/><path d="M13.4 13.4 20 20M16.6 16.6l2-2M18.6 18.6l1.8-1.8"/>',
    memory: '<rect x="4.2" y="4.2" width="9" height="9" rx="1.6"/><rect x="10.8" y="10.8" width="9" height="9" rx="1.6"/>',
  };

  /* ---------- 类型说明 ---------- */
  const TYPE_DESC = {
    anemo: '蒙德地区的神瞳。收集后供奉给七天神像，可提升风神像等级，获得原石、冒险阅历与体力上限奖励。共 66 枚。',
    geo: '璃月地区的神瞳。供奉给七天神像可提升岩神像等级。部分位于层岩巨渊、沉玉谷等新增区域，多在洞窟与高塔顶部。共 131 枚。',
    electro: '稻妻地区的神瞳。部分藏在雷暴、结界与地下空间内，建议携带雷种子或完成对应的世界任务后前往。共 181 枚。',
    dendro: '须弥地区的神瞳。雨林多藏于蘑菇与树冠，沙漠多在山体洞窟与遗迹高处。共 271 枚。',
    hydro: '枫丹地区的神瞳。大量位于水下与洞窟中，需要潜水、解谜或调整水位才能获取；水下点位可在地图层级筛选中单独查看。共 271 枚（含旧日之海 46 枚）。',
    pyro: '纳塔地区的神瞳。多分布于部族聚落、悬崖与火山地貌，部分需要使用龙众能力抵达。共 271 枚（含远古圣山 22 枚）。',
    lunar: '挪德卡莱地区的神瞳（6.0 起）。供奉给月神像可提升等级，部分点位需要推进世界任务才能进入。共 271 枚（含霜月 74 枚）。',
    cryo: '至冬地区的神瞳（7.0 起）。多位于极寒地貌与影域入口附近，注意保暖与体力。共 140 枚。',
    crimson: '龙脊雪山的特殊收集物。供奉给「忍冬之树」可提升等级，是雪山区域的核心收集物。共 80 枚。',
    shadow: '至冬「影域」中诞生的奇特液体物质。用远程武器射击即可获取，带回列车交给「影域解析装置」可提升影域作战体力上限。共 58 枚。下方附米游社攻略的分区图解与编号提示。',
    lumenspar: '层岩巨渊·地下矿区的收集物，用于提升「流明石触媒」等级，可照亮矿区的黑暗区域。共 83 枚。',
    keysigil: '渊下宫的收集物，用于开启「键纹宝箱」以及推进部分解谜。分为Ⅰ—Ⅴ五种纹样。',
    memory: '空之神殿的「摹忆因子」凝聚物，供奉至「摹忆中枢」可换取来自隙间与文明记忆的祝福。共 30 枚。',
  };

  w.GEL = { $, $$, clamp, fmt, hexToRgba, store, toast, GLYPHS, TYPE_DESC };
})(window);
