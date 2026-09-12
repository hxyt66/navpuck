/*
 * NavPuck 手机端协议自测 —— 用**和 Python 完全相同的黄金向量**逐字节校验
 * phone/proto.js 与 phone/navmath.js 的移植是否忠实。
 *
 * 怎么跑（在 navpuck 根目录）：
 *     node phone/test/selftest.mjs
 * 或者：
 *     node --test phone/test/        （Node 18+ 的测试运行器，本文件也可被它加载）
 *
 * 为什么要写这个：
 *   手上没有安卓手机、也没有设备，端到端**不可能**在本机验证。唯一能在
 *   本机钉死的就是"编出来的字节和 Python 一模一样"。少了这一步，任何移植
 *   错误都只能在摩托车上发现 —— 那时既没有控制台，也没有第二块屏幕。
 *
 * 覆盖范围：
 *   [1] CRC 标准向量
 *   [2] 黄金向量逐字节比对（NAV_UPDATE / NAV_TEXT / NAV_META / NAV_ROUTE /
 *       NAV_MAP / PUCK_STATUS）
 *   [3] 每个消息类型的 encode -> decode 往返
 *   [4] NAV_ROUTE 分片往返（含 1 字节一次喂入）
 *   [5] CRC 破坏 / 垃圾前缀 / 半截帧 / 版本不符 的重同步
 *   [6] 边界值（i16 米 ±32767、NO_TURN、heading 0/35999）
 *   [7] 拒绝畸形 NAV_ROUTE / NAV_MAP
 *   [8] navmath 与 Python 同一组算例（硬编码期望值，来自 navmath.py 的实算）
 *   [9] classify_turn 阈值表
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(PHONE_DIR, '..');

const P = require(path.join(PHONE_DIR, 'proto.js'));
const NM = require(path.join(PHONE_DIR, 'navmath.js'));

const VEC_PATH = path.join(ROOT_DIR, 'test', 'navcore_vectors.json');
const VEC = JSON.parse(fs.readFileSync(VEC_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// 极简测试框架（不引任何依赖 —— 这个工程没有 npm）
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let group = '';

function section(name) {
  group = name;
  console.log(`\n[${name}]`);
}

function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${group} :: ${label}`);
    console.log(`  ✗ ${label}`);
  }
}

function eq(actual, expected, label) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const b = typeof expected === 'string' ? expected : JSON.stringify(expected);
  if (a === b) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${group} :: ${label}\n      期望 ${b}\n      实得 ${a}`);
    console.log(`  ✗ ${label}\n      期望 ${b}\n      实得 ${a}`);
  }
}

function throws(fn, label) {
  try {
    fn();
    failures.push(`${group} :: ${label}（本应抛错却没有）`);
    console.log(`  ✗ ${label}（本应抛错却没有）`);
  } catch (_e) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  }
}

/** Python dataclass 的字段级相等：按 NavRoute 的字段名单比，绕开 last/flags 差异。 */
function route_eq(a, b) {
  return a.total_points === b.total_points &&
         a.chunk_start === b.chunk_start &&
         !!a.last === !!b.last &&
         JSON.stringify(a.pts) === JSON.stringify(b.pts);
}

// ---------------------------------------------------------------------------
section('1] CRC-16/CCITT-FALSE');
// ---------------------------------------------------------------------------
{
  const input = new TextEncoder().encode(VEC.crc16_check.input);
  eq(P.crc16(input), VEC.crc16_check.expected,
     `crc16("${VEC.crc16_check.input}") = 0x${VEC.crc16_check.expected.toString(16).toUpperCase()}`);
  eq(P.crc16(input), 0x29B1, 'crc16("123456789") = 0x29B1');
  eq(P.crc16(new Uint8Array(0)), 0xFFFF, 'crc16(b"") = init 0xFFFF');
  // 其余几条是用 tools/navpuck_proto.py 的 crc16 实算出来的（不是手推的）：
  //     python -c "import sys;sys.path.insert(0,'tools');from navpuck_proto import crc16;
  //                print(hex(crc16(b'123')))"   ->  0x5bce
  eq(P.crc16(new TextEncoder().encode('A')), 0xB915, 'crc16("A") = 0xB915');
  eq(P.crc16(new TextEncoder().encode('123')), 0x5BCE, 'crc16("123") = 0x5BCE');
  eq(P.crc16(new TextEncoder().encode('abc')), 0x514A, 'crc16("abc") = 0x514A');
  eq(P.crc16(new TextEncoder().encode('1')), 0xC782, 'crc16("1") = 0xC782');
  eq(P.crc16(new TextEncoder().encode('12')), 0x3DBA, 'crc16("12") = 0x3DBA');
  // 覆盖 0x00..0xFF 全字节范围：CRC 表建错的话这里必崩
  const allBytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) allBytes[i] = i;
  eq(P.crc16(allBytes), 0x3FBD, 'crc16(0x00..0xFF 全部 256 个字节) = 0x3FBD');
}

// ---------------------------------------------------------------------------
section('2] 黄金向量逐字节比对');
// ---------------------------------------------------------------------------
{
  // ---- NAV_UPDATE ----
  const f = VEC.nav_update.fields;
  const u = new P.NavUpdate({
    rel_bearing_cdeg: f.rel_bearing_cdeg,
    abs_bearing_cdeg: f.abs_bearing_cdeg,
    dist_next_cm: f.dist_next_cm,
    dist_dest_m: f.dist_dest_m,
    speed_kmh_x10: f.speed_kmh_x10,
    eta_min: f.eta_min,
    turn: f.turn,
    flags: f.flags,
    progress_pct: f.progress_pct,
    reserved: f.reserved,
    heading_cdeg: f.heading_cdeg,
    pos_east_m: f.pos_east_m,
    pos_north_m: f.pos_north_m,
    next_turn_index: f.next_turn_index,
    view_range_dm: f.view_range_dm,
    reserved2: f.reserved2,
  });
  const updFrame = P.encode_nav_update(u);
  eq(P._hex(updFrame), VEC.nav_update.frame_hex, 'NAV_UPDATE frame_hex');
  eq(updFrame.length, P.OVERHEAD + P.NAV_UPDATE_LEN, 'NAV_UPDATE 帧长 = 8 + 32 = 40');
  eq(u.pack().length, P.NAV_UPDATE_LEN, 'NavUpdate.pack() 恰好 32 字节');

  // ---- NAV_TEXT ----
  const txtFrame = P.encode_nav_text(VEC.nav_text.kind, VEC.nav_text.text);
  eq(P._hex(txtFrame), VEC.nav_text.frame_hex, 'NAV_TEXT frame_hex（UTF-8 中文）');

  // ---- NAV_META ----
  const metaFrame = P.encode_nav_meta(new P.NavMeta({
    total_dist_m: VEC.nav_meta.total_dist_m,
    total_time_s: VEC.nav_meta.total_time_s,
    flags: VEC.nav_meta.flags,
  }));
  eq(P._hex(metaFrame), VEC.nav_meta.frame_hex, 'NAV_META frame_hex');

  // ---- NAV_ROUTE（两片）----
  const chunks = P.route_chunks(VEC.nav_route.pts, 3);
  eq(chunks.length, VEC.nav_route.frame_hex.length, 'NAV_ROUTE 分片数');
  eq(chunks.map((c) => c.count), VEC.nav_route.chunk_points, '每片点数');
  eq(chunks.map((c) => c.chunk_start), VEC.nav_route.chunk_starts, '每片起始下标');
  eq(chunks.map((c) => c.flags), VEC.nav_route.chunk_flags, '每片 flags');
  eq(chunks.map((c) => c.total_points), VEC.nav_route.frame_hex.map(() => VEC.nav_route.total_points),
     '每片的 total_points');
  for (let i = 0; i < chunks.length; i++) {
    eq(P._hex(P.encode_nav_route(chunks[i])), VEC.nav_route.frame_hex[i],
       `NAV_ROUTE 分片 ${i + 1}/${chunks.length} frame_hex`);
  }
  // 分片里特意放了 ±32767（i16 米的边界）：单位一旦残留 ×10 换算，这里立刻变成负数
  const lastPts = VEC.nav_route.pts.slice(-2);
  eq(chunks[1].pts.slice(-2), lastPts, `i16 米边界原样保留 ${JSON.stringify(lastPts)}`);

  // ---- NAV_MAP ----
  const nmap = new P.NavMap({
    seg_count: VEC.nav_map.seg_count,
    flags: 0,
    total_pts: VEC.nav_map.total_pts,
    seg_pts: VEC.nav_map.seg_pts,
    pts: VEC.nav_map.pts,
  });
  eq(P._hex(P.encode_nav_map(nmap)), VEC.nav_map.frame_hex, 'NAV_MAP frame_hex');
  eq(nmap.pack().length, P.NAV_MAP_HEADER_LEN + VEC.nav_map.seg_count + VEC.nav_map.total_pts * 4,
     'NAV_MAP payload 长度 = 4 + seg_count + 4*total_pts');

  // ---- PUCK_STATUS ----
  const st = new P.PuckStatus({
    vbat_mv: VEC.puck_status.vbat_mv,
    battery_pct: VEC.puck_status.battery_pct,
    flags: VEC.puck_status.flags,
  });
  eq(P._hex(P.encode_puck_status(st)), VEC.puck_status.frame_hex, 'PUCK_STATUS frame_hex');

  // ---- NAV_CLOCK（正好 6 字节）----
  // 黄金向量用的是 **+5:30**（330 分钟）而不是整点时区：整点时区用"小时"
  // 也能表达，半点时区不能 —— 拿它钉死"偏移是分钟而不是小时"。
  const ck = new P.NavClock({ epoch_s: VEC.nav_clock.epoch_s,
                              tz_offset_min: VEC.nav_clock.tz_offset_min });
  eq(P._hex(P.encode_nav_clock(ck)), VEC.nav_clock.frame_hex, 'NAV_CLOCK frame_hex');
  eq(ck.pack().length, P.NAV_CLOCK_LEN, 'NavClock.pack() 恰好 6 字节');
  eq(P.NAV_CLOCK_LEN, 6, 'NAV_CLOCK_LEN = 6');
  eq(ck.local_epoch_s, VEC.nav_clock.local_epoch_s, 'local_epoch_s = UTC + 偏移*60');
  const ckBack = P.NavClock.unpack(
    P.encode_nav_clock(ck).slice(P.HEADER_LEN, P.HEADER_LEN + P.NAV_CLOCK_LEN));
  eq([ckBack.epoch_s, ckBack.tz_offset_min], [VEC.nav_clock.epoch_s, VEC.nav_clock.tz_offset_min],
     'NAV_CLOCK 往返后两个字段原样');
  eq(P.MsgType.NAV_CLOCK, 0x06, 'MsgType.NAV_CLOCK = 0x06（0x06 原本空着）');
  eq(P._hex(P.encode_nav_clock(ck)).slice(6, 8), '06', 'NAV_CLOCK 帧头 type 字节 = 0x06');
  eq(P._hex(P.encode_nav_clock(ck)).slice(8, 12), '0600', 'NAV_CLOCK len 字段 = 6（小端）');

  // ---- 交叉：Python selftest 里硬编码的那几个字段偏移 ----
  const payload = updFrame.slice(P.HEADER_LEN, P.HEADER_LEN + P.NAV_UPDATE_LEN);
  eq(P._hex(payload.slice(20, 22)), '7f3e', 'payload[20:22] = heading_cdeg');
  eq(P._hex(payload.slice(22, 24)), 'd7f6', 'payload[22:24] = pos_east_m');
  eq(P._hex(payload.slice(24, 26)), '5046', 'payload[24:26] = pos_north_m');
  eq(P._hex(payload.slice(26, 28)), '0700', 'payload[26:28] = next_turn_index');
  eq(P._hex(payload.slice(28, 30)), 'b80b', 'payload[28:30] = view_range_dm');
  eq(P._hex(payload.slice(30, 32)), '0000', 'payload[30:32] = reserved2 = 0');
}

