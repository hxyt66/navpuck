/*
 * NavPuck 手机端导航大脑 —— tools/navigator.py 的 Navigator 主循环移植。
 *
 * 职责：把"路线 + 当前位置"变成设备能直接画的画面。
 *   1) OSRM 规划 -> 一条真实沿道路的折线 -> Route（带弧长索引 + 路口识别）
 *   2) 整条路线抽稀成**均匀步长**的点集（米，相对路线起点），分片发一次
 *   3) 10Hz 发 NAV_UPDATE：车在哪、朝哪、视距多大、下一个动作点在第几个点
 *   4) 低频发 NAV_MAP：Overpass 抓来的街道路网，同一坐标系
 *
 * ⚠️ 与 PC 版**完全一致**的几个决定（照着 navigator.py 抄的，别"优化"）：
 *
 *   - 视野**固定** ROUTE_FAR_M = 160m，不做"接近路口自动拉近"。
 *     实测那个"地图自己忽远忽近"的观感很打扰，而且更容易误判距离。
 *   - 原点固定在**路线起点**，不是当前位置。所以路线和底图是静态数据，
 *     设备自己平移+旋转；蓝线不闪不漂。
 *   - **路线必须定期整条重发**（30 秒）。只发一次的话，丢一个分片就整趟
 *     没有指引线，而且设备上没有任何提示 —— 比反复重发糟糕得多。
 *     （docs/protocol.md 写的是"出发时一次"，但 navigator.py 从
 *     ROUTE_RESEND_PERIOD_S 起就是 30 秒兜底重发，以代码为准。设备忽略
 *     逐字节相同的重传、不重画，所以代价可忽略：4KB / 30s ≈ 0.13KB/s。）
 *   - 链路刚从断到通时补发一次（覆盖"板子重启了、手机并不知道"）。
 *   - 路网底图抓取**绝不能**阻塞导航循环（PC 版被 Overpass 超时卡过 30 秒）。
 *
 * ⚠️ v1 的硬约束（navigator.py 文档里也写了，这里再写一遍）：
 *   设备没有磁力计，所以"相对车头方位"必须由大脑提供，这意味着**手机必须和
 *   设备固定在车上、朝向一致**。手机放口袋里时 rel_bearing 没有意义。
 */

'use strict';

