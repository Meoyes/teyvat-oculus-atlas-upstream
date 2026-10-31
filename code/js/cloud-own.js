/* ============================================================
   自建后端适配层（Turso API）—— 与 cloud.js 同接口，可整体替换
   接口：enabled / start / onChange / currentSession / userName /
        signInWithPassword / signUp / sendSignupCode / completeSignup /
        signInWithWeChat / signOut / loadProgress / saveProgress /
        clearProgress / isEmail / caps
   —— 与 cloud.js 的区别：没有邮箱验证码、没有微信扫码（自建账号体系是
      邮箱 + 密码），所以 caps 里如实标 false，UI 据此隐藏对应入口。
   ============================================================ */
(function (w) {
  'use strict';

  const CFG = w.GEL_CLOUD_CONFIG || {};
  /* 同源 /api：托管在应用域名和 Cloudflare Worker 域名下都成立 */
  const BASE = (CFG.apiBase || '/api').replace(/\/+$/, '');
  const TOKEN_KEY = 'gel.cloud.token';
  const USER_KEY = 'gel.cloud.user';
  /* 12s 在跨境线路上不够：Vercel 免费档函数在美东，冷启动 + 跨境 TLS
     实测注册一次要 7s 上下（同一请求从 Node 直连只要 1.5s）。放宽到 25s，
     真正的断网仍然会超时，只是不再把「慢」误判成「失败」 */
  const TIMEOUT = 25000;

  let session = null;        // { user: { id, email, name }, token }
  let started = false;
  const listeners = [];

  function readStorage(key) {
    try { return w.localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function writeStorage(key, val) {
    try {
      if (val) w.localStorage.setItem(key, val);
      else w.localStorage.removeItem(key);
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function setSession(next, event) {
    session = next || null;
    writeStorage(TOKEN_KEY, session ? session.token : '');
    writeStorage(USER_KEY, session && session.user ? JSON.stringify(session.user) : '');
    if (event) listeners.forEach((fn) => { try { fn(event, session); } catch (e) { /* ignore */ } });
  }

  function token() {
    return session && session.token ? session.token : readStorage(TOKEN_KEY);
  }

  async function api(path, method, body, withAuth) {
    const headers = { Accept: 'application/json' };
    const t = withAuth === false ? '' : token();
    if (t) {
      headers['X-Gel-Token'] = t;
      headers.Authorization = 'Bearer ' + t;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    let res;
    try {
      res = await w.fetch(BASE + path, {
        method: method || 'GET',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? '网络超时，请稍后重试' : '网络不可用，请检查连接');
    }
    clearTimeout(timer);

    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

    if (res.status === 401) {
      if (withAuth !== false) setSession(null, 'signed_out');
      throw new Error((data && data.error === 'unauthorized') ? '登录已过期，请重新登录' : ((data && data.error) || '未登录'));
    }
    if (!res.ok) {
      throw new Error((data && data.error) || ('请求失败（' + res.status + '）'));
    }
    return data || {};
  }

  /* ---------------- 会话 ---------------- */
  async function start() {
    if (started) return { session };
    started = true;

    /* 先用本地缓存的用户信息把界面点亮，再向服务端确认 */
    const cached = readStorage(USER_KEY);
    const cachedToken = readStorage(TOKEN_KEY);
    if (cachedToken && cached) {
      try {
        const u = JSON.parse(cached);
        if (u && u.id) session = { token: cachedToken, user: u };
      } catch (e) { /* 缓存坏了就当没登录 */ }
    }
    if (!cachedToken) return { session: null };

    try {
      const r = await api('/auth/me', 'GET');
      if (r && r.user) {
        setSession({ token: cachedToken, user: r.user });
        return { session };
      }
      setSession(null, 'signed_out');
      return { session: null };
    } catch (e) {
      /* 过期就清掉；纯网络问题保留本地会话，别把人踢下线 */
      if (/过期|未登录/.test(e.message || '')) {
        setSession(null, 'signed_out');
        return { session: null };
      }
      return { session };
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function currentSession() {
    return session;
  }

  function userName() {
    const u = session && session.user;
    if (!u) return '';
    return u.name || u.email || ('账号 ' + String(u.id).slice(0, 6) + '…');
  }

  function isEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
  }

  /* ---------------- 登录 / 注册 ---------------- */
  async function signInWithPassword(email, pass) {
    if (!isEmail(email)) throw new Error('请输入正确的邮箱地址');
    if (!pass) throw new Error('请输入密码');
    const r = await api('/auth/login', 'POST', { email: String(email).trim().toLowerCase(), password: pass }, false);
    setSession({ token: r.token, user: r.user }, 'signed_in');
    return session;
  }

  async function signUp(email, pass, name) {
    if (!isEmail(email)) throw new Error('请输入正确的邮箱地址');
    if (!pass || String(pass).length < 6) throw new Error('密码至少 6 位');
    const r = await api('/auth/register', 'POST', {
      email: String(email).trim().toLowerCase(),
      password: pass,
      name: (name || '').trim() || null,
    }, false);
    setSession({ token: r.token, user: r.user }, 'signed_in');
    return session;
  }

  /* 自建账号体系没有验证码 / 微信扫码，UI 靠 caps 提前隐藏入口 */
  async function sendSignupCode() {
    throw new Error('当前账号体系不需要邮箱验证码');
  }
  async function completeSignup() {
    throw new Error('当前账号体系不需要邮箱验证码');
  }
  async function signInWithWeChat() {
    throw new Error('当前版本未提供微信登录，请用邮箱注册');
  }

  async function signOut() {
    setSession(null, 'signed_out');
  }

  /* ---------------- 进度数据 ---------------- */
  async function loadProgress() {
    const d = await api('/progress', 'GET');
    if (!d || !d.exists) return null;
    return {
      done: Array.isArray(d.done) ? d.done : [],
      todo: Array.isArray(d.todo) ? d.todo : [],
      owner_name: d.owner_name || null,
      updated_at: d.updated_at || null,
    };
  }

  async function saveProgress(done, todo, ownerName) {
    const d = await api('/progress', 'PUT', {
      done: Array.isArray(done) ? done : [],
      todo: Array.isArray(todo) ? todo : [],
      owner_name: ownerName || null,
    });
    return { updatedAt: d.updated_at || null };
  }

  async function clearProgress() {
    await api('/progress', 'DELETE');
  }

  /* 一轮只传变动的几个键（整包二十几 KB，增量几十字节） */
  async function patchProgress(change, ownerName) {
    const d = await api('/progress/patch', 'POST', {
      done: (change && change.done) || {},
      todo: (change && change.todo) || {},
      owner_name: ownerName || null,
    });
    return { updatedAt: d.updated_at || null, done: d.done, todo: d.todo };
  }

  w.GEL_CLOUD = {
    enabled: Boolean(BASE),
    caps: { emailCode: false, wechat: false },
    start,
    onChange,
    currentSession,
    userName,
    isEmail,
    signInWithPassword,
    signUp,
    sendSignupCode,
    completeSignup,
    signInWithWeChat,
    signOut,
    loadProgress,
    saveProgress,
    patchProgress,
    clearProgress,
  };
})(window);