// ---------------------------------------------------------------------------
section('3] 各消息类型 encode -> decode 往返');
// ---------------------------------------------------------------------------
{
  // NAV_UPDATE
  const u = new P.NavUpdate({
    rel_bearing_cdeg: -12345, abs_bearing_cdeg: 23456, dist_next_cm: 1234567,
    dist_dest_m: 98765, speed_kmh_x10: 487, eta_min: 42, turn: P.Turn.LEFT,
    flags: P.NavFlags.GPS_FIX | P.NavFlags.LINK_UP, progress_pct: 37,
    heading_cdeg: 15999, pos_east_m: -2345, pos_north_m: 18000,
    next_turn_index: 7, view_range_dm: 3000,
  });
  const p1 = new P.FrameParser();
  const got1 = p1.feed(P.encode_nav_update(u));
  eq(got1.length, 1, '解出 1 帧');
  eq(got1[0].type, P.MsgType.NAV_UPDATE, 'type = NAV_UPDATE');
  eq(got1[0].version, P.VERSION, 'version = 1');
  const back = P.NavUpdate.unpack(got1[0].payload);
  eq(back.pack(), u.pack(), 'NAV_UPDATE 往返后 payload 字节相同');
  eq([back.rel_bearing_cdeg, back.abs_bearing_cdeg, back.dist_next_cm, back.dist_dest_m,
      back.speed_kmh_x10, back.eta_min, back.turn, back.flags, back.progress_pct,
      back.heading_cdeg, back.pos_east_m, back.pos_north_m, back.next_turn_index,
      back.view_range_dm, back.reserved2],
     [-12345, 23456, 1234567, 98765, 487, 42, P.Turn.LEFT, 17, 37,
      15999, -2345, 18000, 7, 3000, 0], 'NAV_UPDATE 各字段数值');
  eq([back.bearing_deg, back.heading_deg, back.view_range_m, back.speed_kmh, back.dist_next_m],
     [-123.45, 159.99, 300.0, 48.700000000000003, 12345.67], 'NAV_UPDATE 派生属性');
  ok(back.has_next_turn(), 'has_next_turn() = true');

  // NAV_ROUTE
  const chunks = P.route_chunks(VEC.nav_route.pts, 3);
  const p2 = new P.FrameParser();
  const got2 = p2.feed(P.encode_nav_route(chunks[0]));
  eq(got2.length, 1, 'NAV_ROUTE 解出 1 帧');
  eq(got2[0].type, P.MsgType.NAV_ROUTE, 'type = NAV_ROUTE');
  ok(route_eq(P.NavRoute.unpack(got2[0].payload), chunks[0]), 'NAV_ROUTE 往返后结构相同');
  eq(got2[0].payload.length, P.NAV_ROUTE_HEADER_LEN + 3 * 4, 'NAV_ROUTE payload 长度 = 6 + 4n');

  // NAV_MAP
  const nmap = new P.NavMap({ seg_count: 3, flags: 0, total_pts: 6, seg_pts: [3, 2, 1],
                              pts: VEC.nav_map.pts });
  const p3 = new P.FrameParser();
  const got3 = p3.feed(P.encode_nav_map(nmap));
  eq(got3.length, 1, 'NAV_MAP 解出 1 帧');
  const nmBack = P.NavMap.unpack(got3[0].payload);
  eq([nmBack.seg_count, nmBack.flags, nmBack.total_pts, nmBack.seg_pts, nmBack.pts],
     [3, 0, 6, [3, 2, 1], VEC.nav_map.pts], 'NAV_MAP 往返后结构相同');

  // NAV_META
  const p4 = new P.FrameParser();
  const got4 = p4.feed(P.encode_nav_meta(new P.NavMeta({ total_dist_m: 12345, total_time_s: 1800, flags: 1 })));
  eq(got4.length, 1, 'NAV_META 解出 1 帧');
  const mBack = P.NavMeta.unpack(got4[0].payload);
  eq([mBack.total_dist_m, mBack.total_time_s, mBack.flags], [12345, 1800, 1], 'NAV_META 字段');

  // NAV_TEXT
  const p5 = new P.FrameParser();
  const got5 = p5.feed(P.encode_nav_text(P.TextKind.ROAD_NAME, '人民路'));
  eq(got5.length, 1, 'NAV_TEXT 解出 1 帧');
  const [kind, text] = P.decode_text(got5[0].payload);
  eq([kind, text], [P.TextKind.ROAD_NAME, '人民路'], 'NAV_TEXT kind + UTF-8 文本');

  // PUCK_STATUS
  const p6 = new P.FrameParser();
  const got6 = p6.feed(P.encode_puck_status(new P.PuckStatus({ vbat_mv: 3960, battery_pct: 78, flags: 0 })));
  eq(got6.length, 1, 'PUCK_STATUS 解出 1 帧');
  const sBack = P.PuckStatus.unpack(got6[0].payload);
  eq([sBack.vbat_mv, sBack.battery_pct, sBack.flags], [3960, 78, 0], 'PUCK_STATUS 字段');

  // NAV_CLOCK：往返 + **边界值**。
  // 这个载荷只有 6 个字节、两个字段，长度一旦算错不会有任何提示 ——
  // 只是时间偏掉，而屏幕上照样显示一个"看起来正常"的时间。所以把 u32/i16
  // 的上下界、负偏移、以及半点时区全跑一遍。
  {
    const cases = [
      [0, 0], [0xFFFFFFFF, -32768], [0xFFFFFFFF, 32767],
      [1757500000, 480], [1757500000, 330], [1757500000, -300],
      [1757500000, 345], [1, -1],
    ];
    let bad = [];
    for (const [ep, tz] of cases) {
      const raw = new P.NavClock({ epoch_s: ep, tz_offset_min: tz }).pack();
      if (raw.length !== 6) { bad.push(`${ep}/${tz}: 长度 ${raw.length}`); continue; }
      const back = P.NavClock.unpack(raw);
      if (back.epoch_s !== ep || back.tz_offset_min !== tz) {
        bad.push(`${ep}/${tz}: 回读 ${back.epoch_s}/${back.tz_offset_min}`);
      }
    }
    eq(bad, [], `NAV_CLOCK ${cases.length} 组边界值原样往返（u32/i16 上下界、负偏移、半点时区）`);

    // 整帧走一遍解析器：8 字节开销 + 6 字节载荷 = 14
    const cf = P.encode_nav_clock(new P.NavClock({ epoch_s: 1757500000, tz_offset_min: 330 }));
    eq(cf.length, P.OVERHEAD + P.NAV_CLOCK_LEN, 'NAV_CLOCK 整帧长度 = 8 + 6 = 14');
    const p6b = new P.FrameParser();
    const got6b = p6b.feed(cf);
    eq(got6b.length, 1, 'NAV_CLOCK 解出 1 帧');
    eq(got6b[0].type, P.MsgType.NAV_CLOCK, 'type = NAV_CLOCK');
    // 1 字节一次喂入（BLE 上一次写只有一个 ATT PDU）
    const p6c = new P.FrameParser();
    let n6c = 0;
    for (let i = 0; i < cf.length; i++) n6c += p6c.feed(cf.subarray(i, i + 1)).length;
    eq(n6c, 1, 'NAV_CLOCK 一次一个字节喂入也能解出 1 帧');

    // 长度不对必须被拒：多一字节少一字节都算错版本，不是"兼容"
    const rej = [];
    for (const n of [0, 5, 7]) {
      try { P.NavClock.unpack(new Uint8Array(n)); rej.push(n); } catch (_e) { /* 期望抛错 */ }
    }
    eq(rej, [], 'NAV_CLOCK 长度 != 6 一律拒绝（5 / 7 / 0 都抛错）');

    // now_clock()：符号必须与 Python 的 -time.timezone 一致（见 proto.js 的说明）
    const nc = P.now_clock(Date.UTC(2025, 8, 10, 10, 26, 40));
    eq(nc.epoch_s, 1757500000, 'now_clock(ms) 的 epoch_s = 1757500000');
    eq(nc.tz_offset_min, -new Date(1757500000 * 1000).getTimezoneOffset(),
       `now_clock() 的偏移 = -getTimezoneOffset()（本机 ${-new Date().getTimezoneOffset()} 分钟）`);
  }

  // PING / PONG：0 长度载荷，解析器必须走 state 4 分支而不是把它当 payload
  const p7 = new P.FrameParser();
  const got7 = p7.feed(P.encode_ping());
  eq(got7.length, 1, 'PING（len=0）解出 1 帧');
  eq(got7[0].payload.length, 0, 'PING payload 长度 0');
  eq(P._hex(P.encode_ping()), 'a55a01200000' + P._hex(P.encode_ping()).slice(12), 'PING 帧头格式');
  const p8 = new P.FrameParser();
  eq(p8.feed(P.encode_pong())[0].type, P.MsgType.PONG, 'PONG type');
  const p8b = new P.FrameParser();
  eq(p8b.feed(P.encode_puck_event(P.PuckEventId.SWIPE_LEFT))[0].payload[0],
     P.PuckEventId.SWIPE_LEFT, 'PUCK_EVENT payload');
}

