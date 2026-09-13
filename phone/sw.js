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
 *    v17 附带**结构性防线**（见下面"版本自检"那一段）：
 *        ① 自测 `phone/test/shell_manifest.json` + `phone/test/sw_cache.mjs`：
 *           记录 ASSETS 里每个文件的 sha256。改了任何一个而 CACHE 没变 ->
 *           `phone/test/sw.mjs` 直接红。这是**最早**能发现的地方（跑测试时）。
 *        ② Service Worker **自己**会核对缓存与线上的字节（版本自检）：
 *           发现不一样就把缓存整体更新，并通知页面在**安全的时候**自己刷新。
 *           这一条不依赖任何人记得做任何事 —— 上面那个坑就是这么被堵死的。
 *           ⚠️ 它**不动**"缓存优先"这条服务策略（离线可用性一个字没改）：
 *              自检是后台的、失败就忽略；页面拿到的仍然是缓存里的副本。
 *    v18：⭐ 上面那两道防线都装上了；另外这一版还有两处功能改动：
 *        · `mapview.js` **自己按视野取瓦片**（`load_area`：先本地、缺的排下载，
 *          到货就重画）—— 以前不先开始导航就只能看到一张空地图；
 *        · `app.js` 在 `init()` 末尾问一次 Service Worker"缓存里是最新的吗"，
 *          变了就在**没在导航、蓝牙没连着**的时候自动刷新（否则押后到
 *          `stop_nav`）。
 *        ⚠️ 第十六次同样的坑本来会在这里发生（改了被预缓存的文件却忘了 bump）——
 *        现在 `node phone/test/run-all.mjs` 会直接拦住它。
 *    v19：v18 的收尾，两条都是真机/自测抓出来的：
 *        ① 自检里 `MessageChannel` 的端口传错了（把 `port1` 递给 SW，于是回答
 *           发给了**自己没听的那一端**）—— 页面上表现为"自检永远没有回答"
 *           且不报任何错。`phone/test/sw.mjs` 第 4 节抓出来的。
 *        ② ⭐ **自举那一环**：装完新版本之后，页面跑的是**缓存里的旧代码**，
 *           而"页面自己问一句缓存新不新"这条路在旧代码里根本不存在 ——
 *           光靠页面驱动永远补不上第一次。所以 `activate` 里由 **SW 自己**
 *           把页面顶掉重载（它一定是新的：浏览器按字节比对 sw.js）。
 *           真机上实测过：装完新 APK 打开，页面先是旧代码（`app.is_online`
 *           都不存在），一两秒后自己刷新成新代码。
 *        缓存版本号随之 +1（这正是测试期那道防线该有的样子）。
 *    v20：⭐ 地图取瓦片**加了上界**（也是真机抓到的）：地图被缩到 z7 左右
 *        （视野跨度约 140 km）时，`tiles_for_area()` 会生成 **4489 块** z14 瓦片
 *        （真机日志原话：`这一带缺 19 块瓦片，已在后台排队（本地已有 1581/4489 块）`），
 *        再往下就是"把全国 583,973 块下到手机里"。现在：
 *        · 取数半径夹到 4 km（z14 下约 25 块）；
 *        · 视野跨度 > 12 km 时**只读本地、不排下载**（我们的瓦片是 z14
 *          街道级，放大才补），界面上写明"视野太大：放大后才补瓦片"。
 *    v21 / v22：v20 的真机收尾（两条都是装了 v20 之后在真机上抓到的）：
 *        · `navigate()` 万一被 WebView 挡掉，还有一条退路 —— 给页面发
 *          `shell-install-changed`，让**页面自己**在安全的时候刷（两条都留着）。
 *          顺带修了重试里"没有接住 navigate() 返回的 promise"（会变成未处理的
 *          rejection，把自测进程直接带崩）。
 *        · `mapview.js` 的日志去重：真机上"视野太大"那一行刷到 **~60 行/秒**
 *          （视野太大 + 一批瓦片陆续到货，每块都触发一次"越过闸门读一次"），
 *          把日志面板和崩溃黑匣子灌满了。现在同一句话只打一次。
 *    v23：⭐ 搜索的**中文查询**修了三处（都是真机上抓到的）：
 *        ① **`lang=default`（最关键的一条）**：Photon 按请求的 Accept-Language
 *           决定返回哪种语言的名字，而**浏览器不允许 JS 覆盖这个头**（forbidden
 *           header）。手机 WebView 发的是英文，于是「沈阳师范大学」返回的是
 *           `Shenyang Normal University`，连 city/state/country 都变成
 *           Shenyang / Liaoning Province / China —— 用户报的"搜出来是英文的"。
 *           `lang=default` 强制要本地名；实测（带 Accept-Language: en）名字和
 *           地址全部变回中文。`lang=zh`/`zh-CN` 在这实例上是 HTTP 400（没配中文）。
 *           ⚠️ 我在电脑上一直复现不出这个 bug，就是因为本机 fetch 不发那个头。
 *        ② **汉字之间的空格**：`沈阳 师范大学` 会把主结果弄丢（Photon 按空白
 *           切 token，中文没有词间空格，一断就散）。现在先归一化再查。
 *        ③ **长行政查询**：`辽宁省沈阳市` 返回「辽宁省辽阳市公安局文圣分局」——
 *           Photon 只把"辽宁省"当匹配依据。现在按**匹配质量打分**排序，并逐级
 *           剥掉行政前缀重查（判据是分数，**不是条数**：第一轮那 7 条数量早就
 *           够了，但一条都不对）。
 *        ⚠️ 这一版改 `search.js` 时我又忘了 bump —— 是 `phone/test/sw.mjs` 直接
 *        把它拦下来的（`--fix` 才把它推到 v23）。**那道守卫是有效的。**
 */
