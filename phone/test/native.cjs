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
 * ⚠️ 这个桩必须**照着真插件的行为**写，否则自测会在一片绿里放过真机上的 bug。
 *    这一版特意改掉了两处"桩比真插件好用"的地方：
 *
 *   1. **checkPermissions() 的键名。** 真插件（@capacitor-community/bluetooth-le
 *      8.3.0）把权限声明成 @CapacitorPlugin(permissions=[...])，Capacitor 的
 *      Bridge.getPermissionStates() 按 alias 当键返回，于是真机上拿到的是
 *      {ACCESS_FINE_LOCATION, BLUETOOTH_SCAN, BLUETOOTH_CONNECT, ...}，
 *      **没有** st.scan / st.connect / st.location。以前的桩返回短名，
 *      于是"代码读错字段名"这件事在自测里永远看不出来（真机上权限被拒时，
 *      代码会以为权限是好的，一路走到"没扫到设备"）。现在按真插件的键名返回。
 *
 *   2. **initialize() 会因为权限被拒而 reject。** 真插件在
 *      BluetoothLe.kt 第 130-141 行要求它那一组别名**全部** GRANTED，否则
 *      reject("Permission denied.")。桩以前永远 resolve，于是
 *      "initialize 被拒 → 界面只显示链路断开"这条路从来没被覆盖。
 *
 *   3. **写载荷的字段名和编码必须和真插件一样严。**（这一版新加的，见
 *      _accept_write / hex_to_u8 上面那段长注释。）旧桩直接读
 *      `args.value.buffer` 当 DataView 用 —— 也就是说它**比真插件宽容**：
 *      真插件底层只认字符串（BluetoothLe.kt:674/698 `call.getString("value", null)`
 *      -> reject("Value required.")），而旧桩收 DataView、收数字数组、收什么
 *      都行。于是"ble_native.js 把 DataView 当写载荷传下去"这个真机上
 *      100% 写不出去（而且每片都写不出去）的 bug，在 148 项全绿的自测里
 *      安然无恙地活了下来。桩不能再比真插件宽容了。
 *
 * 其他刻意与真插件一致的地方：
 *   - requestLEScan 之后由 onScanResult 逐条推广播（allowDuplicates=true 时每条都推）；
 *   - isEnabled 返回 {value}；getConnectedDevices 返回 {devices:[...]}；
 *   - writeWithoutResponse / write 都要 {deviceId, service, characteristic, value}，
 *     且 value 必须是**十六进制字符串**（每字节两位、无分隔符，和
 *     bleClient.js:231/248 的 dataViewToHexString() 完全一致）；
 *   - getMtu 返回 {value}；addListener('onNotification', cb) 推 {value: DataView}；
 *   - disconnect 时推 onDisconnected 回调。
 */
class FakePlugin {
  constructor(opts) {
    const o = opts || {};
    this.mtu = o.mtu === undefined ? 247 : o.mtu;
    this.mtu_throws = !!o.mtu_throws;
    this.name = o.name || 'NavPuck-A1B2';
    this.no_device = !!o.no_device;                 // 扫描跑了，但一条广播都没有
    this.deny_permissions = !!o.deny_permissions;   // 权限被拒
    this.enabled = o.enabled === undefined ? true : !!o.enabled;   // 蓝牙开关
    this.no_lescan = !!o.no_lescan;                 // 老版本插件：没有 requestLEScan
    this.fail_writes_above = o.fail_writes_above === undefined ? Infinity : o.fail_writes_above;
    this.system_links = o.system_links || [];       // "系统里已连接的 GATT 设备"

    // 这一轮会广播什么。默认：同一台 NavPuck 连发 3 条（手机侧应该去重成 1 台）。
    this.adverts = o.adverts || [
      { deviceId: 'AA:BB:CC:DD:EE:FF', name: this.name, rssi: -62 },
      { deviceId: 'AA:BB:CC:DD:EE:FF', name: this.name, rssi: -55 },
      { deviceId: 'AA:BB:CC:DD:EE:FF', name: this.name, rssi: -58 },
    ];
    // 老插件没有 requestLEScan。⚠️ 必须赋成 undefined 遮住**原型上**那个方法
    //（delete 删不掉原型链上的，会假装成功）。
    if (this.no_lescan) this.requestLEScan = undefined;

    this.calls = [];              // 方法调用流水（含参数）
    this.writes = [];             // 每次写出去的字节（按序拼接就是设备看到的流）
    this.write_sizes = [];        // 每个分片的长度
    this.notify_cb = null;        // 上行通知回调
    this.scan_cb = null;          // onScanResult 回调
    this.disc_cb = null;          // 断开回调
    this.notifications_started = false;
    this.scanning = false;
    this.connected = false;
    this.initialize_args = null;
    this.required_aliases = null;  // initialize 这一轮要求哪几个权限别名
  }

  _rec(method, args) { this.calls.push({ method, args: args || null }); }

