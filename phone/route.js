/*
 * NavPuck 航线 —— tools/navigator.py 里 Route / 加密 / 路口识别 / OSRM 的
 * JavaScript 忠实移植（对应 Python 的 Route 类、_densify()、load_osrm()）。
 *
 * 这里的所有阈值和算法都**照抄** navigator.py，不要"顺手优化"：
 * 两端算出的转向点下标必须落在同一条路线的同一个点上，否则手机显示"右转"
 * 而设备画出的箭头指向别处，现场完全没法查。
 *
 * 与 Python 的差异（都是语言/环境差异，不是算法差异）：
 *   - Route.point_at() 的二分查找在 Python 里用整数除法 //，JS 用 (lo+hi)>>1，
 *     对非负整数完全等价。
 *   - GPX 解析（load_gpx）在浏览器里用 DOMParser（见 gpx.js 的位置由 app.js 调），
 *     不走这条路；OSRM 走 fetch()。
 *   - Overpass 磁盘缓存 -> localStorage，见 map.js。
 */

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./navmath.js'), require('./proto.js'));
  } else {
    root.NavPuckRoute = factory(root.NavPuckMath, root.NavPuckProto);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (nm, proto) {

  // -------------------------------------------------------------------------
  // 常量 —— 逐条对应 navigator.py
  // -------------------------------------------------------------------------

  // 内置演示航线：和固件里的 DemoNavigator 是同一圈西湖，方便两边对照
  const DEMO_ROUTE = [
    [30.2545, 120.1350, '北山街'],
    [30.2585, 120.1490, '断桥残雪'],
    [30.2500, 120.1600, '湖滨路'],
    [30.2330, 120.1530, '南山路'],
    [30.2285, 120.1420, '长桥公园'],
    [30.2310, 120.1385, '苏堤南口'],
    [30.2340, 120.1340, '花港观鱼'],
    [30.2420, 120.1275, '杨公堤'],
    [30.2500, 120.1290, '曲院风荷'],
    [30.2560, 120.1350, '西泠桥'],
  ];

  const EARTH_M_PER_DEG_LAT = 110540.0;
  const EARTH_M_PER_DEG_LON_EQ = 111320.0;

  const LOOKAHEAD_M = 180.0;        // 箭头瞄多远之后的点
  const MANEUVER_WINDOW_M = 35.0;   // 判断"这是个路口"时前后各看多远
  const MANEUVER_MIN_DEG = 25.0;    // 转角超过这个度数才算一个转向动作

  // ---- 滑动窗口路线（NAV_ROUTE）----
  //
  // 只发"骑手前方的一段"，不再发整条路线。三个常量一起决定画出来的线和带宽
  // （navigator.py 里有同一段说明，两边必须逐字对齐）：
  //
  //   WINDOW_M   窗口有多长。它同时是**坐标上界**：点在窗口里，而窗口是从
  //              **骑手当前位置**（也就是原点）向前量的，所以任何一点的
  //              |east| / |north| 都不可能超过 WINDOW_M 加一点点横向偏差。
  //              i16 米的上限是 ±32767，取 10km 意味着用了不到 1/3，余量巨大。
  //   STEP_M     固定点距。**不能**再按"路线长度 / 点数上限"反推：那样 40km
  //              的路线会退化成 39 米一个点，而设备视野固定 160 米 —— 屏幕上
  //              只剩 4 个点，线看着是一段段折角。10 米一个点 = 160 米视野里
  //              16 个点，足够平滑，同时 10km / 10m = 1000 点仍在设备 1024
  //              点的容量内。
  //   REANCHOR_MOVE_M  骑手离开当前原点这么远就重锚（= 半个窗口）。
  //              5km 一次，42km/h 下约每 7 分钟 4KB，带宽可忽略。
  const WINDOW_M = 10000.0;
  const STEP_M = 10.0;
  const REANCHOR_MOVE_M = 5000.0;
  // 窗口末端离骑手不足这么远、而路线还没走完 —— 也要重锚。
  // 正常情况下"走远了"那条会先触发（5000 < 10000-1000），这条是保险：
  // 少了它，骑手会骑着骑着**冲出画出来的线**，屏幕上一片空白，
  // 而大脑还以为路线早就发过了。
  const REANCHOR_TAIL_M = 1000.0;

  // 设备端 kNavRouteMaxPoints（proto.js 里那个已经和 C++ 对拍钉住的常量）。
  // 这里只当**防御上限**用：正常参数下窗口最多 1001 点，到不了 1024 ——
  // 真到了就说明 WINDOW_M / STEP_M 被改坏了，宁可在这里夹住也不要发出去让
  // 设备整片拒收（症状是"完全没有指引线"，且没有任何提示）。
  const FULL_ROUTE_MAX_POINTS = proto.MAX_ROUTE_POINTS;

  // 当前窗口多久原样重发一次（秒）。只发一次的话，丢一个分片就整段没有指引线。
  // 重发的是**同一份窗口**（逐字节相同），设备端认得出来是重传，不会重画。
  const ROUTE_RESEND_PERIOD_S = 30.0;

  // 视野固定，全程一个比例，**不再自适应**（navigator.py 的 ROUTE_FAR_M）
  const ROUTE_FAR_M = 160.0;

  // 路网底图
  const MAP_RADIUS_M = 260.0;
  const MAP_SIMPLIFY_M = 7.0;
  const MAP_MAX_POINTS = 330;       // 设备端上限 400，留余量
  const MAP_MAX_SEGMENTS = 60;
  const MAP_SEND_PERIOD_S = 0.5;
  const MAP_REFRESH_S = 40.0;
  const MAP_REFRESH_MOVE_M = 80.0;
  const MAP_FAIL_COOLDOWN_S = 60.0;
  const MAP_CACHE_REUSE_M = 180.0;
  const MAP_CACHE_MAX = 60;
  const MAP_CACHE_MAX_AGE_S = 7 * 86400.0;

  // 道路等级：数字越小越优先保留。点预算不够时先丢次要道路。
  // 摩托车不画人行道/台阶/自行车道 —— 骑车时那些只会把屏幕塞满。
  const HIGHWAY_RANK = {
    motorway: 0, motorway_link: 1,
    trunk: 1, trunk_link: 2,
    primary: 2, primary_link: 3,
    secondary: 3, secondary_link: 4,
    tertiary: 4, tertiary_link: 5,
    unclassified: 5,
    residential: 6,
    living_street: 7,
    service: 8,
    road: 8,
  };

  // OSRM 公共实例（免费、不需要 API key）
  const OSRM_ENDPOINT = 'https://router.project-osrm.org';

  // -------------------------------------------------------------------------
  // 加密：在相邻点之间线性插值，让点距不超过 max_spacing_m
  // -------------------------------------------------------------------------
  /** 插值点不带路名。 */
  function _densify(raw, max_spacing_m) {
    if (raw.length < 2) return raw;
    const out = [];
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i];
      const b = raw[i + 1];
      out.push(a);
      const d = nm.distance_m(a[0], a[1], b[0], b[1]);
      if (d > max_spacing_m) {
        const n = Math.ceil(d / max_spacing_m);
        for (let k = 1; k < n; k++) {
          const t = k / n;
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, '']);
        }
      }
    }
    out.push(raw[raw.length - 1]);
    return out;
  }

  class RoutePoint {
    constructor(lat, lon, name, cum_m) {
      this.lat = lat;
      this.lon = lon;
      this.name = name || '';
      this.cum_m = cum_m || 0.0;
    }
  }

  /** 一条带弧长索引的航线，支持按里程取点。 */
  class Route {
    constructor(points, closed, max_spacing_m) {
      if (closed === undefined) closed = false;
      if (max_spacing_m === undefined) max_spacing_m = 25.0;

      let raw = points.slice();
      if (closed && raw.length > 0 &&
          (raw[0][0] !== raw[raw.length - 1][0] || raw[0][1] !== raw[raw.length - 1][1])) {
        raw.push(raw[0]);
      }

      // 加密。这一步不是可选的：
      //   - GPX 轨迹点间距从几米到几百米都有，直接拿来算"前方 180m 的点"
      //     和"路口前后 35m 的方向"会完全失真；
      //   - OSRM 的折线点也不保证足够密。
      raw = _densify(raw, max_spacing_m);

      this.points = [];
      let cum = 0.0;
      for (let i = 0; i < raw.length; i++) {
        if (i > 0) {
          cum += nm.distance_m(raw[i - 1][0], raw[i - 1][1], raw[i][0], raw[i][1]);
        }
        this.points.push(new RoutePoint(raw[i][0], raw[i][1], raw[i][2] || '', cum));
      }

      this.total_m = cum;
      this.maneuvers = this._detect_maneuvers();
    }

    // -- 基本查询 --------------------------------------------------------
    /** 按里程 s 取插值后的位置，返回 [lat, lon, 所在段起点下标]。 */
    point_at(s_m) {
      const s = Math.max(0.0, Math.min(s_m, this.total_m));
      let lo = 0;
      let hi = this.points.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.points[mid].cum_m < s) lo = mid + 1;
        else hi = mid;
      }
      const i = Math.max(1, lo);
      const a = this.points[i - 1];
      const b = this.points[i];
      const span = b.cum_m - a.cum_m;
      const t = span <= 1e-9 ? 0.0 : (s - a.cum_m) / span;
      return [a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t, i - 1];
    }

    /** 在里程 s 处的路径切线方向（罗盘方位）。 */
    tangent_deg(s_m) {
      const p0 = this.point_at(Math.max(0.0, s_m - 15.0));
      const p1 = this.point_at(Math.min(this.total_m, s_m + 15.0));
      return nm.bearing_deg(p0[0], p0[1], p1[0], p1[1]);
    }

    /**
     * 最近点搜索。带 hint 的窗口搜索，避免每次都全表扫描。
     *
     * window 默认 400：这个值决定了"最多能沿着路线往前/往后找多远"。
     * 手机上路线可能有上千个点，全表扫描在 10Hz 下是浪费；但窗口太小
     * 又会在 GPS 跳变时锁到错误的分支上（比如盘山路的回头弯）。
     */
    nearest_index(lat, lon, hint, window) {
      if (hint === undefined) hint = 0;
      if (window === undefined) window = 400;
      const n = this.points.length;
      const lo = Math.max(0, hint - 50);
      const hi = Math.min(n, hint + window);
      let best = lo;
      let best_d = Infinity;
      for (let i = lo; i < hi; i++) {
        const d = nm.distance_m(lat, lon, this.points[i].lat, this.points[i].lon);
        if (d < best_d) { best = i; best_d = d; }
      }
      return best;
    }

    /** 全表最近点搜索（没有 hint 可用时，比如刚拿到第一个定位）。 */
    nearest_index_full(lat, lon) {
      let best = 0;
      let best_d = Infinity;
      for (let i = 0; i < this.points.length; i++) {
        const d = nm.distance_m(lat, lon, this.points[i].lat, this.points[i].lon);
        if (d < best_d) { best = i; best_d = d; }
      }
      return best;
    }

    s_at_index(i) {
      return this.points[Math.min(Math.max(i, 0), this.points.length - 1)].cum_m;
    }

    // -- 路口识别 --------------------------------------------------------
    /**
     * 找出所有"值得提示"的转向点。
     *
     * 做法：对每个点，比较它前 window 米和后 window 米的路径方向，
     * 差值超过阈值就是一个转向动作。这比只看相邻点夹角稳得多 ——
     * 相邻点可能只差几米，噪声会让夹角乱跳。
     *
     * 返回 [[index, delta_deg, turn], ...]
     */
    _detect_maneuvers() {
      const out = [];
      const n = this.points.length;
      if (n < 5) return out;

      let j = 0;
      for (let i = 1; i < n - 1; i++) {
        const s = this.points[i].cum_m;
        // 往前找 window 米的点
        let k = i;
        while (k + 1 < n && this.points[k].cum_m - s < MANEUVER_WINDOW_M) k += 1;
        // 往后找 window 米的点
        let m = i;
        while (m > 0 && s - this.points[m].cum_m < MANEUVER_WINDOW_M) m -= 1;
        if (k <= i || m >= i) continue;

        const b_in = nm.bearing_deg(this.points[m].lat, this.points[m].lon,
                                    this.points[i].lat, this.points[i].lon);
        const b_out = nm.bearing_deg(this.points[i].lat, this.points[i].lon,
                                     this.points[k].lat, this.points[k].lon);
        const delta = nm.shortest_delta(b_in, b_out);
        if (Math.abs(delta) >= MANEUVER_MIN_DEG) {
          if (j === 0 || i - j > 3) {      // 合并相邻的重复检测
            out.push([i, delta, nm.classify_turn(delta, proto.Turn)]);
            j = i;
          }
        }
      }
      return out;
    }

    /** 返回里程 s 之后最近的一个转向点 [index, s, turn, name]，没有就是 null。 */
    next_maneuver(s_m) {
      for (const [idx, _delta, turn] of this.maneuvers) {
        const sm = this.points[idx].cum_m;
        if (sm > s_m + 5.0) {
          // 路名取路口之后那一段的名字（"你即将进入的路"）
          let name = '';
          for (let k = idx; k < Math.min(idx + 12, this.points.length); k++) {
            if (this.points[k].name) { name = this.points[k].name; break; }
          }
          return [idx, sm, turn, name];
        }
      }
      return null;
    }

    /** 当前所在路段的路名。 */
    road_name_at(s_m) {
      let idx = 0;
      for (let i = 0; i < this.points.length; i++) {
        if (this.points[i].cum_m <= s_m) idx = i;
        else break;
      }
      for (let k = idx; k >= 0; k--) {
        if (this.points[k].name) return this.points[k].name;
      }
      return '';
    }
  }

  // -------------------------------------------------------------------------
  // 滑动窗口：把"前方一段"抽成固定点距的点集
  // -------------------------------------------------------------------------
  /**
   * 要不要重锚。两个理由：
   *   1. 骑手已经离开当前原点超过半个窗口 —— 再走下去，已经画出来的线就快
   *      被骑手自己甩到身后了；
   *   2. 窗口末端快到了（离骑手不足 REANCHOR_TAIL_M），而路线还没走完 ——
   *      不重锚的话骑手会直接骑出画出来的线。
   */
  function window_needs_reanchor(s_m, origin_s, window_end_s, total_m) {
    if (Math.abs(s_m - origin_s) > REANCHOR_MOVE_M) return true;
    return window_end_s < total_m - 1.0 && s_m + REANCHOR_TAIL_M >= window_end_s;
  }

  /**
   * 从弧长 s 处**向前**取到 min(路线终点, s + WINDOW_M)，按固定 STEP_M 抽点。
   *
   * 坐标是相对 [origin_lat, origin_lon] 的**正北局部平面、单位米**，原点就是
   * 发这一窗时骑手的位置 —— 于是 pos_east_m / pos_north_m 在这套坐标里天然是
   * 小量（骑手离原点不会超过半个窗口），i16 永远够用。
   *
   * 返回 { pts, end_s }。点距恒为 STEP_M，只有最后一点例外：它落在窗口末端上
   * （不足一步时就是那个短段），这样线尾不会停在窗口里面。
   * 点数是 floor(窗口长/STEP_M) + 1，最多 1001 点（设备上限 1024）。
   */
  function build_route_window(route, s_m, origin_lat, origin_lon) {
    const total = route.total_m;
    const s0 = Math.max(0.0, Math.min(s_m, total));
    const end_s = Math.min(total, s0 + WINDOW_M);
    const length_m = end_s - s0;

    let n = Math.floor(length_m / STEP_M) + 1;
    if (n > FULL_ROUTE_MAX_POINTS) n = FULL_ROUTE_MAX_POINTS;   // 防御
    if (n < 2 && length_m > 1e-9) n = 2;    // 窗口非零至少两个点，否则画不出线

    const cos_lat = Math.cos(origin_lat * nm.DEG2RAD);
    const pts = [];
    for (let k = 0; k < n; k++) {
      // Math.min(..., length_m)：只有 n == 2 的短窗口才会用到
      const [lat, lon] = route.point_at(s0 + Math.min(k * STEP_M, length_m));
      const e = (lon - origin_lon) * EARTH_M_PER_DEG_LON_EQ * cos_lat;
      const nn = (lat - origin_lat) * EARTH_M_PER_DEG_LAT;
      pts.push([nm.pyround(e), nm.pyround(nn)]);
    }
    return { pts: pts, end_s: end_s };
  }

  // -------------------------------------------------------------------------
  // OSRM：把稀疏的途经点变成**真实沿道路**的折线
  // -------------------------------------------------------------------------
  /**
   * 免费、不需要 API key。公共实例有公平使用限制，别做高频调用 ——
   * 这个 app 只在"用户按了开始导航"时调一次（外加用户主动改目的地时）。
   *
   * profile: OSRM 公共服务的 driving / cycling / foot。摩托车用 driving。
   *
   * 返回 { route, raw: {distance_m, duration_s, point_count} }。
   * 出错时抛异常（调用方负责回退到直线航点）。
   */
  async function load_osrm(waypoints, profile, opts) {
    if (profile === undefined || profile === null) profile = 'driving';
    const o = opts || {};
    if (waypoints.length < 2) throw new Error('OSRM 至少需要 2 个途经点');

    const coords = waypoints.map((w) => `${w[1].toFixed(6)},${w[0].toFixed(6)}`).join(';');
    const url = `${o.endpoint || OSRM_ENDPOINT}/route/v1/${profile}/${coords}` +
                '?overview=full&geometries=geojson&continue_straight=false';

    const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!doFetch) throw new Error('这个环境没有 fetch()');

    const resp = await doFetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
    const j = await resp.json();

    if (j.code !== 'Ok' || !j.routes || j.routes.length === 0) {
      throw new Error(`OSRM 规划失败：${j.message || j.code}`);
    }

    const line = j.routes[0].geometry.coordinates;     // [[lon, lat], ...]
    const pts = line.map(([lon, lat]) => [Number(lat), Number(lon), '']);

    // 把命名途经点贴到最近的折线点上，这样界面上还能显示路名
    for (const [wlat, wlon, name] of waypoints) {
      if (!name) continue;
      let best_i = 0;
      let best_d = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = nm.distance_m(wlat, wlon, pts[i][0], pts[i][1]);
        if (d < best_d) { best_i = i; best_d = d; }
      }
      pts[best_i] = [pts[best_i][0], pts[best_i][1], name];
    }

    const rt = j.routes[0];
    return {
      route: new Route(pts),
      raw: {
        distance_m: rt.distance,
        duration_s: rt.duration,
        point_count: pts.length,
      },
    };
  }

  /**
   * 只用 OSRM 取一条真实道路折线，**不做** Route 包装（给需要先看距离的界面用）。
   * 实际上直接把 load_osrm 的结果拿出来用就行，这里是为了语义清晰。
   */
  function straight_route(waypoints) {
    return new Route(waypoints.map((w) => [w[0], w[1], w[2] || '']), false);
  }

  return {
    DEMO_ROUTE,
    EARTH_M_PER_DEG_LAT, EARTH_M_PER_DEG_LON_EQ,
    LOOKAHEAD_M, MANEUVER_WINDOW_M, MANEUVER_MIN_DEG,
    WINDOW_M, STEP_M, REANCHOR_MOVE_M, REANCHOR_TAIL_M,
    FULL_ROUTE_MAX_POINTS, ROUTE_RESEND_PERIOD_S, ROUTE_FAR_M,
    MAP_RADIUS_M, MAP_SIMPLIFY_M, MAP_MAX_POINTS, MAP_MAX_SEGMENTS,
    MAP_SEND_PERIOD_S, MAP_REFRESH_S, MAP_REFRESH_MOVE_M, MAP_FAIL_COOLDOWN_S,
    MAP_CACHE_REUSE_M, MAP_CACHE_MAX, MAP_CACHE_MAX_AGE_S,
    HIGHWAY_RANK, OSRM_ENDPOINT,
    _densify, RoutePoint, Route, load_osrm, straight_route,
    window_needs_reanchor, build_route_window,
  };
}));
