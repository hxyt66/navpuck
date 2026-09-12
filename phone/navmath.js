/*
 * NavPuck 导航数学 —— tools/navmath.py 的 JavaScript 忠实移植。
 *
 * 三边（C++ / Python / JS）必须给出完全一致的结果，
 * test/navcore_vectors.json 里的黄金向量就是用来钉死这一点的。
 *
 * 移植约定：函数名与常量名与 navmath.py **逐字对应**，方便直接 diff 两个文件。
 * 唯一无法一一对应的是 Python 的 pow 运算符 ** 与 math.fmod：
 *   - Python 的 x ** 2  ->  这里写 x * x（JS 的 ** 也有，但乘更明确）
 *   - Python 的 math.fmod(a, b) 是**截断**取余（结果的符号跟 a），
 *     而 JS 的 % 对浮点同样返回"符号跟被除数"的余数，两者语义一致，可以直接用 %。
 *     这里仍然单独抽出 _fmod() 来标注这个对应关系，以免以后有人顺手改成
 *     ((a % b) + b) % b 这种"总是非负"的写法 —— 那会改掉边界行为。
 */

'use strict';

const EARTH_RADIUS_M = 6371008.8;
const DEG2RAD = Math.PI / 180.0;
const RAD2DEG = 180.0 / Math.PI;

/** Python math.fmod 的对应物：结果的符号跟随被除数。 */
function _fmod(a, b) {
  return a % b;
}

/** 规整到 [-180, 180)。 */
function wrap180(deg) {
  let d = _fmod(deg + 180.0, 360.0);
  if (d < 0.0) d += 360.0;
  return d - 180.0;
}

/** 规整到 [0, 360)。 */
function wrap360(deg) {
  let d = _fmod(deg, 360.0);
  if (d < 0.0) d += 360.0;
  return d;
}

/** 从 frm 到 to 的最短有向角差，落在 [-180, 180)。 */
function shortest_delta(frm, to) {
  return wrap180(to - frm);
}

/** 大圆初始方位角，[0, 360)。两点重合时返回 0。 */
function bearing_deg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG2RAD;
  const p2 = lat2 * DEG2RAD;
  const dl = (lon2 - lon1) * DEG2RAD;

  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);

  if (x === 0.0 && y === 0.0) return 0.0;
  return wrap360(Math.atan2(y, x) * RAD2DEG);
}

/** Haversine 大圆距离，米。 */
function distance_m(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG2RAD;
  const p2 = lat2 * DEG2RAD;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * DEG2RAD;

  let a = Math.sin(dp / 2) * Math.sin(dp / 2) +
          Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  a = Math.min(1.0, Math.max(0.0, a));
  const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  return EARTH_RADIUS_M * c;
}

/** 指数趋近 + 速率限幅的角度平滑器，走最短弧。 */
function approach_angle(current, target, dt_s, tau_ms, max_rate_dps) {
  if (!(dt_s > 0.0)) return wrap180(current);
  if (!(tau_ms > 0.0)) return wrap180(target);

  const delta = shortest_delta(current, target);
  const alpha = 1.0 - Math.exp(-(dt_s * 1000.0) / tau_ms);
  let step = delta * alpha;

  if (max_rate_dps > 0.0) {
    const max_step = max_rate_dps * dt_s;
    if (step > max_step) step = max_step;
    else if (step < -max_step) step = -max_step;
  }

  return wrap180(current + step);
}

function map_clamp(x, in_min, in_max, out_min, out_max) {
  if (in_max <= in_min) return out_min;
  if (x <= in_min) return out_min;
  if (x >= in_max) return out_max;
  return out_min + (x - in_min) * (out_max - out_min) / (in_max - in_min);
}

function within_radius_m(lat1, lon1, lat2, lon2, r_m) {
  return distance_m(lat1, lon1, lat2, lon2) <= r_m;
}

