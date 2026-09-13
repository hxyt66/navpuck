/*
 * NavPuck 离线瓦片底图 —— **运行时那一半**。
 *
 * 另一半是生成端：tools/make_tiles_pbf.py（全国/全省，啃 .osm.pbf）和
 * tools/make_tiles.py（局部，走 Overpass）。两边产出同一套 .npt 文件，
 * 格式定义就在下面这一段，**改动必须两边一起改**。
 *
 * ===========================================================================
 * 为什么要有这个文件（一句话）
 * ===========================================================================
 * 底图原来是**运行时**向公共 Overpass 实例要的。用户在手机上打开
 * https://overpass-api.de/api/status，页面上写的是"0 slots available" ——
 * 那是别人捐出来的算力，长期满负荷。所以"底图时有时无"不是配置问题，
 * 是这个方案本身不稳。
 *
 * 现在改成：**预先做好的静态瓦片放在我们自己的 GitHub Pages 上**，
 * 手机按需下载几十 KB 一块，下过就永久留在本地。Overpass 退成**兜底**
 * （只用于瓦片覆盖不到的地方）。
 *
 * ===========================================================================
 * .npt 瓦片格式 v1（小端；和 tools/make_tiles.py 的 encode_segs_dm 一一对应）
 * ===========================================================================
 *   偏移  类型          含义
 *   0     char[4]       magic "NPT1"
 *   4     u8            version = 1
 *   5     u8            zoom（生成端固定 14；解码端只做校验）
 *   6     u16           flags（保留，=0）
 *   8     i32           瓦片中心经度 × 1e7
 *   12    i32           瓦片中心纬度 × 1e7
 *   16    u16           段数 seg_count
 *   18    u16           总点数 pt_count
 *   20    u8[seg]       每段的道路等级 rank（= route.js 的 HIGHWAY_RANK 数值）
 *   20+s  u8[seg]       每段的点数（2..255；超 255 的段在生成端切片了）
 *   20+2s i16[pt][2]    每点：东向、北向 —— **分米**（0.1 m），相对**瓦片中心**
 *
 * ⚠️ 坐标单位是**分米**不是米：精度损失每轴 ±0.05 m（径向最坏 0.071 m）。
 *    设备最近档约 1 m/px，也就是最坏 1/14 像素 —— 看不到。
 *    生成端为此专门用了 floor(x+0.5) 而不是 round()，两边的舍入必须一致。
 *
 * ===========================================================================
 * 瓦片怎么找到（PWA 和 APK 是**两套**，必须都处理）
 * ===========================================================================
 * 站点根 = GitHub Pages 仓库根：
 *     https://hxyt66.github.io/navpuck/phone/index.html   ← 应用
 *     https://hxyt66.github.io/navpuck/tiles/14/x/y.npt   ← 瓦片
 *
 *   PWA（手机浏览器打开 Pages）：页面在 /navpuck/phone/ 里，
 *     相对路径 '../tiles/' 正好指向 /navpuck/tiles/。
 *     **同源**，所以 service worker 也能顺带管一管；而且用户换域名/换路径
 *     部署时不用改代码。
 *
 *   APK（Capacitor 把 phone/ 整个打包进壳里）：页面在 https://localhost/ 根，
 *     '../tiles/' 会变成 https://localhost/tiles/ —— **根本不存在**。
 *     所以 APK 必须用**绝对地址** https://hxyt66.github.io/navpuck/tiles/。
 *     跨域没问题：GitHub Pages 对静态资源回 `Access-Control-Allow-Origin: *`
 *     （本机实测过响应头）。
 *
 * ⚠️ 这里的做法和 map.js 处理 Overpass 镜像时是**同一个思路**：
 *    静态猜测永远会有一段时间是错的，所以**记住哪个能用**（_load_preferred /
 *    _remember_preferred，存在 localStorage 的 navpuck.tiles_base.v1）。
 *    猜错时的代价只有一次 404，之后就一直是对的那个。
 *
 * ===========================================================================
 * 为什么用 IndexedDB 而不是 localStorage
 * ===========================================================================
 * 这个工程的"记忆"从前都在 localStorage 里（镜像 sticky、路网缓存）。
 * 瓦片**必须**换地方，两条硬理由：
 *   1. **装不下**。localStorage 配额约 5MB，而且按 UTF-16 算（1 字符 2 字节）。
 *      二进制要先 base64（+33%）再乘 2 —— 一张 4MB 的城市瓦片集会占掉
 *      10MB 以上的配额。全国主路网更是差着两个数量级。
 *   2. **二进制不该经过字符串**。IndexedDB 直接存 ArrayBuffer，没有编解码，
 *      也不会有"字符串里有非法字符"这类问题。
 * localStorage 只留两个**几十字节**的东西：哪个 base 好用、以及 index 的时间戳。
 * 这和 map.js 里"sticky 镜像单独一个键"的做法是一致的 —— 诊断时
 * "清空瓦片"不该顺手把"哪个地址好用"也忘掉。
 *
 * ===========================================================================
 * 失败绝不拖累导航（沿用 map.js 的三条铁律）
 * ===========================================================================
 *   1. 任何存储/网络异常都在这一层消化掉，返回 null/空，**不抛**。
 *      症状顶多是"底图退回 Overpass"，绝不能是"导航起不来"。
 *   2. 所有网络操作都在**后台**跑，有并发上限、有每块冷却，
 *      而且**永远不 await 在导航循环里**（调用方 fire-and-forget）。
 *   3. 状态要说得清楚：覆盖有没有、在下几块、哪一块失败了、为什么。
 *      界面直接照抄（map.js 的 status()），不再有含糊的"等待路网"。
 */

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./navmath.js'), require('./route.js'));
  } else {
    root.NavPuckTiles = factory(root.NavPuckMath, root.NavPuckRoute);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (nm, rt) {

  // ---- 格式常量（和 tools/make_tiles.py 一一对应）--------------------------
  const MAGIC = [0x4E, 0x50, 0x54, 0x31];        // "NPT1"
  const FORMAT_VERSION = 1;
  const HEADER_BYTES = 20;
  const DM = 0.1;                                 // 一个存储单位 = 0.1 米
  const MAX_SEG_PTS = 255;                        // 生成端切过片，这里只做校验

  const TILE_ZOOM = 14;
  const MERCATOR_CIRCUMFERENCE_M = 40075016.6855785;
  const EARTH_M_PER_DEG_LAT = 110540.0;
  const EARTH_M_PER_DEG_LON_EQ = 111320.0;

  // ---- NPK1 容器（把 16×16 个 z14 块装进一个文件）------------------------
  //
  // 为什么要有容器：散块布局下**一个瓦片一个文件**。实测全国按 way 数外推
  // 约 101 万块 —— GitHub 单仓库建议 5 万文件以内，超 20 倍。打包把文件数
  // 降两个数量级，而 `.npt` 的字节**一个都没改**（原样嵌进容器），
  // 所以解码走的还是同一个 decode_tile，容器不可能引入坐标偏差。
  //
  // 格式（小端）：
  //   0   char[4]  "NPK1"
  //   4   u8       version = 1
  //   5   u8       pack_z
  //   6   u16      count
  //   8   u16      flags
  //   10  u16      x（本包的 pack 坐标，自证用）
  //   12  u16      y
  //   14  u8[count]  dx
  //   14+c u8[count] dy
  //   14+2c u32[count] off
  //   14+2c+4c u32[count] len
  //   然后是顺序拼接的 .npt 原样字节
  const NPK_MAGIC = [0x4E, 0x50, 0x4B, 0x31];
  const NPK_VERSION = 1;
  const NPK_HEAD = 14;
  // 默认打包层级：z10。实测（辽宁+浙江+沈阳+杭州，32,171 块）——
  //   z11（8×8=64）：1,228 个文件，平均只装 26 块，全国外推 ≈ 3.8 万文件
  //                  （紧贴 GitHub 的 5 万建议上限，只剩 23% 余量）
  //   z10（16×16=256）：359 个文件，平均装 90 块，全国外推 ≈ 1.1 万文件 ✅
  // 稀疏地区根本填不满一个格子，所以"每个格子都装满"的外推是错的。
  const PACK_LEVEL_DEFAULT = 10;

  // Pages 上的绝对地址。换仓库名/换账号时**只改这一行**。
  const PAGES_BASE = 'https://hxyt66.github.io/navpuck/tiles/';
  // 相对地址：只有在页面确实位于 .../phone/ 里时才有意义（PWA 的情况）。
  const REL_BASE = '../tiles/';

  // ---- 存储键 ------------------------------------------------------------
  // 小字符串（几十字节）放 localStorage；二进制瓦片放 IndexedDB。见文件头。
  const BASE_KEY = 'navpuck.tiles_base.v1';
  const INDEX_T_KEY = 'navpuck.tiles_index_t.v1';
  const IDB_NAME = 'navpuck-tiles';
  const IDB_VERSION = 1;
  const STORE_TILES = 'tiles';
  const STORE_META = 'meta';

  // ---- 预算 --------------------------------------------------------------
  // 一次瓦片请求的超时。瓦片是几十 KB 的静态文件，20 秒已经很宽松了
  // （对比：Overpass 查询单个镜像给 45 秒，那是实测 17.6 秒逼出来的）。
  const TILE_TIMEOUT_MS = 20000;
  // 同时最多几个瓦片请求。压着来：这是给别人（GitHub）的礼貌，
  // 而且手机上并行太多反而每个都慢。
  const TILE_MAX_INFLIGHT = 3;
  // 一块失败之后隔这么久才再试（秒）。没这条的话，
  // "贴图溢出屏幕时"每一帧都会重试同一块，等于自己打自己。
  const TILE_RETRY_COOLDOWN_S = 60;
  // 一次 refresh 最多排几块。骑行中每 0.5 秒就会调一次 refresh，
  // 所以"细水长流"比"一次排 200 块"好 —— 队列里的东西会跟着骑手走。
  const TILE_PLAN_MAX_PER_CALL = 24;
  // 默认往前预取多远（米）。8km ≈ 30km/h 下 16 分钟，够把"下一个转弯之前"
  // 的底图全部准备好，又不会为一条 200km 的路线一次下几百块。
  const TILE_PREFETCH_AHEAD_M = 8000;
  // 内存里保留多少块**已解码**的瓦片。9 块就够盖住一次抓取（3×3），
  // 留 36 块是为了"刚预取过的路还在手上"，再多就是白占内存。
  const TILE_MEM_KEEP = 36;
  // 索引（index.json）多久算过期（秒）。它只列"哪些瓦片存在"，
  // 一整天重看一次足够了；发新版瓦片后最多一天就能看到。
  const INDEX_MAX_AGE_S = 86400;

  // ---- slippy 瓦片算术（和 make_tiles.py 逐行对应）-----------------------

  /** 经纬度 -> 瓦片 {x, y}。和 slippy 标准定义一致。 */
  function tile_of(lat, lon, z) {
    const zz = (z === undefined) ? TILE_ZOOM : z;
    const n = Math.pow(2, zz);
    let x = Math.floor((lon + 180.0) / 360.0 * n);
    const la = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const la_r = la * Math.PI / 180.0;
    let y = Math.floor((1.0 - Math.asinh(Math.tan(la_r)) / Math.PI) / 2.0 * n);
    // 正好落在东/南边界时 floor 可能给出 n（越界）—— 夹回来
    x = Math.min(Math.max(x, 0), n - 1);
    y = Math.min(Math.max(y, 0), n - 1);
    return { x: x, y: y };
  }

  /** 瓦片边界 -> {south, west, north, east}。 */
  function tile_bounds(z, x, y) {
    const n = Math.pow(2, z);
    const lon_of = (i) => i / n * 360.0 - 180.0;
    const lat_of = (j) => {
      const t = Math.PI * (1.0 - 2.0 * j / n);
      return Math.atan(Math.sinh(t)) * 180.0 / Math.PI;
    };
    return { south: lat_of(y + 1), west: lon_of(x), north: lat_of(y), east: lon_of(x + 1) };
  }

  /** 瓦片中心 -> [lat, lon]。 */
  function tile_center(z, x, y) {
    const b = tile_bounds(z, x, y);
    return [(b.south + b.north) / 2.0, (b.west + b.east) / 2.0];
  }

  /** 瓦片在该纬度的实地边长（米）。 */
  function tile_span_m(z, lat) {
    return MERCATOR_CIRCUMFERENCE_M * Math.cos(lat * Math.PI / 180.0) / Math.pow(2, z);
  }

  /** 瓦片 id（也是 IndexedDB 的键、也是 URL 路径）。 */
  function tile_id(z, x, y) {
    return `${z}/${x}/${y}`;
  }

  /**
   * 解析 NPK1 容器。返回 {pack_z, x, y, count, tiles: Map<slot, {off, len}>}。
   *
   * slot = dx * 256 + dy（dx/dy 是块相对本包原点的偏移，0..15）。
   * 用数字当键而不是字符串：一个包 256 块，查表在热路径上（每次 _refresh）。
   *
   * ⚠️ 所有越界都**抛**。坏包被当成"这些块不存在"的话，症状是"某一带的
   *    路网莫名其妙少一片"，而且完全没有线索 —— 和 decode_tile 同一个理由。
   */
  function parse_pack(buf) {
    const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    if (u8.length < NPK_HEAD) throw new Error(`NPK1 太短：${u8.length} 字节`);
    for (let i = 0; i < 4; i += 1) {
      if (u8[i] !== NPK_MAGIC[i]) throw new Error('NPK1 magic 不对（不是包文件？）');
    }
    if (u8[4] !== NPK_VERSION) throw new Error(`NPK1 版本不支持：${u8[4]}`);
    const pack_z = u8[5];
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = dv.getUint16(6, true);
    const px = dv.getUint16(10, true);
    const py = dv.getUint16(12, true);
    const need = NPK_HEAD + count * 10;
    if (u8.length < need) {
      throw new Error(`NPK1 被截断：${u8.length} 字节，目录需要 ${need}`);
    }
    const tiles = new Map();
    const dx_off = NPK_HEAD;
    const dy_off = NPK_HEAD + count;
    const o_off = NPK_HEAD + count * 2;
    const l_off = NPK_HEAD + count * 6;
    for (let i = 0; i < count; i += 1) {
      const dx = u8[dx_off + i];
      const dy = u8[dy_off + i];
      const off = dv.getUint32(o_off + i * 4, true);
      const len = dv.getUint32(l_off + i * 4, true);
      if (len < HEADER_BYTES) throw new Error(`NPK1 第 ${i} 块长度非法：${len}`);
      if (off + len > u8.length) {
        throw new Error(`NPK1 第 ${i} 块越界：off=${off} len=${len} 文件 ${u8.length}`);
      }
      if (u8[off] !== MAGIC[0] || u8[off + 1] !== MAGIC[1] ||
          u8[off + 2] !== MAGIC[2] || u8[off + 3] !== MAGIC[3]) {
        throw new Error(`NPK1 第 ${i} 块不是 .npt（偏移 ${off} 处 magic 不对）`);
      }
      const slot = dx * 256 + dy;
      if (tiles.has(slot)) throw new Error(`NPK1 目录里有重复的块：dx=${dx} dy=${dy}`);
      tiles.set(slot, { off: off, len: len });
    }
    return { pack_z: pack_z, x: px, y: py, count: count, tiles: tiles, buf: u8 };
  }

  /** 从解好的包里切出某一块的 .npt 字节；包里没有就返回 null。 */
  function slice_pack(pk, id) {
    const p = String(id).split('/');
    const x = Number(p[1]);
    const y = Number(p[2]);
    const d = pk.pack_z;
    const base_x = (x >> (TILE_ZOOM - d)) << (TILE_ZOOM - d);
    const base_y = (y >> (TILE_ZOOM - d)) << (TILE_ZOOM - d);
    const dx = x - base_x;
    const dy = y - base_y;
    const rec = pk.tiles.get(dx * 256 + dy);
    if (!rec) return null;
    return pk.buf.subarray(rec.off, rec.off + rec.len);
  }

  function _byte_len(b) {
    return (b && (b.byteLength || b.length)) || 0;
  }

  /** 解码一块 .npt。返回 {z, x, y, lat_c, lon_c, segs:[[rank,[[lat,lon],...]]]}。
   *
   * ⚠️ 任何异常都**抛**（这里是纯函数，调用方负责吞）—— 和网络/存储那两条
   *    "绝不抛"的路径不同：一块损坏的瓦片是**我们自己产出的东西坏了**，
   *    静默当成"这里没有路"会让这种 bug 永远查不出来。
   *    调用方（TileStore._download）会把坏块当作失败，不写进缓存。
   */
  function decode_tile(buf) {
    const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    if (u8.length < HEADER_BYTES) throw new Error(`.npt 太短：${u8.length} 字节`);
    if (u8[0] !== MAGIC[0] || u8[1] !== MAGIC[1] ||
        u8[2] !== MAGIC[2] || u8[3] !== MAGIC[3]) {
      throw new Error('.npt magic 不对（不是瓦片文件？）');
    }
    if (u8[4] !== FORMAT_VERSION) {
      throw new Error(`.npt 版本不支持：${u8[4]}（本端认 ${FORMAT_VERSION}）`);
    }
    const z = u8[5];
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const lon_c = dv.getInt32(8, true) / 1e7;
    const lat_c = dv.getInt32(12, true) / 1e7;
    const seg_count = dv.getUint16(16, true);
    const pt_count = dv.getUint16(18, true);
    const need = HEADER_BYTES + seg_count * 2 + pt_count * 4;
    if (u8.length < need) {
      throw new Error(`.npt 长度不够：有 ${u8.length}，按头部需要 ${need}`);
    }
    const ranks = u8.subarray(HEADER_BYTES, HEADER_BYTES + seg_count);
    const counts = u8.subarray(HEADER_BYTES + seg_count, HEADER_BYTES + seg_count * 2);
    const pts_off = HEADER_BYTES + seg_count * 2;

    const k_lon = EARTH_M_PER_DEG_LON_EQ * Math.cos(lat_c * Math.PI / 180.0);
    const segs = [];
    let p = 0;
    let total = 0;
    for (let s = 0; s < seg_count; s += 1) {
      const c = counts[s];
      if (c < 2 || c > MAX_SEG_PTS) throw new Error(`.npt 段长非法：${c}`);
      total += c;
      const geom = new Array(c);
      for (let i = 0; i < c; i += 1) {
        const dx = dv.getInt16(pts_off + (p + i) * 4, true) * DM;      // 米
        const dy = dv.getInt16(pts_off + (p + i) * 4 + 2, true) * DM;  // 米
        // 分米 -> 米 -> 经纬度。和生成端的 _to_local_m 是严格逆运算
        // （同一个 EARTH_M_PER_DEG_* 和同一个 cos(lat_c)），
        // 所以这里除了量化误差（≤0.05 m）不会引入任何额外偏差。
        geom[i] = [lat_c + dy / EARTH_M_PER_DEG_LAT, lon_c + dx / k_lon];
      }
      segs.push([ranks[s], geom]);
      p += c;
    }
    if (total !== pt_count) {
      throw new Error(`.npt 点数对不上：段里 ${total}，头部写 ${pt_count}`);
    }
    return { z: z, lat_c: lat_c, lon_c: lon_c, segs: segs,
             seg_count: seg_count, pt_count: pt_count };
  }

  // ---- URL 基地址 --------------------------------------------------------

  /** 把相对地址按页面 URL 解析成绝对地址；解析不了就原样返回。 */
  function _absolutise(u, href) {
    try {
      if (typeof URL !== 'undefined' && href) return new URL(u, href).href;
    } catch (_e) { /* 忽略 */ }
    return u;
  }

  /**
   * 这一端该按什么顺序试哪些瓦片根地址。见文件头那一大段。
   *
   * @param {object} loc location（浏览器里是 window.location；测试可以注入）
   * @returns {string[]} 去重后的候选地址（可能为空 = 这一端没有瓦片能力）
   */
  function candidate_bases(loc) {
    const out = [];
    // ⚠️ **没有 location = 不是浏览器环境**（Node 自测就是这种）。
    //    这时候必须返回空数组，也就是"这一端没有瓦片能力"——
    //    否则自测会拿着绝对地址去真的联网打 GitHub Pages。
    //    一整条"离线优先"的新路径在自测里因此完全不生效，
    //    老的那些断言（Overpass 状态机）才一个都不受影响。
    if (!loc) return out;
    const l = loc || {};
    const href = (typeof l.href === 'string' && l.href) ? l.href : '';
    const path = (typeof l.pathname === 'string') ? l.pathname : '';
    // ① 页面真的在 phone/ 里 -> 先试相对路径（PWA）。
    //    这个正则刻意写得很窄：'../tiles/' 只有在 /phone/ 这一层才对，
    //    别的地方用它会解析到一个莫名其妙的上级目录。
    if (/\/phone\/(index\.html)?$/.test(path)) out.push(_absolutise(REL_BASE, href));
    // ② 绝对地址（APK / 任何别的托管方式）。永远放在候选里 ——
    //    它不依赖页面在哪，是最后一定对的那一个。
    out.push(PAGES_BASE);
    const seen = new Set();
    return out.filter((u) => {
      if (!u || seen.has(u)) return false;
      seen.add(u);
      return true;
    });
  }

  // ---- 存储：IndexedDB（二进制）------------------------------------------

  /**
   * 极小的 IndexedDB 包装。
   *
   * 设计原则只有一条：**任何一步失败都退化成"没有缓存"**，绝不抛到调用方。
   * 隐私模式、配额满、浏览器不支持 —— 全都只是"这次要联网"，不是错误。
   */
  class TileDb {
    constructor(opts) {
      const o = opts || {};
      this.name = o.name || IDB_NAME;
      this.version = o.version || IDB_VERSION;
      this._factory = (o.indexedDB !== undefined) ? o.indexedDB : _default_idb();
      this._db = null;
      this._opening = null;
      this.ok = false;              // 打开成功过没有（界面/自测读它）
      this.last_error = '';
      this.puts = 0;
      this.gets = 0;
    }

    _open() {
      if (this._db) return Promise.resolve(this._db);
      if (this._opening) return this._opening;
      const f = this._factory;
      if (!f || typeof f.open !== 'function') {
        this.last_error = '这个环境没有 IndexedDB';
        return Promise.resolve(null);
      }
      this._opening = new Promise((resolve) => {
        let req;
        try {
          req = f.open(this.name, this.version);
        } catch (e) {
          this.last_error = `IndexedDB 打不开：${e}`;
          resolve(null);
          return;
        }
        req.onupgradeneeded = () => {
          try {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_TILES)) db.createObjectStore(STORE_TILES);
            if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
          } catch (_e) { /* 建表失败 -> 后面 get/put 会失败 -> 退化成没缓存 */ }
        };
        req.onsuccess = () => {
          this._db = req.result;
          this.ok = true;
          this.last_error = '';
          resolve(this._db);
        };
        req.onerror = () => {
          this.last_error = `IndexedDB 打开失败：${req.error && req.error.message}`;
          resolve(null);
        };
        req.onblocked = () => {
          this.last_error = 'IndexedDB 被另一个标签页挡住（旧版本还开着？）';
          resolve(null);
        };
      });
      return this._opening;
    }

    /** 一次事务。resolve 的值见各调用点；出错一律 resolve(null)。 */
    _tx(store, mode, fn) {
      return this._open().then((db) => {
        if (!db) return null;
        return new Promise((resolve) => {
          let out = null;
          try {
            const t = db.transaction(store, mode);
            const os = t.objectStore(store);
            const r = fn(os);
            if (r) r.onsuccess = () => { out = r.result; };
            t.oncomplete = () => resolve(out === undefined ? null : out);
            t.onerror = () => {
              this.last_error = `IndexedDB ${mode} 失败：${t.error && t.error.message}`;
              resolve(null);
            };
            t.onabort = () => {
              this.last_error = `IndexedDB ${mode} 被中止：${t.error && t.error.message}`;
              resolve(null);
            };
          } catch (e) {
            this.last_error = `IndexedDB ${mode} 抛异常：${e}`;
            resolve(null);
          }
        });
      });
    }

    /** 取一块瓦片（ArrayBuffer）。没有/出错都返回 null。 */
    get(key) {
      this.gets += 1;
      return this._tx(STORE_TILES, 'readonly', (os) => os.get(key));
    }

    put(key, value) {
      this.puts += 1;
      return this._tx(STORE_TILES, 'readwrite', (os) => os.put(value, key));
    }

    del(key) {
      return this._tx(STORE_TILES, 'readwrite', (os) => os.delete(key));
    }

    clear() {
      return this._tx(STORE_TILES, 'readwrite', (os) => os.clear());
    }

    /** 所有已缓存的瓦片 id（界面显示"本地已有 N 块"用）。 */
    keys() {
      return this._tx(STORE_TILES, 'readonly', (os) => os.getAllKeys());
    }

    meta_get(key) {
      return this._tx(STORE_META, 'readonly', (os) => os.get(key));
    }

    meta_put(key, value) {
      return this._tx(STORE_META, 'readwrite', (os) => os.put(value, key));
    }
  }

  function _default_idb() {
    try {
      if (typeof indexedDB !== 'undefined' && indexedDB) return indexedDB;
    } catch (_e) { /* 隐私模式 / 被策略禁用 */ }
    return null;
  }

  function _default_storage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (_e) { /* 同上 */ }
    return null;
  }

  function _default_location() {
    try {
      if (typeof location !== 'undefined' && location) return location;
    } catch (_e) { /* 忽略 */ }
    return null;
  }

  // ---- TileStore ---------------------------------------------------------

  class TileStore {
    /**
     * @param {object} opts
     *   fetch       注入的 fetch（默认全局 fetch）
     *   storage     注入的 localStorage 形状 {getItem,setItem,removeItem}
     *   indexedDB   注入的 IndexedDB 工厂（自测用；null = 明确不要持久化）
     *   location    注入的 location（自测用）；不给就取全局
     *   bases       直接指定候选根地址（给了就不再从 location 推）
     *   zoom        瓦片级（默认 14）
     *   now_ms/now  注入时钟
     *   max_inflight / plan_max  并发与单次计划上限（自测会调小）
     *   timeout_ms  单块超时
     *   on_change   有瓦片可用性变化时的回调（map.js 用它触发重画）
     */
    constructor(opts) {
      const o = opts || {};
      this.zoom = o.zoom === undefined ? TILE_ZOOM : o.zoom;
      this._fetch = o.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      this._storage = o.storage === undefined ? _default_storage() : o.storage;
      // ⚠️ null 是**有效值**（"明确不要持久化"），所以不能写成 `|| new TileDb()`：
      //    自测里要的正是"没有 IndexedDB 时也能跑"这条路径。
      this.db = (o.indexedDB === null) ? null
        : new TileDb({ indexedDB: o.indexedDB === undefined ? undefined : o.indexedDB });
      this._now_ms = o.now_ms || (() => Date.now());
      this._now = o.now || (() => Date.now() / 1000);
      this.max_inflight = o.max_inflight === undefined ? TILE_MAX_INFLIGHT : o.max_inflight;
      this.plan_max = o.plan_max === undefined ? TILE_PLAN_MAX_PER_CALL : o.plan_max;
      this.timeout_ms = o.timeout_ms === undefined ? TILE_TIMEOUT_MS : o.timeout_ms;
      this.prefetch_ahead_m = o.prefetch_ahead_m === undefined
        ? TILE_PREFETCH_AHEAD_M : o.prefetch_ahead_m;
      this.on_change = o.on_change || null;

      const loc = (o.location !== undefined) ? o.location : _default_location();
      this.bases = (o.bases !== undefined) ? o.bases.slice() : candidate_bases(loc);
      // 记着上次成功的那个（sticky）。⚠️ 必须**校验它在当前候选里**，
      // 和 map.js 的 _load_preferred 是同一个理由：存坏了/列表改了，
      // 都只是退回静态顺序，不会变成"每轮先试一个不存在的地址"。
      this._preferred = '';
      try {
        const raw = this._storage ? this._storage.getItem(BASE_KEY) : null;
        if (typeof raw === 'string' && this.bases.indexOf(raw) >= 0) this._preferred = raw;
      } catch (_e) { /* 忽略 */ }

      // ---- 运行时状态 ----
      this.mem = new Map();            // tile_id -> 解码结果（有上限，见 _mem_put）
      // ⭐ 容器层：散块部署时"容器 = 这块瓦片自己"，打包部署时"容器 = 它所在的 .npk"。
      //    **只有一条代码路径** —— 下载、缓存、去重、冷却全都按容器 id 记账，
      //    两种部署的差别只剩"取哪个 URL"和"要不要从目录里切一刀"。
      //    （两套平行的下载/缓存路径 = 两倍的 bug 面，不值得。）
      this.pack_z = 0;                 // 0 = 散块部署；>0 = 打包部署（读 index.json 的 pack）
      this._packmem = new Map();       // 容器 id -> {buf, pk}
      this.packs_done = 0;             // 这次运行下了几个包
      this.pack_bytes = 0;
      this.packs_failed = 0;
      // 覆盖索引（**分列**）：x -> {t, ys}。坐标是**容器**的坐标
      // （散块 = z14，打包 = z10）。ys 为 Set = 有这些 y，null = 这一列确定没有，
      // 整条记录不存在 = 还没取过（不知道）。
      this._cols = new Map();
      this.present_count = 0;          // 已加载的列里一共有多少块（只用于显示）
      this.root = null;                // index.json 的头部（范围 + 计数）
      this.root_t = 0;
      this.root_state = 'idle';        // idle | loading | ok | failed | none
      this.absent = new Set();         // 这一轮确认过"上游没有"的**容器**
      this._queue = [];                // 待下载的容器 id
      this._queued = new Set();
      this._inflight = 0;
      this._fail_at = new Map();       // 容器 id -> 上次失败时刻（秒）
      this.done = 0;                   // 散块模式下 = 下了几块；打包模式看 packs_done
      this.bytes = 0;
      this.failed = 0;
      this.last_error = '';
      this.base = this.bases.length ? (this._preferred || this.bases[0]) : '';
      this.gap_reason = '';            // "没有瓦片覆盖"时的一句话原因（界面用）
    }

    // -- 容器（散块 / 打包 两种部署的唯一差别）-----------------------------

    /** 这块瓦片住在哪个容器里。散块部署时就是它自己。 */
    container_id(id) {
      if (!this.pack_z) return id;
      const p = String(id).split('/');
      const d = this.zoom - this.pack_z;
      return `${this.pack_z}/${Number(p[1]) >> d}/${Number(p[2]) >> d}`;
    }

    /** 容器的 (x, y) —— 覆盖索引和 index.json 的 xr/yr 都用这套坐标。 */
    _container_xy(id) {
      const c = this.container_id(id);
      const p = c.split('/');
      return [Number(p[1]), Number(p[2])];
    }

    _pack_put(pid, rec) {
      this._packmem.set(pid, rec);
      // 最多留 4 个包（一个包最大近 1 MB，不能让它们无限涨）
      while (this._packmem.size > 4) {
        const oldest = this._packmem.keys().next().value;
        this._packmem.delete(oldest);
      }
    }

    /** 这一端有没有瓦片能力（没有 = 完全退回 Overpass，行为和以前一样）。 */
    ready() {
      return this.bases.length > 0 && !!this._fetch;
    }

    // -- base（sticky）-----------------------------------------------------

    _base_order() {
      if (this.bases.length <= 1) return this.bases.slice();
      const pref = this._preferred;
      if (!pref || this.bases.indexOf(pref) < 0) return this.bases.slice();
      return [pref].concat(this.bases.filter((b) => b !== pref));
    }

    _remember_base(b) {
      this.base = b;
      this._preferred = b;
      try {
        if (this._storage) this._storage.setItem(BASE_KEY, b);
      } catch (_e) { /* 配额/隐私模式：这一轮照样用，只是下次不记得 */ }
    }

    _forget_base() {
      this._preferred = '';
      try {
        if (this._storage) this._storage.removeItem(BASE_KEY);
      } catch (_e) { /* 忽略 */ }
    }

    _url(tile_path, base) {
      return (base || this.base || this.bases[0] || '') + tile_path;
    }

    // -- 内存缓存 ----------------------------------------------------------

    _mem_get(id) {
      const v = this.mem.get(id);
      if (v === undefined) return null;
      // 重新插一次 = LRU 的"最近用过"
      this.mem.delete(id);
      this.mem.set(id, v);
      return v;
    }

    _mem_put(id, val) {
      this.mem.set(id, val);
      while (this.mem.size > TILE_MEM_KEEP) {
        const oldest = this.mem.keys().next().value;
        this.mem.delete(oldest);
      }
    }

    // -- 覆盖索引 ----------------------------------------------------------

    // -- 覆盖索引（**分列**的，这一版改过）---------------------------------
    //
    // ⚠️ 索引**不是**一个大文件 —— 这是实测逼出来的：
    //    辽宁 17,512 块，把"所有存在的瓦片"列成一个字符串数组要 **333 KB**，
    //    而整个辽宁的路网数据才 2.44 MB：元数据占了 13%。按全国 75 万块外推
    //    是十几 MB，客户端每次开导航都要先下完它才知道地图在哪 ——
    //    那等于把"底图不可靠"这件事又做回去了，而它正是要修的问题。
    //
    // 现在分两层（生成端 tools/make_tiles.write_index_and_manifest 一起改的）：
    //
    //     index.json               191 字节（辽宁实测）：只有范围 + 计数，
    //                              **没有逐块列表**
    //     index/<z>/<x>.json       一列一个文件：这一列里有哪些 y
    //                              辽宁最大 567 字节
    //
    // 客户端一次只下它当前那 1~3 列 ⇒ 首次元数据下载 ≈ 1.9 KB，
    // 而且**这个数字和城市/全国的规模无关**（这是分列的全部意义）。

    /**
     * 取头部索引。拿不到也不致命：root = null 时"覆盖未知"，
     * 调用方会照样去试着下瓦片（顶多多几个 404）。
     */
    /**
     * 采用一份头部索引。**root / root_t / root_state / pack_z 必须一起设。**
     *
     * ⚠️ 这里踩过一个只有真机才暴露的坑：从 IndexedDB 缓存恢复 root 时只设了
     *    root，漏了 pack_z，于是 pack_z 停在 0（= 散块部署）。它**不报错**，
     *    而是静默地永远加载不出底图：
     *
     *      pack_z = 0
     *        -> _container_xy() 按 z14 算容器坐标
     *        -> root_covers() 拿 z14 的 x（如 13809）去比**打包索引**的范围
     *           （xr=[720,895]，那是 z10 的）
     *        -> 每一块都判成"超出发布范围"
     *        -> 每一块都塞进 this.absent
     *        -> 永远不下载，地图永远空白，而且**重启 App 也不自愈**
     *           （缓存新鲜期内每次都走那条分支）
     *
     *    症状和"瓦片根本没发布"一模一样，极难分辨。真机上是靠
     *    `absent=20 / pack_z=0` 这两个内部量才定位到的。
     *
     *    自测抓不到它：Node 里没有 IndexedDB（this.db 为 null），缓存分支
     *    整个被跳过，pack_z 每次都从新取的索引里正确赋值。
     *    —— 又是一次"假依赖比真依赖宽松"。
     */
    _adopt_root(j, t) {
      this.root = j;
      this.root_t = t;
      this.root_state = 'ok';
      // 部署形态由**索引**说了算，不是客户端猜的：有 `pack` 字段就是打包部署。
      // 这样一来同一次发布里不可能出现"客户端以为散块、服务端是包"的错配。
      this.pack_z = (j && typeof j.pack === 'number' && j.pack > 0 &&
                     j.pack < this.zoom) ? j.pack : 0;
    }

    async load_root(force) {
      if (!this.ready()) { this.root_state = 'none'; return null; }
      if (this.root && !force && (this._now() - this.root_t) < INDEX_MAX_AGE_S) {
        return this.root;
      }
      if (this.root_state === 'loading') return this.root;
      if (!force && this.db) {
        const rec = await this.db.meta_get('root');
        if (rec && rec.j && typeof rec.t === 'number') {
          // ⭐ 必须走 _adopt_root，不能只赋 this.root —— 那样会漏掉 pack_z
          this._adopt_root(rec.j, rec.t);
          if ((this._now() - rec.t) < INDEX_MAX_AGE_S) return this.root;
        }
      }
      this.root_state = 'loading';
      const r = await this._get_text('index.json');
      if (r.ok) {
        try {
          const j = JSON.parse(r.text);
          if (!j || typeof j !== 'object') throw new Error('不是对象');
          // 网格对不上就当作不可用：拿 z13 的索引去解释 z14 的路径，
          // 只会得到"处处没覆盖"这种看起来完全正常的错误结论。
          if (j.z !== undefined && j.z !== this.zoom) {
            throw new Error(`索引是 z${j.z}，本端是 z${this.zoom}`);
          }
          // ⭐ 走 _adopt_root：root 与 pack_z 必须一起设（见上面的长注释）
          this._adopt_root(j, this._now());
          if (this.db) this.db.meta_put('root', { t: this.root_t, j: j });
          return this.root;
        } catch (e) {
          this.last_error = `index.json 解析失败：${e}`;
          this.root_state = this.root ? 'ok' : 'failed';
          return this.root;
        }
      }
      this.root_state = this.root ? 'ok' : 'failed';
      if (!r.missing) this.last_error = `index.json 取不到：${r.reason}`;
      return this.root;
    }

    /**
     * 覆盖索引用的是哪一级的坐标。
     *
     * ⚠️ 打包部署时是 **pack_z**（z10），散块部署时是 zoom（z14）——
     *    列文件的路径、IndexedDB 的键、头部 xr/yr，**全都**必须是这一级。
     *    这里写错过一次（用了 this.zoom），症状是"列文件永远 404 →
     *    客户端认定这一带没有覆盖 → 退回 Overpass"，而且在线上的表现
     *    和"瓦片没发布"一模一样，极难分辨。
     */
    index_level() {
      return this.pack_z || this.zoom;
    }

    /**
     * 取**一列**的 y 列表。
     *
     * 返回值有三种，**必须分清**（这一版的核心之一）：
     *   Set    这一列有这些 y
     *   null   这一列**确定没有**（列文件 404 —— 服务端明确答复了）
     *   undefined **不知道**（网络挂了/超时/解析失败）
     * null 和 undefined 混起来，界面就会把"这一带没覆盖"和"网不好"说成同一句话，
     * 而那正是用户最烦的"让我猜"。
     */
    async _load_column(x, force) {
      const lvl = this.index_level();
      const hit = this._cols.get(x);
      if (hit && !force && (this._now() - hit.t) < INDEX_MAX_AGE_S) return hit.ys;
      if (!force && this.db) {
        const rec = await this.db.meta_get(`col:${lvl}:` + x);
        if (rec && typeof rec.t === 'number' && Array.isArray(rec.y)) {
          const ys = new Set(rec.y);
          this._set_col(x, ys, rec.t);
          if ((this._now() - rec.t) < INDEX_MAX_AGE_S) return ys;
        }
      }
      const r = await this._get_text(`index/${lvl}/${x}.json`);
      if (r.ok) {
        try {
          const j = JSON.parse(r.text);
          const ys = new Set(Array.isArray(j && j.y) ? j.y : []);
          this._set_col(x, ys, this._now());
          if (this.db) {
            this.db.meta_put(`col:${lvl}:` + x, { t: this._now(), y: Array.from(ys) });
          }
          return ys;
        } catch (e) {
          this.last_error = `列索引 ${x} 解析失败：${e}`;
          return undefined;
        }
      }
      if (r.missing) {
        this._set_col(x, null, this._now());   // 确定没有（404 也是"答复"）
        return null;
      }
      this.last_error = `列索引 ${x} 取不到：${r.reason}`;
      return undefined;
    }

    _set_col(x, ys, t) {
      const old = this._cols.get(x);
      if (old && old.ys) this.present_count -= old.ys.size;
      this._cols.set(x, { t: t, ys: ys });
      if (ys) this.present_count += ys.size;
    }

    /** 需要哪几列（去重、排序）。 */
    async ensure_columns(xs, force) {
      const uniq = Array.from(new Set(xs)).sort((a, b) => a - b);
      for (const x of uniq) await this._load_column(x, force);
      return uniq.length;
    }

    /** 一块瓦片在不在上游（按**容器**粒度问；散块时容器就是它自己）。 */
    is_present(id) {
      const xy = this._container_xy(id);
      const c = this._cols.get(xy[0]);
      if (c === undefined) return undefined;
      if (c.ys === null) return false;
      return c.ys.has(xy[1]);
    }

    /** 头部里的范围能不能直接判"这一带根本没覆盖"。返回 true/false/undefined。 */
    root_covers(xs, ys) {
      const r = this.root;
      if (!r || !Array.isArray(r.xr) || !Array.isArray(r.yr)) return undefined;
      for (const x of xs) if (x < r.xr[0] || x > r.xr[1]) return false;
      for (const y of ys) if (y < r.yr[0] || y > r.yr[1]) return false;
      return true;
    }

    /** 取一个**文本**资源（index.json / 列文件），换 base 重试。 */
    async _get_text(rel) {
      const order = this._base_order();
      let last_reason = '没有可用的瓦片地址';
      let saw_missing = false;
      for (const b of order) {
        const r = await this._fetch_one(this._url(rel, b), 'text');
        if (r.ok) {
          if (b !== this.base) this._remember_base(b);
          return { ok: true, text: r.text };
        }
        if (r.status === 404) {
          // 这个 base 上连索引都没有 -> 这个 base 是错的（或者这一列真的没有）。
          // 两个 base 都 404 才算"确定没有"，所以这里只记一笔、继续试下一个。
          saw_missing = true;
          if (b === this._preferred) this._forget_base();
          last_reason = 'HTTP 404';
          continue;
        }
        last_reason = r.reason;
      }
      // ⚠️ 只有**每一个**候选地址都明确回了 404，才算"确定没有"。
      //    只要有一个是网络错误，"没有"和"不知道"就不能混。
      if (saw_missing && order.length > 0) {
        return { ok: false, missing: true, status: 404, reason: last_reason };
      }
      return { ok: false, missing: false, reason: last_reason };
    }

    /**
     * 一次 HTTP GET，带超时。**永远 resolve**，不抛。
     * @returns {Promise<{ok, status, buf?, text?, reason?, ms}>}
     */
    _fetch_one(url, kind) {
      const t0 = this._now_ms();
      const secs = Math.max(1, Math.floor(this.timeout_ms / 1000));
      let timer = null;
      let ac = null;
      const work = (async () => {
        if (!this._fetch) throw new Error('这个环境没有 fetch()');
        if (typeof AbortController !== 'undefined') ac = new AbortController();
        const resp = await this._fetch(url, {
          method: 'GET',
          cache: 'default',
          signal: ac ? ac.signal : undefined,
        });
        if (!resp.ok) {
          const e = new Error(`HTTP ${resp.status}`);
          e.http_status = resp.status;
          throw e;
        }
        return kind === 'text' ? await resp.text() : await resp.arrayBuffer();
      })();
      const timeout = new Promise((_res, rej) => {
        timer = setTimeout(() => {
          if (ac) { try { ac.abort(); } catch (_e) { /* 忽略 */ } }
          rej(new Error('请求超时'));
        }, this.timeout_ms);
      });
      work.catch(() => {});     // 免得 race 收下失败之后变成 unhandled rejection
      return Promise.race([work, timeout]).then(
        (v) => {
          if (timer) clearTimeout(timer);
          return { ok: true, status: 200, ms: this._now_ms() - t0,
                   buf: kind === 'text' ? undefined : v,
                   text: kind === 'text' ? v : undefined };
        },
        (e) => {
          if (timer) clearTimeout(timer);
          const status = (e && e.http_status) ? e.http_status : 0;
          const timed = /请求超时/.test(String(e && e.message)) || (e && e.name === 'AbortError');
          return {
            ok: false, status: status, ms: this._now_ms() - t0,
            reason: timed ? `请求超时（${secs} 秒）` : String(e && e.message ? e.message : e),
          };
        });
    }

    // -- 需要哪些瓦片 ------------------------------------------------------

    /**
     * 圆心 + 半径 -> 需要哪些瓦片（外接正方形覆盖到的全部）。
     *
     * 用**外接正方形**而不是圆：瓦片是方的，按圆算仍然要下满这些块，
     * 而且还多一层"点到底在不在圆里"的判断 —— 没有任何好处。
     *
     * @returns {string[]} tile_id 数组
     */
    tiles_for_area(lat, lon, radius_m, margin_tiles) {
      const z = this.zoom;
      const lat_r = lat * Math.PI / 180.0;
      const dlat = radius_m / EARTH_M_PER_DEG_LAT;
      const dlon = radius_m / Math.max(1.0, EARTH_M_PER_DEG_LON_EQ * Math.cos(lat_r));
      const a = tile_of(lat - dlat, lon - dlon, z);
      const b = tile_of(lat + dlat, lon + dlon, z);
      const m = margin_tiles === undefined ? 0 : margin_tiles;
      const out = [];
      for (let x = Math.min(a.x, b.x) - m; x <= Math.max(a.x, b.x) + m; x += 1) {
        for (let y = Math.min(a.y, b.y) - m; y <= Math.max(a.y, b.y) + m; y += 1) {
          out.push(tile_id(z, x, y));
        }
      }
      return out;
    }

    // -- 读取 --------------------------------------------------------------

    /** 从内存或 IndexedDB 拿一块并解码。返回 null = 本地没有（或坏了）。 */
    async _local(id) {
      const hit = this._mem_get(id);
      if (hit) return hit;
      let bytes = null;
      if (this.pack_z) {
        const pid = this.container_id(id);
        let rec = this._packmem.get(pid);
        if (!rec && this.db) {
          const buf = await this.db.get('pack:' + pid);
          if (buf) {
            try {
              rec = { buf: buf, pk: parse_pack(buf) };
              this._pack_put(pid, rec);
            } catch (e) {
              // 本地这份包坏了：删掉，下次重新下。
              // ⚠️ 绝不能当成"这里没有路" —— 那会让一整片 29km×29km 的底图消失
              //    而界面上什么线索都没有。
              this.last_error = `本地包 ${pid} 损坏，已丢弃：${e}`;
              this.db.del('pack:' + pid);
              return null;
            }
          }
        }
        if (!rec) return null;
        bytes = slice_pack(rec.pk, id);
        if (bytes === null) return null;    // 包里确实没有这一块（发布时就没收）
      } else {
        if (!this.db) return null;
        bytes = await this.db.get(id);
        if (!bytes) return null;
      }
      try {
        const dec = decode_tile(bytes);
        dec.id = id;
        this._mem_put(id, dec);
        return dec;
      } catch (e) {
        // 本地这份坏了：删掉，下次重新下。**不要**把它当成"这里没有路"。
        this.last_error = `本地瓦片 ${id} 损坏，已丢弃：${e}`;
        if (!this.pack_z && this.db) this.db.del(id);
        return null;
      }
    }

    /**
     * 只管本地（内存 + IndexedDB）：把这块区域现在**手上就有**的路网拼出来。
     *
     * 这个方法**不联网**，所以界面能"先画上有的，再慢慢补"。
     * 返回 {ways, have, need}；ways 是 [[rank,[[lat,lon],...]],...]，
     * 和 map.js 里 Overpass 那份数据**完全同一个形状**（这是刻意的：
     * build() 一个字都不用改）。
     */
    async local_area(lat, lon, radius_m, margin_tiles) {
      const need = this.tiles_for_area(lat, lon, radius_m, margin_tiles);
      const have = [];
      const ways = [];
      const seen = new Set();
      for (const id of need) {
        const t = await this._local(id);
        if (!t) continue;
        have.push(id);
        for (const seg of t.segs) {
          // ⭐ 去重：相邻瓦片之间**故意**有 --margin-m（默认 150 m）的重叠，
          //    所以边界附近同一条路会出现在两块里。重复画出来的线像素级相同，
          //    视觉上无害，但会白占 build() 那 330 点的预算。
          //    键用"等级 + 点数 + 首尾点"（坐标量化到 1e-5 度 ≈ 1.1 m，
          //    比瓦片的 0.1 m 量化粗，足以让同一段路在两块里算出同一个键）。
          const k = _seg_key(seg);
          if (seen.has(k)) continue;
          seen.add(k);
          ways.push(seg);
        }
      }
      ways.sort((a, b) => a[0] - b[0]);      // 点预算不够时先丢次要道路
      return { ways: ways, have: have, need: need };
    }

    /**
     * 这块区域的覆盖情况。**这是界面上"到底有没有底图"的唯一判据。**
     *
     *   'have'    要的块本地都有了 —— 完全离线可用
     *   'partial' 有一部分
     *   'none'    一块都没有，而且上游**确认**这一带的每一块都没有
     *             （= 真的没覆盖，可以理直气壮落到 Overpass）
     *   'unknown' 一块都没有，但**说不准**（索引没取到 / 网络问题）
     *
     * ⚠️ 'none' 和 'unknown' 的差别是这一版最要紧的一条：
     *    前者说明"这一带永远不会有瓦片"，后者只是"现在不知道"。
     *    界面上的话、以及要不要去打扰 Overpass，全看它。
     */
    coverage_of(need, have) {
      if (have.length >= need.length) return 'have';
      if (have.length > 0) return 'partial';
      let known = 0;
      let present = 0;
      for (const id of need) {
        const p = this.is_present(id);
        if (p === undefined) continue;      // 不知道就别猜
        known += 1;
        if (p) present += 1;
      }
      if (present > 0) return 'partial';
      if (known === need.length && need.length > 0) return 'none';
      return 'unknown';
    }

    // -- 下载队列 ----------------------------------------------------------

    /**
     * 排几块要下载的瓦片。**立即返回**，真正的下载在后台按并发上限慢慢跑。
     *
     * ⚠️ 队列里存的是**容器 id**：打包部署时 9 块 z14 很可能属于同一个 z10 包，
     *    按瓦片排队会把这些块当成 9 次独立下载（虽然下面有去重兜着），
     *    而且 plan_max 那个闸门也会被同一个包吃掉 —— 换成按容器排队，
     *    "一次最多排几块"才真的等于"最多几个请求"。
     *
     * @param {string[]} ids
     * @param {string} why  'area' | 'route'（只用于诊断）
     * @returns {number} 这次真的排进去几个容器
     */
    enqueue(ids, why) {
      if (!this.ready()) return 0;
      const now = this._now();
      let n = 0;
      for (const id of ids) {
        if (n >= this.plan_max) break;
        const cid = this.container_id(id);
        if (this._queued.has(cid)) continue;
        if (this.absent.has(cid)) continue;              // 上游确认没有
        if (this.is_present(id) === false) {
          this.absent.add(cid);                          // 索引说没有 -> 不用试
          continue;
        }
        const f = this._fail_at.get(cid);
        if (f !== undefined && (now - f) < TILE_RETRY_COOLDOWN_S) continue;
        // 本地已经有了就不用下（散块看这块自己，打包看那个包在不在）
        if (this.pack_z ? this._packmem.has(cid) : this.mem.has(id)) continue;
        this._queue.push(cid);
        this._queued.add(cid);
        n += 1;
      }
      if (n > 0) this._pump(why);
      return n;
    }

    _pump(why) {
      while (this._inflight < this.max_inflight && this._queue.length > 0) {
        const cid = this._queue.shift();
        this._inflight += 1;
        this._download(cid, why)
          .catch(() => { /* _download 内部已经全部收好了 */ })
          .then(() => {
            this._inflight -= 1;
            if (this._queue.length > 0) this._pump(why);
            else if (this._inflight === 0) this._notify();
          });
      }
    }

    _notify() {
      if (this.on_change) {
        try { this.on_change(this); } catch (_e) { /* 回调不能反过来把我们搞崩 */ }
      }
    }

    /**
     * 下载一个**容器**。**永远不抛**：所有失败都记进状态。
     *
     * 散块部署：容器就是一块瓦片，下来直接解码。
     * 打包部署：容器是一个 .npk，下来整个存进 IndexedDB（**整包缓存**），
     *          具体的块在 _local() 里按目录切 —— 一次请求换 256 块的覆盖。
     *          ⚠️ 不做"按需只取包里的一块"（HTTP Range）：那要多一次往返、
     *             还要假设服务端支持 Range，而整包一次下完是**确定性**的，
     *             并且落盘之后整片 29km×29km 全离线。
     */
    async _download(cid, why) {
      const packed = !!this.pack_z;
      const order = this._base_order();
      let last = '没有可用的瓦片地址';
      for (const b of order) {
        const r = await this._fetch_one(
          this._url(cid + (packed ? '.npk' : '.npt'), b), 'binary');
        if (r.ok) {
          if (packed) {
            let pk = null;
            try {
              pk = parse_pack(r.buf);
            } catch (e) {
              // 下回来的东西不是包（GitHub Pages 的 404 页面？截断？）
              // —— 记下来并**继续**试下一个地址，绝不把坏数据写进缓存
              last = `包内容坏了：${e}`;
              this.packs_failed += 1;
              this.last_error = last;
              continue;
            }
            this._pack_put(cid, { buf: r.buf, pk: pk });
            if (this.db) this.db.put('pack:' + cid, r.buf);
            this.packs_done += 1;
            this.pack_bytes += _byte_len(r.buf);
          } else {
            let dec = null;
            try {
              dec = decode_tile(r.buf);
            } catch (e) {
              last = `瓦片内容坏了：${e}`;
              this.failed += 1;
              this.last_error = last;
              continue;
            }
            dec.id = cid;
            this._mem_put(cid, dec);
            if (this.db) this.db.put(cid, r.buf);
            this.done += 1;
            this.bytes += _byte_len(r.buf);
          }
          this._fail_at.delete(cid);
          if (b !== this.base) this._remember_base(b);
          this.last_error = '';
          if (this._queue.length === 0 && this._inflight <= 1) this._notify();
          return true;
        }
        if (r.status === 404) {
          // 上游确实没有这个容器 -> 记成"不存在"，这一轮不再试它。
          // ⚠️ 和"下载失败"**必须分开**：一个说明"这里没覆盖"（要落到 Overpass
          //    兜底 + 界面说清楚），一个说明"网络/服务有问题"（要重试）。
          this.absent.add(cid);
          return false;
        }
        last = r.reason;
        if (b === this._preferred) this._forget_base();
      }
      this.failed += 1;
      this.last_error = packed ? `包 ${cid} 下载失败：${last}`
                               : `瓦片 ${cid} 下载失败：${last}`;
      this._fail_at.set(cid, this._now());
      return false;
    }

    // -- 对外的两件事：这一带的路网、以及沿航线预取 ------------------------

    /**
     * 这一带（圆心 + 半径）的路网。**这是 map.js 唯一要调的方法。**
     *
     * 返回：
     *   { ways, have, need, coverage, downloading }
     *   coverage: have | partial | none | unknown   （见 coverage_of）
     *   downloading: 这次新排了几块（>0 说明"正在下载"）
     *
     * ⚠️ 它**不会等下载完**。已经有的先给出来；缺的在后台补，
     *    补好之后通过 on_change 通知上层重画。骑行中一秒钟都等不起。
     */
    async load_area(lat, lon, radius_m) {
      if (!this.ready()) {
        return { ways: [], have: [], need: [], coverage: 'none', downloading: 0,
                 reason: '这一端没有配置瓦片地址' };
      }
      await this.load_root(false);
      const r = await this.local_area(lat, lon, radius_m, 0);
      const missing = r.need.filter((id) => r.have.indexOf(id) < 0);

      // ⭐ 先用头部里的范围把"**确定在发布范围之外**"的块摘出去：
      //    它们既不用取列文件、也不用去下（省掉的是纯粹的 404 往返）。
      //    ⚠️ 坐标是**容器**坐标（打包部署时 z10，散块时 z14），
      //       和 index/<pz>/<x>.json 那一列是同一套。
      //    ⚠️ 只是"摘出去"，**不能**因此就下结论说"整片没覆盖" ——
      //    范围内那几块仍然要照常查、照常下。
      const in_range = [];
      const out_range = [];
      if (this.root) {
        for (const id of missing) {
          const xy = this._container_xy(id);
          if (this.root_covers([xy[0]], [xy[1]]) === false) out_range.push(id);
          else in_range.push(id);
        }
      } else {
        for (const id of missing) in_range.push(id);
      }
      for (const id of out_range) this.absent.add(this.container_id(id));

      let col_state = 'ok';
      if (in_range.length) {
        // ⭐ 只取**需要的列**（不是整个索引）。这就是分列的全部意义：
        //    一次启动的元数据下载量是几百字节，和城市/全国规模无关。
        await this.ensure_columns(
          in_range.map((id) => this._container_xy(id)[0]), false);
        for (const id of in_range) {
          if (this.is_present(id) === undefined) { col_state = 'unknown'; break; }
        }
      }

      const downloading = this.enqueue(in_range, 'area');

      // ⭐ 覆盖判断：把"索引说有" / "索引说没有" / "不知道" **分开数**。
      //
      //   idx_yes  索引说上游**有**这几块 —— 那这一带就是"有覆盖"，
      //            哪怕一块都没下下来（那是下载失败，不是没覆盖）。
      //            ⚠️ 这条以前写错过：索引说有、但块 404 时会被判成"没覆盖"，
      //            于是界面会告诉用户"这一带没有离线瓦片"，
      //            而索引明明说它有 —— 自相矛盾的结论比不说还糟。
      //   idx_no   发布范围之外，或者索引明确说没有
      //   其它     列文件没取到（网络问题）—— 不知道，不许猜
      let idx_yes = 0;
      let idx_no = 0;
      let idx_unknown = 0;
      for (const id of missing) {
        if (out_range.indexOf(id) >= 0) { idx_no += 1; continue; }
        const p = this.is_present(id);
        if (p === true) idx_yes += 1;
        else if (p === false) idx_no += 1;
        else idx_unknown += 1;
      }

      let coverage;
      if (r.have.length >= r.need.length) coverage = 'have';
      else if (r.have.length > 0 || idx_yes > 0) coverage = 'partial';
      else if (missing.length > 0 && idx_no === missing.length) coverage = 'none';
      else coverage = 'unknown';

      let reason = '';
      if (coverage === 'none' || coverage === 'partial') {
        if (coverage === 'none') {
          reason = '上游没有这一带的瓦片（预生成的瓦片只包含主路和次干道）';
        } else if (idx_yes > 0 && r.have.length === 0) {
          reason = `上游有瓦片但一块都没下下来（${idx_unknown} 块状态未知）`;
        } else if (this.root_state === 'failed') {
          reason = '覆盖索引取不到（不知道上游有没有瓦片）';
        } else {
          reason = '瓦片正在下载';
        }
      }
      return { ways: r.ways, have: r.have, need: r.need,
               coverage: coverage, downloading: downloading, reason: reason };
    }

    /**
     * 沿航线往前预取 —— **"骑到哪都有底图"这件事就是靠它**。
     *
     * @param {Array} pts       航线折线 [[lat,lon],...]（或 [lat,lon,name]）
     * @param {number} lat/lon  骑手当前位置（用来决定从航线的哪一段开始）
     * @param {number} ahead_m  往前预取多远（米；默认 8km）
     * @returns {number} 这次排了几块
     *
     * 做法：从"离骑手最近的那一段"开始往前走，边走边收集沿途的瓦片，
     * 走满 ahead_m 就停。**不是**把整条路线一次排完 —— 骑手可能改道，
     * 而且一条 200km 的路线会排几百块，白下。
     *
     * ⚠️ 每块瓦片向外多取一圈（margin_tiles=1）：骑手实际画的是
     *    "自己周围 view×1.6"，路线两侧各多一块能保证转弯时不会刚好缺一块。
     */
    prefetch_route(pts, lat, lon, ahead_m) {
      if (!this.ready() || !pts || pts.length < 2) return 0;
      const ids = this.route_tiles(pts, lat, lon, ahead_m);
      return this.enqueue(ids, 'route');
    }

    /** 纯计算：沿航线前方要哪些瓦片（自测直接钉这个函数）。 */
    route_tiles(pts, lat, lon, ahead_m) {
      const want = (ahead_m === undefined) ? this.prefetch_ahead_m : ahead_m;
      const z = this.zoom;
      const out = [];
      const seen = new Set();
      const push_around = (la, lo) => {
        const t = tile_of(la, lo, z);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            const id = tile_id(z, t.x + dx, t.y + dy);
            if (!seen.has(id)) { seen.add(id); out.push(id); }
          }
        }
      };

      // ① 找到航线里离骑手最近的那一点。只在**已经定位过的附近**扫，
      //    避免 200km 的航线每次都从头遍历（一般是几十个点的事）。
      let best = 0;
      let best_d = Infinity;
      const n = pts.length;
      const step = Math.max(1, Math.floor(n / 400));   // 粗扫，避免长航线 O(n)
      for (let i = 0; i < n; i += step) {
        const d = nm.distance_m(lat, lon, pts[i][0], pts[i][1]);
        if (d < best_d) { best_d = d; best = i; }
      }
      // 粗扫之后在附近细扫一遍，免得落在两个采样点中间
      const lo_i = Math.max(0, best - step);
      const hi_i = Math.min(n - 1, best + step);
      for (let i = lo_i; i <= hi_i; i += 1) {
        const d = nm.distance_m(lat, lon, pts[i][0], pts[i][1]);
        if (d < best_d) { best_d = d; best = i; }
      }

      // ② 从那里往前走 ahead_m
      push_around(pts[best][0], pts[best][1]);
      let acc = 0.0;
      for (let i = best; i < n - 1 && acc < want; i += 1) {
        acc += nm.distance_m(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        push_around(pts[i + 1][0], pts[i + 1][1]);
      }
      return out;
    }

    // -- 诊断 --------------------------------------------------------------

    stats() {
      const s = {
        enabled: this.ready(),
        base: this.base,
        bases: this.bases.slice(),
        preferred: this._preferred,
        // 部署形态：0 = 散块（一块一个文件），>0 = 打包（一个 .npk 装 16×16 块）
        pack_z: this.pack_z,
        packs_mem: this._packmem.size,
        packs_done: this.packs_done,
        pack_bytes: this.pack_bytes,
        packs_failed: this.packs_failed,
        // 索引分两层：头部（几十~几百字节）+ 已经加载的列
        index_state: this.root_state,
        index_cols: this._cols.size,
        index_tiles: this.present_count,
        index_age_s: this.root_t ? Math.max(0, this._now() - this.root_t) : null,
        root_xr: this.root ? this.root.xr : null,
        root_yr: this.root ? this.root.yr : null,
        mem_tiles: this.mem.size,
        pending: this._queue.length,
        inflight: this._inflight,
        done: this.done,
        failed: this.failed,
        bytes: this.bytes,
        absent: this.absent.size,
        db_ok: !!(this.db && this.db.ok),
        db_error: this.db ? this.db.last_error : '',
        last_error: this.last_error,
        zoom: this.zoom,
        span_m: Math.round(tile_span_m(this.zoom, 40.0)),
      };
      // 打包部署时"一次刷新下了几个包、多少字节"是界面和验证脚本都要看的数字
      s.span_pack_m = this.pack_z
        ? Math.round(tile_span_m(this.pack_z, 40.0)) : 0;
      return s;
    }

    /** 清空本地瓦片（界面上"清空底图缓存"会调）。**不动 sticky base。** */
    async clear() {
      this.mem.clear();
      this._packmem.clear();
      this._queue = [];
      this._queued.clear();
      this.absent.clear();
      this._fail_at.clear();
      this._cols.clear();
      this.present_count = 0;
      this.root = null;
      this.root_t = 0;
      this.root_state = 'idle';
      this.pack_z = 0;
      this.packs_done = 0;
      this.pack_bytes = 0;
      this.packs_failed = 0;
      if (this.db) await this.db.clear();
      this.done = 0;
      this.bytes = 0;
      this.failed = 0;
    }

    /** 本地已经有多少块（要遍历 IndexedDB，界面偶尔调一次就行）。 */
    async cached_count() {
      if (!this.db) return this.mem.size;
      const ks = await this.db.keys();
      return ks ? ks.length : this.mem.size;
    }

    /** 一块瓦片是不是"上游确认没有"。界面用它区分"没覆盖"和"下载失败"。 */
    is_absent(id) { return this.absent.has(id); }
  }

  /**
   * 一条线段的去重键（跨瓦片用）。
   *
   * 量化到 1e-5 度 ≈ 1.1 m：瓦片自己的量化是 0.1 m，所以同一条路在两块里
   * 算出来的经纬度最多差 0.14 m —— 除非正好压在一个 1e-5 的格边上，
   * 否则键一定相同。压格边的后果只是"漏掉一次去重"，画出来一模一样。
   */
  function _seg_key(seg) {
    const g = seg[1];
    const a = g[0];
    const b = g[g.length - 1];
    const q = (v) => Math.round(v * 1e5);
    return `${seg[0]}|${g.length}|${q(a[0])},${q(a[1])}|${q(b[0])},${q(b[1])}`;
  }

  return {
    TileStore, TileDb, decode_tile,
    tile_of, tile_bounds, tile_center, tile_span_m, tile_id,
    candidate_bases, _seg_key,
    // NPK1 容器（打包部署）：自测要直接解析包来对拍，所以导出
    parse_pack, slice_pack,
    // 常量：自测和界面文案都要读，所以导出
    TILE_ZOOM, PAGES_BASE, REL_BASE, BASE_KEY, INDEX_T_KEY,
    TILE_TIMEOUT_MS, TILE_MAX_INFLIGHT, TILE_RETRY_COOLDOWN_S,
    TILE_PLAN_MAX_PER_CALL, TILE_PREFETCH_AHEAD_M, TILE_MEM_KEEP,
    INDEX_MAX_AGE_S, IDB_NAME, STORE_TILES, STORE_META,
    FORMAT_VERSION, MAGIC, HEADER_BYTES, DM,
    NPK_MAGIC, NPK_VERSION, NPK_HEAD, PACK_LEVEL_DEFAULT,
    EARTH_M_PER_DEG_LAT, EARTH_M_PER_DEG_LON_EQ, MERCATOR_CIRCUMFERENCE_M,
  };
}));
