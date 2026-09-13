/*
 * NavPuck **手机端地图视图** 自测（phone/mapview.js）。
 *
 * 前面五套测的是协议 / 导航语义 / 离线瓦片 / 接线 / 界面。这一套测的是这一版
 * 新加的那块"用户终于能在手机上看到地图"的东西。它值得单独一套，因为这里
 * 有三件事**错了都不会在开发机上炸**，只会在手机上表现为"图不对"：
 *
 *   1) **投影**。地图上的位置和导航算出来的位置必须落在同一个数上。差一点点
 *      （比如 cos(lat) 用错、或者 y 轴没翻）在屏幕上就是"车在路外面"，
 *      而代码本身跑得好好的 —— 所以这一节全是"给定 lat/lon -> 期望屏幕坐标
 *      -> 实测"的对拍，公式在**这里独立写一遍**，不复用 mapview.js 的。
 *   2) **离线**。用户的场景是"骑到没信号的地方，地图还得在"。所以这一节用
 *      **一个只会抛错的 fetch** 把网络彻底掐死，然后从本地瓦片（.npt / NPK1
 *      打包两种形态）把路网读出来、真的画一遍，并断言 fetch 一次都没被调到。
 *   3) **渲染本身**。没有浏览器、也不该引 canvas 这种原生依赖，所以用
 *      **记录型 ctx**（把每一个 moveTo/lineTo/stroke/arc/fillText 记下来）来钉
 *      图层顺序、线宽、抽稀、裁剪、车标方向这些东西；设了 NAVPUCK_MV_PNG 时
 *      还会把同一批调用真的栅格化成一张 PNG（见 phone/test/pngctx.mjs），
 *      用来**肉眼**确认它真的长成一张地图。
 *
 * 怎么跑（在 navpuck 根目录）：
 *     node phone/test/mapview.mjs
 *     $env:NAVPUCK_MV_PNG = "D:\dsh\navpuck\phone\test\out\map.png"   # 可选：出图
 *
 * 性能那一节（第 8 节）打印的是**真实测量值**，但边界要说清楚：它量的是
 * **JS 侧**（投影 + 路径构造 + 记录型 ctx 的调用开销），**不包含**浏览器的
 * 光栅化/合成。开发机上没有可用的无头浏览器（Edge/Chrome 都没装），所以
 * 这一条只能如实写在这里，不能假装量到了 GPU 那一侧。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(PHONE_DIR, '..');

const NM = require(path.join(PHONE_DIR, 'navmath.js'));
const RT = require(path.join(PHONE_DIR, 'route.js'));
const TL = require(path.join(PHONE_DIR, 'tiles.js'));
const MV = require(path.join(PHONE_DIR, 'mapview.js'));

// ---------------------------------------------------------------------------
// 测试框架（和别的几套保持同一种输出形状）
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let group = '';
// ⚠️ 和 tiles.mjs 里那条一模一样的防静默闸门：async IIFE 收尾少写了 () 的话
//    那一节会**什么都没跑**，而输出看起来完全正常（标题打了、没有 ✗）。
let _last_total = -1;
let _last_name = '(开始)';
function section(n) {
  const total = passed + failures.length;
  if (total === _last_total) {
    const msg = `自测自身：上一节「${_last_name}」一条断言都没有执行 —— ` +
      '多半是 async IIFE 忘了调用（结尾写成 }); 而不是 })();）';
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
  _last_total = total;
  _last_name = n;
  group = n;
  console.log(`\n[${n}]`);
}
function end_sections() {
  if (passed + failures.length === _last_total) {
    const msg = `自测自身：最后一节「${_last_name}」一条断言都没有执行`;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function ok(c, l) {
  if (c) { passed += 1; console.log(`  ✓ ${l}`); }
  else { failures.push(`${group} :: ${l}`); console.log(`  ✗ ${l}`); }
}
function eq(a, b, l) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x === y) { passed += 1; console.log(`  ✓ ${l}`); }
  else {
    failures.push(`${group} :: ${l}\n      期望 ${y}\n      实得 ${x}`);
    console.log(`  ✗ ${l}\n      期望 ${y}\n      实得 ${x}`);
  }
}
function near(a, b, l, tol) {
  const t = tol === undefined ? 1e-9 : tol;
  const scale = Math.max(1, Math.abs(b));
  if (Number.isFinite(a) && Math.abs(a - b) <= t * scale) {
    passed += 1; console.log(`  ✓ ${l}  (${a})`);
  } else {
    failures.push(`${group} :: ${l}\n      期望 ${b}\n      实得 ${a}`);
    console.log(`  ✗ ${l}\n      期望 ${b}\n      实得 ${a}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 记录型 2D 上下文：把 mapview 真正发出的每一个调用记下来。
//
// 刻意**不实现**任何真正的绘图 —— 它要回答的是"代码有没有按我们以为的顺序、
// 用我们以为的颜色和线宽去画"，而不是"像素长什么样"（像素那件事交给
// pngctx.mjs，只在设了环境变量时做）。
// ---------------------------------------------------------------------------
class RecCtx {
  constructor() {
    this.ops = [];
    this.groups = [];        // 每次 stroke() 一组的路径（用来把"路网"和"装饰"分开数）
    this.path = [];
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.font = '';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.transforms = [];
  }
  _push(op, extra) { this.ops.push(Object.assign({ op: op, fill: this.fillStyle,
    stroke: this.strokeStyle, lw: this.lineWidth }, extra || {})); }
  setTransform(a, b, c, d, e, f) { this.transforms.push([a, b, c, d, e, f]); }
  fillRect(x, y, w, h) { this._push('fillRect', { x, y, w, h }); }
  beginPath() { this._push('beginPath'); this.path = []; }
  moveTo(x, y) { this._push('moveTo', { x, y }); this.path.push(['moveTo', x, y]); }
  lineTo(x, y) { this._push('lineTo', { x, y }); this.path.push(['lineTo', x, y]); }
  closePath() { this._push('closePath'); this.path.push(['closePath']); }
  stroke() {
    this._push('stroke');
    this.groups.push({ style: this.strokeStyle, lw: this.lineWidth, ops: this.path });
    this.path = [];
  }
  fill() { this._push('fill'); }
  arc(x, y, r) { this._push('arc', { x, y, r }); }
  fillText(s, x, y) { this._push('fillText', { s, x, y }); }
  measureText(s) { return { width: String(s).length * 5.5 }; }
  count(op) { return this.ops.filter((o) => o.op === op).length; }
  of(op) { return this.ops.filter((o) => o.op === op); }
  /** 某个描边色的 stroke 次数（用来断言"按等级分组、一组只描一次"）。 */
  strokes_of(color) {
    return this.ops.filter((o) => o.op === 'stroke' && o.stroke === color).length;
  }
  texts() { return this.of('fillText').map((o) => o.s); }

  /**
   * 折线路径的计数（**不含**比例尺/指北标那些装饰笔画）。
   *
   * 怎么分：装饰用两个固定颜色（见 mapview.js 的 _draw_scale / _draw_north），
   * 路网和航线用 ROAD_STYLE / ROUTE_COLOR。所以按"这一组 stroke 的颜色"筛，
   * 就能把"画了几条路"和"画了几笔装饰"彻底分开 —— 直接数全局 moveTo 会被
   * 比例尺那 3 笔污染（这是一个真实的坑，我在这里就踩了一次）。
   */
  _path_count(colors) {
    let moveTo = 0, lineTo = 0;
    const segs = [];
    for (const g of this.groups) {
      if (!colors.has(g.style)) continue;
      let cur = null;
      for (const o of g.ops) {
        if (o[0] === 'moveTo') {
          moveTo += 1;
          cur = [o[1], o[2]];
          segs.push(cur);
        } else if (o[0] === 'lineTo') {
          lineTo += 1;
          if (cur) cur.push(o[1], o[2]);
        }
      }
    }
    return { moveTo: moveTo, lineTo: lineTo, segs: segs };
  }
  road_path() {
    return this._path_count(new Set(MV.ROAD_STYLE.map((s) => s.color).concat([MV.ROAD_STYLE_FALLBACK.color])));
  }
  route_path() { return this._path_count(new Set([MV.ROUTE_COLOR])); }
}

// ---------------------------------------------------------------------------
// 一个**独立**的 .npt 编码器（照着 tiles.js 文件头那段格式说明写）。
//
// 和 tiles.mjs 里同一个理由：**不复用** mapview.js/tiles.js 的任何编码代码，
// 否则只能证明"解码器和它自己一致"。这里的坐标是相对瓦片中心的**分米**。
// ---------------------------------------------------------------------------
function mk_tile(z, x, y, segs_dm) {
  const c = TL.tile_center(z, x, y);
  const lat_c = c[0], lon_c = c[1];
  const ranks = [];
  const counts = [];
  const pts = [];
  for (const [rank, dm] of segs_dm) {
    ranks.push(rank);
    counts.push(dm.length / 2);
    for (const v of dm) pts.push(v);
  }
  const pt_count = counts.reduce((a, b) => a + b, 0);
  const buf = new ArrayBuffer(20 + ranks.length * 2 + pt_count * 4);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  u8[0] = 0x4E; u8[1] = 0x50; u8[2] = 0x54; u8[3] = 0x31;    // "NPT1"
  u8[4] = 1;
  u8[5] = z;
  dv.setInt32(8, Math.round(lon_c * 1e7), true);
  dv.setInt32(12, Math.round(lat_c * 1e7), true);
  dv.setUint16(16, ranks.length, true);
  dv.setUint16(18, pt_count, true);
  for (let i = 0; i < ranks.length; i += 1) u8[20 + i] = ranks[i];
  for (let i = 0; i < counts.length; i += 1) u8[20 + ranks.length + i] = counts[i];
  let p = 20 + ranks.length * 2;
  for (const v of pts) { dv.setInt16(p, v, true); p += 2; }
  return buf;
}

/** 独立的 NPK1 打包器（照着 tiles.js 里 NPK1 那段的字段顺序写）。 */
function mk_pack(pack_z, px, py, items) {
  const n = items.length;
  const head = 14 + n * 10;
  let body = 0;
  for (const it of items) body += it[2].byteLength;
  const buf = new ArrayBuffer(head + body);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  u8[0] = 0x4E; u8[1] = 0x50; u8[2] = 0x4B; u8[3] = 0x31;    // "NPK1"
  u8[4] = 1;
  u8[5] = pack_z;
  dv.setUint16(6, n, true);
  dv.setUint16(8, 0, true);
  dv.setUint16(10, px, true);
  dv.setUint16(12, py, true);
  for (let i = 0; i < n; i += 1) u8[14 + i] = items[i][0];
  for (let i = 0; i < n; i += 1) u8[14 + n + i] = items[i][1];
  let o = head;
  for (let i = 0; i < n; i += 1) { dv.setUint32(14 + 2 * n + i * 4, o, true); o += items[i][2].byteLength; }
  for (let i = 0; i < n; i += 1) dv.setUint32(14 + 2 * n + n * 4 + i * 4, items[i][2].byteLength, true);
  o = head;
  for (const it of items) { u8.set(new Uint8Array(it[2]), o); o += it[2].byteLength; }
  return buf;
}

