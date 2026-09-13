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
 *    v9：修 APK 里"连接设备永远扫不到"（ble_native.js / app.js / index.html /
 *        style.css / AndroidManifest.xml 都动了）。两件事：
 *        1) BLE 扫描**不再依赖定位**：插件 initialize({androidNeverForLocation:true})
 *           + 清单里 BLUETOOTH_SCAN 加 android:usesPermissionFlags="neverForLocation"
 *           （Android 12+ 以前要求"定位权限 + 定位服务开着"才给扫描结果，
 *           缺一个就静默返回空 —— 而网页那条路走 Chrome 自己的实现，不受影响，
 *           所以"同一个手机网页能连、APK 连不上"）；
 *        2) 扫描失败不再静默：日志里打真实的权限状态/蓝牙开关/收到的广播条数，
 *           界面上把"权限被拒""蓝牙没开""扫完了但没有广播"分成三种说法，
 *           并加了「重试扫描」。
 *        ⚠️ 第七次同样的坑：不 bump，手机上还是那份"点连接只报没找到设备"的
 *        index.html + app.js + ble_native.js —— 而这一版修的正是它。
 *    v10：修真机上"扫到、连上、MTU=517、通知也订阅了，然后**每一片**都写失败：
 *        Error: Value required.，一路降到 20 字节仍然失败"（只动 ble_native.js）。
 *        根因：原生插件底层只接受**十六进制字符串**的 value，而旧代码传的是
 *        DataView —— 过 Capacitor 桥之后变成 `{}`，native 的 getString("value")
 *        拿到 null 就 reject("Value required.")。与分片大小无关，所以降档阶梯
 *        注定白跑（详见 docs/android.md 3.7）。
 *        ⚠️ 第八次同样的坑：不 bump，手机上还是那份"每个 MTU 都写不通"的
 *        ble_native.js —— 服务端日志会继续把程序错误演成链路问题。
 *    v11：这一版修**闪退**（"连接板子后规划导航直接会闪退"），并且让下一次
 *        出问题时**能自己说清楚是怎么死的**。动了：
 *          · 新增 crashlog.js（崩溃黑匣子：关键操作前同步落盘 + onerror /
 *            unhandledrejection 记录 + 下次启动显示"上次运行异常结束，最后的日志"）；
 *          · ble_native.js：上行通知的**事件名**（真名是 notification|<id>|<svc>|<char>，
 *            不是 onNotification）与**值的编码**（插件发的是大写十六进制字符串）。
 *            这两条错着的时候设备上行整条链路是**静默失效**的（电量/按键/PING
 *            一个都收不到），而手机侧看起来只是"设备没说话"；
 *          · app.js：第一次发帧 / 起导航 / 停导航前写同步 marker；fgs.js 加了
 *            note()/crash_report()/clear_crash_report() 三个封装。
 *        ⚠️ 第九次同样的坑：不 bump，手机上还是那份"崩了什么都不留"的
 *        index.html + app.js —— 而这一版的核心价值恰恰是那份落盘日志。
 *    v12：⭐ 修**真机确认过的闪退根因**（dropbox 里有完整栈）：
 *        `BluetoothGatt.writeCharacteristic` 在 API 33+ 会因为
 *        `value.length > 512` 直接抛 IllegalArgumentException
 *        （"value should not be longer than max length of an attribute value"），
 *        而这条异常**同步抛在插件的回调线程上**，Capacitor 不把它变成 rejected
 *        promise ⇒ JS 接不住 ⇒ 进程消失。旧代码按 `MTU - 3` 分片，真机 MTU 517
 *        ⇒ 514 > 512 ⇒ 必闪退。这一版：
 *          · ble_native.js：分片上界改成 **min(MTU-3, 512)**（512 是框架硬常量，
 *            证据 = 设备上 framework-bluetooth.jar 的字节码，写在 docs/android.md 第 9 节），
 *            并且**从 20 字节起步**、只在连续成功之后才升一档（自适应 + 跨启动落盘 +
 *            黑匣子推断致命失败）；
 *          · index.html / app.js：新增"高级 / BLE 分片"面板 + 状态面板"分片"那一格
 *            （看得见当前值、能设上限、能锁定、能清空学习记录），并写明速度代价。
 *        ⚠️ 第十次同样的坑：不 bump，手机上还是那份"按 MTU-3 分片"的
 *        ble_native.js —— 而它一连接就闪退，用户连日志都看不到。
 *    v13：⭐ 底图改成**离线优先**（新增 phone/tiles.js；map.js / app.js /
 *        index.html 都动了）。三件事：
 *        1) 新增 tiles.js（必须在 map.js 之前加载）并加进预缓存清单；
 *        2) fetch 处理器**跳过 /tiles/ 下的请求** —— 见下面那段说明；
 *        3) 只有**导航请求**（mode === 'navigate'）才回退到 index.html。
 *          以前是"任何请求失败都回 index.html"，瓦片请求一旦失败就会拿到
 *          一整页 HTML 当作 .npt 去解码 —— 那会变成"本地缓存里存了一堆垃圾"，
 *          比不缓存糟得多。
 *        ⚠️ 第十一次同样的坑：不 bump，手机上还是那份"没有任何瓦片逻辑"的
 *        index.html + map.js —— 而这一版修的正是"底图时有时无"。
 *    v14：底图改成**打包布局**（NPK1 容器）。动了 phone/tiles.js（加容器解包层：
 *        一个 .npk 装 256 个 z14 块、整包缓存）—— 而 tiles.js 在预缓存清单里，
 *        所以**必须**再 bump 一次。
 *        ⚠️ 第十二次同样的坑：不 bump，手机上的 PWA 会一直吃旧的 tiles.js，
 *        而那一版**不认识 .npk**（它只会去取 14/<x>/<y>.npt，全 404）——
 *        症状是"底图整个没了"，看起来像瓦片没发布。
 *        同时客户端按 index.json 的 pack 字段判形态，旧代码连这个字段都不看。
 *    v15：⭐ 手机端**终于有地图了**（新增 phone/mapview.js；index.html /
 *        style.css / app.js 都动了）。地图是 Canvas 直接画路网（不引入任何地图库：
 *        瓦片是自产的矢量 .npt，路网本来就在内存/IndexedDB 里），带拖动/双指
 *        缩放/滚轮缩放/回到当前位置，高 DPI 按 devicePixelRatio 处理，并且
 *        **只画已经缓存的离线瓦片**（没有网络也能看到当前位置一带的路网）。
 *        ⚠️ 第十三次同样的坑：不 bump，手机上的 PWA 里根本**没有** mapview.js
 *        （预缓存清单里没有它，离线打开时那一块直接缺），用户看到的还是
 *        "只有控制面板、没有地图"——而这一版加的正是地图。
 *    v16：⭐ 目的地可以**搜地名**了（新增 phone/search.js；index.html /
 *        style.css / app.js 都动了）。搜索框在「目的地」面板最上面（手输经纬度
 *        降级成兜底），每条结果显示名称 + 省市区街道 + 离当前位置多远，点一条
 *        就填进目的地坐标。
 *        ⚠️ 为什么位置偏置不是可选项：不带偏置搜「西湖」返回的是台湾高雄的
 *        同名地点（实测差 800 公里），「天安门」返回的是旅行社。偏置取"当前
 *        位置 → 导航起点 → 地图中心"，都没有时照搜，但界面如实写"未按位置排序"。
 *        ⚠️ 第十四次同样的坑：不 bump，手机上的 PWA 里没有 search.js，
 *        搜索那一栏会一直显示"搜索模块没加载成功"。
 *    v17：修复"打包部署下底图永远空白"。tiles.js 的 load_root() 在从
 *        IndexedDB 恢复 root 时漏设 pack_z，于是 pack_z 停在 0（被当成散块
 *        部署），拿 z14 的坐标去比打包索引的 z10 范围 → 每块都判成"超出发布
 *        范围" → 全部标 absent → 永远不下瓦片。真机症状是地图一直空白且
 *        重启不自愈。
 *        ⚠️ **第十五次同样的坑，而且这次是我自己踩的**：改完 tiles.js 直接
 *        重建 APK 装进手机，忘了 bump 这一行 —— 结果 Service Worker 继续发
 *        navpuck-phone-v16 缓存里的**旧 tiles.js**（实测 51,247 B、不含新加的
 *        _adopt_root），修复在包里但从没被执行，真机上症状一模一样。
 *        诊断靠 DevTools 协议读 caches.keys() + 比对缓存内文件内容才看出来。
 *        **凡是动了 ASSETS 里的文件，这一行必须一起改。**
 */