  /**
   * 真插件：initialize 决定它要求哪几个权限别名，任何一个没给就
   * reject("Permission denied.")（BluetoothLe.kt 第 104-141 行）。
   * 这一条让"androidNeverForLocation 传没传"变成**可断言的行为**，
   * 而不只是"参数里有个 true"。
   */
  async initialize(args) {
    this._rec('initialize', args);
    this.initialize_args = args;
    const never_for_location = !!(args && args.androidNeverForLocation);
    this.required_aliases = never_for_location
      ? ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT']
      : ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT', 'ACCESS_FINE_LOCATION'];
    if (this.deny_permissions) throw new Error('Permission denied.');
  }

  /** 真插件按 @Permission 的 alias 当键返回（见类头上面的说明）。 */
  async checkPermissions() {
    this._rec('checkPermissions');
    const ble = this.deny_permissions ? 'denied' : 'granted';
    const loc = this.deny_permissions ? 'denied' : 'granted';
    return {
      ACCESS_COARSE_LOCATION: loc,
      ACCESS_FINE_LOCATION: loc,
      BLUETOOTH: 'granted',
      BLUETOOTH_ADMIN: 'granted',
      BLUETOOTH_SCAN: ble,
      BLUETOOTH_CONNECT: ble,
    };
  }

  async requestPermissions() { this._rec('requestPermissions'); return this.checkPermissions(); }

  async isEnabled() { this._rec('isEnabled'); return { value: this.enabled }; }

  async getConnectedDevices() {
    this._rec('getConnectedDevices');
    return { devices: this.system_links };
  }

  async requestLEScan(args) {
    this._rec('requestLEScan', args);
    this.scanning = true;
    if (this.no_device) return;           // 扫描真的在跑，就是没有广播
    for (const a of this.adverts) this.emit_scan(a);
  }

  async stopLEScan() { this._rec('stopLEScan'); this.scanning = false; }

  /** 推一条扫描结果（等价于 Android 的 onScanResult）。 */
  emit_scan(a) {
    if (!this.scan_cb) throw new Error('测试自己写错了：onScanResult 监听还没挂上');
    this.scan_cb({
      device: { deviceId: a.deviceId, name: a.name },
      localName: a.name,
      rssi: a.rssi,
    });
  }

  async requestDevice(args) {
    this._rec('requestDevice', args);
    if (this.no_device) return null;
    return { deviceId: 'AA:BB:CC:DD:EE:FF', name: this.name };
  }

  async addListener(event, cb) {
    this._rec('addListener', event);
    if (event === 'onDisconnected') this.disc_cb = cb;
    else if (event === 'onScanResult') this.scan_cb = cb;
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
    const u8 = this._decode_write_value(args && args.value);
    if (u8.length > this.fail_writes_above) {
      throw new Error(`单次写 ${u8.length} 字节被设备拒绝`);
    }
    this.write_sizes.push(u8.length);
    for (const b of u8) this.writes.push(b);
  }

