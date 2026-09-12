/*
 * NavPuck **离线瓦片底图** 自测。
 *
 * 前面四套测的是"协议 / 导航语义 / 接线 / 界面"。这一套测的是这一版新加的
 * 那条路：**路网从哪来**。
 *
 * 为什么它值得单独一套：
 *   这一版的核心风险不是"代码写错了"，而是**两个实现之间的契约**——
 *   生成端是 Python（tools/make_tiles*.py），运行端是 JS（phone/tiles.js），
 *   中间隔着一条二进制格式。任何一边改一点字节，症状都不是本机报错，
 *   而是**手机上底图整体偏掉或者干脆画不出来**，而且现场几乎没法查。
 *   所以这里把契约钉死成三件事：
 *
 *     1) **字节级**：Python 编出来的 .npt，JS 解得回来，坐标逐点一致
 *        （真的起 python 子进程，不是"照着文档再写一遍"）。
 *     2) **表格级**：道路等级表两边逐项相同（否则同一条路在"瓦片"和
 *        "Overpass 兜底"两条路上等级不同，瓦片边界上会看见跳变）。
 *     3) **行为级**：有瓦片时**绝不能碰 Overpass**；没覆盖时才兜底；
 *        存储/网络不管怎么坏都不能把导航拖下水。
 *
 * 还有一条这一版最容易搞坏、又最不该搞坏的东西，也钉在这里：
 *   ⭐ **缓存变大 ≠ 发给设备的帧变大**。这是硬约束（设备端 64 段/400 点），
 *      所以"手上有一大片瓦片"时必须仍然按 view×1.6 裁完再发。
 *
 * 怎么跑（在 navpuck 根目录）：
 *     node phone/test/tiles.mjs
 *
 * 没有 python 时第 1 节会 SKIP 并明确打印出来（**不伪装成通过**），
 * 其余各节照跑。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(PHONE_DIR, '..');

const NM = require(path.join(PHONE_DIR, 'navmath.js'));
const RT = require(path.join(PHONE_DIR, 'route.js'));
const TL = require(path.join(PHONE_DIR, 'tiles.js'));
const MAP = require(path.join(PHONE_DIR, 'map.js'));

// ---------------------------------------------------------------------------
// 测试框架（和别的几套保持同一种输出形状）
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let group = '';
// ⚠️ 自测自己的"防静默跳过"闸门。
//    写这套测试的时候真的踩过一次：三个 section 的 async IIFE 收尾写成了
//    `});` 而不是 `})();` —— 于是那三节**什么都没跑**，而输出看起来完全正常
//    （标题打了、没有 ✗、最后还打印"通过"）。这类"测试自己悄悄不执行"是最
//    危险的失败模式，所以每次切节都检查上一节至少产生了一条断言。
let _last_total = -1;    // -1：第一次 section() 不该报"上一节没跑"
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
function throws(fn, l) {
  let threw = false;
  try { fn(); } catch (_e) { threw = true; }
  ok(threw, l);
}

// ---------------------------------------------------------------------------
// 测试自己写一个 .npt **编码器**。
//
// 刻意**不**复用 tiles.js 里的任何东西：它是照着格式说明（文件头那一段）
// 独立写的，所以"解码器理解错了格式"这件事才可能被抓出来。
// 用同一份代码编、同一份代码解，那种测试只能证明"它自己和自己一致"。
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
  u8[0] = 0x4E; u8[1] = 0x50; u8[2] = 0x54; u8[3] = 0x31;   // "NPT1"
  u8[4] = 1; u8[5] = z;
  dv.setUint16(6, 0, true);
  dv.setInt32(8, Math.round(lon_c * 1e7), true);
  dv.setInt32(12, Math.round(lat_c * 1e7), true);
  dv.setUint16(16, ranks.length, true);
  dv.setUint16(18, pt_count, true);
  let off = 20;
  for (const r of ranks) { u8[off] = r; off += 1; }
  for (const n of counts) { u8[off] = n; off += 1; }
  for (const v of pts) { dv.setInt16(off, v, true); off += 2; }
  return buf;
}

/** 把"相对瓦片中心的米"变成 dm 数组（测试里的输入方便用）。 */
function dm_of(meters) {
  const out = [];
  for (const [ex, ny] of meters) { out.push(Math.round(ex * 10), Math.round(ny * 10)); }
  return out;
}

/**
 * 按**分列索引**的真实布局造一个站点目录（和 tools/make_tiles.py 的
 * write_index_and_manifest 输出一致）：
 *
 *     index.json            头部：只有范围 + 计数，**没有逐块列表**
 *     index/<z>/<x>.json    一列一个文件：{"x":..,"y":[..]}
 *
 * ⚠️ 这个 helper 本身就钉着格式：如果生成端改了布局，这里对不上就会红。
 *    客户端只按这个布局取（phone/tiles.js），两边必须一致。
 */
function site_files(z, ids, base) {
  const b = base || 'https://t/';
  const cols = new Map();
  for (const id of ids) {
    const p = String(id).split('/');
    const x = Number(p[1]);
    const y = Number(p[2]);
    if (!cols.has(x)) cols.set(x, []);
    cols.get(x).push(y);
  }
  const xs = Array.from(cols.keys()).sort((a, c) => a - c);
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const ys of cols.values()) {
    for (const y of ys) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  }
  const files = {};
  files[`${b}index.json`] = JSON.stringify({
    v: 1, fmt: 'npt1', z: z, unit: 'dm', n: ids.length,
    xr: xs.length ? [xs[0], xs[xs.length - 1]] : [0, 0],
    yr: xs.length ? [ymin, ymax] : [0, 0],
    cdir: 'index',
  });
  for (const [x, ys] of cols) {
    files[`${b}index/${z}/${x}.json`] =
      JSON.stringify({ x: x, y: ys.slice().sort((a, c) => a - c) });
  }
  return files;
}

