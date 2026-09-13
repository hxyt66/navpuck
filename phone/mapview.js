/*
 * NavPuck 手机端**地图视图** —— 把已经拿到的路网直接画到 Canvas 上。
 *
 * ===========================================================================
 * 为什么不引入地图库（Leaflet / MapLibre / Mapbox）
 * ===========================================================================
 * 三条硬理由，缺一条都还能忍，三条凑齐就没得选：
 *
 *   1. **瓦片是矢量 `.npt`（NPK1 打包），不是栅格 PNG。** Leaflet/MapLibre
 *      吃的是栅格瓦片或它们自己那套矢量规范（MVT + 样式表）。我们的格式
 *      是自产的（见 tiles.js 文件头），要接进去得先写一层转换 —— 那还不如
 *      自己画。**而且数据本来就已经在内存里了**（`map.ways` / 本地瓦片），
 *      交给库反而是绕远路。
 *   2. **没有付费底图服务，也不该有。** 骑行途中弱网/无网是常态，这个工程
 *      从头到尾的设计前提就是"底图不许依赖上游可用性"。一个需要在线样式表、
 *      在线 sprite、在线字体的库，等于把刚拆掉的依赖又装回来。
 *   3. **体积与离线**。PWA 走 Service Worker 预缓存、APK 走打包，多一个几百 KB
 *      的库就是多一份要预缓存、要版本对齐、要在无网时保证齐全的东西。
 *      而这个视图真正需要的渲染能力只有：画折线、画一个箭头、写三行字。
 *
 * ===========================================================================
 * 投影：和工程其它地方**同一套**
 * ===========================================================================
 * 不做 Web Mercator（那要为了 y 做 asinh，还得为"屏幕像素 ↔ 经纬度"再配一套
 * 反变换）。这里用的是工程里到处都是的那个**局部正北平面**（见 route.js 的
 * `Route`、map.js 的 `build()`、app.js 的 `Navigator._to_local`）：
 *
 *     东向(m) = wrap180(lon - lon_c) * EARTH_M_PER_DEG_LON_EQ * cos(lat_c)
 *     北向(m) = (lat - lat_c) * EARTH_M_PER_DEG_LAT
 *     屏幕 x  = w/2 + 东向 / m_per_px
 *     屏幕 y  = h/2 - 北向 / m_per_px
 *
 * 好处是**地图上量到的距离和导航算出来的距离是同一个数**（同一个米制平面），
 * 坏处是高纬度/超远距离会有形变 —— 但手机上看的是几公里范围，这个形变
 * （cos 在一公里内的变化 < 0.01%）在任何屏幕上都不可能看出来。
 *
 * ⚠️ `cos(lat_c)` 是在**建视图时**按视图中心算一次、之后平移/缩放都**不再重算**
 *    （`view.k_lon`）。这样投影在两次手势之间是**严格仿射**的 —— 可逆、可对拍
 *    （自测里那条"拖 N 像素后屏幕坐标必须正好移动 N 像素"就是靠它）。
 *    跟随定位时每次都会重建视图，所以中心纬度一直在跟着走，不会有累积误差。
 *
 * ⚠️ 经度差全部过 `nm.wrap180`，所以**跨 180° 经线**天然正确：一条从
 *    179.99 走到 -179.99 的路，逐个点折到视图中心的连续经度轴上之后就是
 *    一条连续的短线，而不会横穿整张图（自测钉着这条）。
 *
 * ===========================================================================
 * 数据从哪来（**离线优先，这一层一个字节都不联网**）
 * ===========================================================================
 * 这个类**自己不下载任何东西**。它只从两个地方取路网：
 *
 *   ① `opts.ways()` —— 同步提供者，每帧调。app.js 接的是
 *      `OsmMapSource.ways`（那份数据本身已经是"离线瓦片优先、Overpass 兜底"
 *      的产物，见 map.js 文件头）。形状和瓦片一致：`[[rank,[[lat,lon],...]],...]`。
 *   ② `opts.load_local(lat, lon, radius_m)` —— 异步提供者，**只许读本地**。
 *      app.js 接的是 `TileStore.local_area()`（内存 + IndexedDB，见 tiles.js），
 *      它是**纯本地**读取：没有网也照样返回手上有的那些瓦片拼出来的路网。
 *
 * ⚠️ 这两条**都不联网**。`local_area` 故意不排下载、不碰 fetch；瓦片的下载是
 *    map.js 那条路的事（导航中它自己会做）。所以"没网也能看到当前位置一带的
 *    路网"这件事不是承诺，而是这一层的结构决定的 —— 自测里用"fetch 一律抛错"
 *    把它钉住（见 phone/test/mapview.mjs 第 4 节）。
 *
 *   ③ 快照优先顺序：`ways()` 有数据就用它，否则用 `load_local` 拿回来的那份。
 *      两者形状完全相同，所以画的时候只有一条代码路径。
 *
 * ===========================================================================
 * 画什么（图层顺序，从下到上）
 * ===========================================================================
 *   1. 底色
 *   2. 路网：**按 rank 分组，一组一次 stroke**（rank 越小等级越高 -> 越粗越亮，
 *      表见 ROAD_STYLE）。分组是关键的性能手段：一条一条 stroke 的话，
 *      Canvas 的每次 stroke 都要提交一遍状态，几百条就明显掉帧。
 *   3. 已规划航线：先描一圈深色"描边"再画亮蓝主线，压在任何等级的路之上 ——
 *      骑手瞄一眼屏幕就必须能分出"哪条是让我走的路"。
 *   4. 当前位置 + 朝向箭头（北朝上；地图**不**跟着车头转，见下）
 *   5. 比例尺、指北标、状态角标
 *
 * ⚠️ **地图固定北朝上，不跟着车头转。** 用户要的是"我在哪、路怎么走"，
 *    北朝上时屏幕方向和地理方向一一对应，边看边记路最容易；车头朝上的地图
 *    在静止/慢速时（等红灯、找路）会自己乱转，反而更难读。朝向由车标箭头表达。
 *    （设备那块圆屏是车头朝上的，那是**另一个**使用场景：屏幕只有 240 像素、
 *      骑手没空读地图，只需要"跟着箭头走"。两处刻意不同。）
 *
 * ===========================================================================
 * 触摸手势与 DPR
 * ===========================================================================
 *   - 单指拖动 = 平移；双指 = 缩放（锚在中点）+ 平移；滚轮 = 以光标为锚缩放；
 *     双击 = 放大一档。任何手势都会把 `follow`（跟随当前位置）关掉，界面上
 *     会写明"自由查看"，按「回到当前位置」再打开 —— **状态必须说得清楚**，
 *     否则用户会以为"地图坏了，不跟着我走了"。
 *   - 高 DPI：画布的 `width/height`（设备像素）= CSS 尺寸 × devicePixelRatio，
 *     再用 `setTransform(dpr,...)` 把绘制坐标系整体缩放回 **CSS 像素**。
 *     所以这个文件里所有坐标、线宽、字号都是 CSS 像素，不会在手机上糊。
 */

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./navmath.js'), require('./tiles.js'));
  } else {
    root.NavPuckMapView = factory(root.NavPuckMath, root.NavPuckTiles);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (nm, tl) {

  // ---- 常量 --------------------------------------------------------------

  // 米/像素（在**整数**缩放级上与 slippy 瓦片对齐）：BASE_MPP / 2^zoom。
  // 40075016.686 m（赤道周长）/ 256 px = 156543.03 —— 和 Web Mercator 的 z0
  // 定义一致，所以"z14 的一块瓦片"在赤道上正好是 256 px 宽，和我们下载的
  // 瓦片级（TILE_ZOOM = 14）对得上，排查问题时心算方便。
  const BASE_MPP = 156543.03392804097;
  const MIN_ZOOM = 3.0;
  const MAX_ZOOM = 20.0;
  const DEFAULT_ZOOM = 16.0;
  // 建视图时的兜底尺寸（拿不到 canvas 尺寸时用；240 是设备那块圆屏的直径）
  const DEFAULT_W = 240;
  const DEFAULT_H = 240;

  // 局部平面用的两个常数**必须**和 route.js 逐位相同 —— 不然地图上量出来的
  // 100 米和导航算出来的 100 米不是同一个 100 米，而症状极难看出来。
  const EARTH_M_PER_DEG_LAT = 110540.0;
  const EARTH_M_PER_DEG_LON_EQ = 111320.0;
  const DEG2RAD = Math.PI / 180.0;

  // 纬度夹到 ±85.05（slippy 的极限）：再往极点走，cos(lat) -> 0，经度方向的
  // 米/度会退化成 0，投影会炸出 Infinity。
  const MAX_LAT = 85.05112878;

  // ---- 配色 / 线宽（等级越小越高）----------------------------------------
  //
  // 底色和 style.css 的 --bg 一致，所以地图和面板之间没有色块缝。
  // 道路是从亮到暗的一串灰蓝：高速最亮最粗，服务道最暗最细 —— 屏幕上自然
  // 形成"主干道先跳出来"的层次，不需要标签。
  const BG = '#0b0e13';
  const ROAD_STYLE = [
    { color: '#8b9cb3', width: 4.6 },   // 0 高速
    { color: '#7d8fa7', width: 4.2 },   // 1 干线/高速匝道
    { color: '#6f8299', width: 3.6 },   // 2 主要道路
    { color: '#63768c', width: 3.2 },   // 3 次要道路
    { color: '#57697e', width: 2.8 },   // 4 三级道路
    { color: '#4c5d70', width: 2.4 },   // 5 未分类
    { color: '#425062', width: 2.0 },   // 6 居住区道路
    { color: '#394656', width: 1.8 },   // 7 生活街
    { color: '#333f4d', width: 1.6 },   // 8 服务道
  ];
  const ROAD_STYLE_FALLBACK = { color: '#333f4d', width: 1.6 };
  const ROUTE_COLOR = '#2ea8ff';        // 和 style.css 的 --accent 同色
  const ROUTE_CASING = '#062a44';
  const ROUTE_WIDTH = 5.0;
  const POS_COLOR = '#23c96a';          // 和 style.css 的 --ok 同色
  const POS_RING = '#04140b';
  const TEXT_COLOR = '#c8d6e6';
  const DIM_COLOR = '#8b9aae';
  const BADGE_BG = 'rgba(11,14,19,0.72)';

  // 线宽随缩放级缩放：远景里 4.6px 的一根高速会糊成一坨，近景里 1.6px 的
  // 服务道又细得看不见。16 级是"基准"（手机上大致是 1 像素≈2.4 米的街景）。
  const WIDTH_BASE_ZOOM = 16.0;

  // 屏幕空间抽稀：相邻投影点挨得太近就不画（< 1 像素的点在屏幕上没有意义）。
  // 单位是 **CSS 像素**，所以高 DPI 下这个阈值不会跟着 DPR 放大。
  const MIN_STEP_PX = 0.7;

  // 本地瓦片重读的最小间隔（毫秒）与最小移动距离（米）。见 _refresh_local。
  const LOCAL_MIN_PERIOD_MS = 1500;
  const LOCAL_MIN_MOVE_M = 120.0;
  // 取本地瓦片的半径 = 视图对角半径 × 这个系数 + 这点余量（米）。
  const LOCAL_RADIUS_K = 1.15;
  const LOCAL_RADIUS_PAD_M = 250.0;

  // 每帧的最小间隔（毫秒）：5Hz。真机上再快也没有意义（位置本身就是 1~10Hz、
  // 屏幕也就那么大），而 5Hz 的重画在省电上明显好于"每个 on_ui 都重画"。
  const MIN_PERIOD_MS = 200;

  // ---- 纯函数：缩放与视图 ------------------------------------------------

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function clamp_zoom(z) {
    if (!Number.isFinite(z)) return DEFAULT_ZOOM;
    return clamp(z, MIN_ZOOM, MAX_ZOOM);
  }

  /** 缩放级 -> 米/像素（真地面米，不是墨卡托米）。 */
  function mpp_of(zoom) {
    return BASE_MPP / Math.pow(2, clamp_zoom(zoom));
  }

  /** 米/像素 -> 缩放级。mpp_of 的严格反函数。 */
  function zoom_of_mpp(mpp) {
    if (!(mpp > 0)) return DEFAULT_ZOOM;
    return clamp_zoom(Math.log(BASE_MPP / mpp) / Math.LN2);
  }

  function _k_lon_at(lat) {
    return EARTH_M_PER_DEG_LON_EQ * Math.cos(clamp(lat, -MAX_LAT, MAX_LAT) * DEG2RAD);
  }

  /**
   * 建一个视图（投影的全部状态就这四个数 + 一个 cos）。
   *
   * @param {object} o {lat, lon, zoom, w, h}
   * @returns {{lat:number, lon:number, zoom:number, w:number, h:number,
   *            mpp:number, k_lon:number}}
   */
  function make_view(o) {
    const s = o || {};
    const lat = clamp(Number.isFinite(s.lat) ? s.lat : 0.0, -MAX_LAT, MAX_LAT);
    const lon = Number.isFinite(s.lon) ? nm.wrap180(s.lon) : 0.0;
    const zoom = clamp_zoom(s.zoom === undefined ? DEFAULT_ZOOM : s.zoom);
    const w = Number.isFinite(s.w) && s.w > 0 ? s.w : DEFAULT_W;
    const h = Number.isFinite(s.h) && s.h > 0 ? s.h : DEFAULT_H;
    return {
      lat: lat, lon: lon, zoom: zoom, w: w, h: h,
      mpp: mpp_of(zoom), k_lon: _k_lon_at(lat),
    };
  }

  /** 只换尺寸，其它一律不动（k_lon 保持不变：见文件头那段"严格仿射"）。 */
  function resize_view(view, w, h) {
    const out = {
      lat: view.lat, lon: view.lon, zoom: view.zoom,
      mpp: view.mpp, k_lon: view.k_lon,
      w: Number.isFinite(w) && w > 0 ? w : view.w,
      h: Number.isFinite(h) && h > 0 ? h : view.h,
    };
    return out;
  }

  /**
   * 经纬度 -> 屏幕坐标（CSS 像素）。**这是整个文件里唯一一处投影。**
   *
   * 经度差走 wrap180 -> 跨 180° 经线正确；纬度差直接线性（局部平面）。
   * 返回 [x, y]：x 向右，y 向下（和 Canvas 一致），北在上。
   *
   * ⚠️ 这里的写法（先把 `cos(lat)/mpp` 折成一个**乘数**再乘）是刻意的：它必须
   *    和渲染热路径 `_proj_into` 是**同一个式子**，否则同一个点在"量距离"和
   *    "画出来"两处会差最后几个比特 —— 自测里有一条 20 万点的逐位对拍钉着它。
   *    两条路都写成 `w/2 + d * (k/mpp)`，而不是 `w/2 + d*k/mpp`。
   */
  function project(view, lat, lon) {
    const kx = view.k_lon / view.mpp;
    const ky = EARTH_M_PER_DEG_LAT / view.mpp;
    return [view.w * 0.5 + nm.wrap180(lon - view.lon) * kx,
            view.h * 0.5 - (lat - view.lat) * ky];
  }

  /** 屏幕坐标 -> 经纬度。project 的严格反函数（同一个 k_lon / mpp）。 */
  function unproject(view, x, y) {
    const de = (x - view.w * 0.5) * view.mpp;
    const dn = (view.h * 0.5 - y) * view.mpp;
    return [clamp(view.lat + dn / EARTH_M_PER_DEG_LAT, -MAX_LAT, MAX_LAT),
            nm.wrap180(view.lon + de / view.k_lon)];
  }

  /**
   * 把**内容**平移 (dx, dy) 像素（手指往右拖 dx>0 -> 地图跟着往右走）。
   *
   * 严格可逆：`project(pan_by(v, dx, dy), p)` 恒等于 `project(v, p) + (dx, dy)`
   * （除非跨过 180° 经线或撞到纬度上限）—— 自测钉着这条。
   */
  function pan_by(view, dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return view;
    const dlat = dy * view.mpp / EARTH_M_PER_DEG_LAT;
    const dlon = -dx * view.mpp / view.k_lon;
    return {
      lat: clamp(view.lat + dlat, -MAX_LAT, MAX_LAT),
      lon: nm.wrap180(view.lon + dlon),
      zoom: view.zoom, mpp: view.mpp, k_lon: view.k_lon,
      w: view.w, h: view.h,
    };
  }

  /**
   * 以屏幕上 (ax, ay) 这一点为锚缩放：缩放前后，锚点**下面的那个地理位置**
   * 在屏幕上不动。双指缩放和滚轮缩放的"手感"就全在这个函数里。
   *
   * 实现是"先按新缩放级建一个同中心的视图，再把锚点该在的位置差补回去" ——
   * 复用 pan_by，所以平移那一套的可逆性/夹角处理在这里自动成立。
   */
  function zoom_at(view, new_zoom, ax, ay) {
    const z = clamp_zoom(new_zoom);
    if (z === view.zoom) return view;
    const a = Number.isFinite(ax) ? ax : view.w * 0.5;
    const b = Number.isFinite(ay) ? ay : view.h * 0.5;
    const ll = unproject(view, a, b);
    const v2 = { lat: view.lat, lon: view.lon, zoom: z, mpp: mpp_of(z),
                 k_lon: view.k_lon, w: view.w, h: view.h };
    const p2 = project(v2, ll[0], ll[1]);
    return pan_by(v2, a - p2[0], b - p2[1]);
  }

  /**
   * 视图覆盖的经纬度范围（含跨 180° 经线的情况）。
   *
   * ⚠️ `east` 是折到"以 west 为参照的连续经度轴"上的值，所以它**可能大于 180**
   *    （视图压着 180° 经线时就是这样：west=179.98、east=180.01）。
   *    不这么处理的话，east 会被 wrap180 折成 -179.99，于是 `west <= lon <= east`
   *    这个判断对视图里**所有**的点都不成立 —— 症状是"贴着 180° 经线的那一带
   *    地图整个是空的"，而且看起来完全像"这一带没有路"。
   */
  function visible_bounds(view) {
    const sw = unproject(view, 0, view.h);
    const ne = unproject(view, view.w, 0);
    const west = sw[1];
    return {
      south: sw[0], west: west, north: ne[0],
      east: west + nm.wrap180(ne[1] - west),
    };
  }

  /**
   * 经度在不在 [west, east] 里（允许 west/east 落在 ±180 之外、也允许跨越）。
   *
   * 做法是把 lon 折到"以 west 为参照的连续经度轴"上：`west + wrap180(lon-west)`
   * 落在 [west-180, west+180]。视图最多覆盖 360°，所以这个窗口够用，而且
   * 跨 180° 经线时不需要任何特判。
   */
  function _lon_within(lon, west, east, pad) {
    const l = west + nm.wrap180(lon - west);
    return l >= (west - pad) && l <= (east + pad);
  }

  /** 一条折线的经纬度包围盒（不投影，纯比较，用来在投影之前整条丢掉）。 */
  function _seg_bbox(geom) {
    let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
    for (let i = 0; i < geom.length; i += 1) {
      const p = geom[i];
      const la = p[0];
      const lo = p[1];
      if (la < s) s = la;
      if (la > n) n = la;
      if (lo < w) w = lo;
      if (lo > e) e = lo;
    }
    return { south: s, north: n, west: w, east: e };
  }

  /**
   * 这条折线要不要画。用**经纬度**包围盒比（不投影）：一次比较换掉整条的
   * 投影开销，这是大瓦片下最划算的一刀。
   *
   * ⚠️ 经度那一维要处理"跨 180°"：bbox 的 west/east 是原始值（可能 179.9 与
   *    -179.9 同时出现，此时 e < w），所以按"点是否落在视图经度窗口内"逐边判，
   *    而不是简单地比大小。
   */
  function seg_visible(geom, bounds, pad_deg) {
    const b = _seg_bbox(geom);
    const pad = pad_deg === undefined ? 0 : pad_deg;
    if (b.north < bounds.south - pad || b.south > bounds.north + pad) return false;
    // 经度：把这条折线的**每一个**端点折到视图的连续经度轴上再取 min/max
    // （端点已经是原始经度，逐个 wrap 之后就是连续的）。
    let lo_min = Infinity, lo_max = -Infinity;
    for (let i = 0; i < geom.length; i += 1) {
      const l = bounds.west + nm.wrap180(geom[i][1] - bounds.west);
      if (l < lo_min) lo_min = l;
      if (l > lo_max) lo_max = l;
    }
    return !(lo_max < bounds.west - pad || lo_min > bounds.east + pad);
  }

  /** 道路样式（未知等级退化成最细的那一档）。 */
  function rank_style(rank) {
    const r = Math.round(Number(rank));
    if (Number.isFinite(r) && r >= 0 && r < ROAD_STYLE.length) return ROAD_STYLE[r];
    return ROAD_STYLE_FALLBACK;
  }

  /** 线宽随缩放级的缩放系数（见 WIDTH_BASE_ZOOM）。 */
  function width_scale(zoom) {
    return clamp(Math.pow(2, (clamp_zoom(zoom) - WIDTH_BASE_ZOOM) / 4.0), 0.42, 2.4);
  }

  /** 1/2/5 × 10^k 里挑一个"人看得懂"的长度（米），用于比例尺。 */
  function nice_meters(m) {
    if (!(m > 0) || !Number.isFinite(m)) return 1;
    const e = Math.floor(Math.log(m) / Math.LN10);
    const p = Math.pow(10, e);
    const f = m / p;
    const pick = f >= 5 ? 5 : (f >= 2 ? 2 : 1);
    return pick * p;
  }

  /**
   * 比例尺：给一个"大约多长"的屏幕像素目标，返回一个整数米数和它真正的像素长度。
   *
   * ⚠️ 文本用 `nm.format_distance` —— 和状态面板里"剩余 1.2km"是同一个格式化
   *    函数。比例尺上写 1.2km、面板上写 1200m 会让人怀疑是不是两个东西。
   */
  function scale_bar(view, target_px) {
    const want = Number.isFinite(target_px) && target_px > 0 ? target_px : 64.0;
    const m = nice_meters(want * view.mpp);
    return { m: m, px: m / view.mpp, text: nm.format_distance(m) };
  }

  // ---- 小工具 ------------------------------------------------------------

  function _num(v, d) { return Number.isFinite(v) ? v : d; }

  /** 从各种"可能是数组也可能是对象"的位置表示里取出 [lat, lon, heading]。 */
  function _pos_of(v) {
    if (!v) return null;
    let lat, lon, hdg;
    if (Array.isArray(v)) { lat = v[0]; lon = v[1]; hdg = v[2]; }
    else { lat = v.lat; lon = v.lon; hdg = (v.heading_deg !== undefined ? v.heading_deg : v.heading); }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return [lat, lon, Number.isFinite(hdg) ? hdg : null];
  }

  // ---- MapView -----------------------------------------------------------

  class MapView {
    /**
     * @param {HTMLCanvasElement|null} canvas  画布（Node 自测里给 null + opts.ctx）
     * @param {object} opts
     *   ctx          注入的 2D 上下文（自测用；给了就不碰 canvas.getContext）
     *   w / h        没有 canvas 时的 CSS 尺寸（自测用）
     *   dpr          返回 devicePixelRatio 的函数（自测用）
     *   ways         同步路网提供者 `() => [[rank,[[lat,lon],...]],...]`
     *   load_local   异步**只读本地**的取路网函数 `(lat,lon,radius_m) => {ways,have,need,coverage}`
     *   pos          位置提供者 `() => [lat,lon,heading] | null`
     *   route        航线提供者 `() => [[lat,lon],...] | null`
     *   center       还没有定位时的初始中心 `[lat, lon]`
     *   zoom         初始缩放级
     *   follow       是否跟随当前位置（默认 true）
     *   on_status    状态变化时回调（对象；界面直接照抄）
     *   window       注入的 window（requestAnimationFrame / devicePixelRatio）
     *   now_ms       注入时钟（自测；默认 Date.now）
     *   log          日志回调
     */
    constructor(canvas, opts) {
      const o = opts || {};
      this.canvas = canvas || null;
      this.ctx = o.ctx || null;
      this._win = o.window || (typeof window !== 'undefined' ? window : null);
      this._dpr_fn = o.dpr || null;
      this._now_ms = o.now_ms || (() => Date.now());
      this.log = o.log || (() => {});

      this.ways = o.ways || null;
      this.load_local = o.load_local || null;
      this.pos_provider = o.pos || null;
      this.route_provider = o.route || null;
      this.on_status = o.on_status || null;

      this.zoom = clamp_zoom(o.zoom === undefined ? DEFAULT_ZOOM : o.zoom);
      this.follow = o.follow === undefined ? true : !!o.follow;
      // 初始中心：有定位就等第一帧跟随；没有就给一个（app.js 给的是演示航线
      // 起点）—— 否则打开页面是一片空白，看起来像坏了。
      this._center_seed = _pos_of(o.center);
      this.view = null;

      this.css_w = Number.isFinite(o.w) && o.w > 0 ? o.w : DEFAULT_W;
      this.css_h = Number.isFinite(o.h) && o.h > 0 ? o.h : DEFAULT_H;
      this.dpr = 1;

      // 本地瓦片那一层（见文件头"数据从哪来"）
      this.local = { ways: [], have: 0, need: 0, coverage: 'idle', reason: '' };
      this._loading = false;
      this._load_at = null;
      this._load_t = -1e9;
      this._load_radius = 0;
      this.local_loads = 0;
      this.local_errors = 0;

      // 手势状态
      this._pointers = new Map();
      this._pinch_d = 0;
      this._attached = null;
      this._on = null;
      this._pending = false;

      this._last_t = -1e9;
      this.min_period_ms = Number.isFinite(o.min_period_ms) ? o.min_period_ms : MIN_PERIOD_MS;
      this.stats = {
        frames: 0, last_ms: 0, max_ms: 0, segs: 0, pts: 0, drawn_segs: 0,
        culled_segs: 0, source: 'none', gestures: 0,
      };
      this._status_cache = '';
    }

    // -- 视图 --------------------------------------------------------------

    /** 当前视图（没有就按 seed / 位置建一个）。返回 null = 连中心都还没有。 */
    ensure_view() {
      if (this.view !== null) return this.view;
      const pos = this.read_pos();
      const c = pos || this._center_seed;
      if (!c) return null;
      this.view = make_view({ lat: c[0], lon: c[1], zoom: this.zoom,
                              w: this.css_w, h: this.css_h });
      return this.view;
    }

    /** 把中心挪到 (lat, lon)；keep_zoom=false 时用 this.zoom 重置缩放。 */
    set_center(lat, lon, keep_zoom) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const z = keep_zoom === false ? this.zoom
        : (this.view ? this.view.zoom : this.zoom);
      const w = this.view ? this.view.w : this.css_w;
      const h = this.view ? this.view.h : this.css_h;
      this.view = make_view({ lat: lat, lon: lon, zoom: z, w: w, h: h });
      return this.view;
    }

    /** 回到当前位置：打开跟随，下一帧把中心挪过去。 */
    recenter() {
      this.follow = true;
      const pos = this.read_pos();
      if (pos) this.set_center(pos[0], pos[1], true);
      this.invalidate();
      return this.follow;
    }

    /** 缩放（不改变跟随意愿）。 */
    zoom_by(delta, ax, ay) {
      const v = this.ensure_view();
      if (!v) return null;
      this.view = zoom_at(v, v.zoom + _num(delta, 0), ax, ay);
      this.invalidate();
      return this.view;
    }

    /** 拖动（用户手势 -> 关掉跟随，见文件头）。 */
    drag_by(dx, dy) {
      const v = this.ensure_view();
      if (!v) return null;
      this.follow = false;
      this.view = pan_by(v, _num(dx, 0), _num(dy, 0));
      this.stats.gestures += 1;
      this.invalidate();
      return this.view;
    }

    /** 双指：以 (ax, ay) 为锚缩放 factor 倍，同时跟着中点平移 (dx, dy)。 */
    pinch(ax, ay, factor, dx, dy) {
      const v = this.ensure_view();
      if (!v) return null;
      this.follow = false;
      let out = v;
      if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
        out = zoom_at(out, out.zoom + Math.log(factor) / Math.LN2, ax, ay);
      }
      if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
        out = pan_by(out, dx, dy);
      }
      this.stats.gestures += 1;
      this.view = out;
      this.invalidate();
      return out;
    }

    // -- 数据 --------------------------------------------------------------

    read_pos() {
      if (!this.pos_provider) return null;
      try { return _pos_of(this.pos_provider()); } catch (_e) { return null; }
    }

    read_route() {
      if (!this.route_provider) return null;
      try {
        const r = this.route_provider();
        return (r && r.length >= 2) ? r : null;
      } catch (_e) { return null; }
    }

    /** 要读多大一圈本地瓦片（米）：视图对角半径 × 系数 + 余量。 */
    load_radius_m() {
      const v = this.view;
      if (!v) return 0;
      return Math.hypot(v.w, v.h) * 0.5 * v.mpp * LOCAL_RADIUS_K + LOCAL_RADIUS_PAD_M;
    }

    /**
     * 后台读一次本地瓦片（**不联网**）。
     *
     * 三道闸门（满足任一才真去读）：位置动了够远、离上次够久、**要的范围明显变大**
     * （缩小视图之后要的瓦片多了，不该等满一个周期）。
     *
     * ⚠️ 这三道闸门是**必须**的，而且这里**不能**再暴露一个"强制"入口给 tick：
     *    tick 会被 invalidate() 直接调起来，而加载完成的回调又会调 invalidate() ——
     *    一旦"每次 tick 都强制重读"，就变成 读->tick->再读 的自激循环，
     *    症状是浏览器/Node 直接把内存吃爆（这条真的踩过一次）。
     *    闸门在**发起请求时**就更新（不等回调），所以这个循环天然断掉。
     */
    _refresh_local() {
      if (!this.load_local || this._loading) return false;
      const v = this.view;
      if (!v) return false;
      const now = this._now_ms();
      const moved = this._load_at
        ? nm.distance_m(v.lat, v.lon, this._load_at[0], this._load_at[1]) : Infinity;
      const r = this.load_radius_m();
      const grew = !(this._load_radius > 0) || r > this._load_radius * 1.3;
      if (moved < LOCAL_MIN_MOVE_M && (now - this._load_t) < LOCAL_MIN_PERIOD_MS && !grew) {
        return false;
      }
      this._loading = true;
      this._load_t = now;
      this._load_at = [v.lat, v.lon];
      this._load_radius = r;
      const lat = v.lat;
      const lon = v.lon;
      Promise.resolve()
        .then(() => this.load_local(lat, lon, r))
        .then((res) => {
          this._loading = false;
          if (!res) return;
          this.local = {
            ways: Array.isArray(res.ways) ? res.ways : [],
            have: Array.isArray(res.have) ? res.have.length : 0,
            need: Array.isArray(res.need) ? res.need.length : 0,
            coverage: res.coverage || 'unknown',
            reason: res.reason || '',
          };
          this.local_loads += 1;
          this.invalidate();
        })
        .catch((e) => {
          // 本地读失败（存储坏了/没有 IndexedDB）：**只影响这一层**，
          // 地图继续画手上有的东西，绝不能变成一个异常。
          this._loading = false;
          this.local_errors += 1;
          this.log(`[mapview] 本地瓦片读取失败（地图继续画已有的数据）：${e}`);
        });
      return true;
    }

    /** 把本地路网那一层扔掉（界面上"关掉街道路网底图"时调）。 */
    drop_local() {
      this.local = { ways: [], have: 0, need: 0, coverage: 'off', reason: '' };
      this._load_at = null;
      this._load_radius = 0;
      this.invalidate();
    }

    /** 这一帧要画的路网从哪来（见文件头"数据从哪来"）。 */
    pick_ways() {
      let own = null;
      if (this.ways) {
        try { own = this.ways(); } catch (_e) { own = null; }
      }
      if (own && own.length) return { ways: own, source: 'live' };
      if (this.local.ways.length) return { ways: this.local.ways, source: 'local' };
      return { ways: [], source: 'none' };
    }

    /** 把这一帧要用到的一切抓成一个快照（画的时候不再碰外部状态）。 */
    snapshot() {
      const w = this.pick_ways();
      return {
        view: this.view,
        ways: w.ways,
        source: w.source,
        route: this.read_route(),
        pos: this.read_pos(),
        local: this.local,
        follow: this.follow,
      };
    }

    // -- 尺寸 / DPR --------------------------------------------------------

    _dpr() {
      if (this._dpr_fn) { try { return Math.max(1, this._dpr_fn() || 1); } catch (_e) { /* 忽略 */ } }
      const w = this._win;
      const v = (w && Number.isFinite(w.devicePixelRatio)) ? w.devicePixelRatio : 1;
      return Math.max(1, v || 1);
    }

    /**
     * 按 CSS 尺寸 × DPR 设置画布像素尺寸，并把绘制坐标系缩回 CSS 像素。
     *
     * ⚠️ 不这么做的症状是"手机上地图糊、线宽虚"，而且因为 CSS 尺寸没变，
     *    看起来完全像"显卡/浏览器的问题"，极难查到源头。
     */
    resize() {
      const c = this.canvas;
      const dpr = this._dpr();
      let w = this.css_w;
      let h = this.css_h;
      if (c) {
        // clientWidth 在 canvas 元素上就是它被布局出来的 CSS 尺寸
        if (Number.isFinite(c.clientWidth) && c.clientWidth > 0) w = c.clientWidth;
        else if (Number.isFinite(c.width) && c.width > 0) w = c.width;
        if (Number.isFinite(c.clientHeight) && c.clientHeight > 0) h = c.clientHeight;
        else if (Number.isFinite(c.height) && c.height > 0) h = c.height;
      }
      this.css_w = Math.max(1, Math.round(w));
      this.css_h = Math.max(1, Math.round(h));
      this.dpr = dpr;
      if (c) {
        const pw = Math.max(1, Math.round(this.css_w * dpr));
        const ph = Math.max(1, Math.round(this.css_h * dpr));
        if (c.width !== pw) c.width = pw;
        if (c.height !== ph) c.height = ph;
      }
      if (this.view !== null) {
        this.view = resize_view(this.view, this.css_w, this.css_h);
      }
      return [this.css_w, this.css_h, dpr];
    }

    _get_ctx() {
      if (this.ctx) return this.ctx;
      if (!this.canvas) return null;
      try {
        if (typeof this.canvas.getContext === 'function') return this.canvas.getContext('2d');
      } catch (_e) { /* 没有 2D 上下文：下面按"没得画"处理 */ }
      return null;
    }

    // -- 渲染 --------------------------------------------------------------

    /**
     * 走一帧。返回 true 表示真的画了。
     *
     * 节流（min_period_ms）+ 全量重画的取舍：地图是**每一帧都变**的东西
     * （位置在动、手势在动），局部重绘要维护一堆脏矩形，而 240×240 一屏
     * 折线的实测成本远低于维护脏矩形的复杂度。节流才是这里该做的事。
     */
    tick(force) {
      const now = this._now_ms();
      if (!force && (now - this._last_t) < this.min_period_ms) return false;
      const ctx = this._get_ctx();
      if (!ctx) return false;

      this.resize();
      if (this.follow) {
        const pos = this.read_pos();
        if (pos) this.set_center(pos[0], pos[1], true);
        else if (this.view === null) this.ensure_view();
      } else if (this.view === null) {
        this.ensure_view();
      }
      if (this.view === null) return false;

      this._refresh_local();
      const snap = this.snapshot();
      const t0 = this._now_ms();
      this.draw(ctx, snap);
      const ms = this._now_ms() - t0;
      this.stats.frames += 1;
      this.stats.last_ms = ms;
      if (ms > this.stats.max_ms) this.stats.max_ms = ms;
      this._last_t = now;
      this._emit_status(snap);
      return true;
    }

    /**
     * 标记需要重画。
     *
     * 有 requestAnimationFrame 就等下一帧（浏览器里这是最省的做法：一次手势
     * 里连着好几个 pointermove 只会重画一次）；**没有就当场画** ——
     * 否则手势在那种环境里会变成"怎么拖都不动"，而且没有任何报错。
     */
    invalidate() {
      const w = this._win;
      if (this._pending) return;
      if (w && typeof w.requestAnimationFrame === 'function') {
        this._pending = true;
        try {
          w.requestAnimationFrame(() => { this._pending = false; this.tick(true); });
          return;
        } catch (_e) { this._pending = false; }
      }
      this.tick(true);
    }

    /**
     * 画一帧。**纯函数式**：只读 (ctx, snap)，不读任何外部状态 ——
     * 所以自测可以拿一个记录型 ctx 直接喂快照，不需要 canvas、不需要浏览器。
     */
    draw(ctx, snap) {
      const v = snap.view;
      if (!v) return null;
      const g = ctx;
      const dpr = this.dpr;
      if (typeof g.setTransform === 'function') g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 线宽/字号一律按 CSS 像素给（见文件头 DPR 那段）
      if ('lineCap' in g) g.lineCap = 'round';
      if ('lineJoin' in g) g.lineJoin = 'round';

      g.fillStyle = BG;
      g.fillRect(0, 0, v.w, v.h);

      this._prep(v);
      const wscale = width_scale(v.zoom);
      const bounds = visible_bounds(v);
      // 视图之外多少度以内的折线仍然要画：屏幕上留一点余量（线宽 + 箭头），
      // 否则贴边的路会在视口边缘"断头"。
      const pad_deg = (8.0 + 6.0 * wscale) * v.mpp / EARTH_M_PER_DEG_LAT;

      // ---- ① 路网：按 rank 分组，一组一次 beginPath/stroke --------------
      const report = this._draw_roads(g, v, snap.ways, bounds, pad_deg, wscale);

      // ---- ② 航线 --------------------------------------------------------
      this._draw_route(g, v, snap.route, wscale);

      // ---- ③ 位置 + 朝向 --------------------------------------------------
      this._draw_pos(g, v, snap.pos);

      // ---- ④ 比例尺 / 指北 / 角标 ----------------------------------------
      this._draw_scale(g, v);
      this._draw_north(g, v);
      this._draw_badges(g, v, snap, report);

      this.stats.segs = snap.ways.length;
      this.stats.pts = report.pts;
      this.stats.drawn_segs = report.drawn;
      this.stats.culled_segs = report.culled;
      this.stats.source = snap.source;
      return report;
    }

    /**
     * 投影的**热路径**版本：公式和 `project()` 逐字相同，只是把
     * `w/2 + de/mpp` 里那两次除法提前算成 `kx/ky` 两个乘数、并写进调用方
     * 给的数组里（**不分配**）。
     *
     * ⚠️ 这段和 `project()` 必须永远是同一个式子 —— 自测里有一条
     *    "内联投影 == project()，逐位相等"钉着它（80 万个点）。
     */
    _proj_into(v, lat, lon, out) {
      out[0] = v._cx + nm.wrap180(lon - v.lon) * v._kx;
      out[1] = v._cy - (lat - v.lat) * v._ky;
      return out;
    }

    /** 把 w/h/mpp/k_lon 折成热路径要用的四个数（每次 draw 一次）。 */
    _prep(v) {
      v._cx = v.w * 0.5;
      v._cy = v.h * 0.5;
      v._kx = v.k_lon / v.mpp;
      v._ky = EARTH_M_PER_DEG_LAT / v.mpp;
      return v;
    }

    /** 路网。返回 {segs, drawn, culled, pts}（只用于诊断/自测）。 */
    _draw_roads(g, v, ways, bounds, pad_deg, wscale) {
      const out = { segs: ways ? ways.length : 0, drawn: 0, culled: 0, pts: 0 };
      if (!ways || ways.length === 0) return out;
      const xy = [0, 0];

      // 分组：rank -> 折线数组。用 Map 而不是对象，rank 可能是任意数字。
      const groups = new Map();
      for (let i = 0; i < ways.length; i += 1) {
        const seg = ways[i];
        const geom = seg[1];
        if (!geom || geom.length < 2) continue;
        if (!seg_visible(geom, bounds, pad_deg)) { out.culled += 1; continue; }
        const rank = Math.round(_num(seg[0], 99));
        let arr = groups.get(rank);
        if (arr === undefined) { arr = []; groups.set(rank, arr); }
        arr.push(geom);
      }
      // 等级高的（数字小）**先画**，这样低等级的路压在下面（叠加顺序稳定，
      // 不随数据顺序变化 —— 同一片路网每次画出来必须长得一样）。
      const ranks = Array.from(groups.keys()).sort((a, b) => a - b);

      for (const rank of ranks) {
        const st = rank_style(rank);
        const lw = Math.max(0.8, st.width * wscale);
        g.strokeStyle = st.color;
        g.lineWidth = lw;
        g.beginPath();
        const segs = groups.get(rank);
        for (let s = 0; s < segs.length; s += 1) {
          const geom = segs[s];
          let px = 0, py = 0, has = false;
          let moved = false;
          const n = geom.length;
          for (let i = 0; i < n; i += 1) {
            const gp = geom[i];
            this._proj_into(v, gp[0], gp[1], xy);
            const x = xy[0], y = xy[1];
            if (!has) {
              g.moveTo(x, y);
              has = true; moved = true;
              px = x; py = y; out.pts += 1;
              continue;
            }
            // 屏幕空间抽稀：挨得太近的点不画（1 像素以下看不出区别，
            // 但在几十公里的瓦片里这种点是多数）。**最后一个点永远画**，
            // 否则线的末端会短一截。
            const dx = x - px, dy = y - py;
            if (i !== n - 1 && (dx > -MIN_STEP_PX && dx < MIN_STEP_PX)
                && (dy > -MIN_STEP_PX && dy < MIN_STEP_PX)) {
              continue;
            }
            g.lineTo(x, y);
            px = x; py = y; out.pts += 1;
          }
          if (moved) out.drawn += 1;
        }
        g.stroke();
      }
      return out;
    }

    /** 航线：先描一圈深色底再画亮线（压在所有道路之上）。 */
    _draw_route(g, v, route, wscale) {
      if (!route || route.length < 2) return 0;
      const lw = Math.max(3.0, ROUTE_WIDTH * wscale);
      const layers = [
        { color: ROUTE_CASING, width: lw + 3.0 },
        { color: ROUTE_COLOR, width: lw },
      ];
      const xy = [0, 0];
      const n = route.length;
      for (const layer of layers) {
        g.strokeStyle = layer.color;
        g.lineWidth = layer.width;
        g.beginPath();
        let px = 0, py = 0;
        for (let i = 0; i < n; i += 1) {
          const rp = route[i];
          this._proj_into(v, rp[0], rp[1], xy);
          const x = xy[0], y = xy[1];
          if (i === 0) {
            g.moveTo(x, y);
          } else {
            const dx = x - px, dy = y - py;
            if (i !== n - 1 && dx > -MIN_STEP_PX && dx < MIN_STEP_PX
                && dy > -MIN_STEP_PX && dy < MIN_STEP_PX) {
              continue;
            }
            g.lineTo(x, y);
          }
          px = x; py = y;
        }
        g.stroke();
      }
      return n;
    }

    /**
     * 当前位置 + 朝向箭头。
     *
     * ⚠️ 朝向是**地理方位角**（0 = 正北，顺时针）。地图北朝上，所以屏幕上
     *    直接就是"绕中心顺时针转 heading 度"——不需要减掉任何视图旋转角
     *    （地图不转，见文件头）。设备那块圆屏是车头朝上的，它那边才需要
     *    减 heading，两处别搞混。
     */
    _draw_pos(g, v, pos) {
      if (!pos) return false;
      const p = project(v, pos[0], pos[1]);
      const x = p[0], y = p[1];
      const hdg = pos[2];
      // 定位到屏幕外就只画箭头方向（画在边缘会误导，干脆整块跳过）
      if (x < -20 || y < -20 || x > v.w + 20 || y > v.h + 20) return false;

      if (hdg !== null) {
        const a = hdg * DEG2RAD;
        const sa = Math.sin(a), ca = Math.cos(a);
        const len = 15.0, half = 7.0;
        // 屏幕坐标：北 = -y。箭头尖端 = 中心 + len * (sin a, -cos a)
        const tipx = x + len * sa, tipy = y - len * ca;
        const lx = x - half * ca, ly = y - half * sa;   // 左后
        const rx = x + half * ca, ry = y + half * sa;   // 右后
        g.fillStyle = POS_COLOR;
        g.beginPath();
        g.moveTo(tipx, tipy);
        g.lineTo(lx, ly);
        g.lineTo(x, y);
        g.lineTo(rx, ry);
        g.closePath();
        g.fill();
      }
      // 车标本体：绿点 + 深色圈（在任何底色的路上都能看清）
      g.fillStyle = POS_RING;
      g.beginPath();
      if (typeof g.arc === 'function') g.arc(x, y, 6.0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = POS_COLOR;
      g.beginPath();
      if (typeof g.arc === 'function') g.arc(x, y, 4.2, 0, Math.PI * 2);
      g.fill();
      return true;
    }

    /** 比例尺（左下角）：一根横线 + 两端小竖线 + 上面的米数。 */
    _draw_scale(g, v) {
      const bar = scale_bar(v, Math.min(72.0, Math.max(40.0, v.w * 0.28)));
      const x0 = 10.0;
      const y0 = v.h - 12.0;
      const x1 = x0 + bar.px;
      g.strokeStyle = '#e9eff7';
      g.lineWidth = 2.0;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y0);
      g.moveTo(x0, y0 - 4.0);
      g.lineTo(x0, y0 + 3.0);
      g.moveTo(x1, y0 - 4.0);
      g.lineTo(x1, y0 + 3.0);
      g.stroke();
      this._text(g, `${bar.text} · 北朝上`, x0, y0 - 7.0, 10.0, '#e9eff7', 'left', 'bottom');
      return bar;
    }

    /** 右上角一个"N"（地图永远是北朝上，见文件头）。 */
    _draw_north(g, v) {
      const x = v.w - 14.0;
      const y = 16.0;
      g.fillStyle = 'rgba(233,239,247,0.9)';
      g.beginPath();
      g.moveTo(x, y - 9.0);
      g.lineTo(x - 5.0, y + 3.0);
      g.lineTo(x, y + 0.5);
      g.lineTo(x + 5.0, y + 3.0);
      g.closePath();
      g.fill();
      this._text(g, 'N', x, y + 6.0, 10.0, '#e9eff7', 'center', 'top');
    }

    /** 左上角状态角标：路网从哪来、块数、跟随还是自由查看。 */
    _draw_badges(g, v, snap, report) {
      let text;
      if (snap.source === 'none') {
        text = '暂无路网（本地无缓存）';
      } else {
        const src = snap.source === 'local' ? '离线瓦片' : '本地路网';
        const cov = snap.local && snap.local.need
          ? ` ${snap.local.have}/${snap.local.need}块` : '';
        text = `${src}${cov} · ${report.drawn}段`;
      }
      const line2 = snap.follow ? '跟随当前位置' : '自由查看（点「回到当前位置」）';
      const wpx = Math.max(this._text_w(g, text, 10.5), this._text_w(g, line2, 10.5)) + 12.0;
      g.fillStyle = BADGE_BG;
      g.fillRect(6.0, 6.0, wpx, 26.0);
      this._text(g, text, 12.0, 10.0, 10.5, TEXT_COLOR, 'left', 'top');
      this._text(g, line2, 12.0, 21.0, 9.5, DIM_COLOR, 'left', 'top');
    }

    /** 一行字。测量宽度失败（自测里的假 ctx）就按字号粗估。 */
    _text(g, s, x, y, size, color, align, baseline) {
      if (typeof g.fillText !== 'function') return;
      g.fillStyle = color;
      if ('font' in g) g.font = `${size}px system-ui, sans-serif`;
      if ('textAlign' in g) g.textAlign = align || 'left';
      if ('textBaseline' in g) g.textBaseline = baseline || 'top';
      g.fillText(s, x, y);
    }

    _text_w(g, s, size) {
      if (typeof g.measureText === 'function') {
        try {
          const m = g.measureText(s);
          if (m && Number.isFinite(m.width)) return m.width;
        } catch (_e) { /* 忽略 */ }
      }
      // 中文按 1.0 em、西文按 0.55 em 粗估（只用于角标底色宽度）
      return String(s).length * size * 0.72;
    }

    // -- 状态 --------------------------------------------------------------

    /** 给界面用的状态（对象形状和 map.js 的 status() 一个路数）。 */
    status() {
      const v = this.view;
      const src = this.stats.source;
      let state = 'idle';
      let short = '—';
      if (!v) {
        state = 'unavailable';
        short = '无中心';
      } else if (src === 'none') {
        state = (this.local_errors > 0) ? 'unavailable' : 'empty';
        short = '暂无路网';
      } else if (src === 'local') {
        state = 'offline';
        short = '离线';
      } else {
        state = 'ok';
        short = '已就绪';
      }
      const cov = this.local.need
        ? `本地瓦片 ${this.local.have}/${this.local.need} 块` : '本地瓦片 0 块';
      const parts = [
        cov,
        `${this.stats.drawn_segs} 段 / ${this.stats.pts} 点`,
        this.follow ? '跟随中' : '自由查看',
        v ? `z${v.zoom.toFixed(1)} · ${v.mpp.toFixed(2)} m/像素` : '',
        v ? `${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}` : '',
      ].filter(Boolean);
      return {
        state: state,
        short: short,
        detail: parts.join(' · '),
        source: src,
        zoom: v ? v.zoom : null,
        mpp: v ? v.mpp : null,
        follow: this.follow,
        segs: this.stats.segs,
        drawn_segs: this.stats.drawn_segs,
        pts: this.stats.pts,
        local_have: this.local.have,
        local_need: this.local.need,
        local_coverage: this.local.coverage,
      };
    }

    _emit_status(snap) {
      if (!this.on_status) return;
      const st = this.status();
      const key = `${st.state}|${st.detail}|${st.short}`;
      if (key === this._status_cache) return;   // 每帧都写 DOM 是白费电
      this._status_cache = key;
      try { this.on_status(st, snap); } catch (e) { this.log(`[mapview] on_status 抛错：${e}`); }
    }

    // -- 手势 --------------------------------------------------------------

    /** canvas 坐标（优先 offsetX/Y；没有就用 getBoundingClientRect 换算）。 */
    _local(e) {
      if (Number.isFinite(e.offsetX) && Number.isFinite(e.offsetY)) return [e.offsetX, e.offsetY];
      const c = this.canvas;
      if (c && typeof c.getBoundingClientRect === 'function') {
        const r = c.getBoundingClientRect();
        return [(_num(e.clientX, 0) - r.left), (_num(e.clientY, 0) - r.top)];
      }
      return [_num(e.clientX, 0), _num(e.clientY, 0)];
    }

    /**
     * 挂上触摸/鼠标/滚轮。**幂等**：重复调不会挂两遍。
     *
     * 用 Pointer Events（不是 Touch Events）：Android Chrome / WebView 都支持，
     * 而且鼠标和手指走同一条路径 —— 桌面上调试时行为一致，不用两套代码。
     */
    attach(target) {
      const el = target || this.canvas;
      if (!el || typeof el.addEventListener !== 'function') return false;
      if (this._attached === el) return true;
      if (this._attached) this.detach();
      const self = this;
      const on = (name, fn, opts) => {
        try { el.addEventListener(name, fn, opts); } catch (_e) { el.addEventListener(name, fn); }
      };
      this._on = {
        down(e) {
          const id = e.pointerId === undefined ? 1 : e.pointerId;
          self._pointers.set(id, self._local(e));
          // 第二根手指一落下就把"当前两指距离"记成基准 —— 不记的话，双指缩放
          // 要等到**第二次** move 才动（第一次只建基准），手感上像"愣了一下"。
          if (self._pointers.size >= 2) {
            const pts = Array.from(self._pointers.values());
            self._pinch_d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
          }
          if (typeof el.setPointerCapture === 'function' && e.pointerId !== undefined) {
            try { el.setPointerCapture(e.pointerId); } catch (_e) { /* 忽略 */ }
          }
        },
        move(e) {
          const id = e.pointerId === undefined ? 1 : e.pointerId;
          const prev = self._pointers.get(id);
          if (!prev) return;
          const now = self._local(e);
          const dx = now[0] - prev[0];
          const dy = now[1] - prev[1];
          self._pointers.set(id, now);
          if (self._pointers.size >= 2) {
            // 双指：距离变化 = 缩放，中点变化 = 平移
            const pts = Array.from(self._pointers.values());
            const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
            const mx = (pts[0][0] + pts[1][0]) * 0.5;
            const my = (pts[0][1] + pts[1][1]) * 0.5;
            const factor = (self._pinch_d > 0 && d > 0) ? (d / self._pinch_d) : 1;
            self._pinch_d = d;
            self.pinch(mx, my, factor, dx * 0.5, dy * 0.5);
          } else if (dx !== 0 || dy !== 0) {
            self.drag_by(dx, dy);
          }
          if (e.preventDefault) e.preventDefault();
        },
        up(e) {
          const id = e.pointerId === undefined ? 1 : e.pointerId;
          self._pointers.delete(id);
          if (self._pointers.size < 2) self._pinch_d = 0;
        },
        wheel(e) {
          // 滚轮一格约 deltaY = 100（Chrome）。除以 400 就是"四格一档"，
          // 和双击一档的手感接近。
          const d = _num(e.deltaY, 0);
          if (d === 0) return;
          const p = self._local(e);
          self.follow = false;
          self.zoom_by(-d / 400.0, p[0], p[1]);
          if (e.preventDefault) e.preventDefault();
        },
        dblclick(e) {
          const p = self._local(e);
          self.follow = false;
          self.zoom_by(1.0, p[0], p[1]);
          if (e.preventDefault) e.preventDefault();
        },
      };
      on('pointerdown', this._on.down);
      on('pointermove', this._on.move);
      on('pointerup', this._on.up);
      on('pointercancel', this._on.up);
      on('pointerleave', this._on.up);
      on('wheel', this._on.wheel, { passive: false });
      on('dblclick', this._on.dblclick);
      this._attached = el;
      return true;
    }

    detach() {
      const el = this._attached;
      if (!el || !this._on) return false;
      el.removeEventListener('pointerdown', this._on.down);
      el.removeEventListener('pointermove', this._on.move);
      el.removeEventListener('pointerup', this._on.up);
      el.removeEventListener('pointercancel', this._on.up);
      el.removeEventListener('pointerleave', this._on.up);
      el.removeEventListener('wheel', this._on.wheel);
      el.removeEventListener('dblclick', this._on.dblclick);
      this._attached = null;
      this._on = null;
      this._pointers.clear();
      this._pinch_d = 0;
      return true;
    }

    /** 布局变了（旋转屏幕 / 展开面板）之后调一次。 */
    on_resize() {
      this.resize();
      this.invalidate();
    }
  }

  return {
    MapView,
    // 纯函数（自测直接喂参数对拍，不需要 canvas、不需要浏览器）
    make_view, resize_view, project, unproject, pan_by, zoom_at,
    visible_bounds, seg_visible, rank_style, width_scale,
    mpp_of, zoom_of_mpp, clamp_zoom, nice_meters, scale_bar,
    // 常量
    BASE_MPP, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM, DEFAULT_W, DEFAULT_H,
    MAX_LAT, EARTH_M_PER_DEG_LAT, EARTH_M_PER_DEG_LON_EQ,
    ROAD_STYLE, ROAD_STYLE_FALLBACK, ROUTE_COLOR, ROUTE_WIDTH, POS_COLOR, BG,
    WIDTH_BASE_ZOOM, MIN_STEP_PX, MIN_PERIOD_MS,
    LOCAL_MIN_PERIOD_MS, LOCAL_MIN_MOVE_M, LOCAL_RADIUS_K, LOCAL_RADIUS_PAD_M,
    _pos_of, _lon_within, _seg_bbox,
  };
}));