/** 假 localStorage（TileStore 的 sticky base 要用）。 */
function fake_storage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/** 只读的假 TileDb：把 id 映射到 ArrayBuffer。**只读** —— 写不进任何东西。 */
function fake_db(table) {
  const puts = [];
  return {
    _puts: puts,
    async get(k) { return table[k] || null; },
    async put(k, v) { puts.push(k); return k; },
    async del() { return true; },
    async keys() { return Object.keys(table); },
    async meta_get() { return null; },
    async meta_put() { return null; },
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 造 N 条随机折线（每条 pts 个点），铺满当前视图 —— 性能那一节用。 */
function gen_ways(view, n, pts, seed) {
  const rnd = mulberry32(seed === undefined ? 12345 : seed);
  const ways = [];
  const m_per_deg_lat = MV.EARTH_M_PER_DEG_LAT;
  const span_n = view.h * view.mpp;      // 视图覆盖的南北向米数
  const span_e = view.w * view.mpp;
  for (let i = 0; i < n; i += 1) {
    const rank = i % 9;
    const la0 = view.lat + (rnd() - 0.5) * span_n / m_per_deg_lat;
    const lo0 = view.lon + (rnd() - 0.5) * span_e / view.k_lon;
    const ang = rnd() * Math.PI * 2;
    const step = 8.0 + rnd() * 30.0;     // 相邻点 8~38 米（街景常见量级）
    const geom = [];
    for (let k = 0; k < pts; k += 1) {
      geom.push([
        la0 + (k * step * Math.cos(ang)) / m_per_deg_lat,
        lo0 + (k * step * Math.sin(ang)) / view.k_lon,
      ]);
    }
    ways.push([rank, geom]);
  }
  return ways;
}

// ---------------------------------------------------------------------------
// 1) index.html / sw.js / style.css 的接线
// ---------------------------------------------------------------------------
section('1] 地图真的被接进 index.html / sw.js / style.css');
{
  const HTML = fs.readFileSync(path.join(PHONE_DIR, 'index.html'), 'utf8');
  const SW = fs.readFileSync(path.join(PHONE_DIR, 'sw.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(PHONE_DIR, 'style.css'), 'utf8');
  const APP = fs.readFileSync(path.join(PHONE_DIR, 'app.js'), 'utf8');

  const scripts = [...HTML.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const i_mv = scripts.indexOf('mapview.js');
  ok(i_mv >= 0, 'index.html 里加载了 mapview.js');
  ok(scripts.indexOf('map.js') < i_mv, 'mapview.js 排在 map.js 之后');
  ok(i_mv < scripts.indexOf('app.js'), 'mapview.js 排在 app.js 之前（init() 里要用它）');

  ok(/<canvas[^>]*id="mapview"/.test(HTML), 'index.html 里有 <canvas id="mapview">');
  const cm = /<canvas[^>]*id="mapview"[^>]*>/.exec(HTML);
  ok(/\bwidth="240"/.test(cm[0]) && /\bheight="240"/.test(cm[0]),
     'canvas 的兜底像素尺寸是 240×240（设备那块圆屏的尺寸，也是性能基准）');
  for (const id of ['mapview-state', 'mapview-detail', 'mapview-here-btn',
                    'mapview-zoom-in', 'mapview-zoom-out']) {
    ok(HTML.includes(`id="${id}"`), `index.html 里有 #${id}`);
  }

  // ⭐ "放在显眼位置，不要埋在折叠面板里"：地图必须在**第一个 <details> 之前**
  //    （也就是不在任何折叠块里），而且要在状态数字面板之前。
  const i_map = HTML.indexOf('id="mapview"');
  const i_det = HTML.indexOf('<details');
  const i_grid = HTML.indexOf('<section class="panel" aria-label="实时状态">');
  ok(i_det > 0 && i_map < i_det, '地图在所有折叠面板（<details>）之前 —— 不会被折叠起来');
  ok(i_map < i_grid, '地图排在"实时状态"数字面板之前（用户第一眼看到的是地图）');

  // Service Worker：新文件必须进预缓存清单，而且缓存版本号必须 +1 ——
  // 不然手机上（缓存优先）永远吃不到这一版。
  const assets = [...SW.matchAll(/^\s*'([a-z_]+\.js)',?$/gm)].map((m) => m[1]);
  ok(assets.includes('mapview.js'), 'sw.js 的预缓存清单里有 mapview.js');
  // ⚠️ 这个版本号每加一个被预缓存的文件就要 +1（v15 加 mapview.js，v16 加 search.js）。
  //    故意写死在这里：忘了 bump，手机上的 PWA 会一直吃旧副本。
  ok(/const CACHE = 'navpuck-phone-v16'/.test(SW),
     'sw.js 的缓存版本号已经 bump 到 v16（不然手机上的 PWA 吃的是旧副本）');
  const needed = scripts.filter((s) => s !== 'mapview.js');
  eq(needed.filter((s) => !assets.includes(s)), [],
     'index.html 里的每个 <script> 都在 sw.js 的预缓存清单里');

  ok(/#mapview\s*\{[^}]*touch-action:\s*none/.test(CSS),
     'style.css 给 #mapview 关掉了浏览器默认手势（touch-action:none）—— ' +
     '不然双指缩放会变成整页缩放');
  ok(/\.map-wrap\s*\{[^}]*padding-bottom:\s*100%/.test(CSS),
     'style.css 用 padding-bottom:100% 撑出正方形画布（兼容性比 aspect-ratio 好）');

  ok(APP.includes('root.NavPuckMapView'), 'app.js 从全局取 NavPuckMapView');
  ok(/mapview_frame\(/.test(APP), 'app.js 里有 mapview_frame()（每帧/心跳都调它）');
  ok(/_mv_route/.test(APP), 'app.js 把航线折线单独存了一份给地图');
  ok(/set_mapview_route\(/.test(APP), 'app.js 在规划完成后把航线交给地图');
  for (const id of ['mapview-here-btn', 'mapview-zoom-in', 'mapview-zoom-out']) {
    ok(APP.includes(`on('${id}', 'click'`), `app.js 把 #${id} 接上了（不是只在 HTML 里摆着）`);
  }
}

// ---------------------------------------------------------------------------
// 2) 投影：给定 lat/lon -> 期望屏幕坐标 -> 实测（**独立公式对拍**）
// ---------------------------------------------------------------------------
section('2] 投影对拍（期望值用独立公式算，不复用 mapview.js 的实现）');
{
  // 常数必须和 route.js **逐位相同** —— 否则地图上量到的 100 米和导航算出来
  // 的 100 米不是同一个 100 米，而这种偏差在屏幕上（车压在路外面）才看得出来。
  eq(MV.EARTH_M_PER_DEG_LAT, RT.EARTH_M_PER_DEG_LAT,
     '纬度米/度 与 route.js 完全一致');
  eq(MV.EARTH_M_PER_DEG_LON_EQ, RT.EARTH_M_PER_DEG_LON_EQ,
     '赤道经度米/度 与 route.js 完全一致');

  const view = MV.make_view({ lat: 30.0, lon: 120.0, zoom: 16, w: 240, h: 240 });

  // ↓↓↓ 这是**照规格另写一遍**的投影（不是调 mv.project）。↓↓↓
  const BASE_MPP = 156543.03392804097;      // 赤道周长 40075016.686 / 256
  const MPD_LAT = 110540.0;
  const MPD_LON_EQ = 111320.0;
  function expect_xy(v, lat, lon) {
    const mpp = BASE_MPP / Math.pow(2, v.zoom);
    const k = MPD_LON_EQ * Math.cos(v.lat * Math.PI / 180);
    // 经度取最短弧（跨 180° 用）
    let d = (lon - v.lon) % 360;
    if (d >= 180) d -= 360;
    if (d < -180) d += 360;
    return [v.w / 2 + d * k / mpp, v.h / 2 - (lat - v.lat) * MPD_LAT / mpp];
  }

  // 黄金向量（数值是手算的，硬编码在这里 —— 手算的数字才能抓住"公式整体写错"）
  console.log('      视图：中心 (30.0, 120.0)  z16  240×240  ' +
              `mpp=${view.mpp}  k_lon=${view.k_lon}`);
  const golden = [
    ['视图中心', 30.0, 120.0, [120.0, 120.0]],
    ['正北 100 米', 30.0 + 100 / MPD_LAT, 120.0, [120.0, 78.13547345067563]],
    ['正东 100 米', 30.0, 120.0 + 100 / view.k_lon, [161.86452654952302, 120.0]],
    ['东偏 0.01°', 30.0, 120.01, [523.5989367442405, 120.0]],
    ['北偏 0.005°', 30.005, 120.0, [120.0, -111.38523823834313]],
  ];
  for (const [name, lat, lon, want] of golden) {
    const got = MV.project(view, lat, lon);
    near(got[0], want[0], `${name} -> x`, 1e-9);
    near(got[1], want[1], `${name} -> y`, 1e-9);
  }

  // 表格化的"期望 / 实测"对拍（同时验证独立公式和实现一致）
  const table = [
    [30.0, 120.0], [30.001, 120.001], [30.01, 120.02], [29.99, 119.98],
    [30.05, 120.1], [29.95, 119.9], [30.1, 120.0], [30.0, 120.5],
  ];
  let maxdiff = 0;
  for (const [lat, lon] of table) {
    const want = expect_xy(view, lat, lon);
    const got = MV.project(view, lat, lon);
    maxdiff = Math.max(maxdiff, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
  }
  near(maxdiff, 0, `8 组 lat/lon 的屏幕坐标与独立公式的最大偏差（像素）`, 1e-9);

  // 往返：project -> unproject 必须回到原点
  let rt_max = 0;
  for (const [lat, lon] of table) {
    const p = MV.project(view, lat, lon);
    const ll = MV.unproject(view, p[0], p[1]);
    rt_max = Math.max(rt_max, Math.abs(ll[0] - lat), Math.abs(ll[1] - lon));
  }
  ok(rt_max < 1e-9, `project/unproject 往返误差 < 1e-9 度（实测 ${rt_max.toExponential(2)}）`);

  // ⭐ 平移之后**必须仍然正确**：内容平移 (dx,dy) 像素，屏幕坐标就该正好
  //    移动 (dx,dy) —— 这道题在"拖动地图"那条路上每帧都要成立。
  let pan_max = 0;
  for (const [dx, dy] of [[37, -19], [-120, 55], [5, 5], [240, 240], [-1, 0]]) {
    const v2 = MV.pan_by(view, dx, dy);
    for (const [lat, lon] of table) {
      const a = MV.project(view, lat, lon);
      const b = MV.project(v2, lat, lon);
      pan_max = Math.max(pan_max, Math.abs((b[0] - a[0]) - dx), Math.abs((b[1] - a[1]) - dy));
    }
  }
  ok(pan_max < 1e-9, `平移 N 像素后屏幕坐标正好移动 N 像素（最大偏差 ${pan_max.toExponential(2)} 像素）`);

  // 拖动方向要"跟手"：手指往右拖 -> 地图内容往右走 -> 中心经度变小（西移）
  const right = MV.pan_by(view, 50, 0);
  ok(right.lon < view.lon, '手指向右拖 = 内容右移 = 视图中心往西（跟手）');
  const down = MV.pan_by(view, 0, 50);
  ok(down.lat > view.lat, '手指向下拖 = 内容下移 = 视图中心往北（跟手）');

  // ⭐ 缩放锚点不动：以 (ax,ay) 为锚缩放之后，锚点下面那个地理点**还在原地**。
  let anchor_max = 0;
  for (const [ax, ay] of [[0, 0], [240, 240], [77, 33], [120, 120]]) {
    for (const fz of [0.5, 1.5, 3.0, 0.25]) {
      const target = MV.zoom_of_mpp(view.mpp / fz);
      const v3 = MV.zoom_at(view, target, ax, ay);
      const ll = MV.unproject(view, ax, ay);         // 锚点下的地理点
      const p = MV.project(v3, ll[0], ll[1]);        // 它在新视图里的位置
      anchor_max = Math.max(anchor_max, Math.abs(p[0] - ax), Math.abs(p[1] - ay));
    }
  }
  ok(anchor_max < 1e-8, `以任意点为锚缩放后，锚点下的地理点不动（最大偏差 ${anchor_max.toExponential(2)} 像素）`);

  // 缩放级与米/像素的关系（含夹取）
  near(MV.mpp_of(16), 2.388657133911758, 'z16 -> 2.3887 米/像素', 1e-12);
  near(MV.mpp_of(17) * 2, MV.mpp_of(16), '每升一级，米/像素减半', 1e-12);
  near(MV.zoom_of_mpp(MV.mpp_of(14.3)), 14.3, 'mpp -> zoom 是 mpp_of 的严格反函数', 1e-9);
  eq(MV.clamp_zoom(99), MV.MAX_ZOOM, '缩放级上限被夹住');
  eq(MV.clamp_zoom(-5), MV.MIN_ZOOM, '缩放级下限被夹住');

  // 热路径的内联投影必须和 project() **逐位相等**（两处公式抄歪一个乘数，
  // 症状就是"少数几条路整体偏一点"，只看代码是看不出来的）
  const inst = new MV.MapView(null, { w: 240, h: 240, ctx: new RecCtx() });
  inst._prep(view);
  const out = [0, 0];
  let bit_max = 0;
  const rnd = mulberry32(7);
  for (let i = 0; i < 200000; i += 1) {
    const lat = 29.5 + rnd();
    const lon = 119.5 + rnd();
    inst._proj_into(view, lat, lon, out);
    const ref = MV.project(view, lat, lon);
    if (out[0] !== ref[0] || out[1] !== ref[1]) {
      bit_max = Math.max(bit_max, Math.abs(out[0] - ref[0]), Math.abs(out[1] - ref[1]));
    }
  }
  eq(bit_max, 0, '20 万个随机点的"热路径内联投影"与 project() 逐位相等');
}

// ---------------------------------------------------------------------------
// 3) 边界情况：空路网 / 单点 / 跨 180° / 极端缩放 / 极点
// ---------------------------------------------------------------------------
section('3] 边界情况');
{
  const view = MV.make_view({ lat: 30.0, lon: 120.0, zoom: 16, w: 240, h: 240 });

  // --- 空路网：只能有底色 + 比例尺 + 角标，一根线都不许画 ---
  {
    const ctx = new RecCtx();
    const inst = new MV.MapView(null, { w: 240, h: 240, ctx: ctx });
    inst.view = MV.make_view(view);
    const rep = inst.draw(ctx, { view: inst.view, ways: [], route: null, pos: null,
                                source: 'none', local: { have: 0, need: 0 } });
    eq(rep.drawn, 0, '空路网：一条折线都没画');
    eq(ctx.road_path().moveTo, 0, '空路网：路网一次 moveTo 都没有');
    eq(ctx.road_path().lineTo, 0, '空路网：路网一次 lineTo 都没有');
    // 比例尺（3 笔）+ 指北标（1 笔）是**装饰**，它们该在（空地图也要有尺度和方向）
    ok(ctx.count('moveTo') === 4,
       `空路网：仍然有 4 次装饰性 moveTo（比例尺 3 + 指北 1），实得 ${ctx.count('moveTo')}`);
    ok(ctx.count('fillRect') >= 1, '空路网：底色照画（不会留一块白）');
    ok(ctx.texts().some((s) => /暂无路网/.test(s)), '空路网：角标里写明"暂无路网"');
    ok(ctx.texts().some((s) => /m|km/.test(s)), '比例尺仍然存在（空地图也要有尺度感）');
  }

  // --- 单点/零长折线（数据坏掉时会遇到）：不许画线，也不许抛 ---
  {
    const ctx = new RecCtx();
    const inst = new MV.MapView(null, { w: 240, h: 240, ctx: ctx });
    inst.view = MV.make_view(view);
    const ways = [[0, [[30.0, 120.0]]], [3, []]];
    let threw = false;
    let rep = null;
    try {
      rep = inst.draw(ctx, { view: inst.view, ways: ways, route: null, pos: null,
                             source: 'local', local: { have: 1, need: 1 } });
    } catch (e) { threw = true; }
    ok(!threw, '单点/空折线不会让渲染抛异常');
    eq(rep.drawn, 0, '单点折线被跳过（画不出线的东西不画）');
    eq(ctx.road_path().lineTo, 0, '单点折线没有产生 lineTo');

    // 只有两个点的折线是能画的
    const ctx2 = new RecCtx();
    inst.draw(ctx2, { view: inst.view, ways: [[0, [[30.0, 120.0], [30.001, 120.001]]]],
                      route: null, pos: null, source: 'local', local: { have: 1, need: 1 } });
    eq(ctx2.road_path().moveTo, 1, '两点的折线画出来了（1 次 moveTo）');
    eq(ctx2.road_path().lineTo, 1, '两点的折线画出来了（1 次 lineTo）');
  }

  // --- 跨 180° 经线 ---
  {
    // 视图中心就贴在 180° 上，折线从东经一侧穿到西经一侧
    const v = MV.make_view({ lat: 0.0, lon: 179.995, zoom: 14, w: 240, h: 240 });
    const geom = [[0.0, 179.9995], [0.0, -179.9995], [0.0, -179.998], [0.0, -179.997]];
    const xs = geom.map((p) => MV.project(v, p[0], p[1])[0]);
    ok(xs.every((x) => Number.isFinite(x)), '跨 180° 的点全部投影出有限值');
    ok(xs[0] < xs[1] && xs[1] < xs[2] && xs[2] < xs[3],
       `跨 180° 的四个点 x 单调递增（没有横穿整张图）：${xs.map((x) => x.toFixed(1)).join(' < ')}`);
    const span_px = xs[3] - xs[0];
    ok(span_px > 0 && span_px < 240,
       `跨 180° 的那条路在屏幕上只有 ${span_px.toFixed(1)} px（0.0035° 经度 ≈ 39 m 的实地长度）`);
    ok(MV.seg_visible(geom, MV.visible_bounds(v), 0.001),
       '跨 180° 的折线被判定为可见（按包围盒裁剪时不许漏掉）');
    // 反过来：离得很远的一条路必须被裁掉
    ok(!MV.seg_visible([[10, 10], [10.01, 10.01]], MV.visible_bounds(v), 0.001),
       '离视图很远的折线被裁掉');
    // 视图中心恰好在 -180 附近（另一种跨法）
    const v2 = MV.make_view({ lat: 0.0, lon: -179.995, zoom: 14, w: 240, h: 240 });
    const x2 = MV.project(v2, 0.0, 179.9975)[0];
    ok(Number.isFinite(x2) && Math.abs(x2 - 120) < 120,
       `反方向跨 180° 也正确（中心 -179.995，点在 179.9975 -> x=${x2.toFixed(1)}）`);
    ok(MV.seg_visible([[0, 179.9975], [0, 179.998]], MV.visible_bounds(v2), 0.001),
       '反方向的跨线也判定为可见');
  }

  // --- 极端缩放 ---
  {
    let bad = 0;
    for (const z of [MV.MIN_ZOOM, 3.0001, 14, 19.999, MV.MAX_ZOOM]) {
      const v = MV.make_view({ lat: 45.0, lon: 8.0, zoom: z, w: 240, h: 240 });
      const p = MV.project(v, 45.001, 8.001);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) bad += 1;
      if (!(v.mpp > 0) || !Number.isFinite(v.mpp)) bad += 1;
    }
    eq(bad, 0, `从 z${MV.MIN_ZOOM} 到 z${MV.MAX_ZOOM}，投影和米/像素全部有限`);
    const zmin = MV.make_view({ lat: 0, lon: 0, zoom: -100, w: 240, h: 240 });
    eq(zmin.zoom, MV.MIN_ZOOM, '超范围的缩放级被夹到下限');
    const zmax = MV.make_view({ lat: 0, lon: 0, zoom: 1e9, w: 240, h: 240 });
    eq(zmax.zoom, MV.MAX_ZOOM, '超范围的缩放级被夹到上限');
  }

  // --- 极点附近：cos(lat) -> 0，不夹的话经度方向的米/度会退化成 0 ---
  {
    const v = MV.make_view({ lat: 89.9, lon: 0, zoom: 10, w: 240, h: 240 });
    ok(v.lat <= MV.MAX_LAT + 1e-9, `纬度被夹到 ±${MV.MAX_LAT}（实得 ${v.lat}）`);
    const p = MV.project(v, v.lat, 0.5);
    ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), '极点附近的投影仍然有限');
    const v2 = MV.make_view({ lat: 30, lon: 0, zoom: 16, w: 240, h: 240 });
    const far = MV.pan_by(v2, 0, -1e9);
    ok(far.lat >= -MV.MAX_LAT - 1e-9 && Number.isFinite(far.lat),
       '往上狂拖也不会把中心拖出墨卡托范围');
  }

  // --- 退化视图（尺寸 0 / NaN）：一律退回兜底尺寸，绝不出 NaN ---
  {
    const v = MV.make_view({ lat: 30, lon: 120, zoom: 16, w: 0, h: -5 });
    eq([v.w, v.h], [MV.DEFAULT_W, MV.DEFAULT_H], '尺寸非法时退回兜底尺寸');
    const p = MV.project(v, 30.001, 120.001);
    ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), '兜底尺寸下投影仍然有限');
    const v3 = MV.make_view({ lat: NaN, lon: NaN, zoom: NaN, w: 240, h: 240 });
    ok(Number.isFinite(v3.lat) && Number.isFinite(v3.lon) && Number.isFinite(v3.zoom),
       'NaN 的中心/缩放级被规整成有限值');
    const v4 = MV.make_view({ lat: 30, lon: 480, zoom: 16, w: 240, h: 240 });
    near(v4.lon, 120, '超出 ±180 的经度被规整回来（480 -> 120）', 1e-9);
  }

  // --- 位置在屏幕外：不画车标（画在边上会误导），但路网照画 ---
  {
    const ctx = new RecCtx();
    const inst = new MV.MapView(null, { w: 240, h: 240, ctx: ctx });
    inst.view = MV.make_view(view);
    inst.draw(ctx, { view: inst.view, ways: [[0, [[30.0, 120.0], [30.002, 120.002]]]],
                     route: null, pos: [40.0, 130.0, 90], source: 'local',
                     local: { have: 1, need: 1 } });
    eq(ctx.count('arc'), 0, '位置在屏幕外时不画车标');
    ok(ctx.count('moveTo') >= 1, '位置在屏幕外时路网照画');
  }

  // --- 车标方向：heading=0 箭头朝上（y 更小），90 朝右，180 朝下 ---
  {
    const mk = (hdg) => {
      const ctx = new RecCtx();
      const inst = new MV.MapView(null, { w: 240, h: 240, ctx: ctx });
      inst.view = MV.make_view(view);
      inst.draw(ctx, { view: inst.view, ways: [], route: null, pos: [30.0, 120.0, hdg],
                       source: 'none', local: { have: 0, need: 0 } });
      return ctx.of('moveTo').find((o) => Math.abs(o.x - 120) > 1 || Math.abs(o.y - 120) > 1);
    };
    const n = mk(0.0);
    const e = mk(90.0);
    const s = mk(180.0);
    ok(n && n.y < 120 - 10 && Math.abs(n.x - 120) < 1, 'heading=0：箭头指向屏幕上方（正北）');
    ok(e && e.x > 120 + 10 && Math.abs(e.y - 120) < 1, 'heading=90：箭头指向屏幕右方（正东）');
    ok(s && s.y > 120 + 10 && Math.abs(s.x - 120) < 1, 'heading=180：箭头指向屏幕下方（正南）');
  }
}

// ---------------------------------------------------------------------------
// 4) 离线：fetch 一律抛错，仍然要能画出**已经缓存**的路网
// ---------------------------------------------------------------------------
await (async () => {
  section('4] 离线渲染：fetch 只会抛错，仍然画得出已缓存的路网');

  // 这一节用的"网络"：任何一次调用都抛，并且记数。**断言它一次都没被调到。**
  let fetch_calls = 0;
  const dead_fetch = async () => {
    fetch_calls += 1;
    throw new TypeError('这一节没有网络：fetch 一律抛错');
  };

  // 沈阳附近一块 z14 瓦片（和 tiles.mjs 用同一片区域，方便对照）
  const Z = 14;
  const LAT = 41.8050;
  const LON = 123.4300;
  const t0 = TL.tile_of(LAT, LON, Z);
  const tiles = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const x = t0.x + dx;
      const y = t0.y + dy;
      // 网格状的假路网：横 4 条、竖 4 条（分米，相对瓦片中心）
      const segs = [];
      for (let i = -4; i <= 4; i += 2) {
        segs.push([i === 0 ? 0 : 6, [-4000, i * 400, 4000, i * 400]]);
        segs.push([i === 0 ? 0 : 6, [i * 400, -4000, i * 400, 4000]]);
      }
      // 一条高等级的路（rank 0）
      segs.push([0, [-4000, -4000, 4000, 4000]]);
      tiles.push([`${Z}/${x}/${y}`, mk_tile(Z, x, y, segs)]);
    }
  }
  const loose_table = {};
  for (const [id, buf] of tiles) loose_table[id] = buf;
  const loose_ids = tiles.map((t) => t[0]);

  // ---- 4a 散块（.npt）----
  const store = new TL.TileStore({
    bases: ['https://offline.invalid/tiles/'],
    storage: fake_storage(),
    indexedDB: null,          // 明确不要真的持久化
    fetch: dead_fetch,
    now: () => 1000,
    now_ms: () => 1000000,
  });
  // TileStore 的 db 是私有的持久层。这里直接塞一个**只读**的假 db ——
  // 它比"预先把解码结果塞进内存缓存"更接近真实：.npt 的字节还是要**真的解码**。
  store.db = fake_db(loose_table);
  store.pack_z = 0;

  const need = store.tiles_for_area(LAT, LON, 1500, 0);
  const area = await store.local_area(LAT, LON, 1500, 0);
  ok(area.ways.length > 0, `离线（散块）：从本地瓦片读出 ${area.ways.length} 段路网`);
  ok(area.have.length > 0, `离线（散块）：用到 ${area.have.length}/${need.length} 块本地瓦片`);
  eq(fetch_calls, 0, '⭐ 整个读取过程 fetch 调用次数为 0（真离线，不是"失败了才说离线"）');

  // ---- 4b 打包（NPK1）：真实部署形态，也必须能离线读出来 ----
  const PZ = 10;
  const d = Z - PZ;
  const px = t0.x >> d;
  const py = t0.y >> d;
  const items = [];
  const packed_table = {};
  for (const [id, buf] of tiles) {
    const p = id.split('/');
    const x = Number(p[1]);
    const y = Number(p[2]);
    if ((x >> d) !== px || (y >> d) !== py) continue;
    items.push([x - (px << d), y - (py << d), buf]);
  }
  packed_table[`pack:${PZ}/${px}/${py}`] = mk_pack(PZ, px, py, items);

  const store2 = new TL.TileStore({
    bases: ['https://offline.invalid/tiles/'],
    storage: fake_storage(),
    indexedDB: null,
    fetch: dead_fetch,
    now: () => 1000,
    now_ms: () => 1000000,
  });
  store2.db = fake_db(packed_table);
  store2.pack_z = PZ;
  const area2 = await store2.local_area(LAT, LON, 1500, 0);
  ok(area2.ways.length > 0, `离线（NPK1 打包）：从本地包里解出 ${area2.ways.length} 段路网`);
  eq(fetch_calls, 0, '⭐ 打包路径的 fetch 调用次数也是 0');
  eq(area2.ways.length, area.ways.length,
     '同一片路网：散块与打包两条路解出来的段数完全一样');

  // ---- 4c 把这份离线数据真的画一遍（走 MapView 的完整路径）----
  const ctx = new RecCtx();
  const mv = new MV.MapView(null, {
    ctx: ctx, w: 240, h: 240,
    // 这就是 app.js 里的接法：本地瓦片读取（**不联网**）
    load_local: (lat, lon, r) => store.local_area(lat, lon, r),
    center: [LAT, LON],
    zoom: 15,
    now_ms: () => 1000000,
  });
  mv.view = MV.make_view({ lat: LAT, lon: LON, zoom: 15, w: 240, h: 240 });
  mv.tick(true);                       // 第一帧：排一次本地读取
  await sleep(30);                     // 等异步读取落地
  mv.tick(true);                       // 第二帧：画出本地瓦片里的路网
  eq(fetch_calls, 0, '⭐ 渲染全过程 fetch 调用次数仍然是 0');
  ok(mv.local.have > 0, `MapView 从本地瓦片拿到 ${mv.local.have} 块`);
  ok(ctx.count('moveTo') > 0, `离线渲染真的画了线：${ctx.count('moveTo')} 次 moveTo、` +
                              `${ctx.count('lineTo')} 次 lineTo`);
  eq(mv.stats.source, 'local', '地图的数据来源标记为 local（= 离线瓦片）');
  ok(ctx.texts().some((s) => /离线瓦片/.test(s)), '角标里写明数据来自"离线瓦片"');

  // ---- 4d 本地也空的时候：不炸，只画空地 + 说明 ----
  const store3 = new TL.TileStore({
    bases: ['https://offline.invalid/tiles/'], storage: fake_storage(),
    indexedDB: null, fetch: dead_fetch, now: () => 1000, now_ms: () => 1000000,
  });
  store3.db = fake_db({});
  const ctx3 = new RecCtx();
  const mv3 = new MV.MapView(null, {
    ctx: ctx3, w: 240, h: 240,
    load_local: (lat, lon, r) => store3.local_area(lat, lon, r),
    center: [LAT, LON], zoom: 15, now_ms: () => 1000000,
  });
  mv3.view = MV.make_view({ lat: LAT, lon: LON, zoom: 15, w: 240, h: 240 });
  mv3.tick(true);
  await sleep(30);
  mv3.tick(true);
  eq(fetch_calls, 0, '本地什么都没有时也**不会**去联网（它压根没有网络层）');
  eq(mv3.stats.source, 'none', '本地什么都没有时数据来源是 none');
  ok(ctx3.texts().some((s) => /暂无路网/.test(s)), '本地空时角标说"暂无路网（本地无缓存）"');

  // ---- 4e 真实数量级上的"没网也能画"：把整个 tiles.js 的 fetch 换成抛错，
  //         走一遍 load_area（会尝试索引/下载，全部失败），地图仍然画本地那份 ----
  // ---- 4e 真实数量级上的"没网也能画"：把整个 tiles.js 的 fetch 换成抛错，
  //         走一遍 load_area（会尝试索引/下载，全部失败），地图仍然画本地那份 ----
  {
    const store4 = new TL.TileStore({
      bases: ['https://offline.invalid/tiles/'], storage: fake_storage(),
      indexedDB: null, fetch: dead_fetch, now: () => 1000, now_ms: () => 1000000,
    });
    store4.db = fake_db(loose_table);
    store4.pack_z = 0;
    let threw = false;
    let res = null;
    try { res = await store4.load_area(LAT, LON, 1500); } catch (e) { threw = true; }
    ok(!threw, 'load_area 在网络全挂时也不抛（失败要在这一层消化掉）');
    ok(res && res.ways.length > 0,
       'load_area 在网络全挂时仍然给出本地那 ' + (res ? res.ways.length : 0) + ' 段路网');
    ok(fetch_calls > 0, `顺便确认这条路**真的试过**联网（${fetch_calls} 次全失败）—— ` +
                        '所以上面的 0 次不是"代码压根没跑"');
  }

  // ---- 4f 本地读取的"闸门"必须真的拦得住（这一段是被一个真的 bug 逼出来的）----
  //
  // 踩过的坑：加载完成的回调会 invalidate()，而 invalidate() 会（在没有 rAF 的
  // 环境里）直接再 tick 一次 —— 如果 tick 每次都强制重读本地瓦片，就成了
  // 读 -> tick -> 再读 的自激循环，**内存直接被吃爆**（Node 报
  // "JavaScript heap out of memory"）。所以这里把三道闸门都钉住。
  {
    let loads = 0;
    let clock = 1000000;
    const ctx5 = new RecCtx();
    const mv5 = new MV.MapView(null, {
      ctx: ctx5, w: 240, h: 240, center: [LAT, LON],
      now_ms: () => clock,
      load_local: async () => {
        loads += 1;
        return { ways: [[0, [[LAT, LON], [LAT + 0.001, LON]]]], have: ['a'], need: ['a'] };
      },
    });
    mv5.view = MV.make_view({ lat: LAT, lon: LON, zoom: 15, w: 240, h: 240 });
    for (let i = 0; i < 50; i += 1) mv5.tick(true);
    await sleep(30);
    eq(loads, 1, '同一瞬间连打 50 帧：本地读取只发生 **1** 次（位置没动、时间没走、范围没变大）');

    for (let i = 0; i < 50; i += 1) mv5.tick(true);
    await sleep(30);
    eq(loads, 1, '继续连打 50 帧也还是 1 次 —— 没有"读 -> tick -> 再读"的自激循环');

    clock += 2000;                       // 时间闸门（LOCAL_MIN_PERIOD_MS）
    mv5.tick(true);
    await sleep(20);
    eq(loads, 2, `过了 ${MV.LOCAL_MIN_PERIOD_MS}ms 之后允许再读一次（闸门是"或"关系）`);

    // 范围明显变大（缩小视图）-> 立刻重读，不用等满一个周期
    mv5.view = MV.zoom_at(mv5.view, mv5.view.zoom - 3, 120, 120);
    mv5.tick(true);
    await sleep(20);
    eq(loads, 3, '缩小视图后要的范围大了 3 档 -> 立刻重读一次（不必等周期）');

    // 移动够远也会重读
    mv5.view = MV.pan_by(mv5.view, 0, -1e6);
    mv5.tick(true);
    await sleep(20);
    ok(loads >= 4, `拖出 ${MV.LOCAL_MIN_MOVE_M} 米以外允许重读（实得 ${loads} 次）`);
  }
})();

// ---------------------------------------------------------------------------
// 5) 手势：拖动 / 双指 / 滚轮 / 双击 / 回到当前位置
// ---------------------------------------------------------------------------
section('5] 手势（合成 Pointer 事件，走的是 attach() 里那条真实路径）');
{
  function fake_canvas(w, h, ctx) {
    const listeners = {};
    return {
      clientWidth: w, clientHeight: h, width: w, height: h,
      _listeners: listeners,
      addEventListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
      removeEventListener(ev, cb) {
        listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb);
      },
      getContext() { return ctx; },
      getBoundingClientRect() { return { left: 0, top: 0 }; },
      setPointerCapture() {},
      fire(ev, obj) { for (const cb of (listeners[ev] || [])) cb(Object.assign({
        preventDefault() { this._prevented = true; }, pointerId: 1, offsetX: 0, offsetY: 0,
      }, obj)); },
    };
  }

  const ctx = new RecCtx();
  const cv = fake_canvas(240, 240, ctx);
  const mv = new MV.MapView(cv, { w: 240, h: 240, center: [30.0, 120.0], zoom: 16,
                                  now_ms: () => 1000000 });
  eq(mv.attach(cv), true, 'attach() 挂上手势');
  eq(mv.attach(cv), true, 'attach() 幂等（重复调不会挂两遍）');
  mv.view = MV.make_view({ lat: 30.0, lon: 120.0, zoom: 16, w: 240, h: 240 });

  const before = { lat: mv.view.lat, lon: mv.view.lon, zoom: mv.view.zoom };
  cv.fire('pointerdown', { offsetX: 100, offsetY: 100 });
  cv.fire('pointermove', { offsetX: 140, offsetY: 120 });
  ok(mv.view.lon < before.lon, '单指拖动：内容跟着手指走（中心西移）');
  eq(mv.follow, false, '拖动之后**停止跟随**（否则地图会被定位拽回去，看起来像卡住）');

  // 双指外扩 = 放大
  const z0 = mv.view.zoom;
  cv.fire('pointerdown', { pointerId: 2, offsetX: 60, offsetY: 60 });
  cv.fire('pointermove', { pointerId: 2, offsetX: 40, offsetY: 40 });   // 距离变大
  ok(mv.view.zoom > z0, `双指外扩放大（z${z0.toFixed(2)} -> z${mv.view.zoom.toFixed(2)}）`);
  cv.fire('pointerup', { pointerId: 2 });
  cv.fire('pointerup', { pointerId: 1 });

  // 滚轮：向上滚（deltaY<0）放大，并且 preventDefault（不然页面会跟着滚）
  const z1 = mv.view.zoom;
  let prevented = null;
  const wheel_cb = cv._listeners.wheel[0];
  wheel_cb({ deltaY: -100, offsetX: 100, offsetY: 100, preventDefault() { prevented = true; } });
  ok(mv.view.zoom > z1, `滚轮向上滚：放大（z${z1.toFixed(2)} -> z${mv.view.zoom.toFixed(2)}）`);
  eq(prevented, true, '滚轮事件被 preventDefault（不让页面跟着滚）');
  const z2 = mv.view.zoom;
  mv.view = MV.make_view({ lat: mv.view.lat, lon: mv.view.lon, zoom: z2, w: 240, h: 240 });
  const wheel2 = cv._listeners.wheel[0];
  wheel2({ deltaY: 100, offsetX: 100, offsetY: 100, preventDefault() {} });
  ok(mv.view.zoom < z2, '滚轮向下滚：缩小');

  // 双击放大一档
  const z3 = mv.view.zoom;
  const dbl = cv._listeners.dblclick[0];
  dbl({ offsetX: 120, offsetY: 120, preventDefault() {} });
  near(mv.view.zoom, Math.min(MV.MAX_ZOOM, z3 + 1), '双击放大一档', 1e-9);

  // 平移跟随：跟随时中心自动回到位置
  mv.pos_provider = () => [31.5, 121.5, 0];
  mv.recenter();
  eq(mv.follow, true, '「回到当前位置」重新打开跟随');
  mv.tick(true);
  near(mv.view.lat, 31.5, '跟随时视图中心 = 当前位置（纬度）', 1e-9);
  near(mv.view.lon, 121.5, '跟随时视图中心 = 当前位置（经度）', 1e-9);

  // 缩放在跟随时**不**打断跟随（用户只是想看远一点）
  mv.zoom_by(1.0, 120, 120);
  eq(mv.follow, true, '“放大/缩小”按钮不打断跟随');
  ok(mv.view.zoom > 16, '放大按钮真的放大了');

  // 拖出视野边界也不会出 NaN
  mv.drag_by(0, -1e7);
  ok(Number.isFinite(mv.view.lat) && Math.abs(mv.view.lat) <= MV.MAX_LAT + 1e-9,
     '极端拖动之后中心仍然合法');

  // detach 之后不再响应
  eq(mv.detach(), true, 'detach() 摘掉手势');
  eq(cv._listeners.pointerdown.length, 0, 'detach 之后画布上没有残留的 pointerdown 监听器');
  eq(mv._attached, null, 'detach 之后 _attached 清空');
  const lat_after = mv.view.lat, lon_after = mv.view.lon, zoom_after = mv.view.zoom;
  cv.fire('pointerdown', { offsetX: 10, offsetY: 10, pointerId: 1 });
  cv.fire('pointermove', { offsetX: 200, offsetY: 200, pointerId: 1 });
  cv.fire('wheel', { deltaY: -300, offsetX: 100, offsetY: 100, preventDefault() {} });
  eq([mv.view.lat, mv.view.lon, mv.view.zoom], [lat_after, lon_after, zoom_after],
     'detach 之后再怎么点/滚，视图一动不动');
}

