/*
 * NavPuck 手机端 **Python ↔ JS 行为对拍** 自测。
 *
 * phone/test/selftest.mjs 钉死的是"字节一模一样"；这里钉死的是"算出来的
 * 导航语义一模一样" —— 也就是 navigator.py 的 Route / 加密 / 路口识别 /
 * 整条路线抽稀 / NAV_UPDATE 各字段的计算结果，与 route.js + app.js 的移植版
 * 逐字段一致。
 *
 * 为什么非要有这个：
 *   只有字节对拍了，仍然可能出现"帧格式全对、但 next_turn_index 指到了
 *   错误的路口""rel_bearing 符号反了""视距换成米/分米差 10 倍"这类错误。
 *   这些在摩托车上表现为"箭头乱指""转弯提示迟到/早到"，现场几乎没法查，
 *   但在本机是可以彻底钉死的：**同一份输入喂给两个实现，比结果**。
 *
 * 怎么跑（在 navpuck 根目录）：
 *     node phone/test/parity.mjs
 *
 * 工作方式：
 *   1) 用 node 起一个子进程跑 python tools/navpuck_proto.py 无关的参考实现
 *      —— 见 phone/test/pyref.py，它 import navigator.py / navmath.py，
 *      对固定输入算出一组"应该长这样"的数值，以 JSON 打到 stdout。
 *   2) node 侧用 route.js / app.js 的同一套逻辑算同样的东西。
 *   3) 逐字段比对（浮点给 1e-9 相对容差）。
 *
 * 没有 python 时这个测试会跳过并明确说明（exit 0 但打印 SKIP），
 * 不会伪装成通过。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(PHONE_DIR, '..');

const P = require(path.join(PHONE_DIR, 'proto.js'));
const NM = require(path.join(PHONE_DIR, 'navmath.js'));
const RT = require(path.join(PHONE_DIR, 'route.js'));
// ---------------------------------------------------------------------------
// 测试框架
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let group = '';

function section(name) { group = name; console.log(`\n[${name}]`); }

function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failures.push(`${group} :: ${label}`); console.log(`  ✗ ${label}`); }
}

function near(actual, expected, label, tol) {
  const t = tol === undefined ? 1e-9 : tol;
  const a = Number(actual);
  const b = Number(expected);
  const scale = Math.max(1, Math.abs(b));
  const good = Number.isFinite(a) && Math.abs(a - b) <= t * scale;
  if (good) { passed += 1; console.log(`  ✓ ${label}  (${a})`); }
  else {
    failures.push(`${group} :: ${label}\n      期望 ${b}\n      实得 ${a}`);
    console.log(`  ✗ ${label}\n      期望 ${b}\n      实得 ${a}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed += 1; console.log(`  ✓ ${label}`); }
  else {
    failures.push(`${group} :: ${label}\n      期望 ${b}\n      实得 ${a}`);
    console.log(`  ✗ ${label}\n      期望 ${b}\n      实得 ${a}`);
  }
}

// ---------------------------------------------------------------------------
// 1) 跑 Python 参考实现
// ---------------------------------------------------------------------------
const PYREF = path.join(__dirname, 'pyref.py');
let REF = null;
let PY_VERSION = '';

{
  section('0] 启动 Python 参考实现');
  let py = null;
  for (const cand of ['python', 'python3', 'py']) {
    try {
      const v = execFileSync(cand, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      py = cand;
      PY_VERSION = (v || '').trim();
      break;
    } catch (_e) { /* 试下一个 */ }
  }
  if (py === null) {
    console.log('  ⚠ SKIP：本机没有 python / python3 / py，无法做 Python ↔ JS 对拍。');
    console.log('    这一步**没有**通过，只是无法执行 —— 请在有 Python 的机器上重跑。');
    console.log('    字节级一致性仍然由 phone/test/selftest.mjs 覆盖。');
    process.exit(0);
  }
  console.log(`  ✓ 找到解释器：${py}（${PY_VERSION}）`);
  try {
    // ⚠️ PYTHONIOENCODING=utf-8 是**必需的**，不是保险。
    //
    // Windows 上 Python 的 stdout 默认跟随控制台代码页（中文机器上是 cp936），
    // 而 Node 的 execFileSync 按 UTF-8 解码收到的字节 —— 于是路名这类中文
    // 直接变成乱码（"湖滨路" -> "\uFFFD\uFFFD\uFFFD\uFFFD\u00B7"），对拍会报出
    // 看起来像算法错误的假失败。强制两边都用 UTF-8，中文才能原样过管道。
    const out = execFileSync(py, [PYREF], {
      encoding: 'utf8',
      cwd: ROOT_DIR,
      maxBuffer: 32 * 1024 * 1024,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
    });
    REF = JSON.parse(out);
    console.log(`  ✓ pyref.py 输出 JSON（${out.length} 字节，UTF-8 管道）`);
  } catch (e) {
    console.log(`  ✗ pyref.py 执行失败：${e.message}`);
    if (e.stdout) console.log(`    stdout: ${String(e.stdout).slice(0, 2000)}`);
    if (e.stderr) console.log(`    stderr: ${String(e.stderr).slice(0, 2000)}`);
    failures.push('0] :: pyref.py 执行失败');
    REF = null;
  }
}