/** 空覆盖：头部在很远的地方 —— 客户端**一次列请求都不该发**就能判"没覆盖"。 */
function empty_site_files(z, base) {
  const b = base || 'https://t/';
  return {
    [`${b}index.json`]: JSON.stringify({
      v: 1, fmt: 'npt1', z: z, unit: 'dm', n: 0,
      xr: [1, 1], yr: [1, 1], cdir: 'index',
    }),
  };
}

// ---------------------------------------------------------------------------
// 极简 IndexedDB 假实现。
//
// ⚠️ 为什么不直接 `indexedDB: null`：那样测的就只是"没有持久化时也能跑"，
//    而**持久化恰恰是这一版的核心**（"骑到哪都有底图"靠的就是它）。
//    所以这里照着真实 IDB 的**异步**形状造：请求回调 + 事务 oncomplete，
//    顺序错了（比如事务先于请求完成）就会被这些测试抓出来。
// ---------------------------------------------------------------------------
class FakeRequest {
  constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; this.error = null; }
}
class FakeStore {
  constructor(map) { this.map = map; }
  get(k) {
    const r = new FakeRequest();
    this._later(() => { r.result = this.map.has(k) ? this.map.get(k) : undefined; if (r.onsuccess) r.onsuccess(); });
    return r;
  }
  put(v, k) {
    const r = new FakeRequest();
    this._later(() => { this.map.set(k, v); r.result = k; if (r.onsuccess) r.onsuccess(); });
    return r;
  }
  delete(k) {
    const r = new FakeRequest();
    this._later(() => { this.map.delete(k); if (r.onsuccess) r.onsuccess(); });
    return r;
  }
  clear() {
    const r = new FakeRequest();
    this._later(() => { this.map.clear(); if (r.onsuccess) r.onsuccess(); });
    return r;
  }
  getAllKeys() {
    const r = new FakeRequest();
    this._later(() => { r.result = Array.from(this.map.keys()); if (r.onsuccess) r.onsuccess(); });
    return r;
  }
  // 请求走的是**下一个**宏任务：和真实 IDB 一样"不是同步就绪的"
  _later(fn) { this._tx && this._tx._add(fn); if (!this._tx) setTimeout(fn, 0); }
}
class FakeTx {
  constructor(db, names) {
    this.db = db;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._pending = 0;
    this._fired = false;
    this._names = names;
    setTimeout(() => this._maybe(), 0);
  }
  _add(fn) { this._pending += 1; setTimeout(() => { fn(); this._pending -= 1; this._maybe(); }, 0); }
  _maybe() {
    if (this._fired || this._pending > 0) return;
    this._fired = true;
    if (this.oncomplete) this.oncomplete();
  }
  objectStore(name) {
    const s = new FakeStore(this.db._data[name]);
    s._tx = this;
    return s;
  }
}
class FakeIdb {
  constructor() { this.dbs = new Map(); this.opens = 0; }
  open(name, version) {
    this.opens += 1;
    const req = new FakeRequest();
    let db = this.dbs.get(name);
    const created = !db;
    if (!db) {
      const data = { tiles: new Map(), meta: new Map() };
      db = {
        _data: data,
        objectStoreNames: { contains: (n) => Object.prototype.hasOwnProperty.call(data, n) },
        createObjectStore: (n) => { data[n] = new Map(); },
        transaction: (n) => new FakeTx(db, n),
      };
      this.dbs.set(name, db);
    }
    setTimeout(() => {
      req.result = db;
      if (created && req.onupgradeneeded) req.onupgradeneeded();
      if (req.onsuccess) req.onsuccess();
    }, 0);
    return req;
  }
}

// ---------------------------------------------------------------------------
// 假的 localStorage（sticky base 要用）
// ---------------------------------------------------------------------------
function fake_storage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

// ---------------------------------------------------------------------------
// 假 fetch：按 URL 路由到"站点目录"上
// ---------------------------------------------------------------------------
function fake_site(files) {
  const log = [];
  const f = async (url) => {
    log.push(url);
    const hit = files[url];
    if (hit === undefined) {
      return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); },
               async text() { return 'Not Found'; } };
    }
    if (typeof hit === 'string') {
      return { ok: true, status: 200, async text() { return hit; },
               async arrayBuffer() { return new TextEncoder().encode(hit).buffer; } };
    }
    return { ok: true, status: 200, async text() { return ''; },
             async arrayBuffer() { return hit; } };
  };
  f.log = log;
  return f;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 喂给 python 的那段探针：用**真正的生成端代码**编一块瓦片，
 * 把字节、中心点、slippy 算术和等级表一起以 JSON 打回来。
 *
 * ⚠️ 里面**没有**任何对 navpuck 之外东西的依赖（只用标准库 + make_tiles.py），
 *    所以它不需要 raw 缓存、不联网、也不会碰 Overpass。
 */
const PY_PROBE = `
import sys, json
sys.path.insert(0, r"${path.join(ROOT_DIR, 'tools')}")
import make_tiles as mt
segs_m = [
    (0, [(0.0, 0.0), (100.0, 0.0), (100.0, 50.5)]),
    (6, [(-20.0, -30.0), (-25.0, 40.0), (0.0, 0.0), (17.3, -8.4)]),
]
blob = mt.encode_tile(14, 13808, 6093, segs_m)
lat_c, lon_c = mt.tile_center(14, 13808, 6093)
sys.stdout.write(json.dumps({
    "hex": blob.hex(),
    "lat_c": lat_c, "lon_c": lon_c,
    "segs_m": [[list(p) for p in g] for _r, g in segs_m],
    "tile_of": list(mt.tile_of(41.8057, 123.4315, 14)),
    "bounds": list(mt.tile_bounds(14, 13808, 6093)),
    "len": len(blob),
}))
`;

/** 等后台下载队列安静下来（队列是 fire-and-forget 的）。 */
async function settle(store, rounds) {
  for (let i = 0; i < (rounds === undefined ? 40 : rounds); i += 1) {
    await sleep(2);
    const s = store.stats();
    if (s.pending === 0 && s.inflight === 0) return;
  }
}

