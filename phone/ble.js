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
 *
 * 2. **写失败要作废整帧，不能续传。** 设备收到的是字节流，一旦某个分片没写进去，
 *    后面所有分片在它眼里就是错位的 —— 续传会拼出一帧 CRC 永远不对的数据，
 *    而重发整帧的代价只是一次重传。
 *
 * 3. **发送必须排队，且不能把 10Hz 的导航循环卡住。** 一帧 1.4KB 的 NAV_MAP
 *    在 MTU 23 的情况下是 78 个写操作；如果同步做完，导航循环就停了。
 *    所以这里是一个有界队列 + 异步 drain，队满时丢**最旧的 NAV_UPDATE**
 *    （位置信息过时了没意义），但绝不丢 NAV_ROUTE（丢了就整趟没有指引线）。
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

  // 队列上限。够放下一次整条路线（1024 点 = 5 片 ≈ 8KB）再加几帧高频数据。
  const QUEUE_MAX = 256;

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
      this._last_rx_t = 0;          // 最近一次收到上行字节的时刻（毫秒）

      // 统计
      this.frames_sent = 0;
      this.bytes_sent = 0;
      this.frames_dropped = 0;
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
    get connected() {
      return !!(this.device && this.device.gatt && this.device.gatt.connected);
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
      const device = this.device;
      if (!device) throw new Error('没有设备');

      this._setState('connecting', { name: this.device_name });

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
      this._queue = [];
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
     * 丢了就是整趟没有指引线。
     */
    send(frame, kind, priority) {
      const f = new OutFrame(frame, kind || 'ctl', priority === undefined ? 5 : priority);
      if (this._queue.length >= QUEUE_MAX) {
        const dropped = this._drop_one_for_space(f);
        if (!dropped) {
          this.frames_dropped += 1;
          this._log(`发送队列已满（${QUEUE_MAX}），丢弃一帧 ${f.kind}`);
          return false;
        }
      }
      this._queue.push(f);
      // 按优先级稳定排序：route/ctl/meta 优先于 map，map 优先于 update
      this._queue.sort((a, b) => a.priority - b.priority);
      this._drain();
      return true;
    }

    /** 队满时腾位置：优先丢掉最旧的 update。返回 true 表示腾出来了。 */
    _drop_one_for_space(incoming) {
      if (incoming.kind === 'update') return false;   // 连要进来的都是 update，那就不值得挤
      for (let i = this._queue.length - 1; i >= 0; i--) {
        if (this._queue[i].kind === 'update') {
          this._queue.splice(i, 1);
          this.frames_dropped += 1;
          return true;
        }
      }
      return false;
    }

    async _drain() {
      if (this._draining) return;
      this._draining = true;
      try {
        while (this._queue.length > 0) {
          if (!this.connected || !this.rx) {
            // 链路没了：清空队列。重连之后 app.js 会把整条路线重发一遍
            // （route_resend_t 那条路径），所以这里丢掉是安全的。
            this._queue = [];
            return;
          }
          const f = this._queue[0];
          const ok = await this._write_frame(f.bytes);
          if (ok) {
            this._queue.shift();
            this.frames_sent += 1;
          } else {
            // 写失败：整帧作废（见文件头第 2 条），队列里这一帧也直接丢掉，
            // 免得每轮都重试同一条注定失败的大帧把循环堵死。
            this._queue.shift();
            this.frames_dropped += 1;
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
    CHUNK_CANDIDATES, CHUNK_FALLBACK, QUEUE_MAX, PARSER_IDLE_RESET_S,
    OutFrame, BleLink, _next_chunk_size,
  };
}));
