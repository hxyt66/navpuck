/*
 * NavPuck 手机端 **集成自测**（无浏览器、无设备、无网络）。
 *
 * 前面两个测试覆盖的是"零件"：
 *   selftest.mjs  字节级协议一致性
 *   parity.mjs    与 navigator.py 的导航语义一致性
 *
 * 这里覆盖的是"接线"—— 也就是只有跑起来才暴露的那些问题：
 *   - 整条路线到底有没有在开头发出去、分片顺序对不对
 *   - 30 秒兜底重发有没有真的发生
 *   - 链路 down->up 时有没有补发整条路线
 *   - 10Hz 循环产出的 NAV_UPDATE 能不能被设备侧的解析器解出来（端到端闭环）
 *   - 分片试探 512 -> 20 的降档逻辑与"写失败要作废整帧"
 *   - 队满时丢的是 update 而不是 route
 *   - 底图帧不超 MAX_PAYLOAD
 *   - 上行残帧看门狗会不会复位
 *
 * 做法：把浏览器 API（navigator.bluetooth / geolocation / localStorage /
 * fetch）全都换成伪造实现，然后把 app.js 里的 Navigator 真跑起来。
 * 没有 DOM：app.js 顶层的 App 类会自动跳过 init()，Navigator 是纯逻辑类。
 *
 * 怎么跑（在 navpuck 根目录）：
 *     node phone/test/integration.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.resolve(__dirname, '..');

// app.js 需要 document/navigator 存在（顶层会判断 document），
// 但 Navigator 类本身是纯逻辑。这里给一个最小壳，让 app.js 能安全加载。
//
// ⚠️ 两件事：
// 1) Node 18+ 里 globalThis.navigator 是**只读的 getter**（内置的
//    navigator.userAgent），不能直接赋值，否则 TypeError。而 Node 自带的
//    navigator 没有 bluetooth —— 正好就是我们要的"未连接"初始状态。
//    BleLink 允许注入 navigator，所以测试里不需要改全局。
// 2) app.js 是给浏览器写的**经典脚本 IIFE**，它从 globalThis 上取
//    NavPuckMath / NavPuckProto / NavPuckRoute / NavPuckMap。浏览器里这四个
//    由前面的 <script> 挂上去；Node 里必须在这里手工挂一遍，否则
//    `new App()` 会在 rt.DEMO_ROUTE 上直接崩。挂成全局是**故意**的，
//    这样测的就是 app.js 真实的那条代码路径，而不是它的一个测试专用分支。
globalThis.document = undefined;
const NM_ = require(path.join(PHONE_DIR, 'navmath.js'));
const P_ = require(path.join(PHONE_DIR, 'proto.js'));
const RT_ = require(path.join(PHONE_DIR, 'route.js'));
const MAP_ = require(path.join(PHONE_DIR, 'map.js'));
const BLE_ = require(path.join(PHONE_DIR, 'ble.js'));
globalThis.NavPuckMath = NM_;
globalThis.NavPuckProto = P_;
globalThis.NavPuckRoute = RT_;
globalThis.NavPuckMap = MAP_;
globalThis.NavPuckBle = BLE_;

const P = P_;
const NM = NM_;
const RT = RT_;
const MAP = MAP_;
const BLE = BLE_;
const APP = require(path.join(PHONE_DIR, 'app.js'));

// ---------------------------------------------------------------------------
// 测试框架
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let group = '';
function section(n) { group = n; console.log(`\n[${n}]`); }
function ok(c, l) {
  if (c) { passed += 1; console.log(`  ✓ ${l}`); }
  else { failures.push(`${group} :: ${l}`); console.log(`  ✗ ${l}`); }
}
function eq(a, b, l) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x === y) { passed += 1; console.log(`  ✓ ${l}`); }
  else { failures.push(`${group} :: ${l}\n      期望 ${y}\n      实得 ${x}`); console.log(`  ✗ ${l}\n      期望 ${y}\n      实得 ${x}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** PING 的消息类型值（proto.js 里叫 MsgType.PING，这里包一层免得写错）。 */
const MsgType_ping = () => P.MsgType.PING;

// ---------------------------------------------------------------------------
// 伪造一个 Web Bluetooth 设备
// ---------------------------------------------------------------------------
/**
 * 模拟设备侧：接收手机写来的字节，喂给真正的 FrameParser（等价于设备固件
 * 里那个流式重组器），把解出的帧记下来。这是"端到端闭环"的关键 ——
 * 手机发出去的字节必须能被**同一套协议**解出来。
 */
class FakeDevice {
  constructor() {
    this.parser = new P.FrameParser();
    this.frames = [];              // 解出的帧
    this.writes = [];              // 每次 write 的字节数（用来验证分片）
    this.chunk_sizes = new Set();
    this.fail_above = Infinity;    // 单次写超过这个字节数就抛错（模拟 MTU 不够）
    this.notify_cb = null;
    this.subscribed = false;
  }

  receive(bytes) {
    this.writes.push(bytes.length);
    this.chunk_sizes.add(bytes.length);
    if (bytes.length > this.fail_above) {
      const e = new Error(`模拟写失败：${bytes.length} > ${this.fail_above}`);
      e.name = 'NetworkError';
      throw e;
    }
    for (const fr of this.parser.feed(bytes)) this.frames.push(fr);
  }

  // 设备 -> 手机：通知。真机的事件对象是 { target: { value: DataView } }，
  // 这里必须**照着真机的形状**造，否则测的是假接口而不是真代码。
  emit(bytes) {
    if (this.notify_cb) {
      const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      this.notify_cb({ target: { value: new DataView(u8.buffer, u8.byteOffset, u8.byteLength) } });
    }
  }

  /** 发一个 PUCK_STATUS 给手机。 */
  emit_status(vbat_mv, pct, flags) {
    this.emit(P.encode_puck_status(new P.PuckStatus({ vbat_mv, battery_pct: pct, flags })));
  }

  frames_of_type(t) { return this.frames.filter((f) => f.type === t); }
  reset_counts() { this.frames = []; this.writes = []; this.chunk_sizes.clear(); }
}

function fake_bluetooth(device, opts) {
  const o = opts || {};
  const rx = {
    async writeValueWithoutResponse(bytes) {
      if (o.reject_without_response) throw new Error('不支持 without response');
      device.receive(bytes);
    },
    async writeValue(bytes) { device.receive(bytes); },
  };
  const tx = {
    async startNotifications() { device.subscribed = true; return tx; },
    addEventListener(ev, cb) { if (ev === 'characteristicvaluechanged') device.notify_cb = cb; },
  };
  const gatt = {
    connected: false,
    async connect() { gatt.connected = true; return gatt; },
    disconnect() {
      gatt.connected = false;
      if (device._disc_cb) device._disc_cb();
    },
  };
  const bt = {
    async requestDevice() {
      if (o.cancel_request) {
        const e = new Error('User cancelled the requestDevice() chooser.');
        e.name = 'NotFoundError';
        throw e;
      }
      return {
        name: o.name || 'NavPuck-A1B2',
        gatt,
        addEventListener(ev, cb) { if (ev === 'gattserverdisconnected') device._disc_cb = cb; },
      };
    },
  };
  return { bt, rx, tx, gatt };
}