// ---------------------------------------------------------------------------
// 6) 高 DPI：画布像素尺寸 = CSS 尺寸 × devicePixelRatio
// ---------------------------------------------------------------------------
section('6] 高 DPI（devicePixelRatio）');
{
  const ctx = new RecCtx();
  const cv = {
    clientWidth: 240, clientHeight: 240, width: 240, height: 240,
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {},
    getContext() { return ctx; }, getBoundingClientRect() { return { left: 0, top: 0 }; },
  };
  const mv = new MV.MapView(cv, { w: 240, h: 240, dpr: () => 3,
                                  center: [30.0, 120.0], zoom: 16, now_ms: () => 1000000 });
  mv.resize();
  eq(cv.width, 720, 'dpr=3：画布像素宽度 = 240 × 3 = 720');
  eq(cv.height, 720, 'dpr=3：画布像素高度 = 240 × 3 = 720');
  eq(mv.css_w, 240, 'CSS 尺寸仍然是 240（绘制坐标系是 CSS 像素）');

  const ways = gen_ways(MV.make_view({ lat: 30, lon: 120, zoom: 16, w: 240, h: 240 }), 40, 6, 3);
  mv.view = MV.make_view({ lat: 30, lon: 120, zoom: 16, w: 240, h: 240 });
  mv.tick(true);
  eq(ctx.transforms.length > 0 && ctx.transforms[0][0], 3,
     '绘制前调用 setTransform(3,0,0,3,0,0)：所有坐标仍是 CSS 像素');
  const xs = ctx.of('moveTo').map((o) => o.x);
  ok(xs.every((x) => x > -1000 && x < 1000),
     `moveTo 的坐标都落在 CSS 像素空间（${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)}），` +
     '没有被 dpr 放大 —— 否则线宽/命中判定会整体错 3 倍');

  // 屏幕旋转（CSS 尺寸变了）之后要重算，否则整张图会被拉伸
  cv.clientWidth = 320; cv.clientHeight = 320;
  mv.on_resize();
  eq(cv.width, 960, '布局变化后 on_resize() 重算画布像素尺寸（320×3=960）');
  eq([mv.view.w, mv.view.h], [320, 320], '视图尺寸跟着布局走（投影的中心随之改变）');

  // 拿不到 clientWidth 时退回 canvas.width（老浏览器/隐藏元素）
  const ctx2 = new RecCtx();
  const cv2 = { width: 300, height: 200, getContext: () => ctx2,
                addEventListener() {}, getBoundingClientRect() { return { left: 0, top: 0 }; } };
  const mv2 = new MV.MapView(cv2, { dpr: () => 2, center: [30, 120],
                                    now_ms: () => 1000000 });
  mv2.resize();
  eq([mv2.css_w, mv2.css_h], [300, 200], '拿不到 clientWidth 时退回 canvas 的宽高');
  eq([cv2.width, cv2.height], [600, 400], '按 dpr=2 重设像素尺寸');
}

