/* ============================================================
   云服务公开配置

   apiBase 的取值按「这个主机自己有没有后端」决定，而不是写死 /api：

     · api.meoyes.qzz.io —— 独立部署的纯 API（Vercel 只跑 /api/*）→ 同源 /api
     · 本地开发 localhost/127.0.0.1 —— server/app-server.mjs 同进程分发 → 同源 /api
     · 其它主机（EdgeOne 站点 st.meoyes.qzz.io、各种预览域名）—— 纯静态，
       没有 /api，必须跨域打 API 主机，否则登录会拿到平台的 404
         「The site does not exist」，前端只能显示「请求失败 404」

   2026-11-06 起静态站与 API 彻底分家：Vercel 项目只剩一个 API，
   页面全部由 EdgeOne 提供，所以除了 API 主机自己，其它来源都是跨域。

   为什么不用「先探 /api/health，失败再回退」：多一次往返，而且用户点登录时
   才失败会让人以为是账号问题。主机名是确定的，静态判断更可靠也更快。

   想覆盖（自建后端 / 换域名）：
     window.GEL_API_BASE = 'https://your.host/api';   // 必须在加载本文件前设置
   服务端那侧要放行 Origin，见 server/index.js 的 FIRST_PARTY_ORIGINS
   与部署环境变量 ALLOWED_ORIGINS。

   —— 原来接平台 BaaS 的 endpoint / publishableKey 已随 cloud.js 停用。
      想切回 BaaS：index.html 里把 cloud-own.js 换回 cloud.js，
      再把 endpoint / oauthRelayBaseUrl / publishableKey 三个字段加回来。
   ============================================================ */
(function (w) {
  'use strict';

  /* 接口所在地：独立部署的纯 API（Vercel 只跑 /api/*，不托管页面）。
     站点静态资源在 EdgeOne，两边不同源，所以镜像站与主站都要跨域调它。 */
  var PRIMARY = 'https://api.meoyes.qzz.io';
  /* 自带后端的主机（同源调用）；CDN 镜像与预览域名都不在列表里 */
  var NATIVE = ['api.meoyes.qzz.io'];
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;

  function isNative(host) {
    return NATIVE.indexOf(String(host || '')) >= 0 || LOCAL.test(String(host || ''));
  }

  function resolve(host, override) {
    if (override) return String(override).replace(/\/+$/, '');
    return isNative(host) ? '/api' : PRIMARY + '/api';
  }

  var host = '';
  try { host = w.location.hostname || ''; } catch (e) { /* file:// 打开时没有 location */ }

  var apiBase = resolve(host, w.GEL_API_BASE);
  var native = apiBase === '/api' && isNative(host);
  /* 接口所在主机：同源时为 null（没什么可说的），跨域时给出主机名，
     出问题（比如邮件服务没配）能一眼看出该去配哪台机器 */
  var apiHost = null;
  if (!native) {
    try { apiHost = new URL(apiBase, PRIMARY).hostname; } catch (e) { apiHost = null; }
  }

  w.GEL_CLOUD_CONFIG = {
    apiBase: apiBase,
    apiHost: apiHost,
    /* 下面几个只做展示/排错用 */
    apiPrimary: PRIMARY,
    apiSameOrigin: native,
    host: host,
  };
  w.__GEL_API_RESOLVE = resolve;
  w.__GEL_API_NATIVE = isNative;
})(window);