const CACHE = 'navpuck-phone-v23';

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

// ===========================================================================
//  版本自检（"改了文件忘了 bump CACHE"这件事的结构性防线）
// ===========================================================================
//
// 为什么要有它：那个坑已经踩了**十五次**。每一次的症状都一样 ——
// "代码明明改了、手机上还是老样子"，而且**修好之后还得再 bump 一次才生效**，
// 所以看起来像"没修"。靠人记得 bump 是不行的（连写这段注释的人自己都忘了两次）。
//
// 做法（刻意**不**改服务策略）：
//   · 页面问一句 `{type:'check-shell'}` -> 这里把所有 ASSETS 用 `no-store`
//     重新取一遍，和缓存里的字节**逐个比对**；
//   · 全部取到才提交（**先取全、再写**）：避免"网络半路断了"留下新旧混着的
//     缓存 —— 那比不更新还糟（新 app.js + 旧 index.html 会直接对不上 id）。
//   · 有变化 -> 整体更新缓存 + 回一句 `changed:true`。页面会在**安全的时候**
//     （没在导航、蓝牙没连着）自己刷新，于是修复**当次打开就生效**。
//   · 离线 / 取不到 -> 什么都不做（缓存照旧服务，离线可用性不受影响）。
//   · 6 小时最多查一次（`no-store` 是真的重新下载，几百 KB，不能每次启动都跑）。
//
// ⚠️ 为什么不是"JS/CSS 改成 network-first"：这条路在**弱网**下会把 App 卡死 ——
//    请求挂着不回时脚本加载会一直等（可能几十秒），而缓存优先是**立刻**起来。
//    摩托车的使用场景恰恰是"信号时有时无"，这一条不能赌。而且 network-first
//    还会造出"新 app.js + 旧 index.html"的版本错配。所以继续缓存优先，
//    把"新鲜"这件事交给这个后台自检。
const SHELL_CHECK_KEY = 'navpuck-shell-check.v1';
const SHELL_INSTALL_KEY = 'navpuck-shell-install.v1';
const SHELL_CHECK_MIN_MS = 6 * 3600 * 1000;

/** 读一条记在缓存里的元信息（自检时刻 / 这次安装的判断）。 */
async function _meta_get(cache, key) {
  try {
    const r = await cache.match(key);
    if (!r) return null;
    return await r.json();
  } catch (_e) { return null; }
}

async function _meta_put(cache, key, obj) {
  try {
    await cache.put(key, new Response(JSON.stringify(obj),
      { headers: { 'Content-Type': 'application/json' } }));
  } catch (_e) { /* 记不上就下次再说 */ }
}

/** 把所有 ASSETS 用 `no-store` 取一遍。任何一跳失败 -> null（不半途而废）。 */
async function fetch_all_assets() {
  const fetched = [];
  for (const url of ASSETS) {
    let res = null;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (_e) { return null; }
    if (!res || !res.ok) return null;
    fetched.push([url, res]);
  }
  return fetched;
}

/** 两个响应体是不是逐字节相同。 */
async function _same_body(a, b) {
  try {
    const x = new Uint8Array(await a.arrayBuffer());
    const y = new Uint8Array(await b.clone().arrayBuffer());
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i += 1) {
      if (x[i] !== y[i]) return false;
    }
    return true;
  } catch (_e) { return false; }
}

