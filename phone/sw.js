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
 *    v5：新增"高级 / 模拟行驶"（模拟位置沿航线按速度自动推进：速度/进度/地图
 *        滚动/航向随转弯变化，室内无 GPS 可测）+ 顶部"模拟行驶"横幅。
 *        ⚠️ 同一个坑第三次：不 bump，手机上永远是那版"车不动"的静态手动位置。
 *    v6：修两个现场问题（app.js / index.html / style.css 都动了）：
 *        1) 路线**重锚**（约每 5km）后底图不再整体偏掉 5km 直到下一次抓取成功
 *           —— 现在同一轮就用内存里的路网按新原点重建并重发，且不联网；
 *        2) 新增**屏幕常亮**（Screen Wake Lock，导航开始申请/停止释放/回前台
 *           重新申请）与**后台限流提示**（状态面板"页面在后台，帧率已降"）。
 *        ⚠️ 第四次同样的坑：不 bump，手机上的 PWA 还是那版"底图有时候会掉、
 *        切后台就卡"的代码 —— 而这正是这一版修的东西。
 *    v7：修一处**静默丢帧**（app.js / ble.js 都动了）：
 *        1) ble.js 的 _drain() 以前按**下标**删"刚写完的那一帧"，而 await 期间
 *           send() 会按优先级重排队列 —— 被删掉的往往是刚插到队首的 route 空片
 *           （重锚前那个 14 字节的"清掉旧窗口"），而真正写出去的帧还留在队列里
 *           被写了第二遍。现在按**对象**删帧；
 *        2) 队满时 route 帧**绝不丢**（让队列超额而不是丢帧），并新增
 *           route_frames_dropped / dropped_by_kind 等计数器，任何丢帧都会进
 *           日志和界面（"已发 / 丢"那一格）。
 *        ⚠️ 第五次同样的坑：不 bump，手机上还是那版"偶尔把空片吃掉、而且计数
 *        一直是 0"的 ble.js —— 症状是设备上偶尔出现新旧窗口拼出来的假路线。
 *    v8：加入**原生节拍器**（app.js / fgs.js / fgs_ui.js / index.html / style.css
 *        都动了）：APK 里可以开关"由原生每 100ms 驱动 JS 循环"，用来回答
 *        "熄屏后原生主动调的 JS 会不会执行"——这一条决定导航循环要不要搬进原生。
 *        同时把 fgs.js / fgs_ui.js 加进预缓存清单（以前它们不在，只是靠
 *        "首次访问时被 fetch 顺带缓存"兜着，离线打开时面板会整个缺失）。
 *        ⚠️ 第六次同样的坑：不 bump，手机上的 PWA 还是那版没有节拍器面板的
 *        index.html + app.js —— 而"读数是旧的"正是这类诊断最危险的失败模式
 *        （人会对着一份过期读数下结论）。
 */
const CACHE = 'navpuck-phone-v8';

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
  'fgs.js',
  'fgs_ui.js',
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