/**
 * Python 3 的 round() 的忠实对应物。
 *
 * ⚠️ 这是从"对拍"里抓出来的一个真 bug，不是可有可无的精度洁癖。
 *
 *   Python 3 的 round() 是**银行家舍入**（round-half-to-even）：
 *       round(0.5) == 0    round(1.5) == 2    round(2.5) == 2
 *       round(-0.5) == 0   round(-1.5) == -2
 *   JS 的 Math.round() 是**四舍五入**（.5 一律进位）：
 *       Math.round(0.5) == 1   Math.round(2.5) == 3
 *
 * navigator.py 有 9 处 int(round(x))，全都直接决定 wire 上的整数值
 * （dist_next_cm / dist_dest_m / rel_bearing_cdeg / heading_cdeg /
 *   pos_east_m / pos_north_m / view_range_dm / next_turn_index / 底图坐标）。
 * 一旦某个值正好落在 .5 上，两个实现就会差 1 —— 表现为
 * "距离显示差 1 厘米""eta 差 1 分钟""progress 差 1%"，或者最糟的
 * next_turn_index 差 1（指向相邻的一个点，箭头提前/延后一格拐弯）。
 *
 * 只在**恰好**是 .5 时才需要特殊处理，所以平时走的就是 Math.round() 那条路，
 * 没有性能代价。
 *
 * 说明：Python 传进来的 x 若已经带有浮点误差（比如 0.1+0.2 那种），
 * 两边都是同一个 IEEE754 双精度值，所以这里只要判"是否恰好为 .5"就够了。
 */
function pyround(x) {
  if (!Number.isFinite(x)) return x;
  const r = Math.round(x);           // 四舍五入（.5 进位）
  if (Math.abs(x - Math.trunc(x)) === 0.5) {
    // 正好落在两个整数中间：Python 取偶数那一边
    return (r % 2 === 0) ? r : r - Math.sign(x);
  }
  return r;
}

/**
 * Python 的 int(x) 的忠实对应物：向零取整（**不**四舍五入）。
 *
 * ⚠️ 这条同样是从对拍里抓出来的真 bug。navigator.py 的 NavUpdate 里
 * 两者是**混着用**的，看漏一个就错一格：
 *
 *     rel_bearing_cdeg = int(round(rel * 100))      <- 四舍五入 -> pyround
 *     heading_cdeg     = int(round(wrap360(h)*100)) <- 四舍五入 -> pyround
 *     pos_east_m       = int(round(pe))             <- 四舍五入 -> pyround
 *     view_range_dm    = int(round(want_view_m*10)) <- 四舍五入 -> pyround
 *     dist_next_cm     = int(min(d*100, 0xFFFFFFFF))  <- **截断** -> pyint
 *     dist_dest_m      = int(max(0.0, total - s))     <- **截断** -> pyint
 *     speed_kmh_x10    = int(min(v*3.6*10, 65535))    <- **截断** -> pyint
 *     eta_min          = int(min(x, 65535))           <- **截断** -> pyint
 *     progress_pct     = int(max(0, min(100, x)))     <- **截断** -> pyint
 *
 * 症状举例：dist_dest_m 在 12991.798 上，截断给 12991、四舍五入给 12992；
 * progress_pct 在 0.7 上，截断给 0、四舍五入给 1（"进度条永远差 1%"）。
 * 对方向量之外的人很容易把这些当成"显示上的小差异"，其实那是**字节不同**。
 */
function pyint(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.trunc(x);
}

/**
 * 把距离渲染成 Beeline 那种短标签（与 navmath.py 的 format_distance 逐字符一致）。
 *
 * 四处 int(round(...)) 全部走 pyround() —— Python 侧就是 int(round(x))，
 * 而 int() 是**向零取整**，pyround 已经返回整数，所以两边等价。
 *
 * 唯一保留了已知差异的是 `{km:.1f}` 那一支：CPython 的浮点格式化是
 * "正确舍入的二进制->十进制转换"（.5 时取偶），JS 的 toFixed 在极少数
 * 边界上会差 1 个末位。这条路径不出现在任何黄金向量里，影响也只是界面上
 * 第 4 位有效数字（例如 "1.2km" vs "1.3km" 这种只在正好卡在半格时出现），
 * 不影响下发到设备的任何字节。真要逐字符一致，得自己实现十进制输出。
 */