/**
 * 建一个接好线的 BleLink。
 *
 * ble.js 直接吃 navigator.bluetooth，所以把 fake 塞进一个假 navigator。
 */
async function make_link(device, opts) {
  const o = opts || {};
  const f = fake_bluetooth(device, o);
  const link = new BLE.BleLink({
    navigator: { bluetooth: f.bt },
    onLog: () => {},
  });
  // getPrimaryService / getCharacteristic 在真机上是异步的；这里注入一个
  // 简化版：连接时直接把假的 rx/tx 装上去。
  link._gatt_connect = async function () {
    await f.gatt.connect();                 // 置 gatt.connected = true
    this.server = f.gatt;
    this.rx = f.rx;
    this.tx = f.tx;
    await f.tx.startNotifications();
    this.tx.addEventListener('characteristicvaluechanged', (ev) => this._on_notify(ev));
    this.parser.reset();
    this.chunk_size = 512;
    this._chunk_known = false;
    this._last_rx_t = Date.now();
    this._setState('up', { name: this.device_name });
  };
  return { link, f };
}

/** 一个按脚本走的位置源，接口与 GeoSource 一致。 */
class ScriptSource {
  constructor(fixes) { this.fixes = fixes; this.i = 0; this.heading_source = 'gps'; }
  has_fix() { return true; }
  fix() {
    const f = this.fixes[Math.min(this.i, this.fixes.length - 1)];
    this.i += 1;
    return f;                                  // [lat, lon, heading, speed_mps]
  }
  advance(n) { this.i += n; }
}

function demo_route() {
  return new RT.Route(RT.DEMO_ROUTE.map((p) => [p[0], p[1], p[2]]), true);
}

function fixes_along(route, n, speed_mps) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = route.total_m * k / Math.max(1, n - 1) * 0.9;
    const [la, lo] = route.point_at(s);
    out.push([la, lo, route.tangent_deg(s), speed_mps]);
  }
  return out;
}

// ---------------------------------------------------------------------------
section('1] BleLink：连接、订阅、PUCK_STATUS 上行');
// ---------------------------------------------------------------------------
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);

  const states = [];
  link.onState = (s) => states.push(s);

  await link.connect();
  eq(states, ['connecting', 'up'], '状态迁移 idle -> connecting -> up');
  eq(link.connected, true, 'connected = true');
  eq(dev.subscribed, true, '已订阅 TX 通知');
  eq(link.device_name, 'NavPuck-A1B2', '设备名读到 NavPuck-A1B2');

  // 设备上行 PUCK_STATUS -> 手机解析
  let got_status = null;
  link.onStatus = (s) => { got_status = s; };
  dev.emit_status(3960, 78, P.NavFlags.LINK_UP);
  eq(got_status && got_status.battery_pct, 78, 'PUCK_STATUS 电量 78% 解出');
  eq(got_status && got_status.vbat_mv, 3960, 'PUCK_STATUS 电压 3960mV 解出');
  eq(link.device_link_up, true, 'device_link_up = true（flags bit4）');
  eq(link.device_battery_pct, 78, 'device_battery_pct = 78');

  // 逐字节拆开发一个 PUCK_STATUS：设备侧的通知可能被任意切分
  got_status = null;
  const one = P.encode_puck_status(new P.PuckStatus({ vbat_mv: 3700, battery_pct: 42, flags: 0 }));
  for (let i = 0; i < one.length; i++) dev.emit(one.subarray(i, i + 1));
  eq(got_status && got_status.battery_pct, 42, '逐字节到达的 PUCK_STATUS 也能解出（流式）');

  // 发一帧然后确认设备侧解出来了
  const u = new P.NavUpdate({ heading_cdeg: 9000, speed_kmh_x10: 487 });
  link.send(P.encode_nav_update(u), 'update', 5);
  await sleep(20);
  eq(dev.frames_of_type(P.MsgType.NAV_UPDATE).length, 1, '设备侧解出 1 帧 NAV_UPDATE');
  const back = P.NavUpdate.unpack(dev.frames_of_type(P.MsgType.NAV_UPDATE)[0].payload);
  eq([back.heading_cdeg, back.speed_kmh_x10], [9000, 487], 'NAV_UPDATE 字段端到端正确');
}

// ---------------------------------------------------------------------------
section('2] 分片试探：512 失败自动降到 20，并作废整帧重发');
// ---------------------------------------------------------------------------
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();

  // 让 512 字节的写失败（模拟对端 MTU 只有 23）
  dev.fail_above = 20;
  const logs = [];
  link.onLog = (l) => logs.push(l);

  // 造一帧 100 字节的（NAV_MAP），按 512 分片会一次写完 -> 失败 -> 降到 244 ...
  // 一直降到 20 才能成功。中间每次失败都会重启整帧。
  const big = P.encode_frame(P.MsgType.NAV_MAP, new Uint8Array(100));
  link.send(big, 'map', 3);
  await sleep(200);

  eq(link.chunk_size, 20, '分片大小最终降到 20 字节');
  ok(link.downgrades > 0, `发生过降档（${link.downgrades} 次）`);
  // 设备侧必须**恰好**解出 1 帧：中间那些失败的分片是被吞掉的（模拟丢包），
  // 但整帧作废重发之后必须只成功一次，不能出现"半帧 + 半帧"拼出来的东西
  eq(dev.frames_of_type(P.MsgType.NAV_MAP).length, 1,
     '降档重试后设备侧恰好解出 1 帧（没有拼出重复/半截帧）');
  eq(dev.parser.crc_errors, 0, 'CRC 零错误');
  ok(logs.some((l) => /降到 20 字节/.test(l)), '日志里记录了降档过程');
  ok(logs.some((l) => /分片大小确定：20 字节/.test(l)), '日志里记录了最终分片大小');

  // 降档定下来之后，再发一帧，验证分片确实是**确定的** 20 字节。
  // （不能拿上面那些 writes 去数：那里面混着 512/244/... 每次失败的尝试。）
  dev.reset_counts();
  const ok_before = dev.parser.frames_ok;
  const crc_before = dev.parser.crc_errors;
  const small = P.encode_frame(MsgType_ping(), new Uint8Array(30));
  link.send(small, 'ctl', 1);
  await sleep(150);
  const sizes = dev.writes.slice();
  eq(small.length, 38, 'PING 帧 + 30 字节载荷 = 38 字节');
  eq(sizes, [20, 18],
     '38 字节按 20 分片 -> 恰好 [20, 18]（末片是余数，不是补零）');
  // 用增量比，不用绝对值：dev.parser 是整节共用的，frames_ok 里还留着
  // 前面那几帧的计数（reset_counts() 只清 dev.frames，不清解析器的累计值）。
  eq([dev.parser.frames_ok - ok_before, dev.parser.crc_errors - crc_before,
      dev.parser.is_mid_frame()],
     [1, 0, false],
     '这一帧新增 frames_ok=1、新增 CRC 错=0、解析器不在帧中间');
  eq(dev.frames.filter((f) => f.type === MsgType_ping()).length, 1,
     '设备侧解出的确实是 PING 帧');
}

