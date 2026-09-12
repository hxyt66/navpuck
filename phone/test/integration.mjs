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
  ok(link._queue.length <= BLE.QUEUE_MAX,
     `队列里还有 update 可挤时，route 靠"挤掉最旧的 update"入队，队列不超额（${link._queue.length} <= ${BLE.QUEUE_MAX}）`);
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
  eq([link.dropped_refused, link.dropped_evicted], [10, 1],
     '丢帧账拆开了：10 帧队满拒收的 update + 1 帧给 route 腾位置挤掉的 update');
  eq(link.route_frames_dropped, 0, 'route 丢帧计数 = 0');
  // 这一节发的载荷是 3 个垃圾字节（不是合法帧头），所以设备侧**应当**一帧都
  // 解不出来 —— 解析器在 magic 上重新同步正是它该做的事。这里钉住的其实是
  // "没有半截残留"：解析器必须干净地停在 state 0，不能因为一堆垃圾就卡住。
  eq(dev.frames.length, 0, '3 字节垃圾载荷不产生任何帧（解析器在 magic 上丢弃）');
  eq(dev.parser.is_mid_frame(), false, '一堆垃圾之后解析器没有卡在帧中间');
  eq(dev.parser.crc_errors, 0, '垃圾载荷不产生 CRC 错误（连帧头都没凑齐）');
  eq(link.frames_offered, link.frames_sent + link.frames_dropped,
     `发/丢记账平了：offered ${link.frames_offered} = sent ${link.frames_sent} + dropped ${link.frames_dropped}`);
  eq(link.frames_enqueued + link.dropped_refused, link.frames_offered,
     `每一帧的去向都唯一：enqueued ${link.frames_enqueued} + refused ${link.dropped_refused} = offered ${link.frames_offered}`);
}

// ---------------------------------------------------------------------------
section('3b] 队列里一个 update 都没有时：route 撑大队列，而不是被丢掉');
// ---------------------------------------------------------------------------
// 这是 Issue 1 的核心场景，也是上一版**真的会丢 route** 的那个分支：
// 队满 + 队列里没有任何比 route 更不值钱的帧（这里就是"全是 route"）时，
// 老代码 `_drop_one_for_space()` 找不到 update 就返回 false -> 丢**进来的**那一帧
// —— 丢的正好是 route。新策略：
//   * 让队列**超额**（软上限，QUEUE_HARD_MAX = 2×QUEUE_MAX），并记 queue_overflow；
//   * 只有连硬上限都到了（链路彻底不排水）才丢 route，而且必须带计数 + ⚠️ 日志。
// 为什么不"阻塞一小会儿"：send() 是在 10Hz 导航循环里**同步**调用的，而能腾出
// 位置的只有异步的 _drain() —— 在这里等就是自我死锁（详见 ble.js 的 _make_room_for）。
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();
  const realRx = link.rx;
  let release;
  const gate = new Promise((r) => { release = r; });
  link.rx = {
    async writeValueWithoutResponse(b) { await gate; return realRx.writeValueWithoutResponse(b); },
  };
  const logs = [];
  link.onLog = (l) => logs.push(l);

  // 只塞 route 帧：队列里再没有"比 route 更不值钱"的东西可挤
  const clearFrame = P.encode_nav_route(P.route_chunks([])[0]);   // 14 字节真空片
  for (let i = 0; i < BLE.QUEUE_MAX; i++) link.send(clearFrame, 'route', 0);
  eq(link._queue.length, BLE.QUEUE_MAX, `队列已满（${BLE.QUEUE_MAX} 帧 route）`);
  // 再来一帧 route：老代码**就是在这里丢掉它的**
  const accepted = link.send(clearFrame, 'route', 0);
  eq(accepted, true, '队满且只有 route 时，新来的 route 仍然入队（返回 true）');
  eq(link._queue.length, BLE.QUEUE_MAX + 1,
     `队列**超额**而不是丢 route（${BLE.QUEUE_MAX} -> ${link._queue.length}）`);
  eq(link.queue_overflow, 1, 'queue_overflow = 1（超额这件事本身有计数）');
  eq(link.route_frames_dropped, 0, 'route 一帧都没丢');

  // 放行：超额的那一帧必须**真的写出去**（"让队列涨"不等于把帧藏在队列里）
  release();
  const t0 = Date.now();
  while (link._queue.length > 0 && Date.now() - t0 < 8000) await sleep(20);
  eq(link._queue.length, 0, `放行后（超额）队列全部排空（耗时 ${Date.now() - t0}ms）`);
  eq(link.frames_sent, BLE.QUEUE_MAX + 1,
     `frames_sent = ${BLE.QUEUE_MAX + 1}（含靠超额入队的那一帧，一帧没少）`);
  eq(dev.frames_of_type(P.MsgType.NAV_ROUTE).length, BLE.QUEUE_MAX + 1,
     `设备侧解出 ${BLE.QUEUE_MAX + 1} 帧 NAV_ROUTE`);
  eq(dev.frames_of_type(P.MsgType.NAV_ROUTE).every(
       (f) => P.NavRoute.unpack(f.payload).total_points === 0), true,
     '每一帧都是那个 14 字节的空片（total_points = 0），内容没被搞坏');
  eq(link.frames_offered, link.frames_sent + link.frames_dropped,
     `发/丢记账平了：offered ${link.frames_offered} = sent ${link.frames_sent} + dropped ${link.frames_dropped}`);

  // ---- 硬上限：连 QUEUE_HARD_MAX 都到了才丢 route，而且必须是**响的** ----
  // （这一段刻意不排空：512 帧每帧让出一次事件循环 ≈ 8 秒，没有必要。
  //   要证明的是"拒收时计数和日志都在"，写出去的能力上面已经证过了。）
  let release2;
  const gate2 = new Promise((r) => { release2 = r; });
  link.rx = {
    async writeValueWithoutResponse(b) { await gate2; return realRx.writeValueWithoutResponse(b); },
  };
  for (let i = link._queue.length; i < BLE.QUEUE_HARD_MAX; i++) link.send(clearFrame, 'route', 0);
  eq(link._queue.length, BLE.QUEUE_HARD_MAX,
     `撑到硬上限 QUEUE_HARD_MAX = ${BLE.QUEUE_HARD_MAX}（= 2 × QUEUE_MAX）`);
  eq(link.send(clearFrame, 'route', 0), false,
     '连硬上限都到了才拒收 route（链路彻底不排水的信号）');
  eq(link.route_frames_dropped, 1, 'route 丢帧计数 = 1（**不静默**：这个计数器就是为此存在的）');
  eq(link.frames_dropped, 1, 'frames_dropped = 1');
  ok(logs.some((l) => /⚠️ 丢帧：route/.test(l)),
     `日志里有一条带 ⚠️ 的 route 丢帧记录：${logs.filter((l) => /丢帧/.test(l)).slice(-1)[0] || '（没有）'}`);
  ok(logs.some((l) => /其中 route 1 帧/.test(l)), '日志里带着累计的 route 丢帧数');
  eq(link.drop_summary.includes('route 1'), true,
     `给界面/状态用的 drop_summary 也把它露出来了：${link.drop_summary}`);
  eq(link.stats.route_frames_dropped, 1, 'stats 快照里同样能读到（界面读的就是这一份）');
  await link.disconnect();
  release2();
  await sleep(50);
  eq(link._queue.length, 0, '断开后队列干净');
  eq(link.frames_offered, link.frames_sent + link.frames_dropped,
     `发/丢记账平了：offered ${link.frames_offered} = sent ${link.frames_sent} + dropped ${link.frames_dropped}`);
}