  /**
   * 真插件底层对写载荷的要求，逐条照抄（这就是本文件存在的主要理由）。
   *
   * 真插件这一侧（@capacitor-community/bluetooth-le 8.3.0）：
   *   · android/.../BluetoothLe.kt:674（write）与 :698（writeWithoutResponse）：
   *       val value = call.getString("value", null)
   *       if (value == null) { call.reject("Value required."); return }
   *     — 字段名是 **value**；writeDescriptor 在 :742 同样。
   *   · Capacitor 的 PluginCall.getString(key, def) 是
   *       `data.opt(key) instanceof String ? 值 : def`
   *     （本次用 javap 核对过 @capacitor/android 的 PluginCall.class 字节码）。
   *     所以传 DataView / 数组 / 对象都会变成默认值 null -> "Value required."。
   *   · value 的**内容**再由 Conversion.kt:28-39 stringToBytes() 还原：
   *     长度必须为偶数，每两个字符一个字节，用 Character.digit(c,16) 解
   *     （大小写都吃；非十六进制字符直接抛 "Invalid Hexadecimal Character"）。
   *
   * 一句话：**只接受十六进制字符串，其他一律 reject("Value required.")**。
   * 这跟"某一档 MTU 写不通"是两回事 —— 它和长度无关，所以任何分片大小
   * 都会失败。桩必须复刻这一点，否则这个 bug 又能从自测里溜过去。
   */
  _decode_write_value(value) {
    if (typeof value !== 'string') {
      // 真插件到这一步拿到的是 null，报的就是这句话；把实得类型附在后面，
      // 让失败信息本身就说清楚"传下去的是什么"（DataView / object / ...）。
      const got = (value === null || value === undefined)
        ? String(value)
        : (typeof value === 'object' ? (value.constructor && value.constructor.name) || 'object'
                                     : typeof value);
      throw new Error(`Value required.（桩：写载荷必须是十六进制字符串，实得 ${got}）`);
    }
    if (value.length % 2 !== 0) {
      // Conversion.kt:32 的 require(...)：真插件会抛这个
      throw new Error(`Input string must have an even length, not ${value.length}`);
    }
    const out = new Uint8Array(value.length / 2);
    for (let i = 0; i < out.length; i++) {
      const pair = value.substring(i * 2, i * 2 + 2);
      const hi = parseInt(pair[0], 16);
      const lo = parseInt(pair[1], 16);
      if (Number.isNaN(hi) || Number.isNaN(lo)) {
        // Conversion.kt:41-50 的 toDigit/hexToByte
        throw new Error(`Invalid Hexadecimal Character: ${pair}`);
      }
      out[i] = (hi << 4) + lo;
    }
    return out;
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
  /** 某个方法在流水里第一次出现的位置；没出现返回 -1（比 indexOf 好读）。 */
  at(method) { return this.methods().indexOf(method); }
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

/**
 * 造一个原生传输对象。
 *
 * ⚠️ `scan_window_ms: 0`：生产的扫描窗口是 6000ms（骑车现场点一下要等得起），
 *    自测里每个用例都真等 6 秒就没人愿意跑了。窗口本身也不测时间 ——
 *    测的是"窗口里收到了什么、没收到什么"。
 */
function mk_transport(plugin, extra) {
  return new NATIVE.NativeTransport(Object.assign({
    window: fake_window(plugin), onLog: () => {}, scan_window_ms: 0,
  }, extra || {}));
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
  const t = mk_transport(plugin);
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
  const rd = plugin.calls.find((c) => c.method === 'requestLEScan');
  eq(rd.args.services, [NUS_SERVICE], 'requestLEScan 按 NUS 服务过滤');
  eq(rd.args.allowDuplicates, true,
     'allowDuplicates=true：不重复收广播就数不出"看到几条"（那正是诊断要的读数）');
  eq(rd.args.scanMode, NATIVE.SCAN_MODE_LOW_LATENCY,
     '前台用 LOW_LATENCY 扫（点一下要马上有结果）');
  ok(plugin.at('addListener') < plugin.at('requestLEScan'),
     'onScanResult 监听在 requestLEScan **之前**挂上（否则会漏掉开头几条广播）');
  ok(plugin.at('requestLEScan') < plugin.at('stopLEScan'),
     '扫描窗口结束才 stopLEScan（自己控时，不靠插件那 30 秒的超时）');
  eq(t.scan_mode, 'lescan', '这一轮走的是 requestLEScan（能数广播）');
  eq(t.adverts_seen, 3, '收到 3 条广播（桩里那台 NavPuck 连发了 3 条）');
  eq(t.devices_seen, 1, '但去重之后只有 1 台设备');

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
  const t = mk_transport(plugin);
  await t.connect();

  // 造一个 1400 字节的载荷（真实 NAV_MAP 的量级）
  const payload = new Uint8Array(1400);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  // ⚠️ 这里接住异常只是为了**让这一节把后面的断言跑完**（一个不通过的用例
  //    应该把问题都说清楚，而不是在第一条就整个中止）。真插件契约下写载荷
  //    不对是必然失败的 —— 那件事由第 11b 节点名。
  try {
    await t.write_frame(payload);
  } catch (e) {
    ok(false, `传输层写帧不该失败：${e}`);
  }

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
  const t = mk_transport(plugin);
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
  const t = mk_transport(plugin);

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
  const t = mk_transport(plugin);
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
  const t = mk_transport(plugin);
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
// 8] 三种失败必须分得开：权限被拒 / 蓝牙没开 / 扫完了但没有广播
// ---------------------------------------------------------------------------
//
// 用户报的现象是"APK 里点连接设备报没找到设备，同一个手机用网页能连上"。
// 真正的根因（扫描被绑在定位权限上）在第 8b 节钉住；这一节钉的是**另一半**：
// 以前这三种完全不同的故障都只报一句"没有扫描到 NavPuck 设备"，用户只能靠猜。
// 判据是 err.code（不是文案），而且三种的 code / 文案必须两两不同。
section('8] 失败路径：三种失败（权限 / 蓝牙开关 / 扫完了没有）必须互不相同、且能指路');
{
  // ── (a) 权限被拒 ──────────────────────────────────────────────────────
  // 真插件在 initialize() 里就因为权限 reject("Permission denied.")，
  // 所以这里连扫描都不该开始。
  const plugin = new FakePlugin({ deny_permissions: true });
  const t = mk_transport(plugin);
  let err = null;
  try { await t.connect(); } catch (e) { err = e; }
  ok(err !== null, '权限被拒时抛错（不是静默返回）');
  eq(err && err.code, NATIVE.ERR_PERMISSION, '错误码 = NAV_BLE_PERMISSION_DENIED（界面按码分类）');
  ok(err && /权限被拒绝/.test(err.message), '文案点明"权限被拒绝"');
  ok(err && /BLUETOOTH_SCAN/.test(err.message), '点名是哪一个权限在挡路（BLUETOOTH_SCAN）');
  ok(err && /附近的设备/.test(err.message) && /设置/.test(err.message),
     '并且说清楚去哪儿开（设置 → 应用 → NavPuck → 权限 → 附近的设备）');
  ok(err && /一个设备都看不到/.test(err.message),
     '明说"没有它扫描不可能工作"，而不是含糊地说失败');
  ok(err && !/没有扫描到/.test(err.message), '**不能**退化成"没有扫描到设备"（那会把用户引到错方向）');
  eq(plugin.at('requestLEScan'), -1, '权限被拒时扫描根本没开始（requestLEScan 没被调用）');

  // ── (b) 蓝牙没开 ─────────────────────────────────────────────────────
  const plugin2 = new FakePlugin({ enabled: false });
  const t2 = mk_transport(plugin2);
  let err2 = null;
  try { await t2.connect(); } catch (e) { err2 = e; }
  ok(err2 !== null, '蓝牙关闭时抛错');
  eq(err2 && err2.code, NATIVE.ERR_ADAPTER_OFF, '错误码 = NAV_BLE_ADAPTER_OFF');
  ok(err2 && /蓝牙是关闭的/.test(err2.message) && /isEnabled=false/.test(err2.message),
     '文案点明"蓝牙是关闭的"（并且带上 isEnabled 这个实测值）');
  ok(err2 && /打开蓝牙/.test(err2.message), '告诉用户去开蓝牙');
  eq(plugin2.at('isEnabled') >= 0, true, '真的问了适配器状态（isEnabled 被调用）');
  eq(plugin2.at('requestLEScan'), -1, '蓝牙没开时扫描根本没开始');

  // ── (c) 扫描跑了，但一条广播都没有 ────────────────────────────────────
  const plugin3 = new FakePlugin({ no_device: true });
  const t3 = mk_transport(plugin3);
  let err3 = null;
  try { await t3.connect(); } catch (e) { err3 = e; }
  ok(err3 !== null, '扫不到设备时抛错');
  eq(err3 && err3.code, NATIVE.ERR_NO_DEVICE, '错误码 = NAV_BLE_NO_DEVICE');
  ok(err3 && /扫描已经跑完/.test(err3.message), '文案说清楚"扫描**跑完了**"（不是没跑成）');
  ok(err3 && /0 条广播/.test(err3.message), '并且把实测到的广播条数写出来（0 条）');
  ok(err3 && /停止广播/.test(err3.message) && /网页/.test(err3.message),
     '提示第七种可能性：设备被别的中心连着时会停止广播（网页/上一个 App）');
  eq(plugin3.at('requestLEScan') >= 0, true, '这一种扫描**确实执行了**（requestLEScan 被调用）');
  eq(plugin3.at('stopLEScan') >= 0, true, '窗口结束照样 stopLEScan（不把扫描留在后台）');
  eq(t3.adverts_seen, 0, '传输对象上记着这一轮收到 0 条广播');

  // ── (d) 三种必须两两不同 ─────────────────────────────────────────────
  const codes = [err.code, err2.code, err3.code];
  eq(new Set(codes).size, 3, `三个错误码互不相同：${codes.join(' / ')}`);
  const texts = [err.message, err2.message, err3.message];
  eq(new Set(texts).size, 3, '三段文案也互不相同（用户看得出区别）');
}

// ---------------------------------------------------------------------------
// 8b] 扫描不再依赖定位：androidNeverForLocation 真的传下去了
// ---------------------------------------------------------------------------
//
// 这是"APK 扫不到、网页能连"的**主根因**。两处必须成对：
//   · 插件侧 initialize({androidNeverForLocation:true})  —— 插件据此决定
//     initialize() 要求哪几个权限别名，并且不再索要 ACCESS_FINE_LOCATION；
//   · 清单侧 BLUETOOTH_SCAN 上的 android:usesPermissionFlags="neverForLocation"
//     —— Android 12+ 据此不再把扫描结果与"定位权限 + 定位服务开关"绑定。
// 少任何一处都等于没改。
section('8b] 扫描与定位解耦：androidNeverForLocation 两处都要有');
{
  const plugin = new FakePlugin({ mtu: 247 });
  const t = mk_transport(plugin);
  await t.connect();

  eq(plugin.initialize_args, { androidNeverForLocation: true },
     'initialize() 传的是 {androidNeverForLocation:true}（旧代码是 false）');
  eq(plugin.required_aliases, ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT'],
     '插件据此只要求 BLUETOOTH_SCAN/BLUETOOTH_CONNECT（不再要求 ACCESS_FINE_LOCATION）');

  // 清单侧：真源文件里必须带这个属性。APK 里的字节由构建后的 zip 核对
  // （见 docs/android.md 6.2），这里先把**源**钉住，防止有人手滑把它删掉。
  const fs = require('node:fs');
  const manifest_path = path.resolve(PHONE_DIR, '..', 'android', 'android', 'app',
                                     'src', 'main', 'AndroidManifest.xml');
  if (fs.existsSync(manifest_path)) {
    const xml = fs.readFileSync(manifest_path, 'utf8');
    const m = /<uses-permission[^>]*BLUETOOTH_SCAN[^>]*>/s.exec(xml);
    ok(!!m, 'AndroidManifest.xml 里有 BLUETOOTH_SCAN 的声明');
    ok(!!m && /android:usesPermissionFlags="neverForLocation"/.test(m[0]),
       'BLUETOOTH_SCAN 上带了 android:usesPermissionFlags="neverForLocation"');
    ok(/android\.permission\.ACCESS_FINE_LOCATION/.test(xml),
       'ACCESS_FINE_LOCATION 仍然保留（导航要 GPS —— 解耦的只是扫描）');
  } else {
    console.log(`      （跳过 manifest 检查：找不到 ${manifest_path}）`);
  }

  // 权限/开关读数必须真的进日志：真机上用户就是拿这几行来定位问题的。
  const logs = [];
  const plugin2 = new FakePlugin({ system_links: [{ deviceId: 'AA:BB:CC:DD:EE:FF', name: 'NavPuck-A1B2' }] });
  const t2 = mk_transport(plugin2, { onLog: (l) => logs.push(l) });
  await t2.connect();
  ok(logs.some((l) => /BLUETOOTH_SCAN=granted/.test(l)),
     '扫描前把权限状态按**真插件的别名**打进日志（BLUETOOTH_SCAN=granted）');
  ok(logs.some((l) => /BLUETOOTH_CONNECT=granted/.test(l)), 'BLUETOOTH_CONNECT 也打了');
  ok(!logs.some((l) => /scan=undefined/.test(l)),
     '不会再打出 scan=undefined（旧代码读错了字段名，日志等于没写）');
  ok(logs.some((l) => /isEnabled=true/.test(l)), '蓝牙开关状态也打了（isEnabled=true）');
  ok(logs.some((l) => /GATT 已连接设备/.test(l)),
     '把系统里已连接的 GATT 设备列出来（第七种可能性的证据：设备在别处连着就不广播）');
  ok(logs.some((l) => /收到 3 条广播 \/ 1 台设备/.test(l)),
     '把"收到几条广播、几台设备"写进日志（这是"扫描真的在收包"的证据）');

  // 挑设备：名字以 NavPuck- 开头优先，其次信号最强
  eq(NATIVE._pick_device(new Map([
    ['1', { deviceId: '1', name: 'Other', rssi: -20 }],
    ['2', { deviceId: '2', name: 'NavPuck-B', rssi: -80 }],
  ])).deviceId, '2', '名字以 NavPuck- 开头的优先（哪怕信号更弱）');
  eq(NATIVE._pick_device(new Map([
    ['1', { deviceId: '1', name: '', rssi: -70 }],
    ['2', { deviceId: '2', name: '', rssi: -40 }],
  ])).deviceId, '2', '名字都拿不到时挑信号最强的');
}

// ---------------------------------------------------------------------------
// 8c] 扫描前先放开自己的连接；老插件退回 requestDevice
// ---------------------------------------------------------------------------
section('8c] 扫描前的清理与老插件的退路');
{
  // 连第二次之前，必须先把上一次自己建的 GATT 连接放掉：
  // BLE 外设被连着就不广播，不清掉的话第二次扫描必然为空。
  const plugin = new FakePlugin();
  const t = mk_transport(plugin);
  await t.connect();
  plugin.calls.length = 0;
  await t.reconnect();     // 不重新扫描，只重连（不该有 requestLEScan）
  eq(plugin.at('requestLEScan'), -1, 'reconnect() 复用上次的 deviceId，不再扫一遍');
  eq(t.device_id, 'AA:BB:CC:DD:EE:FF', 'deviceId 仍然是上次那台');

  const plugin2 = new FakePlugin();
  const t2 = mk_transport(plugin2);
  await t2.connect();
  plugin2.calls.length = 0;
  await t2.connect();      // 再连一次：这一次要重新扫描，且扫描前要断开
  ok(plugin2.at('disconnect') >= 0 && plugin2.at('disconnect') < plugin2.at('requestLEScan'),
     '第二次扫描**之前**先 disconnect（否则设备还连着上一次，根本不广播）');

  // 老版本插件没有 requestLEScan：退回 requestDevice，能连上，
  // 但广播条数**记成 null**（不编数 —— 界面会显示 "?"）。
  const plugin3 = new FakePlugin({ no_lescan: true });
  const t3 = mk_transport(plugin3);
  await t3.connect();
  eq(t3.scan_mode, 'requestDevice', '没有 requestLEScan 时退回 requestDevice');
  eq(t3.adverts_seen, null, '退路下广播条数记 null（不瞎编一个 0 或 1）');
  eq(plugin3.at('requestDevice') >= 0, true, 'requestDevice 真的被调用了');
  eq(t3.device_name, 'NavPuck-A1B2', '退路下照样连上（老插件不能用不了）');
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
section('10] 前台服务封装：PWA 里一个异常都不能抛（含原生节拍器）');
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

  // 原生节拍器（APK 里才有的那条路）在 PWA 里也必须**完全无声**：
  // 一个"浏览器里悄悄起了个定时器去驱动导航"的实现，会直接违反
  // "PWA 的行为与加这个功能之前一模一样"这条硬要求。
  eq(fgs.metronome_available, false, 'PWA 里 metronome_available = false（没有原生方法）');
  eq((await fgs.metronome_start()).available, false, 'metronome_start() 返回 {available:false}，不抛错');
  eq((await fgs.metronome_stop()).available, false, 'metronome_stop() 同样');
  {
    const ms = await fgs.metronome_stats();
    eq(ms.available, false, 'metronome_stats() 同样不抛错');
    // 字段必须是**平**的、名字与判读表一致（界面直接按名字读）
    for (const k of ['metroTimerFires', 'ticksDelivered', 'ticksSkipped',
                     'ticksCallbackRejected', 'jsExecCount', 'framesSent',
                     'workerTicks', 'workerMainTicks']) {
      ok(k in ms, `metronome_stats() 里始终有 ${k}（PWA 下为 0）`);
    }
    eq(ms.jsExecCount, 0, 'PWA 下 jsExecCount = 0');
  }
  ok(/没有节拍器/.test(FGS.ForegroundService.metronome_verdict(null,
       { metronomeSupported: false })),
     'metronome_verdict：没有原生方法时不硬下结论，直说"这个 APK 里没有节拍器"');

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
// 11] 下行：APK 那条路上 send() 必须真的写到传输上
// ---------------------------------------------------------------------------
//
// 这一节钉的是一段**真机上完全没有第二道防线**的接线，而且它出过一次真事故：
//
//   - Web Bluetooth 路径的"连上就发时钟"由 ui.mjs 第 10 节覆盖（那条路上
//     link.rx 是 RX 特征，字节走 _write_chunk / rx.writeValue*）；
//   - 原生路径（APK 里）**故意**把 rx/tx 都置空（见 ble.js _gatt_connect 的
//     原生分支），字节走 transport.write_frame()。而 _drain() 曾经用
//     `!this.rx` 当"这条链路能不能写"的判据 —— 于是 APK 里**每一帧**都被判成
//     "链路不可用"、整队清掉：NAV_CLOCK 一个字节都到不了设备，主页永远 --:--。
//     更糟的是 send() 仍然返回 true、app.js 仍然在日志里写"已下发设备时间"，
//     从手机侧看**完全成功** —— 症状和"对端根本没发"长得一模一样。
//
// 所以这里要同时钉住三件事：
//   1. 原生路径下 rx 就是 null 且 connected 是 true（判据不能看 rx）；
//   2. send() 之后字节**真的**出现在传输上，且就是金标 NAV_CLOCK 帧；
//   3. 把写出去的字节喂回 FrameParser（设备侧解析用的就是它）能解出
//      正确的 epoch / 时区 —— 也就是"设备确实能收到这个时间"。
//
// ⚠️ 这里刻意走 send()（排队 + 异步 _drain）而不是直接调 _write_frame()：
//    第 6 节用的是 _write_frame，正因为绕过了 _drain，那个 bug 才从它眼皮底下
//    溜过去了。测哪一层，就只能覆盖哪一层。
section('11] 下行：原生路径 send() 的字节必须真的写到传输上（NAV_CLOCK）');
{
  const plugin = new FakePlugin();
  const t = mk_transport(plugin);
  const logs = [];
  const link = new BLE.BleLink({ transport: t, onLog: (l) => logs.push(l), onFrame: () => {} });
  await link.connect();

  // 前置事实：原生路径下 rx/tx 就是 null。它不是"链路没接好"，
  // 所以任何 `!this.rx` 形式的判据都必然是错的。
  eq(link.rx, null, '原生路径下 link.rx = null（写走 transport，不写 GATT 特征）');
  eq(link.tx, null, '原生路径下 link.tx = null');
  eq(link.connected, true, '但 link.connected = true —— 链路是好的');

  plugin.writes.length = 0;
  const frame = proto.encode_nav_clock(new proto.NavClock({
    epoch_s: 1757500000, tz_offset_min: 330,
  }));
  const accepted = link.send(frame, 'ctl', 1);
  eq(accepted, true, 'send() 收下了这一帧（ctl 是已知 kind，不会被拒收）');
  await sleep(50);                    // 等异步 _drain 真的跑完

  eq(plugin.writes.length, frame.length,
     `整帧写到了原生传输上（${plugin.writes.length}/${frame.length} 字节）`);
  eq(Buffer.from(plugin.writes).toString('hex'), 'a55a010606006052c1684a016a5f',
     '写出去的字节 == 金标 NAV_CLOCK 帧（epoch 1757500000 / tz +330）');
  eq(link.frames_sent, 1, 'frames_sent = 1（真的发出去了）');
  eq(link.frames_dropped, 0, 'frames_dropped = 0（没有被当成"链路不可用"整队清掉）');
  eq(link.dropped_disconnected, 0, 'dropped_disconnected = 0（正是这个桶在吞 APK 的帧）');
  ok(!logs.some((l) => /链路不可用/.test(l)),
     '日志里没有"链路不可用"（APK 里刷这句 = 每一帧都被吞了）');
  eq(link.frames_offered, link.frames_sent + link.frames_dropped,
     '记账不变量仍然成立：offered == sent + dropped');

  // 端到端到底：把传输上真正出现的字节喂回 FrameParser（设备侧用的就是它），
  // 必须解出一帧 NAV_CLOCK，且两个字段都对得上。
  const dev_parser = new proto.FrameParser();
  const frames = dev_parser.feed(Uint8Array.from(plugin.writes));
  eq(frames.length, 1, '设备侧解析器从这条字节流里解出 1 帧');
  if (frames.length === 1) {
    eq(frames[0].type, proto.MsgType.NAV_CLOCK, '帧类型 = NAV_CLOCK（0x06）');
    const ck = proto.NavClock.unpack(frames[0].payload);
    eq(frames[0].payload.length, proto.NAV_CLOCK_LEN, `载荷 ${proto.NAV_CLOCK_LEN} 字节`);
    eq(ck.epoch_s, 1757500000, 'epoch 是秒，且与发出的一致');
    eq(ck.tz_offset_min, 330, '时区偏移原样到达（+5:30 这种半点时区不能被抹平）');
  }

  // 断开之后仍然不能再往链路上写（这条不能因为放宽判据而被一起放开）
  await link.disconnect();
  plugin.writes.length = 0;
  eq(link.send(frame, 'ctl', 1), true, '（断开后 send() 仍会收下——它只负责入队）');
  await sleep(50);
  eq(plugin.writes.length, 0, '断开后 queue 被清空，一个字节都没写出去');
  eq(link.dropped_disconnected, 1, '而且这一帧如实记进了 dropped_disconnected');
}

// ---------------------------------------------------------------------------
// 11b] 写载荷的**编码契约**：native 只认十六进制字符串
// ---------------------------------------------------------------------------
//
// 这一节钉的是真机上"扫到、连上、MTU=517、通知也订阅了，然后**每一片**都
// 写失败：Error: Value required.，一路降到 20 字节仍然失败"那件事的根因。
//
// 现场日志长得像"链路质量差、MTU 谈不下来"，其实和 MTU 一点关系都没有：
// ble_native.js 把 `value: DataView` 传给了**底层**插件，而底层
// （BluetoothLe.kt:674/698）只接受字符串 —— DataView 过 JSON 之后是 `{}`，
// `call.getString("value", null)` 拿到 null，于是 reject("Value required.")。
// 分片大小换成多少都一样，所以降档阶梯注定白跑。
//
// 这里刻意用**最贴近现场**的方式复现：真的 NavUpdate 帧、真的 BleLink、
// 真的走 ble.js 的 _write_frame -> transport.write_frame。桩按真插件的契约
// 拒收（见 FakePlugin._decode_write_value），所以只要有人把
// `value: u8_to_hex_string(chunk)` 改回 `value: u8_to_data_view(chunk)`，
// 这一节立刻红。
section('11b] 写载荷契约：整帧 NAV_UPDATE 必须以十六进制字符串分片送出');
{
  // ── 11b-1) 整帧 NAV_UPDATE（现场那条"到不了设备"的帧）────────────────
  const plugin = new FakePlugin({ mtu: 247 });
  const t = mk_transport(plugin);
  const logs = [];
  const link = new BLE.BleLink({ transport: t, onLog: (l) => logs.push(l), onFrame: () => {} });
  await link.connect();

  const update = new proto.NavUpdate({
    rel_bearing_cdeg: -4500, abs_bearing_cdeg: 27000, dist_next_cm: 123456,
    dist_dest_m: 4321, speed_kmh_x10: 187, eta_min: 42, turn: 2,
    flags: proto.NavFlags.LINK_UP, progress_pct: 63, heading_cdeg: 27100,
    pos_east_m: -1234, pos_north_m: 5678, next_turn_index: 7, view_range_dm: 950,
  });
  const frame = proto.encode_nav_update(update);
  eq(frame.length, proto.HEADER_LEN + proto.NAV_UPDATE_LEN + proto.CRC_LEN,
     `NAV_UPDATE 整帧 = 头 ${proto.HEADER_LEN} + 载荷 ${proto.NAV_UPDATE_LEN} + CRC ${proto.CRC_LEN}` +
     ` = ${proto.HEADER_LEN + proto.NAV_UPDATE_LEN + proto.CRC_LEN} 字节`);

  const okwrite = await link._write_frame(frame);
  ok(okwrite, '整帧 NAV_UPDATE 写成功（旧代码在这一步就是 Value required.）');
  eq(plugin.writes.length, frame.length,
     `设备侧收到的字节数 == 帧长（${plugin.writes.length}/${frame.length}，一片不丢不多）`);
  eq(Buffer.from(plugin.writes).toString('hex'), Buffer.from(frame).toString('hex'),
     '收到的字节流与原始帧**逐字节**相同（十六进制编解码没有错位/大小写问题）');

  // 写下去的那个参数长什么样：字段名 value、类型 string、内容是十六进制
  const w = plugin.calls.find((c) => c.method === 'writeWithoutResponse');
  ok(!!w, '走的是 writeWithoutResponse');
  eq(w.args.value, Buffer.from(frame).toString('hex').toUpperCase(),
     'args.value 是十六进制字符串（每字节两位、无分隔符），不是 DataView');
  eq(typeof w.args.value, 'string', 'args.value 的类型就是 string（native 的 getString 只认这个）');
  ok(!/^\[object|^\{/.test(String(w.args.value)), 'value 不是被 JSON 压成 "[object ...]" 或 "{}"');

  // 设备侧到底能不能解出来 —— 这才是"字节真的到了"的证据
  const dev = new proto.FrameParser();
  const got = dev.feed(Uint8Array.from(plugin.writes));
  eq(got.length, 1, '设备侧 FrameParser 从收到的字节流里解出 1 帧');
  if (got.length === 1) {
    eq(got[0].type, proto.MsgType.NAV_UPDATE, '帧类型 = NAV_UPDATE（0x01）');
    const back = proto.NavUpdate.unpack(got[0].payload);
    eq(back.rel_bearing_cdeg, -4500, '相对方位角（负值）原样到达');
    eq(back.dist_next_cm, 123456, '到下一转向的距离原样到达');
    eq(back.pos_east_m, -1234, '东向坐标（负值、i16 边界）原样到达');
    eq(back.next_turn_index, 7, '转向序号原样到达');
    eq(back.view_range_dm, 950, '视野半径原样到达');
  }

  // 补零不能省：0x05 必须是 "05" 而不是 "5"，否则从这一字节起全部错位。
  eq(NATIVE._u8_to_hex_string(Uint8Array.from([0x00, 0x05, 0xab, 0xff])), '0005ABFF',
     '每字节固定两位（0x05 -> "05"）：少一位会让 native 侧整串错位且不报错');

  // ── 11b-2) 分片必须按 MTU-3 走，而且第一片就成 ──────────────────────────
  // 现场那台设备谈成的是 MTU 517 -> 514 字节/片。1.4KB 底图应该 3 片，
  // 而不是 20 字节的 70 片（那正是"降档阶梯一路走到黑"的样子）。
  const plugin2 = new FakePlugin({ mtu: 517 });
  const t2 = mk_transport(plugin2);
  const logs2 = [];
  const link2 = new BLE.BleLink({ transport: t2, onLog: (l) => logs2.push(l), onFrame: () => {} });
  await link2.connect();

  eq(t2.transport_mtu, 517, 'MTU 路径仍然被使用：协商到 517');
  eq(link2.chunk_size, 514, 'ble.js 起步分片 = MTU-3 = 514（不是 PWA 那个 512）');

  const map = new Uint8Array(1400);
  for (let i = 0; i < map.length; i++) map[i] = (i * 7) & 0xff;
  ok(await link2._write_frame(map), '1400 字节的帧一次写成功');
  eq(plugin2.write_sizes, [514, 514, 372],
     '1400 = 514 + 514 + 372（3 个写操作；旧代码在这里会降到 20 字节 = 70 片）');
  eq(link2.downgrades, 0, '**一次都没降档**（第一片就成 —— 这才是 MTU 路径的意义）');
  eq(link2.write_failures, 0, '写失败次数 = 0');
  eq(link2.chunk_size, 514, '分片大小保持 514');
  let same2 = true;
  for (let i = 0; i < map.length; i++) if (plugin2.writes[i] !== map[i]) same2 = false;
  eq(plugin2.writes.length, 1400, '写出去的字节总数 = 帧长度');
  ok(same2, '3 片拼起来的字节流与原始帧逐字节相同');
  ok(!logs2.some((l) => /写失败|降到|程序错误/.test(l)),
     '日志里没有"写失败/降到/程序错误"（真机上不该再刷那条误导性的降档阶梯）');

  // 有些平台/老插件没有 writeWithoutResponse：退路必须是 write()，且载荷同一套契约
  const plugin3 = new FakePlugin({ mtu: 247 });
  plugin3.writeWithoutResponse = undefined;      // 遮住原型上的，模拟老插件
  const t3 = mk_transport(plugin3);
  const link3 = new BLE.BleLink({ transport: t3, onLog: () => {}, onFrame: () => {} });
  await link3.connect();
  ok(await link3._write_frame(frame), '没有 writeWithoutResponse 时退回 write() 也能写成');
  eq(plugin3.at('write') >= 0, true, 'write() 真的被调用了');
  eq(Buffer.from(plugin3.writes).toString('hex'), Buffer.from(frame).toString('hex'),
     '退路下字节一样完整（两条路共用同一个编码契约）');

  // ── 11b-3) 首片就失败 = 程序错误，日志必须这么说 ─────────────────────────
  // 降档阶梯本身要保留（小分片也可能因为外设接收环满而失败），但不能让它
  // 读起来像"每个 MTU 都连不通"。首片（= 协商 MTU-3）第一次就被拒，
  // 物理上说不通，那是代码/契约问题，必须被点名。
  const plugin4 = new FakePlugin({ mtu: 247, fail_writes_above: 16 });
  const t4 = mk_transport(plugin4);
  const logs4 = [];
  t4.log = (l) => logs4.push(l);
  const link4 = new BLE.BleLink({ transport: t4, onLog: (l) => logs4.push(l), onFrame: () => {} });
  await link4.connect();
  const ok4 = await link4._write_frame(new Uint8Array(300));
  ok(!ok4, '一直失败到底时 _write_frame 返回 false（行为与降档前一模一样）');
  ok(logs4.some((l) => /程序错误/.test(l)),
     '首片（244 = MTU-3）失败被明确说成**程序错误**，不是链路问题');
  eq(logs4.filter((l) => /程序错误/.test(l)).length, 1,
     '"程序错误"只解释一次（APK 里每秒发帧，不能刷屏把现场信息挤掉）');
  ok(logs4.some((l) => /降到 185/.test(l)), '降档阶梯仍然保留（兜底逻辑没被删掉）');
  const i_bug = logs4.findIndex((l) => /程序错误/.test(l));
  const i_ladder = logs4.findIndex((l) => /降到/.test(l));
  ok(i_bug >= 0 && i_ladder > i_bug, '先把"这是程序错误"说清楚，再说降档（不会让人以为阶梯在修问题）');
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