/**
 * install 时把整个 shell 装进缓存，并**顺便判断"和上一版比变了没有"**。
 *
 * ⚠️ 这个判断是给 activate 用的（见那里）：页面跑的是**旧缓存里的旧代码**，
 *    而"页面自己问一句缓存新不新"这条路在旧代码里根本不存在 —— 自举问题。
 *    所以必须由 **SW 自己**（它一定是新代码）把页面顶掉重载。
 *    `had_previous` 是"以前装过 NavPuck 的缓存"：CACHE 名字变了（正常 bump）
 *    时新缓存是空的，只有它能说明"这是一次升级，不是第一次装"。
 */
async function install_shell() {
  const all = await caches.keys();
  const prev_name = all.filter((k) => k !== CACHE && /^navpuck-phone-/.test(k)).pop() || null;
  const cache = await caches.open(CACHE);
  const prev = prev_name ? await caches.open(prev_name) : null;

  const fetched = await fetch_all_assets();
  if (!fetched) {
    // 取不全（网络不好）-> 退回原来的做法：单个失败也不让 SW 整个坏掉
    try {
      await cache.addAll(ASSETS);
    } catch (_e) {
      await Promise.allSettled(ASSETS.map((u) => cache.add(u)));
    }
    await _meta_put(cache, SHELL_INSTALL_KEY, {
      changed: !!prev_name, had_previous: !!prev_name,
    });
    return;
  }

  let changed = false;
  const had_own = (await cache.keys()).length > 0;
  if (prev || had_own) {
    // 只有"本来就有旧的"才谈得上"变了"：第一次装的时候缓存是空的，
    // 那时"每一块都和空的比不一样"没有意义，也不该因此去刷用户的页面。
    for (const [url, res] of fetched) {
      const old = prev ? await prev.match(url) : await cache.match(url);
      if (!old) { changed = true; break; }
      if (!(await _same_body(old, res))) { changed = true; break; }
    }
  }
  for (const [url, res] of fetched) {
    try { await cache.put(url, res.clone()); } catch (_e) { /* 单写失败不影响其它 */ }
  }
  await _meta_put(cache, SHELL_INSTALL_KEY, {
    changed: changed, had_previous: !!prev_name, prev: prev_name || '',
  });
}

/**
 * 把所有页面重新加载（新版本已就位时）。
 *
 * ⚠️ **为什么必须由 SW 来干**：装完新 APK / 发布新版本之后，页面跑的是
 *    **缓存里的旧代码**，而"页面自己问一句缓存新不新"这条路在旧代码里不存在
 *    （那一版根本不知道有这回事）。十五次踩坑里最要命的一次就是这么来的：
 *    修复在新包里，但页面上跑的永远是缓存里那份旧的。SW 一定是新的
 *    （浏览器按字节比对 sw.js），所以这件事只能它来做。
 *
 * 安全性：浏览器的 SW 更新检查只在**导航时**（打开/刷新页面）和 24 小时一次，
 * 所以这条几乎总发生在"用户刚打开 App"的那一刻，而不是骑到一半。页面侧还有
 * 一道（`App.shell_reload_when_safe`）：正在导航 / 蓝牙连着时拒绝刷新。
 */
async function reload_clients() {
  let n = 0;
  try {
    if (!self.clients || typeof self.clients.matchAll !== 'function') return 0;
    const list = await self.clients.matchAll({ type: 'window' });
    for (const c of list) {
      let ok = false;
      try {
        if (typeof c.navigate === 'function') { await c.navigate(c.url); ok = true; }
      } catch (_e) { ok = false; }
      if (ok) { n += 1; continue; }
      // ⚠️ navigate() 万一被挡（WebView 的导航拦截、客户端正在加载等），
      //    还有一条退路：给页面发条消息，让**页面自己**在安全的时候刷新
      //    （`App.shell_reload_when_safe`，它会检查"没在导航、蓝牙没连着"）。
      //    这条对"页面跑的是旧代码"没用（旧代码不认这条消息），所以两条都留着。
      try { c.postMessage({ type: 'shell-install-changed' }); } catch (_e) { /* 忽略 */ }
      // 再给它一次机会：刚装完时页面可能还在加载中，navigate 会被拒。
      // ⚠️ 必须把 navigate() 返回的 **promise** 也接住（只 try/catch 同步抛是
      //    不够的：被拒的 promise 会变成未处理的 rejection —— 这一条就是这么
      //    被 phone/test/sw.mjs 发现的：它直接把自测进程带崩了）。
      const target = c;
      setTimeout(() => {
        Promise.resolve()
          .then(() => (typeof target.navigate === 'function')
            ? target.navigate(target.url) : null)
          .catch(() => { /* 还是不行就算了：下次打开就是新的 */ });
      }, 700);
    }
  } catch (_e) { /* 忽略 */ }
  return n;
}