// ---------------------------------------------------------------------------
section('3c] 断开时队列清空也必须记账（正在写的那一帧不重复记）');
// ---------------------------------------------------------------------------
// 断开/链路丢失时 app.js 会把整条路线重发一遍，所以清空队列功能上安全；
// 但"丢了多少、为什么丢"必须留下账 —— 否则 integration 第 14 节那种
// "设备侧少收了 N 帧"的断言就没法成立（也就没法证明没有静默丢帧）。
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();
  const realRx = link.rx;
  let release;
  const gate = new Promise((r) => { release = r; });
  link.rx = {
    async writeValueWithoutResponse(b) { await gate; return realRx.writeValueWithoutResponse(b); },
  };
  const clearFrame = P.encode_nav_route(P.route_chunks([])[0]);
  // 1 帧正在写（卡在 gate 里）+ 3 帧还在队列里
  for (let i = 0; i < 4; i++) link.send(clearFrame, 'route', 0);
  eq([link.frames_offered, link._queue.length, link._writing === link._queue[0]],
     [4, 4, true], '4 帧入队，第 1 帧已经在写（_writing 指向它）');
  await link.disconnect();
  eq(link._queue.length, 1, '断开后队列里只剩"正在写的那一帧"（它已经交给链路了，不能重复记账）');
  eq(link.frames_dropped, 3, '清队丢掉 3 帧，全部记进 frames_dropped');
  eq(link.dropped_disconnected, 3, '记在 dropped_disconnected 这个原因桶里');
  release();
  await sleep(50);
  eq(link._queue.length, 0, '那一帧写完后队列干净了');
  eq(link.frames_offered, link.frames_sent + link.frames_dropped,
     `发/丢记账平了：offered ${link.frames_offered} = sent ${link.frames_sent} + dropped ${link.frames_dropped}`);
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

  // 设备侧：这一遍分片必须**结构完整**、拼得齐、最后一片带 last，而且
  // **手机侧发了几帧，设备侧就必须解出几帧**。
  //
  // ⚠️ 上一版这里写着"第一片空片会丢"，理由是"mock 的写边界把 14 字节空片和
  //    下一帧的前半截切进同一批写，设备的解析器接着把下一帧的 A5 5A 当成长度
  //    字段（23205 > 1536）于是失步" —— **那个解释是错的，而且盖住了一个真 bug**。
  //    逐字节查过（selftest.mjs 的"任意写边界"那一节，外加用 w64devkit 真编译
  //    lib/navcore/nav_proto.cpp 跑同一套切分矩阵）：两个解析器都是逐字节
  //    状态机，任意切分点（空片两侧的每一个位置、逐字节喂、512 字节写窗口）
  //    解出的帧**完全相同**，一帧不丢；C++ 侧 frames_ok=8 / crc_errors=0 /
  //    resyncs=0，和 JS 侧逐字节一致。协议和固件都没问题。
  //
  //    真正的原因在 ble.js 的队列记账：_drain() 先取 `_queue[0]` 去写，
  //    await 回来后却用 `_queue.shift()` 删"当前的第 0 个"。而 await 期间
  //    send() 会按优先级重排队列（route 是 priority 0，会插到队首），于是被
  //    删掉的是**刚插进来的空片**，而真正写出去的 NAV_CLOCK 还留在队列里、
  //    又被写了一遍。症状：空片一帧没发出去、frames_dropped 仍然是 0
  //    （**完全静默**）、设备侧少一片 NAV_ROUTE。现在 _drain() 按**对象**删帧
  //    （indexOf(f) + splice），route 帧还有"绝不丢"的取舍规则和计数器。
  //
  //    所以这里的断言是严格的：手机侧发 5 帧，设备侧就必须收到 5 帧，
  //    而且第一帧必须正好是那个 14 字节的空片。
  const route_frames = dev.frames_of_type(P.MsgType.NAV_ROUTE);
  const sent_route = sent.filter((s) => s.kind === 'route').length;
  eq(sent_route, 5, `手机侧发了 5 帧 NAV_ROUTE（1 片空片 + 4 片分片）`);
  eq(route_frames.length, sent_route,
     `设备侧一帧不少地收到 ${sent_route} 帧 NAV_ROUTE（实得 ${route_frames.length}）`);
  eq(link.route_frames_dropped, 0, 'route 丢帧计数 = 0（route 帧绝不丢）');
  // 第一帧必须是"清掉旧窗口"的空片：帧长 = 8 字节开销 + 6 字节分片头，
  // total_points = 0。它的字节是固定的 a5 5a 01 04 06 00 00 00 00 00 00 01 79 82。
  eq(route_frames[0].payload.length, P.NAV_ROUTE_HEADER_LEN, '第一帧的载荷正好 6 字节');
  eq(P.NavRoute.unpack(route_frames[0].payload).total_points, 0,
     '第一帧是 total_points = 0 的空片（重锚前必发：不先清掉，设备可能把新旧两个窗口拼成一条不存在的路）');
  const chunks = route_frames.slice(1).map((f) => P.NavRoute.unpack(f.payload));
  const expect_chunks = P.route_chunks(nav.window_pts);
  eq(chunks.length, expect_chunks.length,
     `设备侧收到 ${chunks.length} 片窗口分片（期望 ${expect_chunks.length}）`);
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
  // 手机侧实际**发出**的空片数（total_points == 0，帧长正好是 8+6）。
  //
  // 为什么要单独数一遍：设备侧收到的空片数**可以比发出去的少 1**
  // （下面那条断言解释了为什么），少了之后光看设备侧的数字分不清
  // "没发出去"和"路上被队满丢了"。这个计数器就是那把尺子。
  let sent_clears = 0;
  const nav = new APP.Navigator(longRoute, source, {
    send: (f, k, p) => {
      if (k === 'route' && f.length === P.OVERHEAD + P.NAV_ROUTE_HEADER_LEN) sent_clears += 1;
      return link.send(f, k, p);
    },
    onLog: () => {}, onUi: () => {},
    config: { rate_hz: 10, no_map: true },
  });  nav.set_ble(link);

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
  // ---- 空片（清旧窗口）的条数：**一片都不许少** ----
  //
  // 1300 个周期跑了 130 秒模拟时间，手机侧要发 13000 帧 —— 而 ble.js 的发送
  // 队列只有 QUEUE_MAX = 256 格，10Hz × 远快于排空速度，队列**长期是满的**。
  // 也就是说这一节是"有损队列"压力最大的现场，route 帧的取舍规则必须在这里
  // 站得住：
  //
  //   - 队满时 `_make_room_for()` 先挤**最不值钱**的那一帧（实际上总是最旧的
  //     update），挤到就腾出位置；route 帧只有在"队列里连一个 update 都没有"
  //     时才会走到"让队列超额"那条路（QUEUE_HARD_MAX 兜底），而不是被丢掉。
  //   - 所以不变量是：**重锚了几次，设备侧就必须收到几片空片**，
  //     而且和手机侧**实际发出**的片数逐片相等。上一版这里写的是
  //     `clear_frames === nav.reanchors || === nav.reanchors - 1`，
  //     还配了一段"空片偶尔会被丢，改那条策略不在本次范围内"的说明 ——
  //     那个"偶尔"根本不是队列策略造成的，而是 _drain() 删错帧的记账 bug
  //     （见第 4 节那段说明），它丢的恰好就是队首的 route，而且计数器是 0。
  //     现在两个都修了：删帧按对象删 + route 绝不丢，于是可以严格断言。
  eq(sent_clears, nav.reanchors,
     `手机侧每一遍窗口下发前都发了空片（发出 ${sent_clears} 片 / 重锚 ${nav.reanchors} 次）`);
  eq(clear_frames, sent_clears,
     `发出去的空片一片不少地到了设备侧（设备侧 ${clear_frames} / 手机侧 ${sent_clears}）`);
  eq(clear_frames, nav.reanchors,
     `设备侧收到的空片数 = 重锚次数（${clear_frames} / ${nav.reanchors}）`);
  eq(link.route_frames_dropped, 0,
     `整段骑行 route 丢帧计数 = 0（route 帧绝不丢；队列超额 ${link.queue_overflow} 次、` +
     `历史最高水位 ${link.queue_high_water}/${BLE.QUEUE_MAX}）`);
  eq(link.frames_offered, link.frames_sent + link.frames_dropped,
     `发/丢记账平了：offered ${link.frames_offered} = sent ${link.frames_sent} + dropped ${link.frames_dropped}`);
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
//     g) 预算常数与查询参数钉在"实测 17.6 秒"这条事实上（谁想调小超时，先过这里）；
//     h) **慢但能用的镜像不会被预算饿死**（这一版的现场问题）；
//     i) sticky 镜像：成功过的排第一，失败了立刻退回静态顺序。
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

  // ---- g) 预算常数与查询参数：钉在"实测 17.6 秒"这条事实上 ----
  // 开发机实测（详见 map.js 文件头那张表）：9 个公共实例里只有 maps.mail.ru
  // 能用，而它上面一个 around:300 的**小**查询要 **17.6 秒**。
  // 这一节把那份实测变成可执行的约束 —— 以后谁想把超时"优化"回去，会先在这里
  // 撞墙，而不是等用户再一次看到"全部镜像失败"。
  {
    const MEASURED_QUERY_MS = 17600;      // 实测：200 / 17.6s / 43.9KB / 46 条路
    const N = MAP.ENDPOINTS.length;

    // 1) 顺序：实测唯一能用的那个必须在第一个
    eq(MAP.ENDPOINTS[0], 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
       `实测唯一能用的镜像排在第一个：${MAP.ENDPOINTS[0]}`);
    eq(N, 3, '三个镜像（能用的排头，另外两个留作 fallback）');
    eq(new Set(MAP.ENDPOINTS).size, N, '镜像列表里没有重复项');
    ok(!MAP.ENDPOINTS.some((ep) => /osm\.jp/.test(ep)),
       'TLS 信任失败的那个实例没有被写进列表（写进去只会白烧一个切片）');

    // 2) 超时：必须 2 倍以上于实测查询时间（12 秒那一版就是死在这里）
    ok(MAP.MAP_ENDPOINT_TIMEOUT_MS >= 2 * MEASURED_QUERY_MS,
       `单镜像超时 ${MAP.MAP_ENDPOINT_TIMEOUT_MS}ms >= 2 × 实测查询时间 ` +
       `${MEASURED_QUERY_MS}ms（有余量，不是刚好卡在实测值上）`);
    ok(MAP.MAP_MIN_ENDPOINT_SLICE_MS > MEASURED_QUERY_MS,
       `"这一片够用"的下限 ${MAP.MAP_MIN_ENDPOINT_SLICE_MS}ms > 实测查询时间 ` +
       `${MEASURED_QUERY_MS}ms（否则等于明知一次真查询跑不完还去开一个镜像）`);
    ok(MAP.MAP_MIN_ENDPOINT_SLICE_MS < MAP.MAP_ENDPOINT_TIMEOUT_MS,
       `下限 ${MAP.MAP_MIN_ENDPOINT_SLICE_MS}ms < 单镜像超时 ` +
       `${MAP.MAP_ENDPOINT_TIMEOUT_MS}ms（否则一个镜像都开不起来）`);

    // 3) 预算：把**最后一个**镜像也算进来 —— 前 N-1 个哪怕每个都烧掉一整片，
    //    最后一个仍然拿得到一片"够用"的（> 实测查询时间）。
    //    这就是上一版的病根：3 个镜像、30 秒预算，前两个各烧 12 秒之后只剩 6 秒。
    const last_left = MAP.MAP_REFRESH_BUDGET_MS - (N - 1) * MAP.MAP_ENDPOINT_TIMEOUT_MS;
    ok(last_left > MAP.MAP_MIN_ENDPOINT_SLICE_MS,
       `整轮预算 ${MAP.MAP_REFRESH_BUDGET_MS}ms 减去前 ${N - 1} 个镜像各一整片，` +
       `最后一个还能拿到 ${last_left}ms > 下限 ${MAP.MAP_MIN_ENDPOINT_SLICE_MS}ms` +
       `（不会被记成"未尝试"）`);
    ok(MAP.MAP_REFRESH_BUDGET_MS >= 2 * MAP.MAP_ENDPOINT_TIMEOUT_MS,
       `整轮预算 >= 两个完整切片（排头挂了，第二个镜像仍有一整片）`);

    // 4) 查询参数：半径就是 MAP_RADIUS_M，服务端超时严格早于客户端 abort
    const qsrc = new MAP.OsmMapSource({ storage: null });
    eq(qsrc.radius_m, RT.MAP_RADIUS_M, '查询半径就是 MAP_RADIUS_M（260 米，不能动）');
    const slice_ms = MAP.MAP_ENDPOINT_TIMEOUT_MS;
    const q = qsrc._build_query(30.25, 120.13, slice_ms);
    ok(q.indexOf('around:260,30.250000,120.130000') >= 0,
       `查询里就是 around:260（和 app 的 ~260m 底图半径一致）：${q}`);
    const m = /\[timeout:(\d+)\]/.exec(q);
    ok(m !== null, `查询里有服务端 [timeout:N]：${q}`);
    const server_s = m ? Number(m[1]) : -1;
    ok(server_s * 1000 < slice_ms,
       `服务端超时 ${server_s}s < 客户端 abort ${slice_ms / 1000}s` +
       `（它才有机会回一个带 remark 的 200，而不是只留一个 AbortError）`);
    ok(server_s * 1000 >= MEASURED_QUERY_MS,
       `服务端超时 ${server_s}s >= 实测查询时间 ${MEASURED_QUERY_MS / 1000}s`);
    ok(q.indexOf('way[highway](around:') >= 0,
       '查询形状与实测时逐字相同（way[highway](around:...);out geom;）' +
       '—— 改了形状，那份"17.6 秒 / 200 / CORS *"的实测就不再说明任何事');
  }

  // ---- h) "慢但能用"的镜像不会被预算饿死（这一版修的现场问题）----
  // 现场形状：排头的镜像装死，唯一能用的那个要 ~18 秒才回，结果被预算/超时掐断，
  // 用户看到"全部镜像失败"，而其实它只是慢。
  // 这里把真实常数**按同一比例**缩到毫秒级（免得自测真的等两分钟）：比例不变，
  // 测的就是同一个形状。两个方向都测：新常数必须成，旧常数必须败。
  {
    // 100ms 代表 MAP_ENDPOINT_TIMEOUT_MS（45 秒），其余按同一比例
    const SCALE = 100 / MAP.MAP_ENDPOINT_TIMEOUT_MS;
    const T = 100;
    const B = Math.round(MAP.MAP_REFRESH_BUDGET_MS * SCALE);
    const MIN = Math.round(MAP.MAP_MIN_ENDPOINT_SLICE_MS * SCALE);
    // "慢"的程度按实测来：17.6 秒 / 45 秒 ≈ 0.39 个切片
    const SLOW_MS = Math.max(5, Math.round(17600 * SCALE));

    // 跑一遍"前两个装死、第三个慢但能用"（就是现场那个顺序）
    const run = async (timeout_ms, budget_ms, min_slice_ms) => {
      const EPS = ['https://dead1.example/x', 'https://dead2.example/x',
                   'https://slow.example/x'];
      const tried = [];
      const src = new MAP.OsmMapSource({
        storage: null, endpoints: EPS,
        endpoint_timeout_ms: timeout_ms, budget_ms: budget_ms, min_slice_ms: min_slice_ms,
        fetch: (url) => {
          tried.push(url);
          if (url !== EPS[2]) return new Promise(() => {});      // 装死到超时
          // 慢，但在超时之前回来（用真实的 17.6 秒比例）
          return sleep(SLOW_MS).then(() => ({ ok: true, json: async () => mk_ways(5, 30.25, 120.13) }));
        },
      });
      const got = await src.refresh(30.25, 120.13, 0);
      return { src, got, tried };
    };

    const now = await run(T, B, MIN);
    eq(now.tried.length, 3,
       `新常数下三个镜像都被试到了（${T}/${B}/${MIN}ms）：` +
       `一个装死的镜像不会把后面的饿死`);
    eq(now.got, true, `新常数下"慢但能用"的镜像仍然拿到了数据（慢 ${SLOW_MS}ms）`);
    eq(now.src.state, 'ok', '状态 = ok');
    eq(now.src.current_endpoint, 'https://slow.example/x', '数据来自那个慢镜像');
    // 它慢到 SLOW_MS 才回、却仍然成功返回 —— 说明分给它的那一片一定 >= SLOW_MS，
    // 也就是 >= 实测查询时间按比例缩小的那个值。这正是"慢镜像没被预算饿死"。
    // （成功后 errors 会被清空，这是有意的：界面上只剩"底图正常"。）
    eq(now.src.errors.length, 0, '成功后失败原因被清空（界面只显示"底图正常"）');

    // 反向对照：旧常数（12 秒 / 30 秒 / 2.5 秒）下同一个场景**必然失败**。
    // 这条是这段自测的"我能测出那个 bug"的证明 —— 不然它只是装饰。
    const OLD = {
      t: Math.max(2, Math.round(12000 * SCALE)),
      b: Math.max(4, Math.round(30000 * SCALE)),
      min: 1,
    };
    const old = await run(OLD.t, OLD.b, OLD.min);
    eq(old.got, false,
       `旧常数（${OLD.t}/${OLD.b}/${OLD.min}ms ↔ 12/30/2.5 秒）下同一场景失败 ` +
       `—— 正是用户看到的"全部镜像失败"`);
    eq(old.src.state, 'unavailable', '旧常数下状态 = unavailable');
    eq(old.src.errors.length, 3, '旧常数下三个镜像各留下一条失败/未尝试的原因');
    ok(old.src.errors.every((e) => /请求超时|未尝试/.test(e.reason)),
       `旧常数下三条原因都是"超时/没轮到"：` +
       `${old.src.errors.map((e) => e.reason).join('；')}`);
  }

  // ---- i) sticky 镜像：成功过的排第一，失败了立刻退回静态顺序 ----
  {
    const storage = mk_storage();
    const EPS = ['https://a.example/x', 'https://b.example/x', 'https://c.example/x'];
    // 注意：缓存和 sticky 是**两个独立的键**。这里每轮都把路网缓存清掉，
    // 免得测到"缓存命中"那条早退路径上去（缓存不分镜像，见 map.js）。
    const drop_cache = () => storage.removeItem(MAP.MAP_CACHE_KEY);
    const mk = (fetch_impl) => new MAP.OsmMapSource({
      storage, endpoints: EPS,
      endpoint_timeout_ms: 5, budget_ms: 60, min_slice_ms: 1,
      fetch: fetch_impl,
    });
    const ways_json = async () => mk_ways(5, 30.25, 120.13);

    // 第一轮：a 挂、b 成 —— b 被记住
    const tried1 = [];
    const s1 = mk(async (url) => {
      tried1.push(url);
      if (url === EPS[1]) return { ok: true, json: ways_json };
      throw new Error('挂了');
    });
    eq(s1._preferred, '', '一开始没有"上次成功的镜像"（存储是空的）');
    eq(await s1.refresh(30.25, 120.13, 0), true, '第一轮：a 挂、b 成');
    eq(s1.current_endpoint, EPS[1], '数据来自 b');
    eq(tried1, [EPS[0], EPS[1]], '第一轮按静态顺序试 a → b');
    eq(storage.getItem(MAP.MAP_ENDPOINT_KEY), EPS[1],
       '成功的 b 被持久化进 localStorage（sticky）');

    // 第二轮（新实例、同一份存储）：b 排第一，一次就成
    drop_cache();
    const tried2 = [];
    const s2 = mk(async (url) => { tried2.push(url); return { ok: true, json: ways_json }; });
    eq(s2._preferred, EPS[1], '新实例（等价于重新打开页面）读回了"上次成功的是 b"');
    eq(s2._endpoint_order(), [EPS[1], EPS[0], EPS[2]],
       'b 被排到第一个，其余保持静态顺序（仍然是不重不漏的一个排列）');
    eq(await s2.refresh(30.25, 120.13, 0), true, '第二轮成功');
    eq(tried2, [EPS[1]],
       '第二轮**第一次**就试 b —— 不再先白等前两个挂掉的镜像（这就是省下的那一整片）');

    // 第三轮：b 挂了 —— 退回静态顺序，c 顶上成为新的 sticky
    drop_cache();
    const tried3 = [];
    const s3 = mk(async (url) => {
      tried3.push(url);
      if (url === EPS[2]) return { ok: true, json: ways_json };
      throw new Error('挂了');
    });
    eq(await s3.refresh(30.25, 120.13, 0), true, '第三轮：b 挂了，后面还有能用的');
    eq(tried3, [EPS[1], EPS[0], EPS[2]], 'b 失败后继续按静态顺序试 a → c（退回静态顺序）');
    eq(storage.getItem(MAP.MAP_ENDPOINT_KEY), EPS[2], 'c 成了，sticky 换成 c');

    // 存储里是一个"已经不在列表里"的镜像：当作没有，退回静态顺序（不能崩）
    storage.setItem(MAP.MAP_ENDPOINT_KEY, 'https://gone.example/x');
    const s4 = mk(async () => { throw new Error('挂了'); });
    eq(s4._preferred, '', '存储里那个镜像不在当前列表里 = 当作没有 sticky');
    eq(s4._endpoint_order(), EPS, '退回静态顺序');

    // 存储整个坏掉（隐私模式 / 配额爆了）也不能影响抓取
    const bad_storage = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('QuotaExceededError'); },
      removeItem() { throw new Error('SecurityError'); },
    };
    const s5 = new MAP.OsmMapSource({
      storage: bad_storage, endpoints: EPS,
      endpoint_timeout_ms: 5, budget_ms: 60, min_slice_ms: 1,
      fetch: async () => ({ ok: true, json: ways_json }),
    });
    eq(s5._preferred, '', '存储读不了时当作没有 sticky（不抛）');
    eq(await s5.refresh(30.25, 120.13, 0), true,
       '存储写不了时照样抓得到（sticky 只是记不住，不是依赖）');
    eq(s5.state, 'ok', '状态 = ok');
  }
}

