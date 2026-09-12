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
 *   - 分片大小 = min(MTU - 3, 512)，**并且只从这个上界往回走，从不凭 MTU 直接
 *     取 MTU-3**。512 是 Android 框架在 writeCharacteristic() 里写死的常量，
 *     见下面 MAX_ATTR_VALUE 那一大段（含这台手机 framework-bluetooth.jar 的
 *     字节码证据）—— 旧代码取 517-3 = 514，真机上直接抛异常杀进程；
 *   - 起步值还要更保守（规范默认载荷 20 字节），由 create_chunk_policy 在
 *     **确认成功之后**一档一档往上试，学到的值跨启动落盘。
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

  // ═════════════════════════════════════════════════════════════════════════
  // ⭐ 分片大小的**硬上限**：512（不是 MTU-3！）—— 这是这一版修闪退的核心
  // ═════════════════════════════════════════════════════════════════════════
  /*
   * 现场：Redmi（Android 16 / API 36），`getMtu()` 报 **517**，于是旧代码按
   * "分片 = MTU - 3" 发 **514 字节**，进程当场死掉：
   *
   *   java.lang.IllegalArgumentException:
   *       value should not be longer than max length of an attribute value
   *     at android.bluetooth.BluetoothGatt.writeCharacteristic(BluetoothGatt.java:1731)
   *     at ...bluetoothle.Device.write(Device.kt:590)
   *     at ...bluetoothle.BluetoothLe.writeWithoutResponse(BluetoothLe.kt:705)
   *
   * 这条异常是**同步抛**在插件自己的回调线程上，Capacitor 的桥接层
   * （PluginHandle.invoke -> Bridge.callPluginMethod）没有把它变成 rejected
   * promise，而是让它继续往上冒 —— 于是 **JS 侧 try/catch 根本接不到**，
   * 只能看着 App 消失。所以"分片太大"这一类失败**不可捕获**，唯一的办法是
   * 从一开始就不发出会触发它的长度。
   *
   * 那到底多大算太大？答案是**框架里写死的 512**，与协商到的 MTU 无关。
   * 证据是**这台手机自己的框架字节码**（不是猜、不是网上抄的）：
   *   · 拉出设备上的蓝牙模块
   *       adb pull /apex/com.android.bt/javalib/framework-bluetooth.jar
   *       内层 classes.dex 就是 android.bluetooth.BluetoothGatt 的实现；
   *   · `dexdump -d classes.dex`（tools\.android-sdk\build-tools\35.0.0\dexdump.exe）
   *     在 BluetoothGatt.writeCharacteristic:(Landroid/bluetooth/BluetoothGattCharacteristic;[BI)I
   *     里读到**逐字节**这样的字节码：
   *
   *       0006: if-eqz v8, 00ce        // value == null -> "value must not be null"
   *       0008: array-length v0, v8    // v0 = value.length
   *       0009: const/16 v2, #int 512  // ⭐ 字面量 512
   *       000b: if-gt v0, v2, 00c6     // if (value.length <= 512) 正常往下走
   *       ...
   *       00c8: const-string v2, "value should not be longer than max length of an attribute value"
   *       00cd: throw v0
   *
   *   即 `if (value.length > 512) throw new IllegalArgumentException(...)`。
   *   512 是常量、**不随 MTU 交换刷新**，所以 `getMtu()` 报 517 完全无害，
   *   有害的是拿它去算 `MTU - 3 = 514 > 512`。
   *
   * ⚠️ 常见误解（这份注释就是为了钉死它）：不能写 `mtu - 3`。ATT 载荷上限确实是
   *    MTU-3，但那是**链路**的上限；Android 的 **Java API 还额外压了 512 这道闸**。
   *    真正的安全上界是两者取小：min(MTU - 3, 512)。
   *
   * ⚠️ write 与 writeWithoutResponse 在这件事上**没有区别**：两者在插件里走的是
   *    同一个 Device.write()（BluetoothLe.kt:705 与 :681 都调它），API 33+ 都调
   *    `writeCharacteristic(characteristic, value, writeType)` 这个重载 —— 上面
   *    那段长度检查在这个重载的**最前面**，writeType 只是后面传给 binder 的参数。
   *    所以"换成 write 就没事"是错的：一样抛、一样闪退。
   */
  const MAX_ATTR_VALUE = 512;

  /** 升档阶梯（**升序**）：只在一个尺寸被确认成功之后，才试下一档。 */
  const CHUNK_LADDER_UP = [20, 64, 128, 185, 244, 512];

  /** 学到的分片大小落盘的键（与其它设置同一个命名空间，见 app.js 的 PREF_MAP_KEY）。 */
  const CHUNK_STORE_KEY = 'navpuck.ble.chunk.v1';

  /** 同一档要连续成功多少帧才算"确认"（之后才允许再往上试一档）。 */
  const PROBE_OK_FRAMES = 3;

  /**
   * 这个 MTU 下**可证明安全**的最大分片。
   *
   *   min(MTU - 3, 512)，并且不小于 ATT 默认载荷 20。
   *
   * MTU 未知（null / <23）时**只认默认值 20**：拿不到 MTU 就没有任何证据说明
   * 链路能承载更长的写，而猜错的代价是进程死亡。宁可慢。
   */
  function safe_chunk_max(mtu) {
    const m = (typeof mtu === 'number' && mtu >= 23) ? mtu - 3 : CHUNK_FALLBACK;
    return Math.max(CHUNK_FALLBACK, Math.min(m, MAX_ATTR_VALUE));
  }

  /** 比 size 大的最小一档。没有就 null。 */
  function chunk_next_up(size) {
    for (const c of CHUNK_LADDER_UP) if (c > size) return c;
    return null;
  }

  /** 比 size 小的最大一档。没有就 null。 */
  function chunk_next_down(size) {
    let best = null;
    for (const c of CHUNK_LADDER_UP) if (c < size) best = c;
    return best;
  }

  /** 安全取 localStorage（拿不到就退化成"只活在内存里"，绝不抛）。 */
  function pick_storage(win, given) {
    if (given) return given;
    try {
      const s = win && win.localStorage;
      if (!s) return null;
      const probe = '__navpuck_chunk_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (_e) {
      return null;
    }
  }

  /**
   * ⭐ 自适应分片策略：**从 20 字节起步，只在一个尺寸被确认成功之后才往上试**。
   *
   * 为什么不能"从大到小试"（像 PWA 那条路那样）：
   *   那条路靠的是 promise 被 reject —— 大分片失败会被接住，然后降档重试。
   *   而原生这条路上"分片太大"是**同步抛异常 + 进程死亡**（见 MAX_ATTR_VALUE
   *   那段），失败发生时我们**已经没有任何代码在运行**，接不住、也记不下。
   *   所以探测的方向必须反过来：小 → 大，每一步的"失败"用**下一次启动的黑匣子**
   *   来判定，而不是用 catch。
   *
   * 状态（全部落盘，见 CHUNK_STORE_KEY）：
   *   auto      是否自动升档（UI 上可以锁死在一个保守值）
   *   ceiling   用户允许的上界（UI 可调；崩溃推断也会把它压下来）
   *   learned   **已被确认**的最大分片（连续 PROBE_OK_FRAMES 帧成功）
   *   trial     正在试探的下一档（null = 没有试探在进行）
   *   ok        当前试探已连续成功多少帧
   *   armed     {size, mtu, at} —— "正在试这一档"的落盘记录。
   *             ⚠️ 它在**第一次写这一档之前**就同步落盘。进程如果死在这里，
   *             下次启动看到 armed 还在 + 上一轮没有正常结束 ⇒ 判定这一档致死，
   *             把 ceiling 压到它下面一档并记进 bad。这就是"接不住的失败也能学到"。
   *   bad       被判过致死的档位（只增不减，UI 会显示）
   *
   * 只在内存里的状态：
   *   sess_cap  本会话的上界。某一档被**非致命**拒绝（promise reject）后压到这里，
   *             避免"同一档反复失败"（原生写失败会被 ble.js 降档，但策略自己不该
   *             再往更高处试）。
   */
  function create_chunk_policy(opts) {
    const o = opts || {};
    const win = o.window || (typeof globalThis !== 'undefined' ? globalThis : null);
    const store = pick_storage(win, o.storage);
    const log = o.onLog || (() => {});
    const crash = (o.crash !== undefined) ? o.crash : ((win && win.NavPuckCrash) || null);
    const clock = o.now || (() => Date.now());

    const blank = () => ({
      v: 1, auto: true, ceiling: MAX_ATTR_VALUE, learned: CHUNK_FALLBACK,
      trial: null, ok: 0, armed: null, bad: [],
    });
    let st = blank();
    let sess_cap = MAX_ATTR_VALUE;
    /** 构造时那条"上次崩在分片探测上"的推断结论（给界面/日志用）。 */
    let crash_verdict = null;

    function normalize(d) {
      const out = {
        v: 1,
        auto: (d && d.auto === false) ? false : true,
        ceiling: clamp_int(d && d.ceiling, CHUNK_FALLBACK, MAX_ATTR_VALUE, MAX_ATTR_VALUE),
        learned: clamp_int(d && d.learned, CHUNK_FALLBACK, MAX_ATTR_VALUE, CHUNK_FALLBACK),
        trial: null, ok: 0, armed: null,
        bad: Array.isArray(d && d.bad) ? d.bad.filter((n) => typeof n === 'number') : [],
      };
      const t = d && d.trial;
      if (typeof t === 'number' && t >= CHUNK_FALLBACK && t <= MAX_ATTR_VALUE && out.bad.indexOf(t) < 0) {
        out.trial = t;
        out.ok = clamp_int(d.ok, 0, PROBE_OK_FRAMES, 0);
      }
      const a = d && d.armed;
      if (a && typeof a.size === 'number') {
        out.armed = { size: a.size, mtu: (typeof a.mtu === 'number' ? a.mtu : null), at: a.at || null };
      }
      if (out.learned > out.ceiling) out.learned = out.ceiling;
      return out;
    }

    function clamp_int(v, lo, hi, dflt) {
      const n = (typeof v === 'number' && isFinite(v)) ? Math.round(v) : dflt;
      return Math.max(lo, Math.min(hi, n));
    }

    function load() {
      if (!store) return;
      try {
        const raw = store.getItem(CHUNK_STORE_KEY);
        if (!raw) return;
        const d = JSON.parse(raw);
        if (!d || d.v !== 1) return;
        st = normalize(d);
      } catch (_e) { /* 坏数据就当没有 */ }
    }

    function save() {
      if (!store) return;
      try { store.setItem(CHUNK_STORE_KEY, JSON.stringify(st)); } catch (_e) { /* 配额/权限：忽略 */ }
    }

    /** 上一轮是不是**没有正常结束**。拿不到判据时返回 null（未知）。 */
    function prev_abnormal() {
      try {
        if (crash && typeof crash.status === 'function') {
          const s = crash.status();
          if (s && typeof s.prev_abnormal === 'boolean') return s.prev_abnormal;
        }
      } catch (_e) { /* 忽略 */ }
      return null;
    }

    /**
     * 落盘"正在试这一档" + 同步写一行进崩溃黑匣子（crashlog.marker 是同步落盘的）。
     * ⚠️ 顺序：**先在磁盘上，再去写**。反过来的话进程死掉就什么都不知道了。
     */
    function arm(size, mtu) {
      st.armed = { size: size, mtu: (typeof mtu === 'number' ? mtu : null), at: new Date(clock()).toISOString() };
      save();
      try {
        if (crash && typeof crash.marker === 'function') {
          crash.marker('chunk_probe',
            `size=${size}B mtu=${mtu || '?'} 硬上限=${MAX_ATTR_VALUE} 这一档第一次写之前`);
        }
      } catch (_e) { /* 黑匣子坏了也不能影响探测 */ }
    }

    function clear_arm() {
      if (st.armed) { st.armed = null; save(); }
    }

    // ── 构造时的崩溃推断（这一版"接不住的失败也能学到"的唯一入口）──────────
    function infer_prev_crash() {
      if (!st.armed) return;
      const S = st.armed.size;
      const verdict = prev_abnormal();
      if (verdict === false) {
        // 上一轮是正常结束的 ⇒ 这一档没有把进程弄死，但不代表它成功过（可能
        // 一次都没写到）。只把"正在试"的标记收回来，不作判决。
        st.armed = null;
        log(`原生 BLE：上次退出时正在试 ${S} 字节分片，但上一轮是正常结束的 —— 不作判决，本轮继续试`);
        save();
        return;
      }
      // verdict === true（上次异常结束）或 null（拿不到判据）：**按"就是它"处理**。
      // 方向必须偏保守：判错的代价只是慢，判反的代价是下一次又崩。
      const down = chunk_next_down(S) || CHUNK_FALLBACK;
      if (st.bad.indexOf(S) < 0) st.bad.push(S);
      st.ceiling = Math.max(CHUNK_FALLBACK, Math.min(st.ceiling, down));
      st.learned = Math.min(st.learned, st.ceiling);
      st.trial = null;
      st.ok = 0;
      st.armed = null;
      save();
      crash_verdict = { size: S, ceiling: st.ceiling, certain: verdict === true };
      log(`⛔ 原生 BLE：黑匣子推断 —— 上次运行在 **${S} 字节**分片时崩溃（上一轮没有正常结束）。` +
          `已把分片上限降到 **${st.ceiling} 字节**（这一档不再尝试）。` +
          (verdict === true ? '' : '（拿不到上一轮的结束状态，按最保守处理。）') +
          `如果确认那不是分片的问题，可以在「选项 → BLE 分片」里把上限调回去。`);
    }

    load();
    infer_prev_crash();

    /** 这个 MTU 下允许用到的最大分片（含用户上限、崩溃推断、本会话封顶）。 */
    function limit(mtu) {
      return Math.max(CHUNK_FALLBACK,
        Math.min(st.ceiling, safe_chunk_max(mtu), sess_cap));
    }

    /**
     * 现在该用多大分片。
     *
     * 自动模式：已确认值（或正在试的那一档），再被上限夹住。
     * 锁定模式（auto=false）：**用户选的那个上限**（仍然被 min(MTU-3,512) 夹住）。
     *   锁定的语义就是"我知道该用多少，别替我试" —— 但"第一次用这个尺寸之前
     *   先落盘一笔 armed"仍然照做（见 before_write），所以万一它是致命的，
     *   下次启动照样能推断出来。
     */
    function size(mtu) {
      const lim = limit(mtu);
      if (!st.auto) return lim;
      const base = (st.trial != null) ? st.trial : st.learned;
      return Math.max(CHUNK_FALLBACK, Math.min(base, lim));
    }

    /**
     * ⭐ 真正写出去**之前**调它（transport 在写循环前调用）。
     *
     * 只要"这一帧要用的尺寸还没有被确认过"，就先把 `armed` 同步落盘 —— 这样
     * 即使下一毫秒进程被那条同步异常带走，"我们当时正在试多大"也已经在磁盘上了，
     * 下次启动就能据此降档。这是**唯一**能覆盖"接不住的失败"的手段。
     */
    function before_write(used, mtu) {
      if (!(used > st.learned)) return false;
      if (st.armed && st.armed.size === used) return false;   // 这一档已经记过了
      arm(used, mtu);
      return true;
    }

    /**
     * 一帧**完整写成功**之后调它。返回值说明策略有没有变化（界面/日志用）。
     *
     * ⚠️ 只有"实际用的尺寸 == 策略当前指定的尺寸"才算数：如果 ble.js 中途降过档
     *    （写失败兜底），这一帧的成功说明的是**小尺寸**能成，不是试探档能成。
     */
    function note_success(used, mtu) {
      const cur = size(mtu);
      if (used !== cur) {
        if (st.trial != null) {
          log(`原生 BLE：分片试探中断（上游只让用 ${used} 字节，试探档是 ${st.trial}）—— ` +
              `本次会话不再往上试（不能写超过调用方要求的长度）`);
          st.trial = null; st.ok = 0; clear_arm();
          if (used < sess_cap) sess_cap = used;
          save();
        }
        return { changed: false };
      }
      // 锁定模式：这一档写成功了，直接记为"已确认"（armed 也可以收了）
      if (!st.auto) {
        if (st.learned !== cur) {
          st.learned = cur;
          clear_arm();
          save();
          log(`原生 BLE：锁定分片 ${cur} 字节已被一次成功验证`);
          return { changed: true, event: 'confirm', size: cur };
        }
        return { changed: false };
      }
      if (st.trial != null) {
        st.ok += 1;
        if (st.ok >= PROBE_OK_FRAMES) {
          st.learned = st.trial; st.trial = null; st.ok = 0;
          clear_arm();
          save();
          log(`原生 BLE：分片 **${st.learned} 字节**确认可用（连续 ${PROBE_OK_FRAMES} 帧成功）`);
          return { changed: true, event: 'confirm', size: st.learned };
        }
        save();
        return { changed: false, event: 'probing', size: st.trial, ok: st.ok };
      }
      // 没有试探在跑：往上试下一档（只在不超上限、且没被判过致死时）
      let want = chunk_next_up(st.learned);
      while (want !== null && (want > limit(mtu) || st.bad.indexOf(want) >= 0)) {
        want = chunk_next_up(want);
      }
      if (want === null) return { changed: false };
      st.trial = want; st.ok = 0;
      arm(want, mtu);
      log(`原生 BLE：分片试探 ${want} 字节（当前确认 ${st.learned}；MTU ${mtu || '?'}，` +
          `上界 ${limit(mtu)} = min(MTU-3, ${MAX_ATTR_VALUE})）`);
      return { changed: true, event: 'probe', size: want };
    }

    /**
     * 写失败（promise 被拒 —— 注意：**致命的那类根本不会走到这里**）。
     * 这一档本会话不再往上试，退回到已确认的尺寸。
     */
    function note_failure(used, mtu) {
      const s = (typeof used === 'number' && used > 0) ? used : size(mtu);
      const down = chunk_next_down(s) || CHUNK_FALLBACK;
      if (down < sess_cap) sess_cap = down;      // 本次会话不再往 this 之上试
      if (st.trial != null) {
        log(`原生 BLE：分片试探 ${st.trial} 字节被拒（非致命）→ 本次会话封顶在 ${sess_cap} 字节`);
        st.trial = null; st.ok = 0; clear_arm(); save();
      }
      return { changed: true, event: 'reject', size: size(mtu) };
    }

    /** 用户改了上界（UI）：0/自动之外的值都夹到合法范围。 */
    function set_ceiling(n) {
      st.ceiling = clamp_int(n, CHUNK_FALLBACK, MAX_ATTR_VALUE, MAX_ATTR_VALUE);
      st.learned = Math.min(st.learned, st.ceiling);
      st.trial = null; st.ok = 0;
      sess_cap = MAX_ATTR_VALUE;
      clear_arm();
      save();
      log(`原生 BLE：分片上限设为 ${st.ceiling} 字节（已确认 ${st.learned}）`);
      return st.ceiling;
    }

    function set_auto(on) {
      st.auto = !!on;
      st.trial = null; st.ok = 0;
      sess_cap = MAX_ATTR_VALUE;
      clear_arm();
      save();
      log(`原生 BLE：自动升档 ${st.auto ? '开' : '关'}（关 = 锁在 ${Math.min(st.ceiling, MAX_ATTR_VALUE)} 字节以内）`);
      return st.auto;
    }

    /** 忘了学到的东西（换设备/换固件后用户自己按）。 */
    function reset() {
      st = blank();
      sess_cap = MAX_ATTR_VALUE;
      save();
      log(`原生 BLE：分片学习记录已清空（回到 ${CHUNK_FALLBACK} 字节起步）`);
    }

    function snapshot() {
      return {
        key: CHUNK_STORE_KEY,
        max_attr: MAX_ATTR_VALUE,
        ladder: CHUNK_LADDER_UP.slice(),
        auto: st.auto,
        ceiling: st.ceiling,
        learned: st.learned,
        trial: st.trial,
        ok: st.ok,
        armed: st.armed ? Object.assign({}, st.armed) : null,
        bad: st.bad.slice(),
        sess_cap: sess_cap,
        crash_verdict: crash_verdict ? Object.assign({}, crash_verdict) : null,
        has_storage: !!store,
      };
    }

    return {
      KEY: CHUNK_STORE_KEY, MAX_ATTR_VALUE, CHUNK_MIN: CHUNK_FALLBACK, PROBE_OK_FRAMES,
      max_safe: safe_chunk_max, limit, size, note_success, note_failure,
      set_ceiling, set_auto, reset, snapshot,
      before_write,
      _state: () => JSON.parse(JSON.stringify(st)),
    };
  }

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
   *   chunk_size_hint     ble.js 用它初始化分片大小（**永远 <= min(MTU-3, 512)**）
   *   chunk_policy        自适应分片策略（见 create_chunk_policy）
   *   onChunkSize         分片大小变化时的回调（app.js 用它把 ble.js 对齐）
   *   connect()           扫描 + 连接 + 发现服务 + 订阅通知
   *   disconnect()        断开（不触发 onDisconnected 回调，因为是用户主动的）
   *   write_frame(bytes, size)  一整帧，内部按安全界分片；失败就抛
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
      /**
       * ⭐ 分片策略（见上面 create_chunk_policy 那一大段）。app.js 会把自己造好的
       *    那个注入进来（界面要改它的上限）；没注入就在这里自己造一个。
       *
       * 起始分片**不是** MTU-3，而是一个**可证明安全**的值：
       *   新装 = 20 字节（规范默认 ATT 载荷），之后每确认一档往上走一格。
       *   为什么不信 MTU-3：见 MAX_ATTR_VALUE 那段 —— 它是这一版闪退的根因。
       */
      this.chunk_policy = o.chunk_policy || create_chunk_policy({
        window: this.win,
        onLog: (l) => this.log(l),
      });
      this.chunk_size_hint = this.chunk_policy.size(this.transport_mtu);
      /** 分片大小真的变了时通知外部（app.js 用它把 ble.js 的 chunk_size 对齐）。 */
      this.onChunkSize = o.onChunkSize || null;
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
      /** "首片就写失败 = 程序错误"这条日志只解释一次（见 _note_write_failure）。 */
      this._prog_error_reported = false;
      /** "第一次真的写下去"那条崩溃黑匣子记录只写一次（见 write_frame）。 */
      this._first_write_marked = false;
      /** 通知事件名的三个 handle（真名字 + 两个退路，见 _connect_and_subscribe）。 */
      this._notify_handles = [];
      this._notify_src = null;

      /** 收到通知时把 DataView / 十六进制字符串转成 Uint8Array。 */
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

      /**
       * 通知来源去重（见 _connect_and_subscribe 里那段"事件名不是 onNotification"）。
       *
       * 我们同时挂了真名字 `notification|<deviceId>|<service>|<char>` 和两个历史
       * 名字；哪个先真的送来数据，就以哪个为准，其余来源一律忽略 —— 否则同一个
       * 字节流会被喂进 FrameParser 两遍，症状是"每帧都解析失败"（两帧粘一起）。
       */
      this._notify_dispatch = (src, ev) => {
        if (this._notify_src === null) {
          this._notify_src = src;
          if (src !== `notification|${this.device_id}|${NUS_SERVICE}|${NUS_TX}`) {
            this.log(`原生 BLE：通知事件名实际是 "${src}"（不是预期的 notification|… key）—— 已按它接收`);
          }
        }
        if (this._notify_src !== src) return;
        this._on_notify_ev(ev);
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
          // ⚠️ 不是 mtu-3！真机闪退的根因就是这一行写成 mtu-3（517-3=514 > 512，
          //    Android 14+ 直接抛异常杀进程）。上界 = min(MTU-3, 512)。
          this.chunk_size_hint = this.chunk_policy.size(this.transport_mtu);
          this.log(`原生 BLE：协商 MTU=${mtu}，分片按 ${this.chunk_size_hint} 字节` +
                   `（可证明上界 = min(MTU-3=${mtu - 3}, 硬上限 ${MAX_ATTR_VALUE}) = ` +
                   `${safe_chunk_max(mtu)}；当前已确认 ${this.chunk_policy.snapshot().learned}` +
                   `${this.chunk_policy.snapshot().auto ? '，会自动往上试' : '，自动升档已关'}）`);
        } else {
          // 拿不到 MTU：没有证据说明链路能承载长写，只认规范默认载荷 20 字节。
          this.chunk_size_hint = this.chunk_policy.size(null);
          this.log(`原生 BLE：MTU 拿不到（getMtu 返回 ${mtu === undefined ? 'undefined' : mtu}）` +
                   `→ 分片按规范默认 ${this.chunk_size_hint} 字节（不猜大：猜错的代价是进程死亡）`);
        }
      } catch (e) {
        this.log(`原生 BLE：MTU 协商/读取失败（退到规范默认分片）：${e}`);
        this.transport_mtu = null;
        this.chunk_size_hint = this.chunk_policy.size(null);
      }

      this.log('原生 BLE：发现服务…');
      await p.discoverServices({ deviceId: this.device_id });

      // 订阅 TX（设备 -> 手机）。来的是一条连续字节流，帧边界仍由
      // proto.FrameParser 在 ble.js 里找 —— 这里只负责把字节递上去。
      //
      // ⚠️⚠️ 事件名**不是** 'onNotification'（这一版修的第二个真机 bug）
      // ────────────────────────────────────────────────────────────────────
      // 插件的 native 侧（BluetoothLe.kt 的 startNotifications，第 766-777 行）
      // 推事件时用的名字是拼出来的 key：
      //     notifyListeners("notification|$deviceId|$service|$characteristic", ret)
      // 而 **不是** 固定名 'onNotification'。对照它自己的高层封装
      // （dist/esm/bleClient.js:287 的 startNotifications）就能看到：
      //     const key = `notification|${deviceId}|${service}|${characteristic}`;
      //     const listener = await BluetoothLe.addListener(key, cb);
      // 也就是说 addListener 的名字必须**逐字**等于那个 key。
      //
      // 旧代码订阅的是 'onNotification' / 'onCharacteristicChanged'，两个都
      // 永远收不到东西 —— 症状是"手机能连上、能写、但**设备永远像哑巴**"：
      // PUCK_STATUS（电量/状态）、PUCK_EVENT（按键/滑动）、PING、NAV_TEXT
      // 一个都到不了页面，日志里一片安静，看起来像设备没发。而它其实一直在发。
      //
      // 三种名字都挂上：真名字优先，老版本插件（或未来的改名）走退路。
      // _notify_dispatch 保证**只有第一个真的送来数据的来源被采纳**，所以
      // 即使某个版本同时触发两个名字，也不会把同一条通知喂给解析器两遍。
      const notify_key = `notification|${this.device_id}|${NUS_SERVICE}|${NUS_TX}`;
      this._notify_handles = [];
      this._notify_src = null;
      for (const name of [notify_key, 'onNotification', 'onCharacteristicChanged']) {
        try {
          const h = await p.addListener(name, (ev) => this._notify_dispatch(name, ev));
          if (h) this._notify_handles.push(h);
          if (name === notify_key) this._notify_handle = h || null;
        } catch (e) {
          this.log(`原生 BLE：订阅 ${name} 失败（继续试下一个名字）：${e}`);
        }
      }
      if (!this._notify_handles.length) {
        this.log('⚠️ 原生 BLE：一个通知事件名都没订阅上 —— 设备上行数据收不到（ID 字段/服务 UUID 不对？）');
      }

      await p.startNotifications({ deviceId: this.device_id, service: NUS_SERVICE, characteristic: NUS_TX });

      this.connected = true;
      this.log(`原生 BLE：已连接 ${this.device_name}，TX 通知已订阅（事件名 ${notify_key}）`);
    }

    async disconnect() {
      this._manual_close = true;
      this.connected = false;
      // 三个通知事件名（真名字 + 两个退路）都要摘干净：留着"下一个连接也会被
      // 旧 handle 接走"，症状是重连之后同一个字节流被处理两遍。
      const handles = (this._notify_handles || []).slice();
      if (this._notify_handle) handles.push(this._notify_handle);
      for (const h of handles) {
        try {
          if (h && h.remove) await h.remove();
        } catch (e) { this.log(`原生 BLE：取消通知订阅失败（忽略）：${e}`); }
      }
      this._notify_handles = [];
      this._notify_handle = null;
      this._notify_src = null;
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
     * 崩溃黑匣子：把一句话同步写进 localStorage + 原生 crash.log（见
     * phone/crashlog.js 的 marker()）。PWA 里也有这个模块，只是没有原生那一段。
     *
     * ⚠️ 频度必须极低（同步 IO）：这里只在"第一次写"这种一次性节点上调用。
     */
    _crash_marker(kind, data) {
      try {
        const C = this.win && this.win.NavPuckCrash;
        if (C && typeof C.marker === 'function') C.marker(kind, data);
      } catch (e) { /* 诊断绝不能反过来影响链路 */ }
    }

    /**
     * 写一整帧。按当前分片大小切，一片一片 await。
     *
     * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     * ⚠️ 这里唯一能传的载荷形式是**十六进制字符串**（不是 DataView！）
     * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     * 这一版真机上"每一片都写失败：Value required."的根因就在这一行。
     * 插件有两层，我们拿到的是**底层**那层（cap.Plugins.BluetoothLe），
     * 底层只认字符串；DataView 的自动转换是**高层** BleClient 做的：
     *
     *   · 高层 dist/esm/bleClient.js:221-236 `write()` 与
     *     238-253 `writeWithoutResponse()` —— 两者**完全一致**：
     *         writeValue = dataViewToHexString(value);      // 仅 native 分支
     *         await BluetoothLe.writeWithoutResponse(
     *             Object.assign({ deviceId, service, characteristic,
     *                             value: writeValue }, options));
     *     即字段名就是 **`value`**（**不是** `writeValue`；`writeValue` 只是
     *     它内部的局部变量），编码是 conversion.js:53-63 的
     *     `dataViewToHexString()` —— 每字节两位小写十六进制、**无分隔符**
     *     （例：`[0x0a,0x1b]` -> `"0a1b"`）。写特征值和写描述符（268-286）
     *     用的是同一套。
     *   · 底层 android/.../BluetoothLe.kt:674 `val value = call.getString("value", null)`
     *     （write）与 :698（writeWithoutResponse），拿不到字符串就
     *     reject("Value required.")（:675-678 / :699-702）。writeDescriptor
     *     同理，在 :742-746。
     *   · 到底什么才算"拿不到字符串"：Capacitor 的 PluginCall.getString(key,def)
     *     是 `data.opt(key)`，然后 `instanceof String ? 值 : def`（本次用
     *     javap 逐条核对过 @capacitor/android 的 PluginCall.class 字节码）。
     *     而 JSON.stringify(new DataView(...)) === "{}"（DataView 没有 toJSON），
     *     所以旧代码传过去的 `value: DataView` 到了 native 侧就是一个**空对象**，
     *     instanceof String 为假 -> 返回默认值 null -> "Value required."。
     *     这与分片大小无关，所以 512/244/…/20 全都会失败 —— 日志里那条
     *     "每个 MTU 都写不通"的降档阶梯完全是这个类型错误的假象。
     *   · 字节最终由 Conversion.kt:28-39 `stringToBytes()` 还原：要求**偶数长度**、
     *     两个字符一个字节、`Character.digit(c,16)` 解（大小写都吃）。
     *     所以 u8_to_hex_string() 必须每字节补足两位（0x05 -> "05"），
     *     否则长度一变，后面的字节全部错位。
     *
     * 为什么不用高层 BleClient（虽然它"帮你转换"）：
     *   1) 这里拿到的是 `cap.Plugins.BluetoothLe`（ble_native.js 的 pick_plugin()），
     *      它就是**插件自己 registerPlugin('BluetoothLe') 注册的那个底层代理**
     *      （dist/esm/plugin.js:2）；BleClient 是 dist/esm 里的 **ESM 模块**，
     *      而 phone/ 这几个文件是直接 <script> 加载的 UMD 经典脚本，没有打包器 ——
     *      引入它等于为了一个十行的十六进制转换把构建链整个改掉；
     *   2) BleClient 的每个方法都走它自己的串行队列（dist/esm/queue.js），
     *      和我们这边"一片一片 await"的顺序语义叠在一起没有收益，只有风险。
     *   选底层 + 自己按同一个约定编码，是改动最小、且能对着 native 源码逐行
     *   核对的那条路；编码实现和 bleClient.js 的 dataViewToHexString 是等价算法。
     *
     * 失败一律**抛异常**，让 ble.js 的 _write_frame 走它既有的
     * "整帧作废 + 降档重试"逻辑 —— 分帧正确性只有一处实现（ble.js），
     * 这里不重复一遍，免得两边策略漂移。
     */
    async write_frame(bytes, chunk_size) {
      const p = this.plugin;
      // ⭐ 三道闸，取最小：
      //   ① chunk_size       —— ble.js 传进来的（它负责降档兜底）
      //   ② 策略当前指定值   —— 自适应探测（<= 已确认值 / 正在试的那一档）
      //   ③ min(MTU-3, 512)  —— **可证明安全**的上界（512 是框架硬常量，见 MAX_ATTR_VALUE）
      // ③ 是"再也不能闪退"的保证：无论上游传什么（哪怕是 99999），送到插件的
      // 每一片都不会超过它。测试里对这一点有专门的模糊用例。
      const cap = this.chunk_policy.size(this.transport_mtu);
      const requested = chunk_size || this.chunk_size_hint || cap;
      let size = Math.max(1, Math.min(requested, cap));
      // 双保险：即使策略/MTU 全被写坏，也绝不越过框架常量。
      if (size > MAX_ATTR_VALUE) size = MAX_ATTR_VALUE;
      // hint 永远等于"这一帧实际用的上界"，别让外部读到一个过期的更大值。
      this._sync_hint();
      if (!this.connected || !this.device_id) throw new Error('原生链路未连接');
      // ⭐ 致命失败唯一能留下的东西：**写之前**先把"正在试多大"同步落盘。
      //    （自动模式下试探档是在上一帧成功之后落的；锁定模式靠这里现落。）
      this.chunk_policy.before_write(size, this.transport_mtu);

      for (let i = 0; i < bytes.length; i += size) {
        const chunk = bytes.subarray(i, Math.min(i + size, bytes.length));
        // 崩溃黑匣子：**第一次真的要写出去之前**同步记一笔（见 docs/android.md §8）。
        // 这一行回答的正是"闪退是不是发生在第一次大写入上"：写了多大、分成几片、
        // 协商到的 MTU 是多少。只记一次（每秒都在发帧，记多了会把现场挤掉）。
        if (!this._first_write_marked) {
          this._first_write_marked = true;
          this._crash_marker('first_write',
            `frame=${bytes.length}B 片=${chunk.length}B/${size} mtu=${this.transport_mtu || '?'} ` +
            `cap=${cap}B 策略=${this.chunk_policy.snapshot().learned}/${this.chunk_policy.snapshot().ceiling} ` +
            `hex=${u8_to_hex_string(chunk).length}字符`);
        }
        const args = {
          deviceId: this.device_id,
          service: NUS_SERVICE,
          characteristic: NUS_RX,
          value: u8_to_hex_string(chunk),   // 见上面那段：native 只认十六进制字符串
        };
        // Write Without Response 是首选：设备 RX 两个属性都支持（docs/ble.md），
        // 而 with-response 每个分片都要等一个 ATT 确认，1.4KB 底图会慢好几倍。
        //
        // ⚠️ 但**长度这道闸与 writeType 无关**：插件里 write 与 writeWithoutResponse
        //    走的是同一个 Device.write()，API 33+ 都调
        //    writeCharacteristic(characteristic, value, writeType)，而 512 的长度检查
        //    在那个重载的最前面（见 MAX_ATTR_VALUE 的字节码证据）。所以"换成 write
        //    就不会超长异常"是错的。
        try {
          if (typeof p.writeWithoutResponse === 'function') {
            await p.writeWithoutResponse(args);
          } else {
            await p.write(args);
          }
        } catch (e) {
          // 能走到这里说明**没有**触发那条同步致命异常（长度已经在安全界内），
          // 属于可捕获的失败：让策略本会话不再往上试，然后交给 ble.js 的降档。
          this.chunk_policy.note_failure(size, this.transport_mtu);
          this._sync_hint();
          this._note_write_failure(e, chunk.length, size);
          throw e;
        }
      }
      // 整帧成功：喂给策略（只有"用的是策略指定的那一档"才会被计入升档）
      const r = this.chunk_policy.note_success(size, this.transport_mtu);
      if (r && r.changed) this._announce_chunk(r);
      else this._sync_hint();
      return true;
    }

    /** 把 chunk_size_hint 对齐到策略当前值（外部读到的永远是"现在最多写多少"）。 */
    _sync_hint() {
      this.chunk_size_hint = this.chunk_policy.size(this.transport_mtu);
      return this.chunk_size_hint;
    }

    /**
     * 分片大小变了：把 hint 同步给 ble.js（它的 chunk_size 决定每帧切几片、
     * 以及降档的起点），并通知外部（app.js 会把它落到界面上）。
     *
     * ⚠️ 这里只改**运行时的值**，ble.js 一行代码都没动（队列/解析器/降档逻辑
     *    原封不动）。ble.js 本来就会在 connect 时从 transport.chunk_size_hint
     *    取值、在降档时回写，这里走的是同一条既有契约。
     */
    _announce_chunk(r) {
      const s = this._sync_hint();
      if (this.onChunkSize) {
        try { this.onChunkSize(s, r, this.chunk_policy.snapshot()); } catch (e) { /* 界面不能反过来影响链路 */ }
      }
      this._crash_marker('chunk_size', `size=${s}B event=${r.event} mtu=${this.transport_mtu || '?'}`);
    }

    /**
     * 写失败发生在**第一次尝试**（也就是当前允许的最大分片）时，要说清楚它到底是
     * 哪一类 —— 不然日志会把人引到"信号/距离/设备"上去查。
     *
     * ⚠️ 这一版重写过：旧版本一口咬定"首片被拒 = 程序错误（编码/字段名）"，
     *    那是因为当时超长写是**同步抛异常杀进程**，根本走不到 catch。现在长度已经被
     *    min(MTU-3, 512) 夹住了，能走到这里的失败有三种，必须分开说：
     *      ① 长度超过框架硬上限 512 —— 理论上不可能（有夹取 + 双保险），出现就是本文件的 bug；
     *      ② 长度超过 MTU-3 —— 说明 getMtu() 报的值与真实链路不一致；
     *      ③ 长度合法 —— 那就是链路/外设侧的问题（接收环满、丢包、对端拒绝），
     *         这种情况下 ble.js 的降档阶梯是真有用的。
     */
    _note_write_failure(e, chunk_len, size) {
      if (this._prog_error_reported) return;
      this._prog_error_reported = true;
      const mtu = this.transport_mtu || 0;
      const cap = safe_chunk_max(this.transport_mtu);
      let why;
      if (chunk_len > MAX_ATTR_VALUE) {
        why = `⛔ 这一片 ${chunk_len} 字节**超过框架硬上限 ${MAX_ATTR_VALUE}** —— ` +
              `这是本文件的 bug（夹取逻辑被绕过了），请把它报上来。`;
      } else if (mtu >= 23 && chunk_len > mtu - 3) {
        why = `⚠️ 这一片 ${chunk_len} 字节超过 MTU-3=${mtu - 3} ——` +
              `getMtu() 报的值与真实链路不一致（插件在服务发现后就发起过 MTU 交换，` +
              `读到的可能是那次的值）。`;
      } else {
        why = `这一片 ${chunk_len} 字节在安全界内（<= min(MTU-3, ${MAX_ATTR_VALUE}) = ${cap}），` +
              `所以不是"分片太大"，更像链路/外设侧的问题（对端接收环满、丢包、` +
              `或对端本次没订上通知）。ble.js 的降档重试在这种情况是真有用的。`;
      }
      this.log(`⚠️ 原生 BLE：写 ${chunk_len} 字节（策略上界 ${cap}，MTU ${mtu || '?'}）失败：${e}。${why}`);
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

  /**
   * 插件返回的**字符串**值 -> Uint8Array。
   *
   * ⚠️⚠️ 这一版修的第三个真机 bug：通知/读取回来的值是**十六进制字符串**，
   *      而不是 DataView。
   * ─────────────────────────────────────────────────────────────────────────
   * 证据（读的是这个 APK 里装的 8.3.0 的源码，不是猜）：
   *   · native 侧 Device.kt 的 onCharacteristicChanged 里
   *       `val value = bytesToString(data)` -> Conversion.kt:24-26 的
   *       `bytes.toHexString()`：**每字节两位、大写、无分隔符**（HEX_LOOKUP_TABLE）；
   *   · 然后 BluetoothLe.kt:766-773 把它塞进 `ret.put("value", …)` 推给 JS；
   *   · 插件自己的高层封装正是这么处理的：bleClient.js 的
   *       `convertValue(value) { if (typeof value === 'string') return
   *       hexStringToDataView(value); … }`（同一文件最末尾）。
   *     也就是说"字符串 -> 字节"这一步是**调用方**的责任，而 ble_native.js
   *     用的是**底层**代理（cap.Plugins.BluetoothLe），所以这一步得自己做。
   *
   * 旧代码没做：字符串会落到下面 `typeof v.length === 'number'` 那一支上，
   * 被 `Uint8Array.from("A55A0104…")` 当成"字符数组"处理 —— 十六进制**字母**
   * 转数字是 NaN -> 0，数字位则被当成十进制。结果是一串既不是原字节、也永远
   * 匹配不上帧头 0xA5 的垃圾：**设备上行整条链路静默失效**（PUCK_STATUS 的
   * 电量、按键/滑动事件、PING 全部收不到），而手机侧看起来只是"设备没说话"。
   *
   * ⚠️ 与 base64 的歧义：一个"恰好全是十六进制字符且长度为偶数"的 base64 串会
   *    被这里判成 hex。这个取舍是有意的 —— 本 APK 装的插件版本只会发大写 hex
   *    （上面那三处源码就是证据），而 base64 是**老版本/参考实现**的传法；
   *    两者不可能同时出现在同一条链路上。自测里两种编码都钉住了。
   */
  function decode_string_value(s) {
    const clean = String(s).trim();
    if (clean.length > 0 && clean.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(clean)) {
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) {
        const hi = parseInt(clean[i * 2], 16);
        const lo = parseInt(clean[i * 2 + 1], 16);
        if (hi !== hi || lo !== lo) return base64_to_u8(clean);   // NaN：当作 base64
        out[i] = (hi << 4) | lo;
      }
      return out;
    }
    return base64_to_u8(clean);
  }

  /** 原生插件回值可能是 DataView 或 {buffer,byteOffset,byteLength} 或数组或字符串。 */
  function data_view_to_u8(v) {
    if (v instanceof Uint8Array) return v;
    if (typeof DataView !== 'undefined' && v instanceof DataView) {
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (v && v.buffer instanceof ArrayBuffer) {
      return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength || v.buffer.byteLength);
    }
    if (Array.isArray(v)) return Uint8Array.from(v);
    // ⚠️ 字符串必须**先于** `typeof v.length === 'number'` 处理：字符串也有
    //    .length，落到那一支就会被 Uint8Array.from 按字符拆成 [0,5,5,0,…]。
    if (typeof v === 'string') return decode_string_value(v);
    if (v && typeof v.length === 'number') return Uint8Array.from(v);
    // 走到这里说明是不认识的形式；按 base64 再试一次（老插件的传法）
    return base64_to_u8(String(v));
  }

  /**
   * ⚠️ DataView **只能用于收**（收回来的是 DataView / Uint8Array / **十六进制
   * 字符串**，见 data_view_to_u8）。送出去的值必须是下面那个十六进制字符串 ——
   * 原因写在 write_frame 的注释里（旧代码在这里把 DataView 当写载荷传下去，
   * 真机上就是 "Value required."）。
   */
  function u8_to_data_view(u8) {
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  /** 十六进制字符表（大写，与插件 native 侧 Conversion.kt 的 HEX_LOOKUP_TABLE 一致）。 */
  const HEX_CHARS = '0123456789ABCDEF';

  /**
   * Uint8Array -> 十六进制字符串，每字节**补齐两位**、无分隔符。
   *
   * 等价于插件高层的 conversion.js:53-63 `dataViewToHexString()`（那一个用小写，
   * 但 native 的 `Character.digit(c,16)` 大小写都认，见 Conversion.kt:41-50）。
   * 补零是**必须**的：`stringToBytes()` 按"每两个字符一个字节"切
   * （Conversion.kt:32-38），少一位就从这里开始全部错位 —— 而且不会报错，
   * 只会把乱码写进设备，是比"写失败"更难查的一种失败。
   */
  function u8_to_hex_string(u8) {
    const out = new Array(u8.length);
    for (let i = 0; i < u8.length; i++) {
      const b = u8[i];
      out[i] = HEX_CHARS[(b >> 4) & 0x0f] + HEX_CHARS[b & 0x0f];
    }
    return out.join('');
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
    // ⭐ 分片安全界 + 自适应策略（见文件前半段那一大段注释；测试逐条钉住）
    MAX_ATTR_VALUE, CHUNK_LADDER_UP, CHUNK_STORE_KEY, PROBE_OK_FRAMES,
    safe_chunk_max, chunk_next_up, chunk_next_down, create_chunk_policy,
    SCAN_WINDOW_MS, SCAN_MODE_LOW_LATENCY, NAME_PREFIX,
    ERR_PERMISSION, ERR_ADAPTER_OFF, ERR_NO_DEVICE, ERR_SCAN_FAILED,
    find_capacitor, pick_plugin, available,
    NativeTransport,
    _base64_to_u8: base64_to_u8,
    _data_view_to_u8: data_view_to_u8,
    _u8_to_hex_string: u8_to_hex_string,
    _perm_get: perm_get,
    _perm_dump: perm_dump,
    _pick_device: pick_device,
  };
}));
