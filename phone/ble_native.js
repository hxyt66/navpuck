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
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 这一版修的现场问题：APK 里"连接设备"永远扫不到，同一个手机用网页能连上
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 两个根因，都在这一条路径上：
 *
 *   1) **扫描被绑在了定位上。** 旧代码 initialize({androidNeverForLocation:false})
 *      + 清单里 BLUETOOTH_SCAN 没有 neverForLocation，于是 Android 12+ 要求
 *      "定位权限 + 定位服务开着"才给扫描结果；缺一个就静默地一个设备都扫不到。
 *      网页那条路走 Chrome 自己的实现，不受我们这个清单影响，所以"网页能连"。
 *      现在插件的选项和清单属性都改成 neverForLocation（两处必须成对，见 connect()）。
 *
 *   2) **失败从不说话。** 权限字段读错了名字（真插件按 @Permission 的
 *      alias 返回，见 PERM_REQUIRED 那段注释），"权限被拒"从来没被识别出来，
 *      蓝牙开关也从没查过，最后一律报一句"没有扫描到 NavPuck 设备"。
 *      现在扫描前后都会把权限原文、蓝牙开关、系统里已连接的 GATT 设备、
 *      收到的广播条数写进日志，并按错误码把三种失败分开（见 ERR_*）。
 *
 * ⚠️ 这两条都不是"猜"出来的：插件的 Kotlin 源码、Capacitor 的
 *    Bridge.getPermissionStates()、以及 Android 官方的 neverForLocation 语义
 *    都读过，逐条写在 docs/android.md 里。
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

  /**
   * 一次「连接设备」里的扫描窗口（毫秒）。
   *
   * 6 秒是权衡：骑车现场点一下要等得起，而 BLE 广播间隔通常 20ms~1s，
   * 6 秒足够收到几十条广播；再短就有把"设备刚好这一轮没发到"误判成
   * "没有设备"的风险。测试里用构造参数 `scan_window_ms` 调成 0，
   * 不然每个用例白等 6 秒。
   */
  const SCAN_WINDOW_MS = 6000;

  /** Android scanMode：2 = SCAN_MODE_LOW_LATENCY（前台要快，见插件 definitions.d.ts）。 */
  const SCAN_MODE_LOW_LATENCY = 2;

  /** 名字前缀。ble.js 里有一份权威定义，这里只用来"优先挑哪台"。 */
  const NAME_PREFIX = 'NavPuck-';

  /*
   * 扫描失败的错误码。
   *
   * ⚠️ 界面**按 code 分类**，不去匹配错误文案：文案是给人读的，随时会改；
   *    拿文案当判据的界面和测试都是脆的（改一个字就静默走错分支）。
   *   - PERMISSION  : 权限不足 —— 扫描**根本没跑**；
   *   - ADAPTER_OFF : 蓝牙开关没开 —— 扫描**根本没跑**；
   *   - NO_DEVICE   : 扫描**跑了**（整整 6 秒），一条广播都没收到 —— 设备侧的问题；
   *   - SCAN_FAILED : 插件/系统直接拒绝（initialize / requestLEScan 抛错）。
   * 前两类和第三类必须分得开：把"没扫成"报成"没找到设备"正是这一版要修的
   * 静默失败 —— 用户会一直去查蓝牙开关和设备，而真正的原因在权限上。
   */
  const ERR_PERMISSION  = 'NAV_BLE_PERMISSION_DENIED';
  const ERR_ADAPTER_OFF = 'NAV_BLE_ADAPTER_OFF';
  const ERR_NO_DEVICE   = 'NAV_BLE_NO_DEVICE';
  const ERR_SCAN_FAILED = 'NAV_BLE_SCAN_FAILED';

  /*
   * 权限字段的两种命名。
   *
   * ⚠️ 这里是本文件最容易踩空的一处。Capacitor 的 checkPermissions() 是按
   *    插件 @CapacitorPlugin(permissions = [...]) 里的 **alias 当键**返回的，
   *    而 bluetooth-le 声明的 alias 是：
   *        ACCESS_COARSE_LOCATION / ACCESS_FINE_LOCATION / BLUETOOTH /
   *        BLUETOOTH_ADMIN / BLUETOOTH_SCAN / BLUETOOTH_CONNECT
   *    （证据：node_modules/@capacitor-community/bluetooth-le/android/src/main/
   *      java/com/capacitorjs/community/plugins/bluetoothle/BluetoothLe.kt 第 45-81 行；
   *      键名由 Capacitor 自己生成，见 @capacitor/android 的
   *      capacitor/src/main/java/com/getcapacitor/Bridge.java 第 1220-1271 行
   *      `getPermissionStates()` —— 键取的就是 perm.alias()。）
   *
   *    所以真机上**没有** st.scan / st.connect / st.location 这三个字段：
   *    旧代码读的正是它们，于是日志永远打印 "scan=undefined connect=undefined"，
   *    而 `st.scan === 'denied'` 永远为假 —— "权限被拒"从来没被认出来，
   *    一路走到最后那句"没有扫描到 NavPuck 设备"。
   *    两种命名都认，是为了同时兼容真插件和手写的桩。
   */
  const PERM_REQUIRED = [
    { short: 'scan',    label: '扫描', names: ['BLUETOOTH_SCAN', 'nearbyWifiDevices', 'scan'] },
    { short: 'connect', label: '连接', names: ['BLUETOOTH_CONNECT', 'nearbyWifiDevices', 'connect'] },
  ];
  // 只看不判的两个（诊断用）：定位权限是**导航**要的，扫描这一版已经不依赖它了。
  const PERM_ALL = PERM_REQUIRED.concat([
    { short: 'location', label: '定位', names: ['ACCESS_FINE_LOCATION', 'location', 'fineLocation'] },
    { short: 'locationCoarse', label: '粗略定位', names: ['ACCESS_COARSE_LOCATION', 'coarseLocation'] },
  ]);

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

  /** 按"别名优先、短名兜底"的顺序读一个权限值；都没有就返回 undefined。 */
  function perm_get(st, spec) {
    if (!st) return undefined;
    for (const n of spec.names) if (st[n] !== undefined) return st[n];
    return undefined;
  }

  /** 权限算不算"给了"：真插件返回字符串 'granted'，手写的桩可能是布尔 true。 */
  function perm_ok(v) { return v === 'granted' || v === true; }

  /**
   * checkPermissions() 的返回值摊成一行日志：**先打原文**（将来插件改了键名
   * 一眼就能看见），再用方括号标出归一化后的结果（我们真正读的那几个）。
   */
  function perm_dump(st) {
    if (!st) return '（插件没有返回权限状态）';
    const raw = Object.keys(st).map((k) => `${k}=${st[k]}`).join(' ');
    const norm = PERM_ALL.map((p) => {
      const v = perm_get(st, p);
      return `${p.short}=${v === undefined ? '?' : v}`;
    }).join(' ');
    return `${raw || '(空对象)'} [${norm}]`;
  }

  /** 造一个带**错误码**的错误 —— 界面按 code 分类，不匹配文案。 */
  function scan_error(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
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

      // ── 扫描诊断读数（app.js 会把它们写进界面；见 connect() 里的注释）──────
      /** 扫描窗口。测试里传 0，不然每个用例白等 6 秒。 */
      this.scan_window_ms = (o.scan_window_ms === undefined) ? SCAN_WINDOW_MS : o.scan_window_ms;
      /** 可注入的 sleep（测试里用不到定时器时就别建）。 */
      this._sleep_impl = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
      /** 这一轮到底扫了几条广播 / 几台设备（null = 这个插件版本统计不了）。 */
      this.adverts_seen = 0;
      this.devices_seen = 0;
      /** 'lescan'（能数广播）| 'requestDevice'（老插件的退路，数不了）。 */
      this.scan_mode = null;
      /** 扫描前/申请后的权限状态原文（诊断用，界面读 adverts_seen 为主）。 */
      this.perm_before = null;
      this.perm_after = null;
      /** 系统里当前挂着的 GATT 已连接设备台数（null = 没查/查不到）。 */
      this.system_gatt_links = null;

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
     *   - PWA 里会弹一个系统设备选择框，用户点一下；原生这边**自己扫**，
     *     按 NUS 服务 UUID 过滤、扫满一个 6 秒窗口再挑设备。好处是"不用点"，
     *     坏处是**没有让用户挑设备的机会**。现场如果有两台 NavPuck，
     *     按"名字以 NavPuck- 开头优先，其次信号最强"挑 —— 这台机器上无法验证，
     *     如实记在 docs/android.md 的"未验证"一节。
     *   - 没有用户手势的要求，所以可以在 10Hz 循环里自动重连（PWA 做不到，
     *     见 ble.js 的 _schedule_reconnect 注释）。
     *
     * ⚠️ 这一版把"扫不到设备"拆成了**三种说得出区别**的失败（见 ERR_* 常量）：
     *    权限不足 / 蓝牙没开 = 扫描根本没跑；扫完了但 0 条广播 = 设备侧的问题。
     *    混成一句"没有扫描到 NavPuck 设备"会让用户永远查错方向。
     */
    async connect() {
      if (!this.plugin) throw new Error('没有找到 BluetoothLe 插件（不在 Capacitor 环境里？）');
      this._manual_close = false;

      this.adverts_seen = 0;
      this.devices_seen = 0;
      this.scan_mode = null;
      this.perm_before = null;
      this.perm_after = null;
      this.system_gatt_links = null;

      // ── 1) 初始化插件 ────────────────────────────────────────────────────
      //
      // androidNeverForLocation: true 必须和 AndroidManifest.xml 里
      // BLUETOOTH_SCAN 上的 android:usesPermissionFlags="neverForLocation"
      // **成对**出现，缺一个都不生效：
      //
      //   · 插件这一侧（BluetoothLe.kt 第 104-128 行）：这个开关决定
      //     initialize() 申请、并要求哪几个权限别名 ——
      //         true  => [BLUETOOTH_SCAN, BLUETOOTH_CONNECT]
      //         false => [BLUETOOTH_SCAN, BLUETOOTH_CONNECT, ACCESS_FINE_LOCATION]
      //     然后第 130-141 行要求**每一个**都是 GRANTED，否则
      //     reject("Permission denied.")。所以 false 的时候，定位权限被拒 =
      //     连 initialize 都过不去，而这条错误在旧代码里是原样往上抛的
      //     （界面上只看到一句"链路断开"）。
      //   · 清单这一侧：Android 12+ 只有在 BLUETOOTH_SCAN 上带了
      //     neverForLocation，系统才**不**把"能拿到扫描结果"与
      //     ACCESS_FINE_LOCATION + **定位服务开关**绑定。插件 README 第 139-161 行
      //     把这两步写成了必须同时做的两个步骤（并链到 Android 官方文档）。
      //
      // 这两个位置就是"同一个手机、网页能连、APK 扫不到"的根因：网页走 Chrome
      // 自己的权限与扫描实现，完全不受我们这个清单影响。定位权限仍然保留 ——
      // 导航要 GPS，这里只是让**扫描**不再依赖它。
      this.log('原生 BLE：初始化插件（androidNeverForLocation=true：扫描不再依赖定位权限）…');
      try {
        await this.plugin.initialize({ androidNeverForLocation: true });
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/permission/i.test(msg)) {
          this.log(`原生 BLE：initialize() 被拒：${msg}`);
          this.perm_before = await this._read_permissions('initialize 被拒后');
          throw scan_error(ERR_PERMISSION,
            this._perm_text(this.perm_before, 'initialize() 申请权限时被拒'));
        }
        throw scan_error(ERR_SCAN_FAILED, `插件 initialize() 失败：${msg}`);
      }

      // ── 2) 权限：先记下来，再决定能不能往下扫 ────────────────────────────
      //
      // initialize() 内部已经申请过一次；这里再查一次的价值是**把状态写进日志**
      // （"扫不到设备"最常见的真实原因就是权限），以及把"用户后来在系统设置里
      // 关掉了权限"这种情况堵住。字段名坑见 PERM_REQUIRED 上面那段注释。
      const st = await this._read_permissions('扫描前');
      this.perm_before = st;
      const not_granted = PERM_REQUIRED.filter((p) => {
        const v = perm_get(st, p);
        return v !== undefined && !perm_ok(v);
      });
      if (not_granted.length) {
        this.log(`原生 BLE：${not_granted.map((p) => p.short).join('、')} 不是 granted，再申请一次…`);
        let after = null;
        try {
          after = await this.plugin.requestPermissions();
          this._log_permissions('申请后', after);
        } catch (e) {
          this.log(`原生 BLE：requestPermissions() 失败：${e}`);
        }
        this.perm_after = after || st;
        // ⚠️ 只把**明确的 denied** 当成"被拒"。Android 11 及以下根本没有
        //    BLUETOOTH_SCAN 这个运行时权限，Capacitor 会把它报成 'prompt'；
        //    把 'prompt' 也当成被拒的话，老手机上会永远连不上。
        const denied = PERM_REQUIRED.filter((p) => perm_get(this.perm_after, p) === 'denied');
        if (denied.length) {
          throw scan_error(ERR_PERMISSION, this._perm_text(this.perm_after, '申请权限之后仍然被拒'));
        }
      }

      // ── 3) 蓝牙开关 ─────────────────────────────────────────────────────
      //
      // 蓝牙关着的时候 Android **不报错**，startScan 只是永远不回调 ——
      // 这就是"看起来像没有设备"里最容易被误判的一种。所以必须先问一次，
      // 问到的值也写进日志（用户拿日志来问的时候，这一行就是答案）。
      const enabled = await this._adapter_enabled();
      if (enabled === false) {
        throw scan_error(ERR_ADAPTER_OFF,
          '手机蓝牙是关闭的（isEnabled=false）：蓝牙关着时扫描不报错，只会一直返回空结果，' +
          '看起来和"设备没开机"一模一样。请在系统里打开蓝牙，再回到本页点「重试扫描」。');
      }

      // ── 4) 先把上一次的连接放掉（BLE 外设被连着就不广播）────────────────
      await this._release_own_link();
      await this._log_system_gatt_links();

      // ── 5) 扫描 ─────────────────────────────────────────────────────────
      this.log(`原生 BLE：扫描 NavPuck（窗口 ${(this.scan_window_ms / 1000).toFixed(1)} 秒）…`);
      const dev = await this._scan_for_device();
      if (!dev) throw scan_error(ERR_NO_DEVICE, this._no_device_text());

      this.device_id = dev.deviceId;
      this.device_name = dev.name || '(无名)';
      if (!String(this.device_name).startsWith(NAME_PREFIX)) {
        this.log(`⚠️ 原生 BLE：选中的设备名 "${this.device_name}" 不以 ${NAME_PREFIX} 开头，可能不是 NavPuck`);
      }
      const adv = (this.adverts_seen === null) ? '?' : this.adverts_seen;
      const ndev = (this.devices_seen === null) ? '?' : this.devices_seen;
      this.log(`原生 BLE：找到 ${this.device_name} (${this.device_id})` +
               `（这一轮收到 ${adv} 条广播、${ndev} 台设备）`);

      // 断开事件要在 connect 之前挂，否则连上立刻掉线会漏掉
      try {
        this._disconnected_handle = await this.plugin.addListener('onDisconnected', this._on_disconnected_ev);
      } catch (e) {
        this.log(`原生 BLE：订阅 onDisconnected 失败（忽略）：${e}`);
      }

      await this._connect_and_subscribe();
    }

    // ── 扫描诊断的小工具（都在 connect() 里用）─────────────────────────────

    /** 查一次权限状态并**原样**写进日志。查不到（老插件）不是错误，返回 null。 */
    async _read_permissions(tag) {
      if (typeof this.plugin.checkPermissions !== 'function') {
        this.log(`原生 BLE：权限状态（${tag}）：这个插件版本没有 checkPermissions()，跳过`);
        return null;
      }
      try {
        const st = await this.plugin.checkPermissions();
        this._log_permissions(tag, st);
        return st;
      } catch (e) {
        this.log(`原生 BLE：权限状态（${tag}）：查询失败（忽略）：${e}`);
        return null;
      }
    }

    _log_permissions(tag, st) {
      this.log(`原生 BLE：权限状态（${tag}）：${perm_dump(st)}`);
    }

    /**
     * 权限被拒时给用户的一句话：**点名是哪一个**、说清楚扫描离了它就不行、
     * 以及去哪儿开。不能只说"权限被拒"，更不能退化成"没找到设备"。
     */
    _perm_text(st, phase) {
      const denied = PERM_REQUIRED.filter((p) => perm_get(st, p) === 'denied');
      const who = denied.length
        ? denied.map((p) => `${p.label}权限（${p.names[0]}=denied）`).join('、')
        : `扫描/连接权限（当前读到的是：${perm_dump(st)}）`;
      return `蓝牙权限被拒绝：${who}。扫描离了「附近的设备」权限一个设备都看不到 —— ` +
             `这不是"设备没开机"（${phase}）。请到 设置 → 应用 → NavPuck → 权限 → 附近的设备 ` +
             `里允许，再回到本页点「重试扫描」。`;
    }

    /** 蓝牙适配器开着吗？读不到就返回 null（不阻塞连接）。 */
    async _adapter_enabled() {
      if (typeof this.plugin.isEnabled !== 'function') {
        this.log('原生 BLE：蓝牙开关状态：这个插件版本没有 isEnabled()，跳过检查');
        return null;
      }
      try {
        const r = await this.plugin.isEnabled();
        const on = (r && (r.value !== undefined ? r.value : r.enabled)) === true;
        this.log(`原生 BLE：蓝牙适配器 isEnabled=${on}`);
        return on;
      } catch (e) {
        this.log(`原生 BLE：蓝牙开关状态：isEnabled() 失败（忽略）：${e}`);
        return null;
      }
    }

    /**
     * 把**我们自己**上一次建的 GATT 连接放掉。
     *
     * 为什么要在扫描前做：BLE 外设一旦被某个中心连着就**停止广播**，
     * 于是"设备正连着别处"和"设备没开机"在扫描侧完全一样。我们自己建的连接
     * 我们能关；网页（Chrome 进程）或别的 App 持有的连接我们关不掉 ——
     * 那一种只能在日志和界面提示里说清楚（见 _log_system_gatt_links 和
     * app.js 的扫描失败提示）。
     */
    async _release_own_link() {
      if (!this.device_id) return;
      const id = this.device_id;
      const name = this.device_name || id;
      try {
        await this.plugin.disconnect({ deviceId: id });
        this.log(`原生 BLE：扫描前先断开上一次的 GATT 连接（${name}）—— 连着的时候设备不广播`);
      } catch (e) {
        this.log(`原生 BLE：断开上一次的连接失败（继续扫描）：${e}`);
      }
      this.device_id = null;
      this.connected = false;
    }

    /**
     * 把系统里当前已连接的 GATT 设备列出来（只记日志）。
     *
     * 这一条是给"设备连着别处"这个第七可能性留的证据：如果 NavPuck 出现在
     * 这个列表里而扫描又是空的，答案就摆在那儿了 —— 不需要用户猜。
     */
    async _log_system_gatt_links() {
      if (typeof this.plugin.getConnectedDevices !== 'function') return;
      try {
        const r = await this.plugin.getConnectedDevices();
        const list = (r && r.devices) || [];
        this.system_gatt_links = list.length;
        if (!list.length) {
          this.log('原生 BLE：系统里当前没有别的 GATT 已连接设备');
          return;
        }
        const names = list.map((d) => `${d.name || '(无名)'}(${d.deviceId || '?'})`).join('、');
        this.log(`原生 BLE：系统里现在有 ${list.length} 台 GATT 已连接设备：${names} —— ` +
                 '如果 NavPuck 在其中，它就不会广播，扫描必然为空（那个连接是别的 App/网页持有的，本 App 释放不了）');
      } catch (e) {
        this.log(`原生 BLE：getConnectedDevices() 失败（忽略）：${e}`);
      }
    }

    /** 可注入的等待；窗口 <= 0 时连定时器都不建（自测里全是这一种）。 */
    _sleep(ms) {
      if (!(ms > 0)) return Promise.resolve();
      return this._sleep_impl(ms);
    }

    /**
     * 扫一轮，返回挑中的设备（没扫到返回 null）。
     *
     * 用 requestLEScan 而不是 requestDevice，理由是**能数广播**，也是唯一能
     * 把"扫完了但什么都没有"和"根本没扫成"分开的办法：
     *   - requestLEScan + onScanResult：每条广播都回调，可以数条数、去重设备、
     *     自己控制 6 秒窗口，**不弹**插件的设备选择框（Android 上 requestDevice
     *     是 showDialog=true，会弹一个 AlertDialog，且 30 秒超时之后那个 Promise
     *     既不 resolve 也不 reject，见 DeviceScanner.kt / BluetoothLe.kt 第 307-346 行）；
     *   - 老版本插件没有 requestLEScan 时退回 requestDevice：能连上，但广播条数
     *     只能记成 null（**不编数**，界面会显示 "?"）。
     */
    async _scan_for_device() {
      const p = this.plugin;

      if (typeof p.requestLEScan !== 'function') {
        this.scan_mode = 'requestDevice';
        this.log('原生 BLE：这个插件版本没有 requestLEScan，退回 requestDevice（无法统计广播条数）');
        const dev = await p.requestDevice({
          services: [NUS_SERVICE],        // 按 NUS 服务过滤，和 PWA 一致（名字分包发，见 docs/ble.md）
          optionalServices: [NUS_SERVICE],
          allowDuplicates: false,
        });
        this.adverts_seen = null;
        this.devices_seen = null;
        if (!dev || !dev.deviceId) return null;
        return { deviceId: dev.deviceId, name: dev.name || dev.localName || '' };
      }

      this.scan_mode = 'lescan';
      const seen = new Map();       // deviceId -> {deviceId,name,rssi,count}
      let adverts = 0;
      const on_result = (r) => {
        const d = r && r.device;
        if (!d || !d.deviceId) return;
        adverts += 1;
        const name = d.name || d.localName || r.localName || '';
        const prev = seen.get(d.deviceId);
        if (prev) {
          prev.count += 1;
          if (typeof r.rssi === 'number') prev.rssi = r.rssi;
          if (!prev.name && name) prev.name = name;
        } else {
          seen.set(d.deviceId, {
            deviceId: d.deviceId,
            name,
            rssi: (typeof r.rssi === 'number') ? r.rssi : null,
            count: 1,
          });
        }
      };

      // ⚠️ 监听必须在 requestLEScan **之前**挂上：插件是在 requestLEScan 之后
      //    才开始 notifyListeners('onScanResult') 的，先扫后挂会漏掉开头几条。
      let handle = null;
      try {
        handle = await p.addListener('onScanResult', on_result);
      } catch (e) {
        this.log(`原生 BLE：订阅 onScanResult 失败（继续扫，但数不到条数）：${e}`);
      }

      try {
        await p.requestLEScan({
          services: [NUS_SERVICE],
          optionalServices: [NUS_SERVICE],
          allowDuplicates: true,              // 要**每一条**广播才数得准（插件默认会丢重复）
          scanMode: SCAN_MODE_LOW_LATENCY,    // 前台、点一下要马上有结果
        });
      } catch (e) {
        await this._stop_scan(handle);
        throw scan_error(ERR_SCAN_FAILED, `蓝牙扫描接口报错（requestLEScan 被拒）：${e}`);
      }

      await this._sleep(this.scan_window_ms);
      await this._stop_scan(handle);

      this.adverts_seen = adverts;
      this.devices_seen = seen.size;
      const list = [...seen.values()]
        .map((d) => `${d.name || '(无名)'}(${d.deviceId} rssi=${d.rssi === null ? '?' : d.rssi}×${d.count})`)
        .join('、');
      this.log(`原生 BLE：扫描结束，收到 ${adverts} 条广播 / ${seen.size} 台设备` +
               (list ? `：${list}` : '（一条都没有）'));

      if (!seen.size) return null;
      return pick_device(seen);
    }

    /** 停扫描 + 摘监听，两步都不允许把异常带出去。 */
    async _stop_scan(handle) {
      try {
        await this.plugin.stopLEScan();
      } catch (e) {
        this.log(`原生 BLE：stopLEScan() 失败（忽略）：${e}`);
      }
      if (handle && typeof handle.remove === 'function') {
        try { await handle.remove(); } catch (e) { /* 忽略 */ }
      }
    }

    /**
     * "扫完了但一条广播都没有"该怎么说。
     *
     * 这句话必须和"权限被拒/蓝牙没开"明显不同：那两种是**扫描没跑**，
     * 这一种是扫描跑了、权限和开关都正常，问题在设备侧。最可能的原因是
     * 外设正被别的中心连着（刚才的网页、上一个 App）而停止广播。
     */
    _no_device_text() {
      const secs = (this.scan_window_ms / 1000).toFixed(1);
      const extra = (this.system_gatt_links > 0)
        ? `另外，系统里现在有 ${this.system_gatt_links} 台 GATT 已连接设备，NavPuck 可能就是其中之一。`
        : '';
      return `扫描已经跑完（${secs} 秒，收到 0 条广播）：权限和蓝牙开关都正常，` +
             `所以不是"扫不成"，是真的一条广播都没收到。` +
             `最可能的原因是设备正被别的中心连着（刚才的网页 / 上一个 App）——` +
             `BLE 外设一旦被连上就会停止广播。${extra}` +
             `请在那边先断开，或给设备断电重启，然后点「重试扫描」。`;
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

  /**
   * 从扫到的一堆设备里挑一台。
   *
   * 通道只按 NUS 服务过滤（广播包里 UUID 和名字是分两个包发的，见 docs/ble.md），
   * 所以名字完全可能是空的。优先级：
   *   1) 名字以 NavPuck- 开头的（最确定是它）；
   *   2) 信号最强的（现场有两台 NavPuck 时挑最近的那台；rssi 拿不到就按扫到的先后）。
   */
  function pick_device(seen) {
    const list = [...seen.values()];
    const named = list.filter((d) => String(d.name || '').startsWith(NAME_PREFIX));
    const pool = named.length ? named : list;
    let best = pool[0];
    for (const d of pool) {
      if (d.rssi !== null && (best.rssi === null || d.rssi > best.rssi)) best = d;
    }
    return best;
  }

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
    SCAN_WINDOW_MS, SCAN_MODE_LOW_LATENCY, NAME_PREFIX,
    ERR_PERMISSION, ERR_ADAPTER_OFF, ERR_NO_DEVICE, ERR_SCAN_FAILED,
    find_capacitor, pick_plugin, available,
    NativeTransport,
    _base64_to_u8: base64_to_u8,
    _data_view_to_u8: data_view_to_u8,
    _perm_get: perm_get,
    _perm_dump: perm_dump,
    _pick_device: pick_device,
  };
}));