// ---------------------------------------------------------------------------
section('3] 队满时丢的是 update，route 绝不丢');
// ---------------------------------------------------------------------------
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  // 不连接：队列会积压（_drain 会清空队列）—— 所以这里先在连接状态下
  // 用一个永不返回的写来卡住 drain。
  await link.connect();
  dev.fail_above = Infinity;
  // 把 rx 换成一个慢写，制造积压
  const realRx = link.rx;
  let release;
  const gate = new Promise((r) => { release = r; });
  link.rx = {
    async writeValueWithoutResponse(b) { await gate; return realRx.writeValueWithoutResponse(b); },
  };

  // 先塞满队列（QUEUE_MAX 帧 update），再塞一帧 route
  for (let i = 0; i < BLE.QUEUE_MAX + 10; i++) {
    link.send(new Uint8Array([1, 2, 3]), 'update', 5);
  }
  const before = link._queue.length;
  link.send(new Uint8Array([9, 9, 9]), 'route', 0);
  ok(link._queue.some((f) => f.kind === 'route'),
     `队满时 route 帧仍能入队（队列 ${before} -> ${link._queue.length}）`);
  ok(link._queue.length <= BLE.QUEUE_MAX, `队列长度不超过上限 ${BLE.QUEUE_MAX}`);
  ok(link.frames_dropped > 0, `丢掉了 ${link.frames_dropped} 帧 update 来腾位置`);
  // route 的优先级最高，必须排在最前面
  eq(link._queue[0].kind, 'route', 'route 排到队首（priority 0）');
  // 放行后队列会**慢慢**排空：_drain() 每帧都让出一次事件循环
  // （`await _yield()`，Node 里 setTimeout(0) 实际最小 ~1ms），
  // 251 帧就是 250ms 量级 —— 这正是"不能把 10Hz 循环卡住"的代价与证据。
  release();
  const t0 = Date.now();
  while (link._queue.length > 0 && Date.now() - t0 < 8000) await sleep(20);
  eq(link._queue.length, 0, `放行后队列排空（耗时 ${Date.now() - t0}ms，每帧让出一次事件循环）`);
  const wrote_bytes = dev.writes.reduce((a, b) => a + b, 0);
  eq(dev.writes.length, BLE.QUEUE_MAX,
     `链路把队列里 ${BLE.QUEUE_MAX} 帧全写给了设备（共 ${wrote_bytes} 字节）`);
  eq(link.frames_sent, BLE.QUEUE_MAX, `frames_sent = ${BLE.QUEUE_MAX}`);
  eq(link.frames_dropped, 11, 'frames_dropped = 11（队满时为 route 腾位置丢掉的 update）');
  // 这一节发的载荷是 3 个垃圾字节（不是合法帧头），所以设备侧**应当**一帧都
  // 解不出来 —— 解析器在 magic 上重新同步正是它该做的事。这里钉住的其实是
  // "没有半截残留"：解析器必须干净地停在 state 0，不能因为一堆垃圾就卡住。
  eq(dev.frames.length, 0, '3 字节垃圾载荷不产生任何帧（解析器在 magic 上丢弃）');
  eq(dev.parser.is_mid_frame(), false, '一堆垃圾之后解析器没有卡在帧中间');
  eq(dev.parser.crc_errors, 0, '垃圾载荷不产生 CRC 错误（连帧头都没凑齐）');
}

// ---------------------------------------------------------------------------
section('4] 端到端：整条路线下发 + 10Hz NAV_UPDATE + 设备侧闭环');
// ---------------------------------------------------------------------------
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();

  const route = demo_route();
  const source = new ScriptSource(fixes_along(route, 400, 12.0));

  const sent = [];
  const nav = new APP.Navigator(route, source, {
    send: (frame, kind, prio) => { sent.push({ frame, kind, prio }); return link.send(frame, kind, prio); },
    onLog: () => {},
    onUi: () => {},
    config: { rate_hz: 10, no_map: true },     // 关掉底图，先只验证路线/帧
  });
  nav.set_ble(link);

  eq(nav.window_pts.length, 0, '还没跑第一个周期时窗口是空的（原点在第一个定位帧才定）');

  // 驱动 30 个周期。
  //
  // ⚠️ 每个 send() 内部都会 `await _yield()` 让出一次事件循环（这正是
  //    "不能把 10Hz 循环卡住"的实现方式），所以**不能**同步跑完 30 次就期待
  //    设备侧已经收全 —— 那样测的是 Node 的定时器精度，不是这段逻辑。
  //    这里同步跑完（cycle() 本身是同步的，返回值就是这一帧的 NavUpdate），
  //    只断言"每个周期都算出并下发了一帧 NAV_UPDATE"，
  //    帧的**到达**留给下面的排空等待 + 设备侧计数去验。
  const produced = [];
  for (let i = 0; i < 30; i++) produced.push(nav.cycle(0.1));
  eq(produced.filter((u) => u !== null).length, 30,
     '30 个周期每个都算出了一帧 NAV_UPDATE（cycle() 返回非 null）');
  eq(nav.reanchors, 1, '30 个周期里只重锚了 1 次（3 秒走 36m，离 5km 重锚线还远）');
  eq(nav.window_pts.length >= 2, true,
     `路线窗口抽成 ${nav.window_pts.length} 个点（固定 ${RT.STEP_M}m 点距）`);
  ok(Math.abs(nav.window_pts[0][0]) <= 1 && Math.abs(nav.window_pts[0][1]) <= 1,
     '窗口的第一个点就在原点（骑手位置）上');
  ok(nav._window_span_m() <= RT.WINDOW_M + 200,
     `窗口跨度 ${nav._window_span_m().toFixed(0)} m 在 WINDOW_M(${RT.WINDOW_M}) 之内`);
  eq(sent.filter((s) => s.kind === 'update').length, 30,
     '30 个周期各下发了一帧 update');
  const drain_t0 = Date.now();
  while (link._queue.length > 0 && Date.now() - drain_t0 < 8000) await sleep(20);
  eq(link._queue.length, 0, `发送队列排空（耗时 ${Date.now() - drain_t0}ms）`);

  // 设备侧：第一片是**空路线**（重锚/首发先把设备上的旧窗口清掉），
  // 后面的分片必须齐、且最后一片带 last
  const route_frames = dev.frames_of_type(P.MsgType.NAV_ROUTE);
  const clear = P.NavRoute.unpack(route_frames[0].payload);
  eq([clear.total_points, clear.count], [0, 0],
     '第一片是空路线（total_points=0）—— 设备据此清掉旧窗口');
  const chunks = route_frames.slice(1).map((f) => P.NavRoute.unpack(f.payload));
  const expect_chunks = P.route_chunks(nav.window_pts);
  eq(chunks.length, expect_chunks.length, `设备侧收到 ${chunks.length} 片 NAV_ROUTE（期望 ${expect_chunks.length}）`);
  eq(chunks.map((c) => c.total_points), expect_chunks.map((c) => c.total_points), '每片 total_points 一致');
  eq(chunks.map((c) => c.chunk_start), expect_chunks.map((c) => c.chunk_start), '每片 chunk_start 一致');
  eq(chunks.map((c) => c.flags), expect_chunks.map((c) => c.flags), '每片 flags 一致');
  ok(chunks[chunks.length - 1].is_last_chunk(), '最后一片带 last（设备据此认为这一窗齐了）');

  // 把分片按 chunk_start 拼回去，必须与 window_pts 逐点相同
  const rebuilt = new Array(nav.window_pts.length).fill(null);
  for (const c of chunks) for (let k = 0; k < c.pts.length; k++) rebuilt[c.chunk_start + k] = c.pts[k];
  let mism = 0;
  for (let i = 0; i < nav.window_pts.length; i++) {
    if (!rebuilt[i] || rebuilt[i][0] !== nav.window_pts[i][0] || rebuilt[i][1] !== nav.window_pts[i][1]) mism += 1;
  }
  eq(mism, 0, `设备侧拼出的 ${nav.window_pts.length} 个点与手机端逐点相同`);

  // NAV_UPDATE：每个周期一帧，排空后必须**一帧不多、一帧不少**
  const upd = dev.frames_of_type(P.MsgType.NAV_UPDATE);
  eq(upd.length, 30, `设备侧收到 30 帧 NAV_UPDATE（30 个周期，无丢帧）`);
  const last = P.NavUpdate.unpack(upd[upd.length - 1].payload);
  eq(last.view_range_dm, 1600, 'view_range_dm = 1600（160m 固定视野，不分档）');
  ok(last.has_next_turn() || last.turn === P.Turn.ARRIVE, 'next_turn_index 是合法下标或 NO_TURN');
  ok(last.progress_pct <= 100, `progress_pct ${last.progress_pct} <= 100`);
  ok(last.dist_dest_m > 0, `dist_dest_m ${last.dist_dest_m} > 0`);
  ok(last.flags & P.NavFlags.GPS_FIX, 'flags 带 GPS_FIX');
  ok(last.flags & P.NavFlags.LINK_UP, 'flags 带 LINK_UP');

  // next_turn_index 必须真的是"当前窗口里的一个点"
  if (last.has_next_turn()) {
    ok(last.next_turn_index < nav.window_pts.length,
       `next_turn_index ${last.next_turn_index} < 窗口点数 ${nav.window_pts.length}`);
  }

  // 路线只应发一遍（30 个周期 = 3 秒，远小于 30 秒重发周期）：空片 + 分片
  eq(sent.filter((s) => s.kind === 'route').length, expect_chunks.length + 1,
     '3 秒内这一窗只发了一遍（空片 + 分片，没到 30 秒兜底重发）');
}