// ===========================================================================
// 1] 格式契约：Python 生成端 ↔ JS 运行端
// ===========================================================================
section('1] .npt 格式契约（真的起 python 子进程对拍）');
{
  // 1a) 道路等级表必须逐项相同。这个**不依赖 python**，永远跑：
  //     直接从 Python 源码里把那个字面量抠出来（保持 {k: v, ...} 的写法
  //     就是为了能被这样读出来 —— 见 make_tiles.py 里的说明）。
  const py_src = fs.readFileSync(path.join(ROOT_DIR, 'tools', 'make_tiles.py'), 'utf8');
  const m = /HIGHWAY_RANK\s*=\s*\{([\s\S]*?)\n\}/.exec(py_src);
  ok(!!m, '能从 tools/make_tiles.py 里找到 HIGHWAY_RANK 字面量');
  if (m) {
    const py_rank = {};
    // ⚠️ 必须用**全局**正则：那个字面量是一行写好几项的
    //    （"motorway": 0, "motorway_link": 1, ...），非全局的 exec 一行只会
    //    取到第一项 —— 那样这个"表格级对拍"会退化成"只比了几个键"，
    //    而它看起来还是通过的。
    const re = /"([a-z_]+)"\s*:\s*(\d+)/g;
    let mm;
    while ((mm = re.exec(m[1])) !== null) py_rank[mm[1]] = Number(mm[2]);
    ok(Object.keys(py_rank).length >= 15,
       `从 Python 源码里读出了 ${Object.keys(py_rank).length} 项等级（应该 >= 15）`);
    eq(py_rank, RT.HIGHWAY_RANK,
       'Python 的 HIGHWAY_RANK 与 route.js 的逐项相同（瓦片和 Overpass 兜底必须同一套等级）');
  }

  // 1b) 字节级：Python 编码 -> JS 解码。
  let py = null;
  try {
    py = execFileSync('python', ['-c', PY_PROBE], { encoding: 'utf8', timeout: 60000 });
  } catch (e) {
    py = null;
    console.log(`  ⚠️ SKIP：起不了 python（${String(e.message).split('\n')[0]}）——` +
      '字节级对拍没跑，**这一节的其余部分不算通过**');
  }
  if (py) {
    const j = JSON.parse(py.trim());
    const buf = Buffer.from(j.hex, 'hex');
    const dec = TL.decode_tile(buf);
    eq(dec.z, 14, '解码出的 z 与生成端一致');
    near(dec.lat_c, j.lat_c, '瓦片中心纬度一致');
    near(dec.lon_c, j.lon_c, '瓦片中心经度一致');
    eq(dec.segs.length, 2, '段数与生成端一致');
    eq(dec.segs[0][0], 0, '第一段的 rank 一致');
    eq(dec.segs[1][0], 6, '第二段的 rank 一致');

    // 逐点比对：生成端给的是**米**（相对瓦片中心），解码端给的是经纬度。
    // 期望值在这里用**另一条路**算出来（米 -> 度），和 tiles.js 内部的
    // 那条路径不是同一段代码。
    const k_lon = TL.EARTH_M_PER_DEG_LON_EQ * Math.cos(dec.lat_c * Math.PI / 180);
    const exp_lat = (m) => dec.lat_c + m / TL.EARTH_M_PER_DEG_LAT;
    const exp_lon = (m) => dec.lon_c + m / k_lon;
    const seg0 = j.segs_m[0];
    let all_ok = true;
    for (let i = 0; i < seg0.length; i += 1) {
      const want_lat = exp_lat(seg0[i][1]);
      const want_lon = exp_lon(seg0[i][0]);
      const got = dec.segs[0][1][i];
      if (Math.abs(got[0] - want_lat) > 1e-9 || Math.abs(got[1] - want_lon) > 1e-9) all_ok = false;
    }
    ok(all_ok, `第一段 ${seg0.length} 个点逐点一致（米 -> 度，误差 < 1e-9 度）`);

    const seg1 = j.segs_m[1];
    let all_ok2 = true;
    for (let i = 0; i < seg1.length; i += 1) {
      const got = dec.segs[1][1][i];
      if (Math.abs(got[0] - exp_lat(seg1[i][1])) > 1e-9 ||
          Math.abs(got[1] - exp_lon(seg1[i][0])) > 1e-9) all_ok2 = false;
    }
    ok(all_ok2, `第二段 ${seg1.length} 个点逐点一致`);

    // 解码**精度**：生成端量化到分米，所以往返误差必须 <= 0.05 m（每轴）。
    let worst = 0;
    for (let i = 0; i < seg0.length; i += 1) {
      const dx = (dec.segs[0][1][i][1] - exp_lon(seg0[i][0])) * k_lon;
      const dy = (dec.segs[0][1][i][0] - exp_lat(seg0[i][1])) * TL.EARTH_M_PER_DEG_LAT;
      worst = Math.max(worst, Math.abs(dx), Math.abs(dy));
    }
    ok(worst <= 0.0500001, `量化误差 <= 0.05 m（实测最坏 ${worst.toFixed(4)} m ≈ 设备 1m/px 的 1/20 像素）`);

    // 1c) slippy 算术两边一致
    eq(TL.tile_of(41.8057, 123.4315, 14), { x: j.tile_of[0], y: j.tile_of[1] },
       'JS 的 tile_of 与 Python 的相同（沈阳中心）');
    const b = TL.tile_bounds(14, 13808, 6093);
    near(b.south, j.bounds[0], 'tile_bounds.south 与 Python 相同');
    near(b.west, j.bounds[1], 'tile_bounds.west 与 Python 相同');
    near(b.north, j.bounds[2], 'tile_bounds.north 与 Python 相同');
    near(b.east, j.bounds[3], 'tile_bounds.east 与 Python 相同');
  }
}

