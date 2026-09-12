/*
 * NavPuck BLE 链路 —— Web Bluetooth + Nordic UART Service。
 *
 * 布局见 docs/ble.md：
 *   Service  6E400001-B5A3-F393-E0A9-E50E24DCCA9E
 *   RX（手机写） 6E400002-...   Write / Write Without Response
 *   TX（手机订阅）6E400003-...   Notify
 *   广播名  NavPuck-XXXX
 *
 * ⚠️ 三个必须照做的点：
 *
 * 1. **页面拿不到协商后的 ATT MTU**（WebBluetoothCG/web-bluetooth#284、
 *    #383 至今没有 API）。所以分片大小只能"试"：先用 512 字节
 *    （Chromium 内部对单次写的上限），失败再退到 20（规范默认 MTU 23 的载荷）。
 *    设备侧对切分点不敏感（它的解析器是流式重组器，1 字节一段都行），
 *    所以退到 20 **只是慢，不会错**。
 *    ⚠️ 这一条只对 Web Bluetooth 成立。在 APK 里走原生插件（见 ble_native.js），
 *       那边 getMtu() 能拿到真实 MTU，分片直接按 MTU-3 算，不用试。
 *
 * 2. **写失败要作废整帧，不能续传。** 设备收到的是字节流，一旦某个分片没写进去，
 *    后面所有分片在它眼里就是错位的 —— 续传会拼出一帧 CRC 永远不对的数据，
 *    而重发整帧的代价只是一次重传。
 *
 * 3. **发送必须排队，且不能把 10Hz 的导航循环卡住。** 一帧 1.4KB 的 NAV_MAP
 *    在 MTU 23 的情况下是 78 个写操作；如果同步做完，导航循环就停了。
 *    所以这里是一个有界队列 + 异步 drain，队满时丢**最旧的 NAV_UPDATE**
 *    （位置信息过时了没意义），但绝不丢 NAV_ROUTE（丢了就整趟没有指引线）。
 *
 *    ⚠️ 这一条有两个不许走样的推论：
 *      a) 腾不出位置时（队列里一个比进来的更不值钱的帧都没有），**route 帧
 *         让队列超额，而不是被丢掉** —— 详见 _make_room_for()。
 *      b) **drain 只许删掉它自己刚写完的那一帧**（按对象认，不按下标认）。
 *         await 期间 send() 会按优先级重排队列，用 `_queue.shift()` 会删掉
 *         别人。曾经就是这样把重锚前的**空片**（total_points == 0）静默吃掉
 *         的：设备因此可能把新旧两个窗口拼成一条嵌合路线，而计数器一直是 0。
 *      c) 任何仍然被丢掉的帧都要**记账 + 进日志**（_count_drop），
 *         route 帧另有 route_frames_dropped 这个"恒为 0"的不变量计数器。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 两条传输路径（PWA / APK）共用一个 BleLink
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 浏览器里 navigator.bluetooth 在 Android WebView 里**不能用**（没有设备选择器，
 * 也没有权限代理），所以 APK 里必须换成原生插件。为了不 fork 这个文件、不把
 * 队列/分片/解析逻辑写两遍，这里开了一个接缝：
 *
 *     new BleLink({ transport: <原生传输对象> })   // 有 transport 就走原生
 *     new BleLink({ navigator: navigator })        // 没有就走 Web Bluetooth（原样）
 *
 * 接缝只覆盖"怎么找设备/连接/写字节/收通知"这四件事。**队列、优先级、
 * 帧解析、看门狗全部只有一份实现**，两条路径共用 —— 那些是协议正确性，
 * 被 golden vector / integration 自测盯着，不能有两份。
 * transport 的接口见 ble_native.js。
 */

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./proto.js'));
  } else {
    root.NavPuckBle = factory(root.NavPuckProto);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (proto) {

  const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';   // 手机 -> 设备（write）
  const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';   // 设备 -> 手机（notify）
  const NAME_PREFIX = 'NavPuck-';

  // 分片试探顺序。第一个能写成功的就是本次连接的 MTU 档位。
  const CHUNK_CANDIDATES = [512, 244, 185, 128, 64, 20];
  // 先用 512 试：如果失败就整体退到这个（规范默认 MTU 23 -> 载荷 20）。
  // 中间几档是 Android 常见的协商结果（247 -> 244），列出来是为了少退几步。
  const CHUNK_FALLBACK = 20;

  // 队列上限（软上限）。够放下一次整条路线（1024 点 = 5 片 ≈ 8KB）再加几帧高频数据。
  const QUEUE_MAX = 256;

  // route 帧的硬上限：队满、且队列里**没有任何比 route 更不值钱的帧**可挤时，
  // route 帧允许把队列撑到这里，而不是被丢掉。理由见 _make_room_for()。
  //
  // 为什么是 2×：一次"发一窗"最多 1 片空片 + ceil(1024/255) = 5 片分片，也就是
  // 6 帧。512 格 = 85 个完整窗口的 route 帧同时压在队列里 —— 真到这一步说明
  // 链路已经完全不排水了（写一直失败/彻底堵死），那时再涨只会白烧内存。
  const QUEUE_HARD_MAX = QUEUE_MAX * 2;

  // 空闲多久没收到任何上行字节就复位解析器（秒）。
  // 半截帧之后不复位的话，解析器会把下一个帧头当载荷吃掉、从此永久失步
  // （见 phone/test/selftest.mjs 里那两条"不会自愈"的断言）。
  const PARSER_IDLE_RESET_S = 1.5;

  /**
   * 一个待发送的帧。
   *
   * priority 越小越先发；kind 用于队满时决定丢谁。
   */
  class OutFrame {
    constructor(bytes, kind, priority) {
      this.bytes = bytes;
      this.kind = kind;            // 'update' | 'route' | 'map' | 'meta' | 'text' | 'ctl'
      this.priority = priority;
    }
    get length() { return this.bytes.length; }
  }

  /**
   * NavPuck 的 BLE 连接。
   *
   * 事件（都是可选的赋值，不是 addEventListener）：
   *   onState(state, info)   state: 'idle'|'connecting'|'up'|'down'
   *   onFrame(frame)         收到一个完整帧（proto.Frame）
   *   onStatus(status)       收到 PUCK_STATUS（proto.PuckStatus）
   *   onLog(line)            诊断日志
   */
  class BleLink {
    constructor(opts) {
      const o = opts || {};
      this.navigator = o.navigator ||
        (typeof navigator !== 'undefined' ? navigator : null);
      this.onState = o.onState || (() => {});
      this.onFrame = o.onFrame || (() => {});
      this.onStatus = o.onStatus || (() => {});
      this.onLog = o.onLog || (() => {});

      // 原生传输（可选）。有它就完全不碰 navigator.bluetooth；
      // 没有它就是原来的 Web Bluetooth 路径。见文件头的说明。
      this.transport = o.transport || null;
      if (this.transport) {
        // 上行字节和断线都由传输对象回调进来，喂的还是下面同一个 FrameParser
        this.transport.onNotify = (bytes) => this._on_notify_bytes(bytes);
        this.transport.onDisconnected = () => this._on_disconnected();
      }

      this.device = null;
      this.server = null;
      this.rx = null;               // 写入特征
      this.tx = null;               // 通知特征
      this.state = 'idle';
      this.device_name = '';
      this.device_status = null;    // 最近一次 PUCK_STATUS

      this.parser = new proto.FrameParser();
      this.chunk_size = 512;        // 当前试探到的分片大小
      this._chunk_known = false;    // 是否已经试探成功过

      this._queue = [];
      this._draining = false;
      this._writing = null;         // 正在写的那一帧（按对象认，见 _drain）
      this._last_rx_t = 0;          // 最近一次收到上行字节的时刻（毫秒）

      // 统计
      //
      // 记账的总不变量（任意时刻都成立，自测按它断言）：
      //     frames_offered === frames_sent + frames_dropped
      // 也就是"交给 send() 的每一帧，要么真的写到了链路上，要么进了丢帧账"。
      // 丢帧账再按原因拆成四个桶（refused/evicted/write_failed/disconnected），
      // 并按 kind 分桶 —— 这样"设备侧少收了 N 帧"永远能对上账，不会变成悬案。
      this.frames_sent = 0;
      this.bytes_sent = 0;
      this.frames_offered = 0;         // 交给 send() 的帧总数
      this.frames_enqueued = 0;        // 真进了队列的帧数
      this.frames_dropped = 0;         // 丢帧总数 = 下面四个桶之和
      this.dropped_refused = 0;        // 队满且腾不出位置 -> 拒收（根本没进队列）
      this.dropped_evicted = 0;        // 队满时被挤掉的那一帧
      this.dropped_write_failed = 0;   // 写失败，整帧作废
      this.dropped_disconnected = 0;   // 链路没了，队列整体清空
      this.dropped_by_kind = {};       // kind -> 丢帧数（四种原因都算进来）
      // route 帧被丢的次数。**不变量：恒为 0** —— 见 _count_drop() 的说明。
      this.route_frames_dropped = 0;
      this.queue_overflow = 0;         // route 帧把队列撑过 QUEUE_MAX 的次数
      this.queue_high_water = 0;       // 队列长度的历史最大值
      this.write_failures = 0;
      this.downgrades = 0;
      this.max_write_ms = 0;
      this.last_write_ms = 0;

      this._want_reconnect = false;
      this._reconnect_attempts = 0;
      this._reconnect_timer = null;

      // 主动断开时不要触发自动重连
      this._manual_close = false;
    }

    // -- 状态 --------------------------------------------------------------
    /**
     * 链路是否可用。
     *
     * 两条路径的判据不同：
     *   - 原生：传输对象自己知道（它连的 GATT）
     *   - Web：device.gatt.connected
     * 但**队列能否发送**的判断必须一致，所以由这里统一。
     */
    get connected() {
      if (this.transport) return !!this.transport.connected;
      return !!(this.device && this.device.gatt && this.device.gatt.connected);
    }

    /** 链路自述（日志/界面用）。 */
    get link_kind() {
      return this.transport ? (this.transport.name || '原生 BLE') : 'Web Bluetooth';
    }

    /**
     * 这个环境有没有 Web Bluetooth。
     *
     * 接受一个可选的 navigator 参数：BleLink 支持注入 navigator（自测用），
     * 而 connect() 用的是注入的那个。如果这里硬查全局 navigator，会出现
     * "注入的 navigator 有 bluetooth、全局的没有 -> supported() 说不行但
     * connect() 其实能跑"这种自相矛盾的状态。
     */
    static supported(nav) {
      const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
      return !!n && !!n.bluetooth && typeof n.bluetooth.requestDevice === 'function';
    }

    /** 本实例所在环境是否支持（看注入的 navigator，不是全局）。 */
    get supported() {
      return BleLink.supported(this.navigator);
    }

    /**
     * 本环境有没有可用传输（原生优先，其次 Web Bluetooth）。
     *
     * 为什么要单独有这个：在 APK 的 WebView 里 `'bluetooth' in navigator`
     * 可能是 **true**（Chromium 有这个 API），但它实际上**不能用** ——
     * WebView 没有设备选择器，也没有权限代理，requestDevice() 会直接失败。
     * 所以判断"能不能用蓝牙"不能只看 navigator.bluetooth，必须先问原生。
     *
     * 参数 root 允许注入（自测用），默认看全局。
     */
    static native_available(root_obj) {
      const r = root_obj || (typeof globalThis !== 'undefined' ? globalThis : null);
      if (!r || !r.NavPuckBleNative || typeof r.NavPuckBleNative.available !== 'function') return false;
      try {
        // ⚠️ available() 要的是**根对象**（它从上面找 Capacitor 桥），不是 navigator。
        //    这里必须把根对象传进去，否则会去 navigator.Capacitor 找一个不存在的
        //    东西，永远返回 false —— "在 APK 里却走了 Web 路径"就是这么来的。
        return !!r.NavPuckBleNative.available(r);
      } catch (_e) {
        // available() 内部要看 Capacitor 桥；抛错一律当作"没有原生"
        return false;
      }
    }

    /**
     * 造一个原生传输对象；没有原生环境就返回 null。
     *
     * app.js 用它来决定"给 BleLink 传不传 transport"。这样 ble.js 自己
     * 不依赖 Capacitor 的加载顺序（ble_native.js 有没有先加载都安全）。
     */
    static make_transport(opts) {
      const r = (opts && opts.root) || (typeof globalThis !== 'undefined' ? globalThis : null);
      if (!BleLink.native_available(r)) return null;
      const T = r.NavPuckBleNative.NativeTransport;
      if (!T) return null;
      return new T(opts || {});
    }

    /** 两条路径任意一条可用。 */
    static usable(nav, root_obj) {
      return BleLink.native_available(root_obj) || BleLink.supported(nav);
    }
    _setState(s, info) {
      this.state = s;
      try { this.onState(s, info || {}); } catch (e) { this._log(`onState 回调抛错：${e}`); }
    }

    _log(line) {
      try { this.onLog(line); } catch (_e) { /* 日志回调本身不能影响链路 */ }
    }

    // -- 连接 --------------------------------------------------------------
    /**
     * 弹出设备选择框并连接。
     *
     * ⚠️ 必须在**用户手势**（click/touch 的同步处理里）调用，否则 Chrome 会
     *    以 SecurityError 拒绝 requestDevice()。所以界面上有一个真正的
     *    <button>，不要在 setTimeout / await 之后才调这个函数。
     */
    async connect() {
      // ── 原生路径（APK 里）──────────────────────────────────────────────
      // transport 存在时完全不碰 navigator.bluetooth：WebView 里的
      // navigator.bluetooth 即使存在也不能用来做 GATT（见文件头说明）。
      if (this.transport) {
        this._manual_close = false;
        // ⚠️ 这里**不**发 'connecting'：_gatt_connect() 会发（两条路径共用同一个
        //    状态机）。多发一次会让"连接中…"闪两下，也让数状态迁移的断言挂掉。
        try {
          await this.transport.connect();
        } catch (e) {
          this._setState('down', { error: String(e) });
          this._log(`原生连接失败：${e}`);
          throw e;
        }
        await this._gatt_connect();
        return;
      }

      if (!this.supported) {
        const msg = '这个浏览器不支持 Web Bluetooth（需要 Android Chrome，且页面在安全上下文里）';
        this._setState('down', { error: msg });
        throw new Error(msg);
      }

      this._manual_close = false;
      this._setState('connecting', {});
      this._log('正在弹出设备选择框…');

      let device;
      try {
        // 按 NUS 服务过滤：广播包里 UUID 和名字是分两个包发的（见 docs/ble.md），
        // 只按服务过滤最稳，名字在界面上再显示。
        device = await this.navigator.bluetooth.requestDevice({
          filters: [{ services: [NUS_SERVICE] }],
          optionalServices: [NUS_SERVICE],
        });
      } catch (e) {
        // 用户在弹框里点了取消 —— 这不是错误，不要报红
        const cancelled = e && (e.name === 'NotFoundError' || /cancel/i.test(String(e.message)));
        this._setState(cancelled ? 'idle' : 'down', { error: cancelled ? '' : String(e) });
        if (cancelled) this._log('用户取消了设备选择');
        else this._log(`requestDevice 失败：${e}`);
        throw e;
      }

      this.device = device;
      this.device_name = device.name || '(无名)';
      if (!this.device_name.startsWith(NAME_PREFIX)) {
        this._log(`⚠️ 设备名 "${this.device_name}" 不以 ${NAME_PREFIX} 开头，可能不是 NavPuck`);
      }

      device.addEventListener('gattserverdisconnected', () => this._on_disconnected());

      await this._gatt_connect();
    }

    async _gatt_connect() {
      // ⚠️ 顺序很重要：`this.device` 只有 Web 路径才会被赋值（原生路径下
      //    transport 才是"设备"）。所以这个检查必须在 transport 分支**之后**，
      //    否则原生连接会在这里直接抛"没有设备" —— 这个 bug 由
      //    phone/test/native.cjs 第 5 节抓到过一次。
      this._setState('connecting', { name: this.device_name });

      // ── 原生路径：传输对象已经连好并订阅了，这里只做"接线到解析器" ──
      if (this.transport) {
        this.device_name = this.transport.device_name || this.device_name || '(无名)';
        this.device = this.transport;      // 只为兼容外部读 link.device 的地方
        this.server = null;
        this.rx = null;
        this.tx = null;
        // 新连接必须复位解析器（上一部手机/上一次连接留下的半截帧会让新连接
        // 从错误状态开始）—— 与 Web 路径逐条相同。
        this.parser.reset();
        // 分片大小直接用协商到的 MTU-3；拿不到就维持乐观值，让 ble.js 的
        // 降档逻辑兜底（那是它本来就有的能力）。
        if (this.transport.chunk_size_hint) this.chunk_size = this.transport.chunk_size_hint;
        this._chunk_known = false;
        this._last_rx_t = Date.now();
        this._reconnect_attempts = 0;
        this._setState('up', { name: this.device_name });
        this._log(`已连接 ${this.device_name}（原生 BLE）` +
                  (this.transport.transport_mtu
                    ? `；MTU=${this.transport.transport_mtu}，分片 ${this.chunk_size} 字节`
                    : '；MTU 未知，分片从试探开始'));
        return;
      }

      // ── Web Bluetooth 路径 ─────────────────────────────────────────────
      const device = this.device;
      if (!device) throw new Error('没有设备（Web Bluetooth 路径要求先 requestDevice）');

      const server = await device.gatt.connect();
      this.server = server;

      const service = await server.getPrimaryService(NUS_SERVICE);
      this.rx = await service.getCharacteristic(NUS_RX);
      this.tx = await service.getCharacteristic(NUS_TX);

      // 设备 -> 手机：订阅通知。来的是一条**连续字节流**，帧边界由 FrameParser 找。
      await this.tx.startNotifications();
      this.tx.addEventListener('characteristicvaluechanged', (ev) => this._on_notify(ev));

      // 新连接必须把解析器和试探到的分片大小都复位：
      // 上一部手机留下的半截帧会让新连接从错误的状态开始
      this.parser.reset();
      this.chunk_size = 512;
      this._chunk_known = false;
      this._last_rx_t = Date.now();

      this._reconnect_attempts = 0;
      this._setState('up', { name: this.device_name });
      this._log(`已连接 ${this.device_name}；通知已订阅，分片从 ${this.chunk_size} 字节开始试探`);
    }

    _on_disconnected() {
      const was_up = this.state === 'up';
      this._log('链路断开（gattserverdisconnected）');
      this.parser.reset();
      this._setState('down', { name: this.device_name });

      if (this._manual_close) return;
      // 设备侧断开后不能立刻重连（Bluedroid 还在拆链路，见 docs/ble.md）；
      // 而且 Chrome 不允许在没有用户手势的情况下重新 requestDevice ——
      // 好在 device 对象还在手上，gatt.connect() 可以直接重连。
      if (was_up) this._schedule_reconnect();
    }

    _schedule_reconnect() {
      if (this._reconnect_timer !== null) return;
      const delay = Math.min(30000, 500 * Math.pow(2, this._reconnect_attempts));
      this._reconnect_attempts += 1;
      this._log(`${(delay / 1000).toFixed(1)} 秒后尝试第 ${this._reconnect_attempts} 次重连…`);
      this._reconnect_timer = setTimeout(async () => {
        this._reconnect_timer = null;
        if (this._manual_close || !this.device) return;
        try {
          await this._gatt_connect();
          this._log('重连成功');
        } catch (e) {
          this._log(`重连失败：${e}`);
          this._schedule_reconnect();
        }
      }, delay);
    }

    /** 手动断开（用户按"断开"）。 */
    async disconnect() {
      this._manual_close = true;
      if (this._reconnect_timer !== null) {
        clearTimeout(this._reconnect_timer);
        this._reconnect_timer = null;
      }
      this._clear_queue('手动断开');
      if (this.transport) {
        try {
          await this.transport.disconnect();
        } catch (e) {
          this._log(`断开时出错（忽略）：${e}`);
        }
        this.parser.reset();
        this._setState('idle', {});
        return;
      }
      try {
        if (this.device && this.device.gatt && this.device.gatt.connected) {
          this.device.gatt.disconnect();
        }
      } catch (e) {
        this._log(`断开时出错（忽略）：${e}`);
      }
      this.parser.reset();
      this._setState('idle', {});
    }

    /** 手动重连（用户按"重连"）。device 还在的话不需要再弹框。 */
    async reconnect() {
      if (!this.device) return this.connect();
      this._manual_close = false;
      if (this._reconnect_timer !== null) {
        clearTimeout(this._reconnect_timer);
        this._reconnect_timer = null;
      }
      this._reconnect_attempts = 0;
      try {
        if (this.transport && this.transport.reconnect) {
          await this.transport.reconnect();
          await this._gatt_connect();
          return;
        }
        await this._gatt_connect();
      } catch (e) {
        this._setState('down', { error: String(e) });
        throw e;
      }
    }

    // -- 上行（设备 -> 手机）-----------------------------------------------
    _on_notify(ev) {
      const dv = ev.target.value;
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      this._on_notify_bytes(bytes);
    }

    /**
     * 上行字节的处理**只有这一份**。
     *
     * Web Bluetooth 的事件（_on_notify）和原生插件的通知（ble_native.js）
     * 都汇聚到这里，所以"帧怎么切、PUCK_STATUS 怎么解、回调怎么发"
     * 在 PWA 和 APK 里逐字节相同 —— 不存在"原生路径另有解析逻辑"的可能。
     */
    _on_notify_bytes(bytes) {
      this._last_rx_t = Date.now();
      let frames;
      try {
        frames = this.parser.feed(bytes);
      } catch (e) {
        this._log(`解析上行数据出错：${e}`);
        this.parser.reset();
        return;
      }
      for (const fr of frames) {
        if (fr.type === proto.MsgType.PUCK_STATUS) {
          try {
            this.device_status = proto.PuckStatus.unpack(fr.payload);
            this.onStatus(this.device_status);
          } catch (e) {
            this._log(`PUCK_STATUS 解析失败：${e}`);
          }
        }
        try { this.onFrame(fr); } catch (e) { this._log(`onFrame 回调抛错：${e}`); }
      }
    }

    /**
     * 空闲看门狗：解析器停在帧中间且一段时间没有新字节 => 判定残帧并复位。
     *
     * 串口/BLE 上"收到半截就断了"是常态（对端重启、上电时序、连接事件丢失）。
     * 不复位的话解析器会永久失步，之后**所有**上行数据都解不出来，界面上
     * 表现为"设备电池一直是空的、链路状态永远不更新"。
     * 由 app.js 的 10Hz 循环驱动（浏览器里不适合再开一个定时器）。
     */
    tick_watchdog(now_ms) {
      const t = now_ms === undefined ? Date.now() : now_ms;
      if (this.parser.is_mid_frame() && (t - this._last_rx_t) > PARSER_IDLE_RESET_S * 1000) {
        this.parser.reset();
        this._last_rx_t = t;
        this._log('上行空闲超时：解析器复位（丢弃残帧）');
      }
    }

    /** 设备自己报的链路状态（PUCK_STATUS.flags 的 bit4）。 */
    get device_link_up() {
      if (!this.device_status) return false;
      return !!(this.device_status.flags & proto.NavFlags.LINK_UP);
    }

    /** 设备电池百分比；没收到过状态就返回 null。 */
    get device_battery_pct() {
      return this.device_status ? this.device_status.battery_pct : null;
    }

    // -- 下行（手机 -> 设备）-----------------------------------------------
    /**
     * 把一帧放进发送队列。
     *
     * kind 用于队满时的取舍：`update`（10Hz 的位置帧）是可以丢的 ——
     * 下一帧 100ms 后就到，丢一帧只是箭头少动一格；`route` 绝对不能丢，
     * 丢了就是整趟没有指引线，而重锚前的**空片**（total_points == 0）丢了
     * 还会让设备把新旧两个窗口拼成一条不存在的路（见 app.js._send_window）。
     *
     * @returns {boolean} 帧是否进了队列（false = 队满被拒收，已记入丢帧账）
     */
    send(frame, kind, priority) {
      const f = new OutFrame(frame, kind || 'ctl', priority === undefined ? 5 : priority);
      this.frames_offered += 1;
      if (this._queue.length >= QUEUE_MAX) {
        // 队满：先腾位置；腾不出来才是真的丢，丢的一定是**进来的这一帧**
        // （route 例外，见 _make_room_for）。
        if (this._make_room_for(f) === 'refused') {
          this._count_drop(f, `队列已满（${QUEUE_MAX}）且没有可挤的帧`, 'dropped_refused');
          return false;
        }
      }
      this._queue.push(f);
      if (this._queue.length > this.queue_high_water) this.queue_high_water = this._queue.length;
      this.frames_enqueued += 1;
      // 按优先级稳定排序：route/ctl/meta 优先于 map，map 优先于 update
      //
      // ⚠️ 这里的 sort() 会在 _drain() 的 await 期间把某一帧挪走 —— 所以
      //    _drain() **必须按对象**删帧，不能按下标删。见 _drain() 里的说明。
      this._queue.sort((a, b) => a.priority - b.priority);
      this._drain();
      return true;
    }

    /**
     * 队满时腾位置。返回：
     *   'evicted'  挤掉了一帧（丢帧账已记）
     *   'grew'     腾不出来，但进来的是 route —— 让它把队列撑大
     *   'refused'  腾不出来，只能丢进来的这一帧
     *
     * 取舍（这是这一版专门钉住的一段，改之前先读文件头第 3 条）：
     *
     *   1. **进来的也是 update 就不挤。** 位置帧下一帧 100ms 后就有，
     *      为它牺牲任何一帧都是净亏 —— 直接丢它自己。
     *   2. 否则挤掉**最不值钱**的那一帧：优先级数字更大 = 更可以先牺牲
     *      （update 5 > text 4 > map 3 > meta 2 > ctl 1 > route 0）；
     *      同一档里挑**最旧**的（下标最小）。实际上第 2 条几乎总是等价于
     *      "丢最旧的 update"，与文件头第 3 条的说法一致。
     *   3. 挤不到（队列里全是 route/ctl 这种比它更值钱的）时：
     *      - 进来的是 **route** -> 让队列超额（'grew'，记 queue_overflow）。
     *        **为什么不是"阻塞一小会儿"**：send() 是在 10Hz 导航循环里
     *        **同步**调用的，而能腾出位置的只有异步的 _drain()。在这里等，
     *        等于让唯一能腾位置的东西永远跑不起来（自我死锁），同时导航循环
     *        也被卡住 —— 那比丢一帧严重得多。所以"让它涨"是唯一既不丢
     *        route、又不卡循环的选择，而且涨幅有界（一次发一窗 ≤ 6 帧）。
     *      - 其它 kind -> 拒收（'refused'）。map/text/ctl 丢一帧都能重来。
     *   4. 真到 QUEUE_HARD_MAX（链路彻底不排水）才连 route 一起拒收，
     *      并且**带计数、带 ⚠️ 日志**地拒 —— 这种丢法绝不能静默。
     *
     * 另外：`_writing`（已经交给链路的正在写的那一帧）永远不动。它的字节
     * 已经发出去了，把它挤掉会让 frames_sent 与设备侧实际收到的帧数对不上。
     */
    _make_room_for(incoming) {
      if (incoming.kind === 'update') return 'refused';   // 连要进来的都是 update，不值得挤
      let worst = -1;                                     // 候选下标
      for (let i = 0; i < this._queue.length; i++) {
        const cand = this._queue[i];
        if (cand === this._writing) continue;
        if (cand.priority <= incoming.priority) continue; // 不比我更不值钱就不动它
        // 优先级数字更大 = 更该牺牲；同级保留先出现的（最旧的）
        if (worst < 0 || cand.priority > this._queue[worst].priority) worst = i;
      }
      if (worst >= 0) {
        const victim = this._queue[worst];
        this._queue.splice(worst, 1);
        this._count_drop(victim, `给 ${incoming.kind} 腾位置`, 'dropped_evicted');
        return 'evicted';
      }
      if (incoming.kind === 'route' && this._queue.length < QUEUE_HARD_MAX) {
        this.queue_overflow += 1;
        return 'grew';
      }
      return 'refused';
    }

    /**
     * 记一笔丢帧 —— **一定要留下痕迹**。
     *
     * 丢帧本身是允许的（update 过时了没意义），但**不许静默**：这一笔进总数、
     * 进原因桶、进 kind 桶、进日志。route 帧还要额外进 route_frames_dropped ——
     * 那个计数器的不变量是"恒为 0"，一旦非 0 就说明取舍逻辑被改坏了：
     * 空片丢了会让设备把新旧两个窗口的点拼成一条**根本不存在的路**
     * （app.js._send_window 里那段说明），而屏幕上只会看到一条乱画出来的线。
     */
    _count_drop(f, why, bucket) {
      const kind = f && f.kind ? f.kind : '?';
      this.frames_dropped += 1;
      this.dropped_by_kind[kind] = (this.dropped_by_kind[kind] || 0) + 1;
      if (bucket) this[bucket] += 1;
      if (kind === 'route') this.route_frames_dropped += 1;
      this._log(`${kind === 'route' ? '⚠️ ' : ''}丢帧：${kind}（${why}）；` +
                `累计丢 ${this.frames_dropped} 帧，其中 route ${this.route_frames_dropped} 帧，` +
                `队列 ${this._queue.length}/${QUEUE_MAX}`);
    }

    /**
     * 清空队列（链路没了 / 用户主动断开）。里面的帧必须**记账**：
     * 重连后 app.js 会把整条路线重发一遍（route_resend_t），所以功能上安全，
     * 但账要平 —— frames_offered === frames_sent + frames_dropped 这条不变量
     * 一旦破了，"设备侧少收的帧"就再也没法归因了。
     *
     * ⚠️ `_writing`（已经交给链路、正在 await 的那一帧）**不算丢**：它不在
     *    "还没发出去"的集合里，_drain() 会在 await 回来后把它结算成
     *    frames_sent 或 dropped_write_failed。把它一起算进丢帧账就会**重复记账**
     *    （同一帧既 sent 又 dropped），那条不变量就白写了。
     */
    _clear_queue(why) {
      const keep = this._writing;
      const lost = this._queue.filter((q) => q !== keep);
      this._queue = keep ? [keep] : [];
      if (lost.length === 0) return 0;
      for (const q of lost) {
        this.dropped_by_kind[q.kind] = (this.dropped_by_kind[q.kind] || 0) + 1;
        if (q.kind === 'route') this.route_frames_dropped += 1;
      }
      this.frames_dropped += lost.length;
      this.dropped_disconnected += lost.length;
      this._log(`${why}：清空发送队列（丢 ${lost.length} 帧，累计丢 ${this.frames_dropped} 帧）`);
      return lost.length;
    }

    /**
     * 发送/丢帧统计快照。界面、日志、自测都读这一份，避免"每个调用点自己
     * 拼一遍数字"而拼错。
     */
    get stats() {
      return {
        frames_offered: this.frames_offered,
        frames_enqueued: this.frames_enqueued,
        frames_sent: this.frames_sent,
        frames_dropped: this.frames_dropped,
        dropped_refused: this.dropped_refused,
        dropped_evicted: this.dropped_evicted,
        dropped_write_failed: this.dropped_write_failed,
        dropped_disconnected: this.dropped_disconnected,
        dropped_by_kind: Object.assign({}, this.dropped_by_kind),
        route_frames_dropped: this.route_frames_dropped,
        queue_overflow: this.queue_overflow,
        queue_high_water: this.queue_high_water,
        queue_length: this._queue.length,
        bytes_sent: this.bytes_sent,
        write_failures: this.write_failures,
        downgrades: this.downgrades,
        chunk_size: this.chunk_size,
      };
    }

    /** "发 / 丢"一行（界面用它，日志也会打）。route 丢帧一定在这里露出来。 */
    get drop_summary() {
      const base = `${this.frames_sent} 发 / ${this.frames_dropped} 丢`;
      return this.route_frames_dropped > 0
        ? `${base}（⚠️ 其中 route ${this.route_frames_dropped}）`
        : base;
    }

    async _drain() {
      if (this._draining) return;
      this._draining = true;
      try {
        while (this._queue.length > 0) {
          // ⚠️ "这条链路有没有写入端"**不能只看 this.rx**。
          //
          //    Web Bluetooth 那条路上写入端是 RX 特征（_gatt_connect 里
          //    `this.rx = await service.getCharacteristic(NUS_RX)`）；但**原生
          //    那条路（APK 里）故意把 rx/tx 都置空**（见 _gatt_connect 的原生
          //    分支），字节由 transport.write_frame() 写下去。
          //
          //    早先这里写的是 `if (!this.connected || !this.rx)`，于是 APK 里
          //    **每一帧**都被判成"链路不可用"整队清掉：NAV_CLOCK 永远到不了
          //    设备（主页永远 --:--），而 send() 照样返回 true、app.js 照样
          //    写"已下发设备时间…"—— 从手机侧看**完全成功**。症状是"连上了、
          //    日志也说发了，设备那边什么都没有"。这个 bug 由
          //    phone/test/native.cjs 第 11 节和 phone/test/ui.mjs 第 11.5 节钉住。
          //
          //    判据改成"这条链路的写入端在不在"：原生看 transport，
          //    Web 看 rx 特征。connected 两条路都要。
          const writable = this.connected && (this.transport ? true : !!this.rx);
          if (!writable) {
            // 链路没了：清空队列。重连之后 app.js 会把整条路线重发一遍
            // （route_resend_t 那条路径），所以这里丢掉是安全的 —— 但**要记账**，
            // 不然"设备侧少收了几帧"就永远对不上账了。
            this._clear_queue('链路不可用');
            return;
          }
          const f = this._queue[0];
          // ⚠️ 正在写的这一帧必须**按对象**认，最后也必须**按对象**删。
          //
          //    上面 await 的那一行会让出事件循环，而 send() 会在让出期间按优先级
          //    重排队列（priority 0 的 route 会插到队首）。如果这里写成
          //    `this._queue.shift()`，删掉的就是**别人** —— 实测就是重锚前的
          //    空片：它被从队列里删掉了，既没写出去、也不在队列里、计数器还是 0，
          //    完全静默；而被挤到后面的那一帧（同一段里是 NAV_CLOCK）反而被写了
          //    两遍。设备侧的 NAV_ROUTE 因此少一片，症状是"设备偶尔收不到空片"。
          this._writing = f;
          let ok = false;
          try {
            ok = await this._write_frame(f.bytes);
          } catch (e) {
            // _write_frame 内部已经把"写失败"变成返回值了；真抛到这里说明是它
            // 自己出了意外。整帧作废并记账，**不能让异常把 _drain 打断**：那样
            // 后面的帧会永远卡在队列里（界面上"发着发着就不发了"，且没有日志），
            // 而且 send() 没有 await 它，异常会变成未处理的 rejection。
            this._log(`写帧时抛出异常（整帧作废）：${e}`);
            ok = false;
          } finally {
            this._writing = null;
          }
          const i = this._queue.indexOf(f);
          if (i >= 0) this._queue.splice(i, 1);
          if (ok) {
            this.frames_sent += 1;
          } else {
            this._count_drop(f, '写失败，整帧作废（不续传）', 'dropped_write_failed');
          }
          // 让出事件循环：不然 78 个写操作的 NAV_MAP 会把界面的 10Hz 循环卡住
          await _yield();
        }
      } finally {
        this._draining = false;
      }
    }

    /**
     * 写一整帧，必要时分片。
     *
     * 分片大小从 this.chunk_size 开始；失败就**整体重启这一帧**并降档重试，
     * 一直降到 20 字节（规范默认 MTU 23 的载荷）为止。
     * 全失败返回 false。
     */
    async _write_frame(bytes) {
      // ── 原生路径 ───────────────────────────────────────────────────────
      // 原生传输对象自己知道 MTU，也自己做分片，所以不用走下面那套
      // "试 512 -> 退 20"的探测。但**降档兜底保留**：如果原生写失败
      // （比如设备侧接收环满、链路抖动），仍然整帧重启并降低分片重试，
      // 策略与 Web 路径完全一致 —— 只有一处实现。
      if (this.transport) {
        const t0n = _now_ms();
        try {
          await this.transport.write_frame(bytes, this.chunk_size);
          const ms = _now_ms() - t0n;
          this.last_write_ms = ms;
          if (ms > this.max_write_ms) this.max_write_ms = ms;
          this.bytes_sent += bytes.length;
          if (!this._chunk_known) {
            this._chunk_known = true;
            this._log(`分片大小确定：${this.chunk_size} 字节（原生 MTU` +
                      `${this.transport.transport_mtu || '未知'}；本帧 ${bytes.length} 字节，` +
                      `耗时 ${ms.toFixed(1)}ms）`);
          }
          return true;
        } catch (e) {
          this.write_failures += 1;
          const next = _next_chunk_size(this.chunk_size);
          if (next === null) {
            this._log(`分片降到 ${this.chunk_size} 字节仍然写失败：${e}`);
            return false;
          }
          this._log(`以 ${this.chunk_size} 字节分片写失败（${e}）；整帧重启，降到 ${next} 字节`);
          this.downgrades += 1;
          this.chunk_size = next;
          // 让 transport 下一轮按新的 chunk_size 分片
          if (this.transport.chunk_size_hint !== undefined) {
            this.transport.chunk_size_hint = next;
          }
          return this._write_frame(bytes);   // 整帧重来（不续传，见文件头第 2 条）
        }
      }

      const tried = new Set();
      while (true) {
        const size = this.chunk_size;
        tried.add(size);
        const t0 = _now_ms();
        try {
          for (let i = 0; i < bytes.length; i += size) {
            await this._write_chunk(bytes.subarray(i, Math.min(i + size, bytes.length)));
          }
          const ms = _now_ms() - t0;
          this.last_write_ms = ms;
          if (ms > this.max_write_ms) this.max_write_ms = ms;
          this.bytes_sent += bytes.length;
          if (!this._chunk_known) {
            this._chunk_known = true;
            this._log(`分片大小确定：${size} 字节（本帧 ${bytes.length} 字节，耗时 ${ms.toFixed(1)}ms）`);
          }
          return true;
        } catch (e) {
          this.write_failures += 1;
          const next = _next_chunk_size(size);
          if (next === null) {
            this._log(`分片降到 ${size} 字节仍然写失败：${e}`);
            return false;
          }
          this._log(`以 ${size} 字节分片写失败（${e}）；整帧重启，降到 ${next} 字节`);
          this.downgrades += 1;
          this.chunk_size = next;
        }
      }
    }

    async _write_chunk(chunk) {
      // Write Without Response 是首选：设备 RX 特征两个属性都给了（见 docs/ble.md），
      // 而 with-response 每个分片都要等一个 ATT 确认，1.4KB 的底图会慢好几倍。
      if (typeof this.rx.writeValueWithoutResponse === 'function') {
        return this.rx.writeValueWithoutResponse(chunk);
      }
      return this.rx.writeValue(chunk);
    }
  }

  /** 降档序列：512 -> 244 -> 185 -> 128 -> 64 -> 20，到底了返回 null。 */
  function _next_chunk_size(cur) {
    for (const c of CHUNK_CANDIDATES) {
      if (c < cur) return c;
    }
    return null;
  }

  function _now_ms() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  /** 让出事件循环（不依赖 setTimeout 的 4ms 最小延迟）。 */
  function _yield() {
    if (typeof scheduler !== 'undefined' && scheduler.yield) return scheduler.yield();
    return new Promise((r) => setTimeout(r, 0));
  }

  return {
    NUS_SERVICE, NUS_RX, NUS_TX, NAME_PREFIX,
    CHUNK_CANDIDATES, CHUNK_FALLBACK, QUEUE_MAX, QUEUE_HARD_MAX, PARSER_IDLE_RESET_S,
    OutFrame, BleLink, _next_chunk_size,
  };
}));