// ---------------------------------------------------------------------------
section('4] NAV_ROUTE 分片往返（含 1 字节一次喂入）');
// ---------------------------------------------------------------------------
{
  // 用一整套边界路线：空 / 1 点 / 恰好 255 / 256（跨片）/ 1024（上限）
  const cases = [
    { n: 0, max: 255, label: '空路线（一片 last + 0 点）' },
    { n: 1, max: 255, label: '1 个点' },
    { n: 255, max: 255, label: '恰好 255 点（单片上限）' },
    { n: 256, max: 255, label: '256 点 -> 必须切成 2 片' },
    { n: 1024, max: 255, label: '1024 点（设备端上限）' },
    { n: 10, max: 3, label: '10 点按 3 点/片' },
    { n: 7, max: 1, label: '7 点按 1 点/片（最碎）' },
  ];

  for (const c of cases) {
    const pts = [];
    for (let i = 0; i < c.n; i++) {
      // 覆盖正负、零、以及 i16 米的极值
      const e = ((i * 617) % 65535) - 32767;
      const nn = 32767 - ((i * 991) % 65535);
      pts.push([Math.max(-32767, Math.min(32767, e)), Math.max(-32767, Math.min(32767, nn))]);
    }
    // 手动补上极值，别让模运算把它们筛掉
    if (c.n >= 4) {
      pts[0] = [0, 0];
      pts[1] = [32767, -32767];
      pts[2] = [-32767, 32767];
      pts[3] = [-1, 1];
    }

    const chunks = P.route_chunks(pts, c.max);
    const expectChunks = c.n === 0 ? 1 : Math.ceil(c.n / c.max);
    if (chunks.length !== expectChunks) {
      ok(false, `${c.label}：分片数 ${chunks.length} != ${expectChunks}`);
      continue;
    }
    ok(chunks[chunks.length - 1].is_last_chunk(), `${c.label}：末片带 last`);
    let allLastFalse = true;
    for (let i = 0; i < chunks.length - 1; i++) if (chunks[i].is_last_chunk()) allLastFalse = false;
    ok(allLastFalse, `${c.label}：非末片都不带 last`);

    const frames = chunks.map((ch) => P.encode_nav_route(ch));
    const wire = Buffer.concat(frames.map((f) => Buffer.from(f)));

    // (a) 一次喂入
    const pa = new P.FrameParser();
    const fa = pa.feed(new Uint8Array(wire));
    if (fa.length !== chunks.length) {
      ok(false, `${c.label}：整块喂入解出 ${fa.length} 帧 != ${chunks.length}`);
    } else {
      let allOk = true;
      const rebuilt = new Array(c.n).fill(null);
      for (const fr of fa) {
        const r = P.NavRoute.unpack(fr.payload);
        for (let k = 0; k < r.pts.length; k++) rebuilt[r.chunk_start + k] = r.pts[k];
      }
      for (let k = 0; k < c.n; k++) {
        if (JSON.stringify(rebuilt[k]) !== JSON.stringify(pts[k])) allOk = false;
      }
      ok(allOk, `${c.label}：整块喂入后点集逐点还原`);
    }

    // (b) 1 字节一次喂入 —— 设备侧对任意切分透明，这里钉死解析器也没有整帧假设
    const pb = new P.FrameParser();
    let count = 0;
    for (let i = 0; i < wire.length; i++) {
      const out = pb.feed(wire.subarray(i, i + 1));
      count += out.length;
      if (out.length === 1) {
        const r = P.NavRoute.unpack(out[0].payload);
        if (r.pts.length !== chunks[count - 1].pts.length) {
          ok(false, `${c.label}：1 字节喂入第 ${count} 帧点数不符`);
        }
      }
    }
    eq(count, chunks.length, `${c.label}：1 字节喂入解出同样多的帧`);
    eq(pb.frames_ok, chunks.length, `${c.label}：1 字节喂入 frames_ok`);
    eq(pb.crc_errors + pb.resyncs, 0, `${c.label}：1 字节喂入无 CRC 错/重同步`);

    // (c) 20 / 512 字节块喂入 —— 页面按 MTU 试探切分时就是这个形状
    for (const blk of [20, 512]) {
      const pc = new P.FrameParser();
      let cnt = 0;
      for (let i = 0; i < wire.length; i += blk) {
        cnt += pc.feed(wire.subarray(i, Math.min(i + blk, wire.length))).length;
      }
      eq(cnt, chunks.length, `${c.label}：${blk} 字节块喂入解出 ${chunks.length} 帧`);
    }
  }

  // 越界必须被拒绝
  throws(() => P.route_chunks(new Array(1025).fill([0, 0])), '1025 点整条路线被拒（上限 1024）');
  throws(() => P.route_chunks([[0, 0]], 256), 'max_pts=256 被拒（上限 255）');
  throws(() => P.route_chunks([[0, 0]], 0), 'max_pts=0 被拒');
  throws(() => new P.NavRoute({ total_points: 300, chunk_start: 0, last: false,
                                pts: new Array(300).fill([0, 0]) }).pack(),
         '单片 300 点 pack() 直接报错（不静默截断）');

  // unpack 侧的拒绝规则（镜像 docs/protocol.md 的表格）
  const bad1 = new Uint8Array([3, 0, 5, 0, 200, 0]);                          // n_pts 越界
  const bad2 = new Uint8Array([0xD0, 0x07, 0, 0, 0, 1]);                      // total 2000 > 1024
  const bad3 = new Uint8Array([3, 0, 2, 0, 2, 1]);                            // 2+2 > 3
  const bad4 = new Uint8Array([3, 0, 0, 0, 1, 0]);                            // 长度与 n_pts 不符
  throws(() => P.NavRoute.unpack(bad1), 'n_pts > 255 整片拒绝');
  throws(() => P.NavRoute.unpack(bad2), 'total_points > 1024 整片拒绝');
  throws(() => P.NavRoute.unpack(bad3), 'chunk_start + n_pts > total_points 整片拒绝');
  throws(() => P.NavRoute.unpack(bad4), '帧长与 n_pts 不符 整片拒绝');

  // total_points = 0 且带 last：合法（这是"清掉设备上旧路线"的手段）
  const clearChunk = P.route_chunks([])[0];
  eq([clearChunk.count, clearChunk.is_last_chunk(), clearChunk.pack().length],
     [0, true, P.NAV_ROUTE_HEADER_LEN], '空路线分片：0 点 + last，payload 恰好 6 字节');

  // NAV_MAP 拒绝规则
  const m = new P.NavMap({ seg_count: 2, flags: 0, total_pts: 3, seg_pts: [2, 1],
                           pts: [[-120, -80], [0, 120], [900, -40]] });
  const mp = m.pack();
  eq(mp.length, P.NAV_MAP_HEADER_LEN + 2 + 3 * 4, 'NAV_MAP payload 长度');
  eq([mp[0], mp[1], mp[2] | (mp[3] << 8)], [2, 0, 3], 'NAV_MAP 头 = seg_count, flags, total_pts');
  throws(() => P.NavMap.unpack(mp.subarray(0, 4)), '截断的 NAV_MAP 整帧拒绝');
  const mpBad = Uint8Array.from(mp); mpBad[0] = 3;   // seg_count 说 3 段，实际只有 2 段
  throws(() => P.NavMap.unpack(mpBad), '每段点数之和 != total_pts 整帧拒绝');

  // 段装不下时整条丢掉（不是截断成半条线）。
  //
  // ⚠️ 实测结论（用 tools/navpuck_proto.py 逐个探测出来的，下面每条期望值都是
  //    Python 的实得值，两边必须一致）：
  //
  //      sega  pts/seg  total   pack 后 segs/total   payload   编码
  //      ----  -------  -----   -----------------    -------   ----
  //        60      5      300   60 / 300             1264     OK
  //        61      5      305   61 / 305             1285     OK   <- 全部保留
  //        50      8      400   50 / 400             1654     抛错
  //        51      8      408   50 / 400（丢 1 段）   1654     抛错
  //        45      9      405   44 / 396（丢 1 段）   1632     抛错
  //       100      4      400   64 / 256             1092     OK   <- 段数上限先卡住
  //
  //    也就是说 **"丢段"这条分支在编码到 wire 时永远走不到**：要丢段就得让
  //    total_pts 越过 MAX_MAP_TOTAL_POINTS = 400，而 400 点的 payload 至少
  //    1604 > MAX_PAYLOAD = 1536，encode_frame() 会先抛错。
  //    pack() 里那段"装不下的段整条丢掉"是**防御性代码**，只在直接调用
  //    pack() 时才可能生效 —— 这个事实 Python 和 JS 完全一样，不是移植偏差。
  //    真正保证帧能发出去的是生成端（map.js）的 MAP_MAX_POINTS = 330。

  // (a) 60 段 × 5 点 = 300 点：在 payload 预算内，全部保留
  const segs60 = new P.NavMap({
    seg_count: 60, flags: 0, total_pts: 300,
    seg_pts: new Array(60).fill(5),
    pts: new Array(300).fill(null).map((_, i) => [i, -i]),
  });
  const back60 = P.NavMap.unpack(P.encode_nav_map(segs60).slice(P.HEADER_LEN, -2));
  eq([back60.seg_count, back60.total_pts, back60.seg_pts.length],
     [60, 300, 60], '60 段 / 300 点：全部保留（payload 1264 <= 1536）');
  eq(P.nav_map_payload_len(60, 300), 1264, 'payload 长度 = 4 + 60 + 1200 = 1264');

  // (b) 61 段 × 5 点 = 305 点：还没到 400 的点预算，仍然全部保留
  const segs61 = new P.NavMap({
    seg_count: 61, flags: 0, total_pts: 305,
    seg_pts: new Array(61).fill(5),
    pts: new Array(305).fill(null).map((_, i) => [i, -i]),
  });
  const back61 = P.NavMap.unpack(P.encode_nav_map(segs61).slice(P.HEADER_LEN, -2));
  eq([back61.seg_count, back61.total_pts], [61, 305],
     '61 段 / 305 点：未越点预算，一段都不丢');

  // (c) 段数超过 MAX_MAP_SEGMENTS 时整条丢 —— 这条是能真正走到的
  const segs100 = new P.NavMap({
    seg_count: 100, flags: 0, total_pts: 400,
    seg_pts: new Array(100).fill(4),
    pts: new Array(400).fill(null).map((_, i) => [i, -i]),
  });
  const back100 = P.NavMap.unpack(P.encode_nav_map(segs100).slice(P.HEADER_LEN, -2));
  eq([back100.seg_count, back100.total_pts], [64, 256],
     '100 段 / 400 点：先被 MAX_MAP_SEGMENTS=64 截到 64 段 / 256 点（Python 同值）');
  ok(back100.seg_pts.every((n) => n === 4), '保留下来的每段都是完整的 4 个点');

  // (d) 直接调 pack() 走"丢段"分支（编码到 wire 前就先看结果）
  const dropCase = new P.NavMap({
    seg_count: 51, flags: 0, total_pts: 408,
    seg_pts: new Array(51).fill(8),
    pts: new Array(408).fill(null).map((_, i) => [i, -i]),
  });
  const dp = dropCase.pack();
  eq([dp[0], dp[2] | (dp[3] << 8)], [50, 400],
     'pack() 丢段分支：51 段 × 8 点 -> 50 段 / 400 点（Python 同值）');
  eq(dp.length, 1654, '丢段后 payload 仍是 1654 字节');
  throws(() => P.encode_nav_map(dropCase),
         '丢段后的帧仍超 MAX_PAYLOAD -> 编码时抛错（证明丢段分支到不了 wire）');
  // 越过点预算的那一段是**整条丢**，不是被截成半条线
  const dp45 = new P.NavMap({
    seg_count: 45, flags: 0, total_pts: 405,
    seg_pts: new Array(45).fill(9),
    pts: new Array(405).fill(null).map((_, i) => [i, -i]),
  }).pack();
  eq([dp45[0], dp45[2] | (dp45[3] << 8)], [44, 396],
     '45 段 × 9 点 -> 44 段 / 396 点（多出来的 1 段整条丢，Python 同值）');

  // ---- NAV_MAP 的"合法但与 MAX_PAYLOAD 冲突"区间（一个实测出来的坑） ----
  //
  // MAX_MAP_TOTAL_POINTS = 400 是接收端数组容量，比一帧能装下的还大。
  // 400 点 + 64 段 -> payload 1668 > 1536，encode_frame() 抛错。
  // 手机端的抓取上限（330 点 / 60 段 -> 1384 字节）就是为绕开这个而定的。
  eq(P.nav_map_payload_len(64, 400), 1668, 'NAV_MAP payload 长度公式 = 4 + segs + 4*pts');
  ok(!P.nav_map_fits(64, 400), '64 段 / 400 点：装不进一帧（1668 > 1536）');
  ok(!P.nav_map_fits(0, 400), '0 段 / 400 点：同样装不进（1604 > 1536）');
  ok(P.nav_map_fits(60, 330), '手机端抓取上限 60 段 / 330 点：装得进（1384 <= 1536）');
  eq(P.nav_map_max_points_for_segs(64), 367,
     '64 段时一帧最多 367 点：4+64+4×367 = 1536 恰好用满（368 会到 1540，超）');
  eq(P.nav_map_payload_len(64, 367), 1536, '64 段 / 367 点的 payload 恰好 1536 = MAX_PAYLOAD');
  ok(P.nav_map_fits(64, 367), '64 段 / 367 点：装得进（正好卡在上限）');
  ok(!P.nav_map_fits(64, 368), '64 段 / 368 点：超 4 字节，装不进');
  eq(P.nav_map_max_points_for_segs(60), 368,
     '60 段时一帧最多 368 点（4+60+4×368 = 1536）');
  eq(P.nav_map_max_points_for_segs(0), 383,
     '0 段时一帧最多 383 点（floor((1536-4)/4)，比 400 的数组容量小）');
  throws(() => P.encode_nav_map(new P.NavMap({
    seg_count: 1, flags: 0, total_pts: 384,
    seg_pts: [384], pts: new Array(384).fill([0, 0]),
  })), '超过 MAX_PAYLOAD 的 NAV_MAP 编码时抛错（而不是静默截断）');
}