if (REF !== null) {
  // -------------------------------------------------------------------------
  section('1] navmath：一组固定算例逐位比对');
  // -------------------------------------------------------------------------
  {
    for (const c of REF.math) {
      let got;
      if (c.fn === 'wrap180') got = NM.wrap180(c.args[0]);
      else if (c.fn === 'wrap360') got = NM.wrap360(c.args[0]);
      else if (c.fn === 'shortest_delta') got = NM.shortest_delta(c.args[0], c.args[1]);
      else if (c.fn === 'bearing_deg') got = NM.bearing_deg(...c.args);
      else if (c.fn === 'distance_m') got = NM.distance_m(...c.args);
      else if (c.fn === 'approach_angle') got = NM.approach_angle(...c.args);
      else if (c.fn === 'map_clamp') got = NM.map_clamp(...c.args);
      else throw new Error(`未知算例 ${c.fn}`);
      // 要求**逐位相同**：这些函数是纯 IEEE754 运算，两边不该有任何差异
      if (Object.is(got, c.want)) {
        passed += 1;
        console.log(`  ✓ ${c.fn}(${c.args.map((x) => JSON.stringify(x)).join(', ')}) = ${got}`);
      } else if (Math.abs(got - c.want) <= 1e-12 * Math.max(1, Math.abs(c.want))) {
        passed += 1;
        console.log(`  ~ ${c.fn}(${c.args.join(', ')}) = ${got}（期望 ${c.want}，差 ${got - c.want}，在 1e-12 内）`);
      } else {
        failures.push(`1] :: ${c.fn}(${c.args.join(', ')}) 期望 ${c.want} 实得 ${got}`);
        console.log(`  ✗ ${c.fn}(${c.args.join(', ')}) 期望 ${c.want} 实得 ${got}`);
      }
    }
    ok(REF.math.length >= 40, `navmath 算例数量 ${REF.math.length} >= 40`);
  }

  // -------------------------------------------------------------------------
  section('2] Route：加密 / 弧长 / point_at / tangent / 路口识别');
  // -------------------------------------------------------------------------
  {
    const raw = REF.route_input.points;                  // [[lat,lon,name],...]
    const jsRoute = new RT.Route(raw, REF.route_input.closed, REF.route_input.max_spacing_m);

    near(jsRoute.total_m, REF.route.total_m, 'Route.total_m（总弧长）');
    eq(jsRoute.points.length, REF.route.points.length, 'Route.points 个数（加密后）');
    eq(jsRoute.maneuvers.length, REF.route.maneuvers.length, '识别出的转向点个数');
    eq(jsRoute.maneuvers.map((m) => m[0]), REF.route.maneuvers.map((m) => m[0]),
       '每个转向点的下标');
    eq(jsRoute.maneuvers.map((m) => m[2]), REF.route.maneuvers.map((m) => m[2]),
       '每个转向点的 Turn 分类');

    // 弧长逐点比对：加密算法只要差一个点，后面全歪
    let worst_cum = 0;
    for (let i = 0; i < jsRoute.points.length; i++) {
      worst_cum = Math.max(worst_cum, Math.abs(jsRoute.points[i].cum_m - REF.route.points[i].cum_m));
    }
    near(worst_cum, 0, '所有点的 cum_m 与 Python 的最大偏差（应为 0）', 1e-12);

    // point_at：沿整条路线均匀取 40 个位置
    let worst_pa = 0;
    for (let k = 0; k <= 40; k++) {
      const s = jsRoute.total_m * k / 40;
      const [la, lo, idx] = jsRoute.point_at(s);
      const r = REF.route.point_at[k];
      worst_pa = Math.max(worst_pa, Math.abs(la - r[0]), Math.abs(lo - r[1]));
      if (idx !== r[2]) {
        failures.push(`2] :: point_at(${s.toFixed(3)}) 段下标 ${idx} != ${r[2]}`);
        console.log(`  ✗ point_at(${s.toFixed(3)}) 段下标 ${idx} != ${r[2]}`);
      }
    }
    near(worst_pa, 0, '40 个采样点上 point_at() 经纬度的最大偏差', 1e-12);

    // tangent_deg
    let worst_tan = 0;
    for (let k = 0; k <= 40; k++) {
      const s = jsRoute.total_m * k / 40;
      const a = jsRoute.tangent_deg(s);
      const b = REF.route.tangent[k];
      // 角度用最短弧比较，避免 359.999 -> 0.001 被判成巨大误差
      worst_tan = Math.max(worst_tan, Math.abs(NM.shortest_delta(b, a)));
    }
    near(worst_tan, 0, '40 个采样点上 tangent_deg() 的最大角差（度）', 1e-9);

    // nearest_index / s_at_index
    let worst_near = 0;
    for (const [lat, lon] of REF.route.probe_points) {
      const i_js = jsRoute.nearest_index_full(lat, lon);
      const s_js = jsRoute.s_at_index(i_js);
      const i_py = REF.route.nearest_probe[REF.route.probe_points.indexOf(
        REF.route.probe_points.find((p) => p[0] === lat && p[1] === lon))];
      worst_near = Math.max(worst_near, Math.abs(s_js - i_py[1]));
      if (i_js !== i_py[0]) {
        failures.push(`2] :: nearest_index(${lat},${lon}) 下标 ${i_js} != ${i_py[0]}`);
        console.log(`  ✗ nearest_index(${lat},${lon}) 下标 ${i_js} != ${i_py[0]}`);
      }
    }
    near(worst_near, 0, 'nearest_index 探测点上的 s 偏差', 1e-9);

    // next_maneuver / road_name_at
    let nm_mismatch = 0;
    for (let k = 0; k <= 30; k++) {
      const s = jsRoute.total_m * k / 30;
      const a = jsRoute.next_maneuver(s);
      const b = REF.route.next_maneuver[k];
      if (a === null && b === null) continue;
      if (a === null || b === null) { nm_mismatch += 1; continue; }
      if (a[0] !== b[0] || a[2] !== b[2]) nm_mismatch += 1;
    }
    eq(nm_mismatch, 0, '30 个里程点上 next_maneuver() 的下标/Turn 全部一致');

    let rn_mismatch = 0;
    for (let k = 0; k <= 30; k++) {
      const s = jsRoute.total_m * k / 30;
      if (jsRoute.road_name_at(s) !== REF.route.road_name[k]) rn_mismatch += 1;
    }
    eq(rn_mismatch, 0, '30 个里程点上 road_name_at() 全部一致');
  }

  // -------------------------------------------------------------------------
  section('3] 滑动窗口（build_route_window）：60km 长路线整段骑行，逐点与 Python 相同');
  // -------------------------------------------------------------------------
  // 这一节是这一版的核心：路线不再整条下发，而是"前方 WINDOW_M 一段 + 走远了
  // 重锚"。窗口的坐标上界（i16 米）和点数上界（1024）**只由 WINDOW_M / STEP_M
  // 决定**，跟路线总长无关 —— 所以必须拿一条比 ±32.7km 还长的路线来跑：
  // 60km 在旧实现里是直接 SystemExit 的。
  {
    const inp = REF.ride_input;
    const jsRoute = new RT.Route(inp.points, inp.closed, inp.max_spacing_m);
    const step_m = inp.speed_mps * inp.dt_s;

    near(jsRoute.total_m, REF.ride.total_m, '60km 路线的总弧长与 Python 相同');
    ok(jsRoute.total_m > 32767,
       `路线 ${(jsRoute.total_m / 1000).toFixed(1)}km 超过 ±32.7km（旧实现会拒收）`);

    // 与 pyref 逐帧相同的骑行循环：只调**共享的那两个函数**
    const windows = [];
    let s = 0.0;
    let origin_s = 0.0;
    let window_end = 0.0;
    let sent = false;
    let k = 0;
    while (s < jsRoute.total_m && k < inp.frames) {
      const [lat, lon] = jsRoute.point_at(s);
      if (!sent || RT.window_needs_reanchor(s, origin_s, window_end, jsRoute.total_m)) {
        const w = RT.build_route_window(jsRoute, s, lat, lon);
        window_end = w.end_s;
        origin_s = s;
        sent = true;
        let span_m = 0;
        for (const [e, n] of w.pts) span_m = Math.max(span_m, Math.abs(e), Math.abs(n));
        windows.push({
          s_m: s, origin_s: origin_s, end_s: window_end,
          n: w.pts.length, span_m: span_m,
          first: w.pts[0], last: w.pts[w.pts.length - 1], pts: w.pts,
        });
      }
      s += step_m;
      k += 1;
    }

    eq(windows.length, REF.ride.windows.length,
       `整段骑行重锚 ${windows.length} 次（与 Python 相同）`);
    eq(k, REF.ride.frames, '骑行的帧数与 Python 相同（s 的浮点累加逐帧一致）');

    let bad = [];
    for (let i = 0; i < Math.min(windows.length, REF.ride.windows.length); i++) {
      const a = windows[i];
      const b = REF.ride.windows[i];
      // end_s 只在"路线终点把窗口截断"的那两窗上出现 1 ULP 的差：两个实现的
      // Route 累加弧长时最后一位不同（total_m 差 1 ULP，见上面的 near()）。
      // 那个差值 ≈ 5e-11 m，对任何下标/坐标都没有影响 —— 用容差比，别用相等。
      if (a.n !== b.n || a.span_m !== b.span_m ||
          Math.abs(a.origin_s - b.origin_s) > 1e-6 ||
          Math.abs(a.end_s - b.end_s) > 1e-6 ||
          a.first[0] !== b.first[0] || a.first[1] !== b.first[1] ||
          a.last[0] !== b.last[0] || a.last[1] !== b.last[1]) {
        bad.push(`窗口#${i}: JS(n=${a.n},span=${a.span_m},o=${a.origin_s},e=${a.end_s}) ` +
                 `PY(n=${b.n},span=${b.span_m},o=${b.origin_s},e=${b.end_s})`);
      }
      let mism = 0;
      for (let j = 0; j < Math.min(a.pts.length, b.pts.length); j++) {
        if (a.pts[j][0] !== b.pts[j][0] || a.pts[j][1] !== b.pts[j][1]) mism += 1;
      }
      if (mism > 0) bad.push(`窗口#${i}: ${mism}/${a.n} 个点与 Python 不同`);
    }
    ok(bad.length === 0,
       `${windows.reduce((a, w) => a + w.n, 0)} 个窗口点逐点与 Python 相同`);
    for (const m of bad.slice(0, 8)) console.log(`      ${m}`);

    // ---- 两条上界（对 Python 与 JS 的输出都成立）----
    const all_windows = windows.concat(REF.ride.windows);
    const max_n = Math.max(...all_windows.map((w) => w.n));
    const max_span = Math.max(...all_windows.map((w) => w.span_m));
    ok(max_n <= P.MAX_ROUTE_POINTS,
       `窗口点数最大 ${max_n} <= 设备上限 ${P.MAX_ROUTE_POINTS}`);
    ok(max_span <= P.ROUTE_MAX_RANGE_M,
       `窗口里最远的坐标 ${max_span}m <= i16 米上限 ${P.ROUTE_MAX_RANGE_M}m`);
    ok(max_span <= RT.WINDOW_M + 200,
       `最远坐标 ${max_span}m 落在 WINDOW_M(${RT.WINDOW_M}) + 200m 之内`);

    // 固定点距：窗口内相邻点的间距必须恒等于 STEP_M（只有最后一段可以短一点）
    let gap_bad = 0;
    let gap_min = Infinity;
    for (const w of windows) {
      for (let j = 0; j + 1 < w.pts.length; j++) {
        const d = Math.hypot(w.pts[j + 1][0] - w.pts[j][0],
                             w.pts[j + 1][1] - w.pts[j][1]);
        if (j + 2 < w.pts.length) {
          // 不是最后一段：必须就是 STEP_M（±1m 是整数取整的量化误差）
          if (Math.abs(d - RT.STEP_M) > 1.0) gap_bad += 1;
          gap_min = Math.min(gap_min, d);
        } else if (d > RT.STEP_M + 1.0) {
          gap_bad += 1;
        }
      }
    }
    eq(gap_bad, 0, `窗口内点距恒为 STEP_M = ${RT.STEP_M}m（最小实测 ${gap_min.toFixed(1)}m）`);
    ok(gap_min >= RT.STEP_M - 1.0,
       `点距没有塌陷（最小 ${gap_min.toFixed(1)}m）—— 160m 视野里稳定 16 个点`);

    // 重锚的节奏：每个新原点的弧长差必须超过 REANCHOR_MOVE_M
    // （"走远了"那条判据先触发；窗口比路线短时才轮到"窗口末端快到了"）
    let spacing_bad = 0;
    for (let i = 1; i < windows.length; i++) {
      const d = windows[i].origin_s - windows[i - 1].origin_s;
      if (!(d > RT.REANCHOR_MOVE_M)) spacing_bad += 1;
    }
    eq(spacing_bad, 0, `每 ${RT.REANCHOR_MOVE_M}m 才重锚一次（13 次重锚都不更密）`);

    // ---- 纯函数：两条重锚判据本身 ----
    const T = 60000.0;
    eq(RT.window_needs_reanchor(1000, 0, 10000, T), false,
       '刚发过、还没走远 -> 不重锚');
    eq(RT.window_needs_reanchor(5100, 0, 10000, T), true,
       '离开原点超过 REANCHOR_MOVE_M -> 重锚');
    eq(RT.window_needs_reanchor(9500, 0, 10000, T), true,
       '窗口末端快到了（末端 10000、骑手 9500）而路还长 -> 重锚');
    eq(RT.window_needs_reanchor(9500, 9500, T, T), false,
       '这一窗已经画到路线终点 -> 不需要重锚（前方没有没发的路了）');
    eq(windows[windows.length - 1].end_s, jsRoute.total_m,
       '最后一窗正好画到路线终点（骑手不会骑出画出来的线）');
  }

  // -------------------------------------------------------------------------
  section('4] NAV_UPDATE 各字段：与 Python 在同一里程点上逐字段比对');
  // -------------------------------------------------------------------------
  {
    const raw = REF.update_input.points;
    const jsRoute = new RT.Route(raw, REF.update_input.closed, REF.update_input.max_spacing_m);
    // 原点 = 第一帧骑手的位置（navigator.py 与 app.js 都是"发这一窗时定原点"）。
    // 窗口本身走共享的 build_route_window()，不在这里重写。
    const [olat, olon] = REF.update_window.origin;
    const cos0 = Math.cos(olat * NM.DEG2RAD);
    const total = jsRoute.total_m;
    const f0 = REF.update_input.fixes[0];
    const i0 = jsRoute.nearest_index_full(f0[0], f0[1]);
    const s0 = jsRoute.s_at_index(i0);
    const win = RT.build_route_window(jsRoute, s0, olat, olon);
    const win_pts = win.pts;
    const origin_s = Math.max(0.0, Math.min(s0, total));
    const window_end_s = win.end_s;
    eq(win_pts.length, REF.update_window.n, '这一窗的点数与 Python 相同');
    eq(window_end_s, REF.update_window.end_s, '这一窗的末端里程与 Python 相同');
    eq(origin_s, REF.update_window.origin_s, '这一窗的原点里程与 Python 相同');

    const to_local = (lat, lon) => [
      (lon - olon) * RT.EARTH_M_PER_DEG_LON_EQ * cos0,
      (lat - olat) * RT.EARTH_M_PER_DEG_LAT,
    ];

    // 用 Python 侧的固定 fix 序列，一帧一帧复算 cycle() 的数学部分
    let idx_hint = 0;
    let last_road = '';
    let mismatches = [];
    for (let fi = 0; fi < REF.updates.length; fi++) {
      const ref = REF.updates[fi];
      const [lat, lon, heading, speed_mps] = REF.update_input.fixes[fi];

      // 与 app.js 的首帧全表搜索一致
      idx_hint = jsRoute.nearest_index_full(lat, lon);
      const s = jsRoute.s_at_index(idx_hint);

      const look_s = Math.min(s + RT.LOOKAHEAD_M, total);
      const [llat, llon] = jsRoute.point_at(look_s);
      const bearing_to_look = NM.bearing_deg(lat, lon, llat, llon);

      let turn, road, dist_next, abs_bearing;
      const nxt = jsRoute.next_maneuver(s);
      if (nxt !== null) {
        const [_mi, ms, t, r] = nxt;
        const [mlat, mlon] = jsRoute.point_at(ms);
        dist_next = NM.distance_m(lat, lon, mlat, mlon);
        abs_bearing = NM.bearing_deg(lat, lon, mlat, mlon);
        turn = t; road = r;
      } else {
        turn = P.Turn.ARRIVE;
        road = jsRoute.road_name_at(s);
        dist_next = total - s;
        abs_bearing = bearing_to_look;
      }
      if (total - s < 30.0) { turn = P.Turn.ARRIVE; dist_next = Math.max(0.0, total - s); }

      const rel = NM.shortest_delta(heading, bearing_to_look);
      const want_view_m = RT.ROUTE_FAR_M;
      const [pe, pn] = to_local(lat, lon);

      // next_turn_index：**窗口内**的下标（与 Navigator.turn_index_of 一致）
      let nti = P.NO_TURN;
      if (nxt !== null && win_pts.length >= 2) {
        const ms = jsRoute.points[nxt[0]].cum_m;
        if (ms <= window_end_s + 0.5) {
          const idx = NM.pyround((ms - origin_s) / RT.STEP_M);
          nti = Math.max(0, Math.min(win_pts.length - 1, idx));
        }
      }

      // ⚠️ 取整函数**逐字段**照抄 navigator.py 第 998~1015 行：
      //    角度类 int(round(x)) -> NM.pyround；距离/速度/ETA/进度 int(x) -> NM.pyint。
      //    下面 section 4b 会直接从 app.js 的源码里核对这件事，防止这里和
      //    真正的下发代码各改一半、结果测试自己通过。
      const got = {
        rel_bearing_cdeg: NM.pyround(rel * 100),
        abs_bearing_cdeg: NM.pyround(NM.wrap360(abs_bearing) * 100) % 36000,
        dist_next_cm: Math.min(NM.pyint(dist_next * 100), 0xFFFFFFFF),
        dist_dest_m: NM.pyint(Math.max(0.0, total - s)),
        speed_kmh_x10: Math.min(NM.pyint(speed_mps * 3.6 * 10), 65535),
        eta_min: Math.min(NM.pyint((total - s) / Math.max(speed_mps, 0.5) / 60.0), 65535),
        turn: turn,
        progress_pct: NM.pyint(Math.max(0, Math.min(100, s * 100.0 / Math.max(total, 1.0)))),
        heading_cdeg: NM.pyround(NM.wrap360(heading) * 100) % 36000,
        pos_east_m: NM.pyround(pe),
        pos_north_m: NM.pyround(pn),
        next_turn_index: nti,
        view_range_dm: NM.pyround(want_view_m * 10),
        road_name: road || '',
      };

      for (const k of Object.keys(got)) {
        if (got[k] !== ref[k]) {
          mismatches.push(`fix#${fi}.${k}: JS=${got[k]} PY=${ref[k]}`);
        }
      }
      last_road = road || last_road;
    }

    ok(mismatches.length === 0,
       `${REF.updates.length} 个里程点上 NAV_UPDATE 的 14 个字段全部与 Python 相同`);
    if (mismatches.length > 0) {
      for (const m of mismatches.slice(0, 25)) console.log(`      ${m}`);
    }

    // ---- 4b) 防漂移：parity.mjs 的算术必须与 app.js 的真实代码一致 ----
    //
    // 上面那 14 行是"照抄" app.js 的。如果以后有人只改了 app.js（或只改了
    // 这里），这个测试会自己通过、却测不到真正的下发代码。所以直接把
    // app.js 的 NavUpdate 构造代码抽出来比：逐字段核对取整函数。
    const app_src = fs.readFileSync(path.join(PHONE_DIR, 'app.js'), 'utf8');
    const ctor = app_src.indexOf('new proto.NavUpdate({');
    const ctor_end = app_src.indexOf('});', ctor);
    const navupdate_src = ctor >= 0 ? app_src.slice(ctor, ctor_end) : '';
    ok(navupdate_src.length > 0, '能在 app.js 里定位 NavUpdate 的构造代码');
    // 每个字段该用哪个取整函数 —— 这张表就是 navigator.py 第 998~1015 行的翻译
    const ROUNDED_FIELDS = {
      rel_bearing_cdeg: 'pyround', abs_bearing_cdeg: 'pyround',
      heading_cdeg: 'pyround', pos_east_m: 'pyround',
      pos_north_m: 'pyround', view_range_dm: 'pyround',
      dist_next_cm: 'pyint', dist_dest_m: 'pyint',
      speed_kmh_x10: 'pyint', eta_min: 'pyint', progress_pct: 'pyint',
    };
    let drift = [];
    for (const [f, want] of Object.entries(ROUNDED_FIELDS)) {
      const m = navupdate_src.match(new RegExp(`${f}\\s*:([^,\\n]*(?:\\([^)]*\\))?[^,\\n]*)`));
      if (!m) { drift.push(`${f}: app.js 里找不到这个字段`); continue; }
      const wrong = want === 'pyround' ? 'pyint' : 'pyround';
      if (!m[1].includes(`nm.${want}(`)) {
        drift.push(`${f}: app.js 应使用 nm.${want}()，实得 ${m[1].trim()}`);
      }
      if (m[1].includes(`nm.${wrong}(`)) {
        drift.push(`${f}: app.js 误用了 nm.${wrong}()`);
      }
      if (m[1].includes('Math.round')) drift.push(`${f}: app.js 仍在用 Math.round`);
    }
    ok(drift.length === 0,
       `app.js 里 ${Object.keys(ROUNDED_FIELDS).length} 个字段的取整函数与 navigator.py 逐字段一致`);
    for (const d of drift) console.log(`      ${d}`);
    // next_turn_index 走的是 turn_index_of()，也要确认它用了 pyround
    const tio = app_src.indexOf('turn_index_of(s)');
    const tio_body = app_src.slice(app_src.indexOf('turn_index_of(s) {'),
                                   app_src.indexOf('turn_index_of(s) {') + 500);
    ok(!tio_body.includes('Math.round'), 'app.js 的 turn_index_of() 也不用 Math.round');
    ok(tio >= 0, 'app.js 里 next_turn_index 来自 turn_index_of(s)');
    // 防漂移：窗口内下标 = (路口弧长 − 原点弧长) / STEP_M，两个常量必须来自
    // route.js 的共享常量，不能在 app.js 里另写一份（那就会和 navigator.py 分叉）。
    ok(tio_body.includes('rt.STEP_M') && tio_body.includes('this.origin_s') &&
       tio_body.includes('this.window_end_s'),
       'app.js 的 turn_index_of() 用的是 rt.STEP_M / origin_s / window_end_s');
    // app.js 里不得再有裸 Math.round —— 它出现在任何"镜像 Python round()"的位置都是 bug
    const stray_rounds = (app_src.match(/Math\.round\(/g) || []).length;
    eq(stray_rounds, 0, 'app.js 里没有任何裸 Math.round（全部走 NM.pyround）');
    const map_src = fs.readFileSync(path.join(PHONE_DIR, 'map.js'), 'utf8');
    eq((map_src.match(/Math\.round\(/g) || []).length, 0,
       'map.js 里没有任何裸 Math.round（底图坐标全部走 NM.pyround）');

    // 抽几个关键字段单独打印，让人肉眼也能确认
    const r0 = REF.updates[0];
    console.log(`      首帧参考值：rel=${r0.rel_bearing_cdeg} abs=${r0.abs_bearing_cdeg} ` +
                `dist_next=${r0.dist_next_cm}cm dest=${r0.dist_dest_m}m turn=${P.turn_name(r0.turn)} ` +
                `heading=${r0.heading_cdeg} pos=(${r0.pos_east_m},${r0.pos_north_m}) ` +
                `nti=${r0.next_turn_index === 0xFFFF ? 'NO_TURN' : r0.next_turn_index} ` +
                `view=${r0.view_range_dm}dm`);
  }

  // -------------------------------------------------------------------------
  section('5] 视野固定 & 不变量');
  // -------------------------------------------------------------------------
  {
    eq(REF.invariants.route_far_m, RT.ROUTE_FAR_M, 'ROUTE_FAR_M 两边相同（视野不是自适应的）');
    eq(REF.invariants.route_resend_period_s, RT.ROUTE_RESEND_PERIOD_S,
       'ROUTE_RESEND_PERIOD_S = 30（当前窗口定期兜底重发）');
    eq(REF.invariants.window_m, RT.WINDOW_M, 'WINDOW_M 两边相同（10km 窗口）');
    eq(REF.invariants.step_m, RT.STEP_M, 'STEP_M 两边相同（固定 10m 点距）');
    eq(REF.invariants.reanchor_move_m, RT.REANCHOR_MOVE_M,
       'REANCHOR_MOVE_M 两边相同（走 5km 重锚）');
    eq(REF.invariants.reanchor_tail_m, RT.REANCHOR_TAIL_M,
       'REANCHOR_TAIL_M 两边相同（窗口末端保险）');
    eq(REF.invariants.max_route_points, P.MAX_ROUTE_POINTS,
       '设备端路线点数上限 1024 与 proto.js 相同');
    eq(REF.invariants.route_max_range_m, P.ROUTE_MAX_RANGE_M,
       'i16 米上限 32767 与 proto.js 相同');
    // 两条上界必须是**算出来**安全的，不是碰巧：窗口点数 = WINDOW_M/STEP_M + 1
    ok(RT.WINDOW_M / RT.STEP_M + 1 <= P.MAX_ROUTE_POINTS,
       `窗口点数上界 ${RT.WINDOW_M / RT.STEP_M + 1} <= ${P.MAX_ROUTE_POINTS}`);
    ok(RT.WINDOW_M < P.ROUTE_MAX_RANGE_M,
       `窗口长度 ${RT.WINDOW_M}m 远小于 i16 米上限 ${P.ROUTE_MAX_RANGE_M}m`);
    ok(RT.REANCHOR_MOVE_M * 2 <= RT.WINDOW_M,
       `重锚阈值 ${RT.REANCHOR_MOVE_M}m = 半个窗口，重锚时线尾还剩 ` +
       `${RT.WINDOW_M - RT.REANCHOR_MOVE_M}m`);
    eq(REF.invariants.lookahead_m, RT.LOOKAHEAD_M, 'LOOKAHEAD_M = 180');
    eq(REF.invariants.maneuver_window_m, RT.MANEUVER_WINDOW_M, 'MANEUVER_WINDOW_M = 35');
    eq(REF.invariants.maneuver_min_deg, RT.MANEUVER_MIN_DEG, 'MANEUVER_MIN_DEG = 25');
    eq(REF.invariants.map_radius_m, RT.MAP_RADIUS_M, 'MAP_RADIUS_M = 260');
    eq(REF.invariants.map_simplify_m, RT.MAP_SIMPLIFY_M, 'MAP_SIMPLIFY_M = 7');
    eq(REF.invariants.map_max_points, RT.MAP_MAX_POINTS, 'MAP_MAX_POINTS = 330');
    eq(REF.invariants.map_max_segments, RT.MAP_MAX_SEGMENTS, 'MAP_MAX_SEGMENTS = 60');
    eq(REF.invariants.map_refresh_s, RT.MAP_REFRESH_S, 'MAP_REFRESH_S = 40');
    eq(REF.invariants.map_refresh_move_m, RT.MAP_REFRESH_MOVE_M, 'MAP_REFRESH_MOVE_M = 80');
    eq(REF.invariants.map_fail_cooldown_s, RT.MAP_FAIL_COOLDOWN_S, 'MAP_FAIL_COOLDOWN_S = 60');
    eq(REF.invariants.map_cache_reuse_m, RT.MAP_CACHE_REUSE_M, 'MAP_CACHE_REUSE_M = 180');
    eq(REF.invariants.map_cache_max, RT.MAP_CACHE_MAX, 'MAP_CACHE_MAX = 60');
    eq(REF.invariants.earth_m_per_deg_lat, RT.EARTH_M_PER_DEG_LAT,
       'EARTH_M_PER_DEG_LAT 与 Python 相同');
    eq(REF.invariants.earth_m_per_deg_lon_eq, RT.EARTH_M_PER_DEG_LON_EQ,
       'EARTH_M_PER_DEG_LON_EQ 与 Python 相同');
    eq(Object.keys(RT.HIGHWAY_RANK).sort(), REF.invariants.highway_rank_keys.sort(),
       'HIGHWAY_RANK 的道路等级集合与 Python 相同');
    for (const k of Object.keys(REF.invariants.highway_rank)) {
      if (RT.HIGHWAY_RANK[k] !== REF.invariants.highway_rank[k]) {
        failures.push(`5] :: HIGHWAY_RANK["${k}"] JS=${RT.HIGHWAY_RANK[k]} PY=${REF.invariants.highway_rank[k]}`);
      }
    }
    ok(true, 'HIGHWAY_RANK 的每个等级数值都与 Python 相同');

    // _densify 单独对拍
    const dens = RT._densify(REF.densify_input.in, REF.densify_input.max_spacing_m);
    eq(dens.length, REF.densify_output.length, '_densify 输出点数与 Python 相同');
    let dmis = 0;
    for (let i = 0; i < Math.min(dens.length, REF.densify_output.length); i++) {
      if (Math.abs(dens[i][0] - REF.densify_output[i][0]) > 1e-15 ||
          Math.abs(dens[i][1] - REF.densify_output[i][1]) > 1e-15) dmis += 1;
    }
    eq(dmis, 0, '_densify 每个插值点坐标与 Python 相同');

    // 内置演示航线必须与 Python 的 DEMO_ROUTE 完全一致
    eq(RT.DEMO_ROUTE.map((p) => [p[0], p[1]]), REF.invariants.demo_route.map((p) => [p[0], p[1]]),
       'DEMO_ROUTE 的 10 个坐标与 navigator.py 相同');
    eq(RT.DEMO_ROUTE.map((p) => p[2]), REF.invariants.demo_route.map((p) => p[2]),
       'DEMO_ROUTE 的路名与 navigator.py 相同');
  }

  // -------------------------------------------------------------------------
  section('6] 街道路网投影（OsmMapSource.build）');
  // -------------------------------------------------------------------------
  {
    const MapMod = require(path.join(PHONE_DIR, 'map.js'));
    const b = REF.build_case;
    const src = new MapMod.OsmMapSource({
      storage: null,                      // 不用缓存，直接喂 ways
      fetch: null,
      max_points: b.max_points,
      max_segs: b.max_segs,
      radius_m: b.radius_m,
    });
    // 直接注入 Python 侧抓到的 ways（绕过网络）
    src.ways = b.ways.map(([r, g]) => [r, g.map(([a, c]) => [a, c])]);

    const m = src.build(b.origin_lat, b.origin_lon, b.lat, b.lon, b.view_m);
    eq(m.seg_count, b.out_seg_count, '底图段数与 Python 相同');
    eq(m.total_pts, b.out_total_pts, '底图点数与 Python 相同');
    eq(m.seg_pts, b.out_seg_pts, '每段点数与 Python 相同');
    eq(m.pts.length, b.out_pts.length, '点数组长度与 Python 相同');
    let pmis = 0;
    for (let i = 0; i < Math.min(m.pts.length, b.out_pts.length); i++) {
      if (m.pts[i][0] !== b.out_pts[i][0] || m.pts[i][1] !== b.out_pts[i][1]) pmis += 1;
    }
    eq(pmis, 0, `底图 ${m.pts.length} 个 (east_m, north_m) 与 Python **逐点相同**`);

    // 底图帧必须装得进一帧（那个 400 比 1536 大的坑）
    if (m.seg_count > 0) {
      const frame = P.encode_nav_map(m);
      ok(frame.length <= 8 + P.MAX_PAYLOAD,
         `底图帧 ${frame.length} 字节在协议上限（8 + 1536 = 1544）之内`);
      // 与 Python 的帧逐字节比对
      eq(P._hex(frame), b.out_frame_hex, '底图帧与 Python **逐字节相同**');
    }

    // Overpass 的 remark 检查（限流时是 200 + remark，必须判成失败）
    const src2 = new MapMod.OsmMapSource({ storage: null, endpoints: ['https://x/'] });
    const parsed = MapMod.OsmMapSource._parse_ways({
      elements: [
        { tags: { highway: 'primary' }, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
        { tags: { highway: 'footway' }, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
        { tags: { highway: 'residential' }, geometry: [{ lat: 1, lon: 1 }] },
        { tags: {}, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
      ],
    });
    eq(parsed.length, 1, '_parse_ways 只保留认识的 highway 等级且至少 2 个点');
    eq(parsed[0][0], RT.HIGHWAY_RANK.primary, '_parse_ways 保留了 primary 的 rank');
    ok(RT.HIGHWAY_RANK.footway === undefined, 'footway 不在表里（摩托车不画人行道）');
  }

  // -------------------------------------------------------------------------
  section('7] OSRM 响应解析（用固定的假响应，不联网）');
  // -------------------------------------------------------------------------
  {
    const osrm = REF.osrm_case;
    // 造一个最小的 OSRM 响应
    const fakeResp = {
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{
          distance: osrm.distance_m,
          duration: osrm.duration_s,
          geometry: { coordinates: osrm.coords_lonlat },
        }],
      }),
    };
    const fakeFetch = async (url) => { osrm.last_url = url; return fakeResp; };

    const res = await RT.load_osrm(
      osrm.waypoints,
      osrm.profile,
      { fetch: fakeFetch, endpoint: RT.OSRM_ENDPOINT });
    eq(res.raw.distance_m, osrm.distance_m, 'OSRM distance 透传');
    eq(res.raw.duration_s, osrm.duration_s, 'OSRM duration 透传');
    eq(res.route.points.length, osrm.expected_point_count,
       `解析出的折线点数与 Python 相同（${osrm.expected_point_count}）`);
    near(res.route.total_m, osrm.expected_total_m, 'OSRM 折线的总弧长与 Python 相同');
    eq(res.route.maneuvers.length, osrm.expected_maneuver_count,
       'OSRM 折线上识别出的转向点个数与 Python 相同');
    eq(RT.load_osrm.length >= 2, true, 'load_osrm 至少接受 waypoints + profile');
    // URL 形状：OSRM 的坐标是 lon,lat（不是 lat,lon）—— 反了会静默规划到地球另一边
    ok(/\/route\/v1\/driving\/-?\d+\.\d+,-?\d+\.\d+;-?\d+\.\d+,-?\d+\.\d+\?/.test(osrm.last_url),
       `OSRM 请求 URL 是 lon,lat 顺序：${osrm.last_url.slice(0, 110)}…`);
    ok(osrm.last_url.includes('overview=full') && osrm.last_url.includes('geometries=geojson'),
       'OSRM 请求带上 overview=full 与 geometries=geojson');

    // 途经点命名要贴到最近的折线点上
    const named = res.route.points.filter((p) => p.name);
    ok(named.length === 2, `两个命名途经点都贴上了路名（实得 ${named.length}）`);
    eq(named.map((p) => p.name).sort(), ['终点', '起点'].sort(), '路名分别是 起点 / 终点');
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(62));
if (REF === null) {
  console.log('  Python 参考实现不可用 —— 对拍未能执行（不是通过）');
  console.log('='.repeat(62));
  process.exit(failures.length === 0 ? 0 : 1);
}
if (failures.length === 0) {
  console.log(`  Python ↔ JS 行为对拍通过：${passed} 项全部一致`);
  console.log('='.repeat(62));
  process.exit(0);
} else {
  console.log(`  ${passed} 项一致 / ${failures.length} 项不一致`);
  console.log('='.repeat(62));
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