// ---------------------------------------------------------------------------
// 7) 渲染内容：图层顺序 / 分组 / 抽稀 / 裁剪 / 比例尺
// ---------------------------------------------------------------------------
section('7] 渲染内容（记录型 ctx：图层、分组、抽稀、裁剪）');
{
  // 为了让抽稀不介入，用一个点距很大的视图（每步远大于 1 像素）
  const view = MV.make_view({ lat: 30.0, lon: 120.0, zoom: 15, w: 240, h: 240 });

  // 5 条折线，各 4 个点，等级的分布：0、2、6、6、8（两段 rank 6 必须合并成一次 stroke）
  // 点距 0.0008° 纬度 ≈ 88 米（z15 下约 18 像素），整片都在视野里
  const mk = (rank, i) => [rank, [
    [30.0 + i * 0.0008, 120.0 + i * 0.0008],
    [30.0004 + i * 0.0008, 120.0004 + i * 0.0008],
    [30.0008 + i * 0.0008, 120.0006 + i * 0.0008],
    [30.0012 + i * 0.0008, 120.0008 + i * 0.0008],
  ]];
  const ways = [mk(0, 0), mk(2, 1), mk(6, 2), mk(6, 3), mk(8, 4)];
  const route = [[30.0, 120.0], [30.0004, 120.0004], [30.0008, 120.0006]];
  const ctx = new RecCtx();
  const mv = new MV.MapView(null, { w: 240, h: 240, ctx: ctx, now_ms: () => 1000000 });
  mv.view = MV.make_view(view);
  const rep = mv.draw(ctx, { view: mv.view, ways: ways, route: route,
                             pos: [30.0, 120.0, 45], source: 'local', follow: true,
                             local: { have: 6, need: 9, coverage: 'partial' } });

  eq(rep.segs, 5, '5 段路网全部进了统计');
  eq(rep.drawn, 5, '5 段都在视野里（没有误裁）');
  eq(rep.culled, 0, '没有误裁');
  eq(rep.pts, 20, '20 个点全部画出来（点距远大于 1 像素，抽稀不该介入）');
  eq(ctx.road_path().moveTo, 5, '每段一次 moveTo');
  eq(ctx.road_path().lineTo, 15, '每段 3 次 lineTo（4 个点）');

  // ⭐ 按等级分组：rank 6 的两段只该描一次（分组是这个渲染唯一的性能手段）
  eq(ctx.strokes_of(MV.ROAD_STYLE[0].color), 1, 'rank 0 描一次');
  eq(ctx.strokes_of(MV.ROAD_STYLE[2].color), 1, 'rank 2 描一次');
  eq(ctx.strokes_of(MV.ROAD_STYLE[6].color), 1, 'rank 6 的两段**合并成一次** stroke（分组生效）');
  eq(ctx.strokes_of(MV.ROAD_STYLE[8].color), 1, 'rank 8 描一次');
  const road_colors = new Set(MV.ROAD_STYLE.map((s) => s.color)
    .concat([MV.ROAD_STYLE_FALLBACK.color]));
  const road_strokes = ctx.of('stroke').filter((o) => road_colors.has(o.stroke));
  eq(road_strokes.length, 4, `路网一共 4 次 stroke（实得 ${road_strokes.length}）`);
  ok(road_strokes.every((o) => o.lw > 0), '每一组路网都设了正的线宽');

  // 等级越高（数字越小）线越粗
  const lw0 = MV.rank_style(0).width, lw8 = MV.rank_style(8).width;
  ok(lw0 > lw8, `主干道比服务道粗（${lw0} > ${lw8}）`);
  let mono = true;
  for (let r = 1; r < MV.ROAD_STYLE.length; r += 1) {
    if (!(MV.ROAD_STYLE[r].width < MV.ROAD_STYLE[r - 1].width)) mono = false;
  }
  ok(mono, '道路等级表从 0 到 8 线宽单调变细');
  ok(MV.rank_style(99).width === MV.ROAD_STYLE_FALLBACK.width, '未知等级退化成最细的一档');

  // 线宽随缩放级缩放（远景别糊成一坨、近景别细得看不见）
  ok(MV.width_scale(12) < MV.width_scale(16) && MV.width_scale(16) < MV.width_scale(20),
     '线宽随缩放级单调变化');
  near(MV.width_scale(16), 1.0, 'z16 是线宽基准（系数 = 1）', 1e-9);

  // ⭐ 航线必须画在路网**之后**（压在上面），而且两层：深色描边 + 亮色主线
  const idx_first_road = ctx.ops.findIndex((o) => o.op === 'stroke' &&
    o.stroke === MV.ROAD_STYLE[0].color);
  const idx_route = ctx.ops.findIndex((o) => o.op === 'stroke' && o.stroke === MV.ROUTE_COLOR);
  ok(idx_route > idx_first_road, '航线在路网之后画（压在路上，一眼能认出）');
  const route_strokes = ctx.of('stroke').filter((o) => o.stroke === MV.ROUTE_COLOR ||
    o.stroke === '#062a44');
  eq(route_strokes.length, 2, '航线画两层（深色描边 + 亮蓝主线）');
  ok(route_strokes[0].lw > route_strokes[1].lw, '描边层比主线宽（不然看不出描边）');
  eq(route_strokes[1].stroke, MV.ROUTE_COLOR, '航线主色是 ROUTE_COLOR');

  // 车标：一个圆点 + 一个箭头，颜色是 POS_COLOR
  ok(ctx.count('arc') >= 2, `车标至少两个圆（外圈 + 内点），实得 ${ctx.count('arc')}`);
  ok(ctx.of('fill').some((o) => o.fill === MV.POS_COLOR), '车标用了 POS_COLOR');
  const pos_arcs = ctx.of('arc').filter((o) => Math.abs(o.x - 120) < 1 && Math.abs(o.y - 120) < 1);
  ok(pos_arcs.length >= 2, '车标画在当前位置对应的屏幕点上');

  // 比例尺 + 指北 + 角标
  ok(ctx.texts().some((s) => /北朝上/.test(s)), '比例尺旁边写明"北朝上"');
  ok(ctx.texts().includes('N'), '有指北标');
  ok(ctx.texts().some((s) => /本地路网|离线瓦片/.test(s)), '角标写明数据来源');
  ok(ctx.texts().some((s) => /6\/9块/.test(s)) || ctx.texts().some((s) => /6\/9/.test(s)),
     '角标带上本地瓦片的块数（6/9）');
  ok(ctx.texts().some((s) => /跟随当前位置/.test(s)), '跟着位置走的时候角标说"跟随当前位置"');

  // 比例尺的"整数米"与像素长度
  {
    const bar = MV.scale_bar(view, 64);
    ok([1, 2, 5].includes(Number(String(bar.m).charAt(0))), `比例尺是 1/2/5 × 10^k（实得 ${bar.m} 米）`);
    ok(Math.abs(bar.px - 64) < 64, `比例尺像素长度 ${bar.px.toFixed(1)} px 与目标 64 px 同量级`);
    near(bar.px * view.mpp, bar.m, '比例尺像素长度 × 米/像素 = 它标的米数', 1e-9);
    ok(/m|km/.test(bar.text), `比例尺文本可读（"${bar.text}"）`);
    eq(MV.nice_meters(1.3), 1, 'nice_meters(1.3) = 1');
    eq(MV.nice_meters(3.7), 2, 'nice_meters(3.7) = 2');
    eq(MV.nice_meters(230), 200, 'nice_meters(230) = 200');
    eq(MV.nice_meters(7800), 5000, 'nice_meters(7800) = 5000');
  }

  // 裁剪：视图外的一条必须被整条丢掉（省掉它的全部投影）
  {
    const far = [6, [[10.0, 10.0], [10.01, 10.01], [10.02, 10.02]]];
    const c2 = new RecCtx();
    const rep2 = mv.draw(c2, { view: mv.view, ways: [far], route: null, pos: null,
                               source: 'local', local: { have: 1, need: 1 } });
    eq(rep2.culled, 1, '视图外的折线被整条裁掉');
    eq(rep2.drawn, 0, '裁掉的不产生任何绘制调用');
    eq(c2.road_path().moveTo, 0, '裁掉之后路网一次 moveTo 都没有');
    eq(c2.count('moveTo'), 4, '只有比例尺/指北那 4 笔装饰还在');
  }

  // 抽稀：点距 < 1 像素时跳过（但**最后一个点永远保留**，否则线会短一截）
  {
    const v = MV.make_view({ lat: 30.0, lon: 120.0, zoom: 18, w: 240, h: 240 });
    const step_m = 0.06;     // z18 下 0.06 米 ≈ 0.1 像素 -> 绝大多数点必须被抽掉
    const geom = [];
    const N = 50;
    for (let i = 0; i < N; i += 1) geom.push([30.0 + i * step_m / 110540, 120.0]);
    const c3 = new RecCtx();
    const mv3 = new MV.MapView(null, { w: 240, h: 240, ctx: c3, now_ms: () => 1000000 });
    mv3.view = MV.make_view(v);
    mv3.draw(c3, { view: mv3.view, ways: [[6, geom]], route: null, pos: null,
                   source: 'local', local: { have: 1, need: 1 } });
    const rp = c3.road_path();
    eq(rp.moveTo, 1, '抽稀：起点画一次 moveTo');
    ok(rp.lineTo <= 10,
       `抽稀：${N} 个挤在 5 像素里的点只画了 ${rp.lineTo} 条线（不抽的话是 ${N - 1} 条）`);
    const last = rp.segs[0];
    const want_last = MV.project(mv3.view, geom[N - 1][0], geom[N - 1][1]);
    near(last[last.length - 2], want_last[0], '抽稀后最后一个点仍然画到（线不会短一截）', 1e-9);
    near(last[last.length - 1], want_last[1], '抽稀后最后一个点的 y 也对', 1e-9);
  }

  // 等距点（>1 像素）**不能**被抽掉 —— 这是"抽稀"和"丢点"的分界线
  {
    const v = MV.make_view({ lat: 30.0, lon: 120.0, zoom: 14, w: 240, h: 240 });
    const geom = [];
    for (let i = 0; i < 12; i += 1) geom.push([30.0 + i * 50 / 110540, 120.0]);
    const c4 = new RecCtx();
    const mv4 = new MV.MapView(null, { w: 240, h: 240, ctx: c4, now_ms: () => 1000000 });
    mv4.view = MV.make_view(v);
    mv4.draw(c4, { view: mv4.view, ways: [[6, geom]], route: null, pos: null,
                   source: 'local', local: { have: 1, need: 1 } });
    eq(c4.road_path().lineTo, 11, '每 50 米一个点（z14 下约 5 像素）：11 个点一个都没被抽掉');
  }

  // status() 的形状（界面直接照抄，字段不能少）
  {
    const st = mv.status();
    for (const k of ['state', 'short', 'detail', 'source', 'zoom', 'mpp', 'follow',
                     'segs', 'drawn_segs', 'pts', 'local_have', 'local_need']) {
      ok(Object.prototype.hasOwnProperty.call(st, k), `status() 里有字段 ${k}`);
    }
    eq(st.source, 'local', '数据来源标记为 local');
    ok(/m\/像素/.test(st.detail), '详情里有"米/像素"（说明当前尺度）');
  }
}