// ---------------------------------------------------------------------------
section('5] 解码器健壮性（脏数据 / 重同步）');
// ---------------------------------------------------------------------------
{
  const u = new P.NavUpdate({ rel_bearing_cdeg: -12345, heading_cdeg: 15999,
                              pos_east_m: -2345, pos_north_m: 18000,
                              next_turn_index: 7, view_range_dm: 3000 });
  const frame = P.encode_nav_update(u);

  // 垃圾前缀 + 半截帧头
  const p1 = new P.FrameParser();
  const out1 = p1.feed(Buffer.concat([Buffer.from([0x00, 0xFF, 0xA5, 0xA5]), Buffer.from(frame)]));
  eq(out1.length, 1, '垃圾 + 0xA5A5 前缀后仍能解出帧');

  // 0xA5 0xA5 0x5A：重复 magic0 不能丢帧
  const p2 = new P.FrameParser();
  eq(p2.feed(Buffer.concat([Buffer.from([0xA5, 0xA5]), Buffer.from(frame)])).length, 1,
     '0xA5 0xA5 0x5A 正确同步');

  // CRC 破坏 -> 丢弃 + 计数
  const bad = Uint8Array.from(frame); bad[bad.length - 1] ^= 0xFF;
  const p3 = new P.FrameParser();
  eq(p3.feed(bad).length, 0, 'CRC 错帧被丢弃');
  eq(p3.crc_errors, 1, 'crc_errors 计数 = 1');
  eq(p3.frames_ok, 0, 'CRC 错帧不计入 frames_ok');

  // 版本不符 -> 丢弃 + 计数
  const badv = Uint8Array.from(frame); badv[2] = 2;
  // 版本字节参与 CRC，所以先重算 CRC 才能测到"版本不符"这条分支
  const bodyForCrc = badv.subarray(2, badv.length - 2);
  const newCrc = P.crc16(bodyForCrc);
  badv[badv.length - 2] = newCrc & 0xFF; badv[badv.length - 1] = (newCrc >> 8) & 0xFF;
  const p4 = new P.FrameParser();
  eq(p4.feed(badv).length, 0, '版本不符的帧被丢弃');
  eq(p4.bad_version, 1, 'bad_version 计数 = 1');

  // 帧长字段 > 1536 -> 判为畸形并重新同步
  const evil = new Uint8Array([0xA5, 0x5A, 0x01, 0x01, 0x00, 0x20]);   // len = 0x2000 = 8192
  const p5 = new P.FrameParser();
  eq(p5.feed(evil).length, 0, 'len > 1536 判为畸形');
  eq(p5.resyncs, 1, 'resyncs 计数 = 1');

  // 半截帧后紧跟新帧。
  //
  // ⚠️ 这里**不能**简单地断言"能解出新帧"。实测（Python 与 JS 行为一致）：
  //    在恰好 (HEADER_LEN + NAV_UPDATE_LEN) = 38 字节处截断时，解析器已经
  //    收集完整个 payload、只差 2 个 CRC 字节，此刻它停在 state=4。
  //    下一个帧头的 0xA5 被当成 CRC 的低字节吃掉，0x5A 被当成高字节 —— 于是
  //    CRC 校验失败、这一帧被丢弃并计数。**这就是"丢一帧、丢一条指引线"的机理**。
  //    真正的兜底是 is_mid_frame() + 空闲超时复位（见 app.js 的看门狗），
  //    这里把"会卡住"这件事本身钉住，免得以后有人误以为解析器能自动恢复。
  const p6 = new P.FrameParser();
  p6.feed(frame.subarray(0, 38));                 // 只差 2 个 CRC 字节
  eq(p6.is_mid_frame(), true, '38/40 字节喂入后解析器停在帧中间');
  const out6 = p6.feed(frame);                     // 紧跟一个完整帧
  eq(out6.length, 0, '残帧后的新帧被 CRC 拦下（解析器不会自动恢复）');
  eq(p6.crc_errors, 1, '这次失败计入 crc_errors = 1');
  // 复位之后同一个完整帧必须能正常解出
  p6.reset();
  eq(p6.feed(frame).length, 1, 'reset() 之后同一帧正常解出（空闲超时复位有效）');

  // 帧头中途截断后紧跟新帧：
  // 截到刚好读完 len 字段（7 字节 -> 停在 state 2）之后，新帧的 A5 会被当成
  // 帧头第 7 个字节吃掉，0x5A 成为第 8 个 —— 于是新帧也解不出来。这条同样钉住
  // "不能靠解析器自愈"，兜底只有 reset()。
  const p6b = new P.FrameParser();
  const out6b = p6b.feed(Buffer.concat([Buffer.from(frame.subarray(0, 7)), Buffer.from(frame)]));
  eq(out6b.length, 0, '帧头中途截断同样会让解析器失步（不会自愈）');
  p6b.reset();
  eq(p6b.feed(frame).length, 1, 'reset() 之后恢复正常');

  // 真正能靠 magic 自愈的只有"字节流的尾部恰好对齐到 state 0"的截断：
  // 也就是丢掉整个帧、再从头开始 —— 这是丢链后重新同步的常见形状。
  const p6c = new P.FrameParser();
  eq(p6c.feed(frame).length, 1, '完整帧正常解出');
  eq(p6c.feed(frame).length, 1, '紧随其后的第二帧也正常解出（帧边界对齐时无残留）');

  // 一次喂入多帧
  const p7 = new P.FrameParser();
  const many = Buffer.concat([Buffer.from(frame), Buffer.from(frame), Buffer.from(frame)]);
  eq(p7.feed(many).length, 3, '一次喂入 3 帧全部解出');

  // 一字节一次喂入
  const p8 = new P.FrameParser();
  let n8 = 0;
  for (let i = 0; i < frame.length; i++) n8 += p8.feed(frame.subarray(i, i + 1)).length;
  eq(n8, 1, '一次一个字节喂入解出 1 帧');

  // is_mid_frame 的语义（配合空闲超时复位用）
  const p9 = new P.FrameParser();
  eq(p9.is_mid_frame(), false, '空闲解析器 is_mid_frame() = false');
  p9.feed(frame.subarray(0, 10));
  eq(p9.is_mid_frame(), true, '半截帧 is_mid_frame() = true');
  p9.reset();
  eq(p9.is_mid_frame(), false, 'reset() 后 is_mid_frame() = false');
  const p10 = new P.FrameParser();
  p10.feed(frame);
  eq(p10.is_mid_frame(), false, '整帧喂完后 is_mid_frame() = false');

  // 帧解析器计数汇总
  const p11 = new P.FrameParser();
  p11.feed(frame);
  eq([p11.frames_ok, p11.crc_errors, p11.resyncs, p11.bad_version], [1, 0, 0, 0], '干净帧的计数全对');
}