// ===========================================================================
// 2] 解码器的健壮性：坏数据**必须抛**，不能静默当成"这里没有路"
// ===========================================================================
section('2] decode_tile 对坏数据必须抛（静默降级会让 bug 永远查不出来）');
{
  const good = mk_tile(14, 13808, 6093, [[0, dm_of([[0, 0], [10, 0], [10, 10]])]]);
  const dec = TL.decode_tile(good);
  eq(dec.seg_count, 1, '正常瓦片解得出来');
  eq(dec.pt_count, 3, '点数正确');
  eq(dec.segs[0][1].length, 3, '段内点数正确');

  throws(() => TL.decode_tile(new ArrayBuffer(8)), '太短 -> 抛');
  const bad_magic = good.slice(0);
  new Uint8Array(bad_magic)[0] = 0x58;
  throws(() => TL.decode_tile(bad_magic), 'magic 不对 -> 抛');
  const bad_ver = good.slice(0);
  new Uint8Array(bad_ver)[4] = 9;
  throws(() => TL.decode_tile(bad_ver), '版本不支持 -> 抛');
  throws(() => TL.decode_tile(good.slice(0, 30)), '长度不够（被截断）-> 抛');

  // 头部写 3 个点、段表里写 2 个点：长度对得上、点数对不上 -> 必须抛
  const lie = good.slice(0);
  new DataView(lie).setUint16(18, 2, true);
  throws(() => TL.decode_tile(lie), '段点数之和 != 头部总点数 -> 抛');

  // 段长 1（不是合法折线）
  const one = good.slice(0);
  new Uint8Array(one)[20 + 1] = 1;      // counts[0] = 1
  throws(() => TL.decode_tile(one), '段长 < 2 -> 抛');
}

// ===========================================================================
// 3] 瓦片地址：PWA 和 APK 是**两套**，必须都解析对
// ===========================================================================
section('3] 瓦片根地址解析（PWA 相对 / APK 绝对 / 非浏览器环境没有）');
{
  const pwa = TL.candidate_bases({
    href: 'https://hxyt66.github.io/navpuck/phone/index.html',
    pathname: '/navpuck/phone/index.html',
  });
  eq(pwa, ['https://hxyt66.github.io/navpuck/tiles/'],
     'PWA：相对路径 ../tiles/ 解析后与绝对地址**是同一个**（所以只留一个）');

  const pwa2 = TL.candidate_bases({
    href: 'https://example.com/x/phone/',
    pathname: '/x/phone/',
  });
  eq(pwa2, ['https://example.com/x/tiles/', TL.PAGES_BASE],
     'PWA（换域名）：相对路径排第一、绝对地址做后备 —— 换部署位置不用改代码');

  const apk = TL.candidate_bases({ href: 'https://localhost/index.html', pathname: '/index.html' });
  eq(apk, [TL.PAGES_BASE],
     'APK（Capacitor，页面在 https://localhost/ 根）：**只有**绝对地址 —— ' +
     '../tiles/ 在这里根本不存在');

  eq(TL.candidate_bases(null), [],
     '没有 location（Node 自测）-> 空：这一端没有瓦片能力，行为退回纯 Overpass');

  // sticky：上次成功的排第一，而且必须是当前候选里的那一个
  const st = fake_storage();
  st.setItem(TL.BASE_KEY, 'https://example.com/x/tiles/');
  const s1 = new TL.TileStore({
    bases: pwa2, storage: st, indexedDB: null,
    fetch: async () => ({ ok: false, status: 404 }),
  });
  eq(s1._base_order()[0], 'https://example.com/x/tiles/', 'sticky：记住的那个排第一');
  st.setItem(TL.BASE_KEY, 'https://bogus.invalid/tiles/');
  const s2 = new TL.TileStore({
    bases: pwa2, storage: st, indexedDB: null,
    fetch: async () => ({ ok: false, status: 404 }),
  });
  eq(s2._base_order(), pwa2, 'sticky 存坏了/不在候选里 -> 退回静态顺序（不会每轮先试一个坏地址）');
}