// ---------------------------------------------------------------------------
// 8) 性能：真实测量值（JS 侧）
// ---------------------------------------------------------------------------
section('8] 性能实测（240×240 与手机尺寸；只量 JS 侧，见文件头那段边界说明）');
{
  function bench(fn, iters) {
    const t = [];
    for (let i = 0; i < iters; i += 1) {
      const a = process.hrtime.bigint();
      fn();
      const b = process.hrtime.bigint();
      t.push(Number(b - a) / 1e6);
    }
    t.sort((x, y) => x - y);
    return { med: t[Math.floor(t.length / 2)], min: t[0], max: t[t.length - 1] };
  }

  const sizes = [[240, 240, '设备圆屏 240×240'], [390, 390, '手机竖屏 390×390'],
                 [1080, 1080, '手机全屏 1080×1080']];
  const counts = [100, 300, 600, 1200];
  const pts = 8;
  const results = [];
  console.log('      （每次 = 一整帧：底色 + 全部路网 + 航线 + 车标 + 比例尺；' +
              '折线随机铺满视图，每条 8 个点）');
  for (const [w, h, label] of sizes) {
    const view = MV.make_view({ lat: 30.0, lon: 120.0, zoom: 16, w: w, h: h });
    for (const n of counts) {
      const ways = gen_ways(view, n, pts, 1000 + n);
      const route = gen_ways(view, 1, 200, 99)[0][1];
      const ctx = new RecCtx();
      const mv = new MV.MapView(null, { ctx: ctx, w: w, h: h, now_ms: () => 1000000 });
      mv.view = MV.make_view(view);
      const snap = { view: mv.view, ways: ways, route: route, pos: [30.0, 120.0, 45],
                     source: 'local', local: { have: 9, need: 9 } };
      const r = bench(() => mv.draw(ctx, snap), 30);
      results.push({ label, w, n, r, ctx: ctx, rep: mv.stats });
      console.log(`      ${label.padEnd(18)} ${String(n).padStart(4)} 段 × ${pts} 点：` +
                  `中位 ${r.med.toFixed(2)} ms  最小 ${r.min.toFixed(2)}  ` +
                  `最大 ${r.max.toFixed(2)}   （${(r.med * 1000 / n).toFixed(1)} µs/段，` +
                  `画了 ${mv.stats.drawn_segs} 段 / ${mv.stats.pts} 点）`);
    }
  }

  // 真实量级：一块 z14 瓦片在市区大概几百到一千多条路。
  // 这里给 240×240 一屏 600 段一个**宽松**的回归闸门（开发机实测远低于它）。
  const r240_600 = results.find((x) => x.n === 600 && x.w === 240);
  ok(r240_600.r.med < 20.0,
     `240×240 一屏 600 段 × 8 点：中位 ${r240_600.r.med.toFixed(2)} ms（闸门 20 ms）`);
  const r1080_600 = results.find((x) => x.n === 600 && x.w === 1080);
  ok(r1080_600.r.med < 25.0,
     `1080×1080 一屏 600 段：中位 ${r1080_600.r.med.toFixed(2)} ms（闸门 25 ms）`);

  // 每段耗时随 N 基本不变（说明没有 O(N²) 的东西混进来）
  const per_seg_100 = results.find((x) => x.n === 100 && x.w === 240).r.med / 100;
  const per_seg_1200 = results.find((x) => x.n === 1200 && x.w === 240).r.med / 1200;
  ok(per_seg_1200 < per_seg_100 * 4,
     `每段耗时没有随 N 爆炸（100 段 ${(per_seg_100 * 1000).toFixed(1)} µs/段 vs ` +
     `1200 段 ${(per_seg_1200 * 1000).toFixed(1)} µs/段）—— 没有 O(N²) 的东西`);

  // 裁剪到底省了多少：全部折线堆在视图外时，一帧应该几乎不要钱
  {
    const view = MV.make_view({ lat: 30.0, lon: 120.0, zoom: 16, w: 240, h: 240 });
    const near = gen_ways(view, 600, pts, 5);
    const far = gen_ways(MV.make_view({ lat: 10.0, lon: 100.0, zoom: 16, w: 240, h: 240 }),
                         600, pts, 6);
    const ctx = new RecCtx();
    const mv = new MV.MapView(null, { ctx: ctx, w: 240, h: 240, now_ms: () => 1000000 });
    mv.view = MV.make_view(view);
    const with_near = bench(() => mv.draw(ctx, { view: mv.view, ways: near, route: null,
      pos: null, source: 'local', local: { have: 1, need: 1 } }), 30);
    const all_far = bench(() => mv.draw(ctx, { view: mv.view, ways: far, route: null,
      pos: null, source: 'local', local: { have: 1, need: 1 } }), 30);
    console.log(`      裁剪效果：600 段在视野内 ${with_near.med.toFixed(2)} ms vs ` +
                `600 段全在视野外 ${all_far.med.toFixed(2)} ms`);
    ok(all_far.med < with_near.med,
       `整段裁剪生效：视野外的 600 段只花 ${all_far.med.toFixed(2)} ms ` +
       `（< 视野内的 ${with_near.med.toFixed(2)} ms）`);
  }

  // 记录型 ctx 本身的开销要能被看见（这样上面的数字才不会被误读成"浏览器画图"）
  {
    const view = MV.make_view({ lat: 30.0, lon: 120.0, zoom: 16, w: 240, h: 240 });
    const ways = gen_ways(view, 600, pts, 77);
    const ctx = new RecCtx();
    const mv = new MV.MapView(null, { ctx: ctx, w: 240, h: 240, now_ms: () => 1000000 });
    mv.view = MV.make_view(view);
    const snap = { view: mv.view, ways: ways, route: null, pos: null,
                   source: 'local', local: { have: 1, need: 1 } };
    mv.draw(ctx, snap);
    const calls = ctx.ops.length;
    console.log(`      这一帧产生了 ${calls} 次 Canvas 调用（记录型 ctx 的开销就在这里）`);
    ok(calls > 0, `一帧的 Canvas 调用次数可数：${calls}`);
  }
}