// ---------------------------------------------------------------------------
section('5] 路线窗口的 30 秒兜底重发 + 链路 down->up 补发');
// ---------------------------------------------------------------------------
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();

  const route = demo_route();
  const source = new ScriptSource(fixes_along(route, 5000, 12.0));
  const sent = [];
  const nav = new APP.Navigator(route, source, {
    send: (frame, kind) => { sent.push(kind); return true; },
    onLog: () => {}, onUi: () => {},
    config: { rate_hz: 10, no_map: true },
  });
  nav.set_ble(link);

  // 一次"发一窗" = 1 条空路线（清旧窗口）+ N 片分片。
  // 窗口要跑过第一个周期才存在（原点 = 第一帧骑手位置），所以先跑一帧。
  nav.cycle(0.1);
  const chunks_per_send = P.route_chunks(nav.window_pts).length;
  const frames_per_send = chunks_per_send + 1;
  eq(sent.filter((k) => k === 'route').length, frames_per_send,
     `第一个周期就发了第一窗（空片 + ${chunks_per_send} 片）`);

  // 走 29 秒：不应该重发（12m/s × 29s = 348m，离 5km 重锚线还远）
  for (let i = 0; i < 290; i++) nav.cycle(0.1);
  eq(sent.filter((k) => k === 'route').length, frames_per_send,
     '走了 29 秒仍未重发（阈值 30 秒）');

  // 再过 2 秒（累计 31 秒）：必须重发一次。重发的是**同一份窗口**、而且
  // **不带空片** —— 逐字节相同的分片，设备端认得出来是重传，不会重画。
  const after_resend = frames_per_send + chunks_per_send;
  for (let i = 0; i < 20; i++) nav.cycle(0.1);
  eq(sent.filter((k) => k === 'route').length, after_resend,
     `累计 31 秒时兜底重发了这一窗一次（只发 ${chunks_per_send} 片，不重复清空）`);

  // link down -> up 补发
  link.device_status = new P.PuckStatus({ vbat_mv: 3900, battery_pct: 50, flags: 0 });
  nav.cycle(0.1);                                   // link_up = false
  eq(sent.filter((k) => k === 'route').length, after_resend, '链路 down 时不额外发');
  link.device_status = new P.PuckStatus({ vbat_mv: 3900, battery_pct: 50, flags: P.NavFlags.LINK_UP });
  nav.cycle(0.1);                                   // link_up = true（刚转上来）
  eq(sent.filter((k) => k === 'route').length, after_resend + chunks_per_send,
     '链路 down -> up 时补发了一次（覆盖板子重启）');
  nav.cycle(0.1);
  eq(sent.filter((k) => k === 'route').length, after_resend + chunks_per_send,
     '链路保持 up 时不再重复补发（只在跳变沿发一次）');
}