// ===========================================================================
// 4] 存储 + 下载：覆盖判断、404、损坏、离线复用
// ===========================================================================
section('4] 瓦片存储与下载（假 IndexedDB + 假站点）');
await (async () => {
  const Z = 14;
  const LAT = 41.8057, LON = 123.4315;
  const HERE = TL.tile_of(LAT, LON, Z);
  const id_here = TL.tile_id(Z, HERE.x, HERE.y);
  // 圆心周围 1500m 要几块：z14 在沈阳的实地边长 ≈1823m，所以 3000m 的方框
  // 跨 1.65 块 -> 每轴 2 或 3 块，合计 6 或 9 块（**不是**恒等于 9，
  // 取决于圆心落在格子里的位置）。这里钉的是**覆盖性**，不是那个数字。
  const probe = new TL.TileStore({ bases: ['https://t/'], indexedDB: null });
  const need_ids = probe.tiles_for_area(LAT, LON, 1500);
  ok(need_ids.length >= 4 && need_ids.length <= 9,
     `圆 1500m 在 z14 下需要 4~9 块瓦片（实得 ${need_ids.length}）`);
  // 覆盖性：外接正方形的四个角都必须落在**某一块**返回的瓦片里
  {
    const dlat = 1500 / TL.EARTH_M_PER_DEG_LAT;
    const dlon = 1500 / (TL.EARTH_M_PER_DEG_LON_EQ * Math.cos(LAT * Math.PI / 180));
    const set = new Set(need_ids);
    let covered = true;
    for (const la of [LAT - dlat, LAT + dlat]) {
      for (const lo of [LON - dlon, LON + dlon]) {
        const t = TL.tile_of(la, lo, Z);
        if (!set.has(TL.tile_id(Z, t.x, t.y))) covered = false;
      }
    }
    ok(covered, '外接正方形的四个角都被返回的瓦片盖住了（覆盖性，不是数量）');
    ok(set.has(id_here), '骑手所在的那一块一定在里面');
  }

  const blob_here = mk_tile(Z, HERE.x, HERE.y,
    [[0, dm_of([[0, 0], [50, 0], [50, 30]])], [6, dm_of([[-20, -20], [20, 20]])]]);

  // ---- 4a) 只发布了"骑手脚下那一块"：只下它，其余按头部范围直接判"没有" ----
  {
    const site = fake_site(Object.assign(site_files(Z, [id_here]),
      { [`https://t/${id_here}.npt`]: blob_here }));
    const store = new TL.TileStore({
      fetch: site, bases: ['https://t/'], storage: fake_storage(),
      indexedDB: new FakeIdb(), now: () => 1000,
    });
    await store.load_area(LAT, LON, 1500);
    await settle(store);
    const r2 = await store.load_area(LAT, LON, 1500);
    eq(r2.have.length, 1, '只有 1 块本地有（其余块不在已发布的范围内）');
    eq(r2.coverage, 'partial', '覆盖 = partial（有一块，但不全）');
    ok(r2.ways.length === 2, `解出 2 段路网（实得 ${r2.ways.length}）`);
    eq(r2.ways[0][0] <= r2.ways[1][0], true, 'ways 按 rank 升序（点预算不够时先丢次要道路）');
    // 下载次数：index 一次 + 瓦片一次；第二次 load_area 一次网络都不该有
    const before = site.log.length;
    await store.load_area(LAT, LON, 1500);
    eq(site.log.length - before, 0, '第二次 load_area **零网络请求**（内存/IDB 命中）');
    eq(store.stats().done, 1, '一共只真的下了 1 块');
    // ⭐ 分列索引的核心指标：一次启动只下"头部 + 当前那几列"
    const meta = site.log.filter((u) => /index\.json|index\/14\//.test(u));
    ok(meta.length <= 1 + 3,
       `一次启动只取 1 个头部 + 至多 3 个列文件（实得 ${meta.length} 个元数据请求）`);
    ok(store.stats().index_tiles === 1,
       `索引里统计到的块数 = 1（实得 ${store.stats().index_tiles}）`);
  }

  // ---- 4b) 头部范围就不包含这一带 -> 一次列请求都不发，直接判"没覆盖" ----
  {
    const site = fake_site(empty_site_files(Z));
    const store = new TL.TileStore({
      fetch: site, bases: ['https://t/'], storage: fake_storage(),
      indexedDB: new FakeIdb(), now: () => 1000,
    });
    const r = await store.load_area(LAT, LON, 1500);
    eq(r.coverage, 'none', '头部范围不含这一带 -> coverage = none（确定没有）');
    eq(r.ways.length, 0, '没有任何路网');
    eq(r.downloading, 0, '一块都不去下');
    eq(site.log.length, 1,
       `只取了 index.json 一次，**一个列文件都没取**（实得 ${site.log.length} 次请求）`);
  }

  // ---- 4b2) 索引在、块 404：必须记成"上游没有"，而不是"下载失败" ----
  {
    const site = fake_site(site_files(Z, need_ids));   // 索引说 9 块都有，但 .npt 一个都不给
    const store = new TL.TileStore({
      fetch: site, bases: ['https://t/'], storage: fake_storage(),
      indexedDB: new FakeIdb(), now: () => 1000,
    });
    await store.load_area(LAT, LON, 1500);
    await settle(store);
    ok(store.is_absent(id_here), '404 被记成 "上游没有这一块"（absent）');
    eq(store.stats().failed, 0, '404 **不算**下载失败（两者在界面上是两件事）');
    const r = await store.load_area(LAT, LON, 1500);
    eq(r.coverage, 'partial', '索引说有、但块 404 -> 不是 none（不谎报"没覆盖"）');
  }

  // ---- 4c) 下回来的东西不是瓦片（比如被返回了一页 HTML）-> 不写进缓存 ----
  {
    const files = site_files(Z, need_ids);
    files[`https://t/${id_here}.npt`] = '<!doctype html><html>404</html>';
    const site = fake_site(files);
    const store = new TL.TileStore({
      fetch: site, bases: ['https://t/'], storage: fake_storage(),
      indexedDB: new FakeIdb(), now: () => 1000,
    });
    await store.load_area(LAT, LON, 1500);
    await settle(store);
    eq(store.stats().done, 0, '坏内容不算"下好了"');
    ok(store.stats().failed >= 1, '坏内容记成失败（会按冷却重试）');
    ok(!!store.stats().last_error, `状态里带着原因：${store.stats().last_error}`);
    const r = await store.load_area(LAT, LON, 1500);
    eq(r.ways.length, 0, '坏数据没有变成"路网"（否则会静默画出一片垃圾）');
  }

  // ---- 4e) 离线复用：站点整个消失了，本地那几块照样能用 ----
  {
    const idb = new FakeIdb();
    const site = fake_site(Object.assign(site_files(Z, need_ids),
      { [`https://t/${id_here}.npt`]: blob_here }));
    const store = new TL.TileStore({
      fetch: site, bases: ['https://t/'], storage: fake_storage(),
      indexedDB: idb, now: () => 1000,
    });
    await store.load_area(LAT, LON, 1500);
    await settle(store);

    // 换一个**完全连不上**的 fetch，模拟"骑到没信号的地方"
    const dead = async () => { throw new TypeError('fetch failed'); };
    const store2 = new TL.TileStore({
      fetch: dead, bases: ['https://t/'], storage: fake_storage(),
      indexedDB: idb, now: () => 1000,
    });
    const r2 = await store2.load_area(LAT, LON, 1500);
    eq(r2.have.length, 1, '**断网**状态下从 IndexedDB 里拿到了那一块（这就是离线底图）');
    eq(r2.ways.length, 2, '并且真的解出了路网');
  }

  // ---- 4f) sticky base：第一个地址 404，第二个能用 -> 记住第二个 ----
  {
    const st = fake_storage();
    const site = fake_site(Object.assign(site_files(Z, [id_here], 'https://good/'),
      { [`https://good/${id_here}.npt`]: blob_here }));
    const store = new TL.TileStore({
      fetch: site, bases: ['https://bad/', 'https://good/'], storage: st,
      indexedDB: new FakeIdb(), now: () => 1000,
    });
    await store.load_area(LAT, LON, 1500);
    await settle(store);
    eq(store.stats().base, 'https://good/', '换到了能用的那个地址');
    eq(st.getItem(TL.BASE_KEY), 'https://good/', '并且记进了 localStorage（下一轮先试它）');
  }
})();

// ===========================================================================
// 5] 沿航线预取
// ===========================================================================
section('5] 沿航线预取（"骑到哪都有底图"就是靠它）');
await (async () => {
  const store = new TL.TileStore({
    bases: ['https://t/'], indexedDB: null, fetch: async () => ({ ok: false, status: 404 }),
    prefetch_ahead_m: 8000,
  });
  // 一条向北 40km 的直线航线，1km 一个点
  const pts = [];
  for (let i = 0; i <= 40; i += 1) pts.push([41.0 + i * (1000 / 111000), 123.4]);
  const ids = store.route_tiles(pts, 41.0, 123.4, 8000);
  ok(ids.length > 0, `沿路算出 ${ids.length} 块要预取的瓦片`);
  // 8km / 1.8km ≈ 5 块瓦片，每块向周围多取一圈 -> 大约 3×7 = 21 块
  ok(ids.length >= 12 && ids.length <= 40,
     `8km 预取窗口的瓦片数落在合理范围（实得 ${ids.length}，3 宽 × 约 7 长 + 边角）`);
  const t0 = TL.tile_of(41.0, 123.4, 14);
  ok(ids.indexOf(TL.tile_id(14, t0.x, t0.y)) >= 0, '骑手所在的那一块在计划里');
  // 窗口**必须**是有限的：不能把 40km 全排进去
  const all = store.route_tiles(pts, 41.0, 123.4, 1e9);
  ok(all.length > ids.length,
     `预取窗口真的在起作用（无限窗口 ${all.length} 块 > 8km 窗口 ${ids.length} 块）`);

  // 排队上限：一次不能排太多（细水长流，见 TILE_PLAN_MAX_PER_CALL）
  const store2 = new TL.TileStore({
    bases: ['https://t/'], indexedDB: null,
    fetch: async () => { await sleep(50); return { ok: false, status: 404 }; },
    plan_max: 6, max_inflight: 2,
  });
  const n = store2.enqueue(all, 'route');
  ok(n <= 6, `一次最多排 plan_max 块（实得 ${n}）`);
  eq(store2.stats().inflight <= 2, true, '并发不超过 max_inflight');
})();

// ===========================================================================
// 6] 与 OsmMapSource 接线：有瓦片就**绝不碰 Overpass**；没覆盖才兜底
// ===========================================================================
section('6] 接线：瓦片优先，Overpass 只在没覆盖时兜底');
await (async () => {
  const Z = 14;
  const LAT = 41.8057, LON = 123.4315;
  const HERE = TL.tile_of(LAT, LON, Z);
  // 造一整片 3×3（圆心周围 1500m）都齐的站点
  const files = {};
  const ids = [];
  const center = TL.tile_center(Z, HERE.x, HERE.y);
  const k_lon = TL.EARTH_M_PER_DEG_LON_EQ * Math.cos(center[0] * Math.PI / 180);
  // 骑手相对**中心瓦片**中心的偏移（米）。合成几何必须落在这里附近，
  // 否则 build() 的 view×1.6（=256m）会把它整条裁掉。
  const dE = (LON - center[1]) * k_lon;
  const dN = (LAT - center[0]) * TL.EARTH_M_PER_DEG_LAT;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const x = HERE.x + dx, y = HERE.y + dy;
      const id = TL.tile_id(Z, x, y);
      ids.push(id);
      // 中心那一块：三段路都画在**骑手脚下 ±60m**；周围 8 块：画在各自中心
      // 附近（它们会被裁掉，这正是"裁剪在起作用"的证据）。
      //
      // ⚠️ 中心块这个 ±60m 是有讲究的：build() 只画骑手周围 view×1.6
      //    （这里 160×1.6=256m）以内的路。把合成几何统一放到瓦片中心，
      //    而骑手又恰好离瓦片中心几百米时，裁完就是 0 段 —— 那样下面那条
      //    "缓存放大 30 倍"的断言会因为"本来就是 0 段"而**永远为真**，
      //    等于没测。写这套测试时真的这么错过一次。
      const oE = (dx === 0 && dy === 0) ? dE : 0;
      const oN = (dx === 0 && dy === 0) ? dN : 0;
      files[`https://t/${id}.npt`] = mk_tile(Z, x, y, [
        [2, dm_of([[oE - 60, oN - 60], [oE, oN], [oE + 60, oN + 60]])],
        [3, dm_of([[oE - 60, oN + 60], [oE + 60, oN - 60]])],
        [6, dm_of([[oE - 30, oN], [oE + 30, oN]])],
      ]);
    }
  }
  files['https://t/index.json'] = site_files(Z, ids)['https://t/index.json'];
  Object.assign(files, (() => {
    const s = site_files(Z, ids);
    const out = {};
    for (const k of Object.keys(s)) if (k.indexOf('index/14/') >= 0) out[k] = s[k];
    return out;
  })());

  // Overpass 的假 fetch：**只要被调用就记一笔**（这一节的核心断言就是它没被调）
  const overpass_calls = [];
  const ov_fetch = async (url) => {
    overpass_calls.push(url);
    throw new TypeError('Overpass 不应该被调用');
  };
  const site = fake_site(files);
  const src = new MAP.OsmMapSource({
    storage: null,
    fetch: ov_fetch,                    // Overpass 通道
    tile_fetch: site,                   // 瓦片通道
    tile_bases: ['https://t/'],
    indexedDB: new FakeIdb(),
    now: () => 1000, now_ms: () => 1000000,
  });
  ok(!!src.tiles, 'OsmMapSource 建起了瓦片层');
  await src.refresh(LAT, LON, 0);
  await settle(src.tiles);
  const ok1 = await src.refresh(LAT, LON, 0);
  eq(overpass_calls.length, 0, '⭐ 有瓦片覆盖时 **Overpass 一次都没被调用**');
  eq(ok1, true, 'refresh 返回 true（拿到数据）');
  ok(src.ways.length > 0, `拿到了路网（${src.ways.length} 段）`);
  eq(src.tiles_used, true, '标记了这份路网来自瓦片');
  ok(src.state === 'tiles' || src.state === 'tiles-fetching',
     `状态是瓦片态（实得 ${src.state}）`);
  const st = src.status(0);
  eq(st.from_tiles, true, 'status() 里 from_tiles = true');
  ok(/离线瓦片/.test(st.summary), `界面上说得出是离线瓦片：${st.summary}`);
  ok(st.tiles_enabled === true, 'status() 里 tiles_enabled = true');

  // 协议不变量：手上有一大片瓦片，发出去的帧**仍然**按 view×1.6 裁
  const m = src.build(LAT, LON, LAT, LON, 160.0);
  ok(m.seg_count > 0,
     `合成几何真的落在裁剪窗里（${m.seg_count} 段 / ${m.total_pts} 点）—— ` +
     '否则下面两条"不超限"的断言会永远为真，等于没测');
  ok(m.seg_count <= RT.MAP_MAX_SEGMENTS && m.total_pts <= RT.MAP_MAX_POINTS,
     `缓存里有 ${src.ways.length} 段，下发的帧仍然 <= ${RT.MAP_MAX_SEGMENTS} 段 / ` +
     `${RT.MAP_MAX_POINTS} 点（实得 ${m.seg_count} 段 / ${m.total_pts} 点）`);

  // 缓存变大**不等于**帧变大：把缓存里的东西乘 30 倍，帧一点都不能涨
  const before_segs = m.seg_count, before_pts = m.total_pts;
  const fat = [];
  for (let k = 0; k < 30; k += 1) {
    for (const w of src.ways) fat.push(w);
  }
  src.ways = fat;
  const m2 = src.build(LAT, LON, LAT, LON, 160.0);
  ok(m2.seg_count <= RT.MAP_MAX_SEGMENTS && m2.total_pts <= RT.MAP_MAX_POINTS,
     `⭐⭐ 缓存放大 30 倍（${fat.length} 段）后，帧仍然不超限（${m2.seg_count} 段 / ${m2.total_pts} 点）`);
  // ⭐ 这才是"缓存变大 ≠ 帧变大"的**真正**判据：发出去的每一个点都必须在
  //    view×1.6（=256m）以内。点数是会变的（缓存里同一段路被复制了 30 份就
  //    会多占预算，直到撞上 330 点的上限），但**覆盖范围**一个字节都不能涨 ——
  //    范围涨了就等于"我们在让设备的画布跟着缓存一起变大"，而设备那边是
  //    64 段 / 400 点的硬上限。
  const clip = 160.0 * 1.6;
  let worst = 0;
  for (const p of m2.pts) {
    worst = Math.max(worst, Math.abs(p[0]), Math.abs(p[1]));
  }
  ok(worst <= clip + 1.0,
     `缓存放 30 倍后，帧里离车最远的点仍然只有 ${worst.toFixed(1)} m ` +
     `(<= view×1.6 = ${clip} m) —— 覆盖范围没有跟着缓存涨`);
  eq(m2.total_pts <= 330, true, `点数撞的是设备上限 330，不是缓存大小（实得 ${m2.total_pts}）`);
})();