// ---------------------------------------------------------------------------
// 9) app.js 接线（真的 App 对象 + 最小 DOM）
// ---------------------------------------------------------------------------
await (async () => {
  section('9] app.js 接线（真的 App 对象：位置/航线/开关/状态面板）');

  // 最小 DOM：只提供地图那几个 id。⚠️ readyState 必须是 'loading' 且
  // addEventListener 什么都不做 —— 否则 app.js 顶层会真的去跑 init()，
  // 那需要上面五套里那种完整打桩（ui.mjs 已经专门干这事了）。
  const els = new Map();
  function mk_el(id) {
    const el = {
      id, tagName: 'DIV', textContent: '', value: '', checked: false,
      hidden: false, disabled: false, dataset: {}, style: {},
      _listeners: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, on) {
          const want = on === undefined ? !this._s.has(c) : !!on;
          if (want) this._s.add(c); else this._s.delete(c);
          return want;
        },
      },
      addEventListener(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); },
      removeEventListener(ev, cb) {
        this._listeners[ev] = (this._listeners[ev] || []).filter((f) => f !== cb);
      },
      fire(ev, obj) {
        for (const cb of (this._listeners[ev] || [])) {
          cb(Object.assign({ target: this, type: ev, preventDefault() {} }, obj || {}));
        }
      },
    };
    els.set(id, el);
    return el;
  }
  for (const id of ['log', 'mapview-state', 'mapview-detail', 'route-info',
                    'start-info', 'toast', 'map-info', 'map-detail',
                    'mapview-here-btn', 'mapview-zoom-in', 'mapview-zoom-out']) {
    mk_el(id);
  }
  globalThis.document = {
    readyState: 'loading',           // 见上面那段说明
    visibilityState: 'visible',
    body: { classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } } },
    getElementById: (id) => els.get(id) || null,
    addEventListener() {},           // 故意不派发 DOMContentLoaded -> init() 不跑
  };

  globalThis.NavPuckMath = NM;
  globalThis.NavPuckProto = require(path.join(PHONE_DIR, 'proto.js'));
  globalThis.NavPuckRoute = RT;
  globalThis.NavPuckTiles = TL;
  globalThis.NavPuckMap = require(path.join(PHONE_DIR, 'map.js'));
  globalThis.NavPuckMapView = MV;
  const APP = require(path.join(PHONE_DIR, 'app.js'));

  const app = new APP.App();
  const logs = [];
  app.log = (l) => { logs.push(String(l)); };   // 屏蔽控制台噪声，同时能断言日志

  // ---- 画布还没有的时候：说清楚，但绝不抛 ----
  eq(app.mapview_instance(), null, '页面上没有 #mapview 时返回 null（不抛）');
  ok(logs.some((l) => /没有 #mapview/.test(l)), '没有画布时日志里说清楚原因');

  // ---- 装上画布（用记录型 ctx）----
  const ctx = new RecCtx();
  const cv = mk_el('mapview');
  cv.tagName = 'CANVAS';
  cv.clientWidth = 240; cv.clientHeight = 240; cv.width = 240; cv.height = 240;
  cv.getContext = () => ctx;
  cv.getBoundingClientRect = () => ({ left: 0, top: 0 });
  cv.setPointerCapture = () => {};
  els.set('mapview', cv);

  const mv = app.mapview_instance();
  ok(mv instanceof MV.MapView, 'app.js 用页面上真实的 #mapview 建出了 MapView');
  ok(cv._listeners.pointerdown && cv._listeners.wheel, '地图挂上了手势监听');
  ok(logs.some((l) => /地图已就绪/.test(l)), '就绪时写一行日志（含操作提示）');

  // ---- 位置：和导航用同一个位置源 ----
  app.geo = { lat: 30.2545, lon: 120.1350, heading: 123.0 };
  app.simdrive = false; app.manual = false;
  eq(app.mapview_pos(), [30.2545, 120.1350, 123.0], 'mapview_pos() 直接取位置源（和导航同一个）');
  app.geo = { lat: null, lon: null, heading: null };
  app.start_lat = 30.1; app.start_lon = 120.2;
  eq(app.mapview_pos(), [30.1, 120.2, null], '没有定位时退回导航起点（按过"用当前位置作起点"的那个）');
  app.start_lat = null; app.start_lon = null;
  eq(app.mapview_pos(), null, '既没定位也没起点：返回 null（地图停在初始中心）');

  // ---- 路网来源：OsmMapSource.ways，形状 [[rank,[[lat,lon],...]],...] ----
  const live_ways = [[0, [[30.0, 120.0], [30.001, 120.001]]],
                     [6, [[30.002, 120.002], [30.003, 120.003]]]];
  app.map_source = { ways: live_ways, set_enabled() {}, tiles: null };
  app.map_enabled = true;
  eq(app.mapview_ways(), live_ways, 'mapview_ways() 直接复用 OsmMapSource.ways（同一个形状）');
  app.map_enabled = false;
  eq(app.mapview_ways(), null, '底图开关关掉时地图不再画街道路网');
  app.map_enabled = true;
  app.map_source = { ways: [], set_enabled() {}, tiles: null };
  eq(app.mapview_ways(), null, '底图源手上还没有数据时返回 null（交给本地瓦片那一层）');

  // ---- 本地瓦片：走 TileStore.local_area（**不联网**）----
  let load_args = null;
  const local_ways = [[2, [[30.0, 120.0], [30.002, 120.002]]]];
  app.map_source = {
    ways: [], set_enabled() {},
    tiles: {
      local_area(lat, lon, r) { load_args = [lat, lon, r]; return Promise.resolve({ ways: local_ways, have: ['a'], need: ['a', 'b'] }); },
    },
  };
  const got = await app.mapview_load_local(30.0, 120.0, 800);
  eq(load_args, [30.0, 120.0, 800], 'mapview_load_local 把 (lat,lon,半径) 原样转给 TileStore.local_area');
  eq(got.ways, local_ways, '本地瓦片读出来的路网原样返回');
  app.map_enabled = false;
  eq(await app.mapview_load_local(30, 120, 100), null, '底图关掉时连本地瓦片也不读');
  app.map_enabled = true;

  // ---- 画一帧：状态写进 DOM，路网真的画出来 ----
  app.map_source = { ways: live_ways, set_enabled() {}, tiles: null };
  app.geo = { lat: 30.0, lon: 120.0, heading: 0 };
  eq(app.mapview_frame(true), true, 'mapview_frame(true) 真的画了一帧');
  ok(ctx.count('moveTo') >= 2, `画面上有线（${ctx.count('moveTo')} 次 moveTo）`);
  eq(els.get('mapview-state').textContent, mv.status().short, '状态短格写进了 #mapview-state');
  ok(els.get('mapview-state').dataset.state.length > 0, '状态短格带上了 data-state（配色用）');
  ok(/m\/像素/.test(els.get('mapview-detail').textContent), '详情行写进了 #mapview-detail');
  near(mv.view.lat, 30.0, '跟随时视图中心 = 位置源给的纬度', 1e-9);

  // ---- 航线：规划完成 -> 交给地图（app.set_mapview_route）----
  const route_pts = [[30.0, 120.0], [30.002, 120.001], [30.004, 120.003]];
  app.set_mapview_route(route_pts, true);
  eq(app._mv_route, route_pts, 'app.js 把航线折线存下来交给地图');
  const has_route_stroke = ctx.of('stroke').some((o) => o.stroke === MV.ROUTE_COLOR);
  ok(has_route_stroke, '画面上出现了航线的亮蓝色');
  eq(app.set_mapview_route(null), true, '传 null 可以清掉航线（停止导航时用）');
  eq(app._mv_route, null, '清掉之后 _mv_route 是 null');

  // ---- 底图开关：状态必须说"已关闭"，而且要清掉已经读进内存的本地路网 ----
  mv.local = { ways: local_ways, have: 1, need: 2, coverage: 'partial', reason: '' };
  app.set_map_enabled(false, true);
  eq(mv.local.ways.length, 0, '关掉底图时地图里已经读进来的本地路网也被扔掉');
  eq(els.get('mapview-state').textContent, '已关闭', '关掉底图时状态短格是"已关闭"');
  ok(/只画航线与当前位置/.test(els.get('mapview-detail').textContent),
     '关掉底图时详情行说清楚"只画航线与当前位置"（不能显示"暂无路网"）');
  app.set_map_enabled(true, true);

  // ---- 页面在后台时不画（省电），回到前台才画 ----
  document.visibilityState = 'hidden';
  const frames_before = mv.stats.frames;
  eq(app.mapview_frame(true), false, '页面在后台时不画地图（省电）');
  eq(mv.stats.frames, frames_before, '后台确实没有增加帧数');
  document.visibilityState = 'visible';

  // ---- 位置源在动的时候，地图跟着动（跟随）----
  app.geo = { lat: 30.05, lon: 120.05, heading: 10 };
  app.mapview_frame(true);
  near(mv.view.lat, 30.05, '位置一动，地图中心跟着走（跟随中）', 1e-9);

  // ---- 手势之后不再跟随，但按钮的处理体（App 里那三个）能拉回来 ----
  //
  // ⚠️ 这里直接调**按钮的处理体**（mv.recenter / mv.zoom_by），而不是
  //    `#mapview-here-btn.fire('click')`：按钮的 addEventListener 在 App.init()
  //    里，而这一节刻意不跑 init()（那需要 ui.mjs 那种完整 DOM 打桩）。
  //    "按钮真的连到这些方法上"由两处保证：第 1 节钉 app.js 源码里的
  //    `on('mapview-*')` 绑定，ui.mjs 那一套用完整 DOM 真的点一遍。
  cv.fire('pointerdown', { offsetX: 10, offsetY: 10, pointerId: 1 });
  cv.fire('pointermove', { offsetX: 90, offsetY: 60, pointerId: 1 });
  cv.fire('pointerup', { pointerId: 1 });
  eq(mv.follow, false, '在手机上拖一下地图：停止跟随');
  app.mapview_frame(true);
  ok(Math.abs(mv.view.lat - 30.05) > 1e-6, '自由查看时位置再动也不会把地图拽回去');
  mv.recenter();
  eq(mv.follow, true, '「回到当前位置」的处理体把跟随打开');
  app.mapview_frame(true);
  near(mv.view.lat, 30.05, '点完之后中心回到当前位置', 1e-9);

  // ---- 放大/缩小按钮的处理体 ----
  const z_before = mv.view.zoom;
  mv.zoom_by(1.0);
  ok(mv.view.zoom > z_before, '「放大」的处理体放大一档');
  mv.zoom_by(-1.0, 120, 120);
  near(mv.view.zoom, z_before, '「缩小」的处理体缩回原样', 1e-9);

  // ---- mapview.js 没加载成功时：只写日志，导航照常（不抛）----
  {
    // 第二个 App 实例（等价于"又开了一个页面"）照样能建出自己的地图视图 ——
    // 地图不是单例的全局状态
    const app2 = new APP.App();
    app2.log = () => {};
    ok(app2.mapview_instance() instanceof MV.MapView,
       '新开一个 App 实例也能建出自己的地图视图（互不影响）');
    ok(app2.mapview !== app.mapview, '两个实例的地图是两个对象');

    // 模拟"模块没加载"：app.js 在**加载时**就把 root.NavPuckMapView 抓进闭包了，
    // 所以只把全局置空是不够的 —— 必须重新 require 一遍，模拟"mapview.js 那个
    // <script> 没加载成功"的真实情况。
    const app_path = path.join(PHONE_DIR, 'app.js');
    globalThis.NavPuckMapView = undefined;
    delete require.cache[require.resolve(app_path)];
    const APP2 = require(app_path);
    const app3 = new APP2.App();
    const logs3 = [];
    app3.log = (l) => { logs3.push(String(l)); };
    eq(app3.mapview_instance(), null, 'mapview.js 没加载成功时 mapview_instance() 返回 null（不抛）');
    ok(logs3.some((l) => /地图模块（mapview\.js）没加载成功/.test(l)),
       '地图模块缺失时日志说清楚"不影响导航"');
    eq(app3.mapview_frame(true), false, '模块缺失时 mapview_frame 安全返回 false');
    eq(app3.set_mapview_route([[30, 120], [30.001, 120.001]]), false,
       '模块缺失时 set_mapview_route 安全返回 false（只把折线记下来）');
    globalThis.NavPuckMapView = MV;
    delete require.cache[require.resolve(app_path)];
    require(app_path);
  }

  // ---- 导航循环里的那一帧：Navigator 每帧调 App.on_ui -> mapview_frame ----
  //      （这是"导航中地图跟着车走"的那条真实路径，不是直接调 mapview）
  //
  // ⚠️ 这里同时钉住**节流**的行为：on_ui 是 10Hz 调的，而地图不该跟着 10Hz
  //    重画（位置本身就没那么快，每帧重画是白烧电）。所以紧接着一帧之后的
  //    on_ui 必须**不**产生新帧；等过了一个节流周期才画。
  {
    app.geo = { lat: 30.01, lon: 120.01, heading: 5 };
    app.map_source = { ways: live_ways, set_enabled() {}, tiles: null };
    app.mapview_frame(true);
    const frames_before = mv.stats.frames;
    const move_before = ctx.count('moveTo');
    const ui_frame = () => app.on_ui({
      update: {
        speed_kmh: 40.0, dist_dest_m: 1200, dist_next_m: 300, view_range_m: 160,
        progress_pct: 12, heading_deg: 5, eta_min: 2,
      },
      turn_name: '直行', road_name: '北山街',
    });
    ui_frame();                        // 紧跟着上一帧：应当被 5Hz 节流挡住
    eq(mv.stats.frames, frames_before,
       '紧跟着一帧的 on_ui 被节流挡下（10Hz 的 on_ui 不会变成 10Hz 重画）');
    await sleep(MV.MIN_PERIOD_MS + 40);
    ui_frame();                        // 过了节流周期：这一帧要真的画出来
    ok(mv.stats.frames > frames_before,
       `过了 ${MV.MIN_PERIOD_MS}ms 之后 on_ui 真的让地图画了一帧` +
       `（${frames_before} -> ${mv.stats.frames}）`);
    ok(ctx.count('moveTo') > move_before, '这一帧真的往画布上画了东西');
    near(mv.view.lat, 30.01, '这一帧之后地图中心跟着位置走了', 1e-9);
  }
})();

