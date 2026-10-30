/* ============================================================
   云服务接入层：账号（邮箱密码 / 邮箱验证码注册 / 微信扫码）+ 采集进度同步
   —— 依赖 SDK 全局 WorkBuddyCloud（CDN 形式，无构建步骤）
   ============================================================ */
(function (w) {
  const CFG = w.GEL_CLOUD_CONFIG || {};
  const TABLE = 'gel_progress';

  let cloud = null;
  let pendingSignup = null;
  let lastSession = null;

  function sdk() {
    const g = w.WorkBuddyCloud;
    if (!g || typeof g.createWorkBuddyCloud !== 'function') {
      throw new Error('云服务组件未加载，请检查网络后刷新');
    }
    return g;
  }

  function client() {
    if (cloud) return cloud;
    const g = sdk();
    cloud = g.createWorkBuddyCloud({
      endpoint: CFG.endpoint,
      oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
      publishableKey: CFG.publishableKey,
    });
    return cloud;
  }

  function failMessage(err, fallback) {
    if (!err) return fallback;
    const m = err.message || err.error_description || err.code || String(err);
    return m || fallback;
  }

  /* ---------------- 启动：处理 OAuth 回调 / 恢复会话 ---------------- */
  async function start() {
    const c = client();
    const url = new URL(w.location.href);
    const hasCallback = url.searchParams.has('code') || url.searchParams.has('error');

    if (hasCallback) {
      const provider = url.searchParams.get('provider');
      if (provider !== 'workbuddy' && provider !== 'wechat') {
        return { error: { message: '授权回调缺少有效的登录方式，请重新登录。' } };
      }
      const handler = provider === 'workbuddy'
        ? c.auth.handleWorkBuddyCallback
        : c.auth.handleWechatWebCallback;
      if (typeof handler !== 'function') {
        return { error: { message: '当前云服务组件不支持该登录方式，请刷新页面重试。' } };
      }
      const res = await handler.call(c.auth);
      if (res && res.error) return { error: res.error };
      // 清掉一次性回调参数，保留 sharecode 等业务参数
      for (const k of ['code', 'state', 'provider']) url.searchParams.delete(k);
      w.history.replaceState(null, '', url.pathname + url.search + url.hash);
      lastSession = res && res.data ? res.data : await currentSession();
      return { session: lastSession };
    }

    lastSession = await currentSession();
    return { session: lastSession };
  }

  async function currentSession() {
    try {
      const { data, error } = await client().auth.getSession();
      if (error) return null;
      lastSession = data || null;
      return lastSession;
    } catch (e) {
      return null;
    }
  }

  function onChange(cb) {
    try {
      client().auth.onAuthStateChange((event, session) => {
        lastSession = session || null;
        cb(event, lastSession, null);
      });
    } catch (e) { /* 忽略：SDK 未加载时不影响主流程 */ }
  }

  /* ---------------- 登录 ---------------- */
  function isEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
  }

  /* 邮箱 + 密码登录（已有账号） */
  async function signInWithPassword(email, password) {
    const addr = String(email || '').trim();
    const pwd = String(password || '');
    if (!isEmail(addr)) throw new Error('请输入正确的邮箱地址');
    if (pwd.length < 6) throw new Error('密码至少 6 位');
    const { data, error } = await client().auth.signInWithPassword({ email: addr, password: pwd });
    if (error) {
      // 不区分「账号不存在 / 密码错误」，也不把服务端英文原文抛给用户
      const network = error.kind === 'network' || error.status === 0;
      throw new Error(network ? failMessage(error, '网络异常，请稍后重试') : '邮箱或密码不正确');
    }
    lastSession = data || null;
    return lastSession;
  }

  /* 注册第一步：给邮箱发验证码 */
  async function sendSignupCode(email) {
    const addr = String(email || '').trim();
    if (!isEmail(addr)) throw new Error('请输入正确的邮箱地址');
    const { data, error } = await client().auth.sendOtp({ email: addr });
    if (error) throw new Error(failMessage(error, '验证码发送失败'));
    pendingSignup = {
      email: addr,
      verificationId: data.verificationId,
      isExistingUser: data.isExistingUser,
    };
    return { isExistingUser: Boolean(data.isExistingUser) };
  }

  /* 注册第二步：校验验证码并设置密码（已在用的邮箱则直接完成验证码登录） */
  async function completeSignup(email, token, password) {
    const pending = pendingSignup;
    const addr = String(email || '').trim();
    if (!pending || pending.email !== addr) throw new Error('请先获取该邮箱的验证码');
    const code = String(token || '').trim();
    if (!code) throw new Error('请输入邮箱验证码');
    const pwd = String(password || '');
    if (!pending.isExistingUser && pwd.length < 6) throw new Error('密码至少 6 位');
    const { data, error } = await client().auth.verifyOtp({
      email: pending.email,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: code,
      password: pending.isExistingUser ? undefined : pwd,
    });
    if (error) throw new Error(failMessage(error, '注册失败'));
    const wasExisting = Boolean(pending.isExistingUser);
    pendingSignup = null;
    lastSession = data || null;
    return { session: lastSession, isExistingUser: wasExisting };
  }

  /* 微信扫码登录 */
  async function signInWithWeChat() {
    const c = client();
    const back = new URL(w.location.href);
    back.pathname = '/';
    for (const k of ['code', 'state', 'provider']) back.searchParams.delete(k);
    const { data, error } = await c.auth.signInWithOAuth({
      provider: 'wechat',
      redirectTo: back.toString(),
    });
    if (error) throw new Error(failMessage(error, '微信登录发起失败'));
    if (!data || !data.url) throw new Error('未获取到授权地址，请稍后重试');
    w.location.assign(data.url);
  }

  async function signOut() {
    try { await client().auth.signOut(); } catch (e) { /* 本地状态照常清理 */ }
    lastSession = null;
  }

  /* ---------------- 进度数据 ---------------- */
  async function loadProgress() {
    const { data, error } = await client()
      .database.from(TABLE)
      .select('done, todo, updated_at, owner_name')
      .maybeSingle();
    if (error) throw new Error(failMessage(error, '读取云端进度失败'));
    return data || null;
  }

  async function saveProgress(done, todo, ownerName) {
    const payload = {
      done: Array.isArray(done) ? done : [],
      todo: Array.isArray(todo) ? todo : [],
      owner_name: ownerName || null,
    };
    const { data, error } = await client()
      .database.from(TABLE)
      .upsert(payload, { onConflict: 'owner_id' })
      .select('updated_at');
    if (error) throw new Error(failMessage(error, '保存云端进度失败'));
    const row = Array.isArray(data) ? data[0] : data;
    return { updatedAt: row && row.updated_at ? row.updated_at : null };
  }

  async function clearProgress() {
    const { error } = await client().database.from(TABLE).delete().eq('owner_id', user_id());
    if (error) throw new Error(failMessage(error, '清除云端进度失败'));
  }

  function user_id() {
    return lastSession && lastSession.user ? lastSession.user.id : null;
  }

  function userName() {
    const u = lastSession && lastSession.user;
    if (!u) return '';
    if (u.name || u.email) return u.name || u.email;
    // 邮箱/微信登录的会话不返回昵称与邮箱，退化为账号标识
    if (u.id) return '账号 ' + String(u.id).slice(0, 6) + '…';
    return '已登录';
  }

  w.GEL_CLOUD = {
    enabled: Boolean(CFG.endpoint && CFG.publishableKey),
    start,
    onChange,
    currentSession,
    userName,
    signInWithPassword,
    sendSignupCode,
    completeSignup,
    signInWithWeChat,
    signOut,
    loadProgress,
    saveProgress,
    clearProgress,
    isEmail,
  };
})(window);
