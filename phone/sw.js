/* NavPuck 手机端 Service Worker（经典脚本，非模块） */
'use strict';

/*
 * ⚠️ 这里改的每一个预缓存文件（index.html / app.js / style.css …）都必须把
 *    CACHE 版本号 +1。fetch 是**缓存优先**的：版本号不变，手机上的 PWA 会
 *    一直吃旧副本 —— 症状是"代码明明改了，手机上还是老样子"，而且因为
 *    改动本身没生效，用户根本看不出是缓存问题。
 *    v2：加入"高级 / 手动定位"与定位状态面板（室内无 GPS 也能测试）。
 *    v3：底图（Overpass）改成"快速失败 + 说清楚状态 + 可关闭"（map.js / app.js /
 *        index.html / style.css 都动了）。⚠️ 手机上的 PWA 是缓存优先的，
 *        不改这个版本号就永远吃不到这一版代码 —— 而这一版修的正是
 *        "用户只看到等待路网"那个问题。
 *    v4：底图镜像重排（实测唯一能用的 maps.mail.ru 排第一）+ 单镜像超时
 *        12 → 45 秒 / 整轮预算 30 → 120 秒 + sticky 镜像（成功过的下一轮先试）。
 *        ⚠️ 又是同一个坑：v3 那版把**唯一能用的镜像**排在第三、只给 12 秒，
 *        用户看到的是"全部镜像失败"。不 bump 版本号，手机上还是那份坏代码。
 */
const CACHE = 'navpuck-phone-v4';

// 仅预缓存本应用自身的静态资源
const ASSETS = [
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icon.svg',
  'navmath.js',
  'proto.js',
  'route.js',
  'map.js',
  'ble.js',
  'app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      try {
        await cache.addAll(ASSETS);
      } catch (err) {
        // 单个文件缺失不应让 SW 永久损坏：退化为逐个添加
        await Promise.allSettled(ASSETS.map((url) => cache.add(url)));
      }
    } catch (err) {
      // 缓存整体不可用时也要继续激活
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
      );
    } catch (err) {
      // 忽略清理失败
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理同源 GET；其余（含 OSRM / Overpass 的跨域请求）交给浏览器直连
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;

    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      const fallback = await cache.match('index.html');
      if (fallback) return fallback;
      throw err;
    }
  })());
});