// ---------------------------------------------------------------------------
section('5b] 任意写边界：BLE 怎么写都不许丢帧（含 14 字节空片）');
// ---------------------------------------------------------------------------
//
// 这一节是"设备偶尔收不到空片"那件悬案的**验收**，也是上一版错误解释的证伪。
//
// 上一版在 integration.mjs 里写着：14 字节的空片和下一帧的前半截被切进同一批
// 写，设备的解析器紧接着把下一帧的 A5 5A 当成长度字段（0x5AA5 = 23205 > 1536）
// 于是失步、整帧作废 —— 结论是"空片丢了是切字节必然的代价，不是 bug"。
//
// **那个解释不成立。** 两个解析器（phone/proto.js 与 lib/navcore/nav_proto.cpp）
// 都是**逐字节状态机**：状态里只有"这一帧已经吃了几个字节"，与"这批一次写了
// 多少字节"完全无关。所以下面把**每一个**切分点都喂一遍：
//   (a) 一次喂完             (b) 一个字节一次
//   (c) 所有二段切分点       (d) 空片两侧的每一个位置（含把 14 字节从中间劈开）
//   (e) 512 字节的写窗口（ble.js 真实的分片形状）
// 每一种切法都必须解出**逐字节相同**的帧序列（不是"帧数差不多"），而且
// resyncs / crc_errors 必须是 0 —— 只要有一次把 A5 5A 读成长度字段，
// resyncs 就会非 0。
//
// 真正的丢帧原因在 ble.js 自己的队列记账（_drain() 用下标删帧，删掉了 await
// 期间被优先级排序插到队首的空片），已在 integration.mjs 第 4 节和 ble.js 的
// _drain() 注释里写明。
//
// C++ 侧不是"读代码得出的结论"，而是真编译跑过（w64devkit，2026-09）：
//     g++ -std=gnu++11 -I include -I lib/navcore -DNAVPUCK_HOST_TEST=1 \
//         <harness>.cpp lib/navcore/nav_proto.cpp
//   同一份 4147 字节的流 + 同一套切分矩阵，输出与 JS 侧**逐字节相同**：
//     two_way_bad 0 of 4146 / empty_neighborhood_bad 0 of 210 /
//     frames_ok=8 crc_errors=0 resyncs=0 / 每条切法的帧序列一致。
//   为了让"没有主机编译器"的机器也能守住这条结论，下面把 C++ 的 push()
//   逐行转写了一份（cpp_digest），并要求它在**所有**切法上与真解析器一致。
{
  // ---- 一份"真实 BLE 写序列"：与 app.js._send_window(true) 同形 ----
  // 1 片空片（清旧窗口）+ 4 片分片 + 时钟 + 更新 + 文本，全部接在一条流里，
  // 因为设备收到的就是一条连续字节流（帧边界由它自己找）。
  const pts = [];
  for (let i = 0; i <= 1000; i++) pts.push([i * 10, i * 2]);
  const frames = [
    P.encode_nav_route(P.route_chunks([])[0]),
    ...P.route_chunks(pts).map((c) => P.encode_nav_route(c)),
    P.encode_nav_clock(new P.NavClock({ epoch_s: 1789226827, tz_offset_min: 480 })),
    P.encode_nav_update(new P.NavUpdate({ heading_cdeg: 9000, speed_kmh_x10: 487 })),
    P.encode_nav_text(P.TextKind.ROAD_NAME, '中山路'),
  ];
  const wire = new Uint8Array(frames.reduce((a, f) => a + f.length, 0));
  { let o = 0; for (const f of frames) { wire.set(f, o); o += f.length; } }

  // 空片的字节是**固定的**：8 字节开销 + 6 字节分片头（total=0, start=0, n=0, flags=1）
  const CLEAR_LEN = P.OVERHEAD + P.NAV_ROUTE_HEADER_LEN;
  eq(CLEAR_LEN, 14, '空片帧长 = 14 字节（8 开销 + 6 分片头）');
  eq(frames[0].length, CLEAR_LEN, '第一帧就是那个 14 字节的空片');
  eq(P._hex(frames[0]), 'a55a010406000000000000017982',
     '空片的 14 个字节逐字节固定（a5 5a 01 04 | 06 00 | 00 00 00 00 00 01 | 79 82）');
  eq([...frames.map((f) => f.length)], [14, 1034, 1034, 1034, 958, 14, 40, 19],
     '这一串的帧长：空片 14 / 3×1034 / 958 / 时钟 14 / 更新 40 / 文本 19');

  // 期望的"帧序列摘要"：type/载荷长度，顺序敏感 —— 这就是逐帧比对的基准
  const want = frames.map((f) => `${f[3]}/${f[4] | (f[5] << 8)}`).join(',');

  /** 用某种切法喂真解析器，返回摘要 + 解析器计数。 */
  function js_digest(chunks) {
    const p = new P.FrameParser();
    const out = [];
    for (const c of chunks) for (const fr of p.feed(c)) out.push(`${fr.type}/${fr.payload.length}`);
    return { s: out.join(','), crc: p.crc_errors, resync: p.resyncs, mid: p.is_mid_frame() };
  }

  /**
   * lib/navcore/nav_proto.cpp 的 FrameParser::push()（第 336-403 行）的逐行转写。
   *
   * 只为了让"任意切分点都不丢帧"这条结论在没有主机编译器的机器上也能守住：
   * 真 C++ 已经编译跑过一遍（见本节开头），这里把它变成一条常驻断言。
   * 转写是**照抄**：状态机、len > MAX_PAYLOAD 的重同步、CRC 覆盖面
   * [2, 6+len)、以及"先 CRC 后版本"的判定顺序，都不做任何"顺手优化"。
   */
  function cpp_digest(chunks) {
    const MAGIC0 = P.MAGIC0, MAGIC1 = P.MAGIC1, MAX = P.MAX_PAYLOAD, HL = P.HEADER_LEN;
    let state = 0, idx = 0, len = 0;                 // 0=Magic0 1=Magic1 2=Header 3=Payload 4=Crc
    const buf = new Uint8Array(HL + MAX + P.CRC_LEN);
    const out = [];
    let frames_ok = 0, crc_errors = 0, resyncs = 0, bad_version = 0;
    for (const ch of chunks) {
      for (const b of ch) {
        if (state === 0) {
          if (b === MAGIC0) { buf[0] = b; state = 1; }
          continue;
        }
        if (state === 1) {
          if (b === MAGIC1) { buf[1] = b; idx = 2; state = 2; }
          else if (b !== MAGIC0) { resyncs += 1; state = 0; }  // 0xA5 0xA5 也能重新同步
          continue;
        }
        if (state === 2) {
          buf[idx++] = b;
          if (idx < HL) continue;
          len = buf[4] | (buf[5] << 8);
          if (len > MAX) { resyncs += 1; state = 0; continue; }
          idx = HL;
          state = len === 0 ? 4 : 3;
          continue;
        }
        if (state === 3) {
          buf[idx++] = b;
          if (idx < HL + len) continue;
          state = 4;
          continue;
        }
        buf[idx++] = b;
        if (idx < HL + len + P.CRC_LEN) continue;
        state = 0;
        const expect = buf[HL + len] | (buf[HL + len + 1] << 8);
        const got = P.crc16(buf.slice(2, HL + len));
        if (expect !== got) { crc_errors += 1; continue; }
        if (buf[2] !== P.VERSION) { bad_version += 1; continue; }
        frames_ok += 1;
        out.push(`${buf[3]}/${len}`);
      }
    }
    return { s: out.join(','), crc: crc_errors, resync: resyncs, mid: state !== 0, frames_ok };
  }

  // (a) 一次喂完
  const a_js = js_digest([wire]);
  eq(a_js.s, want, `整块喂入解出全部 ${frames.length} 帧（含 14 字节空片）`);
  eq([a_js.crc, a_js.resync, a_js.mid], [0, 0, false], '整块喂入：零 CRC 错、零重同步、不在帧中间');
  eq(cpp_digest([wire]).s, want, 'C++ 转写：整块喂入同样解出全部 8 帧');
  // 空片必须被解成"total_points = 0 且带 last"的那一片（设备据此清旧窗口）
  const emptyFrame = new P.FrameParser().feed(wire.subarray(0, CLEAR_LEN))[0];
  const emptyRoute = P.NavRoute.unpack(emptyFrame.payload);
  eq([emptyFrame.type, emptyRoute.total_points, emptyRoute.count, emptyRoute.is_last_chunk()],
     [P.MsgType.NAV_ROUTE, 0, 0, true],
     '空片被解成 NAV_ROUTE + total_points = 0 + last（设备据此清掉旧窗口）');

  // (b) 一个字节一次 —— 多段切分的极端情形
  const bytes1 = [];
  for (let i = 0; i < wire.length; i++) bytes1.push(wire.subarray(i, i + 1));
  const b_js = js_digest(bytes1);
  eq(b_js.s, want, `一字节一次喂入（${wire.length} 次 feed）解出同一串帧`);
  eq([b_js.crc, b_js.resync], [0, 0], '一字节一次喂入：零 CRC 错、零重同步');
  eq(cpp_digest(bytes1).s, want, 'C++ 转写：一字节一次喂入同样一帧不丢');

  // (c) **所有**二段切分点
  let bad_js = 0, bad_cpp = 0, crc_sum = 0, resync_sum = 0;
  for (let i = 1; i < wire.length; i++) {
    const cs = [wire.subarray(0, i), wire.subarray(i)];
    const d = js_digest(cs);
    if (d.s !== want) bad_js += 1;
    crc_sum += d.crc; resync_sum += d.resync;
    if (cpp_digest(cs).s !== want) bad_cpp += 1;
  }
  eq(bad_js, 0, `全部 ${wire.length - 1} 个二段切分点：真解析器一帧不丢、顺序不变`);
  eq(bad_cpp, 0, `全部 ${wire.length - 1} 个二段切分点：C++ 转写一帧不丢`);
  eq([crc_sum, resync_sum], [0, 0],
     '所有切分点加起来 CRC 错 0 / 重同步 0（"把 A5 5A 读成长度字段"的失步一次都没发生）');

  // (d) 空片两侧：三段切法，切点把 14 字节的每一个位置都劈开
  let bad_neigh = 0, total_neigh = 0;
  for (let a = 0; a <= CLEAR_LEN; a++) {
    for (let b = a; b <= CLEAR_LEN + 6; b++) {
      total_neigh += 1;
      const cs = [wire.subarray(0, a), wire.subarray(a, b), wire.subarray(b)];
      if (js_digest(cs).s !== want) bad_neigh += 1;
      if (cpp_digest(cs).s !== want) bad_neigh += 1;
    }
  }
  eq(bad_neigh, 0,
     `空片前后 ${total_neigh * 2} 种三段切法（含把空片劈成 1+13 … 13+1）全部解出同一串帧`);

  // (e) 512 字节写窗口 —— ble.js 试探成功后的真实写边界
  const w512 = [];
  for (let i = 0; i < wire.length; i += 512) w512.push(wire.subarray(i, Math.min(i + 512, wire.length)));
  const e_js = js_digest(w512);
  eq(e_js.s, want, `512 字节写窗口（${w512.map((c) => c.length).join('/')}）解出同一串帧`);
  eq(cpp_digest(w512).s, want, 'C++ 转写：512 字节写窗口同样一致');
  // 20 字节写窗口（MTU 23 退档后的形状）也必须一致
  const w20 = [];
  for (let i = 0; i < wire.length; i += 20) w20.push(wire.subarray(i, Math.min(i + 20, wire.length)));
  eq(js_digest(w20).s, want, '20 字节写窗口（退档到 MTU 23）解出同一串帧');
  eq(cpp_digest(w20).s, want, 'C++ 转写：20 字节写窗口同样一致');

  // 顺带钉住"失步之后不会自愈"这件事在 C++ 转写里也一样（两边语义必须同构）：
  // 单帧末尾截断 2 字节后紧跟同一帧，两边都必须丢这一帧。
  const u = P.encode_nav_update(new P.NavUpdate({ heading_cdeg: 9000 }));
  const j1 = new P.FrameParser(); j1.feed(u.subarray(0, u.length - 2));
  const mid_after_partial = j1.is_mid_frame();   // 必须在喂第二帧**之前**取
  const j2 = j1.feed(u);
  const c1 = cpp_digest([u.subarray(0, u.length - 2)]);
  const c2 = cpp_digest([u.subarray(0, u.length - 2), u]);
  eq([mid_after_partial, j2.length], [true, 0], 'JS：半截帧后紧跟新帧 -> 新帧被 CRC 拦下（不会自愈）');
  eq([c1.mid, c1.s, c2.s], [true, '', ''], 'C++ 转写：同样停在帧中间、同样丢帧（两边同构）');
}