// ---------------------------------------------------------------------------
section('6] 路网底图：不受限时不阻塞、帧不超 MAX_PAYLOAD、缓存生效');
// ---------------------------------------------------------------------------
{
  const route = demo_route();
  // 伪造 Overpass 响应
  const mk_ways = (n, lat0, lon0) => {
    const els = [];
    for (let i = 0; i < n; i++) {
      const geom = [];
      for (let k = 0; k < 6; k++) {
        geom.push({ lat: lat0 + i * 0.0002 + k * 0.00005, lon: lon0 + k * 0.00008 });
      }
      els.push({ tags: { highway: 'residential' }, geometry: geom });
    }
    return { elements: els };
  };

  let fetch_calls = 0;
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v); },
    removeItem: (k) => { store.delete(k); },
  };
  const fakeFetch = async () => {
    fetch_calls += 1;
    const [la, lo] = route.point_at(0);
    return { ok: true, json: async () => mk_ways(40, la, lo) };
  };

  const mapSrc = new MAP.OsmMapSource({ fetch: fakeFetch, storage, max_points: 330, max_segs: 60 });
  const source = new ScriptSource(fixes_along(route, 200, 12.0));
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();

  const nav = new APP.Navigator(route, source, {
    send: (f, k, p) => link.send(f, k, p),
    onLog: () => {}, onUi: () => {},
    mapSource: mapSrc,
    config: { rate_hz: 10, no_map: false },
  });
  nav.set_ble(link);

  for (let i = 0; i < 60; i++) { nav.cycle(0.1); await sleep(1); }
  await sleep(200);

  ok(fetch_calls >= 1, `Overpass 被调用 ${fetch_calls} 次（后台抓取）`);
  const map_frames = dev.frames_of_type(P.MsgType.NAV_MAP);
  ok(map_frames.length >= 1, `设备侧收到 ${map_frames.length} 帧 NAV_MAP`);
  if (map_frames.length > 0) {
    ok(map_frames[0].payload.length + 8 <= 8 + P.MAX_PAYLOAD,
       `底图帧 ${map_frames[0].payload.length + 8} 字节在协议上限内`);
    const m = P.NavMap.unpack(map_frames[0].payload);
    ok(m.seg_count <= RT.MAP_MAX_SEGMENTS, `底图段数 ${m.seg_count} <= ${RT.MAP_MAX_SEGMENTS}`);
    ok(m.total_pts <= RT.MAP_MAX_POINTS, `底图点数 ${m.total_pts} <= ${RT.MAP_MAX_POINTS}`);
    ok(m.seg_pts.reduce((a, b) => a + b, 0) === m.total_pts, '每段点数之和 = total_pts');
  }

  // 缓存：换一个离得很近的位置，应当命中缓存、不再联网
  const calls_before = fetch_calls;
  const mapSrc2 = new MAP.OsmMapSource({ fetch: fakeFetch, storage, max_points: 330, max_segs: 60 });
  const [la, lo] = route.point_at(0);
  mapSrc2.last_fetch_t = -1e9;
  mapSrc2.refresh(la, lo, 1000);
  eq(mapSrc2.fetch_count, 0, '缓存命中时完全不联网');
  eq(mapSrc2.cache_hits, 1, 'cache_hits 计数 = 1');
  eq(mapSrc2.ways.length, 40, '命中缓存后拿到了 40 条路');

  // remark 必须被当成失败（Overpass 限流时是 200 + remark）
  const badSrc = new MAP.OsmMapSource({
    storage: null,
    endpoints: ['https://x/'],
    fetch: async () => ({ ok: true, json: async () => ({ elements: [], remark: 'runtime error: Query timed out' }) }),
  });
  await badSrc.refresh(30.25, 120.13, 100);
  ok(/remark/.test(badSrc.last_error), `remark 被判为失败：${badSrc.last_error}`);
  ok(badSrc.fail_until_t > 100, '失败后进入冷却（fail_until_t 被设置）');
  eq(badSrc.ways.length, 0, '失败时不留半份数据');

  // 冷却期内不再重试
  const before = badSrc.fetch_count;
  await badSrc.refresh(30.25, 120.13, 101);
  eq(badSrc.fetch_count, before, '冷却期内不再联网（避免把 Overpass 惹毛）');
}

// ---------------------------------------------------------------------------
section('7] 上行残帧看门狗');
// ---------------------------------------------------------------------------
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();

  let saw = 0;
  link.onStatus = () => { saw += 1; };
  const st = P.encode_puck_status(new P.PuckStatus({ vbat_mv: 4000, battery_pct: 90, flags: 0 }));

  // 半截帧，然后长时间没有新字节 -> 看门狗复位
  dev.emit(st.subarray(0, 5));
  eq(link.parser.is_mid_frame(), true, '半截帧后解析器停在帧中间');
  link.tick_watchdog(Date.now() + 3000);            // 假装过了 3 秒
  eq(link.parser.is_mid_frame(), false, '看门狗把残帧复位了');
  // 复位之后一整帧必须能正常解出（否则会永久失步）
  dev.emit(st);
  eq(saw, 1, '复位后完整帧正常解出（没有永久失步）');

  // 未到超时时间就不该复位
  dev.emit(st.subarray(0, 5));
  link.tick_watchdog(Date.now());                   // 刚刚才收到字节
  eq(link.parser.is_mid_frame(), true, '空闲未超时不复位（正常的分片到达不会被误杀）');
}

// ---------------------------------------------------------------------------
section('8] 断开 / 重连');
// ---------------------------------------------------------------------------
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  const states = [];
  link.onState = (s) => states.push(s);
  await link.connect();

  // 模拟设备侧断开
  dev._disc_cb();
  eq(link.state, 'down', '设备断开后状态变 down');
  ok(states.includes('down'), 'onState 收到 down');

  // 手动重连（device 还在手上，不需要再弹框）
  await link.reconnect();
  eq(link.state, 'up', '重连后状态回到 up');
  eq(link.parser.is_mid_frame(), false, '重连时解析器被复位');

  // 手动断开不应触发重连
  await link.disconnect();
  eq(link.state, 'idle', '手动断开后状态是 idle');
  eq(link._reconnect_timer, null, '手动断开时取消了重连定时器');
}

// ---------------------------------------------------------------------------
section('9] 取消设备选择 / 不支持 Web Bluetooth');
// ---------------------------------------------------------------------------
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev, { cancel_request: true });
  const states = [];
  link.onState = (s) => states.push(s);
  let threw = false;
  try { await link.connect(); } catch (_e) { threw = true; }
  ok(threw, '用户取消时 connect() 抛错（调用方需要知道）');
  eq(states[states.length - 1], 'idle', '用户取消后状态回到 idle（不是红色错误）');

  // 不支持的浏览器
  const link2 = new BLE.BleLink({ navigator: {}, onLog: () => {} });
  let threw2 = false;
  try { await link2.connect(); } catch (_e) { threw2 = true; }
  ok(threw2, '没有 navigator.bluetooth 时 connect() 抛错');
  eq(BLE.BleLink.supported(), false, 'BleLink.supported() = false');
}

// ---------------------------------------------------------------------------
section('10] 发出去的每一帧都能被同一套解析器解出（闭环总检）');
// ---------------------------------------------------------------------------
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();
  const route = demo_route();
  const source = new ScriptSource(fixes_along(route, 400, 12.0));
  const nav = new APP.Navigator(route, source, {
    send: (f, k, p) => link.send(f, k, p),
    onLog: () => {}, onUi: () => {},
    mapSource: new MAP.OsmMapSource({ storage: null, fetch: null }),   // 没数据 -> 不发底图
    config: { rate_hz: 10, no_map: false },
  });
  nav.set_ble(link);
  for (let i = 0; i < 40; i++) { nav.cycle(0.1); await sleep(1); }
  await sleep(250);

  eq(dev.parser.crc_errors, 0, '设备侧 CRC 零错误');
  eq(dev.parser.bad_version, 0, '设备侧版本零错误');
  eq(dev.parser.resyncs, 0, '设备侧零重同步（字节流没有错位）');
  ok(dev.frames.length > 30, `设备侧共解出 ${dev.frames.length} 帧，全部 CRC 正确`);
  const types = new Set(dev.frames.map((f) => f.type));
  ok(types.has(P.MsgType.NAV_UPDATE), '解出 NAV_UPDATE');
  ok(types.has(P.MsgType.NAV_ROUTE), '解出 NAV_ROUTE');
  // 每一帧都必须是有效帧（解析器只产出通过 CRC 与长度校验的帧）
  ok(dev.frames.every((f) => f.version === 1), '所有帧 version = 1');
}

