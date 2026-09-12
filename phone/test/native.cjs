/*
 * 原生 BLE 传输适配器自测（ble_native.js + ble.js 的 transport 接缝）。
 *
 * 用法（在 navpuck 根目录）：
 *     node phone/test/native.cjs
 *
 * ⚠️ 扩展名是 .cjs 不是 .mjs：本文件用 require() 加载 phone/ 那几个经典脚本
 *    （它们本来就是 CommonJS/UMD），而 Node 24 对"同时有 require 和顶层 await"
 *    的 .mjs 会直接报 ERR_AMBIGUOUS_MODULE_SYNTAX。下面所有 await 都包在
 *    async IIFE 里，所以 .cjs 是对的。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 为什么要有这一套
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * APK 那条路（原生插件）在这台机器上**没有真机可测**。那至少要把"能在 Node 里
 * 证明的部分"全部钉住：
 *
 *   1. 原生环境探测：只有在 Capacitor 桥 + 插件都在时才算"可用"。
 *      （关键反例：WebView 里 navigator.bluetooth 存在但不可用，所以判断
 *        **不能**看它。）
 *   2. 分片：分片大小必须 = 协商到的 MTU - 3，而不是 Web Bluetooth 那套
 *      "先试 512"。这是原生路线相对 PWA 的**主要收益**（1.4KB 底图 0.3s vs 3s），
 *      也是最容易在重构里被悄悄改回 512 的地方。
 *   3. 上行字节喂的是**同一个** FrameParser：原生通知和 Web Bluetooth 通知
 *      走同一条 _on_notify_bytes，所以"帧怎么切"只有一份实现。
 *   4. 写失败要整帧降档重试（不能续传），且降档后 transport 也跟着用小分片。
 *   5. 没写出去的字节不会丢：整帧发给设备后，用**同一套 proto** 能解回来。
 *
 * 这些都不需要 Android：Capacitor 桥和插件在测试里是一个纯 JS 的假对象。
 */

'use strict';

const path = require('node:path');

const PHONE_DIR = path.resolve(process.argv[2] || path.join(process.cwd(), 'phone'));

const proto = require(path.join(PHONE_DIR, 'proto.js'));
const NATIVE = require(path.join(PHONE_DIR, 'ble_native.js'));

// ble.js 是给浏览器写的经典脚本（UMD）。它 require('./proto.js')，所以在 Node
// 里直接 require 就行；但它内部读 globalThis.navigator 作为默认值 —— Node 的
// navigator 没有 bluetooth，正好用来验证"没有原生时退回 Web 路径"。
const BLE = require(path.join(PHONE_DIR, 'ble.js'));

