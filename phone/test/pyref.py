#!/usr/bin/env python3
"""
对拍用的 Python 参考实现 —— 由 phone/test/parity.mjs 调用。

职责：**只**用 tools/navigator.py + tools/navmath.py + tools/navpuck_proto.py
（也就是路由的真正权威实现）对一组固定输入算出结果，以 JSON 打到 stdout。
Node 侧用同样的输入跑 route.js / map.js / app.js 的移植版，比结果。

这个文件**不重新实现任何算法** —— 它只是把 navigator.py 的函数拿过来喂参数。
一旦这里开始"顺手写一遍算法"，对拍就失去意义了（两边一起错就测不出来）。

约定：stdout 上**只能有 JSON**。任何调试输出都必须走 stderr。
"""

from __future__ import annotations

import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.abspath(os.path.join(_HERE, "..", "..", "tools"))
sys.path.insert(0, _TOOLS)

import navmath as nm                      # noqa: E402
import navigator as nav                   # noqa: E402
import navpuck_proto as proto             # noqa: E402


# ---------------------------------------------------------------------------
# 固定输入 —— Node 侧硬编码同样的值
# ---------------------------------------------------------------------------

# 一条小航线：带一个明显的左转和一个明显的右转，用来验证路口识别。
# 数值是随手的经纬度，只要两端一样就行。
ROUTE_POINTS = [
    (30.2500, 120.1300, "起点路"),
    (30.2500, 120.1330, "起点路"),
    (30.2520, 120.1330, "北向路"),      # 左转（向北）
    (30.2540, 120.1330, "北向路"),
    (30.2560, 120.1330, "北向路"),
    (30.2560, 120.1370, "东向路"),      # 右转（向东）
    (30.2560, 120.1410, "东向路"),
    (30.2530, 120.1410, "南向路"),      # 右转（向南）
    (30.2500, 120.1410, "南向路"),
    (30.2500, 120.1450, "终点路"),
]

# 整条路线抽稀用的输入：一条更长的折线，保证 n 明显大于 2
FULL_ROUTE_POINTS = [
    (30.2500 + i * 0.0006, 120.1300 + i * 0.0009, "") for i in range(120)
]

# 滑动窗口对拍用的输入：一条 **60km 的长路线**（每 ~105m 一个点）。
#
# 为什么非要 60km：这一版修的就是"路线超过 ±32.7km 就没法导航"。
# 60km > 32.7km，旧实现会直接 SystemExit；新实现必须一路正常，
# 而且**每一次重锚**的窗口都要落在 i16 米和 1024 点之内。
LONG_ROUTE_POINTS = [
    (30.2500 + i * 0.0009, 120.1300 + i * 0.00035, "") for i in range(601)
]

# 骑行对拍参数。dt 取 2 秒只是为了让 JSON 别太大（少跑几千帧），
# 它不参与任何算法：窗口只跟弧长和骑手位置有关。
RIDE_SPEED_MPS = 25.0
RIDE_DT_S = 2.0
RIDE_FRAMES = 1300        # 60km @ 25m/s = 2400s -> 1200 帧，留点余量跑完全程

# NAV_UPDATE 对拍用的 fix 序列（lat, lon, heading_deg, speed_mps）
UPDATE_FIXES = [
    (30.2500, 120.1300, 0.0, 0.0),
    (30.2505, 120.1310, 5.0, 8.0),
    (30.2515, 120.1322, 12.0, 12.0),
    (30.2530, 120.1330, 0.0, 14.0),
    (30.2550, 120.1330, 2.0, 15.0),
    (30.2560, 120.1350, 88.0, 10.0),
    (30.2560, 120.1390, 92.0, 16.0),
    (30.2550, 120.1410, 168.0, 11.0),
    (30.2510, 120.1410, 180.0, 13.0),
    (30.2500, 120.1430, 89.0, 9.0),
]