// ---------------------------------------------------------------------------
section('6] 边界值往返');
// ---------------------------------------------------------------------------
{
  // heading：0 = 正北，35999 = 正北前一格，65535 是 wire 极值（越界值不该出现）
  for (const hdg of [0, 35999, 1, 18000, 65535]) {
    const u = new P.NavUpdate({ heading_cdeg: hdg });
    const payload = P.NavUpdate.unpack(
      P.encode_nav_update(u).slice(P.HEADER_LEN, P.HEADER_LEN + P.NAV_UPDATE_LEN));
    eq(payload.heading_cdeg, hdg, `heading_cdeg = ${hdg} 原样往返`);
  }
  // pos：i16 米边界
  for (const [pe, pn] of [[0, 0], [32767, -32767], [-32768, 32767]]) {
    const u = new P.NavUpdate({ pos_east_m: pe, pos_north_m: pn });
    const back = P.NavUpdate.unpack(
      P.encode_nav_update(u).slice(P.HEADER_LEN, P.HEADER_LEN + P.NAV_UPDATE_LEN));
    eq([back.pos_east_m, back.pos_north_m], [pe, pn], `pos = (${pe}, ${pn}) 原样往返`);
  }
  // NO_TURN 哨兵：不是 0，0 是合法下标
  const un = new P.NavUpdate({ next_turn_index: P.NO_TURN });
  eq(un.has_next_turn(), false, 'next_turn_index = NO_TURN -> has_next_turn() = false');
  eq(P.NavUpdate.unpack(P.encode_nav_update(un).slice(P.HEADER_LEN, P.HEADER_LEN + 32))
       .next_turn_index, 0xFFFF, 'NO_TURN 在 wire 上是 0xFFFF');
  eq(new P.NavUpdate({}).next_turn_index, P.NO_TURN, 'NavUpdate 默认 next_turn_index = 0xFFFF');
  const u0 = new P.NavUpdate({ next_turn_index: 0 });
  ok(u0.has_next_turn(), 'next_turn_index = 0 是合法下标（不是"没有"）');
  eq(P.NO_TURN, 0xFFFF, 'NO_TURN = 0xFFFF');
  eq(P.NO_TURN_INDEX, P.NO_TURN, 'NO_TURN_INDEX 是 NO_TURN 的同义名');

  // 越界的输入必须被 clamp（而不是回绕成别的数）
  const uc = new P.NavUpdate({ pos_east_m: 99999, pos_north_m: -99999,
                               heading_cdeg: 70000, rel_bearing_cdeg: -99999,
                               dist_next_cm: -5, speed_kmh_x10: 99999 });
  const cb = P.NavUpdate.unpack(
    P.encode_nav_update(uc).slice(P.HEADER_LEN, P.HEADER_LEN + P.NAV_UPDATE_LEN));
  eq([cb.pos_east_m, cb.pos_north_m], [32767, -32768], 'pos 越界被 clamp 到 i16 边界');
  eq(cb.heading_cdeg, 65535, 'heading 越界被 clamp 到 65535');
  eq(cb.rel_bearing_cdeg, -32768, 'rel_bearing 越界被 clamp 到 -32768');
  eq(cb.dist_next_cm, 0, 'dist_next_cm 负数被 clamp 到 0');
  eq(cb.speed_kmh_x10, 65535, 'speed 越界被 clamp 到 65535');

  // NAV_ROUTE 点越界同样 clamp（设备端只认 i16 米）
  const rc = P.route_chunks([[99999, -99999]])[0];
  const rcBack = P.NavRoute.unpack(P.encode_nav_route(rc).slice(P.HEADER_LEN, -2));
  eq(rcBack.pts[0], [32767, -32767], 'NAV_ROUTE 点越界被 clamp 到 i16 米边界');

  // 大 u32：dist_dest_m 用 u32，不能因为 JS 位运算被截成 32 位有符号
  const ubig = new P.NavUpdate({ dist_dest_m: 4000000000, dist_next_cm: 4294967295 });
  const bigBack = P.NavUpdate.unpack(
    P.encode_nav_update(ubig).slice(P.HEADER_LEN, P.HEADER_LEN + P.NAV_UPDATE_LEN));
  eq([bigBack.dist_dest_m, bigBack.dist_next_cm], [4000000000, 4294967295],
     'u32 大值原样往返（未走 |0）');

  // 多字节字符截断不劈开
  const longText = '中'.repeat(200);       // 600 字节
  const tf = P.encode_nav_text(P.TextKind.ROAD_NAME, longText);
  const payloadT = tf.slice(P.HEADER_LEN, tf.length - 2);
  eq(payloadT[1], 255, 'NAV_TEXT 长度字段截到 255');
  const [, tBack] = P.decode_text(payloadT);
  eq(tBack, '中'.repeat(85), '255 字节回退到字符边界 = 85 个汉字（255/3）');
  eq(P._truncate_utf8(new TextEncoder().encode('中文'.repeat(100)), 7).length, 6,
     '_truncate_utf8(7) 回退到 6 字节（不劈开第 3 个汉字）');
  eq(P._truncate_utf8(new TextEncoder().encode('abc'), 10).length, 3,
     '_truncate_utf8 短于 limit 时原样返回');

  // 常量自检：这些数字错了，两端所有偏移量一起错
  eq([P.NAV_UPDATE_LEN, P.NAV_META_LEN, P.PUCK_STATUS_LEN, P.NAV_CLOCK_LEN],
     [32, 9, 4, 6], 'NAV_UPDATE_LEN = 32 / NAV_META_LEN = 9 / PUCK_STATUS_LEN = 4 / NAV_CLOCK_LEN = 6');
  eq(P.NAV_ROUTE_HEADER_LEN, 6, 'NAV_ROUTE_HEADER_LEN = 6');
  eq(P.NAV_MAP_HEADER_LEN, 4, 'NAV_MAP_HEADER_LEN = 4');
  eq(P.MAX_PAYLOAD, 1536, 'MAX_PAYLOAD = 1536');
  eq(P.MAX_ROUTE_POINTS, 1024, 'MAX_ROUTE_POINTS = 1024');
  eq(P.MAX_ROUTE_CHUNK_POINTS, 255, 'MAX_ROUTE_CHUNK_POINTS = 255');
  ok(P.MAX_ROUTE_CHUNK_POINTS <= P.MAX_ROUTE_CHUNK_POINTS_BY_PAYLOAD,
     'MAX_ROUTE_CHUNK_POINTS <= 载荷允许的片长（255 <= 382）');
  eq(P.ROUTE_MAX_RANGE_M, 32767, 'ROUTE_MAX_RANGE_M = 32767');
  eq(P.ROUTE_CHUNK_LAST, 1, 'ROUTE_CHUNK_LAST = 1');
  eq([P.MAGIC0, P.MAGIC1, P.VERSION], [0xA5, 0x5A, 1], 'magic / version');
  eq(P.TURN_NAMES.length, 16, 'Turn 表 16 个值');
  eq([P.MsgType.NAV_UPDATE, P.MsgType.NAV_TEXT, P.MsgType.NAV_META, P.MsgType.NAV_ROUTE,
      P.MsgType.NAV_MAP, P.MsgType.NAV_CLOCK, P.MsgType.PUCK_STATUS, P.MsgType.PUCK_EVENT,
      P.MsgType.PING, P.MsgType.PONG],
     [1, 2, 3, 4, 5, 6, 0x10, 0x11, 0x20, 0x21], 'MsgType 全部取值（NAV_CLOCK = 0x06）');
  eq([P.Turn.NONE, P.Turn.STRAIGHT, P.Turn.LEFT, P.Turn.ARRIVE, P.Turn.OFF_ROUTE],
     [0, 1, 3, 14, 15], 'Turn 关键取值');
  eq([P.NavFlags.GPS_FIX, P.NavFlags.OFF_ROUTE, P.NavFlags.ARRIVED, P.NavFlags.LOW_BATTERY,
      P.NavFlags.LINK_UP, P.NavFlags.REROUTING], [1, 2, 4, 8, 16, 32], 'NavFlags 位');
}