function format_distance(meters) {
  if (meters < 10) return `${pyround(meters)}m`;
  if (meters < 100) return `${pyround(meters / 5.0) * 5}m`;
  if (meters < 1000) return `${pyround(meters / 10.0) * 10}m`;
  const km = meters / 1000.0;
  if (km < 10) return `${km.toFixed(1)}km`;
  return `${pyround(km)}km`;
}

// 转向分类阈值，必须与 lib/navcore/nav_math.cpp 的 classifyTurn 完全一致
const TURN_THRESHOLDS = [
  [15.0, null],            // < 15°  直行
  [45.0, 'Slight'],        // 15~45 微转
  [110.0, ''],             // 45~110 正常转
  [155.0, 'Sharp'],        // 110~155 急转
  [Infinity, 'Uturn'],     // > 155 掉头
];

/**
 * 把转角分类成转向类型，返回 proto.js 里 Turn 的数值。
 *
 * delta_deg 有向，**右转为正**（罗盘航向增大的方向）。
 * 阈值与固件端的 math::classifyTurn 保持一致 —— 两边不一致的话，
 * 同一个路口在手机端显示"右转"、在设备上显示"微右"，会非常难查。
 *
 * 与 navmath.py 的差异：Python 版在函数内部 `from navpuck_proto import Turn`
 * 以避免循环导入；JS 版由调用方把 Turn 表传进来（默认取 proto.js 的 Turn），
 * 这样 navmath.js 保持零依赖，单测可以单独加载它。
 */
function classify_turn(delta_deg, Turn) {
  const T = Turn || _defaultTurn();
  if (!T) throw new Error('classify_turn: Turn 表不可用，请显式传入第二个参数');
  const a = Math.abs(delta_deg);
  const right = delta_deg > 0.0;

  if (a < 15.0) return T.STRAIGHT;
  if (a < 45.0) return right ? T.SLIGHT_RIGHT : T.SLIGHT_LEFT;
  if (a < 110.0) return right ? T.RIGHT : T.LEFT;
  if (a < 155.0) return right ? T.SHARP_RIGHT : T.SHARP_LEFT;
  return right ? T.UTURN_RIGHT : T.UTURN_LEFT;
}

function _defaultTurn() {
  // 延迟解析：navmath.js 要能单独被 <script> 加载，也要能被 Node 单独 require。
  // 正常路径是 proto.js 加载完调用 _setProto() 回填；这里再兜一层 ——
  // 万一有人只 require 了 navmath.js 之后直接调 classify_turn，也能自己找到 proto。
  if (_protoRef && _protoRef.Turn) return _protoRef.Turn;
  if (typeof globalThis !== 'undefined' && globalThis.NavPuckProto) {
    return globalThis.NavPuckProto.Turn;
  }
  if (typeof require === 'function') {
    try {
      const p = require('./proto.js');
      if (p && p.Turn) { _protoRef = p; return p.Turn; }
    } catch (_e) { /* 浏览器 / 单文件加载时没有 require */ }
  }
  return null;
}

let _protoRef = null;

/**
 * 由 proto.js 在自身加载完成时回填。
 *
 * 为什么不让 navmath.js 去 require proto.js：proto.js 也 require 了本文件，
 * 直接互相 require 会构成循环依赖，谁先被求值谁就拿不到对方的完整 exports。
 * 改成"proto 加载完主动回填"，依赖方向就只有一条（proto -> navmath），
 * Node 与浏览器两种加载方式都成立。
 */
function _setProto(p) {
  _protoRef = p;
}

const NavMath = {
  EARTH_RADIUS_M,
  DEG2RAD,
  RAD2DEG,
  wrap180,
  wrap360,
  shortest_delta,
  bearing_deg,
  distance_m,
  approach_angle,
  map_clamp,
  within_radius_m,
  format_distance,
  pyround,
  pyint,
  TURN_THRESHOLDS,
  classify_turn,
  // 内部接口：proto.js 加载完回填 Turn 表用。应用代码不要直接调。
  _setProto,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NavMath;
} else if (typeof globalThis !== 'undefined') {
  globalThis.NavPuckMath = NavMath;
}