def _math_cases():
    """一组 navmath 算例。逐位比（两边都是纯 IEEE754 运算）。"""
    cases = []
    for d in (-720.0, -360.0, -180.0, -179.999, -0.5, 0.0, 0.5, 90.0, 179.999,
              180.0, 180.001, 270.0, 359.5, 360.0, 540.0, 1e-9):
        cases.append({"fn": "wrap180", "args": [d], "want": nm.wrap180(d)})
        cases.append({"fn": "wrap360", "args": [d], "want": nm.wrap360(d)})
    for a, b in ((0.0, 0.0), (0.0, 180.0), (0.0, -180.0), (350.0, 10.0), (10.0, 350.0),
                 (90.0, 270.0), (-179.0, 179.0), (179.0, -179.0), (1e-12, -1e-12)):
        cases.append({"fn": "shortest_delta", "args": [a, b], "want": nm.shortest_delta(a, b)})
    for lat1, lon1, lat2, lon2 in (
        (0.0, 0.0, 1.0, 0.0), (0.0, 0.0, 0.0, 1.0), (0.0, 0.0, -1.0, 0.0),
        (0.0, 0.0, 0.0, -1.0), (30.2545, 120.1350, 30.2585, 120.1490),
        (30.25, 120.13, 30.25, 120.13), (-33.9, 151.2, 51.5, -0.13),
        (89.9, 0.0, 89.9, 180.0), (0.0, 0.0, 0.0, 0.0),
    ):
        cases.append({"fn": "bearing_deg", "args": [lat1, lon1, lat2, lon2],
                      "want": nm.bearing_deg(lat1, lon1, lat2, lon2)})
        cases.append({"fn": "distance_m", "args": [lat1, lon1, lat2, lon2],
                      "want": nm.distance_m(lat1, lon1, lat2, lon2)})
    for cur, tgt, dt, tau, mrs in (
        (0.0, 90.0, 0.1, 500.0, 400.0), (0.0, 90.0, 0.0, 500.0, 400.0),
        (0.0, 90.0, 0.1, 0.0, 400.0), (0.0, 170.0, 0.1, 1.0, 400.0),
        (0.0, -170.0, 0.1, 1.0, 400.0), (350.0, 10.0, 0.05, 500.0, 0.0),
        (355.0, 5.0, 0.05, 500.0, 0.0), (-179.0, 179.0, 0.016, 220.0, 400.0),
    ):
        cases.append({"fn": "approach_angle", "args": [cur, tgt, dt, tau, mrs],
                      "want": nm.approach_angle(cur, tgt, dt, tau, mrs)})
    for x, a, b, c, d in ((5.0, 0.0, 10.0, 0.0, 100.0), (-1.0, 0.0, 10.0, 0.0, 100.0),
                          (11.0, 0.0, 10.0, 0.0, 100.0), (5.0, 10.0, 10.0, 7.0, 100.0)):
        cases.append({"fn": "map_clamp", "args": [x, a, b, c, d],
                      "want": nm.map_clamp(x, a, b, c, d)})
    return cases


def _route_block(points, closed, max_spacing_m):
    r = nav.Route(list(points), closed=closed, max_spacing_m=max_spacing_m)
    olat, olon, _ = r.point_at(0.0)
    cos0 = math.cos(math.radians(olat))

    # point_at / tangent_deg 沿整条路线均匀采样 40 个点
    pa = []
    tan = []
    for k in range(41):
        s = r.total_m * k / 40.0
        la, lo, idx = r.point_at(s)
        pa.append([la, lo, idx])
        tan.append(r.tangent_deg(s))

    # nearest_index 的探测点：沿路线均匀取 20 个真实点，稍微偏移一点
    probes = []
    nearest = []
    for k in range(20):
        la, lo, _ = r.point_at(r.total_m * (k + 1) / 21.0)
        # 往东北各偏 ~5e-5 度（约 5 米），保证不会正好落在某个点上
        pla = la + 5e-5
        plo = lo + 5e-5
        probes.append([pla, plo])
        i = r.nearest_index(pla, plo, 0, len(r.points))
        nearest.append([i, r.s_at_index(i)])

    # next_maneuver / road_name_at
    nextm = []
    roadnames = []
    for k in range(31):
        s = r.total_m * k / 30.0
        nx = r.next_maneuver(s)
        nextm.append(None if nx is None else [nx[0], nx[1], int(nx[2]), nx[3]])
        roadnames.append(r.road_name_at(s))

    return {
        "total_m": r.total_m,
        "points": [{"lat": p.lat, "lon": p.lon, "name": p.name, "cum_m": p.cum_m}
                   for p in r.points],
        "maneuvers": [[i, d, int(t)] for i, d, t in r.maneuvers],
        "point_at": pa,
        "tangent": tan,
        "probe_points": probes,
        "nearest_probe": nearest,
        "next_maneuver": nextm,
        "road_name": roadnames,
        "origin": [olat, olon],
        "cos_lat0": cos0,
    }, r