// ---------------------------------------------------------------------------
section('11] 60km 长路线端到端：滑动窗口重锚 / 清旧窗口 / 两条上界');
// ---------------------------------------------------------------------------
// 这一节是这一版要修的那个设计缺陷的**验收**：
//   路线点以前是"相对路线起点"的 i16 米，整条路线因此被 ±32.7km 卡死
//   （旧代码在构造 Navigator 时直接 throw）。现在原点跟着骑手走、只发前方
//   10km，60km 的路线必须一路正常 —— 而且**每一个分片**都要落在
//   i16 米（±32767）和 1024 点之内，不能靠"路线短所以碰巧没超"。
{
  // 与 phone/test/pyref.py 的 LONG_ROUTE_POINTS 是同一串坐标（63.3km）
  const longPts = [];
  for (let i = 0; i < 601; i++) longPts.push([30.2500 + i * 0.0009, 120.1300 + i * 0.00035, '']);
  const longRoute = new RT.Route(longPts);
  ok(longRoute.total_m > 32767,
     `长路线 ${(longRoute.total_m / 1000).toFixed(1)}km > ±32.7km（旧实现直接拒收）`);

  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();

  // 1300 个定位点铺在 90% 的路线上（约 44m 一个），足以跑出 13 次重锚
  const source = new ScriptSource(fixes_along(longRoute, 1300, 30.0));
  const nav = new APP.Navigator(longRoute, source, {
    send: (f, k, p) => link.send(f, k, p),
    onLog: () => {}, onUi: () => {},
    config: { rate_hz: 10, no_map: true },
  });
  nav.set_ble(link);

  // 构造 Navigator 本身不能抛错 —— 这一条就是"长路线现在被接受"的直接证据
  eq(nav.window_pts.length, 0, '构造时不建窗口（原点还没定位）；60km 路线不再被拒收');

  let max_win_n = 0;
  let max_win_span = 0;
  for (let i = 0; i < 1300; i++) {
    nav.cycle(0.1);
    if (nav.window_pts.length > max_win_n) max_win_n = nav.window_pts.length;
    max_win_span = Math.max(max_win_span, nav._window_span_m());
    if (i % 50 === 0) await sleep(1);
  }
  const drain_t0 = Date.now();
  while (link._queue.length > 0 && Date.now() - drain_t0 < 15000) await sleep(20);
  eq(link._queue.length, 0, `发送队列排空（耗时 ${Date.now() - drain_t0}ms）`);

  ok(nav.reanchors >= 10, `整段骑行重锚了 ${nav.reanchors} 次（60km / 5km）`);
  ok(max_win_n <= P.MAX_ROUTE_POINTS,
     `任一时刻的窗口点数最多 ${max_win_n} <= ${P.MAX_ROUTE_POINTS}`);
  ok(max_win_span <= P.ROUTE_MAX_RANGE_M,
     `任一时刻窗口里最远的坐标 ${max_win_span}m <= ${P.ROUTE_MAX_RANGE_M}m`);
  ok(max_win_span <= RT.WINDOW_M + 200,
     `最远坐标 ${max_win_span}m 落在 WINDOW_M(${RT.WINDOW_M})+200m 之内`);

  // 设备侧：把每一片 NAV_ROUTE 都解出来，逐片检查两条上界
  const rf = dev.frames_of_type(P.MsgType.NAV_ROUTE);
  ok(rf.length > 0, `设备侧收到 ${rf.length} 片 NAV_ROUTE`);
  let clear_frames = 0;
  let passes = 0;
  let chunk_bad = 0;
  let coord_bad = 0;
  let total_bad = 0;
  let cur_total = null;
  let cur_got = 0;
  let cur_last = false;
  let passes_incomplete = 0;
  let pass_windows = [];
  for (const fr of rf) {
    const c = P.NavRoute.unpack(fr.payload);
    if (c.count > P.MAX_ROUTE_CHUNK_POINTS) chunk_bad += 1;
    if (c.total_points > P.MAX_ROUTE_POINTS) total_bad += 1;
    for (const [e, n] of c.pts) {
      if (Math.abs(e) > P.ROUTE_MAX_RANGE_M || Math.abs(n) > P.ROUTE_MAX_RANGE_M) coord_bad += 1;
    }
    if (c.total_points === 0) {
      // 空片 = 重锚前的"清掉旧窗口"。它必须出现在**每一遍的第一片**。
      if (cur_total !== null) { if (!(cur_got === cur_total && cur_last)) passes_incomplete += 1;
                                pass_windows.push([cur_total, cur_got, cur_last]); }
      clear_frames += 1;
      cur_total = null; cur_got = 0; cur_last = false;
      continue;
    }
    if (cur_total === null) {
      if (c.chunk_start !== 0) { passes_incomplete += 1; }   // 第一片不是 0 = 半个窗口
      cur_total = c.total_points;
      cur_got = 0;
    }
    if (c.chunk_start !== cur_got) passes_incomplete += 1;    // 分片不连续
    cur_got += c.count;
    cur_last = c.is_last_chunk();
  }
  if (cur_total !== null) {
    if (!(cur_got === cur_total && cur_last)) passes_incomplete += 1;
    pass_windows.push([cur_total, cur_got, cur_last]);
  }
  passes = clear_frames;

  eq(chunk_bad, 0, `每一片分片都不超过 ${P.MAX_ROUTE_CHUNK_POINTS} 点（u8 字段的硬上限）`);
  eq(total_bad, 0, `每一片声明的总点数都不超过 ${P.MAX_ROUTE_POINTS}（设备 4KB 数组的容量）`);
  eq(coord_bad, 0, `所有点的 |east|/|north| 都不超过 ${P.ROUTE_MAX_RANGE_M}m（i16 米）`);
  eq(clear_frames, nav.reanchors,
     `每一遍窗口下发前都先发了空片清旧窗口（${clear_frames} = 重锚次数）`);
  eq(passes_incomplete, 0,
     `每一遍窗口都是连续、完整、带 last 的（共 ${passes} 遍，最后一遍 ${cur_got}/${cur_total} 点）`);
  ok(pass_windows.every(([t, g, l]) => t <= P.MAX_ROUTE_POINTS && g === t && l),
     `每一遍的分片点数都在上限内且拼得齐（${pass_windows.length} 遍）`);
}