// ---------------------------------------------------------------------------
// 测试框架（与其它几套自测同一风格，便于输出对齐）
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
  else {
    failures.push(`${group} :: ${l}\n      期望 ${y}\n      实得 ${x}`);
    console.log(`  ✗ ${l}\n      期望 ${y}\n      实得 ${x}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// ---------------------------------------------------------------------------
// 假 Capacitor 桥 + 假 BluetoothLe 插件
// ---------------------------------------------------------------------------
/**
 * 插件桩。它把"手机写出去的字节"按调用顺序记下来，并能把上行字节推回页面。
 *
 * 行为刻意做得和真插件一致的地方：
 *   - requestDevice 返回 {deviceId, name}
 *   - writeWithoutResponse / write 都要 {deviceId, service, characteristic, value}
 *   - getMtu 返回 {value}
 *   - addListener('onNotification', cb) 推 {value: DataView}
 *   - disconnect 时推 onDisconnected 回调
 */
class FakePlugin {
  constructor(opts) {
    const o = opts || {};
    this.mtu = o.mtu === undefined ? 247 : o.mtu;
    this.mtu_throws = !!o.mtu_throws;
    this.name = o.name || 'NavPuck-A1B2';
    this.no_device = !!o.no_device;
    this.deny_permissions = !!o.deny_permissions;
    this.fail_writes_above = o.fail_writes_above === undefined ? Infinity : o.fail_writes_above;

    this.calls = [];              // 方法调用流水（含参数）
    this.writes = [];             // 每次写出去的字节（按序拼接就是设备看到的流）
    this.write_sizes = [];        // 每个分片的长度
    this.notify_cb = null;        // 上行通知回调
    this.disc_cb = null;          // 断开回调
    this.notifications_started = false;
    this.connected = false;
    this.initialize_args = null;
  }

  _rec(method, args) { this.calls.push({ method, args: args || null }); }

  async initialize(args) { this._rec('initialize', args); this.initialize_args = args; }

  async checkPermissions() {
    this._rec('checkPermissions');
    return this.deny_permissions
      ? { scan: 'denied', connect: 'denied', location: 'denied' }
      : { scan: 'granted', connect: 'granted', location: 'granted' };
  }

  async requestPermissions() { this._rec('requestPermissions'); return this.checkPermissions(); }

  async requestDevice(args) {
    this._rec('requestDevice', args);
    if (this.no_device) return null;
    return { deviceId: 'AA:BB:CC:DD:EE:FF', name: this.name };
  }

  async addListener(event, cb) {
    this._rec('addListener', event);
    if (event === 'onDisconnected') this.disc_cb = cb;
    else this.notify_cb = cb;
    return { remove: async () => { this._rec('removeListener', event); } };
  }

  async connect(args) {
    this._rec('connect', args);
    this.connected = true;
  }

  async requestMtu(args) {
    this._rec('requestMtu', args);
    if (this.mtu_throws) throw new Error('设备拒绝 MTU 协商');
  }

  async getMtu(args) {
    this._rec('getMtu', args);
    if (this.mtu_throws) throw new Error('拿不到 MTU');
    return { value: this.mtu };
  }

  async discoverServices(args) { this._rec('discoverServices', args); }

  async startNotifications(args) {
    this._rec('startNotifications', args);
    this.notifications_started = true;
  }

  async writeWithoutResponse(args) {
    this._rec('writeWithoutResponse', args);
    this._accept_write(args);
  }

  async write(args) { this._rec('write', args); this._accept_write(args); }

  _accept_write(args) {
    const u8 = new Uint8Array(args.value.buffer, args.value.byteOffset, args.value.byteLength);
    if (u8.length > this.fail_writes_above) {
      throw new Error(`单次写 ${u8.length} 字节被设备拒绝`);
    }
    this.write_sizes.push(u8.length);
    for (const b of u8) this.writes.push(b);
  }

  /** 把一段上行字节推给页面（等价于设备的 TX 通知）。 */
  emit(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (!this.notify_cb) throw new Error('测试自己写错了：还没订阅通知');
    this.notify_cb({ value: new DataView(u8.buffer, u8.byteOffset, u8.byteLength) });
  }

  /** 设备侧主动断开。 */
  emit_disconnect() { if (this.disc_cb) this.disc_cb({ deviceId: 'AA:BB:CC:DD:EE:FF', name: this.name }); }

  async disconnect() { this._rec('disconnect'); this.connected = false; }

  methods() { return this.calls.map((c) => c.method); }
}

/** 造一个"在 Capacitor 里"的假 window。 */
function fake_window(plugin) {
  const win = {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: { BluetoothLe: plugin },
    },
  };
  return win;
}

// ---------------------------------------------------------------------------
// 全部用例包在一个 async IIFE 里：本文件是 CommonJS，不能有顶层 await
// ---------------------------------------------------------------------------
(async function main() {

// ---------------------------------------------------------------------------
// 1] 环境探测
// ---------------------------------------------------------------------------
section('1] 环境探测：什么时候算"有原生 BLE"');
{
  const plugin = new FakePlugin();
  const win = fake_window(plugin);
  ok(NATIVE.available(win), '有 Capacitor 桥 + BluetoothLe 插件 => 可用');

  // 关键反例：只有 navigator.bluetooth（PWA / 甚至 Android WebView 里也可能是 true）
  const pwa = { navigator: { bluetooth: { requestDevice: () => {} } } };
  eq(NATIVE.available(pwa), false,
     '只有 navigator.bluetooth、没有 Capacitor 桥 => **不**算原生可用');

  // 老版本 Capacitor 用 isNative 布尔
  const legacy = { Capacitor: { isNative: true, Plugins: { BluetoothLe: plugin } } };
  ok(NATIVE.available(legacy), '老版本 Capacitor（isNative 布尔）也认');

  // 是原生，但没装插件
  const no_plugin = { Capacitor: { isNativePlatform: () => true, Plugins: {} } };
  eq(NATIVE.available(no_plugin), false, '在壳里但没有 BluetoothLe 插件 => 不可用');

  // BleLink 上的入口
  eq(BLE.BleLink.native_available(pwa), false, 'BleLink.native_available：PWA 里 false');
  eq(BLE.BleLink.make_transport({ root: pwa }), null, 'BleLink.make_transport：PWA 里返回 null（走 Web 路径）');
  // ⚠️ 这里的 navigator 必须**真的是** navigator 的形状：supported() 查的是
  //    navigator.bluetooth.requestDevice 是不是函数（见 ble.js）。
  //    空对象 {} 会被正确判成"不支持"，所以桩不能用 {}。
  const web_nav = { bluetooth: { requestDevice: async () => ({}) } };
  eq(BLE.BleLink.usable(web_nav, pwa), true, 'BleLink.usable：有 Web Bluetooth 也算可用');
  eq(BLE.BleLink.usable({}, pwa), false, 'BleLink.usable：两条都没有 => 不可用');
  eq(BLE.BleLink.usable(web_nav, fake_window(new FakePlugin())), true,
     'BleLink.usable：原生和 Web 都在 => 也可用（实际会优先走原生）');
}

// ---------------------------------------------------------------------------
// 2] 连接顺序 + MTU 决定分片
// ---------------------------------------------------------------------------
section('2] 连接流程与 MTU：分片必须 = MTU-3，而不是 Web Bluetooth 那套试 512');
{
  const plugin = new FakePlugin({ mtu: 247 });
  const win = fake_window(plugin);
  const t = new NATIVE.NativeTransport({ window: win, onLog: () => {} });
  await t.connect();

  ok(t.connected, '连接后 connected = true');
  eq(t.device_name, 'NavPuck-A1B2', '设备名从插件读出来');
  eq(t.transport_mtu, 247, 'MTU 读到了 247');
  eq(t.chunk_size_hint, 244, '分片大小 = MTU - 3 = 244（不是 512）');
  ok(plugin.notifications_started, 'TX 通知已订阅');

  // 调用顺序：initialize 必须最先，startNotifications 最后
  const m = plugin.methods();
  eq(m[0], 'initialize', '第一步是 initialize（插件要求）');
  ok(m.indexOf('connect') < m.indexOf('discoverServices'),
     '先 connect 再 discoverServices');
  ok(m.indexOf('discoverServices') < m.indexOf('startNotifications'),
     '先 discoverServices 再 startNotifications');
  eq(m[m.length - 1], 'startNotifications', '最后一步是 startNotifications');

  // 按服务 UUID 扫，不按名字（名字分包发，见 docs/ble.md）
  const rd = plugin.calls.find((c) => c.method === 'requestDevice');
  eq(rd.args.services, [NUS_SERVICE], 'requestDevice 按 NUS 服务过滤');

  // 订阅通知用的是 TX 特征，写用的是 RX 特征
  const sn = plugin.calls.find((c) => c.method === 'startNotifications');
  eq(sn.args.characteristic, NUS_TX, 'startNotifications 订的是 TX（设备->手机）');
}

// ---------------------------------------------------------------------------
// 3] 分片写：1.4KB 底图在 MTU 247 下应该是 6 片而不是 78 片
// ---------------------------------------------------------------------------
section('3] 分片写：按 MTU 分片，字节序与设备看到的完全一致');
{
  const plugin = new FakePlugin({ mtu: 247 });
  const t = new NATIVE.NativeTransport({ window: fake_window(plugin), onLog: () => {} });
  await t.connect();

  // 造一个 1400 字节的载荷（真实 NAV_MAP 的量级）
  const payload = new Uint8Array(1400);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  await t.write_frame(payload);

  eq(plugin.write_sizes, [244, 244, 244, 244, 244, 180],
     '1400 字节 = 5×244 + 180（6 个写操作）');
  eq(plugin.writes.length, 1400, '写出去的字节总数 = 帧长度（不多不少）');
  let same = true;
  for (let i = 0; i < payload.length; i++) if (plugin.writes[i] !== payload[i]) same = false;
  ok(same, '拼起来的字节流与原始帧逐字节相同（顺序/边界都没错）');

  // Web Bluetooth 那套会是多少片？把这个对比写进输出里，作为"原生值不值得"的证据
  const pwa_slices = Math.ceil(1400 / 512);
  console.log(`      （参考：PWA 先试 512 是 ${pwa_slices} 片；退到 20 则是 ${Math.ceil(1400 / 20)} 片）`);

  const w = plugin.calls.find((c) => c.method === 'writeWithoutResponse');
  eq(w.args.characteristic, NUS_RX, '写到 RX（手机->设备）');
  eq(w.args.service, NUS_SERVICE, '写用的服务是 NUS');
  ok(plugin.calls.every((c) => c.method !== 'write'),
     '优先用 writeWithoutResponse（with-response 每片都要等 ATT 确认，会慢好几倍）');
}

// ---------------------------------------------------------------------------
// 4] MTU 拿不到时的退路
// ---------------------------------------------------------------------------
section('4] MTU 协商失败：不能因此连不上，要退到试探分片');
{
  const plugin = new FakePlugin({ mtu_throws: true });
  const t = new NATIVE.NativeTransport({ window: fake_window(plugin), onLog: () => {} });
  await t.connect();
  ok(t.connected, 'MTU 拿不到也照样连上（正确性不依赖 MTU）');
  eq(t.transport_mtu, null, 'MTU 记为 null');
  eq(t.chunk_size_hint, 512, '分片维持乐观值 512，交给 ble.js 的降档逻辑兜底');
}

// ---------------------------------------------------------------------------
// 5] 上行：原生通知喂给同一个 FrameParser
// ---------------------------------------------------------------------------
section('5] 上行：原生通知与 Web Bluetooth 走同一个 FrameParser');
{
  const plugin = new FakePlugin();
  const win = fake_window(plugin);
  const t = new NATIVE.NativeTransport({ window: win, onLog: () => {} });

  const seen = [];
  const states = [];
  const link = new BLE.BleLink({
    transport: t,
    onFrame: (f) => seen.push(f),
    onState: (s) => states.push(s),
    onLog: () => {},
  });

  await link.connect();
  eq(states, ['connecting', 'up'], '状态迁移 connecting -> up（与 Web 路径一致）');
  ok(link.connected, 'link.connected 走的是 transport 的状态');

  // 设备发一个 PUCK_STATUS，应该被解析出来并触发 onStatus
  let status = null;
  link.onStatus = (st) => { status = st; };
  plugin.emit(proto.encode_puck_status(new proto.PuckStatus({
    vbat_mv: 3900, battery_pct: 72, flags: proto.NavFlags.LINK_UP,
  })));

  eq(seen.length, 1, '收到 1 帧');
  eq(seen[0].type, proto.MsgType.PUCK_STATUS, '帧类型是 PUCK_STATUS');
  ok(status !== null, 'onStatus 被调用');
  eq(status.battery_pct, 72, '电量解析正确（72%）');
  eq(link.device_battery_pct, 72, 'link.device_battery_pct 也能读到');
  ok(link.device_link_up, 'device_link_up 从 flags 里读出来');

  // 关键：上行**字节流**被切成帧的能力只有一份实现。发两个帧粘在一起，
  // 必须解出两帧 —— 这正是 Web Bluetooth 路径被 golden vector 覆盖的行为。
  seen.length = 0;
  const a = proto.encode_ping();
  const b = proto.encode_pong();
  const glued = new Uint8Array(a.length + b.length);
  glued.set(a, 0); glued.set(b, a.length);
  plugin.emit(glued);
  eq(seen.length, 2, '两个帧粘在一个通知里也能解出 2 帧（流式重组器只有一份）');
}

// ---------------------------------------------------------------------------
// 6] 写失败：整帧降档重试，且 transport 跟着用小分片
// ---------------------------------------------------------------------------
section('6] 写失败：整帧作废 + 降档重试（与 Web 路径同一策略）');
{
  // 设备单次最多接受 64 字节 —— 244 的分片会被拒
  const plugin = new FakePlugin({ mtu: 247, fail_writes_above: 64 });
  const t = new NATIVE.NativeTransport({ window: fake_window(plugin), onLog: () => {} });
  const logs = [];
  t.log = (l) => logs.push(l);
  const link = new BLE.BleLink({ transport: t, onLog: (l) => logs.push(l), onFrame: () => {} });
  await link.connect();

  eq(link.chunk_size, 244, '起步用 MTU-3 = 244');

  const payload = new Uint8Array(300);
  // 直接用内部写路径：send() 要排队 + 异步 drain，这里要看的是降档过程本身
  const okwrite = await link._write_frame(payload);
  ok(okwrite, '最终写成功（降档后）');
  ok(link.chunk_size < 244, `降过档：现在分片 ${link.chunk_size} 字节`);
  eq(t.chunk_size_hint, link.chunk_size, 'transport 的分片大小跟着降（否则下一帧还会用大分片）');
  ok(link.downgrades >= 1, `记录了降档次数（${link.downgrades}）`);
  ok(link.write_failures >= 1, `记录了写失败次数（${link.write_failures}）`);
  ok(logs.some((l) => /整帧重启/.test(l)), '日志里写明了"整帧重启"（不是续传）');
}

// ---------------------------------------------------------------------------
// 7] 断开：外部断开要触发重连，手动断开不要
// ---------------------------------------------------------------------------
section('7] 断开：设备侧掉线要能自动重连，用户手动断开不能偷偷重连');
{
  const plugin = new FakePlugin();
  const t = new NATIVE.NativeTransport({ window: fake_window(plugin), onLog: () => {} });
  const states = [];
  const link = new BLE.BleLink({ transport: t, onLog: () => {}, onState: (s) => states.push(s) });
  await link.connect();
  states.length = 0;

  plugin.emit_disconnect();
  eq(states, ['down'], '设备侧断开 => 状态变 down');
  ok(link._reconnect_timer !== null, '排了一次自动重连（骑车时链路抖一下不该要用户去点）');
  if (link._reconnect_timer !== null) clearTimeout(link._reconnect_timer);
  link._reconnect_timer = null;

  // 手动断开之后不能再自动重连
  await link.disconnect();
  eq(link._manual_close, true, '手动断开置了 _manual_close');
  plugin.emit_disconnect();
  ok(link._reconnect_timer === null, '手动断开后不再安排重连');
}

// ---------------------------------------------------------------------------
// 8] 没有设备 / 权限被拒时的错误信息要能指路
// ---------------------------------------------------------------------------
section('8] 失败路径：错误信息要能指到真正的原因');
{
  const plugin = new FakePlugin({ no_device: true });
  const t = new NATIVE.NativeTransport({ window: fake_window(plugin), onLog: () => {} });
  let err = null;
  try { await t.connect(); } catch (e) { err = e; }
  ok(err !== null, '扫不到设备时抛错');
  ok(err && /没有扫描到 NavPuck/.test(err.message), '错误信息点明"没扫到 NavPuck"');

  const plugin2 = new FakePlugin({ deny_permissions: true });
  const t2 = new NATIVE.NativeTransport({ window: fake_window(plugin2), onLog: () => {} });
  let err2 = null;
  try { await t2.connect(); } catch (e) { err2 = e; }
  ok(err2 !== null, '权限被拒时抛错');
  ok(err2 && /权限被拒绝/.test(err2.message), '错误信息点明"权限被拒绝"');
  ok(err2 && /设置/.test(err2.message), '并且告诉用户去哪里开权限');
}

// ---------------------------------------------------------------------------
// 9] base64 回退：插件在某些版本/平台上用 base64 传字节
// ---------------------------------------------------------------------------
section('9] 字节序列化：DataView 和 base64 两种都要能吃');
{
  const payload = Uint8Array.from([0x00, 0xff, 0x41, 0x42, 0x80, 0x7f]);
  const dv = new DataView(payload.buffer);
  eq([...NATIVE._data_view_to_u8(dv)], [...payload], 'DataView -> Uint8Array');

  // 手工算的 base64：AP9BQoB/ （6 字节）
  const b64 = 'AP9BQoB/';
  eq([...NATIVE._base64_to_u8(b64)], [...payload], 'base64 -> Uint8Array（不依赖 atob，Node 里也能跑）');
  eq(NATIVE._base64_to_u8('').length, 0, '空字符串 -> 长度 0（不抛错）');
}

// ---------------------------------------------------------------------------
// 10] fgs.js：前台服务封装在 PWA 里必须完全无声
// ---------------------------------------------------------------------------
section('10] 前台服务封装：PWA 里一个异常都不能抛');
{
  const FGS = require(path.join(PHONE_DIR, 'fgs.js'));
  const pwa = { navigator: {} };
  eq(FGS.available(pwa), false, 'PWA 里 available = false');

  const fgs = new FGS.ForegroundService({ window: pwa });
  eq(fgs.available, false, '实例上 available 也是 false');
  eq((await fgs.start()).available, false, 'start() 返回 {available:false}，不抛错');
  eq((await fgs.stop()).available, false, 'stop() 同样');
  eq((await fgs.state()).available, false, 'state() 同样');
  eq((await fgs.probe_start()).available, false, 'probe_start() 同样');
  eq((await fgs.probe_stop()).available, false, 'probe_stop() 同样');
  eq((await fgs.probe_report()).available, false, 'probe_report() 同样');

  // verdict() 是纯函数：两根秒针的差 -> 结论。这段逻辑是"熄屏后还行不行"
  // 这个问题的判据，必须钉住。
  //
  // 采样点字段说明：ticks = 页面嵌套 setTimeout 的累计跳数（每 100ms 一跳）、
  // runMs = 页面侧已运行的毫秒数（判据用的是 ticks/runMs 的**时间比**，
  // 不受采样节奏影响 —— 被冻过一次之后采样间隔会拉长，用"每秒跳数"会误判）。
  const base = { hbCount: 10, ticks: 100000, ivTicks: 1000, runMs: 1000000 };
  ok(/正常/.test(FGS.ForegroundService.verdict(base,
       { hbCount: 11, ticks: 100100, ivTicks: 1001, runMs: 1010000 })),
     '两根秒针都在走、约 10Hz => 正常');
  ok(/WebView 被冻结/.test(FGS.ForegroundService.verdict(base,
       { hbCount: 11, ticks: 100000, ivTicks: 1000, runMs: 1010000 })),
     '原生心跳在走、JS 停了 => 判定为 WebView 被冻结（这是要搬原生循环的那种情况）');
  ok(/都停了/.test(FGS.ForegroundService.verdict(base,
       { hbCount: 10, ticks: 100000, ivTicks: 1000, runMs: 1010000 })),
     '两个都不走 => 进程被冻结/回收');
  // 10 秒里只跳了 20 次 = 2Hz（10Hz 循环的 1/5）
  ok(/降频/.test(FGS.ForegroundService.verdict(base,
       { hbCount: 11, ticks: 100020, ivTicks: 1000, runMs: 1010000 })),
     'JS 在走但只有约 2Hz => 判定为降频（不是被冻，也不是被杀）');
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`  原生 BLE 适配器自测通过：${passed} 项全部通过`);
} else {
  console.log(`  ${passed} 项通过 / ${failures.length} 项失败`);
  for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log('='.repeat(66));
process.exit(failures.length === 0 ? 0 : 1);

})().catch((e) => {
  // IIFE 里任何未捕获的异常都必须是**失败**，不能被 Node 当成"跑完了"
  console.error('原生适配器自测自身抛错：', e);
  process.exit(1);
});