def _window_ride():
    """
    滑动窗口的整段骑行：沿 60km 长路线按固定步长推进，把每一次（重）锚的窗口
    完整记下来。

    ⚠️ 这里**不**用真实的 Navigator 类。原因是一个**两边本来就不同**的细节：
    navigator.py 在 SimSource 下直接用模拟器的 s（精确值），而 app.js 无论
    什么位置源都走"最近路线点的 cum_m"（量化到点上，最多差半个点距）。
    真拿两个 Navigator 的帧流对拍，会一直在这一点上假失败 —— 那是位置源的
    差异，不是这一版要测的窗口算法。

    所以这里只驱动**共享的那两个函数**（window_needs_reanchor /
    build_route_window，两边是同一份逻辑的两份移植），骑行的 `s` 序列在两边
    逐帧相同（都是同一个浮点累加）。窗口算法本身一行都没有在这里重写。
    """
    r = nav.Route(list(LONG_ROUTE_POINTS))
    step_m = RIDE_SPEED_MPS * RIDE_DT_S
    windows = []
    s = 0.0
    origin_s = 0.0
    window_end = 0.0
    sent = False
    k = 0
    while s < r.total_m and k < RIDE_FRAMES:
        lat, lon, _ = r.point_at(s)
        if (not sent) or nav.window_needs_reanchor(s, origin_s, window_end,
                                                  r.total_m):
            pts, window_end = nav.build_route_window(r, s, lat, lon)
            origin_s = s
            sent = True
            windows.append({
                "s_m": s,
                "origin_s": origin_s,
                "end_s": window_end,
                "n": len(pts),
                "span_m": max((max(abs(e), abs(nn)) for e, nn in pts), default=0),
                "first": list(pts[0]),
                "last": list(pts[-1]),
                "pts": [[e, nn] for e, nn in pts],
            })
        s += step_m
        k += 1
    return {
        "total_m": r.total_m,
        "step_m": step_m,
        "frames": k,
        "windows": windows,
        "reanchors": len(windows),
    }


def _updates(r, win_pts, origin_s, window_end_s, origin, fixes):
    """
    镜像 navigator.Navigator.cycle() 的数学部分（路线改成滑动窗口之后）。

    刻意**不**走 Navigator 类本身：那个类要 send_fn、要 OsmMapSource、
    要 args，套起来噪声太大。这里只把它 cycle() 里那几行算术照抄一遍 ——
    照抄的范围就是 Node 侧对拍的范围。

    窗口（win_pts / origin_s / window_end_s / origin）由调用方用
    navigator.build_route_window() 算好传进来 —— 窗口本身的算法**不在这里
    重写**，那样对拍就测不到它了。
    """
    total = r.total_m
    olat, olon = origin
    cos0 = math.cos(math.radians(olat))
    out = []

    for (lat, lon, heading, speed_mps) in fixes:
        i = r.nearest_index(lat, lon, 0, len(r.points))
        s = r.s_at_index(i)

        look_s = min(s + nav.LOOKAHEAD_M, total)
        llat, llon, _ = r.point_at(look_s)
        bearing_to_look = nm.bearing_deg(lat, lon, llat, llon)

        nxt = r.next_maneuver(s)
        if nxt is not None:
            midx, ms, turn, road = nxt
            mlat, mlon, _ = r.point_at(ms)
            dist_next = nm.distance_m(lat, lon, mlat, mlon)
            abs_bearing = nm.bearing_deg(lat, lon, mlat, mlon)
        else:
            turn, road = proto.Turn.ARRIVE, r.road_name_at(s)
            dist_next = total - s
            abs_bearing = bearing_to_look

        if total - s < 30.0:
            turn = proto.Turn.ARRIVE
            dist_next = max(0.0, total - s)

        rel = nm.shortest_delta(heading, bearing_to_look)
        want_view_m = nav.ROUTE_FAR_M

        pe = (lon - olon) * nav.EARTH_M_PER_DEG_LON_EQ * cos0
        pn = (lat - olat) * nav.EARTH_M_PER_DEG_LAT

        # next_turn_index：与 Navigator.turn_index_of() 一致（窗口内下标）
        if nxt is None or len(win_pts) < 2:
            nti = proto.NO_TURN
        else:
            ms = r.points[nxt[0]].cum_m
            if ms > window_end_s + 0.5:
                nti = proto.NO_TURN
            else:
                nti = max(0, min(len(win_pts) - 1,
                                 int(round((ms - origin_s) / nav.STEP_M))))

        out.append({
            # ⚠️ 这里的取整必须与 navigator.py 第 998~1015 行**逐字段**一致。
            #    角度类字段是 int(round(x))，距离/速度/ETA/进度是 int(x)。
            #    一开始这里把 dist_dest_m 写成了 int(max(0.0, round(...)))，
            #    结果对拍报出"JS 与 PY 差 1 米"—— 那是**参考实现对错了**，
            #    不是端口错。参考实现里多写一个 round() 比端口里少写一个
            #    更危险：它会让对拍指向错误的方向，浪费一整个排查周期。
            "rel_bearing_cdeg": int(round(rel * 100)),
            "abs_bearing_cdeg": int(round(nm.wrap360(abs_bearing) * 100)) % 36000,
            "dist_next_cm": int(min(dist_next * 100, 0xFFFFFFFF)),
            "dist_dest_m": int(max(0.0, total - s)),
            "speed_kmh_x10": int(min(speed_mps * 3.6 * 10, 65535)),
            "eta_min": int(min((total - s) / max(speed_mps, 0.5) / 60.0, 65535)),
            "turn": int(turn),
            "progress_pct": int(max(0, min(100, s * 100.0 / max(total, 1.0)))),
            "heading_cdeg": int(round(nm.wrap360(heading) * 100)) % 36000,
            "pos_east_m": int(round(pe)),
            "pos_north_m": int(round(pn)),
            "next_turn_index": int(nti),
            "view_range_dm": int(round(want_view_m * 10)),
            "road_name": road or "",
        })
    return out