// ---------------------------------------------------------------------------
section('12] 底图（Overpass）永久失败：导航照常，且网络行为有界');
// ---------------------------------------------------------------------------
// 这一节是这一版要修的那个现场问题的**验收**：
//   公共 Overpass 实例整体挂掉（overpass-api.de 的 443 不通、kumi 镜子真查询
//   超时 >90 秒）时，用户看到的是永远不变的"等待路网"，仿佛导航也死了 ——
//   而实际上路线、箭头、10Hz 更新全都好好的。所以这里逐条钉住：
//     a) 底图永久失败，10Hz 循环一帧都不能少；
//     b) 每个镜像单独超时 + 整轮预算有界（不睡觉的镜像不能把整轮拖死）；
//     c) 缓存优先（新鲜缓存完全不联网；过期缓存先用上并标"已旧"；换镜像列表不废缓存）；
//     d) 失败后指数退避（不把刚恢复的服务打限流）＋ 轮换起点（排头的死镜子不饿死后面）；
//     e) 关掉底图 = 一个请求都不发；
//     f) 底图代码内部抛错也绝不能吃掉这一帧 NAV_UPDATE。
{
  const route = demo_route();
  const mk_ways = (n, lat0, lon0) => {
    const els = [];
    for (let i = 0; i < n; i++) {
      const geom = [];
      for (let k = 0; k < 6; k++) {
        geom.push({ lat: lat0 + i * 0.0002 + k * 0.00005, lon: lon0 + k * 0.00008 });
      }
      els.push({ tags: { highway: 'residential' }, geometry: geom });
    }
    return { elements: els };
  };
  const mk_storage = () => {
    const store = new Map();
    return {
      store,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, v); },
      removeItem: (k) => { store.delete(k); },
    };
  };

  // ---- a) 永久失败时，10Hz 循环一帧都不能少 ----
  {
    const dev = new FakeDevice();
    const { link } = await make_link(dev);
    await link.connect();

    let overpass_calls = 0;
    const deadSrc = new MAP.OsmMapSource({
      storage: null,
      endpoint_timeout_ms: 5, budget_ms: 30, min_slice_ms: 1,
      fetch: async () => { overpass_calls += 1; throw new TypeError('fetch failed'); },
    });
    const source = new ScriptSource(fixes_along(route, 60, 12.0));
    const nav = new APP.Navigator(route, source, {
      send: (f, k, p) => link.send(f, k, p),
      onLog: () => {}, onUi: () => {},
      mapSource: deadSrc,
      config: { rate_hz: 10, no_map: false },
    });
    nav.set_ble(link);

    const CYCLES = 100;                        // 10 秒（模拟时间）
    for (let i = 0; i < CYCLES; i++) { nav.cycle(0.1); await sleep(1); }
    const drain_t0 = Date.now();
    while (link._queue.length > 0 && Date.now() - drain_t0 < 5000) await sleep(10);

    eq(nav.frames_sent, CYCLES,
       `底图永久失败时 10Hz 循环仍然发出了 ${nav.frames_sent}/${CYCLES} 帧`);
    eq(dev.frames_of_type(P.MsgType.NAV_UPDATE).length, CYCLES,
       `设备侧把 ${CYCLES} 帧 NAV_UPDATE 全解出来了（底图挂了不影响导航）`);
    ok(dev.frames_of_type(P.MsgType.NAV_ROUTE).length > 0, '路线窗口照常下发');
    eq(dev.frames_of_type(P.MsgType.NAV_MAP).length, 0, '没有底图数据时不会发半张空底图');
    eq(nav.last_map_segs, 0, 'last_map_segs 保持 0');
    // 整条导航流水线在"零底图数据"下都必须是好的：航向、视距、车位置、
    // 滑动窗口路线 —— 一个都不许因为底图挂了而变样。
    eq(nav.route_sent, true, '滑动窗口路线照常下发（route_sent = true）');
    const rf = dev.frames_of_type(P.MsgType.NAV_ROUTE);
    const chunks = rf.map((f) => P.NavRoute.unpack(f.payload));
    const clear_chunks = chunks.filter((c) => c.total_points === 0);
    ok(clear_chunks.length >= 1, `重锚时先发的空片（清旧窗口）还在（${clear_chunks.length} 片）`);
    // 把"第一遍窗口"挑出来（空片是分界）：必须是完整、连续、带 last 的一遍
    const pass = [];
    for (const c of chunks) {
      if (c.total_points === 0) { if (pass.length) break; continue; }
      pass.push(c);
    }
    ok(pass.length > 0 && pass[0].chunk_start === 0, '第一片真窗口从下标 0 开始');
    const got_pts = pass.reduce((a, c) => a + c.count, 0);
    ok(pass.length > 0 && got_pts === pass[0].total_points &&
       pass[pass.length - 1].is_last_chunk(),
       `路线窗口 ${pass.length ? pass[0].total_points : 0} 点 / ${pass.length} 片，拼得齐且带 last`);
    const last_upd = P.NavUpdate.unpack(
      dev.frames_of_type(P.MsgType.NAV_UPDATE)[dev.frames_of_type(P.MsgType.NAV_UPDATE).length - 1].payload);
    eq(last_upd.view_range_dm, Math.trunc(RT.ROUTE_FAR_M * 10),
       `视距字段照常 = ${RT.ROUTE_FAR_M * 10} dm`);
    ok(Number.isFinite(last_upd.heading_deg), `航向照常有值：${last_upd.heading_deg}°`);
    ok(last_upd.dist_dest_m > 0, `剩余距离照常有值：${last_upd.dist_dest_m} m`);
    ok(last_upd.next_turn_index === 0xFFFF || last_upd.next_turn_index < 1024,
       `下一个动作点下标合法：${last_upd.next_turn_index}`);
    eq(dev.parser.crc_errors, 0, '设备侧 CRC 零错误（帧内容没被底图搞坏）');
    eq(deadSrc.state, 'unavailable', '底图状态 = unavailable（不是含糊的"等待路网"）');
    ok(/不影响导航/.test(deadSrc.status(nav.clock_s).summary),
       `状态里有那句"不影响导航"：${deadSrc.status(nav.clock_s).summary}`);
    ok(deadSrc.status(nav.clock_s).reasons.length >= 1,
       `状态里带着逐镜像的失败原因：${deadSrc.status(nav.clock_s).reasons.join('；')}`);
    ok(overpass_calls <= 2 * deadSrc.endpoints.length,
       `10 秒里只试了 ${overpass_calls} 次请求（冷却生效，没有每帧打一遍）`);
    ok(nav.stats.max_cycle_ms < 50,
       `单帧最长耗时 ${nav.stats.max_cycle_ms.toFixed(1)}ms（底图没有阻塞循环）`);
  }

  // ---- b) 每个镜像单独超时、整轮预算有界（镜像装死也不拖死整轮） ----
  {
    const hung = [];
    const never = (url) => { hung.push(url); return new Promise(() => {}); };
    const src = new MAP.OsmMapSource({
      storage: null,
      endpoints: ['https://a.example/x', 'https://b.example/x', 'https://c.example/x'],
      endpoint_timeout_ms: 60, budget_ms: 200, min_slice_ms: 20,
      fetch: (url) => never(url),
    });
    const t0 = Date.now();
    const got = await src.refresh(30.25, 120.13, 0);
    const elapsed = Date.now() - t0;

    eq(got, false, '所有镜像都装死时 refresh() 返回 false');
    eq(src.state, 'unavailable', '状态 = unavailable');
    eq(hung.length, 3, '三个镜像都被试到了（一个装死不会吃掉整轮）');
    eq(src.errors.length, 3, '三个镜像各有一条失败原因');
    ok(src.errors.every((e) => /请求超时/.test(e.reason)),
       `每条原因都是"请求超时"：${src.errors.map((e) => e.reason).join('；')}`);
    ok(elapsed < 700, `整轮实测 ${elapsed}ms，被预算（200ms）夹住了，没有无限等下去`);
    ok(elapsed >= 120, `整轮实测 ${elapsed}ms，确实把预算用满了（不是提前放弃）`);
    ok(src.status(1).cooldown_s >= 60, `失败后进入冷却 ${src.status(1).cooldown_s}s`);
  }

  // ---- c) 缓存优先：新鲜命中不联网、过期也先用、换镜像列表不废缓存 ----
  {
    const storage = mk_storage();
    const okFetch = async () => ({ ok: true, json: async () => mk_ways(40, 30.25, 120.13) });
    const a = new MAP.OsmMapSource({
      fetch: okFetch, storage, endpoints: ['https://old.example/api/interpreter'],
    });
    eq(await a.refresh(30.25, 120.13, 0), true, '第一次抓取成功');
    eq(a.state, 'ok', '状态 = ok');
    ok(/实时/.test(a.status(1).detail), `详情写明是实时抓取：${a.status(1).detail}`);

    // 换**一整套完全不同的镜像**：缓存照旧命中（缓存键里没有 endpoint）
    let net_after = 0;
    const b = new MAP.OsmMapSource({
      storage, endpoints: ['https://brand.new.example/api/interpreter'],
      fetch: async () => { net_after += 1; throw new Error('不应该联网'); },
    });
    eq(await b.refresh(30.25, 120.13, 1000), false, '缓存命中：refresh 返回 false（没有新数据）');
    eq(b.fetch_count, 0, '镜像列表整个换掉了，旧缓存仍然命中：一次网都没联');
    eq(b.state, 'cached', '状态 = cached');
    eq(b.ways.length, 40, '缓存里有 40 条路');
    ok(/缓存/.test(b.status(1000).short) && /没有联网/.test(b.status(1000).detail),
       `界面上看得出来是缓存：${b.status(1000).short} / ${b.status(1000).detail}`);

    // 缓存变旧：**先用上**（标"缓存已旧"），同时仍然尝试联网刷新
    const raw = JSON.parse(storage.getItem(MAP.MAP_CACHE_KEY));
    raw.entries.forEach((e) => { e.t -= 9 * 86400; });        // 往前挪 9 天 > 7 天阈值
    storage.setItem(MAP.MAP_CACHE_KEY, JSON.stringify(raw));

    const c = new MAP.OsmMapSource({
      storage, endpoint_timeout_ms: 5, budget_ms: 20, min_slice_ms: 1,
      fetch: async () => { throw new Error('挂了'); },
    });
    await c.refresh(30.25, 120.13, 5000);
    eq(c.ways.length, 40, '过期缓存也先画上（联网失败后屏幕上仍然有路）');
    eq(c.stale, true, '过期缓存被标记 stale');
    eq(c.state, 'stale', '状态 = stale（界面写"缓存已旧"，而不是空屏）');
    ok(c.fetch_count >= 1, '过期缓存仍然会去尝试联网刷新');
    ok(/偏旧/.test(c.status(5000).detail),
       `详情里写明了数据偏旧：${c.status(5000).detail}`);
  }

  // ---- d) 失败退避（指数 + 上限）与起点轮换 ----
  {
    const storage = mk_storage();
    const s = new MAP.OsmMapSource({
      storage, endpoints: ['https://a.example/x'],
      endpoint_timeout_ms: 5, budget_ms: 20, min_slice_ms: 1,
      fetch: async () => { throw new Error('挂了'); },
    });
    const cools = [];
    for (let k = 0; k < 4; k++) {
      s.fail_until_t = -1e9;                            // 跳过冷却 = "时间到了"
      await s.refresh(30.25, 120.13, 100 + k * 1000);
      cools.push(s.fail_cooldown_used_s);
    }
    eq(cools, [60, 120, 240, 480], '失败退避是指数的：60 → 120 → 240 → 480 秒');
    const before = s.fetch_count;
    await s.refresh(30.25, 120.13, s.clock_now + 1);    // 还在冷却里
    eq(s.fetch_count, before, '冷却期内一次都不重试（不把刚恢复的服务打限流）');
    s.consecutive_fails = 30;
    s.fail_until_t = -1e9;
    await s.refresh(30.25, 120.13, 999999);
    eq(s.fail_cooldown_used_s, MAP.MAP_FAIL_COOLDOWN_MAX_S,
       `退避有上限 ${MAP.MAP_FAIL_COOLDOWN_MAX_S} 秒（不会等到天荒地老）`);

    // 轮换：失败一次之后，下一轮从下一个镜像开始 —— 排头的死镜子不会永远
    // 把后面的镜像饿死（开发机上 overpass-api.de 正是那个排头的死镜子）
    const tried = [];
    const rot = new MAP.OsmMapSource({
      storage: null, endpoints: ['https://a.example/x', 'https://b.example/x', 'https://c.example/x'],
      endpoint_timeout_ms: 5, budget_ms: 100, min_slice_ms: 1,
      fetch: async (url) => { tried.push(url); throw new Error('挂了'); },
    });
    await rot.refresh(30.25, 120.13, 0);
    eq(tried, ['https://a.example/x', 'https://b.example/x', 'https://c.example/x'],
       '第一轮按列表顺序试 a/b/c');
    rot.fail_until_t = -1e9;
    tried.length = 0;
    await rot.refresh(30.25, 120.13, 1000);
    eq(tried[0], 'https://b.example/x', '失败后下一轮从下一个镜像开始（轮换）');
  }

  // ---- e) 关掉底图 = 一个请求都不发 ----
  {
    let calls = 0;
    const off = new MAP.OsmMapSource({
      storage: null, enabled: false,
      fetch: async () => { calls += 1; return { ok: true, json: async () => mk_ways(5, 30.25, 120.13) }; },
    });
    eq(off.state, 'disabled', 'enabled=false 时状态 = disabled');
    eq(await off.refresh(30.25, 120.13, 0), false, '关掉时 refresh() 直接返回 false');
    eq(calls, 0, '关掉时一个 Overpass 请求都不发');
    const st = off.status(0);
    eq(st.short, '已关闭', '界面短状态 = 已关闭');
    ok(/不影响导航/.test(st.detail), `详情里说明不影响导航：${st.detail}`);
    off.set_enabled(true);
    eq(off.state, 'idle', '重新打开回到 idle（下一轮立刻会试一次）');
  }

  // ---- f) 底图代码自己抛错，也绝不能吃掉这一帧 NAV_UPDATE ----
  {
    const dev = new FakeDevice();
    const { link } = await make_link(dev);
    await link.connect();

    const evil = {
      enabled: true,
      refresh() { throw new Error('底图内部 bug'); },
      build() { throw new Error('底图内部 bug'); },
    };
    const source = new ScriptSource(fixes_along(route, 30, 10.0));
    const logs = [];
    const nav = new APP.Navigator(route, source, {
      send: (f, k, p) => link.send(f, k, p),
      onLog: (l) => logs.push(l), onUi: () => {},
      mapSource: evil,
      config: { rate_hz: 10, no_map: false },
    });
    nav.set_ble(link);
    for (let i = 0; i < 30; i++) { nav.cycle(0.1); await sleep(1); }
    const drain_t0 = Date.now();
    while (link._queue.length > 0 && Date.now() - drain_t0 < 3000) await sleep(10);

    eq(nav.frames_sent, 30, '底图源每次调用都抛错，30 帧 NAV_UPDATE 一帧没少');
    eq(dev.frames_of_type(P.MsgType.NAV_UPDATE).length, 30, '设备侧 30 帧全解出来');
    const map_log = logs.filter((l) => /\[map\]/.test(l))[0] || '';
    ok(map_log.length > 0, `日志里有 [map] 那条（不是静默吞掉）：${map_log}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(62));
if (failures.length === 0) {
  console.log(`  手机端集成自测通过：${passed} 项全部通过`);
  console.log('='.repeat(62));
  process.exit(0);
} else {
  console.log(`  ${passed} 项通过 / ${failures.length} 项失败`);
  console.log('='.repeat(62));
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