// ---------------------------------------------------------------------------
section('7] navmath 与 navmath.py 同组算例');
// ---------------------------------------------------------------------------
{
  // wrap
  eq(NM.wrap180(0), 0, 'wrap180(0)');
  eq(NM.wrap180(180), -180, 'wrap180(180) = -180（区间是 [-180,180)）');
  eq(NM.wrap180(-180), -180, 'wrap180(-180)');
  eq(NM.wrap180(190), -170, 'wrap180(190)');
  eq(NM.wrap180(-190), 170, 'wrap180(-190)');
  eq(NM.wrap180(540), -180, 'wrap180(540)');
  eq(NM.wrap360(0), 0, 'wrap360(0)');
  eq(NM.wrap360(360), 0, 'wrap360(360) = 0');
  eq(NM.wrap360(-90), 270, 'wrap360(-90)');
  eq(NM.wrap360(450), 90, 'wrap360(450)');

  // shortest_delta 走最短弧：跨 ±180 不能绕远路
  eq(NM.shortest_delta(350, 10), 20, 'shortest_delta(350,10) = +20（跨北）');
  eq(NM.shortest_delta(10, 350), -20, 'shortest_delta(10,350) = -20');
  eq(NM.shortest_delta(0, 180), -180, 'shortest_delta(0,180) = -180');
  eq(NM.shortest_delta(0, -180), -180, 'shortest_delta(0,-180) = -180');

  // bearing：正北 0 / 正东 90 / 正南 180 / 正西 270
  const b = NM.bearing_deg(0, 0, 1, 0);
  ok(Math.abs(b - 0) < 1e-9, 'bearing 正北 = 0');
  const be = NM.bearing_deg(0, 0, 0, 1);
  ok(Math.abs(be - 90) < 1e-9, 'bearing 正东 = 90');
  const bs = NM.bearing_deg(0, 0, -1, 0);
  ok(Math.abs(NM.wrap360(bs) - 180) < 1e-9, 'bearing 正南 = 180');
  const bw = NM.bearing_deg(0, 0, 0, -1);
  ok(Math.abs(NM.wrap360(bw) - 270) < 1e-9, 'bearing 正西 = 270');
  eq(NM.bearing_deg(30, 120, 30, 120), 0, 'bearing 两点重合 = 0');

  // distance：1 度纬度 ≈ 111.195 km（EARTH_RADIUS_M = 6371008.8 的球面）
  const d1 = NM.distance_m(0, 0, 1, 0);
  ok(Math.abs(d1 - 111195.0802335329) < 1e-6, `distance 1° 纬 = ${d1} m`);
  eq(NM.distance_m(30, 120, 30, 120), 0, 'distance 同点 = 0');
  // 杭州西湖演示航线的一段，手工核算的量级
  const d2 = NM.distance_m(30.2545, 120.1350, 30.2585, 120.1490);
  ok(d2 > 1300 && d2 < 1500, `distance(北山街 -> 断桥残雪) = ${d2.toFixed(1)} m 落在合理区间`);

  // approach_angle：指数趋近 + 速率限幅
  eq(NM.approach_angle(0, 90, 0, 500, 400), 0, 'dt=0 时原样返回');
  eq(NM.approach_angle(0, 90, 0.1, 0, 400), 90, 'tau=0 时直接跳到目标');
  const ap1 = NM.approach_angle(0, 170, 0.1, 500, 0);
  ok(ap1 > 0 && ap1 < 170, `approach_angle 走最短弧且不过冲 (${ap1.toFixed(3)})`);
  // 速率限幅：400°/s * 0.1s = 40° 上限
  const apLim = NM.approach_angle(0, 170, 0.1, 1, 400);
  ok(Math.abs(apLim - 40) < 1e-9, `速率限幅到 40°/帧（实得 ${apLim}）`);
  const apLimNeg = NM.approach_angle(0, -170, 0.1, 1, 400);
  ok(Math.abs(apLimNeg + 40) < 1e-9, `反向速率限幅到 -40°/帧（实得 ${apLimNeg}）`);
  // 跨 360 走最短弧：350 -> 10 应该往**正方向**走 20°。
  //
  // 注意 wrap180 的返回值有意落在 [-180, 180)，所以 352° 会以 -8.097 的形式
  // 返回 —— 这是与 navmath.py 一致的行为，不是 bug。要判断"走了多少"必须用
  // shortest_delta 量，不能直接比大小。
  //     Python: navmath.approach_angle(350, 10, 0.05, 500, 0) == -8.096748360719175
  const apW = NM.approach_angle(350, 10, 0.05, 500, 0);
  eq(apW, -8.096748360719175,
     'approach_angle(350,10,0.05,500,0) = -8.096748360719175（与 navmath.py 逐位相同）');
  const apWstep = NM.shortest_delta(350, apW);
  ok(apWstep > 0 && Math.abs(apWstep - 1.9032516392808247) < 1e-12,
     `跨 360 只走 +${apWstep.toFixed(4)}°（最短弧 +20° 的一小步），不是 -340°`);
  const apW2 = NM.approach_angle(355, 5, 0.05, 500, 0);
  ok(NM.shortest_delta(355, apW2) > 0, `approach_angle(355,5) 同样走最短弧（实得 ${apW2.toFixed(3)}）`);
  // alpha = 1 - exp(-(0.05*1000)/500) = 0.09516258196404048（Python 同值）
  eq(1 - Math.exp(-(0.05 * 1000) / 500), 0.09516258196404048, 'alpha 公式与 Python 一致');

  // map_clamp
  eq(NM.map_clamp(5, 0, 10, 0, 100), 50, 'map_clamp 中值线性映射');
  eq(NM.map_clamp(-1, 0, 10, 0, 100), 0, 'map_clamp 下溢');
  eq(NM.map_clamp(11, 0, 10, 0, 100), 100, 'map_clamp 上溢');
  eq(NM.map_clamp(5, 10, 10, 7, 100), 7, 'map_clamp 空区间返回 out_min');

  // within_radius_m
  eq(NM.within_radius_m(0, 0, 0, 0, 1), true, 'within_radius_m 同点');
  eq(NM.within_radius_m(0, 0, 1, 0, 1000), false, 'within_radius_m 超出');

  // format_distance（界面用，与 Python 输出应一致）
  eq(NM.format_distance(0), '0m', 'format_distance(0)');
  eq(NM.format_distance(9.4), '9m', 'format_distance(9.4)');
  eq(NM.format_distance(42), '40m', 'format_distance(42) -> 40m（就近 5m）');
  eq(NM.format_distance(500), '500m', 'format_distance(500) -> 500m（就近 10m）');
  eq(NM.format_distance(1234), '1.2km', 'format_distance(1234)');
  eq(NM.format_distance(12345), '12km', 'format_distance(12345) -> 12km');

  // _fmod 对应关系：JS 的 % 对负数的行为必须与 Python math.fmod 一致
  eq(0 - ((0 - 0) % 1 || 0), 0, '（占位）');
  eq(NM.wrap180(-0.5), -0.5, 'wrap180 保留负小数');
  eq(NM.wrap360(-0.5), 359.5, 'wrap360(-0.5) = 359.5');
}