// ---------------------------------------------------------------------------
section('13] 模拟行驶：沿航线按真实流逝时间推进、航向随转弯变化、到终点干净停住');
// ---------------------------------------------------------------------------
// 这一节对应 tools/navigator.py 的 SimSource（PC 版是参考实现）：
//   - s += speed_mps * dt，dt 是**真实流逝时间**
//   - fix() = (point_at(s).lat/lon, tangent_deg(s), speed_mps)
// 唯一**故意**不同的地方在最后一小节：走到终点停住，不像 Python 那样
// `s -= total_m` 绕回起点。
{
  const route = demo_route();                  // 闭环演示航线：10.03km / 7 个转向点
  const total = route.total_m;
  // 第一个转向点：[下标, 转角, 动作]。1391.5m 处 +30.1°
  const M1_IDX = route.maneuvers[0][0];
  const M1_DELTA = route.maneuvers[0][1];
  const M1_S = route.points[M1_IDX].cum_m;

  // --- 1) 位置源本身 ------------------------------------------------------
  ok(APP.RouteSimSource !== APP.SimSource,
     'RouteSimSource 是独立的类（沿航线推进，不是那个静态的手动位置源）');

  const s0 = new APP.RouteSimSource({});
  eq(s0.has_route(), false, '还没 set_route() 时没有航线');
  eq(s0.has_fix(), false, '没有航线时 has_fix() = false');
  eq(s0.fix(0), null, '没有航线时 fix() 返回 null（Navigator 会安全跳过这一帧，不崩）');
  eq(s0.set_route(null), false, 'set_route(null) 被拒绝（返回 false，不会留下半条航线）');
  eq(s0.set_route(route), true, 'set_route(合法航线) 返回 true');
  eq(s0.has_route(), true, 'set_route() 之后 has_route() = true');
  eq(s0.s, 0, '默认从航线起点开始（对应 PC 版 --start 默认 0）');
  eq(s0.is_route_sim, true, '带 is_route_sim 标记（Navigator 靠它走"弧长源"那条分支）');

  s0.active = true;
  const f0 = s0.fix(999);
  eq(f0.length, 4, 'fix() 与 GeoSource 同形状：[lat, lon, heading, speed_mps]');
  const p0 = route.point_at(0);
  ok(Math.abs(f0[0] - p0[0]) < 1e-12 && Math.abs(f0[1] - p0[1]) < 1e-12,
     's=0 的 lat/lon 就是航线起点');
  ok(Math.abs(f0[2] - route.tangent_deg(0)) < 1e-12,
     `航向 = 航线在 s 处的切线（${f0[2].toFixed(1)}°），不是传进来的兜底值`);
  eq(f0[3], 42 / 3.6, '默认速度 = 42 km/h ÷ 3.6 = 11.667 m/s（PC 版 --speed 的默认值）');
  eq(s0.heading_source, 'sim', "heading_source = 'sim'（一眼能看出这个航向是算出来的）");
  eq(s0.accuracy_m, null, 'accuracy_m = null（模拟位置没有精度，界面显示 —）');
  eq(s0.total_m(), total, 'total_m() = 航线全长');

  // --- 2) 速度 = 真实流逝时间 × 速度，而且与帧率无关 ------------------------
  const sv = new APP.RouteSimSource({});
  sv.set_route(route);
  sv.active = true;
  sv.set_speed_kmh(36.0);
  eq(sv.speed_mps, 10.0, '36 km/h = 10 m/s');
  sv.advance(1.0);
  ok(Math.abs(sv.s - 10.0) < 1e-9, `advance(1.0) 走了 10 m（实得 ${sv.s}）`);
  sv.advance(0.5);
  ok(Math.abs(sv.s - 15.0) < 1e-9, `再 advance(0.5) 累计 15 m（实得 ${sv.s}）`);

  const dense = new APP.RouteSimSource({});
  const sparse = new APP.RouteSimSource({});
  dense.set_route(route); sparse.set_route(route);
  dense.set_speed_kmh(36.0); sparse.set_speed_kmh(36.0);
  for (let i = 0; i < 10; i++) dense.advance(0.1);   // 10Hz × 1 秒
  sparse.advance(1.0);                               // 一帧 1 秒
  ok(Math.abs(dense.s - sparse.s) < 1e-9 && dense.s > 0,
     `10 帧 × 0.1s 与 1 帧 × 1.0s 走出的距离相同（${dense.s.toFixed(6)} m）—— 速度与帧率无关`);

  eq(sv.advance(0), sv.s, 'advance(0) 不动（不产生 NaN）');
  sv.set_speed_kmh(0);
  const s_zero = sv.s;
  sv.advance(1.0);
  ok(sv.speed_mps > 0 && sv.s > s_zero && Number.isFinite(sv.s),
     '速度填 0 被夹到极小正值：车还会动一点点，不会看起来像"模拟行驶坏了"');

  // 起点偏移（对应 PC 版 --start）
  sv.set_speed_kmh(36.0);
  sv.restart(0.5);
  ok(Math.abs(sv.s - total * 0.5) < 1e-9, `restart(0.5) 从航线一半开始（${(sv.s / 1000).toFixed(2)} km）`);
  sv.restart(0);
  eq(sv.s, 0, 'restart(0) 回到起点');
  sv.restart(1.0);
  eq([sv.s, sv.arrived], [total, true], 'restart(1.0) 直接落在终点，并且已经算"已到终点"');

  // --- 3) 接进 Navigator：10Hz 每一帧都推进，航向跟着路转弯 ----------------
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();

  const sim = new APP.RouteSimSource({});
  sim.set_route(route);
  sim.set_speed_kmh(36.0);                     // 10 m/s
  sim.active = true;
  // 放到第一个转弯前 40 m 处（转弯在 1391.5m），只跑这一小段
  sim.restart((M1_S - 40.0) / total);

  const sent = [];
  const nav = new APP.Navigator(route, sim, {
    send: (frame, kind, prio) => { sent.push(kind); return link.send(frame, kind, prio); },
    onLog: () => {}, onUi: () => {},
    config: { rate_hz: 10, no_map: true },
  });
  nav.set_ble(link);
  // 室内没有 GPS 这件事在这里是**事实**：integration.mjs 里没有 geolocation，
  // document 也是 undefined；整条链路只用到 RouteSimSource。
  eq(nav.source, sim, 'Navigator 拿到的就是模拟行驶源（一个 GPS fix 都不需要）');

  const changes = [];
  let unwrapped = 0;
  let prev_h = route.tangent_deg(sim.s);
  let s_prev = sim.s;
  let s_first = null;
  let progress_prev = -1;
  let dist_prev = Infinity;
  let monotonic = true;
  let used_in_seconds = 0;
  for (let i = 0; i < 100; i++) {
    const u = nav.cycle(0.1);
    used_in_seconds += 0.1;
    if (u === null) { monotonic = false; break; }
    // s 单调不减 / 进度不减 / 剩余不增 / 航向每一帧都等于航线切线
    if (!(sim.s >= s_prev)) monotonic = false;
    if (!(u.progress_pct >= progress_prev)) monotonic = false;
    if (!(u.dist_dest_m <= dist_prev)) monotonic = false;
    if (Math.abs(NM.shortest_delta(u.heading_deg, route.tangent_deg(sim.s))) > 0.02) monotonic = false;
    if (s_first === null) s_first = sim.s;
    unwrapped += NM.shortest_delta(prev_h, u.heading_deg);
    prev_h = u.heading_deg;
    s_prev = sim.s;
    progress_prev = u.progress_pct;
    dist_prev = u.dist_dest_m;
    changes.push(u.heading_deg);
  }
  const s_last = sim.s;
  const expected_m = 10.0 * used_in_seconds;
  ok(Math.abs((s_last - (M1_S - 40.0)) - expected_m) < 1e-6,
     `10 秒 × 10 m/s 正好走了 ${expected_m.toFixed(0)} m（实得 ${(s_last - (M1_S - 40.0)).toFixed(3)} m，dt 用的是真实流逝时间）`);
  ok(monotonic,
     '每一帧：s 单调不减 / progress_pct 不减 / dist_dest_m 不增 / 航向与切线一致（误差 < 0.01°）');
  ok(unwrapped > M1_DELTA * 0.8,
     `过弯时航向真的转了（累计 ${unwrapped.toFixed(1)}°，转弯点标称 +${M1_DELTA.toFixed(1)}°）`);
  ok(changes.length === 100, `100 个周期每个都算出了一帧 NAV_UPDATE（实得 ${changes.length}）`);
  ok(Math.abs(NM.shortest_delta(changes[0], route.tangent_deg(s_first))) < 0.02 &&
     Math.abs(NM.shortest_delta(changes[99], route.tangent_deg(s_last))) < 0.02,
     `首尾航向分别等于起止点的航线切线（${changes[0].toFixed(1)}° -> ${changes[99].toFixed(1)}°）`);
  eq(sent.filter((k) => k === 'update').length, 100, '100 个周期各下发了一帧 update');

  // --- 4) 帧本身必须是良构的：设备侧解析器能原样解出来 --------------------
  const drain_t0 = Date.now();
  while (link._queue.length > 0 && Date.now() - drain_t0 < 8000) await sleep(20);
  eq(link._queue.length, 0, `发送队列排空（耗时 ${Date.now() - drain_t0}ms）`);
  eq(dev.parser.crc_errors, 0, '设备侧 CRC 零错误');
  eq(dev.frames_of_type(P.MsgType.NAV_UPDATE).length, 100,
     '设备侧恰好收到 100 帧 NAV_UPDATE（一帧不多、一帧不少）');
  const last_parsed = P.NavUpdate.unpack(
    dev.frames_of_type(P.MsgType.NAV_UPDATE)[99].payload);
  eq([last_parsed.heading_cdeg, last_parsed.speed_kmh_x10, last_parsed.progress_pct],
     [nav.last_update.heading_cdeg, nav.last_update.speed_kmh_x10, nav.last_update.progress_pct],
     '解出来的帧与最后一帧 NAV_UPDATE 逐字段相同');
  ok(last_parsed.speed_kmh_x10 === 360,
     `速度栏就是配置的 36 km/h（speed_kmh_x10 = ${last_parsed.speed_kmh_x10}）`);
  ok(Number.isFinite(last_parsed.heading_deg) && Number.isFinite(last_parsed.pos_east_m) &&
     Number.isFinite(last_parsed.pos_north_m) && Number.isFinite(last_parsed.dist_dest_m),
     '帧里没有任何 NaN 字段');
  ok(last_parsed.flags & P.NavFlags.GPS_FIX && last_parsed.flags & P.NavFlags.LINK_UP,
     '模拟行驶的帧照样带 GPS_FIX | LINK_UP（设备不会因为"没有真实定位"而拒画）');

  // --- 5) 到终点：停住，不绕回起点、不产生 NaN ------------------------------
  sim.restart(1.0);                             // 直接放到终点
  const end0 = nav.cycle(0.1);
  eq(sim.s, total, 's 正好停在 total_m 上（不越界）');
  eq(sim.arrived, true, 'arrived = true');
  eq(sim.fix(0)[3], 0, '到终点后速度报 0（车停了，速度栏和 ETA 不会自相矛盾）');
  eq(end0.progress_pct, 100, 'progress_pct = 100');
  eq(end0.dist_dest_m, 0, 'dist_dest_m = 0');
  eq(end0.turn, P.Turn.ARRIVE, 'turn = ARRIVE');
  ok(Number.isFinite(end0.heading_deg) && Number.isFinite(end0.dist_next_m) &&
     Number.isFinite(end0.eta_min),
     `终点这一帧没有 NaN（航向 ${end0.heading_deg}° / 距路口 ${end0.dist_next_m}m）`);

  // 再跑 20 帧：位置一动不动，也**不会**绕回起点重来
  let end_ok = true;
  for (let i = 0; i < 20; i++) {
    const u = nav.cycle(0.1);
    if (u === null) { end_ok = false; break; }
    if (!Number.isFinite(u.heading_deg) || !Number.isFinite(u.speed_kmh) ||
        !Number.isFinite(u.dist_next_m)) end_ok = false;
    if (u.speed_kmh !== 0 || u.dist_dest_m !== 0 || u.progress_pct !== 100) end_ok = false;
  }
  ok(end_ok, '到终点后再跑 20 帧：位置/速度/进度全部保持"停在终点"，没有 NaN');
  eq([sim.s, sim.arrived], [total, true],
     `20 帧之后 s 仍然恰好是 total_m（${sim.s}）—— 刻意不像 PC 版那样 s -= total_m 绕回起点`);
  ok(!(sim.s > total), 's 从不越过终点（不会越界到第二圈）');

  // 终点之后仍然每帧发 NAV_UPDATE：设备不会因为"没有新位置"而黑屏或断流
  const before_frames = nav.frames_sent;
  nav.cycle(0.1);
  eq(nav.frames_sent, before_frames + 1, '停在终点时仍然每帧照发（设备端不黑屏）');

  // --- 6) 真的挂上 10Hz 循环（setInterval）：速度按**真实流逝时间**算 ---------
  // 前面几节都是手工喂 dt，这里验证"驱动它的是现有那条 ~10Hz 循环"这件事，
  // 顺便钉住"不是固定每拍走一步"—— 那样掉帧时速度就会失真。
  const sim3 = new APP.RouteSimSource({});
  sim3.set_route(route);
  sim3.set_speed_kmh(36.0);                     // 10 m/s
  sim3.active = true;
  const nav3 = new APP.Navigator(route, sim3, {
    send: () => true, onLog: () => {}, onUi: () => {},
    config: { rate_hz: 10, no_map: true },
  });
  const t_wall0 = Date.now();
  const s_wall0 = sim3.s;
  nav3.start();
  await sleep(500);
  nav3.stop();
  const wall_s = (Date.now() - t_wall0) / 1000.0;
  const walked = sim3.s - s_wall0;
  ok(walked > 10.0 * wall_s * 0.5 && walked <= 10.0 * wall_s * 1.15,
     `挂上真实 10Hz 循环：${wall_s.toFixed(2)} 秒走了 ${walked.toFixed(2)} m` +
     `（= 10 m/s × 真正跑掉的 ${nav3.frames_sent} 拍；定时器采样粒度 0.1 秒，` +
     `所以这是个量级校验 —— "与帧率无关"由上面那条确定性的用例钉住）`);
  ok(nav3.frames_sent > 0, `循环期间照常发帧（${nav3.frames_sent} 帧）`);
  eq(nav3.running, false, 'stop() 之后循环真的停了');
}