/** 缓存里记的"上次自检时刻"。 */
async function _shell_last_check(cache) {
  const j = await _meta_get(cache, SHELL_CHECK_KEY);
  return (j && typeof j.t === 'number') ? j.t : 0;
}

async function _shell_put_check(cache, t, changed) {
  await _meta_put(cache, SHELL_CHECK_KEY, { t: t, changed: !!changed });
}

/**
 * 把所有 ASSETS 重新取一遍，和缓存逐字节比对。
 * @returns {Promise<{checked:boolean, changed:boolean, files:string[], reason:string}>}
 */
async function shell_revalidate() {
  const cache = await caches.open(CACHE);
  // ⚠️ 先全部取到内存里（任何一跳失败就整体放弃，**不留半新半旧**：
  //    新 app.js + 旧 index.html 会直接对不上 id）
  const fetched = await fetch_all_assets();
  if (!fetched) {
    return { checked: false, changed: false, files: [], reason: 'fetch-failed' };
  }
  const changed = [];
  for (const [url, res] of fetched) {
    let old = null;
    try { old = await cache.match(url); } catch (_e) { old = null; }
    if (!old) { changed.push(url); continue; }
    if (!(await _same_body(old, res))) changed.push(url);
  }
  // 有变化才整体写回
  if (changed.length > 0) {
    for (const [url, res] of fetched) {
      try { await cache.put(url, res.clone()); } catch (_e) { /* 单个写失败不影响其它 */ }
    }
  }
  await _shell_put_check(cache, Date.now(), changed.length > 0);
  return { checked: true, changed: changed.length > 0, files: changed, reason: '' };
}

/** 页面来问"缓存里的东西还是最新的吗"。 */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'check-shell') return;
  const reply = (payload) => {
    const msg = Object.assign({ type: 'shell-status' }, payload);
    try {
      if (event.ports && event.ports[0]) { event.ports[0].postMessage(msg); return; }
    } catch (_e) { /* 落到下面用 source */ }
    try { if (event.source && event.source.postMessage) event.source.postMessage(msg); }
    catch (_e) { /* 没人听就算了 */ }
  };
  event.waitUntil((async () => {
    // 明确离线：一个请求都不发（跟地图那边一个规矩）
    if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
      reply({ checked: false, changed: false, files: [], reason: 'offline' });
      return;
    }
    let cache = null;
    try { cache = await caches.open(CACHE); } catch (_e) {
      reply({ checked: false, changed: false, files: [], reason: 'no-cache' });
      return;
    }
    const last = await _shell_last_check(cache);
    if (Date.now() - last < SHELL_CHECK_MIN_MS) {
      reply({ checked: false, changed: false, files: [], reason: 'throttled' });
      return;
    }
    const r = await shell_revalidate();
    reply(r);
  })().catch(() => reply({ checked: false, changed: false, files: [], reason: 'error' })));
});

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      // ⭐ 装缓存 + 判断"和上一版比变了没有"（见 install_shell 的说明）
      await install_shell();
    } catch (err) {
      // 缓存整体不可用时也要继续激活（退化成每次都走网络/HTTP 缓存）
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

    // ⭐⭐ 自举那一环：新版本已经装好了，但**页面跑的还是缓存里的旧代码**。
    //     旧代码里没有"问一句缓存新不新"这回事，所以只能由 SW 把页面顶掉重载。
    //     这是"改了文件忘了 bump CACHE"那个坑在真机上唯一能自愈的地方
    //     （实测：装完新 APK 打开，页面先是旧代码，一两秒后自己刷新成新代码）。
    try {
      const cache = await caches.open(CACHE);
      const meta = await _meta_get(cache, SHELL_INSTALL_KEY);
      // 只有**内容真的变了**才顶页面：CACHE 名字变了但内容一样（有人白 bump 一次）
      // 时刷新页面没有任何意义。
      if (meta && meta.changed) await reload_clients();
    } catch (_e) { /* 顶不掉就算了：下次打开就是新的 */ }
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
