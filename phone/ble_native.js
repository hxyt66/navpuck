/*
 * NavPuck BLE —— 原生（Capacitor）侧的传输层适配器。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 它替换的是什么、没替换什么
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 只替换**传输**：怎么找到设备、怎么连、怎么把字节写进 RX、怎么收 TX 通知。
 * **不动**的是 ble.js 里的东西：发送队列、优先级、队满丢 update 的策略、
 * 帧解析（proto.FrameParser）、空闲看门狗。那些是协议正确性的一部分，被
 * golden vector / integration 自测覆盖着，原生路径跑的是同一份代码。
 *
 * 所以 phone/ble.js 里只加了一个"传输对象"的接缝（见该文件里 transport 的
 * 说明），Web Bluetooth 那条路一个字节都没改，PWA 照旧。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 原生相比 Web Bluetooth 多出来的那件事：**能拿到协商后的 MTU**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ble.js 的文件头第 1 条写得很清楚：Web Bluetooth 拿不到 MTU，所以只能
 * "先试 512，失败退 244/185/128/64/20"。原生插件直接有 getMtu()，
 * 于是这里的策略变成：
 *   - 连上之后 requestMtu()，读回真实 MTU；
 *   - 分片大小 = MTU - 3（3 = ATT 写请求的 opcode + handle，见 docs/protocol.md）；
 *   - 仍然保留"写失败就降档重试整帧"的兜底（ble.js 的 _write_frame 负责），
 *     但正常情况下一次就成，不会有 78 个 20 字节分片那种情况。
 * 对 1.4KB 的 NAV_MAP 底图，这直接决定它是 0.3 秒还是 3 秒（docs/ble.md 第 2 节）。
 */

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.NavPuckBleNative = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // 与 ble.js 保持同一组常量（NUS 是设备固件定死的，见 docs/ble.md）
  const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_RX      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_TX      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

  // 分片兜底序列，与 ble.js 的 CHUNK_CANDIDATES 一致
  const CHUNK_FALLBACK = 20;
  const CHUNK_CANDIDATES = [512, 244, 185, 128, 64, 20];

  /** 默认请求的 MTU。247 是 Android 上最常见能谈成的一档（载荷 244）。 */
  const WANT_MTU = 247;

  /** 这些方法的返回都是 Promise，且**不要**指望它们同步抛错。 */

  /** 找到 Capacitor 桥。找不到就返回 null（说明在 PWA 里跑）。 */
  function find_capacitor(win) {
    const w = win || (typeof globalThis !== 'undefined' ? globalThis : null);
    if (!w) return null;
    const c = w.Capacitor;
    if (!c) return null;
    // Capacitor 6+ 用 isNativePlatform()；老版本用 isNative 布尔。
    // 两个都认，避免因为版本差异把"在 App 里"判成"不在 App 里"。
    if (typeof c.isNativePlatform === 'function') return c.isNativePlatform() ? c : null;
    if (typeof c.isNative === 'boolean') return c.isNative ? c : null;
    // 都没有就把"存在 Capacitor 且有插件通道"当作在原生里
    return c.Plugins ? c : null;
  }

  /** 命名风格两种都认（Capacitor 插件通道会做 camelCase 转换）。 */
  function pick_plugin(cap) {
    if (!cap || !cap.Plugins) return null;
    return cap.Plugins.BluetoothLe || cap.Plugins.BluetoothLE
        || cap.Plugins.bluetoothLe || cap.Plugins.BluetoothLePlugin || null;
  }

  /**
   * 本环境能不能走原生 BLE。
   *
   * ⚠️ 刻意**不**检查 navigator.bluetooth：Capacitor 的 WebView 里
   *    navigator.bluetooth 可能也存在（Chromium 有 Web Bluetooth 实现），
   *    但它在 WebView 里根本不能用来做 GATT（没有设备选择器，也没有
   *    权限代理）。所以判断依据只能是"在 Capacitor 壳里 + 插件在不在"。
   */
  function available(win) {
    return !!(find_capacitor(win) && pick_plugin(find_capacitor(win)));
  }

  /**
   * 原生 BLE 传输对象。接口与 ble.js 期望的 transport 完全对应：
   *
   *   name                显示用
   *   connected           布尔
   *   device_name         连接后可用
   *   transport_mtu       协商到的 MTU（拿不到就是 null）
   *   chunk_size_hint     ble.js 用它初始化分片大小
   *   connect()           扫描 + 连接 + 发现服务 + 订阅通知
   *   disconnect()        断开（不触发 onDisconnected 回调，因为是用户主动的）
   *   write_frame(bytes)  一整帧，内部按 MTU 分片；失败就抛
   *
   * 回调（ble.js 赋过来）：
   *   onNotify(Uint8Array)        有上行字节
   *   onDisconnected(info)        链路掉了（外部原因）
   */
  class NativeTransport {
    constructor(opts) {
      const o = opts || {};
      this.win = o.window || (typeof globalThis !== 'undefined' ? globalThis : null);
      this.cap = find_capacitor(this.win);
      this.plugin = pick_plugin(this.cap);
      this.log = o.onLog || (() => {});
      this.onNotify = null;
      this.onDisconnected = null;
      this.onState = o.onState || (() => {});

      this.device_id = null;
      this.device_name = '';
      this.connected = false;
      this.transport_mtu = null;
      this.chunk_size_hint = 512;      // 还没协商出来之前的乐观值（与 PWA 一致）
      this.name = '原生 BLE（Capacitor）';

      this._notify_handle = null;
      this._manual_close = false;

      /** 收到通知时把 DataView 转成 Uint8Array。 */
      this._on_notify_ev = (result) => {
        if (!result || !result.value) return;
        let bytes;
        try {
          bytes = data_view_to_u8(result.value);
        } catch (e) {
          // 参考实现（bluetooth-le 文档）用 base64 字符串传值；
          // 这里两种都支持，转换失败只记日志，不能让回调把通道带崩。
          try { bytes = base64_to_u8(String(result.value)); }
          catch (e2) { this.log(`原生通知解析失败：${e2}`); return; }
        }
        if (this.onNotify) {
          try { this.onNotify(bytes); } catch (e) { this.log(`onNotify 抛错：${e}`); }
        }
      };

      /** 设备侧断开：插件会推这个事件。 */
      this._on_disconnected_ev = (dev) => {
        const was = this.connected;
        this.connected = false;
        const name = (dev && dev.name) || this.device_name;
        this.log(`原生链路断开（${name}）`);
        if (!this._manual_close && was && this.onDisconnected) {
          try { this.onDisconnected({ name }); } catch (e) { this.log(`onDisconnected 抛错：${e}`); }
        }
      };
    }

    static available(win) { return available(win); }

    /** 让 ble.js 知道该用什么分片起步。 */
    get chunk_size() { return this.chunk_size_hint; }

    /**
     * 扫描并连接。
     *
     * 与 Web Bluetooth 的 requestDevice() 的**行为差异**（必须说清楚）：
     *   - PWA 里会弹一个系统设备选择框，用户点一下；原生插件没有那个框，
     *     它直接按服务 UUID 过滤扫到的第一个 NavPuck。好处是"不用点"，
     *     坏处是**没有让用户挑设备的机会**。现场如果有两台 NavPuck，
     *     选中的是信号最强/最先被扫到的那个 —— 这台机器上无法验证，
     *     如实记在 docs/android.md 的"未验证"一节。
     *   - 没有用户手势的要求，所以可以在 10Hz 循环里自动重连（PWA 做不到，
     *     见 ble.js 的 _schedule_reconnect 注释）。
     */
    async connect() {
      if (!this.plugin) throw new Error('没有找到 BluetoothLe 插件（不在 Capacitor 环境里？）');
      this._manual_close = false;

      this.log('原生 BLE：初始化插件…');
      await this.plugin.initialize({ androidNeverForLocation: false });

      // 运行时权限：BLUETOOTH_SCAN / BLUETOOTH_CONNECT。
      // initialize() 内部会请求，这里再显式查一次是为了在日志里留下痕迹 ——
      // "扫不到设备"最常见的真实原因就是权限被拒。
      //
      // ⚠️ "权限被拒"和"这个插件版本没有 checkPermissions"是两件事，必须分开：
      //    前者要**抛出**（继续扫只会得到一句莫名其妙的各种空结果），
      //    后者要忽略（initialize 已经请求过一次了）。
      //    第一版把两者写在同一个 catch 里，结果自己抛的"权限被拒"被自己的
      //    catch 吃掉了 —— 症状是权限全拒的时候还在往下扫、最后报"没扫到设备"，
      //    用户去查蓝牙开关永远查不出问题。这个 bug 由 phone/test/native.cjs
      //    第 8 节抓到。
      let perm_error = null;
      try {
        const st = await this.plugin.checkPermissions();
        this.log(`原生 BLE：权限 scan=${st.scan} connect=${st.connect} location=${st.location}`);
        if (st.scan === 'denied' || st.connect === 'denied') {
          const rq = await this.plugin.requestPermissions();
          this.log(`原生 BLE：请求权限后 scan=${rq.scan} connect=${rq.connect}`);
          if (rq.scan === 'denied' || rq.connect === 'denied') {
            perm_error = new Error('蓝牙权限被拒绝（设置 → 应用 → NavPuck → 权限 → 附近的设备）');
          }
        }
      } catch (e) {
        // 只有"插件没有 checkPermissions/requestPermissions"才走到这里
        this.log(`原生 BLE：权限检查跳过（这个插件版本可能没有该接口）：${e}`);
      }
      if (perm_error) throw perm_error;

      this.log('原生 BLE：扫描 NavPuck…');
      const dev = await this.plugin.requestDevice({
        services: [NUS_SERVICE],          // 按 NUS 服务过滤，和 PWA 一致（名字分包发，见 docs/ble.md）
        // 6000ms：骑车场景下用户在点"连接"，等太久体验很差；插件自身也会缓存上次设备。
        optionalServices: [NUS_SERVICE],
        allowDuplicates: false,
      });
      if (!dev || !dev.deviceId) throw new Error('没有扫描到 NavPuck 设备（设备开机了吗？在广播吗？）');

      this.device_id = dev.deviceId;
      this.device_name = dev.name || dev.localName || '(无名)';
      this.log(`原生 BLE：找到 ${this.device_name} (${this.device_id})`);

      // 断开事件要在 connect 之前挂，否则连上立刻掉线会漏掉
      try {
        this._disconnected_handle = await this.plugin.addListener('onDisconnected', this._on_disconnected_ev);
      } catch (e) {
        this.log(`原生 BLE：订阅 onDisconnected 失败（忽略）：${e}`);
      }

      await this._connect_and_subscribe();
    }

    async _connect_and_subscribe() {
      const p = this.plugin;

      this.log('原生 BLE：连接中…');
      // ⚠️ 这里**不**发 onState：状态机归 ble.js 的 _gatt_connect() 统一驱动。
      //    transport 只负责链路，驱动状态会让 connecting 被推两次
      //    （一次这里、一次 _gatt_connect），症状是界面上"连接中…"闪两下、
      //    以及任何数状态迁移的断言都会挂。这个 bug 由 phone/test/native.cjs
      //    第 5 节抓到过一次。
      await p.connect({
        deviceId: this.device_id,
        timeout: 15000,
      });

      // MTU：这是原生路线的核心优势。失败不影响正确性（退到规范默认），只影响速度。
      this.transport_mtu = null;
      try {
        // requestMtu 只在 Android 上有；没有这个方法的平台直接跳过。
        if (typeof p.requestMtu === 'function') await p.requestMtu({ deviceId: this.device_id, mtu: WANT_MTU });
        const m = await p.getMtu({ deviceId: this.device_id });
        const mtu = m && (m.value !== undefined ? m.value : m.mtu);
        if (mtu && mtu >= 23) {
          this.transport_mtu = mtu;
          this.chunk_size_hint = Math.max(CHUNK_FALLBACK, mtu - 3);
          this.log(`原生 BLE：协商 MTU=${mtu}，分片按 ${this.chunk_size_hint} 字节（MTU-3）`);
        }
      } catch (e) {
        this.log(`原生 BLE：MTU 协商/读取失败（退到试探分片）：${e}`);
        this.transport_mtu = null;
      }

      this.log('原生 BLE：发现服务…');
      await p.discoverServices({ deviceId: this.device_id });

      // 订阅 TX（设备 -> 手机）。来的是一条连续字节流，帧边界仍由
      // proto.FrameParser 在 ble.js 里找 —— 这里只负责把字节递上去。
      try {
        this._notify_handle = await p.addListener('onNotification', this._on_notify_ev);
      } catch (e) {
        // 新版插件把通知事件名改成了 onCharacteristicChanged；两个都试。
        this._notify_handle = await p.addListener('onCharacteristicChanged', this._on_notify_ev);
      }
      await p.startNotifications({ deviceId: this.device_id, service: NUS_SERVICE, characteristic: NUS_TX });

      this.connected = true;
      this.log(`原生 BLE：已连接 ${this.device_name}，TX 通知已订阅`);
    }

    async disconnect() {
      this._manual_close = true;
      this.connected = false;
      try {
        if (this._notify_handle && this._notify_handle.remove) await this._notify_handle.remove();
      } catch (e) { this.log(`原生 BLE：取消通知订阅失败（忽略）：${e}`); }
      this._notify_handle = null;
      try {
        if (this._disconnected_handle && this._disconnected_handle.remove) await this._disconnected_handle.remove();
      } catch (e) { /* 忽略 */ }
      this._disconnected_handle = null;
      try {
        if (this.device_id) await this.plugin.disconnect({ deviceId: this.device_id });
      } catch (e) {
        this.log(`原生 BLE：断开时出错（忽略）：${e}`);
      }
      this.device_id = null;
    }

    /**
     * 写一整帧。按当前分片大小切，一片一片 await。
     *
     * 失败一律**抛异常**，让 ble.js 的 _write_frame 走它既有的
     * "整帧作废 + 降档重试"逻辑 —— 分帧正确性只有一处实现（ble.js），
     * 这里不重复一遍，免得两边策略漂移。
     */
    async write_frame(bytes) {
      const p = this.plugin;
      const size = this.chunk_size_hint || 512;
      if (!this.connected || !this.device_id) throw new Error('原生链路未连接');

      for (let i = 0; i < bytes.length; i += size) {
        const chunk = bytes.subarray(i, Math.min(i + size, bytes.length));
        const args = {
          deviceId: this.device_id,
          service: NUS_SERVICE,
          characteristic: NUS_RX,
          value: u8_to_data_view(chunk),
        };
        // Write Without Response 是首选：设备 RX 两个属性都支持（docs/ble.md），
        // 而 with-response 每个分片都要等一个 ATT 确认，1.4KB 底图会慢好几倍。
        if (typeof p.writeWithoutResponse === 'function') {
          await p.writeWithoutResponse(args);
        } else {
          await p.write(args);
        }
      }
      return true;
    }

    /** 主动重连（用户按"重连"，或页面回到前台时补一刀）。 */
    async reconnect() {
      if (!this.device_id) return this.connect();
      this._manual_close = false;
      await this._connect_and_subscribe();
    }
  }

  // -- 小工具 ---------------------------------------------------------------

  /** 原生插件回值可能是 DataView 或 {buffer,byteOffset,byteLength} 或数组。 */
  function data_view_to_u8(v) {
    if (v instanceof Uint8Array) return v;
    if (typeof DataView !== 'undefined' && v instanceof DataView) {
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (v && v.buffer instanceof ArrayBuffer) {
      return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength || v.buffer.byteLength);
    }
    if (Array.isArray(v)) return Uint8Array.from(v);
    if (v && typeof v.length === 'number') return Uint8Array.from(v);
    // 走到这里说明是 base64 字符串（bluetooth-le 的默认序列化）
    return base64_to_u8(String(v));
  }

  /** 送出去的值：DataView 是插件文档里认可的写法。 */
  function u8_to_data_view(u8) {
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  /**
   * base64 -> Uint8Array。
   *
   * ⚠️ 不用 atob：它在 WebView 里有，但 Node（自测）里没有。这里手写一份，
   *    两条路径共用同一段代码，自测才能真的覆盖到它。
   */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64_to_u8(s) {
    const clean = String(s).replace(/[^A-Za-z0-9+/=]/g, '');
    // ⚠️ 必须返回 Uint8Array，不能返回普通数组：调用方（_on_notify_ev）会把它
    //    直接喂给 proto.FrameParser，而解析器读的是 .length 和下标 —— 数组虽然
    //    也能用，但类型契约模糊，会让"到底传的是什么"在别处出错时很难查。
    const out = new Uint8Array(clean.length * 3 >> 2);
    let n = 0, buf = 0, bits = 0;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (ch === '=') break;
      const v = B64.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[n++] = (buf >> bits) & 0xff;
      }
    }
    return out.subarray(0, n);
  }

  return {
    NUS_SERVICE, NUS_RX, NUS_TX,
    CHUNK_CANDIDATES, CHUNK_FALLBACK, WANT_MTU,
    find_capacitor, pick_plugin, available,
    NativeTransport,
    _base64_to_u8: base64_to_u8,
    _data_view_to_u8: data_view_to_u8,
  };
}));