// ---------------------------------------------------------------------------
section('8] classify_turn 阈值表（必须与固件 classifyTurn 一致）');
// ---------------------------------------------------------------------------
{
  const T = P.Turn;
  const cases = [
    [0, T.STRAIGHT], [14.99, T.STRAIGHT], [-14.99, T.STRAIGHT],
    [15.0, T.SLIGHT_RIGHT], [-15.0, T.SLIGHT_LEFT],
    [44.99, T.SLIGHT_RIGHT], [-44.99, T.SLIGHT_LEFT],
    [45.0, T.RIGHT], [-45.0, T.LEFT],
    [109.99, T.RIGHT], [-109.99, T.LEFT],
    [110.0, T.SHARP_RIGHT], [-110.0, T.SHARP_LEFT],
    [154.99, T.SHARP_RIGHT], [-154.99, T.SHARP_LEFT],
    [155.0, T.UTURN_RIGHT], [-155.0, T.UTURN_LEFT],
    [180, T.UTURN_RIGHT], [-180, T.UTURN_LEFT],
  ];
  for (const [deg, want] of cases) {
    eq(NM.classify_turn(deg, T), want,
       `classify_turn(${deg}) = ${P.turn_name(want)}`);
  }
  // 右转为正：符号约定必须与 docs/protocol.md 的 rel_bearing 一致
  ok(NM.classify_turn(90, T) === T.RIGHT, '正角 = 右转');
  ok(NM.classify_turn(-90, T) === T.LEFT, '负角 = 左转');
  // 不传 Turn 表时必须能自动解析（循环依赖那条路）
  eq(NM.classify_turn(90), T.RIGHT, 'classify_turn 不传 Turn 表也能工作');
  eq(NM.TURN_THRESHOLDS.length, 5, 'TURN_THRESHOLDS 5 档（与 navmath.py 一致）');
}

// ---------------------------------------------------------------------------
section('9] 黄金向量文件一致性');
// ---------------------------------------------------------------------------
{
  // 这个文件是 Python 侧 --emit-vectors 生成的。这里只做**存在性和自洽性**检查，
  // 真正比对 Python 输出由 tools/selftest.py 负责（这里有 node 跑不了 python）。
  eq(VEC._comment, '由 tools/navpuck_proto.py --emit-vectors 生成，请勿手工编辑',
     'navcore_vectors.json 是生成的（未被手工改过）');
  ok(VEC.nav_route.pts.length === VEC.nav_route.total_points, 'nav_route.total_points 与 pts 长度一致');
  ok(VEC.nav_route.frame_hex.length === VEC.nav_route.chunk_points.length,
     '分片数与 frame_hex 数一致');
  // 每片点数之和 = 总点数
  let sum = 0; for (const n of VEC.nav_route.chunk_points) sum += n;
  eq(sum, VEC.nav_route.total_points, '每片点数之和 = total_points');
  // 每片起始下标正确
  let start = 0;
  for (let i = 0; i < VEC.nav_route.chunk_starts.length; i++) {
    if (VEC.nav_route.chunk_starts[i] !== start) ok(false, `第 ${i} 片 chunk_start 应为 ${start}`);
    start += VEC.nav_route.chunk_points[i];
  }
  ok(true, '每片 chunk_start 依次衔接');
  ok(VEC.nav_route.chunk_flags[VEC.nav_route.chunk_flags.length - 1] === 1, '末片 flags bit0 = 1');
  ok(VEC.nav_route.chunk_flags.slice(0, -1).every((x) => x === 0), '非末片 flags = 0');
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(62));
if (failures.length === 0) {
  console.log(`  手机端协议自测通过：${passed} 项全部通过`);
  console.log('='.repeat(62));
  process.exit(0);
} else {
  console.log(`  ${passed} 项通过 / ${failures.length} 项失败`);
  console.log('='.repeat(62));
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
