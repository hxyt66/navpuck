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

  // 界面选项的持久化键。手机上的 PWA 每次打开都要重新勾一遍很烦，而
  // "关掉街道路网底图"（省流量、省电、Overpass 挂了）恰恰正是要记住的选择。
  const PREF_MAP_KEY = 'navpuck.opt.map.v1';

  // ⚠️ "底图已关闭"那句话**只有 map.js 里那一份**（OsmMapSource.status() 也用
  //    它）。这里取出同一个常量，是为了 map.js 自己都没加载成功时（底图源都
  //    建不起来）也能说同一句话，而不是另写一份、两边慢慢分叉。
  const MAP_DISABLED_TEXT = (mapmod && mapmod.MAP_DISABLED_TEXT) ||
    '街道路网底图已关闭：不再向 Overpass 发任何请求。不影响导航 —— ' +
    '路线、箭头、转向提示和 10Hz 更新都照常。';

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

      this._timer = null;
      this._last_tick_ms = 0;
      this.last_update = null;
      this.stats = { max_cycle_ms: 0, max_gap_ms: 0 };
      this._call_count = 0;
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
      const fix = this.source.fix(this.route.tangent_deg(this.s_hint));
      if (fix === null) return null;
      const [lat, lon, heading, speed_mps] = fix;

      // 把当前位置映射到路线里程上。
      //
      // 前 5 帧做全表搜索：idx_hint 初始为 0，如果路线起点离车很远（用户从
      // 中途开始导航），带 hint 的窗口搜索会锁在起点附近一动不动。跑几帧
      // 之后 hint 就准了，再切回窗口搜索省 CPU。
      if (this._call_count <= 5) {
        this.idx_hint = this.route.nearest_index_full(lat, lon);
        this._hinted = true;
      } else {
        this.idx_hint = this.route.nearest_index(lat, lon, this.idx_hint);
      }
      const s = this.route.s_at_index(this.idx_hint);
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
      if ((!this.route_sent) ||
          rt.window_needs_reanchor(s, this.origin_s, this.window_end_s,
                                   this.route.total_m)) {
        this._reanchor(lat, lon, s);
        this.route_resend_t = 0.0;
        this._send_window(true);
        // 原点变了，底图必须**同一轮**跟着换：底图的点也是相对这个原点的，
        // 落后一轮的话，这半秒里底图会整体偏掉"原点移动量"（5km = 一整屏）。
        this.map_timer = rt.MAP_SEND_PERIOD_S;
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
          this.map_timer = (this.map_timer || 0) + dt_s;
          if (this.map_timer >= rt.MAP_SEND_PERIOD_S || Math.abs(want_view_m - this.map_view_m) > 1.0) {
            this.map_src.refresh(lat, lon, this.clock_s);
            const m = this.map_src.build(this.origin_lat, this.origin_lon, lat, lon, want_view_m);
            if (m.seg_count > 0) {
              this.map_timer = 0.0;
              this.last_map_segs = m.seg_count;
              this.last_map_pts = m.total_pts;
              this.map_view_m = want_view_m;
              let frame;
              try {
                frame = proto.encode_nav_map(m);
              } catch (e) {
                // 底图帧超 MAX_PAYLOAD（见 proto.js 里那段说明）：丢掉底图不致命，
                // 但**绝不能**让它把这一轮的 NAV_UPDATE 一起带崩。
                this.onLog(`[map] 底图帧编码失败，跳过本次下发：${e}`);
                frame = null;
              }
              if (frame) this.send(frame, 'map', 3);
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
      });
      return u;
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
     * 而导航必须继续（骑手会锁屏看设备）。代价是后台可能被浏览器限流到 1Hz ——
     * 这份 app 需要用户保持屏幕常亮，见 README 的说明。
     */
    start() {
      if (this._timer !== null) return;
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

    get running() { return this._timer !== null; }

    _tick() {
      const t0 = now_ms();
      const dt = Math.max(0.001, Math.min(1.0, (t0 - this._last_tick_ms) / 1000.0));
      if (this._last_tick_ms > 0) {
        const gap = t0 - this._last_tick_ms;
        if (gap > this.stats.max_gap_ms) this.stats.max_gap_ms = gap;
      }
      this._last_tick_ms = t0;

      try {
        this.cycle(dt);
      } catch (e) {
        this.onLog(`[nav] cycle 抛错：${e}`);
      }
      const cms = now_ms() - t0;
      if (cms > this.stats.max_cycle_ms) this.stats.max_cycle_ms = cms;
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
      this.nav = null;
      this.route = null;
      this.start_lat = null;
      this.start_lon = null;
      this.mounted = true;      // 手机是否与车头同向固定（界面上可切）
      this.log_lines = [];
      this.map_enabled = true;  // "显示街道路网底图"（init 时从存储里恢复）
      this.map_source = null;   // 懒创建的 OsmMapSource（缓存/退避/状态都在它身上）

      // 起点/终点：默认用内置演示航线（西湖），这样没 GPS 也能验证链路
      const demo = rt.DEMO_ROUTE;
      this.dest_lat = demo[2][0];
      this.dest_lon = demo[2][1];
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
      // 控制台也留一份，用 USB 调试时方便
      if (typeof console !== 'undefined') console.log(s);
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
      if (state === 'up') this.toast('设备已连接');
      if (state === 'down') this.toast('链路断开', 5000);
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
     * @param {string} kind 'ok' | 'waiting' | 'denied' | 'unavailable' | 'manual'
     * @param {string} msg  错误/说明文本（可空）
     * @param {object} src  产生这次状态的位置源（默认 GPS 源）
     */
    set_gps_state(kind, msg, src) {
      const names = {
        ok: '已定位', waiting: '等待定位', denied: '权限被拒',
        unavailable: '不可用', manual: '手动定位',
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
        if (kind === 'manual') {
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
        if (this.manual) {
          text = '正在使用手动位置（模拟坐标），GPS 已经不影响导航。' +
                 '取消勾选可切回真实定位。';
        }
        hint.textContent = text;
        hint.hidden = !text;
      }

      if (msg) this.log(`[gps] ${msg}`);
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
        frames.textContent = this.ble
          ? `${this.ble.frames_sent} / ${this.ble.frames_dropped}丢`
          : String(this.nav ? this.nav.frames_sent : 0);
      }
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
        md.classList.toggle('warn', ms.state === 'unavailable' || ms.state === 'stale');
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
          detail: '还没有开始导航：街道路网底图会在导航启动后自动拉取，' +
            '单个镜像最多 12 秒、整轮最多 30 秒就会给结论。',
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
      return want;
    }

    // -- 位置来源：GPS 或手动 ------------------------------------------------
    /**
     * 当前生效的位置源：手动位置优先，否则 GPS（浏览器不支持定位时可能是 null）。
     *
     * Navigator 只依赖 source 的接口，所以"换源"就是换这个返回值 ——
     * 整条流水线（路线匹配、相对方位、10Hz 更新、地图旋转）一行都不用改。
     */
    active_source() {
      if (this.manual && this.sim) return this.sim;
      return this.geo;
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
      if (badge) badge.hidden = !this.manual;
      const cb = $('opt-manual');
      if (cb) cb.checked = this.manual;

      // 正在导航时换源：Navigator 只认接口，直接替换即可（不必重建循环）
      const src = this.active_source();
      if (this.nav) this.nav.source = src;

      if (this.manual) {
        this.set_gps_state('manual', '', this.sim);
      } else if (this.geo) {
        // 切回 GPS：把当前真实状态立刻重画一遍（多半还是"等待定位"）
        this.set_gps_state(this.geo.has_fix() ? 'ok' : 'waiting', '', this.geo);
      }
    }

    // -- 连接 --------------------------------------------------------------
    async do_connect() {
      if (!this.ble) return;
      try {
        await this.ble.connect();
      } catch (e) {
        // connect() 内部已经报过状态了；用户取消不算错误
        if (!/cancel|NotFoundError/i.test(String(e))) this.log(`连接失败：${e}`);
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
      // 全程用**当前生效的**位置源：手动位置时就是 SimSource，和 GPS 走同一段代码
      const src = this.active_source();

      this.toast('正在规划路线…', 10000);
      this.log(`[osrm] 起点 ${this.start_lat.toFixed(6)},${this.start_lon.toFixed(6)} ` +
               `-> 终点 ${dest[0].toFixed(6)},${dest[1].toFixed(6)}（${profile}）` +
               `${this.manual ? ' [手动位置]' : ''}`);

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
        this.log(`[osrm] 不可用（${e}），退回直线航点`);
        this.toast('路线服务不可用，已退回直线连接', 5000);
        route = rt.straight_route([[this.start_lat, this.start_lon, '起点'], [dest[0], dest[1], '终点']]);
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

      // 停掉旧循环，用新路线重建
      this.stop_nav();
      if (!use_map) {
        this.log('[map] 底图已关闭：本次导航不会向 Overpass 发任何请求');
      } else if (!map_src) {
        this.log('[map] 底图源不可用（map.js 没加载成功）：本次导航没有街道路网，' +
                 '但路线和箭头照常');
      } else {
        map_src.set_enabled(true);
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

      this.nav.start();
      this.toast('导航已启动');
      this.log('[nav] 10Hz 循环已启动');
    }

    send_frame(frame, kind, prio) {
      if (!this.ble || !this.ble.connected) return false;
      return this.ble.send(frame, kind, prio);
    }

    stop_nav() {
      if (this.nav) {
        this.nav.stop();
        this.nav = null;
        this.log('[nav] 循环已停止');
      }
    }

    // -- 启动 --------------------------------------------------------------
    init() {
      // 不支持的浏览器：给出明确提示而不是让按钮静默失效
      if (!('bluetooth' in navigator)) {
        const u = $('unsupported');
        if (u) u.hidden = false;
        this.log('⚠️ 这个浏览器没有 navigator.bluetooth：需要用 Android Chrome，' +
                 '并且页面必须在 localhost 或 HTTPS 下打开。');
      }

      this.ble = new root.NavPuckBle.BleLink({
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

      // ---- 按钮 ----
      const on = (id, ev, fn) => {
        const el = $(id);
        if (el) el.addEventListener(ev, fn);
      };

      // ⚠️ connect 必须在用户手势的**同步**处理里发起，中间不能有 await
      on('connect-btn', 'click', () => this.do_connect());
      on('disconnect-btn', 'click', () => {
        if (this.ble) this.ble.disconnect();
        this.stop_nav();
      });

      on('use-gps-btn', 'click', () => {
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
                           (this.manual ? '（手动位置）' : '');
        }
        this.toast(this.manual ? '起点已设为手动位置' : '起点已设为当前位置');
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

      // 预设改变时同步到两个坐标框，用户能看到实际用了什么
      on('dest-preset', 'change', () => {
        const d = this.read_destination();
        if (d) {
          const la = $('dest-lat'); const lo = $('dest-lon');
          if (la) la.value = d[0];
          if (lo) lo.value = d[1];
        }
      });

      on('opt-log', 'change', () => {
        document.body.classList.toggle('show-log', !!$('opt-log').checked);
      });

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

      // 手机是否固定：默认当作固定（这是 v1 的正确用法）
      const mounted = $('opt-mounted');
      if (mounted) {
        mounted.checked = this.mounted;
        mounted.addEventListener('change', () => {
          this.mounted = mounted.checked;
          this.log(`[gps] 手机固定与车头同向：${this.mounted ? '是' : '否'}`);
        });
      }

      // ---- 后台恢复：BLE 断了/页面被冻结之后要把状态重新对齐 ----
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.log('[app] 页面回到前台');
          if (this.ble && this.ble.device && !this.ble.connected && !this.ble._manual_close) {
            this.ble.reconnect().catch((e) => this.log(`[ble] 重连失败：${e}`));
          }
        }
      });

      // 会话恢复时自动重新定位（用户上一次授权过就不用再点）
      if (GeoSource.supported()) {
        this.geo.start(this.mounted);
      }

      // 看门狗：解析器停在残帧里超过 1.5 秒就复位（见 ble.js 的说明）
      setInterval(() => {
        if (this.ble) this.ble.tick_watchdog();
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

      // 定位面板的初始读数：还没有任何 fix（GPS 可能还在等，室内永远等不到）
      this.set_gps_state(GeoSource.supported() ? 'waiting' : 'unavailable',
                         GeoSource.supported() ? '' : '这个浏览器不支持 navigator.geolocation');

      this.log('NavPuck 手机端已就绪。步骤：1) 连接设备 2) 获取定位 3) 规划并开始导航' +
               '。室内收不到 GPS 时，展开"高级 / 手动定位"直接手输坐标');
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

  root.NavPuckApp = { App, Navigator, GeoSource, SimSource, heading_unusable, app };

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