// ---------------------------------------------------------------------------
// 可选：把同一批绘制调用栅格化成 PNG（肉眼验证）
// ---------------------------------------------------------------------------
if (process.env.NAVPUCK_MV_PNG) {
  const { make_png_ctx } = await import('./pngctx.mjs');
  section('10] 出图（肉眼验证；只在设了 NAVPUCK_MV_PNG 时跑）');
  const W = 480;
  const view = MV.make_view({ lat: 30.2545, lon: 120.1350, zoom: 15, w: W, h: W });
  // 一片像样的路网：主干道 + 网格支路 + 一条斜穿的快速路
  const ways = [];
  const rnd = mulberry32(2024);
  for (let i = -12; i <= 12; i += 1) {
    ways.push([6, [[view.lat - 0.02, view.lon + i * 0.0016],
                   [view.lat + 0.02, view.lon + i * 0.0016 + 0.0004]]]);
    ways.push([6, [[view.lat + i * 0.0016, view.lon - 0.02],
                   [view.lat + i * 0.0016 + 0.0004, view.lon + 0.02]]]);
  }
  for (let i = -6; i <= 6; i += 2) {
    ways.push([2, [[view.lat - 0.02, view.lon + i * 0.0028],
                   [view.lat + 0.02, view.lon + i * 0.0028 - 0.0006]]]);
  }
  ways.push([0, [[view.lat - 0.021, view.lon - 0.019], [view.lat, view.lon],
                 [view.lat + 0.021, view.lon + 0.019]]]);
  ways.push([4, [[view.lat - 0.019, view.lon + 0.017], [view.lat + 0.019, view.lon - 0.013]]]);
  const route = [];
  for (let i = 0; i <= 60; i += 1) {
    route.push([view.lat - 0.012 + i * 0.0004,
                view.lon - 0.010 + i * 0.00035 + Math.sin(i / 6) * 0.0012]);
  }
  const png = make_png_ctx(W, W, 2);
  const inst = new MV.MapView(null, { ctx: png, w: W, h: W, now_ms: () => 1000000 });
  inst.view = MV.make_view(view);
  inst.dpr = 2;
  inst.draw(png, { view: inst.view, ways: ways, route: route,
                   pos: [view.lat - 0.004, view.lon - 0.003, 42], source: 'local',
                   local: { have: 6, need: 9, coverage: 'partial' } });
  const out = process.env.NAVPUCK_MV_PNG;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const n = png.to_png(out);
  console.log(`      已写出 ${out}（${n} 字节，${W * 2}×${W * 2} 像素，` +
              `${ways.length} 段路网 + 航线 + 车标；文本不进像素）`);
  ok(n > 1000, `PNG 出图成功（${n} 字节）`);
  ok(png.strokes > 0 && png.fills > 0, `真的画了东西（${png.strokes} 次描边 / ${png.fills} 次填充）`);
}

end_sections();

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`  手机端地图视图自测通过：${passed} 项全部通过。`);
} else {
  console.log(`  ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log('='.repeat(66));
process.exit(failures.length === 0 ? 0 : 1);