// ---------------------------------------------------------------------------
section('14] NAV_CLOCK：连上就发一次 + 每 30 秒补一次（设备没有电池 RTC）');
// ---------------------------------------------------------------------------
//
// 设备是 ESP32-S3，**没有电池 RTC**：断电就不知道几点了，也不能开 WiFi 走 NTP
// （它跑 BLE 跟手机连，两者抢同一个射频）。所以时间只能走这条链路推过去。
//
// 这一节钉两件事，缺一不可：
//   1. 连上就发一次 —— 否则刚连上的那半分钟里主页显示 --:--；
//   2. 之后每 30 秒补一次 —— 否则设备中途复位（烧录、上电抖动）之后就永久
//      显示 --:--，而手机这边完全看不出来。顺带纠正晶振漂移。
//
// 载荷必须**正好 6 字节**、时区必须是**分钟**（半点时区 +5:30 存在，用小时
// 表达不了），epoch 必须就是当前时间（写成毫秒或者用了单调时钟都不行）。
{
  const dev = new FakeDevice();
  const { link } = await make_link(dev);
  await link.connect();
  const route = demo_route();

  // 记录"第几秒发了什么"。**按发送时刻记账，不按累计帧数记账** ——
  // 累计帧数会被"这个 Navigator 之前已经跑过多少轮"影响（自测里好几个
  // 用例共用一个 Navigator 实例），而"周期是 30 秒"这件事只有时间能证明。
  const sent_log = [];
  let sim_t = 0.0;
  const nav = new APP.Navigator(route, new ScriptSource(fixes_along(route, 500, 12.0)), {
    send: (f, k, p) => {
      // 帧头第 4 个字节就是 type（A5 5A ver type ...）
      sent_log.push({ t: sim_t, type: f[3] });
      return link.send(f, k, p);
    },
    onLog: () => {}, onUi: () => {},
    config: { rate_hz: 10, no_map: true },
  });
  nav.set_ble(link);

  const t_before = Math.floor(Date.now() / 1000);
  // 110 秒模拟时间，10Hz。跨过 30/60/90 三个阈值。
  for (let i = 0; i < 1100; i++) {
    sim_t += 0.1;
    nav.cycle(0.1);
  }
  const t_after = Math.floor(Date.now() / 1000);

  const drain_t0 = Date.now();
  while (link._queue.length > 0 && Date.now() - drain_t0 < 8000) await sleep(10);

  const clock_log = sent_log.filter((e) => e.type === P.MsgType.NAV_CLOCK);
  const clocks = dev.frames_of_type(P.MsgType.NAV_CLOCK);

  // 110 秒 / 30 秒 = 首帧 + 3 次补发 = 4 帧（第 1、31、61、91 秒）
  eq(clock_log.length, 4,
     `110 秒里发了 4 帧 NAV_CLOCK（首帧 + 每 30 秒一次），实测 ${clock_log.length} 帧`);
  ok(clock_log.length > 0 && clock_log[0].t <= 0.11,
     `第一帧就在第一个周期（t=${clock_log.length ? clock_log[0].t.toFixed(2) : '-'}s）` +
     '——只挂 30 秒定时器的话，设备刚连上那半分钟只能显示 --:--');
  ok(clock_log.every((e, i) => i === 0 || e.t - clock_log[i - 1].t >= 29.9),
     '任意两帧之间至少隔 29.9 秒（不是每帧都发）');
  ok(clock_log.every((e, i) => i === 0 || e.t - clock_log[i - 1].t <= 30.3),
     '任意两帧之间不超过 30.3 秒（补发没有迟到 —— 设备中途复位最多挂 30 秒）');

  const ck = P.NavClock.unpack(clocks[0].payload);
  eq(clocks[0].payload.length, P.NAV_CLOCK_LEN,
     `NAV_CLOCK 载荷正好 ${P.NAV_CLOCK_LEN} 字节（u32 epoch + i16 时区分钟）`);
  eq(P.NAV_CLOCK_LEN, 6, 'NAV_CLOCK_LEN = 6');
  ok(ck.epoch_s >= t_before - 2 && ck.epoch_s <= t_after + 2,
     `epoch 就是当前时间（${ck.epoch_s}，本机 ${t_before}..${t_after}）` +
     '——写成毫秒或用单调时钟都会落到这个区间之外');
  eq(ck.tz_offset_min, -new Date().getTimezoneOffset(),
     `时区偏移 = -getTimezoneOffset()（本机 ${-new Date().getTimezoneOffset()} 分钟）` +
     '——符号写反会让设备上的钟差一整个时区');
  ok(Math.abs(ck.tz_offset_min) <= 14 * 60,
     `时区偏移落在真实范围内（${ck.tz_offset_min} 分钟）`);

  // 时钟帧不能顶替导航帧：它只是"对表"，不是"数据"。
  //
  // ⚠️ 这里**不能**要求"1100 帧一帧不少"，但那不是因为"有损队列天生丢帧说不清"，
  //    而是因为丢帧是**按设计、可归因**的：ble.js 的发送队列只有 QUEUE_MAX = 256
  //    格，这 1100 帧是**同步**产生的（10Hz × 110 秒），而排空是异步的
  //    （每帧 `await _yield()`），队列必然长期是满的；队满时丢的是 update
  //    （下一帧 100ms 后就到，丢一帧只是箭头少动一格）。
  //
  //    上一版这里被弱化成 `upd_rx > 0`（"照常到达"），那等于什么都没验
  //    —— 丢 1099 帧它也会通过。正确的写法是把**真实不变量**写出来：
  //
  //        设备侧收到的 update 数 === 手机侧产出的 update 数 - link 记账丢掉的 update 数
  //
  //    这条式子同时钉住了三件事：丢帧只可能来自被记账的那几条路径、每一条
  //    丢帧路径都真的进了计数器（没有静默丢帧）、手机侧写的字节都被设备侧
  //    解出来了（CRC/长度没坏）。实现里 frames_offered === frames_sent +
  //    frames_dropped 是同一笔账的另一种写法，两条都验。
  const upd_rx = dev.frames_of_type(P.MsgType.NAV_UPDATE).length;
  const upd_tx = sent_log.filter((e) => e.type === P.MsgType.NAV_UPDATE).length;
  const upd_dropped = link.dropped_by_kind.update || 0;
  eq(upd_tx, 1100, `110 秒 × 10Hz 产出了 ${upd_tx} 帧 NAV_UPDATE`);
  eq(upd_rx, upd_tx - upd_dropped,
     `设备侧收到 ${upd_rx} 帧 NAV_UPDATE = 产出 ${upd_tx} - 记账丢掉的 ${upd_dropped} ` +
     `（丢帧只可能来自记账过的路径，没有静默丢帧）`);
  ok(upd_dropped > 0 && upd_dropped < upd_tx,
     `这一节确实压满了队列（丢掉 ${upd_dropped} 帧 update = 队满拒收/腾位置），` +
     `但每一帧都在账上`);
  eq(link.frames_offered, link.frames_sent + link.frames_dropped,
     `发/丢记账平了：offered ${link.frames_offered} = sent ${link.frames_sent} + dropped ${link.frames_dropped}`);
  eq(link.dropped_refused + link.dropped_evicted + link.dropped_write_failed +
     link.dropped_disconnected, link.frames_dropped, 'frames_dropped = 四个原因桶之和');
  eq(clocks.length, clock_log.length,
     `4 帧 NAV_CLOCK 全部到达设备侧（发 ${clock_log.length} / 收 ${clocks.length}）`);
  eq(dev.parser.crc_errors, 0, 'NAV_CLOCK 也是合法帧（CRC 零错误）');
  nav.stop();
}

