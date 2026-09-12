/*
 * NavPuck 线协议 —— tools/navpuck_proto.py 的 JavaScript 忠实移植。
 *
 * ⚠️ 这个文件的每一个字节都必须和 navpuck_proto.py / nav_proto.cpp 一致。
 *    手机页面是"导航大脑"，它写出去的字节直接进设备的 FrameParser。
 *    移植后的正确性由 phone/test/selftest.mjs 用 test/navcore_vectors.json
 *    里的黄金向量逐字节钉死 —— 改这个文件之后**必须**重跑那个自测。
 *
 * 线格式（小端）：
 *     +0  magic0   0xA5
 *     +1  magic1   0x5A
 *     +2  version  u8
 *     +3  type     u8
 *     +4  len      u16      payload 字节数
 *     +6  payload  [len]
 *     +6+len crc16 u16      CRC-16/CCITT-FALSE，覆盖 [2, 6+len)
 *
 * 移植约定：
 *   - 常量名、函数名、字段名与 Python 版逐字对应，方便 diff。
 *   - Python 的 struct "<..." 用 _dv/_uv/_i16/_u16/_u32 手工读写代替；
 *     全部走 Math.trunc 而不是位运算 |0 —— JS 的位运算会把数截成 32 位有符号，
 *     写 dist_dest_m = 98765 这种还看不出来，写到 > 2^31 就静默出错。
 */

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./navmath.js'));
  } else {
    root.NavPuckProto = factory(root.NavPuckMath);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (nm) {

  const MAGIC0 = 0xA5;
  const MAGIC1 = 0x5A;
  const VERSION = 1;
  const HEADER_LEN = 6;
  const CRC_LEN = 2;
  const OVERHEAD = HEADER_LEN + CRC_LEN;
  const MAX_PAYLOAD = 1536;

  const NAV_UPDATE_LEN = 32;
  const NAV_META_LEN = 9;
  const PUCK_STATUS_LEN = 4;

  // ---- NAV_CLOCK：对端把"现在几点"推给设备 ----
  //
  // 载荷**恰好 6 字节**：
  //     +0  epoch_s        u32   Unix 秒，**UTC**
  //     +4  tz_offset_min  i16   本地时区相对 UTC 的**分钟**数（UTC+8 = 480）
  //
  // 本地时间 = epoch_s + tz_offset_min * 60。
  //
  // 为什么时间要从手机推：设备是 ESP32-S3，**没有电池 RTC**，断电就不知道
  // 几点了；也不能开 WiFi 走 NTP —— 它跑 BLE 跟手机连，WiFi 和 BLE 抢同一个
  // 射频，同时开会把 BLE 连接质量拖垮，还得让用户填 WiFi 凭据。
  // 所以时间只能走**已经建好的这条链路**推过去。
  //
  // 为什么偏移是**分钟**而不是小时：印度 +5:30、尼泊尔 +5:45 这些"半点时区"
  // 是真实存在的，用小时只能表达整点时区，那些地方会整整差半天 ——
  // 而且差的是**日期**，比差几十分钟难发现得多。
  const NAV_CLOCK_LEN = 6;

  // ---- NAV_ROUTE：**前方窗口**的一个分片 ----
  //
  // 头 6 字节：total_points(u16) chunk_start(u16) n_pts(u8) flags(u8)，
  // 后面 n_pts 个 <i16 east_m, i16 north_m>，单位**米**，
  // 原点 = **发送端选定的原点**（现在是发这一窗时骑手的位置；滑动窗口，
  // 见 route.js 的 WINDOW_M / REANCHOR_MOVE_M）。
  // total_points == 0 的空片 = "把接收端上那条旧窗口清掉"（重锚前必发）。
  const NAV_ROUTE_HEADER_LEN = 6;
  const MAX_ROUTE_POINTS = 1024;          // 一遍（一窗）的点数上限（设备端为它留了 4KB）
  // 单片点数上限。载荷给的是 382，但 n_pts 是 u8 -> 255 才是真正生效的那条。
  const MAX_ROUTE_CHUNK_POINTS_BY_PAYLOAD = (MAX_PAYLOAD - NAV_ROUTE_HEADER_LEN) / 4;  // 382
  const MAX_ROUTE_CHUNK_POINTS = 255;
  const ROUTE_MAX_RANGE_M = 32767;        // i16 米能表达的半径：±32.7 km（**窗口**的上界，不是路线长度的）
  const ROUTE_CHUNK_LAST = 0x01;          // 分片头 flags bit0：最后一片
  const NO_TURN = 0xFFFF;                 // NavUpdate.next_turn_index 的"没有动作点"哨兵
  const NO_TURN_INDEX = NO_TURN;          // 同义名

  // ---- NAV_MAP：头里删掉了 view_range_dm ----
  //
  // 字段表是 u8 seg_count + u8 flags + u16 total_pts = **4** 字节。
  // total_pts 因此从旧的 +4 挪到 +2（见 Python 版里那段注释与 docs/protocol.md）。
  const NAV_MAP_HEADER_LEN = 4;
  const MAX_MAP_SEGMENTS = 64;
  const MAX_MAP_TOTAL_POINTS = 400;

  /**
   * ⚠️ 一个测量出来的坑（与 Python 版**完全一致**，不是移植偏差）：
   *
   * MAX_MAP_TOTAL_POINTS = 400 是**接收端数组**的容量，但它比 MAX_PAYLOAD 允许的
   * 还大。NAV_MAP 的 payload = 4 + seg_count + 4 × total_pts，所以：
   *
   *     400 点 + 64 段 = 4 + 64 + 1600 = 1668 > 1536  -> encode_frame() 直接抛错
   *
   * 也就是说"合法但装不进一帧"的组合是存在的，症状是**底图整帧发不出去、抛异常**。
   * 真正可发送的上限是：
   *
   *     4 + seg_count + 4 × total_pts <= 1536
   *
   * 所以手机端不靠这两个常量兜底，而是按*当前手机*的 OSRM/Overpass 抓取上限
   * （MAP_MAX_POINTS = 330 / MAP_MAX_SEGMENTS = 60）在**生成端**就压住 ——
   * 330 + 60 时 payload = 1384，留了余量。这个函数用来在运行时复核，
   * 免得以后调大抓取上限时又踩回来。
   */
  function nav_map_payload_len(seg_count, total_pts) {
    return NAV_MAP_HEADER_LEN + seg_count + total_pts * 4;
  }

  /** 某个 (seg_count, total_pts) 组合能不能装进一帧 NAV_MAP。 */
  function nav_map_fits(seg_count, total_pts) {
    return seg_count <= MAX_MAP_SEGMENTS &&
           total_pts <= MAX_MAP_TOTAL_POINTS &&
           nav_map_payload_len(seg_count, total_pts) <= MAX_PAYLOAD;
  }

  /** 给定段数时，NAV_MAP 一帧最多能装多少个点（受 MAX_PAYLOAD 约束）。 */
  function nav_map_max_points_for_segs(seg_count) {
    const byPayload = Math.floor((MAX_PAYLOAD - NAV_MAP_HEADER_LEN - seg_count) / 4);
    return Math.max(0, Math.min(MAX_MAP_TOTAL_POINTS, byPayload));
  }

  // -------------------------------------------------------------------------
  // 枚举（Python IntEnum 的对应物：普通对象 + 反向名字表）
  // -------------------------------------------------------------------------
  const MsgType = {
    NAV_UPDATE: 0x01,
    NAV_TEXT: 0x02,
    NAV_META: 0x03,
    NAV_ROUTE: 0x04,
    NAV_MAP: 0x05,
    // 0x06 是 0x01..0x05 之外唯一空着的小号类型：设备->大脑是 0x10/0x11，
    // 控制帧是 0x20/0x21。取它就不必动任何已有类型的编号（wire 是冻结的）。
    NAV_CLOCK: 0x06,
    PUCK_STATUS: 0x10,
    PUCK_EVENT: 0x11,
    PING: 0x20,
    PONG: 0x21,
  };

  const TextKind = {
    ROAD_NAME: 0,
    INSTRUCTION: 1,
    DEST_NAME: 2,
  };

  const Turn = {
    NONE: 0,
    STRAIGHT: 1,
    SLIGHT_LEFT: 2,
    LEFT: 3,
    SHARP_LEFT: 4,
    SLIGHT_RIGHT: 5,
    RIGHT: 6,
    SHARP_RIGHT: 7,
    UTURN_LEFT: 8,
    UTURN_RIGHT: 9,
    ROUNDABOUT: 10,
    MERGE: 11,
    RAMP: 12,
    FERRY: 13,
    ARRIVE: 14,
    OFF_ROUTE: 15,
  };

  // Python 的 Turn(x).name —— 界面上要显示 "Left" / "SlightRight" 这种
  const TURN_NAMES = [
    'None', 'Straight', 'SlightLeft', 'Left', 'SharpLeft', 'SlightRight',
    'Right', 'SharpRight', 'UturnLeft', 'UturnRight', 'Roundabout', 'Merge',
    'Ramp', 'Ferry', 'Arrive', 'OffRoute',
  ];
  const turn_name = (v) => TURN_NAMES[v] || `Turn(${v})`;

  const NavFlags = {
    GPS_FIX: 1 << 0,
    OFF_ROUTE: 1 << 1,
    ARRIVED: 1 << 2,
    LOW_BATTERY: 1 << 3,
    LINK_UP: 1 << 4,
    REROUTING: 1 << 5,
  };

  const PuckEventId = {
    TAP: 0,
    LONG_PRESS: 1,
    SWIPE_LEFT: 2,
    SWIPE_RIGHT: 3,
    SWIPE_UP: 4,
    SWIPE_DOWN: 5,
    SCREEN_WAKE: 6,
  };

  // -------------------------------------------------------------------------
  // CRC-16/CCITT-FALSE
  // -------------------------------------------------------------------------
  function _build_crc_table() {
    const table = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let crc = i << 8;
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xFFFF) : ((crc << 1) & 0xFFFF);
      }
      table[i] = crc;
    }
    return table;
  }

  const _CRC_TABLE = _build_crc_table();

  /** CRC-16/CCITT-FALSE：poly 0x1021, init 0xFFFF, 不反转, 不异或输出。 */
  function crc16(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = ((crc << 8) & 0xFFFF) ^ _CRC_TABLE[((crc >> 8) ^ data[i]) & 0xFF];
    }
    return crc;
  }

  // -------------------------------------------------------------------------
  // 小工具（代替 struct.pack / struct.unpack）
  // -------------------------------------------------------------------------
  function _clamp_u8(v) { return v < 0 ? 0 : (v > 255 ? 255 : Math.trunc(v)); }

  /** _clamp_i(v, lo, hi)：v 不是有限数时按 0 处理（Python 会抛异常，这里不抛）。 */
  function _clamp_i(v, lo, hi) {
    if (!Number.isFinite(v)) v = 0;
    v = Math.trunc(v);
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** struct.pack("<H", v) 语义：先按 u16 取模再写。 */
  function _u16(v) {
    if (!Number.isFinite(v)) v = 0;
    return ((Math.trunc(v) % 65536) + 65536) % 65536;
  }

  /** struct.pack("<h", v) 语义：先按 i16 取模。 */
  function _i16(v) {
    const u = _u16(v);
    return u >= 32768 ? u - 65536 : u;
  }

  /** struct.pack("<I", v) 语义：按 u32 取模。 */
  function _u32(v) {
    if (!Number.isFinite(v)) v = 0;
    return ((Math.trunc(v) % 4294967296) + 4294967296) % 4294967296;
  }

  class ByteWriter {
    constructor() { this._a = []; }
    u8(v) { this._a.push(_clamp_u8(v)); return this; }
    u16(v) { const x = _u16(v); this._a.push(x & 0xFF, (x >> 8) & 0xFF); return this; }
    i16(v) { return this.u16(_i16(v)); }
    u32(v) {
      const x = _u32(v);
      this._a.push(x & 0xFF, Math.floor(x / 256) & 0xFF,
                   Math.floor(x / 65536) & 0xFF, Math.floor(x / 16777216) & 0xFF);
      return this;
    }
    bytes(arr) { for (let i = 0; i < arr.length; i++) this._a.push(arr[i] & 0xFF); return this; }
    toUint8() { return Uint8Array.from(this._a); }
  }

  class ByteReader {
    constructor(u8, off) { this._u = u8; this._o = off || 0; }
    get offset() { return this._o; }
    get remaining() { return this._u.length - this._o; }
    u8() { return this._u[this._o++]; }
    u16() { const v = this._u[this._o] | (this._u[this._o + 1] << 8); this._o += 2; return v; }
    i16() { const v = this.u16(); return v >= 32768 ? v - 65536 : v; }
    u32() {
      const u = this._u;
      const o = this._o; this._o += 4;
      return (u[o] + u[o + 1] * 256 + u[o + 2] * 65536 + u[o + 3] * 16777216);
    }
  }

  function _hex(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
    return s;
  }

  // -------------------------------------------------------------------------
  // 数据结构
  // -------------------------------------------------------------------------
  /**
   * 一帧导航数据。字段顺序 = wire 顺序，**只能追加在最后**。
   *
   * - heading_cdeg：设备端把 NAV_ROUTE / NAV_MAP（正北朝上的局部平面）转到
   *   屏幕上用的车头朝向。
   * - pos_east_m / pos_north_m：车相对**当前路线原点**的位置，米；重锚时一起换。
   * - next_turn_index：下一个动作点在**当前窗口**里的下标；NO_TURN = 没有。
   * - view_range_dm：**唯一**的视距，路线和底图都用它缩放。
   */
  class NavUpdate {
    constructor(fields) {
      const f = fields || {};
      this.rel_bearing_cdeg = f.rel_bearing_cdeg || 0;
      this.abs_bearing_cdeg = f.abs_bearing_cdeg || 0;
      this.dist_next_cm = f.dist_next_cm || 0;
      this.dist_dest_m = f.dist_dest_m || 0;
      this.speed_kmh_x10 = f.speed_kmh_x10 || 0;
      this.eta_min = f.eta_min || 0;
      this.turn = f.turn || 0;
      this.flags = f.flags || 0;
      this.progress_pct = f.progress_pct || 0;
      this.reserved = f.reserved || 0;
      this.heading_cdeg = f.heading_cdeg || 0;
      this.pos_east_m = f.pos_east_m || 0;
      this.pos_north_m = f.pos_north_m || 0;
      this.next_turn_index = (f.next_turn_index === undefined || f.next_turn_index === null)
        ? NO_TURN : f.next_turn_index;
      this.view_range_dm = f.view_range_dm || 0;
      this.reserved2 = f.reserved2 || 0;
    }

    pack() {
      return new ByteWriter()
        .i16(_clamp_i(this.rel_bearing_cdeg, -32768, 32767))
        .u16(_clamp_i(this.abs_bearing_cdeg, 0, 65535))
        .u32(_clamp_i(this.dist_next_cm, 0, 0xFFFFFFFF))
        .u32(_clamp_i(this.dist_dest_m, 0, 0xFFFFFFFF))
        .u16(_clamp_i(this.speed_kmh_x10, 0, 65535))
        .u16(_clamp_i(this.eta_min, 0, 65535))
        .u8(_clamp_i(this.turn, 0, 255))
        .u8(_clamp_i(this.flags, 0, 255))
        .u8(_clamp_i(this.progress_pct, 0, 255))
        .u8(_clamp_i(this.reserved, 0, 255))
        .u16(_clamp_i(this.heading_cdeg, 0, 65535))
        .i16(_clamp_i(this.pos_east_m, -32768, 32767))
        .i16(_clamp_i(this.pos_north_m, -32768, 32767))
        .u16(_clamp_i(this.next_turn_index, 0, 65535))
        .u16(_clamp_i(this.view_range_dm, 0, 65535))
        .u16(_clamp_i(this.reserved2, 0, 65535))
        .toUint8();
    }

    static unpack(payload) {
      if (payload.length !== NAV_UPDATE_LEN) {
        throw new Error(`NAV_UPDATE 长度应为 ${NAV_UPDATE_LEN}，实得 ${payload.length}`);
      }
      const r = new ByteReader(payload, 0);
      return new NavUpdate({
        rel_bearing_cdeg: r.i16(),
        abs_bearing_cdeg: r.u16(),
        dist_next_cm: r.u32(),
        dist_dest_m: r.u32(),
        speed_kmh_x10: r.u16(),
        eta_min: r.u16(),
        turn: r.u8(),
        flags: r.u8(),
        progress_pct: r.u8(),
        reserved: r.u8(),
        heading_cdeg: r.u16(),
        pos_east_m: r.i16(),
        pos_north_m: r.i16(),
        next_turn_index: r.u16(),
        view_range_dm: r.u16(),
        reserved2: r.u16(),
      });
    }

    get bearing_deg() { return this.rel_bearing_cdeg * 0.01; }
    get abs_bearing_deg() { return this.abs_bearing_cdeg * 0.01; }
    /** 车头航向，度（0 = 正北，顺时针）。 */
    get heading_deg() { return this.heading_cdeg * 0.01; }
    get dist_next_m() { return this.dist_next_cm * 0.01; }
    get speed_kmh() { return this.speed_kmh_x10 * 0.1; }
    get view_range_m() { return this.view_range_dm * 0.1; }

    /** next_turn_index 能不能当下标用（0xFFFF 不能）。 */
    has_next_turn() { return this.next_turn_index !== NO_TURN; }
  }

  class NavMeta {
    constructor(fields) {
      const f = fields || {};
      this.total_dist_m = f.total_dist_m || 0;
      this.total_time_s = f.total_time_s || 0;
      this.flags = f.flags || 0;
    }
    pack() {
      return new ByteWriter()
        .u32(_u32(this.total_dist_m))
        .u32(_u32(this.total_time_s))
        .u8(this.flags & 0xFF)
        .toUint8();
    }
    static unpack(payload) {
      if (payload.length !== NAV_META_LEN) throw new Error('NAV_META 长度不对');
      const r = new ByteReader(payload, 0);
      return new NavMeta({ total_dist_m: r.u32(), total_time_s: r.u32(), flags: r.u8() });
    }
  }

  class PuckStatus {
    constructor(fields) {
      const f = fields || {};
      this.vbat_mv = f.vbat_mv || 0;
      this.battery_pct = f.battery_pct || 0;
      this.flags = f.flags || 0;
    }
    pack() {
      return new ByteWriter()
        .i16(_i16(this.vbat_mv))
        .u8(this.battery_pct & 0xFF)
        .u8(this.flags & 0xFF)
        .toUint8();
    }
    static unpack(payload) {
      if (payload.length !== PUCK_STATUS_LEN) throw new Error('PUCK_STATUS 长度不对');
      const r = new ByteReader(payload, 0);
      return new PuckStatus({ vbat_mv: r.i16(), battery_pct: r.u8(), flags: r.u8() });
    }
  }

  /**
   * "现在几点" —— 手机推给设备的一帧。
   *
   * 设备端**不保存这一帧本身**，只保存 (epoch_s, 收到那一刻的 millis())，
   * 之后靠毫秒计数器自己往下走：链路断了完全不影响走时。
   * 所以这一帧是"对表"，不是"流"（连接时一次 + 每 30 秒一次纠正漂移）。
   *
   * ⚠️ 字段一旦发布就不能改（wire 冻结）：插一个字段进去会让后面所有字段
   * 整体平移，而 CRC 两边各算各的都是对的 —— 症状是设备屏幕上显示一个
   * **看起来很正常**的错时间，没有任何东西会报警。
   */
  class NavClock {
    constructor(fields) {
      const f = fields || {};
      this.epoch_s = f.epoch_s || 0;
      this.tz_offset_min = f.tz_offset_min || 0;
    }

    /** 本地时间戳 = UTC + 偏移（秒）。 */
    get local_epoch_s() { return this.epoch_s + this.tz_offset_min * 60; }

    pack() {
      return new ByteWriter()
        .u32(_u32(this.epoch_s))
        .i16(_i16(this.tz_offset_min))
        .toUint8();
    }

    static unpack(payload) {
      // 长度必须**正好** 6 字节：这一帧没有变长部分，长度不对就只能是两端
      // 协议版本不一样。放宽成"至少 6 字节"的话，将来给这一帧追加字段时，
      // 旧固件会把新字段的低位当成 epoch —— 时间看着正常，只是错了几个小时。
      if (payload.length !== NAV_CLOCK_LEN) {
        throw new Error(`NAV_CLOCK 长度应为 ${NAV_CLOCK_LEN}，实得 ${payload.length}`);
      }
      const r = new ByteReader(payload, 0);
      return new NavClock({ epoch_s: r.u32(), tz_offset_min: r.i16() });
    }
  }

  /**
   * **前方窗口的一个分片**（滑动窗口：一窗发一遍）。
   *
   * 坐标系是**正北朝上的局部平面**：x 东为正，y 北为正，单位**米**，
   * 原点是**发送端选定的原点**（现在 = 发这一窗时骑手的位置，既不是当前位置
   * 也不是路线起点）。为什么：见 Python 版 NavRoute 的说明。
   * `total_points == 0` 的空片 = "把接收端上那条旧窗口清掉"，重锚前必发。
   *
   * 注意 last 与 flags 的对应关系与 Python 版完全一致：
   *   - pack() 写的是 flags（0 或 1）
   *   - unpack() 读 flags 后只留 bit0，存进 last（布尔）
   *   所以"pack 出来的 flags" 和 "unpack 出来的 flags" 不是同一个东西，
   *   比较两个 NavRoute 时要按 Python dataclass 的字段名 [total_points,
   *   chunk_start, last, pts] 比 —— selftest 里的 route_eq() 就是这么做的。
   */
  class NavRoute {
    constructor(fields) {
      const f = fields || {};
      this.total_points = f.total_points || 0;
      this.chunk_start = f.chunk_start || 0;
      this.last = !!f.last;
      this.pts = f.pts ? f.pts.map((p) => [p[0], p[1]]) : [];
    }

    /** 本片点数（wire 上的 n_pts）。等于 pts.length。 */
    get count() { return this.pts.length; }

    /** 分片头 flags，目前只有 bit0（ROUTE_CHUNK_LAST）。 */
    get flags() { return this.last ? ROUTE_CHUNK_LAST : 0; }

    is_last_chunk() { return this.last; }

    pack() {
      const n = this.pts.length;
      if (n > MAX_ROUTE_CHUNK_POINTS) {
        // 静默截断会发出一条"看起来完整、其实缺一半"的分片，接收端按
        // n_pts 校验长度后**整片丢弃**，症状是"最后一片永远到不了"。
        throw new Error(
          `单个 NAV_ROUTE 分片最多 ${MAX_ROUTE_CHUNK_POINTS} 个点，实得 ${n}` +
          '（请用 route_chunks() 切分）');
      }
      const w = new ByteWriter()
        .u16(this.total_points & 0xFFFF)
        .u16(this.chunk_start & 0xFFFF)
        .u8(n)
        .u8(this.flags);
      for (let i = 0; i < n; i++) {
        w.i16(_clamp_i(this.pts[i][0], -ROUTE_MAX_RANGE_M, ROUTE_MAX_RANGE_M));
        w.i16(_clamp_i(this.pts[i][1], -ROUTE_MAX_RANGE_M, ROUTE_MAX_RANGE_M));
      }
      return w.toUint8();
    }

    static unpack(payload) {
      if (payload.length < NAV_ROUTE_HEADER_LEN) throw new Error('NAV_ROUTE 太短');
      const r = new ByteReader(payload, 0);
      const total = r.u16();
      const start = r.u16();
      const n = r.u8();
      const flags = r.u8();
      if (n > MAX_ROUTE_CHUNK_POINTS) throw new Error(`NAV_ROUTE 分片点数越界: ${n}`);
      if (total > MAX_ROUTE_POINTS) throw new Error(`NAV_ROUTE 总点数越界: ${total}`);
      if (start + n > total) throw new Error('NAV_ROUTE 分片范围超出总点数');
      if (payload.length !== NAV_ROUTE_HEADER_LEN + n * 4) {
        throw new Error('NAV_ROUTE 长度字段与实际不符');
      }
      const pts = [];
      for (let i = 0; i < n; i++) pts.push([r.i16(), r.i16()]);
      return new NavRoute({ total_points: total, chunk_start: start,
                            last: !!(flags & ROUTE_CHUNK_LAST), pts });
    }
  }

  /**
   * 把**一遍**点集切成 NAV_ROUTE 分片，最后一片 last=true。
   *
   * pts 是相对**发送端选定的那个原点**的 (east_m, north_m)（滑动窗口下就是
   * "发这一窗时骑手的位置"）。超过 MAX_ROUTE_POINTS 会报错 —— 设备端会拒收
   * 这一遍（宁可没有路线，也不要半条错的）。空数组 = 清掉接收端上的旧窗口。
   */
  function route_chunks(pts, max_pts) {
    if (max_pts === undefined || max_pts === null) max_pts = MAX_ROUTE_CHUNK_POINTS;
    if (pts.length > MAX_ROUTE_POINTS) {
      throw new Error(`一遍最多 ${MAX_ROUTE_POINTS} 个点，实得 ${pts.length}`);
    }
    if (max_pts < 1 || max_pts > MAX_ROUTE_CHUNK_POINTS) {
      throw new Error(`max_pts 必须在 1..${MAX_ROUTE_CHUNK_POINTS} 之间`);
    }
    const total = pts.length;
    if (total === 0) {
      // 空路线：一片"最后一片 + 0 个点"，接收端据此把旧窗口清掉
      // （滑动窗口重锚时**必须先发这一片**，否则新旧两窗可能被拼成一条嵌合路）
      return [new NavRoute({ total_points: 0, chunk_start: 0, last: true, pts: [] })];
    }
    const out = [];
    for (let start = 0; start < total; start += max_pts) {
      const chunk = pts.slice(start, start + max_pts);
      out.push(new NavRoute({
        total_points: total,
        chunk_start: start,
        last: (start + chunk.length === total),
        pts: chunk,
      }));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 编码
  // -------------------------------------------------------------------------
  function encode_frame(msg_type, payload) {
    if (payload === undefined || payload === null) payload = new Uint8Array(0);
    if (payload.length > MAX_PAYLOAD) throw new Error('payload 超长');
    // magic0 magic1 version type (4 x u8) + len (u16) = 6 字节，与 C++ 侧一致
    const w = new ByteWriter()
      .u8(MAGIC0).u8(MAGIC1).u8(VERSION).u8(msg_type).u16(payload.length);
    // body = [version, type, len_lo, len_hi, payload...]
    const body = new ByteWriter()
      .u8(VERSION).u8(msg_type).u16(payload.length).bytes(payload).toUint8();
    w.bytes(payload);
    w.u16(crc16(body));
    return w.toUint8();
  }

  function encode_nav_update(u) { return encode_frame(MsgType.NAV_UPDATE, u.pack()); }

  /** 截断到 limit 字节，且不把一个多字节字符劈开。 */
  function _truncate_utf8(raw, limit) {
    if (raw.length <= limit) return raw;
    let n = limit;
    while (n > 0 && (raw[n] & 0xC0) === 0x80) n -= 1;
    return raw.subarray(0, n);
  }

  function encode_nav_text(kind, text) {
    let raw = new TextEncoder().encode(text);
    raw = _truncate_utf8(raw, 255);
    const payload = new ByteWriter().u8(kind).u8(raw.length).bytes(raw).toUint8();
    return encode_frame(MsgType.NAV_TEXT, payload);
  }

  function encode_nav_meta(m) { return encode_frame(MsgType.NAV_META, m.pack()); }
  function encode_nav_route(r) { return encode_frame(MsgType.NAV_ROUTE, r.pack()); }

  /** 一遍点集 -> 一串 NAV_ROUTE 帧（依次发出去；空数组 = 清掉接收端的旧窗口）。 */
  function encode_nav_route_full(pts) {
    return route_chunks(pts).map((c) => encode_nav_route(c));
  }

  /**
   * 周边路网底图。一堆折线（路段），同样是**正北朝上的局部平面**、单位**米**，
   * 原点也是**当前路线原点**（和 NAV_ROUTE 完全一致）。
   * ⚠️ 路线重锚时底图必须**同一轮**按新原点重建（见 app.js 的 cycle()）。
   *
   * 头只有 4 字节，**没有 view_range_dm**：视距的唯一来源是
   * NavUpdate.view_range_dm。
   */
  class NavMap {
    constructor(fields) {
      const f = fields || {};
      this.seg_count = f.seg_count || 0;
      this.flags = f.flags || 0;
      this.total_pts = f.total_pts || 0;
      this.seg_pts = f.seg_pts ? f.seg_pts.slice() : [];
      this.pts = f.pts ? f.pts.map((p) => [p[0], p[1]]) : [];
    }

    pack() {
      let segs = this.seg_pts.slice(0, MAX_MAP_SEGMENTS);
      // 装不下的段整条丢掉，而不是截断 —— 半条路画出来是错的，不如不画
      let total = 0;
      let keep = 0;
      for (const n of segs) {
        if (total + n > MAX_MAP_TOTAL_POINTS) break;
        total += n;
        keep += 1;
      }
      segs = segs.slice(0, keep);
      const pts = this.pts.slice(0, total);

      const w = new ByteWriter().u8(keep).u8(this.flags & 0xFF).u16(total);
      for (const n of segs) w.u8(n);
      for (const [x, y] of pts) {
        w.i16(_clamp_i(x, -ROUTE_MAX_RANGE_M, ROUTE_MAX_RANGE_M));
        w.i16(_clamp_i(y, -ROUTE_MAX_RANGE_M, ROUTE_MAX_RANGE_M));
      }
      return w.toUint8();
    }

    static unpack(payload) {
      if (payload.length < NAV_MAP_HEADER_LEN) throw new Error('NAV_MAP 太短');
      const r = new ByteReader(payload, 0);
      const segs = r.u8();
      const flags = r.u8();
      const total = r.u16();
      if (segs > MAX_MAP_SEGMENTS || total > MAX_MAP_TOTAL_POINTS) {
        throw new Error('NAV_MAP 越界');
      }
      if (payload.length !== NAV_MAP_HEADER_LEN + segs + total * 4) {
        throw new Error('NAV_MAP 长度字段与实际不符');
      }
      const seg_pts = [];
      for (let i = 0; i < segs; i++) seg_pts.push(r.u8());
      let sum = 0;
      for (const n of seg_pts) sum += n;
      if (sum !== total) throw new Error('NAV_MAP 每段点数之和与总点数不符');
      const pts = [];
      for (let i = 0; i < total; i++) pts.push([r.i16(), r.i16()]);
      return new NavMap({ seg_count: segs, flags, total_pts: total, seg_pts, pts });
    }
  }

  function encode_nav_map(m) { return encode_frame(MsgType.NAV_MAP, m.pack()); }
  function encode_puck_status(s) { return encode_frame(MsgType.PUCK_STATUS, s.pack()); }

  /**
   * NAV_CLOCK -> 完整帧（8 字节开销 + 6 字节载荷 = 14 字节）。
   *
   * ⚠️ 这里**不做**范围校验（比如"时区必须在 ±14 小时以内"）：设备端只做加法，
   * 越界的偏移只会让时间偏掉，不会越界读写；而在编码侧悄悄夹断，
   * 对端就再也看不出"发的人算错了"。该管住的是发送端。
   */
  function encode_nav_clock(c) { return encode_frame(MsgType.NAV_CLOCK, c.pack()); }

  /**
   * 取**本机**当前时间 + 本机**真实时区**，装成一帧 NAV_CLOCK。
   *
   * ⚠️ 符号：`new Date().getTimezoneOffset()` 是 "UTC 减本地" 的分钟数，
   *    北京是 **-480**；而协议里要的是"本地相对 UTC 多了多少"，
   *    所以要取负：`-new Date().getTimezoneOffset()` -> +480。
   *    忘了这个负号，设备上的钟会往反方向偏一整个时区
   *    （北京显示成 UTC，差 8 小时），而且看起来完全正常。
   */
  function now_clock(ms) {
    // ms 可注入（自测用）；正常调用不传，取本机当前时间。
    const d = (ms === undefined || ms === null) ? new Date() : new Date(ms);
    return new NavClock({
      // Math.floor 而不是 |0：epoch 秒现在还没到 2^31，但 2038 年之后就超了，
      // 而 JS 的位运算是 32 位有符号 —— 那之后会静默变成负数。
      epoch_s: Math.floor(d.getTime() / 1000),
      tz_offset_min: -d.getTimezoneOffset(),
    });
  }
  function encode_puck_event(ev) {
    return encode_frame(MsgType.PUCK_EVENT, new Uint8Array([ev]));
  }
  function encode_ping() { return encode_frame(MsgType.PING, new Uint8Array(0)); }
  function encode_pong() { return encode_frame(MsgType.PONG, new Uint8Array(0)); }

  // -------------------------------------------------------------------------
  // 流式解码器 —— 严格镜像 C++ / Python 的 FrameParser 状态机
  // -------------------------------------------------------------------------
  class Frame {
    constructor(version, type, payload) {
      this.version = version;
      this.type = type;
      this.payload = payload;
    }
  }

  /** 逐字节喂入，自动找帧头 + CRC 校验 + 错误重同步。 */
  class FrameParser {
    constructor() {
      this._buf = [];
      this._state = 0;          // 0=magic0 1=magic1 2=header 3=payload 4=crc
      this._len = 0;
      this.frames_ok = 0;
      this.crc_errors = 0;
      this.resyncs = 0;
      this.bad_version = 0;
    }

    reset() {
      this._buf.length = 0;
      this._state = 0;
      this._len = 0;
    }

    /**
     * 解析器是否停在某一帧的中间。
     *
     * 配合"空闲超时复位"用：BLE 上如果收到半截帧就断了（对端重启、上电时序），
     * 解析器会一直傻等剩下的字节，并把下一个帧头当成自己的载荷吃掉，从此永久
     * 失步。帧与帧之间有明确间隔（10Hz 即 100ms），所以"帧中间状态持续几十
     * 毫秒没有新字节"就可以断定残帧，复位重来。
     */
    is_mid_frame() { return this._state !== 0; }

    feed(data) {
      const out = [];
      for (let i = 0; i < data.length; i++) {
        const frame = this._push(data[i]);
        if (frame !== null) out.push(frame);
      }
      return out;
    }

    _push(byte) {
      if (this._state === 0) {
        if (byte === MAGIC0) {
          this._buf = [byte];
          this._state = 1;
        }
        return null;
      }

      if (this._state === 1) {
        if (byte === MAGIC1) {
          this._buf.push(byte);
          this._state = 2;
        } else if (byte !== MAGIC0) {
          this.resyncs += 1;
          this._state = 0;
        }
        // byte === MAGIC0：留在 state 1，支持 0xA5 0xA5 0x5A
        return null;
      }

      if (this._state === 2) {
        this._buf.push(byte);
        if (this._buf.length < HEADER_LEN) return null;
        this._len = this._buf[4] | (this._buf[5] << 8);
        if (this._len > MAX_PAYLOAD) {
          this.resyncs += 1;
          this._state = 0;
          return null;
        }
        this._state = this._len === 0 ? 4 : 3;
        return null;
      }

      if (this._state === 3) {
        this._buf.push(byte);
        if (this._buf.length < HEADER_LEN + this._len) return null;
        this._state = 4;
        return null;
      }

      // state === 4
      this._buf.push(byte);
      if (this._buf.length < HEADER_LEN + this._len + CRC_LEN) return null;

      this._state = 0;
      const buf = Uint8Array.from(this._buf);
      const expect = buf[HEADER_LEN + this._len] |
                     (buf[HEADER_LEN + this._len + 1] << 8);
      const got = crc16(buf.subarray(2, HEADER_LEN + this._len));
      if (expect !== got) {
        this.crc_errors += 1;
        return null;
      }
      if (buf[2] !== VERSION) {
        this.bad_version += 1;
        return null;
      }

      this.frames_ok += 1;
      return new Frame(buf[2], buf[3], buf.slice(HEADER_LEN, HEADER_LEN + this._len));
    }
  }

  function decode_text(payload) {
    if (payload.length < 2) throw new Error('NAV_TEXT 太短');
    const kind = payload[0];
    const n = payload[1];
    if (2 + n !== payload.length) throw new Error('NAV_TEXT 长度字段与实际不符');
    return [kind, new TextDecoder('utf-8').decode(payload.subarray(2, 2 + n))];
  }

  const API = {
    MAGIC0, MAGIC1, VERSION, HEADER_LEN, CRC_LEN, OVERHEAD, MAX_PAYLOAD,
    NAV_UPDATE_LEN, NAV_META_LEN, PUCK_STATUS_LEN, NAV_CLOCK_LEN,
    NAV_ROUTE_HEADER_LEN, MAX_ROUTE_POINTS, MAX_ROUTE_CHUNK_POINTS_BY_PAYLOAD,
    MAX_ROUTE_CHUNK_POINTS, ROUTE_MAX_RANGE_M, ROUTE_CHUNK_LAST,
    NO_TURN, NO_TURN_INDEX,
    NAV_MAP_HEADER_LEN, MAX_MAP_SEGMENTS, MAX_MAP_TOTAL_POINTS,
    nav_map_payload_len, nav_map_fits, nav_map_max_points_for_segs,
    MsgType, TextKind, Turn, TURN_NAMES, turn_name, NavFlags, PuckEventId,
    crc16, _clamp_i, _truncate_utf8, _hex,
    NavUpdate, NavMeta, PuckStatus, NavRoute, NavMap, Frame, FrameParser,
    NavClock, now_clock,
    route_chunks, encode_frame, encode_nav_update, encode_nav_text,
    encode_nav_meta, encode_nav_route, encode_nav_route_full, encode_nav_map,
    encode_puck_status, encode_nav_clock, encode_puck_event, encode_ping, encode_pong, decode_text,
  };

  // 把 Turn 表回填给 navmath.js。
  //
  // navmath.classify_turn() 需要 Turn 枚举，但 navmath.js 不能 require 本文件
  // （本文件已经 require 了它，互相 require 会拿到残缺的 exports）。
  // 所以依赖方向固定为 proto -> navmath，由这边加载完主动回填。
  // 浏览器里两个文件是各自独立的 <script>，这个回填同样是必需的。
  if (nm && typeof nm._setProto === 'function') nm._setProto(API);

  return API;
}));