// ===========================================================================
// 7] 没覆盖 -> Overpass 兜底；兜底也忙 -> gap-busy（用户最需要的那句话）
// ===========================================================================
section('7] 没瓦片覆盖 + Overpass 也忙 -> gap-busy');
await (async () => {
  // ⭐ 这一节还钉着一个**真的踩过的坑**：`_safe_text` 曾经在 map.js 里
  //    "被调用但没定义"，于是 `!resp.ok` 那一支抛 ReferenceError、
  //    被收成 kind='other' —— 每一次 429/504 都被报成"底图不可用"，
  //    而不是"服务太忙"。所以这里喂的是**真的 HTTP 429 响应对象**
  //    （带着 text() 和状态码），把那条路径整条走通。
  const LAT = 41.8057, LON = 123.4315;
  // 头部范围不含这一带 -> 确定没有瓦片覆盖（而且一个列文件都不用取）
  const site = fake_site(empty_site_files(14));
  // Overpass 一律 429（被限流）
  const ov = async () => ({
    ok: false, status: 429,
    async text() { return 'too many requests'; },
    async json() { return {}; },
  });
  const src = new MAP.OsmMapSource({
    storage: null, fetch: ov, tile_fetch: site, tile_bases: ['https://t/'],
    indexedDB: new FakeIdb(), now: () => 1000, now_ms: () => 1000000,
    endpoints: ['https://x/'], budget_ms: 500, endpoint_timeout_ms: 400, min_slice_ms: 1,
  });
  await src.refresh(LAT, LON, 0);
  eq(src.coverage, 'none', '覆盖索引说这一带没有瓦片（coverage = none）');
  await sleep(30);
  eq(src.state, 'gap-busy', `状态 = gap-busy（实得 ${src.state}）`);
  const st = src.status(1);
  ok(/没有离线瓦片覆盖/.test(st.summary) && /Overpass/.test(st.summary),
     '这句话**同时**说了"没有瓦片覆盖"和"Overpass 也忙"两件事');
  ok(/不受影响/.test(st.summary), '并且明确说了导航不受影响');
  ok(st.short.length > 0 && /无瓦片/.test(st.short), `短状态也说清楚了：${st.short}`);

  // ---- 7b) 索引和列文件**取不到**（网络错误，不是 404）->
  //          coverage 'unknown'，绝不能谎报"这一带没覆盖" ----
  //
  //  ⚠️ 这一条和"404"必须分开：404 是服务端**明确答复**了"没有这一列"，
  //     那是"确定没有覆盖"（可以判 none）；网络错误只是"现在不知道"。
  //     两者混起来，界面就会把"这一带永远不会有瓦片"和"网不好"说成同一句话。
  {
    let clock = 1000;
    const boom = async () => { throw new TypeError('fetch failed（自测：网络炸了）'); };
    const src2 = new MAP.OsmMapSource({
      storage: null, fetch: ov, tile_fetch: boom, tile_bases: ['https://t/'],
      indexedDB: null, now: () => clock, now_ms: () => 1000000,
      endpoints: ['https://x/'], budget_ms: 500, endpoint_timeout_ms: 400, min_slice_ms: 1,
    });
    await src2.refresh(LAT, LON, 0);
    eq(src2.coverage, 'unknown', '索引取不到 -> coverage = unknown（"不知道"，不是"没有"）');
    await sleep(80);                       // 让瓦片下载全部失败、退出队列
    clock += 120;                          // 走过 60 秒的下载冷却
    await src2.refresh(LAT, LON, 10);
    eq(src2.state, 'busy', `状态说的是"服务忙"，**不谎报**"这一带没覆盖"（实得 ${src2.state}）`);
    ok(src2.coverage !== 'none', 'coverage 始终不是 none');
  }

  // ---- 7c) 索引说这一带**有**瓦片、但块下不来（503）-> 不算"没覆盖"，
  //          而且这时候**不去打扰 Overpass**（等几秒瓦片就到了，别白打限流）----
  {
    const need = new TL.TileStore({ bases: ['https://t/'], indexedDB: null })
      .tiles_for_area(LAT, LON, 1500);
    const files = site_files(14, need);
    const site3 = async (url) => {
      if (files[url]) {
        return { ok: true, status: 200, async text() { return files[url]; },
                 async arrayBuffer() { return new ArrayBuffer(0); } };
      }
      return { ok: false, status: 503, async text() { return 'service unavailable'; },
               async arrayBuffer() { return new ArrayBuffer(0); } };
    };
    let ov_calls = 0;
    const ovc = async () => { ov_calls += 1; return { ok: false, status: 429,
      async text() { return 'too many'; }, async json() { return {}; } }; };
    const src3 = new MAP.OsmMapSource({
      storage: null, fetch: ovc, tile_fetch: site3, tile_bases: ['https://t/'],
      indexedDB: null, now: () => 1000, now_ms: () => 1000000,
      endpoints: ['https://x/'], budget_ms: 500, endpoint_timeout_ms: 400, min_slice_ms: 1,
    });
    await src3.refresh(LAT, LON, 0);
    eq(src3.coverage, 'partial', '索引说有、块 503 -> coverage = partial（不是 none）');
    await sleep(40);
    eq(ov_calls, 0, '⭐ 瓦片在下的时候**不打扰 Overpass**（等几秒就有，白打只会让对方更忙）');
    eq(src3.state, 'tiles-fetching', `状态 = tiles-fetching（实得 ${src3.state}）`);
    ok(src3.status(0).short.indexOf('下载瓦片') >= 0,
       `短状态写着在下载：${src3.status(0).short}`);
  }
})();