// ---------------------------------------------------------------------------
section('15] 重锚：底图必须**同一轮**按新原点重建（不联网、也不擦屏）');
// ---------------------------------------------------------------------------
//
// 这一节钉的是现场反馈的"底图有时候会掉"：
//
//   底图的点和路线窗口**同源** —— 都是相对"发这一窗时骑手的位置"（原点）的米。
//   路线每走 5km 重锚一次（原点跟着骑手往前挪），而设备每一帧都在拿
//   NAV_UPDATE.pos_east_m/pos_north_m 去减底图的点。原点挪了、底图却没重建，
//   整张图就偏掉 5km：屏幕外，看着就是"底图掉了"—— 而它自己好起来要等
//   **下一次成功的底图下发**，最坏是整整一轮 120 秒的刷新预算（实测一次
//   Overpass 查询就要 17.6 秒）。
//
// 所以重锚那一轮必须：拿**已经在内存里的**路网按新原点重投影、重发一帧，
// 而且**一个网络请求都不发**（路网一个字节都没变，变的只有投影原点）。
//
// 另一条同样重要：覆盖不到新原点时**不许发空帧**。设备对 seg_count == 0 的
// 处理是"把所有路网线藏起来"（src/ui/ui_puck.cpp 的 renderMap()）—— 那等于
// 把上一份还能用的路网擦成白屏，比"暂时没有新路网"糟糕得多。
{
  // 60km 的合成路线（每 500m 一个直角弯）：演示航线只有 10km，走不出第二次
  // 重锚，而这一节要的正是"重锚之后再重锚"。
  const synth_route = (n_seg) => {
    const pts = [];
    let lat = 30.2500;
    let lon = 120.1300;
    for (let i = 0; i < n_seg; i++) {
      pts.push([lat, lon, `长路段${i}`]);
      lat += 400.0 / RT.EARTH_M_PER_DEG_LAT;             // 正北 400m
      pts.push([lat, lon, `长路段${i}`]);
      lon += 300.0 / (RT.EARTH_M_PER_DEG_LON_EQ * Math.cos(lat * Math.PI / 180));
    }
    pts.push([lat, lon, '终点']);
    return new RT.Route(pts, false);
  };
  const route = synth_route(120);
  ok(route.total_m > 40000, `合成路线 ${(route.total_m / 1000).toFixed(1)} km（够走出好几次重锚）`);
  const [la0, lo0] = route.point_at(0);

  // 假 Overpass：只返回**请求点附近**的路（真实行为就是 around:260），
  // 并数请求次数 —— "重锚那一轮不联网"这条断言全靠它。
  let overpass_calls = 0;
  const mk_ways = (lat0, lon0) => {
    const els = [];
    for (let i = 0; i < 30; i++) {
      const geom = [];
      for (let k = 0; k < 6; k++) {
        geom.push({ lat: lat0 + (i - 15) * 0.0004 + k * 0.00005,
                    lon: lon0 + (k - 3) * 0.00009 });
      }
      els.push({ tags: { highway: 'residential' }, geometry: geom });
    }
    return { elements: els };
  };
  const fakeFetch = async (_ep, opts) => {
    overpass_calls += 1;
    const body = decodeURIComponent(String(opts && opts.body));
    const m = /around:(\d+),([-\d.]+),([-\d.]+)/.exec(body);
    return { ok: true, json: async () => mk_ways(Number(m[2]), Number(m[3])) };
  };

  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v); },
    removeItem: (k) => { store.delete(k); },
  };
  const mapSrc = new MAP.OsmMapSource({
    fetch: fakeFetch, storage, max_points: 330, max_segs: 60,
  });

  // 位置源：s 想拨到哪就拨到哪（模拟"骑手已经跑到 5km 外了"）。
  // 接口与 GeoSource 同形，Navigator 只认这几个字段。
  const sim = {
    s: 0.0,
    heading_source: 'gps',
    has_fix() { return true; },
    fix() {
      const [a, b] = route.point_at(this.s);
      return [a, b, route.tangent_deg(this.s), 12.0];
    },
  };

  const logs = [];
  const sent = [];
  const nav = new APP.Navigator(route, sim, {
    send: (f, k, p) => { sent.push({ f, k, p }); return true; },
    onLog: (l) => logs.push(l),
    onUi: () => {},
    mapSource: mapSrc,
    config: { rate_hz: 10, no_map: false },
  });
  const map_frames = () => sent.filter((x) => x.k === 'map');
  /** 把最后一帧 NAV_MAP 解出来（走真正的解析器，不自己切字节）。 */
  const last_map = () => {
    const f = map_frames()[map_frames().length - 1].f;
    const parser = new P.FrameParser();
    const out = parser.feed(f);
    return P.NavMap.unpack(out[0].payload);
  };

  // 沿路线一段一段往前走，每段停几拍：让后台抓取真的成功几次（缓存里因此
  // 有沿途的几份路网）。这就是现实里"骑了 5km 之后手上有的数据"。
  //
  // ⚠️ 每段只走 500m 以内、最后一小步只走 260m：`s` 是"路线上最近的那个点"，
  //    会有一两个点距（25m）的零头，走太猛可能提前越过重锚线（那样"下面那一轮
  //    是第一次重锚"这个前提就没了，这一节的断言全指着它）；而最后一步也不能
  //    太大 —— 抓取是每 ~80m 触发一次的，跳太远手上那份路网就真的覆盖不到
  //    新原点了（那是另一条分支，由下面第二段覆盖）。
  for (const target of [0, 1000, 2000, 3000, 4000, 4500, 4800, 4950]) {
    sim.s = target;
    for (let i = 0; i < 4; i++) { nav.cycle(0.1); await sleep(1); }
  }
  eq(nav.reanchors, 1, '这一路只重锚过 1 次（出发时定原点那次）');
  ok(mapSrc.ways.length > 0, `手上已经有路网数据（${mapSrc.ways.length} 条路）`);
  const frames_before = map_frames().length;
  ok(frames_before >= 1, `重锚之前底图已经在画（已发 ${frames_before} 帧 NAV_MAP）`);

  // ---- 跨过 5km 重锚线：这一轮必须重建 + 重发，而且不联网 ----
  const old_origin = [nav.origin_lat, nav.origin_lon];
  const calls_before = overpass_calls;
  const before_re = map_frames().length;
  sim.s = 5060;                       // |s - 原点弧长| > REANCHOR_MOVE_M(5000)
  nav.cycle(0.1);
  eq(nav.reanchors, 2, '跨过 5km 后真的重锚了（原点挪到骑手当前位置）');
  eq(overpass_calls, calls_before,
     '重锚那一轮**一个 Overpass 请求都没发**（纯重投影，不是重新抓取）');
  const grew = map_frames().length - before_re;
  ok(grew >= 1, `重锚那一轮**同一轮**就重发了底图（+${grew} 帧 NAV_MAP），` +
     '不用等下一次抓取成功（最坏 120 秒）');

  // 重发的那一帧必须与**新原点**一致：拿同一份路网按新原点重投影一遍逐点比。
  // 这是"底图不再偏 5km"的直接证明 —— 不是"发了就算".
  {
    const [rlat, rlon] = route.point_at(5060);
    const expect = mapSrc.build(nav.origin_lat, nav.origin_lon, rlat, rlon, RT.ROUTE_FAR_M);
    const got = last_map();
    eq(got.seg_count, expect.seg_count,
       `重发的底图段数 = 按新原点重投影的段数（${expect.seg_count}）`);
    eq(got.pts, expect.pts, '重发的底图坐标与"按新原点重投影" **逐点相同**');
    ok(expect.seg_count > 0, '重投影确实画出了东西（不是空图）');
    // 反面：用**旧原点**投影出来的那一份必须与它不同，否则上面那条什么都没证明
    const stale = mapSrc.build(old_origin[0], old_origin[1], rlat, rlon, RT.ROUTE_FAR_M);
    ok(JSON.stringify(got.pts) !== JSON.stringify(stale.pts),
       '这一份确实换了原点（和旧原点那份不同）—— 旧那份正是会掉到屏幕外的那份');
  }
  ok(nav.last_map_segs > 0,
     `重发之后界面读的"多少段"跟着更新（${nav.last_map_segs} 段，非零）`);

  // ---- 覆盖不到新原点时：不许发空帧把设备上那张擦掉 ----
  //
  // 现实中就是"Overpass 挂了/被限流，手上只剩很早以前那一带的路"。设备对
  // seg_count == 0 的处理是把整片路网藏起来，所以发空帧 = 白屏。
  mapSrc.ways = MAP.OsmMapSource._parse_ways(mk_ways(la0 + 1.0, lo0 + 1.0));  // 100km 外
  mapSrc.anchor = [la0 + 1.0, lo0 + 1.0];
  const before_gap = map_frames().length;
  const updates_before = nav.frames_sent;
  const segs_gap = nav.last_map_segs;
  sim.s = 10100;                      // 再走 5km -> 第二次重锚
  nav.cycle(0.1);
  eq(nav.reanchors, 3, '第二次跨过 5km 又重锚了');
  eq(map_frames().length, before_gap,
     '手上的路网覆盖不到新原点时**不发任何底图帧**（尤其不发空帧把屏幕擦白）');
  eq(nav.last_map_segs, segs_gap,
     '界面读的"多少段"保持上一次真发出去的值（不被这次空重投影改成 0）');
  eq(nav.frames_sent, updates_before + 1,
     '底图没得发也照样发 NAV_UPDATE（底图是装饰，导航是本职）');
  ok(logs.some((l) => /重锚/.test(l) && /不发空底图/.test(l)),
     `日志里说清楚了为什么没重发：${logs.filter((l) => /重锚/.test(l)).slice(-1)[0] || '（没有）'}`);

  // ---- 刷新"合法地"返回 0 条道路：手里那份路网绝不能被清掉 ----
  const keepSrc = new MAP.OsmMapSource({
    storage: null,
    endpoints: ['https://x/'],
    fetch: async () => ({ ok: true, json: async () => ({ elements: [] }) }),
  });
  keepSrc.ways = MAP.OsmMapSource._parse_ways(mk_ways(la0, lo0));
  keepSrc.anchor = [la0, lo0];
  const kept = keepSrc.ways.length;
  await keepSrc.refresh(la0, lo0, 1000);
  eq(keepSrc.ways.length, kept,
     `Overpass 返回 0 条可用道路时，手里那 ${kept} 条路网**不被清掉**`);
  eq(keepSrc.state, 'stale', '状态是"缓存已旧"（还能继续画），不是"不可用/空"');
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
