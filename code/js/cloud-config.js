/* ============================================================
   云服务公开配置
   —— apiBase 指向自建 Turso API：同源 /api
      · 线上 atlas.meoyes.qzz.io：静态走 CDN，/api/* 走 Vercel Serverless Function
      · 本地与 Node 托管：server/app-server.mjs 同一进程分发
      · Cloudflare Worker（可选入口）：server/worker.js
      路径一律是 /api，所以只写相对地址，换托管不用改配置。
   —— 原来接平台 BaaS 的 endpoint / publishableKey 已随 cloud.js 停用。
      想切回 BaaS：index.html 里把 cloud-own.js 换回 cloud.js，
      再把 endpoint / oauthRelayBaseUrl / publishableKey 三个字段加回来。
   ============================================================ */
window.GEL_CLOUD_CONFIG = {
  apiBase: '/api',
};