// ===========================================================================
// 8] 没有瓦片能力时，行为必须和上一版**一模一样**
// ===========================================================================
section('8] 没有 location / tiles.js 没加载 -> 退回纯 Overpass（行为不变）');
await (async () => {
  // 8a) 不给 tile_bases / location -> tiles === null
  //
  // ⚠️ fetch 要显式给一个**会失败**的假实现，不能写 `fetch: null`：
  //    map.js 的 `o.fetch || 全局 fetch` 里，null 是**假值**，
  //    于是会退回 Node 的全局 fetch —— 测试就会真的去联网打 Overpass，
  //    既慢又不是密闭的（而且可能真的成功，把"不可用"断言搞成假阴性）。
  const dead = async () => { throw new TypeError('fetch failed（自测：不许联网）'); };
  const src = new MAP.OsmMapSource({ storage: null, fetch: dead,
                                     endpoint_timeout_ms: 50, budget_ms: 60,
                                     min_slice_ms: 1 });
  eq(src.tiles, null, '没有瓦片能力时 this.tiles === null');
  ok(!!src.tiles_error, `而且说得出为什么：${src.tiles_error}`);
  eq(src.coverage, 'off', 'coverage = off');
  const st = src.status(0);
  eq(st.tiles_enabled, false, 'status() 里 tiles_enabled = false');
  eq(st.coverage, 'off', 'status() 里 coverage = off');
  await src.refresh(41.8, 123.4, 0);
  eq(src.state, 'unavailable', '还是老行为：抓不到 -> unavailable');
  eq(src.fetch_count, 1, '真的走了 Overpass 那条老路（fetch_count=1）');

  // 8b) 明确 tiles:false
  const src2 = new MAP.OsmMapSource({ storage: null, fetch: dead, tiles: false,
                                      tile_bases: ['https://t/'] });
  eq(src2.tiles, null, 'tiles:false 明确关掉瓦片层');

  // 8c) set_route 在没有瓦片时也不能出错
  let threw = false;
  try { src.set_route([[41.0, 123.0], [41.1, 123.1]]); src.set_route(null); }
  catch (_e) { threw = true; }
  ok(!threw, '没有瓦片时 set_route 也安全');
})();
end_sections();

// ===========================================================================
// 汇总
// ===========================================================================
console.log('\n' + '='.repeat(62));
if (failures.length === 0) {
  console.log(`  离线瓦片自测通过：${passed} 项全部通过`);
  console.log('='.repeat(62));
  process.exit(0);
}
console.log(`  离线瓦片自测失败：${failures.length} 项`);
for (const f of failures) console.log(`   - ${f}`);
console.log('='.repeat(62));
process.exit(1);