def _build_case():
    """
    OsmMapSource.build() 的对拍。

    ways 是**人造**的（不联网）：一份相对路线起点附近的路网折线集合。
    """
    origin_lat, origin_lon = 30.2500, 120.1300
    lat, lon = 30.2510, 120.1305
    view_m = nav.ROUTE_FAR_M

    ways = []
    # rank 0：一条穿过车附近的主干道（点密一点，触发抽稀）
    ways.append((0, [(30.2495 + i * 0.00005, 120.1300 + i * 0.00008) for i in range(40)]))
    # rank 3：两条次级路
    ways.append((3, [(30.2520, 120.1290 + i * 0.0001) for i in range(25)]))
    ways.append((3, [(30.2480 + i * 0.0001, 120.1330) for i in range(25)]))
    # rank 6：一条住宅路，大部分在裁剪窗口外
    ways.append((6, [(30.2400 + i * 0.0005, 120.1400) for i in range(20)]))
    # 太短，应当被丢掉
    ways.append((4, [(30.2500, 120.1300)]))
    ways.sort(key=lambda w: w[0])

    src = nav.OsmMapSource(max_points=nav.MAP_MAX_POINTS, max_segs=nav.MAP_MAX_SEGMENTS)
    src.ways = list(ways)
    src.anchor = (lat, lon)

    m = src.build(origin_lat, origin_lon, lat, lon, view_m)
    frame = proto.encode_nav_map(m) if m.seg_count > 0 else b""

    return {
        "origin_lat": origin_lat, "origin_lon": origin_lon,
        "lat": lat, "lon": lon, "view_m": view_m,
        "radius_m": nav.MAP_RADIUS_M,
        "max_points": nav.MAP_MAX_POINTS, "max_segs": nav.MAP_MAX_SEGMENTS,
        "ways": [[r, [[a, b] for a, b in g]] for r, g in ways],
        "out_seg_count": m.seg_count,
        "out_total_pts": m.total_pts,
        "out_seg_pts": list(m.seg_pts),
        "out_pts": [[e, n] for e, n in m.pts],
        "out_frame_hex": frame.hex(),
    }


def _osrm_case():
    """load_osrm() 的解析对拍。用一份**假**响应，不联网。"""
    coords_lonlat = [[120.1300 + i * 0.0002, 30.2500 + (i % 7) * 0.0003] for i in range(60)]
    waypoints = [(30.2500, 120.1300, "起点"), (30.2500 + 6 * 0.0003, 120.1300 + 59 * 0.0002, "终点")]

    # 用 navigator.load_osrm 的解析逻辑：这里手工走一遍同样的步骤（它内部直接
    # 调 urlopen，没法注入假响应），所以是把那段逻辑抄出来 —— 抄的范围就是
    # Node 侧对拍的范围，两端抄的是同一段。
    pts = [(float(la), float(lo), "") for (lo, la) in coords_lonlat]
    for (wlat, wlon, name) in waypoints:
        if not name:
            continue
        best_i, best_d = 0, float("inf")
        for i, (plat, plon, _t) in enumerate(pts):
            d = nm.distance_m(wlat, wlon, plat, plon)
            if d < best_d:
                best_i, best_d = i, d
        pts[best_i] = (pts[best_i][0], pts[best_i][1], name)

    r = nav.Route(pts)
    return {
        "coords_lonlat": coords_lonlat,
        "waypoints": [list(w) for w in waypoints],
        "distance_m": 4321.0,
        "duration_s": 620.0,
        "profile": "driving",
        "expected_point_count": r.points and len(r.points) or 0,
        "expected_total_m": r.total_m,
        "expected_maneuver_count": len(r.maneuvers),
    }