const CACHE = 'navpuck-phone-v17';

// 仅预缓存本应用自身的静态资源
const ASSETS = [
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icon.svg',
  'crashlog.js',
  'navmath.js',
  'proto.js',
  'route.js',
  'tiles.js',
  'map.js',
  // ⭐ 地图视图（Canvas 画路网）。和别的 .js 一样必须预缓存：不预缓存的话
  //    "离线打开 PWA"时它取不到，地图那一块会整个缺失（而离线正是最需要
  //    地图的时候）。
  'mapview.js',
  // ⭐ 地点搜索（Photon，见 search.js 里那段"偏置不是可选项"的实测说明）。
  //    同样必须预缓存：不预缓存的话离线打开时它取不到，搜索那一栏会一直报
  //    "搜索模块没加载成功"——而搜地名正是"骑到半路想改目的地"时最需要的东西。
  'search.js',
  // ⚠️ ble_native.js 以前**不在**这个清单里：offline 打开 PWA 时它取不到，
  //    只是"没有原生 BLE 传输"这一条退路而已（PWA 本来就走 Web Bluetooth），
  //    所以一直没人发现。既然是 index.html 里加载的文件，就该一起预缓存。
  'ble_native.js',
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

  // ⭐ 离线瓦片（/tiles/...）**刻意不走这里**。
  //
  // 为什么：瓦片的持久缓存由 phone/tiles.js 用 IndexedDB 管（二进制、几十 MB、
  // 要能数块数、要能按需淘汰）。让 SW 再存一份是双份磁盘，而且两边的淘汰
  // 策略互不知情 —— 只会让"到底有没有这块"变得说不清。
  //
  // ⚠️ 更要紧的是**不能**让它们掉进下面那个 index.html 回退：一块瓦片下载
  //    失败却拿到一整页 HTML，会被当成二进制塞进缓存 —— 之后每次解码都失败，
  //    而且症状是"这一带的路网莫名其妙没了"。这类"缓存里存了垃圾"的故障
  //    极难查，所以宁可不碰。
  if (url.pathname.indexOf('/tiles/') >= 0) return;

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
      // ⚠️ 只有**导航请求**（地址栏跳转 / 打开 PWA）才回退到 index.html。
      //    以前是任何请求都回退 —— 于是一个失败的 map.js 请求会拿到一整页
      //    HTML，浏览器把它当 JS 解析，报的错和真正的原因（网络）毫无关系。
      if (req.mode === 'navigate') {
        const fallback = await cache.match('index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