(function (root) {
  const nm = root.NavPuckMath;
  const proto = root.NavPuckProto;
  const rt = root.NavPuckRoute;
  const mapmod = root.NavPuckMap;
  // 地图视图（Canvas 画路网，见 phone/mapview.js）。**可以缺席**：文件没加载
  // 成功时地图那一块显示"模块没加载"，导航/蓝牙/10Hz 一条都不受影响 ——
  // 和 mapmod 的容错是同一个路数，但这个是"用户能看到地图"的唯一入口，
  // 所以缺席时必须说清楚（见 App.mapview_instance）。
  const mvmod = root.NavPuckMapView;
  // 地点搜索（Photon，见 phone/search.js）。**可以缺席**：文件没加载成功时
  // 搜索那一栏会写"搜索模块没加载"，手输经纬度/常用地点照常能用。
  const srch = root.NavPuckSearch;

  // 界面选项的持久化键。手机上的 PWA 每次打开都要重新勾一遍很烦，而
  // "关掉街道路网底图"（省流量、省电、Overpass 挂了）恰恰正是要记住的选择。
  const PREF_MAP_KEY = 'navpuck.opt.map.v1';

  // 搜索结果里"离得太远"的阈值（米）。超过它就把那一条标出来
  // （黄框 + 黄字距离）—— 这是"搜到了别的城市/省份"唯一能被一眼看出来的
  // 地方：不带位置偏置搜「西湖」拿到的那个同名地点在 800 公里外，
  // 光看名字和"浙江省杭州市"这种副标题是分不出来的（副标题也可能是空的）。
  const SEARCH_FAR_M = 50000.0;

  // ⚠️ "底图已关闭"那句话**只有 map.js 里那一份**（OsmMapSource.status() 也用
  //    它）。这里取出同一个常量，是为了 map.js 自己都没加载成功时（底图源都
  //    建不起来）也能说同一句话，而不是另写一份、两边慢慢分叉。
  const MAP_DISABLED_TEXT = (mapmod && mapmod.MAP_DISABLED_TEXT) ||
    '街道路网底图已关闭：不再向 Overpass 发任何请求。不影响导航 —— ' +
    '路线、箭头、转向提示和 10Hz 更新都照常。';

  // NAV_CLOCK（设备上的时间）多久重发一次，毫秒。
  //
  // 设备**没有电池 RTC**，时间只能由这边推过去（见 set_link_state 里的说明）。
  // 30 秒是"足够纠正漂移、又不至于浪费带宽"的那个点：ESP32 的晶振日漂移在
  // **秒**量级，30 秒最多漂几毫秒，只要保证"分钟"永远对就够了。
  // 这个数和 tools/navigator.py 的 CLOCK_SEND_PERIOD_S = 30.0 是**同一个数**，
  // 改一边记得改另一边（两端行为要一致，否则"手机好好的、PC 上是 --:--"）。
  const CLOCK_RESEND_MS = 30000;
  // 同一个周期，秒为单位 —— Navigator.cycle(dt_s) 用的是秒（与 navigator.py 一致）。
  const CLOCK_SEND_PERIOD_S = CLOCK_RESEND_MS / 1000.0;

  // -------------------------------------------------------------------------
  // 后台限流：怎么判定"循环已经没在跑 10Hz 了"
  // -------------------------------------------------------------------------
  //
  // 浏览器对**后台标签页**的定时器有硬性节流：Chrome 把 setInterval 压到大约
  // 1 秒一次（再叠加"页面被冻结"时干脆一次都不跑）。这不是 bug，也没有 API
  // 能关掉它 —— 骑手把页面切到后台（或者锁屏看设备）时，设备那边就会从
  // 10Hz 掉到 ~1Hz，画面明显变卡。
  //
  // 我们能做的只有两件事，都在这一版里：
  //   1. **屏幕常亮**（Screen Wake Lock，见 ScreenWakeLock）：屏幕亮着、
  //      页面留在前台，浏览器就不会节流。这是唯一"真的有用"的那一条。
  //   2. **把症状说出来**：一旦实测的循环周期超过阈值，状态面板直接写
  //      "页面在后台，帧率已降"，并往日志写一行 —— 用户就不会以为导航坏了。
  //
  // 阈值取 400ms：10Hz 的正常周期是 100ms，4 倍留足了抖动余量（一次 GC、
  // 一次布局都可能吃掉几十毫秒），而后台节流的 1000ms 是这个阈值的 2.5 倍，
  // 所以"偶尔抖一下"和"真的被限流"在数值上分得开。
  const LOOP_SLOW_MS = 400.0;

  // -------------------------------------------------------------------------
  // 原生（APK）扫描失败：三种失败**必须**看得出区别
  // -------------------------------------------------------------------------
  //
  // 用户报的现象是"APK 里点连接设备报没找到设备，同一个手机用网页能连上"。
  // 根因在 ble_native.js（扫描被绑在定位权限上）里修掉了，但**另一个**问题是
  // 它从来不说人话：权限被拒、蓝牙没开、扫完了但没有广播，这三种以前都只显示
  // 一句"没找到设备" —— 而它们的修法完全不同（开权限 / 开蓝牙 / 去断开别处
  // 的连接或给设备上电）。用户没法自己分类，就只能反复试。
  //
  // 判据是 ble_native.js 抛出的 **错误码**（err.code），不是错误文案：
  // 文案随时会改，用文案做判据的界面和测试都是脆的。
  //
  // state 用的是和 #gps-state / #map-info 同一套配色约定：
  //   bad  = 红（扫描**根本没跑**）; warn = 黄（跑了但没收到）; ok = 绿。
  const SCAN_FAIL = {
    NAV_BLE_PERMISSION_DENIED: {
      state: 'bad',
      lead: '扫描没能开始：蓝牙权限被拒绝。',
      hint: '⚠️ 这一条不是"设备没开机"：扫描根本没跑起来。没有「附近的设备」权限时，' +
            'Android 不报错，只是永远返回空结果。请到 设置 → 应用 → NavPuck → 权限 → ' +
            '附近的设备 里允许，回到本页点「重试扫描」。',
    },
    NAV_BLE_ADAPTER_OFF: {
      state: 'bad',
      lead: '扫描没能开始：手机的蓝牙是关闭的。',
      hint: '⚠️ 蓝牙关着时同样不报错、只返回空结果 —— 和"没有设备"看起来一模一样，' +
            '但修法完全不同。请在系统里打开蓝牙，再点「重试扫描」。',
    },
    NAV_BLE_SCAN_FAILED: {
      state: 'bad',
      lead: '扫描没能开始：蓝牙扫描接口直接报错。',
      hint: '这是插件/系统当场拒绝（不是"没扫到"）。具体原文看下面那一行；' +
            '点「重试扫描」可以再来一次。',
    },
    NAV_BLE_NO_DEVICE: {
      state: 'warn',
      lead: '扫描已经跑完，但一条 NavPuck 广播都没收到。',
      hint: '⚠️ 这一条和上面两种不是一回事：权限和蓝牙开关都正常，扫描真的执行了。' +
            '最常见的解释是设备正被别的中心连着（刚才的网页 / 上一个 App）——' +
            'BLE 外设一旦被连上就会停止广播；其次才是设备没上电。' +
            '请先在那边断开（或关掉那个页面），或给设备断电重启，然后点「重试扫描」。',
    },
  };

  /** 错误 -> SCAN_FAIL 的键；没有错误码（Web 路径 / 老插件）返回 null。 */
  function scan_fail_kind(e) {
    const code = e && e.code;
    return (typeof code === 'string' && SCAN_FAIL[code]) ? code : null;
  }

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------
  const $ = (id) => {
    const el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    return el;
  };

  function fmt(v, digits) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return v.toFixed(digits === undefined ? 1 : digits);
  }

  function now_ms() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  // -------------------------------------------------------------------------
  // 位置源：浏览器的 navigator.geolocation
  // -------------------------------------------------------------------------
  /**
   * 手机自己的位置和航向。
   *
   * 航向（heading）的处理**刻意模仿** navigator.py 里 NmeaSource 的做法：
   * 低速时 GPS 的对地航向（COG）不可靠，所以速度低于 2 m/s 时**沿用上一次
   * 的有效航向**。这不是偷懒 —— 纯 GPS 定向方案的根本缺陷就在这里，也是
   * 为什么 docs/roadmap.md 里要给设备加磁力计。
   *
   * 另外手机静止时 GeolocationPosition.coords.heading 是 null，所以"上一次
   * 有效航向"这条路径在等红灯时会一直生效 —— 这正是我们想要的（车头没转，
   * 地图就不该转）。
   */
  class GeoSource {
    constructor(opts) {
      const o = opts || {};
      this.geolocation = o.geolocation ||
        (typeof navigator !== 'undefined' ? navigator.geolocation : null);
      this.onLog = o.onLog || (() => {});
      this.onState = o.onState || (() => {});   // 'ok' | 'waiting' | 'denied' | 'unavailable'

      this.lat = null;
      this.lon = null;
      this.accuracy_m = null;
      this.speed_mps = 0.0;
      this.heading = null;          // 最近一次有效航向（罗盘方位）
      this.heading_source = '';     // 'gps' | 'held' | 'route'
      this.last_fix_t = 0;
      this.fix_count = 0;
      this.error = '';
      this._watch_id = null;
      this._mounted = false;        // 手机是否朝前固定（影响 heading 可用性）
    }

    static supported() {
      return typeof navigator !== 'undefined' && !!navigator.geolocation;
    }

    /**
     * 开始跟踪位置。
     *
     * @param {boolean} mounted 手机是否与车头同向固定在车上。
     *   固定手机时用 GPS 航向；没固定（放口袋）时只能用路线切线兜底 ——
     *   那种情况下"相对车头方位"本身就是没意义的（v1 的硬约束）。
     */
    start(mounted) {
      this._mounted = !!mounted;
      if (!GeoSource.supported()) {
        this.error = '这个浏览器不支持 navigator.geolocation';
        this.onState('unavailable', this.error);
        return;
      }
      if (this._watch_id !== null) return;
      this.onState('waiting', '正在等待 GPS 定位…');
      this._watch_id = this.geolocation.watchPosition(
        (pos) => this._on_position(pos),
        (err) => this._on_error(err),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 }
      );
    }

    stop() {
      if (this._watch_id !== null && this.geolocation) {
        try { this.geolocation.clearWatch(this._watch_id); } catch (_e) { /* 忽略 */ }
      }
      this._watch_id = null;
    }

    _on_position(pos) {
      const c = pos.coords;
      this.lat = c.latitude;
      this.lon = c.longitude;
      this.accuracy_m = c.accuracy;
      this.speed_mps = Number.isFinite(c.speed) && c.speed > 0 ? c.speed : 0.0;
      this.last_fix_t = pos.timestamp || Date.now();
      this.fix_count += 1;
      this.error = '';

      // 只有跑起来 COG 才可信（与 NmeaSource 的 2 m/s 阈值一致）
      const h = c.heading;
      if (Number.isFinite(h) && this.speed_mps >= 2.0) {
        this.heading = nm.wrap360(h);
        this.heading_source = 'gps';
      } else if (this.heading === null) {
        // 还没拿到过任何航向：交给调用方用路线切线兜底
        this.heading_source = 'route';
      } else {
        this.heading_source = 'held';   // 沿用上一次有效航向
      }

      this.onState('ok', '');
    }

    _on_error(err) {
      const code = err && err.code;
      let msg;
      if (code === 1) { msg = '定位权限被拒绝'; this.onState('denied', msg); }
      else if (code === 2) { msg = '定位不可用（GPS 没信号？）'; this.onState('unavailable', msg); }
      else if (code === 3) { msg = '定位超时'; this.onState('waiting', msg); }
      else { msg = String(err && err.message ? err.message : err); this.onState('unavailable', msg); }
      this.error = msg;
      this.onLog(`[gps] ${msg}`);
    }

    /** 有没有可用的定位。 */
    has_fix() {
      return this.lat !== null && this.lon !== null;
    }

    /** 返回 [lat, lon, heading_deg, speed_mps]，没有定位就返回 null。 */
    fix(fallback_heading) {
      if (!this.has_fix()) return null;
      let hdg = this.heading;
      if (heading_unusable(this._mounted, hdg, this.speed_mps)) {
        hdg = Number.isFinite(fallback_heading) ? fallback_heading : 0.0;
        this.heading_source = 'route';
      }
      return [this.lat, this.lon, hdg, this.speed_mps];
    }
  }

  /**
   * 判断 GPS 航向能不能用。
   *
   * 手机放在口袋里 / 揣在包里时，GPS 的 COG 描述的是"手机被带着走的那个方向"，
   * 而设备（装在车把上）朝向完全由车决定 —— 两者只有在**骑行中**而且
   * **手机与车头同向**时才一致。停车、掉头、把手机掏出来看，都会让
   * rel_bearing 变成噪声。所以：
   *   - 没装在车上 -> 一律不用，退回路线切线（箭头指向"路往哪走"，
   *     这仍然是有用的信息，只是不再是"相对车头"）
   *   - 装在车上但速度 < 2m/s -> 用上一次的（GeoSource 内部已经 hold 了）
   */
  function heading_unusable(mounted, heading, speed_mps) {
    if (!mounted) return true;
    if (heading === null || !Number.isFinite(heading)) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // 位置源：手动 / 模拟（室内收不到 GPS 时用它把整条链路跑通）
  // -------------------------------------------------------------------------
  /**
   * 手输坐标的位置源。
   *
   * 为什么**单独一个类**、而不是给 GeoSource 塞一个"手动模式"开关：
   * GeoSource 的全部逻辑都围绕 watchPosition 的回调、错误码和"沿用上一次有效
   * 航向"展开 —— 把静态坐标混进去，等于让一个真实定位对象随时可能被浏览器
   * 回调改写，而界面上却写着"手动"。分开之后，模拟源永远不会自己动，也不可能
   * 被权限、错误码、重试影响；Navigator 那边完全看不出区别（同一组字段和方法）。
   *
   * 与 GeoSource 保持一致的接口（这是关键：Navigator 只认这些）：
   *   lat / lon / accuracy_m / speed_mps / heading / heading_source
   *   fix_count / error / has_fix() / fix(fallback_heading) / onState(kind, msg)
   *   start() / stop()
   *
   * 两处刻意的语义差别：
   *   - 位置是**静态**的：车停在输入的坐标上不动；速度只影响速度栏和 ETA；
   *   - 航向来自输入框（默认 0 = 正北），heading_source 恒为 'manual'。
   *     这里**故意不套用 heading_unusable()**（"手机放口袋就别用 GPS 航向"那条
   *     规则）：航向是用户明确手输的，再按 mounted 丢掉它，就没法验证"地图旋转
   *     对不对" —— 而设备没有磁力计、地图是车头朝上的，那正是手动模式的主要用途。
   */
  class SimSource {
    constructor(opts) {
      const o = opts || {};
      this.onLog = o.onLog || (() => {});
      this.onState = o.onState || (() => {});   // 固定只发 'manual'

      this.lat = null;
      this.lon = null;
      this.accuracy_m = null;       // 手输坐标没有"精度"可言，显示成 — 而不是编个数
      this.speed_mps = 0.0;
      this.heading = 0.0;
      this.heading_source = 'manual';
      this.last_fix_t = 0;
      this.fix_count = 0;
      this.error = '';
      this.active = false;          // 只有 active 时 has_fix() 才为真
    }

    /** 永远可用：它不依赖任何浏览器权限。 */
    static supported() { return true; }

    /**
     * 设置/更新手动位置。
     *
     * @returns {string|null} null = 成功；否则是给用户看的错误文本。
     */
    set(lat, lon, heading_deg, speed_mps) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
          Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        const msg = '手动位置的坐标不合法（纬度 ±90，经度 ±180 的十进制度）';
        this.error = msg;
        this.onLog(`[sim] ${msg}`);
        return msg;
      }
      this.lat = lat;
      this.lon = lon;
      this.heading = Number.isFinite(heading_deg) ? nm.wrap360(heading_deg) : 0.0;
      this.speed_mps = (Number.isFinite(speed_mps) && speed_mps > 0) ? speed_mps : 0.0;
      this.last_fix_t = Date.now();
      this.fix_count += 1;
      this.error = '';
      this.active = true;
      this.onState('manual',
        `手动位置 ${lat.toFixed(6)}, ${lon.toFixed(6)} ` +
        `航向 ${this.heading.toFixed(0)}° 速度 ${this.speed_mps.toFixed(1)} m/s`);
      return null;
    }

    /** 关掉手动位置（切回 GPS 时调用）。坐标留着，方便再切回来。 */
    clear() {
      this.active = false;
      this.error = '';
    }

    start() { /* 没有异步等待：设置即生效 */ }
    stop() { this.clear(); }

    has_fix() { return this.active && this.lat !== null && this.lon !== null; }

    /** 与 GeoSource.fix() **完全同形状**：[lat, lon, heading_deg, speed_mps]。 */
    fix(fallback_heading) {
      if (!this.has_fix()) return null;
      let hdg = this.heading;
      if (Number.isFinite(hdg)) {
        // 手输的航向永远照用（见类注释：mounted 那条规则在这里不适用）
        this.heading_source = 'manual';
      } else {
        // 理论上到不了这里（set() 已经把 heading 归一化成有限值）；留着是为了
        // 和 GeoSource 的兜底语义一致，而不是让调用方去猜。
        hdg = Number.isFinite(fallback_heading) ? fallback_heading : 0.0;
        this.heading_source = 'route';
      }
      return [this.lat, this.lon, hdg, this.speed_mps];
    }
  }

  // 模拟行驶的最低速度（km/h）。速度填 0 时车永远不动，界面上看着就是
  // "模拟行驶坏了" —— 与其让人去查，不如夹到一个极小但非零的值。
  const MIN_SIM_SPEED_KMH = 0.1;

  // -------------------------------------------------------------------------
  // 位置源：模拟行驶（沿航线自动推进）
  // -------------------------------------------------------------------------
  /**
   * 沿**规划出来的航线**按配置速度前进的模拟位置源（"模拟行驶 / 模拟骑行"）。
   *
   * 和上面那个静态 SimSource 的区别只有一件事：**位置会动**。于是速度栏、
   * 剩余距离、进度、地图滚动，以及最要紧的"航向随转弯变化"全都能在室内验证
   * —— 这正是这个模式存在的理由（设备没有磁力计，地图是车头朝上的，"航向
   * 对不对"只能靠手机推给它的那个角来验证，静态坐标永远验证不了）。
   *
   * 行为逐条对齐 tools/navigator.py 的 SimSource（PC 版是参考实现）：
   *   - speed_mps = speed_kmh / 3.6（PC 版 --speed 默认 42 km/h）
   *   - s 初值 = route.total_m * start_frac（PC 版 --start，0~1，默认 0）
   *   - advance(dt) 里 s += speed_mps * dt，dt 是**真实流逝时间**（10Hz 循环
   *     传进来的那一份），不是固定步长 —— 掉帧或后台限流时速度才不会失真
   *   - fix() 给的是 (lat, lon, tangent_deg(s), speed_mps)：航向取**航线在
   *     这一点的切线**，所以过弯时它会跟着变（PC 版就是 route.tangent_deg）
   *
   * 与接口的约定和 GeoSource / SimSource 完全一样（Navigator 只认这些字段）：
   *   lat / lon / accuracy_m / speed_mps / heading / heading_source
   *   fix_count / error / has_fix() / fix(fallback_heading) / onState(kind, msg)
   *   start() / stop()
   *
   * 三处**故意**和 PC 版不一样，都写在下面：
   *   1. 走到终点**停住**，不像 Python 那样 `s -= total_m` 绕回起点重跑。
   *      室内测试要看的是"这条航线走完是什么样"；绕回起点会让人以为导航
   *      自己重置了（进度条从 100% 跳回 0% 最容易被当成 bug）。
   *   2. heading_source 恒为 'sim'（既不是 'gps' 也不是 'manual'），日志和
   *      界面上都能一眼看出这个航向是算出来的。
   *   3. accuracy_m = null（模拟位置没有"精度"可言，界面显示 — 而不是编个数）。
   */
  class RouteSimSource {
    constructor(opts) {
      const o = opts || {};
      this.onLog = o.onLog || (() => {});
      this.onState = o.onState || (() => {});

      // 航线：**必须**有几何才能沿路走，所以由 App 在规划完成时 set_route()
      this.route = null;
      this.s = 0.0;                 // 当前弧长（米）
      this.arrived = false;         // 到终点后恒为 true，s 钉在 total_m 上
      this.speed_kmh = 42.0;
      this.speed_mps = 42.0 / 3.6;
      this.start_frac = 0.0;

      this.lat = null;
      this.lon = null;
      this.accuracy_m = null;
      this.heading = 0.0;
      this.heading_source = 'sim';
      this.last_fix_t = 0;
      this.fix_count = 0;
      this.error = '';
      this.active = false;          // 只有 active 时 has_fix() 才为真

      // Navigator 靠这个标记认"弧长源"：先 advance(dt) 再取 fix，而且直接用
      // 它给的 s 当里程（见 Navigator.cycle）。用标记而不是 instanceof，是为了
      // 让 app.js 里的类顺序/打包方式变了也不会把这条分支悄悄断掉。
      this.is_route_sim = true;
    }

    /** 永远可用：它不依赖任何浏览器权限，也不需要 GPS。 */
    static supported() { return true; }

    has_route() { return this.route !== null; }

    total_m() { return this.route ? this.route.total_m : 0.0; }

    /** 换一条航线（每次"规划并开始导航"都会调一次），并从头开始。 */
    set_route(route) {
      this.route = (route && Number.isFinite(route.total_m) && route.total_m >= 1.0)
        ? route : null;
      if (this.route === null) {
        this.s = 0.0;
        this.lat = null;
        this.lon = null;
        this.error = '模拟行驶：还没有可用的航线';
        this.onLog(`[sim] ${this.error}`);
        return false;
      }
      this.error = '';
      this.restart(this.start_frac);
      return true;
    }

    /** 把弧长拨回 total_m * frac（0~1），清掉"已到终点"。 */
    restart(frac) {
      if (Number.isFinite(frac)) this.start_frac = Math.max(0.0, Math.min(1.0, frac));
      // ⚠️ 夹住上界：start_frac 允许正好 1.0（就停在终点），但不能越过它
      this.s = this.has_route() ? this.total_m() * this.start_frac : 0.0;
      this.arrived = this.has_route() && this.s >= this.total_m();
      this.fix_count = 0;
      this.last_fix_t = 0;
      this._sync();
      return this.s;
    }

    set_speed_kmh(v) {
      const k = Number.isFinite(v) ? Math.max(MIN_SIM_SPEED_KMH, v) : 42.0;
      this.speed_kmh = k;
      this.speed_mps = k / 3.6;
      return this.speed_mps;
    }

    /**
     * 前进 dt 秒（dt 是**真实流逝时间**）。
     *
     * 到终点就停：s 夹在 total_m 上、arrived 置位，之后再怎么调都不动。
     * 刻意不做 Python 的取模绕回（见类注释）。
     */
    advance(dt_s) {
      if (!this.has_route() || !(dt_s > 0.0)) return this.s;
      if (this.arrived) return this.s;
      if (!(this.speed_mps > 0.0)) return this.s;      // 速度为 0 = 原地不动
      this.s += this.speed_mps * dt_s;
      if (!Number.isFinite(this.s) || this.s >= this.total_m()) {
        this.s = this.total_m();                       // 夹住，绝不让 NaN/越界漏出去
        this.arrived = true;
        this._sync();
        this.onState('simdrive', '模拟行驶已到终点');
        return this.s;
      }
      this._sync();
      return this.s;
    }

    /** 按当前弧长刷新 lat/lon/heading（restart / advance 之后各调一次）。 */
    _sync() {
      if (!this.has_route()) {
        this.lat = null;
        this.lon = null;
        this.heading = 0.0;
        return;
      }
      const [lat, lon] = this.route.point_at(this.s);
      this.lat = lat;
      this.lon = lon;
      // 航向 = 航线在 s 处的切线（罗盘方位）。这就是"过弯时地图跟着转"的来源。
      this.heading = this.route.tangent_deg(this.s);
    }

    /** 与 GeoSource / SimSource 同形状：设置即生效，没有异步等待。 */
    start() { this.active = true; }
    stop() { this.active = false; }

    has_fix() {
      return this.active && this.route !== null && this.lat !== null && this.lon !== null;
    }

    /**
     * 与 GeoSource.fix() **完全同形状**：[lat, lon, heading_deg, speed_mps]。
     *
     * 到终点后速度报 0（车停了），位置停在终点不动 —— 速度栏、ETA 和设备的
     * 表现因此是一致的，不会出现"停在终点但速度还写着 42"这种自相矛盾。
     * 这里**故意不套用** heading_unusable()（"手机放口袋就别用 GPS 航向"那条
     * 规则）：这个航向是航线切线算出来的，与手机怎么放没有半点关系，丢掉它
     * 就等于把本模式最该验证的东西丢掉了。
     */
    fix(_fallback_heading) {
      if (!this.has_fix()) return null;
      this.heading_source = 'sim';
      this.last_fix_t = Date.now();
      return [this.lat, this.lon, this.heading, this.arrived ? 0.0 : this.speed_mps];
    }
  }

  // -------------------------------------------------------------------------
  // 主控 —— Navigator 的移植
  // -------------------------------------------------------------------------
  class Navigator {
    /**
     * @param {rt.Route} route
     * @param {GeoSource} source
     * @param {object} opts {send, ble, onLog, onUi, mapSource, config}
     */
    constructor(route, source, opts) {
      const o = opts || {};
      this.route = route;
      this.source = source;
      this.send = o.send || (() => false);
      this.onLog = o.onLog || (() => {});
      this.onUi = o.onUi || (() => {});
      this.cfg = Object.assign({
        rate_hz: 10.0,
        no_map: false,
        osrm_profile: 'driving',
      }, o.config || {});

      this.s_hint = 0.0;
      this.idx_hint = 0;
      this.last_road = '';
      this.frames_sent = 0;
      this.clock_s = 0.0;

      this.map_src = null;
      this.map_error = '';
      if (!this.cfg.no_map) {
        // ⚠️ 建底图源**必须**包在 try/catch 里：底图是装饰，路线和箭头才是本职。
        //    以前这里是裸的 `new mapmod.OsmMapSource()`，于是 map.js 没加载成功
        //    （SW 缓存里的文件坏了/被截断了）时，构造 Navigator 直接抛错，
        //    do_route() 弹一句"无法开始导航"就结束了 —— 症状是"底图服务一有问题，
        //    连导航都开不起来"，而这两件事根本不该有关系。
        try {
          this.map_src = o.mapSource || new mapmod.OsmMapSource();
        } catch (e) {
          this.map_error = `底图源不可用：${e}`;
          this.onLog(`[map] ${this.map_error}（导航照常，只是没有街道路网）`);
        }
      } else {
        // 关掉底图时给一句明确的理由，界面直接用（见 App.map_status）
        this.map_error = 'no_map';
      }
      this.last_map_segs = 0;
      this.last_map_pts = 0;
      this.map_view_m = 0.0;
      // 底图重发计时（秒）。以前它只靠 `(this.map_timer || 0)` 兜底、从不初始化，
      // 于是"重锚那一轮到底重发没重发"在自测里读不出来（是 undefined）。
      // 与 navigator.py 的 self.map_timer = 0.0 对齐。
      this.map_timer = 0.0;

      // ---- 滑动窗口路线 ----
      //
      // 以前是"把整条路线一开始就定死"：原点固定在**路线起点**，整条路线
      // 一次性发完。好处（蓝线是设备拥有的静态数据，不重发就不闪）保留，
      // 但"整条"这两个字撑不住两件事：
      //
      //   1. 点在原点固定的坐标系里走 int16 米，整条路线因此被 ±32767m
      //      （≈ ±32.7km）卡死。摩托车一天随便跑 100km —— 这种路线以前直接
      //      报错拒绝导航。
      //   2. 步长按"路线长度 / 1024 点"反推。40km 的路线会退化成 39 米一个点，
      //      而设备视野固定 160 米 —— 屏幕上一共只有 4 个点，线是一段段折角。
      //
      // 现在改成：原点 = **发这一窗时骑手的位置**，只发前方 WINDOW_M 一段，
      // 步长固定 STEP_M。整条路线有多长都不影响坐标上界和点距，两个毛病一起
      // 消失；wire 格式一个字没动（还是"相对某个原点的 i16 米 + 每帧一个
      // 相对原点的车位置"），变的只是原点的选择与下发时机。
      if (!(route.total_m >= 1.0)) {
        throw new Error('路线长度为 0，没法导航（检查起点终点是否重合）。');
      }

      // 第一次 cycle 里按骑手位置定原点；之前先摆成"没发过"的状态
      this.origin_lat = 0.0;
      this.origin_lon = 0.0;
      this.cos_lat0 = 1.0;
      this.origin_s = 0.0;         // 原点的弧长
      this.window_end_s = 0.0;     // 这一窗画到哪个弧长
      this.window_pts = [];
      this.reanchors = 0;          // 重锚次数（界面/自检用）
      this.route_sent = false;
      this.route_resend_t = 0.0;
      this.link_was_up = false;

      // NAV_CLOCK 的重发计时。初值取**满一个周期**（不是 0），为的是第一帧
      // cycle 就把时间发出去：设备一连上就显示真实时间，而不是先挂 30 秒
      // 的 --:--。与 tools/navigator.py 的 clock_send_t 初值一致。
      this.clock_send_t = CLOCK_SEND_PERIOD_S;

      this._timer = null;
      this._last_tick_ms = 0;
      this.last_update = null;
      this.stats = { max_cycle_ms: 0, max_gap_ms: 0 };
      this._call_count = 0;

      // ---- 原生节拍器（APK）：谁在敲这个循环 ----
      //
      // 背景：实测已经证明**熄屏后 JS 定时器会被 Chromium 冻住**（探针的
      // "JS 跳数"不涨、原生心跳照涨）。但那个探针数的是**定时器回调**，
      // 而"原生主动调 evaluateJavascript 里的函数，页面不可见时会不会执行"
      // 是**另一个**问题 —— 后者才决定要不要把循环搬进原生。
      //
      // 于是原生可以请求"让我来当节拍器"（每 100ms 调一次 _tick，
      // 入口是 App.do_route 装的 window.__navpuckNativeTick）。
      //   _metronome        有没有人（原生页面的诊断面板）把节拍器打开
      //   exec_count        这个入口**真的执行**了几次 —— 唯一能证明"JS 跑了"的量，
      //                     由 JS 自己数，原生只搬运
      //   frames_at_last_exec  最近一次执行时循环累计发过多少帧（诊断面板用它算增量）
      //
      // ⚠️ **默认 false，而且只可能由原生侧打开**：PWA 里永远没有谁来调
      //    set_metronome()，所以浏览器那条路的行为与加这个功能之前一模一样。
      this._metronome = false;
      this.exec_count = 0;
      this.frames_at_last_exec = 0;
      this.last_metronome_error = '';

      // ---- 循环周期（判定"页面在后台被浏览器限流"）----
      //
      // 这三个量全部由 _tick() 里的真实墙钟差值喂进来（唯一知道"这一帧离上一帧
      // 多久"的地方）。界面直接读它们把症状说出来，见 App.render_awake_loop()。
      //   loop_gap_ms  最近一帧的周期（毫秒）
      //   loop_slow    这一帧是否已经掉出 10Hz（见 LOOP_SLOW_MS）
      //   hidden       页面是否在后台（由 App 在 visibilitychange 里喂，见 set_hidden()）
      this.loop_gap_ms = 0.0;
      this.loop_slow = false;
      this.hidden = false;
    }

    /**
     * 视野固定，全程一个比例，**不再自适应**。
     *
     * s 参数保留只是为了不动调用点（与 navigator.py 的 view_range_m(s) 一致）。
     */
    view_range_m(_s) {
      return rt.ROUTE_FAR_M;
    }

    /** 经纬度 -> 相对**当前原点（发这一窗时骑手的位置）**的正北局部平面。 */
    _to_local(lat, lon) {
      return [(lon - this.origin_lon) * rt.EARTH_M_PER_DEG_LON_EQ * this.cos_lat0,
              (lat - this.origin_lat) * rt.EARTH_M_PER_DEG_LAT];
    }

    /**
     * 重锚：把原点挪到骑手**现在**的位置，重算前方 WINDOW_M 的窗口。
     *
     * 原点是骑手的真实位置（GPS fix），不是"路线上离他最近的那个点" ——
     * 设备和底图都是拿 pos_east_m/pos_north_m 减出来的，原点只能用同一个量，
     * 否则车标会偏到路线旁边去。
     */
    _reanchor(lat, lon, s) {
      const w = rt.build_route_window(this.route, s, lat, lon);
      this.window_pts = w.pts;
      this.window_end_s = w.end_s;
      this.origin_lat = lat;
      this.origin_lon = lon;
      this.cos_lat0 = Math.cos(lat * nm.DEG2RAD);
      this.origin_s = Math.max(0.0, Math.min(s, this.route.total_m));
      this.reanchors += 1;

      // 防御性断言：真出现越界，编码器会**静默夹断**，屏幕上表现为路线末端
      // 钉在边上、车标不动，全程没有任何提示 —— 宁可在这里炸掉。
      // 参数算对了就永远到不了：点在 10km 窗口里，i16 米的上限是 ±32767。
      let span_m = 0;
      for (const [e, n] of this.window_pts) {
        span_m = Math.max(span_m, Math.abs(e), Math.abs(n));
      }
      if (span_m > 32000 || this.window_pts.length > rt.FULL_ROUTE_MAX_POINTS) {
        throw new Error(
          `路线窗口越界：最远 ${span_m} 米 / ${this.window_pts.length} 点。` +
          `窗口最长 ${rt.WINDOW_M} m、点距 ${rt.STEP_M} m，这是参数被改坏的信号。`);
      }
    }

    /**
     * 把当前窗口分片发出去。`clear=true` 时先发一条空路线。
     *
     * ⚠️ 重锚必须带 clear，这不是保险而是必须的：新窗口和旧窗口的点数**通常
     * 完全一样**（都是 WINDOW_M/STEP_M + 1 ≈ 1001），而 wire 上没有 route_id，
     * 设备只能靠"同下标上的点内容对不对"来认路线身份。旧窗口自己没拼完
     * （比如第一片丢了）时，新窗口的第一片正好落在旧窗口的缺口里 —— 那一带
     * 没有任何已存点可以比较，设备会把两份窗口的点拼成一条**根本不存在的路**。
     * 空片（total_points == 0）是协议里本来就有的"把旧路线清掉"信号，重锚时
     * 先发它，设备侧的状态就一定是干净的。代价 8 个字节 / 5km。
     */
    _send_window(clear) {
      if (clear) {
        // route 的优先级最高：队满时绝不丢它
        this.send(proto.encode_nav_route(proto.route_chunks([])[0]), 'route', 0);
      }
      const chunks = proto.route_chunks(this.window_pts);
      for (const chunk of chunks) {
        this.send(proto.encode_nav_route(chunk), 'route', 0);
      }
      this.route_sent = true;
      this.onLog(`[route] 路线窗口${clear ? '（重锚，先清旧窗口）' : '（兜底重发）'}已下发：` +
                 `锚 ${(this.origin_s / 1000).toFixed(1)}km / ${this.window_pts.length} 点 / ` +
                 `${chunks.length} 片`);
    }

    /**
     * 用**手上已有的**路网数据投影一张底图并发出去（同步、不联网）。
     *
     * 原来这段代码长在 cycle() 的底图块里（build + 编码 + 记账 + send 挤在一处），
     * 重锚那条路要复用它，所以单独拆出来 —— **算法一个字没改**，只是把
     * "什么时候调"和"怎么算"分开：周期性刷新走 refresh() + 这里，重锚走
     * _resend_map()（不 refresh）。
     *
     * @returns {boolean} 真的发出去了一帧
     */
    _send_map_now(lat, lon, view_m) {
      if (this.map_src === null || this.map_src.enabled === false) return false;
      const m = this.map_src.build(this.origin_lat, this.origin_lon, lat, lon, view_m);
      if (m.seg_count <= 0) {
        // ⚠️ 这里**绝不**发空底图：设备收到 seg_count == 0 会把整片路网藏起来
        //    （见 src/ui/ui_puck.cpp 的 renderMap()），那等于把设备上那张
        //    "还算能用"的底图擦成白屏。手上的数据覆盖不到这里时，保留原来
        //    那张、不发任何东西，等下一次抓取成功再换 —— 宁可旧，不可空。
        return false;
      }
      let frame;
      try {
        frame = proto.encode_nav_map(m);
      } catch (e) {
        // 底图帧超 MAX_PAYLOAD（见 proto.js 里那段说明）：丢掉底图不致命，
        // 但**绝不能**让它把这一轮的 NAV_UPDATE 一起带崩。
        this.onLog(`[map] 底图帧编码失败，跳过本次下发：${e}`);
        return false;
      }
      // 只有**真的发出去了**才动这几个读数：last_map_segs 还是"设备上那张图
      // 有多少段"，界面（和"关掉底图要发空帧清屏"那条路）都靠它。
      this.map_timer = 0.0;
      this.last_map_segs = m.seg_count;
      this.last_map_pts = m.total_pts;
      this.map_view_m = view_m;
      this.send(frame, 'map', 3);
      return true;
    }

    /**
     * 重锚（原点挪到骑手当前位置）后的底图重建 + 重发：**同一轮、同步、不联网**。
     *
     * ⚠️ 为什么必须"同一轮、且不联网"：
     *   底图的点和路线窗口**同源** —— 都是相对**当前原点**的米。原点一挪
     *   （重锚 = 挪 5km），设备再拿新的 pos_east_m/pos_north_m 去减设备上
     *   那份旧底图，整张图就偏掉 5km：屏幕外，看着就是"底图掉了"。
     *   而它自己好起来要等**下一次成功的底图下发** —— 最坏是整整一轮刷新预算
     *   （120 秒，map.js 里 MAP_REFRESH_BUDGET_MS；实测一次 Overpass 查询
     *    17.6 秒）。
     *   可是路网数据一个字节都没变，变的只有投影原点，所以这里既不该等、
     *   也不该发请求：拿内存里那份路网直接重投影一次就行（纯计算）。
     *
     * @returns {boolean} 真的重发了一帧（false = 没有可用路网 / 编码失败）
     */
    _resend_map(lat, lon, view_m) {
      const sent = this._send_map_now(lat, lon, view_m);
      if (sent) {
        this.onLog(`[map] 重锚：底图已按新原点重建并重发（${this.last_map_segs}段/` +
                   `${this.last_map_pts}点，未联网）`);
      } else if (this.map_src !== null && this.map_src.ways &&
                 this.map_src.ways.length > 0) {
        // 有数据但覆盖不到新原点：**不发空底图**（那会把设备上那张擦掉），
        // 留着旧的那张，等下一次抓取。写一行日志，免得"底图怎么又没了"
        // 变成一句查不出来的抱怨。
        this.onLog('[map] 重锚：手上的路网覆盖不到新原点，先保留设备上那张' +
                   '（不发空底图擦掉它），等下一次抓取成功再换');
      }
      if (!sent) {
        // 没重发成 -> 下一轮**立刻**走正常的"刷新 + 重建"这条路（也就是马上
        // 在新位置发起一次抓取）。不这么做的话，这一轮被跳过的 refresh()
        // 要等 map_timer 再攒满 0.5 秒才轮到 —— 而这时骑手屏幕上啥也没有。
        this.map_timer = rt.MAP_SEND_PERIOD_S;
      }
      return sent;
    }

    /** 弧长 s 处的动作点在**当前窗口**里的下标（没有就返回 NO_TURN）。 */
    turn_index_of(s) {
      const nxt = this.route.next_maneuver(s);
      if (nxt === null || this.window_pts.length < 2) return proto.NO_TURN;
      const ms = this.route.points[nxt[0]].cum_m;
      // 路口在窗口之外（10km 外）就没法画那个点 —— 它本来也在屏幕外，
      // 报 NO_TURN 比报一个越界下标安全（设备拿它直接当下标用）。
      if (ms > this.window_end_s + 0.5) return proto.NO_TURN;
      const idx = nm.pyround((ms - this.origin_s) / rt.STEP_M);
      return Math.max(0, Math.min(this.window_pts.length - 1, idx));
    }

    /**
     * 一个导航周期：算一帧 NAV_UPDATE，并按节奏决定要不要补发路线/底图。
     *
     * 返回 NavUpdate，或 null（还没有 GPS 定位）。
     */
    cycle(dt_s) {
      this._call_count += 1;

      // 沿航线推进的模拟源：**先按真实流逝时间推进弧长**，再取这一帧的位置。
      // 和 navigator.py 的 `if isinstance(self.source, SimSource): advance(dt)`
      // 是同一个位置、同一件事：速度因此与帧率无关（掉帧/后台限流都不会让
      // 模拟车"偷偷慢下来"）。
      if (!!this.source && this.source.is_route_sim === true &&
          typeof this.source.advance === 'function') {
        this.source.advance(dt_s);
      }

      const fix = this.source.fix(this.route.tangent_deg(this.s_hint));
      if (fix === null) return null;
      const [lat, lon, heading, speed_mps] = fix;

      // 把当前位置映射到路线里程上。
      //
      // 前 5 帧做全表搜索：idx_hint 初始为 0，如果路线起点离车很远（用户从
      // 中途开始导航），带 hint 的窗口搜索会锁在起点附近一动不动。跑几帧
      // 之后 hint 就准了，再切回窗口搜索省 CPU。
      let s;
      if (!!this.source && this.source.is_route_sim === true && Number.isFinite(this.source.s)) {
        // 弧长模拟源：s **直接用它自己的里程**（PC 版也是这样）。走最近点匹配
        // 的话 s 会被量化到折线点距（OSRM 加密后 25m），进度条和剩余距离会
        // 一跳一跳 —— 而位置本身已经由 fix() 精确给出了，没必要再舍一次。
        // idx_hint 仍然维护着（诊断/后续换源时用得上），头几帧照旧全表搜索。
        this.idx_hint = (this._call_count <= 5)
          ? this.route.nearest_index_full(lat, lon)
          : this.route.nearest_index(lat, lon, this.idx_hint);
        s = Math.max(0.0, Math.min(this.source.s, this.route.total_m));
      } else if (this._call_count <= 5) {
        this.idx_hint = this.route.nearest_index_full(lat, lon);
        this._hinted = true;
        s = this.route.s_at_index(this.idx_hint);
      } else {
        this.idx_hint = this.route.nearest_index(lat, lon, this.idx_hint);
        s = this.route.s_at_index(this.idx_hint);
      }
      this.s_hint = s;

      // ---- 前视点：箭头瞄它 ----
      const look_s = Math.min(s + rt.LOOKAHEAD_M, this.route.total_m);
      const [llat, llon] = this.route.point_at(look_s);
      const bearing_to_look = nm.bearing_deg(lat, lon, llat, llon);

      // ---- 下一个路口：距离和转向看它 ----
      let turn;
      let road;
      let dist_next;
      let abs_bearing;
      const nxt = this.route.next_maneuver(s);
      if (nxt !== null) {
        const [_midx, ms, t, r] = nxt;
        const [mlat, mlon] = this.route.point_at(ms);
        dist_next = nm.distance_m(lat, lon, mlat, mlon);
        abs_bearing = nm.bearing_deg(lat, lon, mlat, mlon);
        turn = t;
        road = r;
      } else {
        turn = proto.Turn.ARRIVE;
        road = this.route.road_name_at(s);
        dist_next = (this.route.total_m - s);
        abs_bearing = bearing_to_look;
      }

      // 到达终点附近就报到达
      if (this.route.total_m - s < 30.0) {
        turn = proto.Turn.ARRIVE;
        dist_next = Math.max(0.0, this.route.total_m - s);
      }

      const rel = nm.shortest_delta(heading, bearing_to_look);

      // ---- 视野：这一轮只算一次，路线和底图共用同一个值 ----
      const want_view_m = this.view_range_m(s);

      this.clock_s += dt_s;

      // ---- 时钟：连上就发，之后每 30 秒补一次 ----
      //
      // 和 tools/navigator.py 的 cycle() 逐行对应（初值取满一个周期，
      // 所以**第一帧 cycle 就把时间发出去**）。
      // 放在 cycle 里而不是只挂在 App 的 setInterval 上：所有跑 Navigator 的
      // 入口都会调用 cycle —— 手机页面、集成自测、以后任何新的驱动方式。
      // 只挂在页面上，"换一个驱动"就等于"设备收不到时间"，而这种漏很难看出来。
      // 两处都发是**故意**的冗余（14 字节 / 30 秒）：App 那一路管"刚连上"，
      // 这一路管"循环在跑"，任何一路活着设备就不会显示 --:--。
      this.clock_send_t += dt_s;
      if (this.clock_send_t >= CLOCK_SEND_PERIOD_S) this.send_clock();

      // ---- 路线：滑动窗口 ----
      //
      // 三种情况要发路线：
      //   1. 还没发过 —— 出发时先定原点、发第一窗；
      //   2. 该重锚了（骑手走远了 / 窗口末端快到了）—— 原点挪到骑手当前位置，
      //      重算窗口、发一条空片清掉设备上的旧窗口、再发新窗口；
      //   3. 兜底重发 —— 任何一个分片丢掉（CRC 错、接收环溢出、板子还在启动
      //      没在听），或者设备中途重启，结果就是**整段骑行都没有指引线**。
      //      所以定期把**当前窗口原样**重发一遍（4KB / 30 秒 ≈ 0.13KB/s），
      //      链路刚从断到通时也补发一次。原样重发的每一片都和上次逐字节相同，
      //      设备认得出来是重传，会原地忽略、连重画都不会触发。
      this.route_resend_t += dt_s;
      const link_up = this._link_up();
      // 这一轮重锚了吗？底图必须在**同一轮**按新原点重建（见 _resend_map）。
      let reanchored = false;
      if ((!this.route_sent) ||
          rt.window_needs_reanchor(s, this.origin_s, this.window_end_s,
                                   this.route.total_m)) {
        this._reanchor(lat, lon, s);
        this.route_resend_t = 0.0;
        this._send_window(true);
        // 原点变了（首发也在这里定原点）。这里只记标记，真正的重建放到下面
        // 底图那一块里做：底图永远不联网、失败也只记一行日志，绝不会把
        // 同一帧的 NAV_UPDATE 带崩。
        reanchored = true;
      } else if (this.route_resend_t >= rt.ROUTE_RESEND_PERIOD_S ||
                 (link_up && !this.link_was_up)) {
        this.route_resend_t = 0.0;
        this._send_window(false);
      }
      this.link_was_up = link_up;

      // ---- 底图：低频 ----
      //
      // 旋转已经交给设备了，底图不必再跟着航向重发，只在走远了或换视野档时更新。
      //
      // ⚠️ 两条硬规矩，都是"底图绝不拖累导航"的一部分：
      //    1. refresh() **不要 await**：它是异步的，await 会把 10Hz 循环卡在网络上
      //       （PC 版被 Overpass 超时卡过 30 秒）。它返回的 promise 只用来做
      //       诊断，失败也已经全部收进 map.js 的状态机里了。
      //    2. 整块必须包 try/catch：底图是**装饰**，路线和箭头是本职。这块里
      //       任何一次抛错，在这一版之前都会让**同一帧的 NAV_UPDATE 也发不出去**
      //       —— 用户看到的就是"Overpass 一挂，设备连箭头都不动了"。
      if (this.map_src !== null && this.map_src.enabled !== false) {
        try {
          if (reanchored) {
            // ⚠️ 重锚这一轮**只按新原点重建 + 重发，绝不调用 refresh()**：
            //    底图坐标和路线窗口同源（相对当前原点）。原点一挪（5km），
            //    设备再拿新的 pos_east_m/pos_north_m 去减设备上那份旧底图，
            //    整张图就偏掉 5km —— 屏幕上直接消失，而"下一次成功的底图
            //    下发"最坏要等满 120 秒的刷新预算（实测一次 Overpass 查询
            //    就要 17.6 秒），中间这段骑手看到的就是"底图掉了"。
            //    路网数据一个字节都没变，变的只有投影原点，所以这是纯粹的
            //    一次重投影：同步做、一个网络请求都不发。
            this._resend_map(lat, lon, want_view_m);
          } else {
            this.map_timer = (this.map_timer || 0) + dt_s;
            if (this.map_timer >= rt.MAP_SEND_PERIOD_S || Math.abs(want_view_m - this.map_view_m) > 1.0) {
              this.map_src.refresh(lat, lon, this.clock_s);
              this._send_map_now(lat, lon, want_view_m);
            }
          }
        } catch (e) {
          this.onLog(`[map] 底图这一块出错（本次跳过，导航不受影响）：${e}`);
        }
      }

      // 车相对**当前原点**的位置（米）。设备用它把窗口点集平移到"以车为原点"。
      const [pe, pn] = this._to_local(lat, lon);

      let flags = proto.NavFlags.GPS_FIX | proto.NavFlags.LINK_UP;

      // ⚠️ 取整函数的选用**逐字段照抄** navigator.py 第 997~1016 行。
      //    角度类字段是 int(round(x)) -> nm.pyround（银行家舍入）；
      //    距离/速度/ETA/进度是 int(x) -> nm.pyint（向零截断）。
      //    两者混用错一个，就是"距离差 1 米、进度差 1%"这类看着像显示差异、
      //    实际是**字节不同**的 bug。对拍测试 phone/test/parity.mjs 钉着这条。
      const u = new proto.NavUpdate({
        rel_bearing_cdeg: nm.pyround(rel * 100),
        abs_bearing_cdeg: nm.pyround(nm.wrap360(abs_bearing) * 100) % 36000,
        dist_next_cm: Math.min(nm.pyint(dist_next * 100), 0xFFFFFFFF),
        dist_dest_m: nm.pyint(Math.max(0.0, this.route.total_m - s)),
        speed_kmh_x10: Math.min(nm.pyint(speed_mps * 3.6 * 10), 65535),
        eta_min: Math.min(nm.pyint((this.route.total_m - s) / Math.max(speed_mps, 0.5) / 60.0), 65535),
        turn: turn,
        flags: flags,
        progress_pct: nm.pyint(Math.max(0, Math.min(100, s * 100.0 / Math.max(this.route.total_m, 1.0)))),
        // 航向：0=正北，顺时针，0.01°。设备靠它把正北坐标的路线和底图一起
        // 转到"车头朝上"。**必须放在最后**，与 C++ 端的字段顺序一致。
        heading_cdeg: nm.pyround(nm.wrap360(heading) * 100) % 36000,
        pos_east_m: nm.pyround(pe),
        pos_north_m: nm.pyround(pn),
        next_turn_index: this.turn_index_of(s),
        // 视距全屏只有一个来源 —— 路线和底图共用，所以两者在比例上不可能不一致。
        view_range_dm: nm.pyround(want_view_m * 10),
      });

      // ---- 路名变化就发一条文本帧 ----
      //
      // 设备当前**不显示任何文字**（用户刻意把所有标签去掉了），但协议里
      // NAV_TEXT 是完整的，留着以后要用。发出去的代价只有几十字节。
      if (road && road !== this.last_road) {
        this.last_road = road;
        this.send(proto.encode_nav_text(proto.TextKind.ROAD_NAME, road), 'text', 4);
      }

      this.send(proto.encode_nav_update(u), 'update', 5);
      this.frames_sent += 1;
      this.last_update = u;

      this.onUi({
        update: u,
        s_m: s,
        turn_name: proto.turn_name(turn),
        road_name: road || '',
        map_segs: this.last_map_segs,
        map_pts: this.last_map_pts,
        map_view_m: this.map_view_m,
        heading_source: this.source.heading_source,
        route_sent: this.route_sent,
        // 路线现在是"前方窗口"：点数和跨度只描述**这一窗**，不再等于整条路线。
        // 界面上想看整条路线的长度得用 route_total_m。
        route_points: this.window_pts.length,
        route_span_m: this._window_span_m(),
        route_origin_km: this.origin_s / 1000.0,
        route_reanchors: this.reanchors,
        route_total_m: this.route.total_m,
        // 循环节拍：界面靠这三个量把"页面在后台、帧率已降"直接说出来
        // （见 App.render_awake_loop）。hidden 由 App 喂进来，见 set_hidden()。
        loop_gap_ms: this.loop_gap_ms,
        loop_hz: this.loop_gap_ms > 0 ? (1000.0 / this.loop_gap_ms) : 0.0,
        loop_slow: this.loop_slow,
        page_hidden: !!this.hidden,
        frames_sent: this.frames_sent,
      });
      return u;
    }

    /**
     * 把**这台手机**的当前时间 + 真实时区推给设备（NAV_CLOCK）。
     *
     * 与 tools/navigator.py 的 Navigator.send_clock() 对应。发完把计时清零。
     * 与 App.send_clock() 的区别只有一个：那个走页面的 send_frame（会检查
     * ble.connected），这个走 Navigator 自己的 send 回调（集成自测里就是它）。
     * 两者都保留 —— 见 cycle() 里那段说明。
     */
    send_clock() {
      // ⚠️ 要在**路线之前**排队：BLE 发送队列按优先级稳定排序，而时钟取 1、
      //    路线分片取 0 —— 路线永远排在前面。这里在意顺序只有一个原因：
      //    "第一片是空路线"这条约定（设备据此清掉旧窗口）不能被一帧时钟插到
      //    前面。优先级已经保证了这一点，注释留在这里是提醒下一个人别把时钟
      //    的优先级调到 0。
      this.send(proto.encode_nav_clock(proto.now_clock()), 'ctl', 1);
      this.clock_send_t = 0.0;
    }

    /** 当前窗口里离原点最远的那个坐标（米）。诊断用：它必须远小于 32767。 */
    _window_span_m() {
      let span_m = 0;
      for (const [e, n] of this.window_pts) {
        span_m = Math.max(span_m, Math.abs(e), Math.abs(n));
      }
      return span_m;
    }

    /** 设备自己报的链路状态（PUCK_STATUS.flags bit4）。没有 BLE 时当作已连通。 */
    _link_up() {
      if (!this._ble) return true;
      if (!this._ble.device_status) return false;
      return this._ble.device_link_up;
    }

    set_ble(ble) { this._ble = ble; }

    // -- 定时循环 ----------------------------------------------------------
    /**
     * 启动 10Hz 循环。
     *
     * 用 setInterval 而不是 requestAnimationFrame：页面切到后台时 rAF 会停，
     * 而导航必须继续（骑手会锁屏看设备）。代价是后台会被浏览器限流到 ~1Hz ——
     * 所以这一版加了**屏幕常亮**（ScreenWakeLock：屏幕亮着、页面留在前台就
     * 不会被节流）和**把症状说出来**（note_loop_gap + 状态面板），见 README。
     */
    start() {
      if (this._timer !== null) return;
      // 节拍器开着的时候**不要**再起 setInterval：两个驱动叠在一起会让
      // "开了节拍器"这一组的读数翻倍，整张判读表就没法用了。见 set_metronome。
      if (this._metronome) return;
      const period_ms = 1000.0 / this.cfg.rate_hz;
      this._last_tick_ms = now_ms();
      this._timer = setInterval(() => this._tick(), Math.max(10, period_ms));
    }

    stop() {
      if (this._timer !== null) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }

    /**
     * 让**原生**接管节拍（每 100ms 调一次 _tick 的调用者由 setInterval 变成
     * 原生 Handler）。返回是否真的切换了状态。
     *
     * 关掉时立刻把 setInterval 起回来，导航不会有"没有人在推"的空档；
     * 反过来打开时立刻把 setInterval 停掉，避免双驱动。
     *
     * ⚠️ 这里**不重算 dt**：_tick 内部按真实墙钟差值算，谁调它都一样。
     *    这正是"原生当节拍器"这条路能成立的全部理由 —— 循环体一个字都不用改。
     */
    set_metronome(on) {
      const want = !!on;
      if (want === this._metronome) return false;
      this._metronome = want;
      if (want) {
        this.stop();
        // 重新对表：_last_tick_ms 停在"上一次由 setInterval 触发"的时刻，
        // 而那一刻可能已经过去很久（页面被冻过），不重置的话下一帧的 dt
        // 会顶到 1 秒的上限 —— 模拟行驶会"卡完突然窜一下"。
        this._last_tick_ms = now_ms();
      } else {
        this.start();
      }
      return true;
    }

    get metronome() { return this._metronome; }

    /**
     * 原生节拍器每次投递进来时**唯一**该走的入口（由 App 装到
     * window.__navpuckNativeTick，见 do_route）。
     *
     * 它做的就一件事：走一遍原来的 _tick()，然后把"这一次真的执行了"记下来。
     * 计数必须在**这里**加：native 侧看到的是 evaluateJavascript 的回调，
     * 回调回来了不等于函数体执行了（比如页面被冻时 WebView 可能回 null）。
     * 只有 JS 自己数的数才能证明 JS 跑了。
     */
    native_tick() {
      this.exec_count += 1;
      this._tick();
      this.frames_at_last_exec = this.frames_sent;
      return this.frames_at_last_exec;
    }

    /**
     * 给诊断面板/测试用的一份节拍器快照（只读，不碰内部状态）。
     */
    metronome_state() {
      return {
        on: this._metronome,
        running: this.running,
        executions: this.exec_count,
        frames_at_last_exec: this.frames_at_last_exec,
        frames_sent: this.frames_sent,
        last_error: this.last_metronome_error,
      };
    }

    get running() { return this._timer !== null; }

    /**
     * 页面可见性（App 在 visibilitychange 里喂进来）。
     *
     * Navigator 自己**不碰 document**：集成自测里根本没有 DOM，而"页面在不在
     * 后台"只有页面知道。喂进来只影响诊断文案（"页面在后台，帧率已降"），
     * 不参与任何导航计算。
     */
    set_hidden(hidden) {
      this.hidden = !!hidden;
      return this.hidden;
    }

    /**
     * 记一帧的循环周期（毫秒），判定有没有掉出 10Hz。
     *
     * 阈值是 LOOP_SLOW_MS（400ms = 10Hz 的 4 倍）。只在**跳变沿**记日志：
     * 掉下去一次写一行，回到正常再写一行 —— 后台限流时每帧都写会把日志刷爆，
     * 而那正好是最需要看清别的日志的时候。
     *
     * @returns {boolean} 这一帧是否算"掉帧"
     */
    note_loop_gap(gap_ms) {
      this.loop_gap_ms = gap_ms;
      const slow = gap_ms > LOOP_SLOW_MS;
      if (slow !== this.loop_slow) {
        this.loop_slow = slow;
        const nominal = (this.cfg.rate_hz > 0) ? (1000.0 / this.cfg.rate_hz) : 100.0;
        if (slow) {
          // 这句日志就是"用户以为 app 坏了"和"用户知道是浏览器限流"的分界
          this.onLog(`[loop] 帧率已降：这一帧距上一帧 ${gap_ms.toFixed(0)} ms` +
                     `（${this.cfg.rate_hz.toFixed(0)}Hz 应为 ${nominal.toFixed(0)} ms）` +
                     (this.hidden
                       ? '—— 页面在后台，浏览器把定时器压到了约 1Hz；屏幕常亮 + 保持页面在前台才能避免'
                       : '—— 页面在前台，是设备卡顿；导航仍然照常') +
                     `。累计已发 ${this.frames_sent} 帧。`);
        } else {
          // 回到前台 / 卡顿过去：确认循环恢复了正常节拍（帧计数在这中间一直没停）
          this.onLog(`[loop] 已恢复 ${this.cfg.rate_hz.toFixed(0)}Hz：这一帧 ` +
                     `${gap_ms.toFixed(0)} ms，累计已发 ${this.frames_sent} 帧`);
        }
      }
      return this.loop_slow;
    }

    /**
     * 一次节拍：算一帧 NAV_UPDATE 并把它发出去（cycle 内部负责发送）。
     *
     * 调用者有且只有两个：
     *   1. setInterval（默认，见 start()）—— 页面在前台时的正常路径；
     *   2. 原生 Handler -> window.__navpuckNativeTick -> native_tick()
     *      —— 熄屏诊断时由原生驱动，见 set_metronome()。
     * 两条路的**循环体完全相同**（就是下面这一坨），这是"原生能不能当节拍器"
     * 这个实验的前提：只有循环体是同一个，读数才有可比性。
     */
    _tick() {
      const t0 = now_ms();
      const dt = Math.max(0.001, Math.min(1.0, (t0 - this._last_tick_ms) / 1000.0));
      if (this._last_tick_ms > 0) {
        const gap = t0 - this._last_tick_ms;
        if (gap > this.stats.max_gap_ms) this.stats.max_gap_ms = gap;
        // 每一帧的周期都记一笔（判定后台限流，见 note_loop_gap）
        this.note_loop_gap(gap);
      }
      this._last_tick_ms = t0;

      try {
        this.cycle(dt);
        this.last_metronome_error = '';
      } catch (e) {
        this.last_metronome_error = String(e);
        this.onLog(`[nav] cycle 抛错：${e}`);
      }
      const cms = now_ms() - t0;
      if (cms > this.stats.max_cycle_ms) this.stats.max_cycle_ms = cms;
    }
  }

  // -------------------------------------------------------------------------
  // 屏幕常亮（Screen Wake Lock）
  // -------------------------------------------------------------------------
  /**
   * 让屏幕一直亮着 —— 摩托车上那块显示屏本来就该常亮，而"页面被切到后台 /
   * 锁屏"正是浏览器把定时器压到 ~1Hz 的直接原因（见文件上部 LOOP_SLOW_MS
   * 那段说明）。这是后台掉帧这件事唯一"真的有用"的对策：屏幕亮着、页面留在
   * 前台，浏览器就不会节流。
   *
   * 生命周期三条，少一条都会留下"锁拿着不放"或者"回到前台再也不常亮"：
   *   1. **导航开始**时申请（App.do_route -> request()），**停止导航**时释放
   *      （App.stop_nav -> release()）。空闲时绝不持有 —— 已经不导航的页面
   *      还占着屏幕常亮，那是在偷用户的电。
   *   2. 页面被隐藏时，浏览器**一定会**把锁自动收走（这是规范行为，不是异常），
   *      所以我们同时也把本地引用清掉（on_hidden），免得自己以为还拿着。
   *   3. 页面回到前台时**必须重新申请**（on_visible）—— 这一步最容易漏：
   *      不重新要的话，用户切出去看一眼消息再切回来，屏幕就再也不常亮了，
   *      而界面上完全看不出来。
   *
   * 全程**不允许抛错**：API 不存在（Safari / 旧版 Chrome）、低电量被拒、
   * 页面不可见时申请被拒 —— 都只写一行日志并返回 false，导航照常。
   */
  class ScreenWakeLock {
    constructor(opts) {
      const o = opts || {};
      this.onLog = o.onLog || (() => {});
      this.onChange = o.onChange || (() => {});
      // navigator 可以注入（自测用）。**每次现读 this._nav.wakeLock**，不在
      // 构造时缓存 —— 自测要在同一个 App 上依次换"支持 / 不支持 / 被拒"三种情况。
      this._nav = (o.navigator !== undefined)
        ? o.navigator
        : (typeof navigator !== 'undefined' ? navigator : null);
      this._sentinel = null;      // wakeLock.request() 返回的那个对象
      this._pending = null;       // "正在要"的那个 promise（防重复申请，见 _acquire）
      this._want = false;         // "现在在导航、应该持有这把锁"
      this._state = 'idle';       // idle | held | released | failed | unsupported
      this._reason = '';
      this.requests = 0;          // 诊断/自测：真的调了几次 request()
      this.releases = 0;
    }

    /** 这个浏览器有没有 Screen Wake Lock API（懒判断：自测会中途换掉它）。 */
    get supported() {
      return !!(this._nav && this._nav.wakeLock &&
                typeof this._nav.wakeLock.request === 'function');
    }

    /** 给界面看的一份快照（界面只读它，不碰内部字段）。 */
    state() {
      return {
        state: this._state,
        reason: this._reason,
        supported: this.supported,
        want: this._want,
        requests: this.requests,
        releases: this.releases,
      };
    }

    /**
     * 开始导航：申请屏幕常亮。
     * @returns {Promise<boolean>} 拿到了没有（拿不到**也不影响导航**）
     */
    async request() {
      this._want = true;
      return this._acquire();
    }

    /** 停止导航：放开屏幕常亮（空闲时不该占着它）。 */
    async release() {
      this._want = false;
      const s = this._sentinel;
      this._sentinel = null;
      this._state = 'idle';
      this._reason = '';
      this.releases += 1;
      this.onChange(this.state());
      if (s && typeof s.release === 'function') {
        try {
          await s.release();
        } catch (e) {
          this.onLog(`[wake] 释放屏幕常亮失败（忽略）：${e}`);
        }
      }
      return true;
    }

    /** 页面被隐藏：浏览器保证会把锁收走，本地引用一起清掉。 */
    on_hidden() {
      if (this._sentinel === null) return false;
      this._sentinel = null;
      if (this._want) {
        this._state = 'released';
        this._reason = '页面在后台时浏览器一定会收回屏幕常亮锁';
      }
      this.onChange(this.state());
      return true;
    }

    /** 页面回到前台：还在导航就重新申请一把（不重新要 = 屏幕从此不再常亮）。 */
    async on_visible() {
      if (!this._want) return false;          // 没在导航，别顺手把锁拿上
      if (this._sentinel !== null) return true;
      return this._acquire();
    }

    async _acquire() {
      if (!this.supported) {
        // 没有这个 API 也要说清楚：屏幕上那一格写"不支持"，别再让人以为常亮生效了
        if (this._state !== 'unsupported') {
          this._state = 'unsupported';
          this._reason = '这个浏览器没有 Screen Wake Lock API';
          this.onLog('[wake] 这个浏览器不支持屏幕常亮（Screen Wake Lock）：' +
                     '导航照常，但请自己保持屏幕常亮（锁屏/切后台会让帧率掉到 ~1Hz）');
          this.onChange(this.state());
        }
        return false;
      }
      if (this._sentinel !== null) return true;
      // ⚠️ 已经在要了就别再要一次。`wakeLock.request()` 是异步的，而"同一轮里被
      //    叫两次"在真机上真的会发生（页面 init 两次 → visibilitychange 有两个
      //    监听器）。发两个请求的后果不是"多要一把"这么轻：后一个 sentinel 会
      //    覆盖掉前一个的引用，**那一把锁就永远释放不掉了**（页面会一直占着
      //    屏幕常亮，用户却看不到任何原因）。
      if (this._pending !== null) return this._pending;
      this._pending = this._acquire_once();
      try {
        return await this._pending;
      } finally {
        this._pending = null;
      }
    }

    async _acquire_once() {
      this.requests += 1;
      try {
        const s = await this._nav.wakeLock.request('screen');
        this._sentinel = s;
        this._state = 'held';
        this._reason = '';
        // 锁被系统/浏览器收走时也会走这里（页面被隐藏、电量策略变化……）。
        // ⚠️ 我们自己调 release() 时也会触发它，所以先比对身份再处理。
        if (s && typeof s.addEventListener === 'function') {
          s.addEventListener('release', () => {
            if (this._sentinel !== s) return;      // 主动释放的那次，忽略
            this._sentinel = null;
            this._state = this._want ? 'released' : 'idle';
            this._reason = '屏幕常亮锁被浏览器收回';
            this.onLog('[wake] 屏幕常亮锁被浏览器收回（页面在后台时一定会发生）：' +
                       '回到前台会自动重新申请，导航不受影响');
            this.onChange(this.state());
          });
        }
        this.onLog('[wake] 已申请到屏幕常亮：导航期间屏幕不会自己熄灭');
        this.onChange(this.state());
        return true;
      } catch (e) {
        // 低电量、页面不可见、权限策略……都走这里。**绝不能**让它影响导航。
        this._sentinel = null;
        this._state = 'failed';
        this._reason = String(e && e.message ? e.message : e);
        this.onLog(`[wake] 屏幕常亮申请被拒（导航照常，屏幕可能会自己熄灭）：` +
                   `${this._reason}`);
        this.onChange(this.state());
        return false;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 界面绑定
  // -------------------------------------------------------------------------
  class App {
    constructor() {
      this.ble = null;
      this.geo = null;
      this.sim = null;          // 手动/模拟位置源（室内测试用）
      this.manual = false;      // 当前是否在用手动位置
      this.routesim = null;     // 模拟行驶位置源（沿航线自动推进）
      this.simdrive = false;    // 当前是否在模拟行驶
      this._sim_arrived = false; // "已到终点"只提示一次（每帧都弹会永远关不掉）
      this.nav = null;
      this.route = null;
      this.start_lat = null;
      this.start_lon = null;
      this.mounted = true;      // 手机是否与车头同向固定（界面上可切）
      this.log_lines = [];
      this.map_enabled = true;  // "显示街道路网底图"（init 时从存储里恢复）
      this.map_source = null;   // 懒创建的 OsmMapSource（缓存/退避/状态都在它身上）
      // 手机端地图视图（Canvas，见 phone/mapview.js）：懒创建 + 全局唯一。
      // 它画的路线折线单独存一份（[[lat,lon],...]）——Route 对象里的点是
      // RoutePoint（带 cum_m/name），而地图只关心几何，转换一次就够了。
      this.mapview = null;
      this._mv_route = null;
      this._mv_last = null;     // 最近一次地图状态（诊断/自测读）
      // 地点搜索（见 phone/search.js）：
      //   search_results  当前列出来的结果（点选时按**下标**取，所以每次搜索
      //                   都整批替换，不做增量）
      //   _search_seq     请求序号：用户连着搜两次时，先回来的那个旧响应必须
      //                   被丢掉（否则界面会被一个过期的结果覆盖）
      //   _search_fetch   **自测注入用**；浏览器里一直是 null（search.js 会用
      //                   全局 fetch）
      this.search_results = [];
      this._search_seq = 0;
      this._search_last = null;
      this._search_fetch = null;
      this._search_picked = -1;
      // 屏幕常亮（Screen Wake Lock）的持有者：懒创建，见 wake()
      this._wake = null;
      // 上一次画进状态面板的"循环/屏幕常亮"快照（只在变化时重画，见
      // render_awake_loop；on_ui 是每帧都跑的，别在里面白拼字符串）
      this._awake_last = '';
      // NAV_CLOCK 的补发状态与"只记一次日志"标志（见 tick_clock / send_clock）。
      // `_clock_next_ms = 0` 表示"下一次 tick 立刻发"，连上时就是这样置的。
      this._clock_next_ms = 0;
      this._clock_logged = false;
      // "上一次发送失败了没有"。用来给失败日志去重（见 send_clock）——
      // 与 _clock_logged 分开：那个管"成功只报一次"，这个管"失败别刷屏"。
      this._clock_failed = false;

      // 原生节拍器的入口与只读状态快照（由 _install_native_tick 装上，
      // 见 App.do_route）。在 PWA 里它们会被装到 window 上但**永远没人调**。
      this._native_tick = null;
      this._native_state = null;

      // 起点/终点：默认用内置演示航线（西湖），这样没 GPS 也能验证链路
      const demo = rt.DEMO_ROUTE;
      this.dest_lat = demo[2][0];
      this.dest_lon = demo[2][1];

      // ⭐ BLE 分片策略（自适应 + 跨启动落盘，见 phone/ble_native.js）。
      //   init() 里会换成真正的策略对象；这里先占位，保证别处读它不炸。
      this.chunk_policy = null;
      this._chunk_last_text = '';
    }

    log(line) {
      const t = new Date().toISOString().slice(11, 23);
      const s = `[${t}] ${line}`;
      this.log_lines.push(s);
      if (this.log_lines.length > 400) this.log_lines.shift();
      const el = $('log');
      if (el) {
        el.textContent = this.log_lines.join('\n');
        el.scrollTop = el.scrollHeight;
      }
      // 崩溃捕获：同一行也进 localStorage 的环形缓冲（见 phone/crashlog.js）。
      // ⚠️ 闪退 = 进程没了，页面上这块 #log 一个字都留不下；只有落盘的那份能在
      //    下一次启动时告诉用户"崩之前走到哪一步"。这里只是转发，任何失败都吞掉
      //    —— 诊断绝不能反过来影响导航。
      this.crash_note(line);
      // 控制台也留一份，用 USB 调试时方便
      if (typeof console !== 'undefined') console.log(s);
    }

    /** 把一行日志喂给崩溃捕获（PWA 里也有这个模块，只是没有原生那一段）。 */
    crash_note(line) {
      try {
        const C = root.NavPuckCrash;
        if (C && typeof C.note === 'function') C.note('app', line);
      } catch (_e) { /* 诊断不能影响导航 */ }
    }

    /**
     * 崩溃"黑匣子"：**危险操作之前**同步写一句话进 localStorage。
     *
     * ⚠️ 和 crash_note 的区别只有一个但很关键：marker 是**同步落盘**的。
     *    崩在下一行时，这句话已经在磁盘上了。所以它只能用在"几步一次"的关键
     *    节点上（开始下发路线 / 起循环 / 停循环），不能放进 10Hz 循环里。
     */
    crash_marker(kind, data) {
      try {
        const C = root.NavPuckCrash;
        if (C && typeof C.marker === 'function') C.marker(kind, data);
      } catch (_e) { /* 同上 */ }
    }

    toast(msg, ms) {
      const el = $('toast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(this._toast_t);
      this._toast_t = setTimeout(() => el.classList.remove('show'), ms || 3000);
    }

    set_link_state(state, info) {
      const el = $('link-state');
      const names = { idle: '未连接', connecting: '连接中…', up: '已连接', down: '已断开' };
      if (el) {
        el.textContent = names[state] || state;
        el.dataset.state = state;
      }
      const dn = $('device-name');
      if (dn) dn.textContent = (info && info.name) ? info.name : '';
      const cb = $('connect-btn');
      if (cb) cb.disabled = (state === 'connecting' || state === 'up');
      const db = $('disconnect-btn');
      if (db) db.disabled = (state === 'idle');
      // "重试扫描"跟"连接设备"是同一件事的两个入口：扫描中/已连上时不能重复点。
      // （失败之后这个按钮由 render_scan_state 显出来，见 do_connect。）
      const rb = $('rescan-btn');
      if (rb) rb.disabled = (state === 'connecting' || state === 'up');
      if (state === 'up') this.toast('设备已连接');
      if (state === 'down') this.toast('链路断开', 5000);

      // 链路状态一变，分片那一格也要跟着变：连上之后才有 MTU，
      // "当前 N 字节 / 已确认 M / 上限 …" 才是完整的。
      this.update_chunk_ui();

      // ---- 时钟：连上就发一次，之后由那个 1 秒看门狗 tick 每 30 秒补一次 ----
      //
      // 设备是 ESP32-S3，**没有电池 RTC**（断电即失），也不可能开 WiFi 走 NTP
      // （它跑 BLE 跟这台手机连，WiFi 和 BLE 抢同一个射频），所以时间只能由
      // 这边推过去：协议是 NAV_CLOCK(0x06)，6 字节。
      // 设备端只存 (UTC 秒, 收到时的 millis())，之后靠毫秒计数器自己走 ——
      // 所以这 30 秒里链路断不断都不影响它走时，这个间隔只用来纠正晶振漂移
      // （ESP32 的日漂移在**秒**量级，30 秒最多几毫秒，保证"分钟"永远对）。
      //
      // ⚠️ 必须**同时**挂在 connect 和定时补发上，缺一不可：
      //    只挂 connect —— 设备中途复位（烧录/上电抖动）后就一直显示 --:--，
      //                   而手机这边完全看不出来；
      //    只挂定时器 —— 页面刚连上、离下一次 tick 还有 29 秒，那半分钟里
      //                   主页上的时间是 --:--。
      //
      // ⚠️ 补发**不用 setInterval**，而是搭在 init() 里那个已经存在的 1 秒
      //    看门狗上（tick_clock）。理由是一次实测出来的坑：setInterval 在
      //    "断开连接"和"页面销毁"这两条路上都必须记得 clear，漏一条就是一个
      //    永不停止的定时器 —— 它会在链路早就断了之后继续往一个死对象上写，
      //    而且**自测里会串到别的用例上**（某个用例的假设备突然多收一帧时钟，
      //    断言 NAV_ROUTE 分片数就开始莫名其妙地不对）。
      //    搭在已有的 tick 上还有一个好处：30 秒 = 30 个 tick，确定性可测。
      if (state === 'up') {
        this._clock_next_ms = 0;      // 让下一次 tick 立刻补发一次
        this.send_clock();
      } else {
        // 断开就把"下次该发"的时刻清掉：留着它，重连之后第一次 tick 会立刻
        // 发一次（这没问题），但真正的理由是别让状态跨链路生命周期残留。
        this._clock_next_ms = 0;
      }
    }

    /**
     * 每 1 秒调一次（挂在 init() 的看门狗定时器上）：到点就把手机时间推给设备。
     *
     * 只在**链路是 up 的时候**发 —— send_frame 自己也会判一次，但在这里就
     * 判掉可以让"没连上时不做任何事"一眼可见。
     */
    tick_clock() {
      if (!this.ble || !this.ble.connected) return;
      const now = Date.now();
      if (this._clock_next_ms !== 0 && now < this._clock_next_ms) return;
      this._clock_next_ms = now + CLOCK_RESEND_MS;
      this.send_clock();
    }

    /** 把**手机**的当前时间 + 真实时区推给设备（NAV_CLOCK）。 */
    send_clock() {
      // proto.now_clock() 里已经处理好那个最容易写反的符号：
      //   new Date().getTimezoneOffset() 北京是 **-480**（"UTC 减本地"），
      //   协议要的是"本地相对 UTC"-> 取负 = +480。
      // 写反的后果是设备上的钟差**一整个时区**，而屏幕上看起来完全正常。
      const frame = proto.encode_nav_clock(proto.now_clock());
      const ok = this.send_frame(frame, 'ctl', 1);
      // 日志只在**状态变化**时写一行（日志面板就那么高，每 30 秒刷一行会把它淹掉），
      // 但"只记成功那一次"和"只记第一次尝试"是两件不同的事：
      //
      // ⚠️ `_clock_logged` 必须**发成功之后**才置位。原来它是"第一次尝试"就置位的
      //    （无论成败），于是"连上那一瞬间链路还没就绪"会把唯一的日志名额用掉：
      //    之后每 30 秒的补发**即使全部成功**，日志面板上也永远只有最初那条
      //    "链路未就绪"。真机上排查"主页还是 --:--"时，这一点会把人直接引到
      //    "手机根本没发过"这个错误结论上 —— 而实际是发了、只是没到。
      //    失败也照样留痕（不静默），但按"从好变坏"去重，不刷屏。
      const c = proto.now_clock();
      const line = `[clock] 设备时间 ${new Date(c.epoch_s * 1000).toLocaleString()}` +
                   `（时区 ${c.tz_offset_min >= 0 ? '+' : ''}${c.tz_offset_min} 分钟）`;
      if (ok) {
        this._clock_failed = false;
        if (!this._clock_logged) {
          this._clock_logged = true;
          this.log(`${line} 已下发`);
        }
      } else if (!this._clock_failed) {
        this._clock_failed = true;
        this.log(`${line} **没送进发送队列**（链路未就绪，30 秒后自动重试）`);
      }
      return ok;
    }

    set_status(s) {
      const el = $('battery');
      if (!el) return;
      if (!s) { el.textContent = '—'; return; }
      el.textContent = `${s.battery_pct}% / ${(s.vbat_mv / 1000).toFixed(2)}V`;
    }

    /**
     * 画"定位"这一组读数。
     *
     * 之前这里只把 kind 翻成四个字（等待定位/已定位/…），而错误文本只写进日志 ——
     * 可日志默认是**收起**的（#log 要勾"显示日志"才可见）。于是室内等不到定位的
     * 用户看到的就是"等待定位"加一句永远不动的"正在等待 GPS 定位…"：既不知道
     * 为什么，也不知道该干什么（真实反馈）。
     *
     * 现在把**状态 + 最后一次错误 + 收到过几次 fix + 精度**全部摆到面板上，
     * 并且在 denied / unavailable / waiting 时明确给出下一步做什么。
     *
     * @param {string} kind 'ok' | 'waiting' | 'denied' | 'unavailable' | 'manual' | 'simdrive'
     * @param {string} msg  错误/说明文本（可空）
     * @param {object} src  产生这次状态的位置源（默认 GPS 源）
     */
    set_gps_state(kind, msg, src) {
      const names = {
        ok: '已定位', waiting: '等待定位', denied: '权限被拒',
        unavailable: '不可用', manual: '手动定位', simdrive: '模拟行驶',
      };
      const el = $('gps-state');
      if (el) {
        el.textContent = names[kind] || kind;
        el.dataset.state = kind;
      }

      const s = src || this.geo;
      const has_src_fix = !!(s && s.has_fix && s.has_fix());

      // 最后一次错误 / 当前位置来源
      const err = $('gps-error');
      if (err) {
        if (kind === 'simdrive') {
          // 模拟行驶：把"走到哪了 + 当前航向"摆出来。它本身就是最有力的
          // "这是模拟"的证据 —— 真实 GPS 不可能告诉你航线里程。
          // ⚠️ 认的是 src 自己（is_route_sim），不是靠 kind 猜：万一传进来的是
          //    GPS 源（比如模拟源还没建起来），下面这些 s / total_m 就不存在，
          //    直接取会在**报错的那条路上**再抛一个 TypeError。
          const rs = (s && s.is_route_sim === true) ? s : null;
          const total = (rs && rs.has_route()) ? rs.route.total_m : 0.0;
          err.textContent = (rs && rs.has_fix())
            ? `模拟行驶：沿航线 ${(rs.s / 1000).toFixed(2)} / ${(total / 1000).toFixed(2)} km` +
              `，航向 ${fmt(rs.heading, 0)}°（不是真实 GPS）` +
              (rs.arrived ? '，已到终点' : '')
            : '模拟行驶：还没有可用的航线（先"规划并开始导航"）—— 不是真实 GPS';
        } else if (kind === 'manual') {
          err.textContent = has_src_fix
            ? `模拟位置 ${s.lat.toFixed(6)}, ${s.lon.toFixed(6)}（不是真实 GPS）`
            : '手动位置未设置';
        } else if (msg) {
          err.textContent = `最近一次错误：${msg}`;
        } else if (kind === 'ok') {
          err.textContent = '定位正常';
        } else if (kind === 'waiting') {
          err.textContent = '还没有收到任何定位数据';
        } else {
          err.textContent = '—';
        }
      }

      // 收到过几次 fix / 当前精度（米）。手输坐标没有精度，显示 — 而不是编一个数。
      const fx = $('gps-fixes');
      if (fx) fx.textContent = String((s && s.fix_count) ? s.fix_count : 0);
      const ac = $('gps-accuracy');
      if (ac) {
        ac.textContent = (s && Number.isFinite(s.accuracy_m))
          ? `±${fmt(s.accuracy_m, 0)} m` : '—';
      }

      // 出问题时给出**下一步做什么**，而不只是报状态
      const hint = $('gps-hint');
      if (hint) {
        let text = '';
        if (kind === 'denied') {
          text = '定位权限被拒绝：点地址栏左边的锁图标，把"位置"改回允许后刷新页面。' +
                 '室内也可以展开"高级 / 手动定位"，用手输坐标把整条链路测通。';
        } else if (kind === 'unavailable') {
          text = '定位不可用：室内/地下车库基本收不到 GPS，请到窗边或室外再试；' +
                 '也可以展开"高级 / 手动定位"先用手输坐标测试。';
        } else if (kind === 'waiting') {
          text = '还在等定位：室内收不到 GPS，请到窗边或室外；' +
                 '也可以展开"高级 / 手动定位"先用手输坐标测试。';
        }
        if (kind === 'simdrive') {
          text = '正在模拟行驶（沿航线自动推进，不是真实定位）：GPS 已经不影响导航。' +
                 '取消勾选可切回真实定位。';
        } else if (this.manual && !this.simdrive) {
          text = '正在使用手动位置（模拟坐标），GPS 已经不影响导航。' +
                 '取消勾选可切回真实定位。';
        }
        hint.textContent = text;
        hint.hidden = !text;
      }

      if (msg) this.log(`[gps] ${msg}`);
    }

    // -- 屏幕常亮 / 后台限流 --------------------------------------------------
    /**
     * 屏幕常亮的持有者（懒创建 + 全局唯一）。
     *
     * 懒创建的原因和底图源一样：不导航时根本用不上它，而 App 在 Node 自测里
     * 也会被构造（那里没有 navigator.wakeLock）。所有入口都走这一个方法，
     * 免得出现"两个 ScreenWakeLock 各持一把锁"。
     */
    wake() {
      if (this._wake) return this._wake;
      try {
        this._wake = new ScreenWakeLock({
          onLog: (l) => this.log(l),
          // 锁的状态一变就立刻重画那一格（否则要等下一帧 on_ui，最多 100ms，
          // 看着像点了没反应；不导航时更要靠它 —— 那时根本没有 on_ui）
          onChange: () => this.render_awake_loop(this._ui_last),
        });
      } catch (e) {
        this._wake = null;
        this.log(`[wake] 屏幕常亮模块建不起来：${e}（导航不受影响）`);
      }
      return this._wake;
    }

    /** 页面现在是不是在后台（Node 自测里没有 document，一律当作在前台）。 */
    page_hidden() {
      return (typeof document !== 'undefined' && document.visibilityState === 'hidden');
    }

    /**
     * 画"屏幕常亮"和"循环"两格，以及底下那行说明。
     *
     * 这是这一版给"切到后台就变卡"这件事的**可见**部分：用户看到的是
     * "页面在后台，帧率已降"，而不是"导航莫名其妙卡住了"。文案分三种情况：
     *   - 真的掉出 10Hz 且页面在后台：那四个字 + 为什么会这样 + 怎么恢复；
     *   - 掉出 10Hz 但页面在前台：是这台设备卡（GC / 别的页面抢 CPU）；
     *   - 没掉帧：显示实测 Hz。
     * 屏幕常亮那一格单独说锁的状态（已保持 / 未保持 / 不支持 / 失败 / 已释放）。
     *
     * ⚠️ 由 on_ui **每帧**调用（10Hz），所以：
     *   - 只在算出来的快照**变了**的时候才碰 DOM（见 this._awake_last）；
     *   - 不在这里做任何重活（字符串拼接本身很便宜，但每帧写 DOM 不是）。
     *
     * @param {object|null} d Navigator 的 onUi 快照（没有就只用本机状态）
     */
    render_awake_loop(d) {
      const loop_el = $('loop-info');
      const wake_el = $('wake-info');
      const detail_el = $('loop-detail');
      if (!loop_el && !wake_el && !detail_el) return;

      const nav = this.nav;
      if (d) this._ui_last = d;
      const snap = (d || this._ui_last || null);
      const w = this._wake ? this._wake.state() : { state: 'idle', supported: false, reason: '' };

      // ---- 屏幕常亮那一格 ----
      let wake_short = '空闲';
      let wake_state = 'idle';
      switch (w.state) {
        case 'held': wake_short = '已保持'; wake_state = 'ok'; break;
        case 'released': wake_short = '已释放'; wake_state = 'warn'; break;
        case 'failed': wake_short = '失败'; wake_state = 'bad'; break;
        case 'unsupported': wake_short = '不支持'; wake_state = 'muted'; break;
        default: wake_short = this.page_hidden() ? '已释放' : '空闲'; wake_state = 'muted'; break;
      }

      // ---- 循环那一格 ----
      const navigating = !!nav;
      const hidden = this.page_hidden() || !!(snap && snap.page_hidden);
      // 没在导航时"掉帧"没有意义（停止后根本没有循环在跑）——
      // 那两格要如实写"— / 空闲"，而不是留着上一次的数
      const slow = navigating && !!(snap && snap.loop_slow);
      const gap_ms = navigating && snap && snap.loop_gap_ms ? snap.loop_gap_ms : 0.0;
      const hz = gap_ms > 0 ? (1000.0 / gap_ms) : 0.0;
      let loop_short = '—';
      let loop_state = 'muted';
      if (!navigating) {
        loop_short = '—';
      } else if (slow) {
        loop_short = hidden ? '页面在后台，帧率已降' : '帧率不足';
        loop_state = 'bad';
      } else {
        // 整数 Hz：定时器抖动会让小数位每帧都变（9.8/10.2…），而这个函数是
        // 每帧都调的 —— 显示整数才不会为了"10.0 → 9.9"每帧白写一次 DOM
        loop_short = `${hz.toFixed(0)} Hz`;
        loop_state = 'ok';
      }

      // ---- 底下那行说明：只在有话说的时候出现 ----
      let detail = '';
      if (snap && slow && hidden) {
        // 这一句就是"用户以为 app 坏了"和"用户知道是浏览器在限流"的分界
        detail = `页面在后台，帧率已降：这一帧距上一帧 ${gap_ms.toFixed(0)} ms` +
          `（10Hz 应为 100 ms）。浏览器把后台标签页的定时器压到了约 1 秒一次，` +
          `设备因此大约每秒才收到一帧。这不是导航坏了 —— 把页面切回前台会立刻` +
          `恢复到 10Hz（已累计发出 ${snap.frames_sent || 0} 帧），屏幕常亮${wake_short}。`;
      } else if (snap && slow) {
        detail = `循环没跑满 10Hz：这一帧距上一帧 ${gap_ms.toFixed(0)} ms` +
          `（应为 100 ms）。页面在前台，说明是这台设备本身卡顿（别的页面抢 CPU、` +
          `定位/地图开销等），导航仍然照常，已累计发出 ${snap.frames_sent || 0} 帧。`;
      } else if (w.state === 'failed') {
        detail = `屏幕常亮没拿到（${w.reason || '原因未知'}）：导航完全不受影响，` +
          `但屏幕可能会自己熄灭 —— 请手动保持屏幕常亮，切后台/锁屏会让帧率掉到约 1Hz。`;
      } else if (w.state === 'unsupported') {
        detail = '这个浏览器不支持屏幕常亮（Screen Wake Lock）：导航照常，' +
          '请手动保持屏幕常亮 —— 锁屏或切到后台时浏览器会把帧率压到约 1Hz。';
      } else if (hidden && w.want) {
        detail = '页面在后台：浏览器会收走屏幕常亮锁、并把定时器压到约 1Hz；' +
          '回到前台会自动重新申请常亮锁并恢复 10Hz。';
      }

      // 只在**变了**的时候碰 DOM（这个函数每帧都被调用，见上面的说明）
      const stamp = [loop_short, wake_short, detail, loop_state, wake_state].join('\u0000');
      if (stamp === this._awake_last) return;
      this._awake_last = stamp;

      if (loop_el) {
        loop_el.textContent = loop_short;
        loop_el.dataset.state = loop_state;
      }
      if (wake_el) {
        wake_el.textContent = wake_short;
        wake_el.dataset.state = wake_state;
      }
      if (detail_el) {
        detail_el.textContent = detail;
        detail_el.hidden = !detail;
        detail_el.classList.toggle('warn', slow);
      }
    }

    on_ui(d) {
      const u = d.update;
      const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
      set('speed', fmt(u.speed_kmh, 1));
      set('remaining', nm.format_distance(u.dist_dest_m));
      set('next-turn', d.turn_name + (d.road_name ? ` · ${d.road_name}` : ''));
      set('turn-dist', nm.format_distance(u.dist_next_m));
      set('view-range', `${fmt(u.view_range_m, 0)} m`);
      set('progress', `${u.progress_pct}%`);
      set('heading', `${fmt(u.heading_deg, 0)}°`);
      set('eta', `${u.eta_min} min`);
      const frames = $('frames');
      if (frames) {
        // "已发 / 丢"这一格：丢帧是允许的（update 过时了没意义），但**丢 route
        // 帧绝不允许静默** —— ble.js 里 route_frames_dropped 的不变量是 0，
        // 一旦非 0 就把那部分显式写到这一格上（正常时一个字符都不多）。
        // 逐帧的丢帧原因在 ble.js 的日志里（onLog -> 日志面板）。
        frames.textContent = this.ble
          ? `${this.ble.frames_sent} / ${this.ble.frames_dropped}丢` +
            (this.ble.route_frames_dropped > 0
              ? `（route ${this.ble.route_frames_dropped}）` : '')
          : String(this.nav ? this.nav.frames_sent : 0);
      }
      // 屏幕常亮 + 循环节拍：用户能一眼看出"屏幕是不是被保持常亮"以及
      // "帧率是不是掉了"（见 render_awake_loop，它内部只在变化时碰 DOM）
      this.render_awake_loop(d);
      // ---- 底图：一个短状态 + 一行常显的详情 ----
      //
      // 以前这里只写"等待路网…"，于是 Overpass 整体挂掉时用户看到的就是永远
      // 不动的四个字：既不知道这是上游故障，也不知道**导航其实好好的**。
      // 现在短格只说状态，详情那一行说清楚"为什么、下一步做什么"。
      const ms = this.map_status();
      set('map-info', ms.short);
      const mi = $('map-info');
      if (mi) mi.dataset.state = ms.state || '';
      const md = $('map-detail');
      if (md) {
        md.textContent = ms.detail || '';
        md.hidden = !ms.detail;
        // ⚠️ 需要"黄色警告"的状态列表。新加的 gap-busy（没瓦片覆盖 + Overpass
        //    也忙）**必须**在里面 —— 它是这一版最需要被看见的一句话，
        //    样式上和普通"底图正常"一样的话就等于没说。
        md.classList.toggle('warn', ms.state === 'unavailable' || ms.state === 'stale'
          || ms.state === 'busy' || ms.state === 'gap-busy' || ms.state === 'empty'
          || ms.state === 'tiles-partial');
      }
      // 模拟行驶的实时读数：走到哪了、速度多少、航向多少（过弯时会变）。
      // 每帧都刷，因为它就是"这条路真的在动"的证据。
      this.update_sim_readout();
      // ⭐ 地图：on_ui 是 10Hz 调的，而地图**不需要**跟着 10Hz 重画
      //    （位置本身就没那么快，而且每帧重画白烧电）。mapview.js 内部有
      //    5Hz 节流，这里只管"来敲一下"。
      this.mapview_frame(false);
    }

    /**
     * 画"模拟行驶"那一行实时读数，并在**刚到终点**时提示一次。
     *
     * 光有横幅不够：室内测试时用户要一眼看出"走到哪了、航向是不是跟着路转"，
     * 这三个数（里程 / 速度 / 航向）就是最直接的证据，也不必去翻默认收起的日志。
     */
    update_sim_readout() {
      const el = $('sim-info');
      const s = this.routesim;
      if (!el) return;
      if (!this.simdrive || !s || !s.has_route()) {
        el.hidden = true;
        el.textContent = '';
        return;
      }
      const total = s.total_m();
      const pct = total > 0 ? Math.max(0, Math.min(100, s.s * 100.0 / total)) : 0;
      el.hidden = false;
      el.textContent =
        `模拟行驶：沿航线 ${(s.s / 1000).toFixed(2)} / ${(total / 1000).toFixed(2)} km` +
        `（${pct.toFixed(0)}%）· ${fmt(s.speed_kmh, 0)} km/h · 航向 ${fmt(s.heading, 0)}°` +
        (s.arrived ? ' · 已到终点（已停住，不绕回起点）' : '');

      const badge = $('sim-badge');
      if (badge) badge.dataset.state = s.arrived ? 'arrived' : 'running';

      // "已到终点"只提示一次。每帧都弹的话那个 toast 会永远关不掉。
      if (s.arrived && !this._sim_arrived) {
        this._sim_arrived = true;
        this.log('[sim] 模拟行驶已到终点：位置停在终点、速度归零（刻意不绕回起点）');
        this.toast('模拟行驶已到终点', 6000);
      }
    }

    // -- 街道路网底图 --------------------------------------------------------
    /**
     * 底图源：**懒创建 + 全局唯一**。
     *
     * 必须是同一个实例：缓存命中计数、失败退避、状态机全挂在它身上，
     * 每次导航重建一个的话"上次刚失败过"这件事就丢了，会立刻再去打一遍
     * Overpass（正是要避免的那种行为）。
     *
     * @returns {OsmMapSource|null} null = map.js 没加载成功（此时界面会说清楚）
     */
    map_source_instance() {
      if (this.map_source) return this.map_source;
      try {
        this.map_source = new mapmod.OsmMapSource();
        this.map_source.set_enabled(!!this.map_enabled);
      } catch (e) {
        this.map_source = null;
        this.log(`[map] 底图源建不起来：${e}（导航不受影响，只是没有街道路网）`);
      }
      return this.map_source;
    }

    /**
     * 当前该显示的底图状态。
     *
     * 正常情况直接抄 OsmMapSource.status()（短状态 + 一句人话 + 逐镜像原因）；
     * App 只负责补一种它才知道的情况：**底图源压根没建起来**（map.js 没加载）。
     * 那种情况绝不能报成"Overpass 无响应"—— 那会把用户引到完全错误的方向。
     */
    map_status() {
      const nav = this.nav;
      if (!nav) {
        // 还没开始导航：底图这一格保持"没有数据"（和别的格子的 — 一致），
        // 而不是"等待路网…" —— 那句话什么都没有说明白。
        if (!this.map_enabled) {
          return { state: 'disabled', short: '已关闭', detail: MAP_DISABLED_TEXT };
        }
        return {
          state: 'idle', short: '—',
          detail: '还没有开始导航：底图会在导航启动后自动准备 —— 优先取**离线瓦片**' +
            '（预先做好的路网，从项目自己的站点下载，几十 KB 一块），' +
            '只有瓦片覆盖不到的地方才去问 Overpass。',
        };
      }
      const src = nav.map_src || this.map_source;
      if (src && typeof src.status === 'function') {
        // 时钟用导航循环的（秒）：界面要显示"还有几秒重试"
        return src.status(nav.clock_s);
      }
      if (!this.map_enabled) {
        return { state: 'disabled', short: '已关闭', detail: MAP_DISABLED_TEXT };
      }
      return {
        state: 'unavailable',
        short: '底图不可用',
        summary: '底图模块（map.js）没有加载成功，所以这次没有街道路网底图。',
        detail: '底图模块（map.js）没有加载成功：这次不会有街道路网，也不会向 ' +
          'Overpass 发任何请求；路线、箭头、转向提示和 10Hz 更新都不受影响。' +
          '刷新页面（或清一次站点数据重装 PWA）可以重试。',
      };
    }

    // -- 地图（Canvas，手机端唯一"能看见地图"的地方）------------------------
    //
    // 用户的诉求就是这一块："我要在手机端 app 看到地图"。以前手机端只有控制
    // 面板和一堆数字，地图**只出现在设备那块圆屏上**（而且只有手机推过去的那
    // 一点视距）。现在这一块把同一份路网画在手机上：不引入任何地图库、不需要
    // 付费底图服务，数据只来自**已经缓存的离线瓦片** + 已规划航线。
    //
    // 三条边界：
    //   1) 地图这一层**一个网络请求都不发**。路网要么是 OsmMapSource 已经拿到
    //      的那份（它自己离线优先），要么是本地瓦片（TileStore.local_area，
    //      纯 IndexedDB 读）。所以"没有网也能看到当前位置一带的路网"是结构
    //      决定的，不是承诺（自测用"fetch 一律抛错"钉着它）。
    //   2) 它**绝不阻塞导航**：画一帧是纯 CPU（240×240 上实测 <1ms，见自测的
    //      性能那节），而且每帧最多画一次（mapview.js 里 5Hz 节流）。
    //   3) 底图开关关掉时地图**不画街道路网**（只画航线与当前位置）—— 那个
    //      勾选框的字面意思就是"显示街道路网底图"，说到就要做到。

    /**
     * 地图视图：**懒创建 + 全局唯一**。
     *
     * 唯一是必须的：画布尺寸/DPR/视图中心/手势状态/本地瓦片缓存全挂在它身上，
     * 每次重画都新建一个的话，用户拖动一下地图就被重置回当前位置了。
     *
     * @returns {MapView|null} null = mapview.js 没加载成功，或页面上没有画布
     */
    mapview_instance() {
      if (this.mapview) return this.mapview;
      const cv = $('mapview');
      if (!mvmod || !mvmod.MapView) {
        this.log('[mapview] 地图模块（mapview.js）没加载成功：手机上看不到地图' +
                 '（导航、蓝牙、10Hz 更新都照常）');
        return null;
      }
      if (!cv) {
        this.log('[mapview] 页面上没有 #mapview 画布：手机上看不到地图');
        return null;
      }
      const self = this;
      const demo = rt.DEMO_ROUTE;
      try {
        this.mapview = new mvmod.MapView(cv, {
          // ① 同步：OsmMapSource 手上那份（离线瓦片优先、Overpass 兜底）
          ways: () => self.mapview_ways(),
          // ② 异步、**先本地、缺的排下载**：地图自己按视野取瓦片 ——
          //    没有这一条，用户不先开始导航就永远只能看到一张空地图。
          load_area: (lat, lon, r) => self.mapview_load_area(lat, lon, r),
          // ③ 异步、**只读本地**：明确离线（navigator.onLine === false）时用它，
          //    一个请求都不发（飞行模式/隧道里不该白费电和白等超时）。
          load_local: (lat, lon, r) => self.mapview_load_local(lat, lon, r),
          online: () => self.is_online(),
          pos: () => self.mapview_pos(),
          route: () => self._mv_route,
          // 还没有定位时的初始中心：内置演示航线的起点。不这么做的话，
          // 第一次打开页面是一片空白，看起来就像"地图坏了"。
          center: [demo[0][0], demo[0][1]],
          on_status: (st) => self.mapview_status(st),
          log: (l) => self.log(l),
        });
      } catch (e) {
        this.mapview = null;
        this.log(`[mapview] 地图视图建不起来：${e}（导航不受影响）`);
        return null;
      }
      this.mapview.attach(cv);
      // ⭐ 瓦片到货要能立刻上屏：store 的 on_change 原来是 map.js 独占的
      //    （它只置一个 tiles_dirty，而那个标志**只有导航循环在跑**时才有人消费）。
      //    地图这一层必须自己接一份，否则"不导航时地图永远停在第一帧"。
      this.mapview_watch_tiles(this.map_source_instance());
      this.log('[mapview] 地图已就绪：拖动平移、双指/滚轮缩放、' +
               '「回到当前位置」回到跟随（路网优先用已缓存的离线瓦片，缺的会在后台补）');
      return this.mapview;
    }

    /** 有没有网：地图据此决定走"排下载"还是"只读本地"。 */
    is_online() {
      if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
        return false;
      }
      return true;
    }

    /**
     * 把 `TileStore.on_change` 接到地图上（**幂等**）。
     *
     * ⚠️ 必须**链式**接，不能直接覆盖：map.js 自己也挂了 on_change
     *    （`this.tiles_dirty = true`，导航循环靠它重建底图）。覆盖掉它的症状是
     *    "导航中底图不再跟着新瓦片更新"，而且完全看不出来是哪一步弄坏的。
     */
    mapview_watch_tiles(ms) {
      if (!ms || !ms.tiles || ms.tiles._navpuck_mv_watched) return false;
      const prev = ms.tiles.on_change;
      const self = this;
      ms.tiles.on_change = function (store) {
        try { if (prev) prev(store); } catch (_e) { /* map.js 那边出错不该拖累地图 */ }
        try {
          if (self.mapview) self.mapview.on_tiles_changed(store || ms.tiles);
        } catch (_e) { /* 地图重画失败也不影响导航 */ }
      };
      ms.tiles._navpuck_mv_watched = true;
      return true;
    }

    /**
     * 地图要的这一带路网：**先本地、缺的排下载**（`TileStore.load_area`）。
     *
     * 它和 `mapview_load_local` 只差一件事：`load_area` 会把缺的块**排进下载
     * 队列**（后台、有并发上限和失败冷却）。没有它，用户不先开始导航就只能看到
     * 一张空地图 —— 瓦片原来只在导航过程中由 map.js 下载。
     *
     * ⚠️ 它**不会等下载完**：立刻返回"手上已经有的那部分"，所以画图那一帧永远
     *    不等网络；块到了通过 on_change 通知地图重画。
     */
    mapview_load_area(lat, lon, radius_m) {
      if (!this.map_enabled) return null;
      const ms = this.map_source_instance();
      if (!ms || !ms.tiles) return null;
      this.mapview_watch_tiles(ms);
      try {
        if (typeof ms.tiles.load_area === 'function') {
          return ms.tiles.load_area(lat, lon, radius_m);
        }
      } catch (e) {
        this.log(`[mapview] 这一带取数出错（地图继续画已有的）：${e}`);
      }
      return this.mapview_load_local(lat, lon, radius_m);
    }

    /**
     * 地图要画的路网（同步，每帧调）。
     *
     * 只认 `OsmMapSource.ways`：它的形状是 `[[rank,[[lat,lon],...]],...]`，
     * 而瓦片解码、Overpass 兜底、缓存全都已经在那一层处理过了（见 map.js）。
     * 底图关掉时返回 null —— 地图退回"只画航线与当前位置"。
     */
    mapview_ways() {
      if (!this.map_enabled) return null;
      const ms = this.map_source || (this.nav && this.nav.map_src);
      if (ms && Array.isArray(ms.ways) && ms.ways.length) return ms.ways;
      return null;
    }

    /**
     * 从**本地瓦片**里取一片路网（内存 + IndexedDB，**完全离线**）。
     *
     * ⚠️ 用的是 `TileStore.local_area()`：它只读本地、不排下载、不碰 fetch
     *    （见 tiles.js 里那段说明）。所以这一条路径在飞行模式下也照样出数据，
     *    而且**一个请求都不发** —— 明确离线时地图走的就是它（见 mapview_load_area）。
     *
     * 它同时覆盖了"还没开始导航"这个场景：导航循环不跑的时候没有人去调
     * OsmMapSource.refresh()，地图就自己把这一带读出来。
     */
    mapview_load_local(lat, lon, radius_m) {
      if (!this.map_enabled) return null;
      const ms = this.map_source_instance();
      if (!ms || !ms.tiles) return null;
      try {
        if (typeof ms.tiles.local_area === 'function') {
          return ms.tiles.local_area(lat, lon, radius_m);
        }
      } catch (e) {
        this.log(`[mapview] 本地瓦片读取出错（地图继续画已有的）：${e}`);
      }
      return null;
    }

    /**
     * 地图上"当前位置"从哪来：**和导航用的是同一个位置源**。
     *
     * 优先级由 active_source() 决定（模拟行驶 > 手动位置 > GPS），所以地图上
     * 那个绿点和设备屏幕上那台车**永远是同一个点** —— 不会出现"手机说在这、
     * 设备画在那"。没有定位就退回导航起点（用户按过"用当前位置作起点"的那个）。
     */
    mapview_pos() {
      const src = this.active_source();
      if (src && src.lat !== null && src.lon !== null &&
          Number.isFinite(src.lat) && Number.isFinite(src.lon)) {
        return [src.lat, src.lon, src.heading];
      }
      if (this.start_lat !== null && this.start_lon !== null) {
        return [this.start_lat, this.start_lon, null];
      }
      return null;
    }

    /**
     * 画一帧地图。**在页面后台时直接跳过**（屏幕都没亮，画了也看不见，
     * 只是白烧电）。
     *
     * @param {boolean} force true = 忽略 5Hz 节流（手势、按钮、刚拿到数据）
     */
    mapview_frame(force) {
      const mv = this.mapview_instance();
      if (!mv) return false;
      if (this.page_hidden()) return false;
      try {
        return mv.tick(!!force);
      } catch (e) {
        // 地图画不出来绝不能让 10Hz 循环看到异常（on_ui 会调到这里）
        this.log(`[mapview] 画一帧出错（本次跳过）：${e}`);
        return false;
      }
    }

    /** 把地图状态写进面板（和底图那一格同一个路数：短格 + 一行详情）。 */
    mapview_status(st) {
      this._mv_last = st;
      const el = $('mapview-state');
      const d = $('mapview-detail');
      // 底图关掉时**不要**说"暂无路网" —— 那看起来像"这一带没数据"，
      // 而事实是用户自己关掉的。状态必须说得清楚。
      if (!this.map_enabled) {
        if (el) { el.textContent = '已关闭'; el.dataset.state = 'idle'; }
        if (d) {
          d.textContent = '街道路网底图已关闭：地图只画航线与当前位置（一个请求都不发）。' +
            '在「选项」里重新勾上就能恢复。';
          d.classList.remove('warn');
        }
        return;
      }
      if (el) {
        el.textContent = st.short;
        el.dataset.state = st.state || '';
      }
      if (d) {
        d.textContent = st.detail || '';
        d.classList.toggle('warn', st.state === 'empty' || st.state === 'unavailable');
      }
    }

    /** 设置地图上的航线折线（null = 清掉）。 */
    set_mapview_route(pts, recenter) {
      this._mv_route = (pts && pts.length >= 2) ? pts : null;
      const mv = this.mapview_instance();
      if (!mv) return false;
      if (recenter && pts && pts.length >= 2) {
        mv.follow = true;
        mv.set_center(pts[0][0], pts[0][1], true);
      }
      mv.invalidate();
      this.mapview_frame(true);
      return true;
    }

    // -- 地点搜索（见 phone/search.js）--------------------------------------
    //
    // 用户的诉求："输个地名就能当目的地"。以前只能手输经纬度或者从 7 个预设里
    // 挑一个 —— 骑行途中在手机上输六位小数是不现实的。
    //
    // ⚠️ 四条不能破的边界（前两条是 search.js 里实测出来的，不是猜的）：
    //   1) **必须带位置偏置**。不带偏置搜「西湖」会返回**台湾高雄**的同名地点
    //      （实测差 800 公里、跨了一个省）。偏置取"当前位置 → 导航起点 →
    //      地图中心"，一个都没有时**照搜**，但在界面上如实写"未按位置排序"。
    //   2) **"没这个地方"和"请求失败"必须长得不一样**。search.js 已经区分好了
    //      （`ok:true, results:[]` vs `ok:false`），界面这一层不许把它们揉成
    //      同一句话 —— 前者换个词就行，后者要等网络。
    //   3) 搜索**绝不拖累导航**：它整条路都在 try/catch 里，`search()` 本身也
    //      承诺永不 reject，任何异常都只表现为"这次没搜到"。
    //   4) 点选结果时**必须把"常用地点"下拉清回"自定义坐标"** ——
    //      `read_destination()` 里预设是优先于坐标框的（见那里的说明），不清掉
    //      的话用户点了搜索结果、坐标框也变了，但按"规划并开始导航"用的还是
    //      下拉里那个旧地点。这个坑很隐蔽，自测里专门钉了一条。

    /** 偏置点从哪来：当前位置 > 导航起点 > 地图中心 > 没有。 */
    search_bias() {
      const src = this.active_source();
      if (src && Number.isFinite(src.lat) && Number.isFinite(src.lon)) {
        return { lat: src.lat, lon: src.lon, from: 'gps' };
      }
      if (Number.isFinite(this.start_lat) && Number.isFinite(this.start_lon)) {
        return { lat: this.start_lat, lon: this.start_lon, from: 'start' };
      }
      const mv = this.mapview;
      if (mv && mv.view && Number.isFinite(mv.view.lat) && Number.isFinite(mv.view.lon)) {
        return { lat: mv.view.lat, lon: mv.view.lon, from: 'map' };
      }
      return null;
    }

    /** 偏置来源的人话（界面上要说清楚"这次是按什么排的"）。 */
    _bias_text(bias) {
      if (!bias) return '未按位置排序';
      if (bias.from === 'gps') return '按当前位置排序';
      if (bias.from === 'start') return '按导航起点排序';
      return '按地图中心排序';
    }

    /** 写搜索状态行（三种状态三套配色，见 style.css 的 #search-info）。 */
    set_search_info(state, text) {
      const el = $('search-info');
      if (!el) return false;
      el.textContent = text || '';
      el.dataset.state = state || '';
      el.classList.toggle('warn', state === 'empty');
      return true;
    }

    /** 清空结果列表（不含状态行）。 */
    clear_search_results() {
      this.search_results = [];
      this._search_picked = -1;
      const box = $('search-results');
      if (box) {
        this._clear_children(box);
        box.hidden = true;
      }
      return true;
    }

    /**
     * 清掉一个元素的全部子节点。
     *
     * ⚠️ 刻意**不用 innerHTML**：结果里的 `name`/`detail` 是从 OSM（第三方）
     *    来的字符串，拼进 HTML 就是一个注入口子。全程 `createElement` +
     *    `textContent`，浏览器只会把它当文本。
     *    （那个 `n > 500` 的上限是防"某个元素的 removeChild 没有真的删掉"时
     *      这里转成死循环 —— 循环里的 bug 比多一行判断贵得多。）
     */
    _clear_children(el) {
      if (!el) return 0;
      let n = 0;
      while (el.firstChild && n < 500) {
        el.removeChild(el.firstChild);
        n += 1;
      }
      return n;
    }

    /**
     * 搜地名。
     *
     * @param {string} [query] 不给就读输入框
     * @returns {Promise<object|null>} search.js 的返回值；没发请求时 null
     */
    async do_search(query) {
      const input = $('search-input');
      const raw = (query === undefined || query === null) ? (input ? input.value : '') : query;
      const q = String(raw == null ? '' : raw).trim();

      // 请求序号：这一次搜索的编号。回来时对不上就说明用户又搜了一次，
      // 这时的旧结果必须**整批丢掉**，不能覆盖新的（弱网下这很常见）。
      this._search_seq += 1;
      const seq = this._search_seq;

      if (!srch || typeof srch.search !== 'function') {
        this.clear_search_results();
        this.set_search_info('error',
          '搜索模块（search.js）没加载成功：不能按地名搜索。' +
          '手输下面的纬度/经度，或者用「常用地点」都不受影响。');
        this.log('[search] search.js 没加载成功：搜索那一栏不可用（其余功能照常）');
        return null;
      }

      // 空输入**不发请求**（search.js 也是这么约定的）。这里只说清楚该做什么。
      if (!q) {
        this.clear_search_results();
        this.set_search_info('idle', '请输入地名再搜索（例如「西湖」「广州塔」）。');
        return null;
      }

      const bias = this.search_bias();
      this.set_search_info('loading', `搜索中…「${q}」`);
      this.log(`[search] 「${q}」${bias
        ? `偏置=${bias.lat.toFixed(5)},${bias.lon.toFixed(5)}（${this._bias_text(bias)}）`
        : '**没有位置偏置**：结果可能来自别的城市/省份'}`);

      let res = null;
      try {
        const opts = { limit: srch.SEARCH_LIMIT_DEFAULT };
        if (bias) { opts.lat = bias.lat; opts.lon = bias.lon; }
        if (this._search_fetch) opts.fetch = this._search_fetch;
        res = await srch.search(q, opts);
      } catch (e) {
        // search.js 承诺永不 reject，但界面这一层不能"假设别人守约"。
        res = { ok: false, results: [], error: String(e && e.message ? e.message : e),
                biased: !!bias, source: '', from_cache: false };
      }
      if (seq !== this._search_seq) {
        this.log(`[search] 「${q}」的结果已过期（用户又搜了一次），丢弃`);
        return res;
      }

      this._search_last = { q, res, bias };
      this.search_results = Array.isArray(res.results) ? res.results : [];
      this._search_picked = -1;
      this.render_search_results(this.search_results, res, bias);

      const tail = res.from_cache ? '（来自缓存）' : '';
      if (!res.ok) {
        // ⚠️ 失败就是失败：不许写成"没找到"。
        this.set_search_info('error', `搜索失败：${res.error || '未知原因'}。` +
          '导航不受影响 —— 可以直接填下面的纬度/经度，或者用「常用地点」。');
        this.log(`[search] 「${q}」失败：${res.error || '未知原因'}`);
      } else if (this.search_results.length === 0) {
        // ⚠️ "没这个地方"是成功的一种（请求通了、上游明确没这条），
        //    和上面那条失败**必须**区分开 —— 处理办法完全不同。
        this.set_search_info('empty', `没找到「${q}」这个地方${tail}。` +
          `换个说法试试（例如加城市名），或者直接填经纬度` +
          `${bias ? '' : '；另外这次**没有位置**，带不上位置偏置'}` +
          '（用「用当前位置作起点」或地图拿到位置后会更准）。');
        this.log(`[search] 「${q}」0 条（${res.source || '?'}）—— 确认"没这个地方"，不是请求失败`);
      } else {
        this.set_search_info('done',
          `找到 ${this.search_results.length} 条 · ${this._bias_text(bias)}${tail}` +
          (bias ? '' : ' ⚠️ 没有位置偏置：结果可能来自别的城市/省份，看下面的距离'));
        this.log(`[search] 「${q}」→ ${this.search_results.length} 条（${res.source || '?'}${tail}）`);
      }
      return res;
    }

    /**
     * 把结果画成可点的列表。
     *
     * 每条三行信息：名称 / 副标题（省·市·区·街道）/ 距离。
     * **副标题是必须的** —— 同名地点（"西湖"全国有好几个）光看名字分不出来；
     * **距离也是必须的** —— 800 公里外那条唯一的线索就是"812km"这个数。
     */
    render_search_results(results, res, bias) {
      const box = $('search-results');
      if (!box) return 0;
      const doc = (typeof document !== 'undefined') ? document : null;
      const list = Array.isArray(results) ? results : [];
      this._clear_children(box);
      if (!doc || list.length === 0) {
        box.hidden = true;
        return 0;
      }
      for (let i = 0; i < list.length; i += 1) {
        box.appendChild(this._mk_search_item(list[i], i, bias, doc));
      }
      box.hidden = false;
      return list.length;
    }

    /** 造一条结果的 DOM（全程 textContent，不用 innerHTML，见 _clear_children）。 */
    _mk_search_item(r, i, bias, doc) {
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'search-item';
      item.dataset.index = String(i);

      const name = doc.createElement('span');
      name.className = 'search-name';
      name.textContent = (r && r.name) ? String(r.name) : '(未命名)';
      item.appendChild(name);

      const detail = doc.createElement('span');
      detail.className = 'search-detail';
      // 副标题没有内容时，退化成 OSM 类型（`water=lake`）——总之不能是空白
      detail.textContent = (r && r.detail) ? String(r.detail)
        : ((r && r.kind) ? String(r.kind) : '');
      item.appendChild(detail);

      if (bias && r && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
        const m = nm.distance_m(bias.lat, bias.lon, r.lat, r.lon);
        const dist = doc.createElement('span');
        dist.className = 'search-dist';
        dist.textContent = `距${this._bias_text(bias)} ${nm.format_distance(m)}`;
        item.appendChild(dist);
        // 超过 50km 就标出来：这是"搜到别的城市/省份"唯一看得见的信号
        if (m > SEARCH_FAR_M) item.dataset.far = '1';
      }

      item.addEventListener('click', () => this.pick_search_result(i));
      return item;
    }

    /**
     * 点选一条结果 -> 填进目的地坐标。
     *
     * @returns {object|null} 被选中的那条（没有就 null）
     */
    pick_search_result(i) {
      const r = this.search_results[i];
      if (!r) return null;
      // ⚠️ 见方法区开头第 4 条：不清掉预设，read_destination() 会继续用下拉里
      //    那个旧地点（预设优先于坐标框）。
      const sel = $('dest-preset');
      if (sel) sel.value = '';
      const la = $('dest-lat');
      const lo = $('dest-lon');
      const lat_s = Number(r.lat).toFixed(6);
      const lon_s = Number(r.lon).toFixed(6);
      if (la) la.value = lat_s;
      if (lo) lo.value = lon_s;

      this._search_picked = i;
      const box = $('search-results');
      if (box && box.children) {
        for (let k = 0; k < box.children.length; k += 1) {
          const ch = box.children[k];
          if (ch && ch.dataset) {
            if (k === i) ch.dataset.picked = '1';
            else delete ch.dataset.picked;
          }
        }
      }

      const what = `${r.name || '(未命名)'}（${lat_s}, ${lon_s}）` +
                   (r.detail ? ` · ${r.detail}` : '');
      this.set_search_info('done', `已选：${what}`);
      this.toast(`目的地：${r.name || lat_s + ', ' + lon_s}`, 5000);
      this.log(`[search] 已选目的地：${what}` +
        `${r.kind ? `　[${r.kind}]` : ''}${r.source ? `（来源 ${r.source}）` : ''}`);

      // 在地图上把它显示出来 —— "这条在哪个城市"最直观的答案就是看一眼地图。
      // ⚠️ 这会**关掉跟随**（否则下一帧就被定位拽回当前位置，等于没看）。
      //    地图角标会写"自由查看（点「回到当前位置」）"，随时能回来。
      if (this.mapview) {
        try {
          this.mapview.follow = false;
          this.mapview.set_center(r.lat, r.lon, true);
          this.mapview_frame(true);
        } catch (e) {
          this.log(`[search] 地图上定位这个点失败（忽略）：${e}`);
        }
      }
      return r;
    }


    // -- BLE 分片（闪退修复的调节口，见 phone/ble_native.js）------------------
    /**
     * 造策略对象 + 接好界面。**必须在造 transport 之前调用**：
     *
     * transport 每一帧都要问它"这一帧最多能写多少字节"。
     */
    init_chunk_policy() {
      try {
        const N = root.NavPuckBleNative;
        if (N && typeof N.create_chunk_policy === 'function') {
          this.chunk_policy = N.create_chunk_policy({
            window: root,
            onLog: (l) => this.log(l),
          });
        }
      } catch (e) {
        this.chunk_policy = null;
        this.log(`[ble] 分片策略初始化失败（不影响导航，退到规范默认分片）：${e}`);
      }
      if (!this.chunk_policy) {
        this.log('[ble] ble_native.js 未加载：分片策略不可用（PWA 走 Web Bluetooth 那条路）');
      }
      return this.chunk_policy;
    }

    /** 分片大小变化（自适应升档确认 / 试探开始）时被 transport 回调。 */
    on_chunk_size_changed(size) {
      try {
        // 把 ble.js 的 chunk_size 对齐到原生实际用的大小。
        // ⚠️ ble.js **一行代码都没改**：它的 chunk_size 本来就是运行时可变的
        //    （connect 时从 transport.chunk_size_hint 取，降档时回写），这里走
        //    的是同一条既有契约。不对齐的话，ble.js 会一直按旧的小分片切，
        //    策略试出来的更大分片永远用不上。
        const t = this.ble && this.ble.transport;
        if (t && this.ble.chunk_size !== size) {
          this.ble.chunk_size = size;
          this.ble._chunk_known = false;   // 让 ble.js 下一帧重新报一次"分片大小确定"
        }
      } catch (_e) { /* 界面/链路状态不能互相拖累 */ }
      this.update_chunk_ui();
    }

    /** 政策当前值的一句话（状态面板 + 详情行共用）。 */
    chunk_status() {
      const p = this.chunk_policy;
      if (!p) {
        return { short: '—', detail: 'PWA（Web Bluetooth）路径：拿不到 MTU，仍按 512→20 试探（见 docs/ble.md 第 2 节）' };
      }
      const t = (this.ble && this.ble.transport) || null;
      const mtu = t ? t.transport_mtu : null;
      const s = p.snapshot();
      const cur = t ? this.ble.chunk_size : p.size(mtu);
      const cap = p.max_safe(mtu);
      const bits = [];
      bits.push(`当前 ${cur} 字节`);
      bits.push(`已确认 ${s.learned}`);
      bits.push(`上限 ${Math.min(s.ceiling, cap)}（用户上限 ${s.ceiling}／硬上限 min(MTU-3, ${s.max_attr})=${cap}` +
                `${mtu ? `，MTU ${mtu}` : '，MTU 未知'}）`);
      bits.push(`自动升档 ${s.auto ? '开' : '关'}`);
      if (s.trial != null) bits.push(`正在试 ${s.trial}（已连续成功 ${s.ok}/${p.PROBE_OK_FRAMES}）`);
      if (s.bad.length) bits.push(`判过致死的档位 ${s.bad.join('/')}`);
      if (s.crash_verdict) {
        bits.push(`上次崩溃推断：${s.crash_verdict.size}B 致死 → 上限压到 ${s.crash_verdict.ceiling}B` +
                  (s.crash_verdict.certain ? '' : '（判据不全，按最保守处理）'));
      }
      return { short: `${cur} B`, detail: bits.join('；') };
    }

    /** 把策略现状画到界面（状态面板那一格 + 分片面板里那行详情）。 */
    update_chunk_ui() {
      const st = this.chunk_status();
      const cell = $('chunk-info');
      if (cell && cell.textContent !== st.short) cell.textContent = st.short;
      const det = $('chunk-detail');
      if (det && det.textContent !== st.detail) det.textContent = st.detail;
      this._chunk_last_text = st.detail;
    }

    /** 用户把"上限"调了（下拉框）。 */
    set_chunk_ceiling(n) {
      if (!this.chunk_policy) return;
      const v = this.chunk_policy.set_ceiling(parseInt(n, 10));
      this.apply_chunk_policy();
      this.toast(`分片上限已设为 ${v} 字节`);
    }

    /** 用户开关"自动升档"。 */
    set_chunk_auto(on) {
      if (!this.chunk_policy) return;
      const v = this.chunk_policy.set_auto(!!on);
      this.apply_chunk_policy();
      this.toast(v ? '已打开自动升档' : '已关闭自动升档（锁在当前上限内，不再往上试）');
    }

    /** 清空学到的分片大小（换设备/换固件后用户自己按）。 */
    reset_chunk_learning() {
      if (!this.chunk_policy) return;
      this.chunk_policy.reset();
      this.apply_chunk_policy();
      this.toast('分片学习记录已清空，下一帧从 20 字节起步');
    }

    /** 把策略的新上限**立刻**作用到当前链路（降下来是立刻的，升上去靠探测）。 */
    apply_chunk_policy() {
      try {
        const t = this.ble && this.ble.transport;
        if (t && this.chunk_policy) {
          const s = this.chunk_policy.size(t.transport_mtu);
          t.chunk_size_hint = s;
          if (this.ble.chunk_size > s) {
            this.ble.chunk_size = s;
            this.ble._chunk_known = false;
          }
        }
      } catch (_e) { /* 忽略 */ }
      this.update_chunk_ui();
    }

    /** 界面初始化：把落盘的值画进控件，并绑事件。 */
    init_chunk_ui() {
      const auto = $('opt-chunk-auto');
      const ceil = $('opt-chunk-ceiling');
      const btn = $('chunk-reset');
      if (this.chunk_policy) {
        const s = this.chunk_policy.snapshot();
        if (auto) auto.checked = !!s.auto;
        if (ceil) ceil.value = String(s.ceiling);
      } else if (auto && ceil) {
        auto.checked = false;
        auto.disabled = true;
        ceil.disabled = true;
        if (btn) btn.disabled = true;
      }
      const on = (id, ev, fn) => {
        const el = $(id);
        if (el) el.addEventListener(ev, fn);
      };
      on('opt-chunk-auto', 'change', () => {
        const el = $('opt-chunk-auto');
        this.set_chunk_auto(!!(el && el.checked));
      });
      on('opt-chunk-ceiling', 'change', () => {
        const el = $('opt-chunk-ceiling');
        this.set_chunk_ceiling(el && el.value);
      });
      on('chunk-reset', 'click', () => this.reset_chunk_learning());
      this.update_chunk_ui();
    }

    /**
     * 开关街道路网底图（"显示街道路网底图"复选框）。
     *
     * ⚠️ 关掉必须是**真的关掉**：把底图源从正在跑的 Navigator 上摘下来
     * （`nav.map_src = null`），而不是只把复选框画成没勾 —— 那会变成"界面说关了、
     * 实际还在每 40 秒打一次 Overpass"，既费流量又费电，而且用户在 Overpass
     * 被限流的时候根本关不掉它。
     *
     * 还要往设备发一帧**空 NAV_MAP**：设备对 `seg_count == 0` 的处理就是把所有
     * 路网线藏起来（见 src/ui/ui_puck.cpp 的 renderMap()），所以这是"清屏"而不是
     * "留着上一张图"。不发的话用户会以为没关掉 —— 屏幕上那一片街道还在。
     *
     * @param {boolean} on
     * @param {boolean} quiet 静默（init 里恢复上次的选择时用）
     */
    set_map_enabled(on, quiet) {
      const want = !!on;
      this.map_enabled = want;
      const cb = $('opt-map');
      if (cb) cb.checked = want;
      try {
        // 隐私模式下 localStorage 会抛，忽略即可 —— 选项记不住不该影响导航
        localStorage.setItem(PREF_MAP_KEY, want ? '1' : '0');
      } catch (_e) { /* 忽略 */ }

      const src = this.map_source_instance();
      if (src) src.set_enabled(want);

      if (this.nav) {
        const had_map = this.nav.last_map_segs > 0;
        this.nav.map_src = want ? (src || null) : null;
        this.nav.last_map_segs = 0;
        this.nav.last_map_pts = 0;
        this.nav.map_view_m = 0.0;
        if (want) {
          this.nav.map_timer = rt.MAP_SEND_PERIOD_S;   // 立刻拉一次，不用等半秒
        } else if (had_map) {
          // 清掉设备上已经画出来的那片路网
          this.send_frame(proto.encode_nav_map(new proto.NavMap()), 'map', 3);
        }
      }

      if (!quiet) {
        this.log(`[map] 街道路网底图已${want ? '打开' : '关闭'}`);
        this.toast(want ? '已打开街道路网底图' : '已关闭街道路网底图（不影响导航）');
      }
      // 地图那一块跟着变：关掉时把已经读进内存的本地路网也扔掉（否则地图上
      // 还留着上一次画的路，看起来像"开关没生效"），然后立刻重画 + 重写状态。
      // ⚠️ 状态必须**无条件**重写一次：mapview.js 内部对"状态文本没变"有去重
      //    （见 _emit_status），不清掉那层去重的话，"关掉再打开"之后面板会一直
      //    停在上一次的"已关闭"——而地图明明已经在画了。
      if (this.mapview) {
        if (!want) this.mapview.drop_local();
        this.mapview_frame(true);
        this.mapview_status(this.mapview.status());
      }
      return want;
    }

    // -- 位置来源：GPS / 手动 / 模拟行驶 --------------------------------------
    /**
     * 模拟行驶此刻是不是**真的在链路里**。
     *
     * 它比"勾了复选框"多一个条件：必须已经有航线。勾选之后、规划之前它拿不到
     * 几何，active_source() 会退回手动/GPS —— 界面（横幅、状态面板）必须和这个
     * 事实一致，不能勾上就宣称"正在模拟行驶"。判断只此一份，别处一律调它。
     */
    sim_drive_effective() {
      return !!(this.simdrive && this.routesim && this.routesim.has_route());
    }

    /**
     * 当前生效的位置源。
     *
     * 优先级：模拟行驶 > 手动位置 > GPS（浏览器不支持定位时可能是 null）。
     * 模拟行驶排最前面，是因为它自己带着航线、是"整条链路在动"的那个模式；
     * 它没拿到航线之前（还没规划）自动退回下一个源，所以勾选本身不会让
     * 导航没数据。
     *
     * Navigator 只依赖 source 的接口，所以"换源"就是换这个返回值 ——
     * 整条流水线（路线匹配、相对方位、10Hz 更新、地图旋转）一行都不用改。
     */
    active_source() {
      if (this.sim_drive_effective()) return this.routesim;
      if (this.manual && this.sim) return this.sim;
      return this.geo;
    }

    /**
     * 读"模拟行驶"的两个输入框。
     *
     * 速度默认 42 km/h —— 和 PC 版 `--speed` 的默认值一致；起点偏移默认 0
     * （= 航线起点），对应 PC 版 `--start`（0~1 的百分比）。
     *
     * @returns {{speed_kmh:number, start_frac:number}}
     */
    read_sim_drive() {
      const num = (id, dflt) => {
        const el = $(id);
        const v = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(v) ? v : dflt;
      };
      let speed = num('sim-speed', 42.0);
      if (!(speed >= MIN_SIM_SPEED_KMH)) speed = MIN_SIM_SPEED_KMH;   // 0 会永远不动
      let frac = num('sim-start', 0.0);
      frac = Math.max(0.0, Math.min(1.0, frac));
      return { speed_kmh: speed, start_frac: frac };
    }

    /**
     * 把"模拟行驶"的参数应用下去（勾选/按"重新开始"时走这条路）。
     *
     * 顺序很重要：先设速度、再换航线（set_route 会按 start_frac 从头开始），
     * 最后才切 active_source()。已经在导航的话直接把新航线接上即可，不必重启
     * 10Hz 循环 —— Navigator 只认接口。
     *
     * @param {boolean} quiet 静默（输入框改一下就重算时用，不弹 toast）
     */
    apply_sim_drive(quiet) {
      if (!this.routesim) return false;
      const v = this.read_sim_drive();
      this.routesim.set_speed_kmh(v.speed_kmh);

      // 已经在导航（且没有新航线）时，把正在跑的那条航线接过来：
      // "先开始导航、再勾模拟行驶"也能立刻动起来。
      if (!this.routesim.has_route() && this.nav && this.nav.route) {
        this.routesim.start_frac = v.start_frac;
        this.routesim.set_route(this.nav.route);
        this.log('[sim] 模拟行驶接上当前导航的航线（不必重新规划）');
      } else if (this.routesim.has_route()) {
        this.routesim.restart(v.start_frac);
      } else {
        // 还没规划过路线：参数先记住，等 do_route() 拿到航线再沿路走
        this.routesim.start_frac = v.start_frac;
      }

      this._sim_arrived = false;
      this.set_sim_drive_active(true);

      // 起点：室内没有 GPS，也不该逼用户先手输一串坐标才肯开始 ——
      // 没起点时用内置演示航线的起点（界面上写明"模拟起点"）。
      if (this.start_lat === null || this.start_lon === null) {
        this.use_demo_start('模拟行驶');
      }

      this.log(`[sim] 模拟行驶已启用：${v.speed_kmh.toFixed(1)} km/h，` +
               `起点偏移 ${(v.start_frac * 100).toFixed(0)}%` +
               (this.routesim.has_route()
                 ? `（航线 ${(this.routesim.total_m() / 1000).toFixed(2)} km）`
                 : '（还没有航线，规划后自动沿路推进）'));
      if (!quiet) this.toast(`模拟行驶：${v.speed_kmh.toFixed(0)} km/h（模拟，不是真实定位）`, 5000);
      return true;
    }

    /** 只改速度，**不动**已经走到的位置（跑到一半调速度不该把车拨回起点）。 */
    apply_sim_speed(quiet) {
      if (!this.routesim) return false;
      const v = this.read_sim_drive();
      this.routesim.set_speed_kmh(v.speed_kmh);
      this.log(`[sim] 模拟行驶速度改为 ${v.speed_kmh.toFixed(1)} km/h`);
      if (!quiet) this.toast(`模拟行驶速度：${v.speed_kmh.toFixed(0)} km/h`, 3000);
      return true;
    }

    /** 从起点偏移处重新开始（"从起点重新开始模拟"按钮 / 改起点偏移）。 */
    restart_sim_route(quiet) {
      if (!this.routesim) return false;
      const v = this.read_sim_drive();
      this.routesim.set_speed_kmh(v.speed_kmh);
      this._sim_arrived = false;
      if (this.routesim.has_route()) {
        this.routesim.restart(v.start_frac);
        this.log(`[sim] 模拟行驶从 ${(this.routesim.s / 1000).toFixed(2)} km 处重新开始` +
                 `（航线全长 ${(this.routesim.total_m() / 1000).toFixed(2)} km）`);
        if (!quiet) this.toast(`模拟行驶：从航线 ${(v.start_frac * 100).toFixed(0)}% 处开始`, 4000);
      } else {
        this.routesim.start_frac = v.start_frac;
        if (!quiet) this.toast('还没有航线：先"规划并开始导航"', 4000);
      }
      this.update_sim_readout();
      return true;
    }

    /**
     * 用**内置演示航线的起点**当起点。
     *
     * 模拟行驶是给"室内、没有 GPS"准备的；如果还要求用户手输一串坐标才能开始，
     * 这个模式就白加了。演示航线（西湖北山街）是代码里本来就有的常量，拿它当
     * 默认起点不会误导任何人 —— 界面上会写清"模拟起点"，横幅也一直挂着。
     */
    use_demo_start(why) {
      const p = rt.DEMO_ROUTE[0];
      this.start_lat = p[0];
      this.start_lon = p[1];
      const el = $('start-info');
      if (el) el.textContent = `${p[0].toFixed(6)}, ${p[1].toFixed(6)}（模拟起点）`;
      this.log(`[sim] 起点取内置演示航线起点 ${p[0].toFixed(6)}, ${p[1].toFixed(6)}` +
               `（${why || '模拟行驶'}，不是真实定位）`);
      return true;
    }

    /** 开关模拟行驶：同步复选框、横幅、位置源和状态面板。 */
    set_sim_drive_active(on) {
      this.simdrive = !!on;
      if (this.routesim) this.routesim.active = this.simdrive;

      const badge = $('sim-badge');
      if (badge) {
        badge.hidden = !this.simdrive;
        badge.dataset.state = (this.routesim && this.routesim.arrived) ? 'arrived' : 'running';
      }
      const cb = $('opt-simdrive');
      if (cb) cb.checked = this.simdrive;

      // 正在导航时换源：Navigator 只认接口，直接替换即可（不必重建循环）
      const src = this.active_source();
      if (this.nav) this.nav.source = src;

      // 横幅/状态面板跟着**真正生效**的那个源走：两个模拟模式同时开着时，
      // 模拟行驶优先；它还没拿到航线时手动位置才是在链路里的那个。
      const eff = this.sim_drive_effective();
      const mb = $('manual-badge');
      if (mb) mb.hidden = !(this.manual && !eff);

      if (this.simdrive) {
        this.set_gps_state('simdrive', '', this.routesim);
      } else if (this.manual) {
        // 关掉模拟行驶但手动位置还开着：状态面板要回到"手动定位"，
        // 不能停在一个已经不生效的状态上
        this.set_gps_state('manual', '', this.sim);
      } else if (this.geo) {
        // 切回 GPS：把当前真实状态立刻重画一遍（多半还是"等待定位"）
        this.set_gps_state(this.geo.has_fix() ? 'ok' : 'waiting', '', this.geo);
      }
      this.update_sim_readout();
    }

    /** 读手动位置的四个输入框 @returns {[number,number,number,number]|null} */
    read_manual() {
      const num = (id) => {
        const el = $(id);
        const v = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(v) ? v : NaN;
      };
      const lat = num('man-lat');
      const lon = num('man-lon');
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      let hdg = num('man-heading');
      if (!Number.isFinite(hdg)) hdg = 0.0;          // 默认正北
      let spd = num('man-speed');
      if (!Number.isFinite(spd) || spd < 0) spd = 0.0;
      return [lat, lon, nm.wrap360(hdg), spd];
    }

    /**
     * 应用手动位置。
     *
     * 勾"使用手动位置"和按"应用"走的是同一条路：坐标合法就切到 SimSource，
     * 不合法就把勾去掉并提示 —— 绝不允许出现"界面写着手动、实际还在用 GPS"
     * 这种状态，那种运行最容易被后面的人误当成真实定位。
     *
     * @param {boolean} quiet 静默模式（输入框改一下就重算时用，不弹 toast）
     */
    apply_manual(quiet) {
      const v = this.read_manual();
      const cb = $('opt-manual');
      if (v === null) {
        this.log('[sim] 手动位置坐标不合法，忽略');
        if (!quiet) {
          this.toast('手动位置：请填合法的纬度/经度（十进制度）', 5000);
          if (cb) cb.checked = false;
          this.set_manual_active(false);
        }
        return false;
      }
      if (!this.sim) return false;
      this.sim.set(v[0], v[1], v[2], v[3]);
      // 手动位置同时也是"起点"，可以直接规划路线 —— 不需要先拿到 GPS
      this.start_lat = v[0];
      this.start_lon = v[1];
      this.set_manual_active(true);
      const el = $('start-info');
      if (el) el.textContent = `${v[0].toFixed(6)}, ${v[1].toFixed(6)}（手动位置）`;
      this.log(`[sim] 手动位置已生效：${v[0].toFixed(6)}, ${v[1].toFixed(6)} ` +
               `航向 ${v[2].toFixed(0)}° 速度 ${v[3].toFixed(1)} m/s`);
      if (!quiet) this.toast('已使用手动位置（模拟，不是真实 GPS）', 5000);
      return true;
    }

    /** 开关手动位置：同步复选框、横幅、位置源和状态面板。 */
    set_manual_active(on) {
      this.manual = !!on;
      if (this.sim) this.sim.active = this.manual;

      const badge = $('manual-badge');
      // 模拟行驶真的在链路里时，"手动位置"横幅不该亮 —— 那是假的
      if (badge) badge.hidden = !(this.manual && !this.sim_drive_effective());
      const cb = $('opt-manual');
      if (cb) cb.checked = this.manual;

      // 正在导航时换源：Navigator 只认接口，直接替换即可（不必重建循环）
      const src = this.active_source();
      if (this.nav) this.nav.source = src;

      if (this.sim_drive_effective()) {
        // 模拟行驶优先（见 active_source()）：状态面板要跟着生效的那个走
        this.set_gps_state('simdrive', '', this.routesim);
      } else if (this.manual) {
        this.set_gps_state('manual', '', this.sim);
      } else if (this.geo) {
        // 切回 GPS：把当前真实状态立刻重画一遍（多半还是"等待定位"）
        this.set_gps_state(this.geo.has_fix() ? 'ok' : 'waiting', '', this.geo);
      }
    }

    // -- 连接 --------------------------------------------------------------

    /**
     * 把一次扫描的结果写进顶部那两行诊断（只有 APK 的原生路径会显示）。
     *
     * kind：
     *   'scanning'  正在扫（最长 6 秒）—— 顺带解释"为什么点了没反应"；
     *   'ok'        扫到并选中了：把**收到的广播条数**写出来。这是"扫描确实在
     *               收包"的证据，也正是"设备在广播"和"设备没在广播"的分界；
     *   SCAN_FAIL 的键 / 'other'  三类失败 + 兜底。
     *
     * ⚠️ 传输对象为 null（PWA / Web Bluetooth）时整块直接隐藏：网页那条路的
     *    失败原因由 Chrome 自己解释（选择框里就写着"找不到设备"），多一块红字
     *    只会让 Web 路径的行为变样 —— 而它现在是好的，不该被这次改动碰到。
     */
    render_scan_state(kind, err, t) {
      const el = $('scan-state');
      const hint = $('scan-hint');
      const rb = $('rescan-btn');
      if (!el) return;

      if (!t) {                       // Web 路径：一个字都不显示
        el.hidden = true;
        if (hint) hint.hidden = true;
        if (rb) rb.hidden = true;
        return;
      }

      if (kind === 'scanning') {
        const secs = (t.scan_window_ms / 1000).toFixed(1);
        el.dataset.state = 'busy';
        el.hidden = false;
        el.textContent = `正在扫描（最长 ${secs} 秒）…权限状态和收到的广播条数都在日志里`;
        if (hint) hint.hidden = true;
        if (rb) { rb.hidden = false; rb.disabled = true; }
        return;
      }

      if (kind === 'ok') {
        const adv = (t.adverts_seen === null || t.adverts_seen === undefined) ? '?' : t.adverts_seen;
        const dev = (t.devices_seen === null || t.devices_seen === undefined) ? '?' : t.devices_seen;
        el.dataset.state = 'ok';
        el.hidden = false;
        el.textContent = `扫描完成：收到 ${adv} 条广播、看到 ${dev} 台设备，选中 ` +
          `${t.device_name || '设备'}` +
          (t.scan_mode === 'lescan' ? '。' : '（这个插件版本没有 requestLEScan，广播条数拿不到）。');
        if (hint) hint.hidden = true;
        if (rb) { rb.hidden = true; rb.disabled = false; }
        return;
      }

      const f = SCAN_FAIL[kind] || null;
      const why = (err && err.message) ? err.message : String(err || '连接失败');
      el.dataset.state = f ? f.state : 'bad';
      el.hidden = false;
      el.textContent = (f ? f.lead : '连接失败：') + ' ' + why;
      if (hint) {
        hint.dataset.state = f ? f.state : 'bad';
        hint.hidden = false;
        hint.textContent = f ? f.hint : '看下面的日志（勾选「显示日志」）。点「重试扫描」可以再来一次。';
      }
      if (rb) { rb.hidden = false; rb.disabled = false; }
    }

    async do_connect() {
      if (!this.ble) return;
      // 原生传输对象存在 = 走 APK 那条路（Web Bluetooth 那条路它是 null）。
      const t = this.ble.transport || null;
      if (t) this.render_scan_state('scanning', null, t);
      // 崩在扫描/连接里也要留下"正在连"这一笔（扫描是 6 秒窗口，最容易出事的段）
      this.crash_marker('ble_connect_begin', t ? '原生路径' : 'Web Bluetooth 路径');
      try {
        await this.ble.connect();
        if (t) this.render_scan_state('ok', null, t);
      } catch (e) {
        // connect() 内部已经报过状态了；用户取消不算错误
        if (!/cancel|NotFoundError/i.test(String(e))) this.log(`连接失败：${e}`);
        // ⚠️ 这里**不能**退化成"没找到设备"：ble_native.js 抛的是带错误码的
        //    分类错误（权限 / 蓝牙开关 / 扫完了但没有 / 插件报错），按码显示。
        if (t) this.render_scan_state(scan_fail_kind(e) || 'other', e, t);
      }
    }

    // -- 路线 --------------------------------------------------------------
    /** 读界面上的目的地（预设优先，否则用两个坐标框）。 */
    read_destination() {
      const sel = $('dest-preset');
      if (sel && sel.value) {
        const [a, b] = sel.value.split(',');
        return [parseFloat(a), parseFloat(b)];
      }
      const la = $('dest-lat');
      const lo = $('dest-lon');
      const lat = la ? parseFloat(la.value) : NaN;
      const lon = lo ? parseFloat(lo.value) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      return [lat, lon];
    }

    async do_route() {
      const dest = this.read_destination();
      if (dest === null) {
        this.toast('请先选择预设或填写合法坐标');
        return;
      }
      if (this.start_lat === null || this.start_lon === null) {
        this.toast('还没有起点：请先获取定位');
        return;
      }

      const profile = ($('opt-osrm-profile') || {}).value || 'driving';
      // 底图开关以 App 的状态为准（复选框和它是同步的，init 时也从存储里恢复了）。
      // 关掉时**一个 Overpass 请求都不发**：连底图源都不挂到 Navigator 上。
      const use_map = !!this.map_enabled;
      const map_src = use_map ? this.map_source_instance() : null;
      const rate_hz = parseFloat(($('opt-rate') || {}).value) || 10.0;
      // 全程用**当前生效的**位置源：手动位置时就是 SimSource，和 GPS 走同一段代码。
      // ⚠️ 模拟行驶这一刻还拿不到（它必须先有航线），所以下面规划完会再取一次。
      let src = this.active_source();

      this.toast('正在规划路线…', 10000);
      // 崩溃黑匣子：从这一行开始到"路线 + 底图 + 10Hz 循环全部铺好"之间，是
      // 这一版真机上闪退的那一段。崩了也至少要留下"当时正在给谁规划、开了多大"。
      this.crash_marker('route_begin', `dest=${dest[0].toFixed(5)},${dest[1].toFixed(5)} ` +
        `profile=${profile} map=${use_map ? 'on' : 'off'} rate=${rate_hz}Hz ` +
        `simdrive=${this.simdrive ? 1 : 0} manual=${this.manual ? 1 : 0}`);
      this.log(`[osrm] 起点 ${this.start_lat.toFixed(6)},${this.start_lon.toFixed(6)} ` +
               `-> 终点 ${dest[0].toFixed(6)},${dest[1].toFixed(6)}（${profile}）` +
               `${this.simdrive ? ' [模拟行驶]' : (this.manual ? ' [手动位置]' : '')}`);

      let route;
      let raw = null;
      try {
        const res = await rt.load_osrm(
          [[this.start_lat, this.start_lon, '起点'], [dest[0], dest[1], '终点']], profile);
        route = res.route;
        raw = res.raw;
        this.log(`[osrm] ${(raw.distance_m / 1000).toFixed(2)} km, ` +
                 `${(raw.duration_s / 60).toFixed(1)} min, ${raw.point_count} 个折线点`);
      } catch (e) {
        // OSRM 不可用时退回直线航点，至少让链路和箭头有东西可跑
        this.log(`[osrm] 不可用（${e}）`);
        if (this.simdrive) {
          // ⚠️ 模拟行驶**不能**退回直线：一条直线没有转弯，而这个模式最该验证
          //    的恰恰是"航向随转弯变化"（设备没有磁力计，地图车头朝上全靠手机
          //    给的航向）。室内往往也没网，正好会走到这条分支上。所以改用**内置
          //    演示航线**（西湖北山街环线，10km / 7 个转向点）—— 它是一条真正的
          //    Route，窗口/底图/10Hz/转向提示全都照常，和规划出来的航线没有区别。
          route = new rt.Route(rt.DEMO_ROUTE.map((p) => [p[0], p[1], p[2]]), true);
          this.toast('路线服务不可用：模拟行驶改用内置演示航线（有转弯）', 6000);
          this.log('[sim] 模拟行驶改用内置演示航线（环线，含 7 个转向点）');
        } else {
          this.toast('路线服务不可用，已退回直线连接', 5000);
          route = rt.straight_route([[this.start_lat, this.start_lon, '起点'],
                                     [dest[0], dest[1], '终点']]);
        }
      }

      this.log(`[route] ${(route.total_m / 1000).toFixed(2)} km, ` +
               `${route.points.length} 个点, ${route.maneuvers.length} 个转向点`);
      for (const [idx, delta, turn] of route.maneuvers.slice(0, 8)) {
        const p = route.points[idx];
        this.log(`    +${(p.cum_m / 1000).toFixed(2)} km  ${delta >= 0 ? '+' : ''}` +
                 `${delta.toFixed(1)}°  ${proto.turn_name(turn)}` +
                 (p.name ? `  ${p.name}` : ''));
      }
      if (route.maneuvers.length > 8) {
        this.log(`    ... 还有 ${route.maneuvers.length - 8} 个`);
      }

      const ri = $('route-info');
      if (ri) {
        ri.textContent =
          `${(route.total_m / 1000).toFixed(2)} km · ` +
          `${raw ? (raw.duration_s / 60).toFixed(0) + ' min · ' : ''}` +
          `${route.points.length} 点 · ${route.maneuvers.length} 个转向点`;
      }

      // ⭐ 地图上也要出现这条航线 —— 用户"规划并开始导航"之后第一件想确认的
      //    事就是"它给我规划的这条线长什么样"。Route 的点是 RoutePoint
      //    （带 cum_m/name），地图只要几何，所以在这里转成 [[lat,lon],...]。
      //    ⚠️ 包一层 try：地图出任何问题都不该让"开始导航"失败。
      this.route = route;
      try {
        this.set_mapview_route(route.points.map((p) => [p.lat, p.lon]), true);
      } catch (e) {
        this.log(`[mapview] 航线交给地图时出错（忽略，导航照常）：${e}`);
      }

      // 模拟行驶：把刚规划出来的航线交给模拟源 —— 它**必须**先有航线才能沿路
      // 推进，所以 active_source() 要在这之后再取一次（在这之前它只能返回
      // GPS/手动源）。起点偏移也在这里重新应用一次：用户可能先规划、后勾选。
      if (this.simdrive && this.routesim) {
        const v = this.read_sim_drive();
        this.routesim.set_speed_kmh(v.speed_kmh);
        this.routesim.start_frac = v.start_frac;
        this.routesim.set_route(route);
        this.routesim.active = true;
        this._sim_arrived = false;
        src = this.active_source();
        this.log(`[sim] 模拟行驶已挂上本次航线：${(route.total_m / 1000).toFixed(2)} km，` +
                 `${v.speed_kmh.toFixed(1)} km/h，从 ${(v.start_frac * 100).toFixed(0)}% 处开始` +
                 `（航向取航线切线）`);
      }

      // 停掉旧循环，用新路线重建
      this.stop_nav();
      if (!use_map) {
        this.log('[map] 底图已关闭：本次导航不会向 Overpass 发任何请求');
      } else if (!map_src) {
        this.log('[map] 底图源不可用（map.js 没加载成功）：本次导航没有街道路网，' +
                 '但路线和箭头照常');
      } else {
        map_src.set_enabled(true);
        // ⭐ 把航线交给底图 —— 它要沿这条路**预先下载瓦片**（见 phone/tiles.js
        //    的 prefetch_route）。这是"骑到哪底图都已经在手上"的唯一来源：
        //    等骑到了再下，弱网下就是几百米的空白。
        //
        // ⚠️ 传的是**折线点**（[[lat,lon],...]），不是 Route 对象：
        //    底图只关心"要经过哪些瓦片"，不需要里程/转向那一套。
        //    包一层 try：底图出任何问题都不该让"开始导航"失败。
        if (typeof map_src.set_route === 'function') {
          try {
            map_src.set_route(route.points.map((p) => [p.lat, p.lon]));
            const ts = map_src.tiles;
            this.log(`[map] 已把航线交给底图：${route.points.length} 点，` +
              (ts ? `沿路预取 ${(ts.prefetch_ahead_m / 1000).toFixed(0)}km 内的瓦片` +
                    `（地址 ${ts.base || '未定'}）`
                  : '这一端没有离线瓦片（只走 Overpass）'));
          } catch (e) {
            this.log(`[map] 航线交给底图时出错（忽略，底图退回 Overpass）：${e}`);
          }
        }
      }
      try {
        this.nav = new Navigator(route, src, {
          send: (frame, kind, prio) => this.send_frame(frame, kind, prio),
          onLog: (l) => this.log(l),
          onUi: (d) => this.on_ui(d),
          mapSource: map_src || undefined,
          config: { rate_hz, no_map: !use_map, osrm_profile: profile },
        });
      } catch (e) {
        this.toast(String(e.message || e), 8000);
        this.log(`[route] 无法开始导航：${e}`);
        return;
      }
      this.nav.set_ble(this.ble);

      // 开始前把整条路线的元信息发一遍（对齐 navigator.py 的 main()）
      const speed_mps = Math.max(src && src.speed_mps ? src.speed_mps : 0.0, 0.5);
      this.send_frame(proto.encode_nav_meta(new proto.NavMeta({
        total_dist_m: nm.pyround(route.total_m),
        total_time_s: nm.pyround(route.total_m / speed_mps),
        flags: 1,
      })), 'meta', 2);

      // ⚠️ 这一行是这一版真机闪退的分界线：nv.start() 之后，10Hz 循环会**第一次**
      //    真的把整条路线写出去（以前 rx 门把它们全吞了）。所以把"即将发生的写"
      //    的完整参数同步落盘 —— 崩在下面的 start()/第一片写里，这一行就是现场。
      this.crash_marker('nav_start_begin',
        `route_pts=${route.points.length} route_km=${(route.total_m / 1000).toFixed(2)} ` +
        `window_pts=${(this.nav.window_pts ? this.nav.window_pts.length : '?')} ` +
        `mtu=${(this.ble && this.ble.transport && this.ble.transport.transport_mtu) || '?'} ` +
        `chunk=${this.ble ? this.ble.chunk_size : '?'} ` +
        `connected=${this.ble && this.ble.connected ? 1 : 0} ` +
        `queue=${this.ble && this.ble.stats ? this.ble.stats.queue_length : '?'}`);
      this.nav.start();
      this.nav.set_hidden(this.page_hidden());
      this.crash_marker('nav_started', `rate=${rate_hz}Hz`);

      // ---- 原生节拍器的入口（APK）------------------------------------------
      //
      // 这是"原生主动调 JS"这条路上唯一被调的函数。它必须：
      //   1. 走的是**同一个**循环体（nav.native_tick -> _tick -> cycle），
      //      不是另写一份影子逻辑 —— 否则读数只能证明"JS 引擎没死"，
      //      证明不了"导航能继续跑"，而那正是这次实验要回答的问题；
      //   2. 幂等、任意频率都安全：_tick 内部按真实墙钟差值算 dt，
      //      被调 10 次/秒还是 100 次/秒，输出都只取决于墙钟；
      //   3. 导航停了/重开时行为可预期（见 _clear_native_tick 与 stop_nav）。
      //
      // 在 PWA 里这个函数**也会被装上，但永远没人调它**：只有 APK 的诊断面板
      // 会请求原生起节拍器（见 fgs_ui.js）。浏览器那条路因此一个字都没变。
      this._install_native_tick();

      // 屏幕常亮：**导航开始**时申请（这是"保持 10Hz"唯一真正有用的手段，
      // 见 ScreenWakeLock 那段说明）。request() 自己吞掉所有错误并只写日志，
      // 所以这里不需要 await、更不需要 catch —— 拿不到也绝不能挡住导航。
      this.wake().request();
      this.render_awake_loop(this._ui_last);
      this.toast('导航已启动');
      this.log('[nav] 10Hz 循环已启动');
    }

    /**
     * 把原生节拍器的入口装到 window 上（见 do_route 里的调用）。
     *
     * 入口名是**跨语言契约**：NavPuckFgsPlugin 的 METRONOME_TICK_JS 里按字面量
     * 找 window.__navpuckNativeTick。改名字必须两边一起改（docs/android.md §5 有表）。
     *
     * 同时挂一份 __navpuckNativeState：原生每帧读回 executions/frames 时要用的
     * 只读快照。用"对象 + 每次执行时刷新"而不是 getter，是因为 getter 在
     * 原生读回时也可能被执行，而我们要的是**上一次执行的真实结果**。
     */
    _install_native_tick() {
      const nav = this.nav;
      if (!nav) return false;
      const self = this;
      // ⚠️ 顺序要紧：先建状态对象，再定义会去写它的入口函数。
      //    反过来写虽然也能跑（闭包到调用时才解析），但"先建好再暴露"
      //    少一个"第一次调用时 undefined"的隐患。
      this._native_state = { executions: 0, frames: 0, lastError: '' };
      this._native_tick = function () {
        const n = self.nav;
        // 导航已经停了（stop_nav 把 nav 置空）时不做任何事：原生可能还没收到
        // "停"的消息，但这里绝不能对着一个空对象调方法而抛错 ——
        // 抛错会让原生侧看到 error，污染"JS 到底跑没跑"的判读。
        if (!n) return 0;
        try {
          const frames = n.native_tick();
          self._native_state.executions = n.exec_count;
          self._native_state.frames = frames;
          self._native_state.lastError = n.last_metronome_error || '';
          return frames;
        } catch (e) {
          self._native_state.lastError = String(e);
          return 0;
        }
      };
      root.__navpuckNativeTick = this._native_tick;
      root.__navpuckNativeState = this._native_state;
      return true;
    }

    /** 导航停止时把入口摘掉：留着它就是"往一个已经不在的循环里投帧"。 */
    _clear_native_tick() {
      // 只摘自己装的那一个（用引用比对）。别的代码以后也往同名属性上挂东西时，
      // 这里不会把人家的实现删掉。
      if (this._native_tick && root.__navpuckNativeTick === this._native_tick) {
        try { delete root.__navpuckNativeTick; } catch (_e) { root.__navpuckNativeTick = undefined; }
      }
      this._native_tick = null;
      const st = this._native_state;
      if (st && root.__navpuckNativeState === st) {
        try { delete root.__navpuckNativeState; } catch (_e) { root.__navpuckNativeState = undefined; }
      }
      this._native_state = null;
    }

    send_frame(frame, kind, prio) {
      if (!this.ble || !this.ble.connected) return false;
      // 每一种帧**第一次**真的要走线上时记一笔（含字节数/分片/MTU）。
      // 只记第一次：APK 里每秒都在发帧，每次都记会把现场信息挤掉（崩溃报告只有
      // 最后 40 行）。这一行回答的正是"第一次大写入到底多大"。
      if (!this._sent_kinds) this._sent_kinds = {};
      if (!this._sent_kinds[kind]) {
        this._sent_kinds[kind] = true;
        this.crash_marker('first_send',
          `${kind} ${frame.length}B chunk=${this.ble.chunk_size} ` +
          `mtu=${(this.ble.transport && this.ble.transport.transport_mtu) || '?'}`);
      }
      return this.ble.send(frame, kind, prio);
    }

    stop_nav() {
      // 航线没了 = 沿路预取也该停：留着它会让底图继续为一条不存在的路线
      // 下载瓦片（用户可能是换了目的地，也可能是取消了）。
      // ⚠️ 只是**停止排新的**，已经下到本地的瓦片一块都不删 ——
      //    它们本来就该留着，下次骑回来直接就是离线的。
      try {
        const ms = this.map_source || (this.nav && this.nav.map_src);
        if (ms && typeof ms.set_route === 'function') ms.set_route(null);
      } catch (_e) { /* 底图的事不能挡住"停止导航" */ }
      if (this.nav) {
        this.crash_marker('nav_stop', '用户或重新规划触发的停止');
        this.nav.stop();
        this.nav = null;
        this.log('[nav] 循环已停止');
      }
      // 原生节拍器的入口跟着导航一起摘掉（见 _clear_native_tick）：
      // 留着它，原生那 10Hz 的投递就变成"往一个不存在的循环里发帧"——
      // 每次都返回 0 帧，看起来像"JS 不执行"，会把判读带偏。
      this._clear_native_tick();
      // 停止导航 = 不再需要屏幕常亮：立刻放开（空闲时占着它是在偷用户的电）。
      // 这里同样**不 await**：release() 内部也不允许抛错。
      this.wake().release();
      this.render_awake_loop(this._ui_last);
    }

    // -- 启动 --------------------------------------------------------------
    init() {
      // 不支持的浏览器：给出明确提示而不是让按钮静默失效。
      //
      // ⚠️ 判据不能只看 navigator.bluetooth：APK 里（Android WebView）这个 API
      //    **存在但不可用**（没有设备选择器、没有权限代理，requestDevice() 必失败）。
      //    所以在原生环境里要问"原生插件在不在"。两条都不在才报不支持。
      const native_ble = !!(root.NavPuckBle && root.NavPuckBle.BleLink
                            && root.NavPuckBle.BleLink.native_available(root));
      if (!native_ble && !('bluetooth' in navigator)) {
        const u = $('unsupported');
        if (u) u.hidden = false;
        this.log('⚠️ 这个浏览器没有 navigator.bluetooth：需要用 Android Chrome，' +
                 '并且页面必须在 localhost 或 HTTPS 下打开。');
      }
      if (native_ble) {
        this.log('[ble] 检测到原生 BLE 插件：本次使用原生链路（WebView 里的 Web Bluetooth 不可用）');
      }

      // ⚠️ 原生传输对象必须在这里就造好：BLE 走原生时 navigator.bluetooth
      //    一个字节都不会碰（见 ble.js 文件头"两条传输路径"）。
      //    不在原生环境时 make_transport() 返回 null，BleLink 走原来的
      //    Web Bluetooth 路径 —— 这就是 PWA 那条路还活着的原因。
      //
      // ⭐ 分片策略必须先建：transport 每一帧都要问它"最多能写多少字节"
      //    （真机闪退的根因就是这一处原来取 MTU-3 = 514 > 框架硬上限 512）。
      this.init_chunk_policy();
      const ble_transport = (root.NavPuckBle && root.NavPuckBle.BleLink)
        ? root.NavPuckBle.BleLink.make_transport({
            window: root,
            onLog: (l) => this.log(l),
            chunk_policy: this.chunk_policy || undefined,
            onChunkSize: (size) => this.on_chunk_size_changed(size),
          })
        : null;

      this.ble = new root.NavPuckBle.BleLink({
        transport: ble_transport,
        onState: (s, info) => this.set_link_state(s, info),
        onStatus: (st) => this.set_status(st),
        onLog: (l) => this.log(l),
        onFrame: (fr) => {
          if (fr.type === proto.MsgType.PUCK_EVENT) {
            const names = ['单击', '长按', '左滑', '右滑', '上滑', '下滑', '屏幕唤醒'];
            this.log(`[event] 设备事件：${names[fr.payload[0]] || fr.payload[0]}`);
          } else if (fr.type === proto.MsgType.PING) {
            // 设备主动 PING 就要回 PONG（协议里 PING 是双向的）
            this.send_frame(proto.encode_pong(), 'ctl', 1);
          }
        },
      });

      // ⚠️ 这里原来写的是 `new root.NavPuckRoute ? new GeoSource({...}) : null`，
      //    运算符优先级把它解析成 `(new root.NavPuckRoute) ? ... : ...` ——
      //    `new` 作用在**模块对象**上会直接抛 "root.NavPuckRoute is not a
      //    constructor"，整个 init() 在绑定任何按钮之前就崩掉。
      //    症状是"页面能打开、但所有按钮都没反应"，且控制台只有一条看不懂的
      //    TypeError。GeoSource（位置源）跟 NavPuckRoute 根本没关系，
      //    那个判断本身就是多余的 —— 正确的判断是"有没有 geolocation"。
      this.geo = GeoSource.supported() ? new GeoSource({
        onLog: (l) => this.log(l),
        // this.geo 在回调真正触发时（start()/watchPosition 回调）已经赋好值，
        // 这里只是把 fix_count / accuracy_m 一起带上状态面板。
        onState: (k, m) => this.set_gps_state(k, m, this.geo),
      }) : null;

      // 手动/模拟位置源：与 GPS 源**并列**存在，谁生效由 this.manual 决定。
      // 它没有异步等待，所以"设置即生效"，室内无 GPS 也能立刻跑整条链路。
      this.sim = new SimSource({
        onLog: (l) => this.log(l),
        onState: (k, m) => { if (this.manual) this.set_gps_state(k, m, this.sim); },
      });

      // 模拟行驶位置源：与 GPS / 手动源**并列**存在，谁生效由 active_source()
      // 决定。它比其他两个多一个"航线"依赖，所以航线由 do_route() 喂进来。
      this.routesim = new RouteSimSource({
        onLog: (l) => this.log(l),
        onState: (k, m) => { if (this.simdrive) this.set_gps_state(k, m, this.routesim); },
      });

      // ---- 按钮 ----
      const on = (id, ev, fn) => {
        const el = $(id);
        if (el) el.addEventListener(ev, fn);
      };

      // ⚠️ connect 必须在用户手势的**同步**处理里发起，中间不能有 await
      on('connect-btn', 'click', () => this.do_connect());
      // 「重试扫描」= 再走一遍完全相同的连接流程。它**必须是真正 <button> 上的
      // 点击**：以后若要回到 Web Bluetooth（Chrome 要求用户手势），这条路径
      // 依然成立；而在原生路径上它就是"再扫 6 秒"。
      on('rescan-btn', 'click', () => this.do_connect());
      on('disconnect-btn', 'click', () => {
        if (this.ble) this.ble.disconnect();
        this.stop_nav();
      });

      on('use-gps-btn', 'click', () => {
        // 模拟行驶：起点不需要任何定位。没有起点时直接用内置演示航线的起点，
        // 室内（无 GPS、也不手输坐标）就能两步跑起来。
        if (this.simdrive && (this.start_lat === null || this.start_lon === null)) {
          this.use_demo_start('模拟行驶');
          this.toast('起点已设为模拟起点（内置演示航线）', 5000);
          return;
        }
        // 手动位置生效时，"当前位置"就是那个手输坐标（同一条取起点的代码路径）
        const src = this.active_source();
        if (!src) {
          this.toast('这个浏览器没有定位能力，请用"高级 / 手动定位"手输坐标', 6000);
          return;
        }
        // watchPosition 是持续定位，只要拿到过 fix 就够了
        if (src.has_fix()) {
          this.start_lat = src.lat;
          this.start_lon = src.lon;
        } else if (src === this.geo) {
          src.start(this.mounted);
          this.toast('正在获取定位，拿到后请再按一次');
          return;
        } else {
          // 手动位置开着但坐标没填/没生效：别去 start()，它不会有任何回调
          this.toast('请先在"高级 / 手动定位"里填好纬度/经度');
          return;
        }
        const el = $('start-info');
        if (el) {
          el.textContent = `${this.start_lat.toFixed(6)}, ${this.start_lon.toFixed(6)}` +
                           (this.manual ? '（手动位置）' : (this.simdrive ? '（模拟行驶）' : ''));
        }
        this.toast(this.manual ? '起点已设为手动位置'
                              : (this.simdrive ? '起点已设为当前模拟位置' : '起点已设为当前位置'));
      });

      on('route-btn', 'click', () => this.do_route());
      on('stop-btn', 'click', () => {
        this.stop_nav();
        this.toast('已停止导航');
      });

      // ---- 手动位置 ----
      //
      // ⚠️ 分支只看 this.manual，**不**看复选框的当前值：坐标不合法时
      //    apply_manual() 会把复选框弹回未勾选，若再按"复选框是关的"走一遍
      //    "切回 GPS"分支，就会把"坐标不合法"的提示顶掉，用户看到的是
      //    "已切回 GPS 定位"—— 完全指不到真正的问题。
      on('opt-manual', 'change', () => {
        const want = !!($('opt-manual') || {}).checked;
        if (want) {
          // 刚勾上 -> 弹提示；已经开着（重复触发/改完又点）-> 静默重算
          this.apply_manual(this.manual);
        } else if (this.manual) {
          this.set_manual_active(false);
          this.log('[sim] 已切回 GPS 定位');
          this.toast('已切回 GPS 定位');
        }
      });
      on('man-apply', 'click', () => {
        const cb = $('opt-manual');
        if (cb) cb.checked = true;
        this.apply_manual(false);
      });
      // 输入框改完就生效（不必每次都回来按"应用"）；不合法时静默忽略，
      // 免得边输边弹窗
      on('man-lat', 'change', () => { if (this.manual) this.apply_manual(true); });
      on('man-lon', 'change', () => { if (this.manual) this.apply_manual(true); });
      on('man-heading', 'change', () => { if (this.manual) this.apply_manual(true); });
      on('man-speed', 'change', () => { if (this.manual) this.apply_manual(true); });

      // ---- 模拟行驶 ----
      //
      // 和手动位置同一套规矩：界面说在模拟就**必须真在模拟**（set_sim_drive_active
      // 会同时切换位置源），勾选后横幅立刻挂上，绝不会被当成真实定位。
      // ⚠️ 这个选择**刻意不持久化**：重新打开页面就回到真实定位。模拟行驶是
      //    测试模式，让它悄悄自己恢复，正是"把模拟当成真实"最危险的来源。
      on('opt-simdrive', 'change', () => {
        const want = !!($('opt-simdrive') || {}).checked;
        if (want) {
          this.apply_sim_drive(this.simdrive);
        } else if (this.simdrive) {
          this.set_sim_drive_active(false);
          this.log('[sim] 模拟行驶已关闭，切回真实定位');
          this.toast('已关闭模拟行驶');
        }
      });
      on('sim-apply', 'click', () => {
        const cb = $('opt-simdrive');
        if (cb) cb.checked = true;
        // 按"重新开始"时如果还没启用，就连启用一起做掉（少一步操作）
        if (!this.simdrive) this.apply_sim_drive(false);
        else this.restart_sim_route(false);
      });
      // 改速度**不**重置已经走到的位置（跑到一半调速度不该把车拨回起点）
      on('sim-speed', 'change', () => { if (this.simdrive) this.apply_sim_speed(true); });
      // 改起点偏移 = 重新开始（这个参数只在新一轮模拟时有意义）
      on('sim-start', 'change', () => { if (this.simdrive) this.restart_sim_route(true); });

      // 预设改变时同步到两个坐标框，用户能看到实际用了什么
      on('dest-preset', 'change', () => {
        const d = this.read_destination();
        if (d) {
          const la = $('dest-lat'); const lo = $('dest-lon');
          if (la) la.value = d[0];
          if (lo) lo.value = d[1];
        }
      });

      // ---- 地点搜索（见 phone/search.js）----
      //
      // 只在这两个时机发请求：**回车**和按「搜索」。刻意不做"边打边搜"——
      // Photon 是别人捐出来的免费实例，每敲一个字就发一次请求是打限流的
      // 标准姿势（search.js 里的缓存也是为这件事准备的）。
      {
        const si = $('search-input');
        if (si) {
          si.addEventListener('keydown', (ev) => {
            // 手机键盘右下角那颗键就是"搜索"（index.html 里的 enterkeyhint），
            // 桌面上是 Enter。两条都走同一个入口。
            const key = (ev && (ev.key !== undefined ? ev.key : ev.keyCode));
            if (key === 'Enter' || key === 13) {
              if (ev.preventDefault) ev.preventDefault();
              this.do_search();
            }
          });
          // `type=search` 自带的那个"清空"小叉会发一个 search 事件
          si.addEventListener('search', () => {
            if (!si.value) {
              this.clear_search_results();
              this.set_search_info('idle', '已清空：输入地名再搜索。');
            }
          });
        }
        on('search-btn', 'click', () => this.do_search());
        if (!srch) {
          this.set_search_info('error',
            '搜索模块（search.js）没加载成功：不能按地名搜索。' +
            '手输纬度/经度或者用「常用地点」都不受影响。');
        }
      }

      on('opt-log', 'change', () => {
        document.body.classList.toggle('show-log', !!$('opt-log').checked);
      });

      // ---- 后台运行（前台服务）/ 后台存活探针 ----
      //
      // 整块界面接线在 phone/fgs_ui.js 里（原生诊断，与导航无关；
      // 放那边是为了不和正在改这个文件的其它改动互相踩）。这里只调用一次。
      // 在 PWA 里它什么都不做：NavPuckFgs 的 available() 为 false，
      // 整块 <details id="fgs-block"> 直接隐藏，行为与加它之前一模一样。
      this.fgs = (root.NavPuckFgsUi && root.NavPuckFgsUi.setup)
        ? root.NavPuckFgsUi.setup(this)
        : null;
      if (!root.NavPuckFgsUi) {
        this.log('[fgs] fgs_ui.js 未加载：后台运行面板不可用（不影响导航）');
      }

      // ---- 街道路网底图开关 ----
      //
      // 恢复上次的选择（手机上的 PWA 每次打开都重新勾一遍很烦；而 Overpass
      // 挂掉、或者就是想省流量省电的时候，"关掉"正是要记住的那个选择）。
      // 默认**打开**：以前一直是这样，不改变老用户的观感。
      let map_pref = true;
      try {
        const v = localStorage.getItem(PREF_MAP_KEY);
        if (v === '0') map_pref = false;
        else if (v === '1') map_pref = true;
      } catch (_e) { /* 隐私模式：记不住就每次默认打开 */ }
      this.set_map_enabled(map_pref, true);

      on('opt-map', 'change', () => {
        const el = $('opt-map');
        this.set_map_enabled(!!(el && el.checked), false);
      });

      // ---- 地图（Canvas，见 phone/mapview.js）------------------------------
      //
      // ⚠️ 建视图放在**这里**（底图开关恢复之后），因为地图画什么由
      //    map_enabled 决定；放前面的话第一次状态写的还是旧值。
      //
      // 它和导航是**解耦**的：地图在"还没连接设备、还没定位"时就已经在了，
      // 靠下面那个 1 秒的心跳刷新（有定位就跟着走、没有就停在演示起点）。
      // 这样用户打开页面第一眼就能看到地图，而不是"必须先跑完整条链路"。
      this.mapview_instance();
      this.mapview_frame(true);
      on('mapview-here-btn', 'click', () => {
        const mv = this.mapview_instance();
        if (!mv) return;
        mv.recenter();
        this.mapview_frame(true);
        if (!this.mapview_pos()) {
          this.toast('还没有定位：地图停在最后一次的位置', 5000);
        } else if (mv.follow) {
          this.toast('地图已回到当前位置');
        }
      });
      on('mapview-zoom-in', 'click', () => {
        const mv = this.mapview_instance();
        if (mv) { mv.zoom_by(1.0); this.mapview_frame(true); }
      });
      on('mapview-zoom-out', 'click', () => {
        const mv = this.mapview_instance();
        if (mv) { mv.zoom_by(-1.0); this.mapview_frame(true); }
      });
      // 屏幕旋转 / 键盘弹出 / 面板展开都会改变画布的 CSS 尺寸。不重设的话，
      // 高 DPI 下画布的实际像素尺寸就和布局对不上了（图会糊或者被拉伸）。
      const on_layout = () => { if (this.mapview) this.mapview.on_resize(); };
      if (root.addEventListener) {
        root.addEventListener('resize', on_layout);
        root.addEventListener('orientationchange', on_layout);
      }

      // ---- BLE 分片（真机闪退的调节口，见 phone/ble_native.js）----
      // 恢复落盘的"上限/自动升档"，并把当前分片画进状态面板。
      this.init_chunk_ui();

      // 手机是否固定：默认当作固定（这是 v1 的正确用法）
      const mounted = $('opt-mounted');
      if (mounted) {
        mounted.checked = this.mounted;
        mounted.addEventListener('change', () => {
          this.mounted = mounted.checked;
          this.log(`[gps] 手机固定与车头同向：${this.mounted ? '是' : '否'}`);
        });
      }

      // ---- 后台/前台切换 ----
      //
      // 三件事必须一起做，缺一件就会出现"看着正常、其实已经不对"的状态：
      //   1. 告诉 Navigator 现在在不在后台 —— 它靠这个把"页面在后台，帧率已降"
      //      这句话说出来（这就是用户最需要的那句解释）。
      //   2. **屏幕常亮锁**：页面被隐藏时浏览器一定会把它收走，回到前台
      //      **必须重新申请**（不重新要 = 用户切出去看一眼消息，屏幕从此不再
      //      常亮，而界面上看不出来）。
      //   3. BLE 断了/被冻结之后把链路重新对齐（老逻辑，保留）。
      document.addEventListener('visibilitychange', () => {
        const hidden = this.page_hidden();
        if (this.nav) this.nav.set_hidden(hidden);
        if (hidden) {
          this.log('[app] 页面到后台：浏览器会把定时器压到约 1Hz（帧率会掉），' +
                   '屏幕常亮锁也会被收回；切回前台自动恢复');
          this.wake().on_hidden();
        } else {
          this.log('[app] 页面回到前台');
          // 重新申请屏幕常亮锁（只在还在导航时才会真的去要，见 on_visible）
          this.wake().on_visible();
          if (this.ble && this.ble.device && !this.ble.connected && !this.ble._manual_close) {
            this.ble.reconnect().catch((e) => this.log(`[ble] 重连失败：${e}`));
          }
        }
        this.render_awake_loop(this._ui_last);
      });

      // 会话恢复时自动重新定位（用户上一次授权过就不用再点）
      if (GeoSource.supported()) {
        this.geo.start(this.mounted);
      }

      // 看门狗：解析器停在残帧里超过 1.5 秒就复位（见 ble.js 的说明）。
      // NAV_CLOCK 的每 30 秒补发也搭在这一个 tick 上（tick_clock）——
      // 理由见 set_link_state 里那段说明：多一个 setInterval 就多一条
      // "忘了 clear" 的路，而它一旦漏了就是自测里都看不见的串扰。
      setInterval(() => {
        if (this.ble) this.ble.tick_watchdog();
        this.tick_clock();
        // ⭐ 地图的心跳：**导航没在跑的时候也要刷**（这正是"打开 app 就能看到
        //    地图"的那条路）。mapview.js 内部有 5Hz 节流，所以 1 秒敲一次
        //    等于 1Hz 重画；它还兼管"跟着定位走"和"本地瓦片刚读回来就上屏"。
        this.mapview_frame(false);
      }, 1000);

      this.set_link_state('idle', {});
      this.set_status(null);

      // 把演示目的地填进输入框，方便第一次打开就能试
      const la = $('dest-lat'); const lo = $('dest-lon');
      if (la) la.value = this.dest_lat;
      if (lo) lo.value = this.dest_lon;

      // 手动位置默认不启用。坐标框**刻意不预填** —— 空的输入框一眼就知道
      // "现在用的不是它"；预填一个看起来很像真实定位的坐标反而容易被误读。
      this.set_manual_active(false);

      // 模拟行驶同样默认不启用，而且**不从存储里恢复**（见事件绑定处的说明）。
      // 速度框的默认值写在 index.html 里（42 km/h，与 PC 版 --speed 一致）。
      this.set_sim_drive_active(false);

      // 定位面板的初始读数：还没有任何 fix（GPS 可能还在等，室内永远等不到）
      this.set_gps_state(GeoSource.supported() ? 'waiting' : 'unavailable',
                         GeoSource.supported() ? '' : '这个浏览器不支持 navigator.geolocation');

      this.log('NavPuck 手机端已就绪。步骤：1) 连接设备 2) 获取定位 3) 规划并开始导航' +
               '。室内收不到 GPS 时，展开"高级 / 手动定位"直接手输坐标，' +
               '或者用"高级 / 模拟行驶"让车沿航线自己走（速度/进度/航向都会动）');
    }
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  const app = new App();

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => app.init());
    } else {
      app.init();
    }
  }

  root.NavPuckApp = { App, Navigator, GeoSource, SimSource, RouteSimSource,
                      ScreenWakeLock, heading_unusable, app };

  // CommonJS 导出：只在 phone/test/ 的 Node 自测里用到。
  //
  // ⚠️ 空壳导出（导出 {}）会让 "new APP.Navigator(...)" 报
  //    "APP.Navigator is not a constructor"，而错误信息完全指不到真正的原因。
  //    既然模块里本来就有 module.exports 的判断，这里就把它导出去，
  //    让集成自测能直接构造真正的 Navigator，而不是另写一份仿制品。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.NavPuckApp;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