def main() -> int:
    route_block, r = _route_block(ROUTE_POINTS, False, 25.0)
    fr_block, r_full = _route_block(FULL_ROUTE_POINTS, False, 25.0)

    # ---- NAV_UPDATE 对拍：窗口由 build_route_window() 算（原点 = 第一帧位置）----
    upd_route = nav.Route(list(FULL_ROUTE_POINTS), closed=False, max_spacing_m=25.0)
    f0 = UPDATE_FIXES[0]
    i0 = upd_route.nearest_index(f0[0], f0[1], 0, len(upd_route.points))
    s0 = upd_route.s_at_index(i0)
    win_pts, win_end = nav.build_route_window(upd_route, s0, f0[0], f0[1])
    updates = _updates(upd_route, win_pts, max(0.0, min(s0, upd_route.total_m)),
                       win_end, (f0[0], f0[1]), UPDATE_FIXES)

    # ---- 滑动窗口：60km 长路线整段骑行 ----
    ride = _window_ride()

    densify_in = [(30.2500 + i * 0.004, 120.1300 + i * 0.006, "") for i in range(5)]

    out = {
        "math": _math_cases(),
        "route_input": {"points": [list(p) for p in ROUTE_POINTS], "closed": False,
                        "max_spacing_m": 25.0},
        "route": route_block,
        "update_input": {"points": [list(p) for p in FULL_ROUTE_POINTS], "closed": False,
                         "max_spacing_m": 25.0,
                         "fixes": [list(f) for f in UPDATE_FIXES]},
        "update_window": {
            "origin": [f0[0], f0[1]],
            "origin_s": max(0.0, min(s0, upd_route.total_m)),
            "end_s": win_end,
            "n": len(win_pts),
        },
        "updates": updates,
        "ride_input": {"points": [list(p) for p in LONG_ROUTE_POINTS], "closed": False,
                       "max_spacing_m": 25.0,
                       "speed_mps": RIDE_SPEED_MPS, "dt_s": RIDE_DT_S,
                       "frames": RIDE_FRAMES},
        "ride": ride,
        "densify_input": {"in": [list(p) for p in densify_in], "max_spacing_m": 100.0},
        "densify_output": [list(p) for p in nav._densify(list(densify_in), 100.0)],
        "build_case": _build_case(),
        "osrm_case": _osrm_case(),
        "invariants": {
            "route_far_m": nav.ROUTE_FAR_M,
            "route_resend_period_s": nav.ROUTE_RESEND_PERIOD_S,
            "window_m": nav.WINDOW_M,
            "step_m": nav.STEP_M,
            "reanchor_move_m": nav.REANCHOR_MOVE_M,
            "reanchor_tail_m": nav.REANCHOR_TAIL_M,
            "max_route_points": proto.MAX_ROUTE_POINTS,
            "route_max_range_m": proto.ROUTE_MAX_RANGE_M,
            "lookahead_m": nav.LOOKAHEAD_M,
            "maneuver_window_m": nav.MANEUVER_WINDOW_M,
            "maneuver_min_deg": nav.MANEUVER_MIN_DEG,
            "map_radius_m": nav.MAP_RADIUS_M,
            "map_simplify_m": nav.MAP_SIMPLIFY_M,
            "map_max_points": nav.MAP_MAX_POINTS,
            "map_max_segments": nav.MAP_MAX_SEGMENTS,
            "map_refresh_s": nav.MAP_REFRESH_S,
            "map_refresh_move_m": nav.MAP_REFRESH_MOVE_M,
            "map_fail_cooldown_s": nav.MAP_FAIL_COOLDOWN_S,
            "map_cache_reuse_m": nav.MAP_CACHE_REUSE_M,
            "map_cache_max": nav.MAP_CACHE_MAX,
            "earth_m_per_deg_lat": nav.EARTH_M_PER_DEG_LAT,
            "earth_m_per_deg_lon_eq": nav.EARTH_M_PER_DEG_LON_EQ,
            "highway_rank": dict(nav.HIGHWAY_RANK),
            "highway_rank_keys": sorted(nav.HIGHWAY_RANK.keys()),
            "demo_route": [list(p) for p in nav.DEMO_ROUTE],
        },
    }

    # stdout 上只能有 JSON
    json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
