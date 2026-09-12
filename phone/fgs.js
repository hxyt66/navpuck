/*
 * NavPuck —— 前台服务 / 后台存活探针的页面侧封装。
 *
 * phone/ 是唯一真源：这份代码同时跑在 PWA 和 APK 里。在浏览器里它必须
 * **完全无声**：所有方法都返回 {available:false} 之类的中性值，一个异常都不抛，
 * 也不注册任何定时器。这样 PWA 的行为和加这个文件之前一模一样。
 *
 * 它包的是原生插件 NavPuckFgsPlugin（见
 * android/android/app/src/main/java/dev/navpuck/app/NavPuckFgsPlugin.java）：
 * 前台服务本身 + "WebView 后台还活着吗"的探针。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 为什么需要一个前台服务（用户的原话）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * "弄这个就是为了不用骑车时候手机常亮" —— 手机揣兜里、屏幕熄灭，ESP32 那块屏继续导航。
 * 浏览器做不到：后台标签被限流到 ~1Hz、还可能被整个冻结。Android 上唯一被系统
 * 承认的后台存活机制就是前台服务 + 常驻通知。
 *
 * ⚠️ 但前台服务只解决"进程别被杀"。WebView 里的 10Hz 循环会不会继续跑是
 *    **另一件事**，只能实测。本模块的探针就是那把尺子，结论见 docs/android.md。
 */

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.NavPuckFgs = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /** 找 Capacitor 桥；不在壳里就返回 null。 */
  function find_capacitor(win) {
    const w = win || (typeof globalThis !== 'undefined' ? globalThis : null);
    if (!w || !w.Capacitor) return null;
    const c = w.Capacitor;
    if (typeof c.isNativePlatform === 'function') return c.isNativePlatform() ? c : null;
    if (typeof c.isNative === 'boolean') return c.isNative ? c : null;
    return c.Plugins ? c : null;
  }

  function find_plugin(win) {
    const c = find_capacitor(win);
    if (!c || !c.Plugins) return null;
    return c.Plugins.NavPuckFgs || c.Plugins.navPuckFgs || null;
  }

  /** 本环境有没有前台服务能力（= 在 NavPuck 的 APK 里）。 */
  function available(win) {
    return !!find_plugin(win);
  }

  /**
   * 前台服务的页面侧句柄。
   *
   *   await fgs.start()          起服务（内部会请求定位/通知权限）
   *   await fgs.stop()           停服务
   *   await fgs.state()          服务状态 + 原生秒针 + 探针计数
   *   await fgs.probe_start()    开始"JS 还在跑吗"的探针
   *   await fgs.probe_stop()
   *   await fgs.probe_report()   拉一次探针读数
   *   fgs.on_probe(cb)           原生每秒推上来的探针事件（页面被冻时收不到，这本身也是证据）
   *   await fgs.metronome_start() 让**原生**当节拍器：每 100ms 调一次页面里的
   *                               window.__navpuckNativeTick()（= 10Hz 循环本体）
   *   await fgs.metronome_stop()
   *   await fgs.metronome_stats() 一次拿齐原生/页面两侧的判读读数
   *   ForegroundService.metronome_verdict(prev, cur)  纯函数：增量 -> 一句话结论
   */
  class ForegroundService {
    constructor(opts) {
      const o = opts || {};
      this.win = o.window || (typeof globalThis !== 'undefined' ? globalThis : null);
      this.plugin = find_plugin(this.win);
      this.onLog = o.onLog || (() => {});
      this.onProbe = o.onProbe || (() => {});
      this.onStateChange = o.onStateChange || (() => {});
      this.running = false;
      this._probe_listener = null;
      this.last_state = null;
      this.probe_samples = [];
    }

    static available(win) { return available(win); }

    get available() { return !!this.plugin; }

    /** 起前台服务。返回 {running, locationGranted, notificationsGranted}。 */
    async start() {
      if (!this.plugin) return { available: false, running: false };
      try {
        const r = await this.plugin.startService();
        this.running = !!(r && r.running);
        // 权限被拒要明说：没有通知权限时常驻通知不显示，部分 ROM 会因此把进程
        // 当普通后台进程回收 —— 那正好会让"熄屏后还在跑吗"这个问题变成"否"。
        if (r && (!r.locationGranted || !r.notificationsGranted)) {
          this.onLog(`⚠️ 前台服务已起，但权限不全：定位=${r.locationGranted ? '有' : '无'}，` +
                     `通知=${r.notificationsGranted ? '有' : '无'}（通知被拒时后台存活概率会下降）`);
        }
        this.onStateChange(this.running);
        return Object.assign({ available: true }, r);
      } catch (e) {
        // 最常见的失败：Android 14+ 只在 App 处于前台时允许启动 location 类型
        // 的前台服务。这个错误必须原样告诉用户，否则表现为"服务莫名其妙没起"。
        this.onLog(`❌ 前台服务启动失败：${e && e.message ? e.message : e}`);
        this.onStateChange(false);
        throw e;
      }
    }

    async stop() {
      if (!this.plugin) return { available: false, running: false };
      try {
        await this.probe_stop();
        const r = await this.plugin.stopService();
        this.running = false;
        this.onStateChange(false);
        return Object.assign({ available: true }, r);
      } catch (e) {
        this.onLog(`停止前台服务失败：${e}`);
        throw e;
      }
    }

    /** 原生侧状态 + 两个秒针（hb=进程活着，probe=JS 定时器活着）。 */
    async state() {
      if (!this.plugin) return { available: false };
      try {
        const s = await this.plugin.getState();
        this.last_state = s;
        return Object.assign({ available: true }, s);
      } catch (e) {
        this.onLog(`读取前台服务状态失败：${e}`);
        return { available: true, error: String(e) };
      }
    }

    /**
     * 装探针 + 让原生每秒戳一次 WebView。
     *
     * 探针在页面里做两件事（脚本在原生侧，见 NavPuckFgsPlugin 的 PROBE_INSTALL_JS）：
     *   1. 嵌套 setTimeout 每 100ms 自增 ticks（10Hz 循环的"最坏情况"代理）
     *   2. setInterval 每 1000ms 自增 ivTicks
     *   3. 记录 >250ms 的间隔（gaps）：被限流/冻结的**幅度**比"停了"这个二值
     *      信息有用得多 —— 卡 300ms 和卡 5 分钟是完全不同的两件事。
     */
    async probe_start() {
      if (!this.plugin) return { available: false };
      // 先挂监听，再让原生开工，免得漏掉第一批事件
      if (!this._probe_listener && this.plugin.addListener) {
        try {
          this._probe_listener = await this.plugin.addListener('probe', (data) => {
            this.probe_samples.push(data);
            if (this.probe_samples.length > 300) this.probe_samples.shift();
            try { this.onProbe(data); } catch (e) { this.onLog(`探针回调抛错：${e}`); }
          });
        } catch (e) {
          this.onLog(`订阅探针事件失败（不影响探针本身）：${e}`);
        }
      }
      const r = await this.plugin.probeStart();
      return Object.assign({ available: true }, r);
    }

    async probe_stop() {
      if (!this.plugin) return { available: false };
      try {
        const r = await this.plugin.probeStop();
        if (this._probe_listener && this._probe_listener.remove) {
          try { await this._probe_listener.remove(); } catch (e) { /* 忽略 */ }
        }
        this._probe_listener = null;
        return Object.assign({ available: true }, r);
      } catch (e) {
        this.onLog(`停止探针失败：${e}`);
        return { available: true, error: String(e) };
      }
    }

    /** 拉一次读数（页面主动问，不依赖事件推送）。 */
    async probe_report() {
      if (!this.plugin) return { available: false };
      try {
        return Object.assign({ available: true }, await this.plugin.probeReport());
      } catch (e) {
        return { available: true, error: String(e) };
      }
    }

    // -- 原生节拍器（原生 -> JS 的驱动，见 NavPuckFgsPlugin 的注释）----------
    //
    // 它回答的是探针留下的那个洞："定时器被冻了"已经实测确认，但
    // **原生主动调 evaluateJavascript 里的 JS，页面不可见时会不会执行**？
    // 如果会，原生就能当节拍器、JS 导航栈原地不动；如果不会，循环就得搬原生。
    //
    // 全部方法在 PWA 里返回中性值（available:false），一个异常都不抛 ——
    // 与这个文件其它方法同一条规矩。

    /** 本环境支不支持节拍器（旧版 APK 里没有这两个原生方法）。 */
    get metronome_available() {
      return !!(this.plugin && typeof this.plugin.metronomeStart === 'function');
    }

    /** 起节拍器：原生每 100ms 调一次 window.__navpuckNativeTick()。 */
    async metronome_start() {
      if (!this.plugin) return { available: false };
      if (!this.metronome_available) return { available: true, unsupported: true };
      try {
        const r = await this.plugin.metronomeStart();
        return Object.assign({ available: true }, r);
      } catch (e) {
        this.onLog(`❌ 节拍器启动失败：${e && e.message ? e.message : e}`);
        return { available: true, error: String(e) };
      }
    }

    async metronome_stop() {
      if (!this.plugin) return { available: false };
      if (!this.metronome_available) return { available: true, unsupported: true };
      try {
        return Object.assign({ available: true }, await this.plugin.metronomeStop());
      } catch (e) {
        return { available: true, error: String(e) };
      }
    }

    /**
     * 节拍器的全部读数（原生侧 + 页面侧），一次拿齐。
     *
     * 不沿用 state()：这个函数的返回值是**判读表**的输入，字段必须是平的、
     * 名字必须和界面/文档里那张表逐字对应，多一层嵌套只会让读代码的人多绕一次。
     */
    async metronome_stats() {
      const out = {
        available: !!this.plugin,
        metronomeSupported: this.metronome_available,
        running: false,
        metroTimerFires: 0,
        ticksDelivered: 0,
        ticksSkipped: 0,
        ticksCallbackRejected: 0,
        inFlightDepth: 0,
        jsExecCount: 0,
        framesSent: 0,
        framesSentTotal: 0,
        hbCount: 0,
        ticks: null,
        ivTicks: null,
        workerTicks: 0,
        workerMainTicks: 0,
        workerErrors: 0,
        workerMode: '',
        error: '',
      };
      if (!this.plugin) return out;
      try {
        const s = await this.plugin.getState();
        if (s) Object.assign(out, s);
      } catch (e) {
        out.error = String(e);
      }
      // 顺带把注入探针的数（旧的那种定时器读数）也带上，好在同一行里对比
      try {
        const p = await this.plugin.probeReport();
        if (p) {
          out.ticks = p.ticks;
          out.ivTicks = p.ivTicks;
          out.jsRuns = (p.ticks != null) ? p.ticks : null;
        }
      } catch (_e) { /* 探针没开就没这一项，不是错误 */ }
      return out;
    }

    /**
     * 把一份节拍器读数翻成**一句话结论**。
     *
     * 这是整个实验的判据，必须机械、必须只看证据。用**增量**判（cur - prev），
     * 因为要看的是"熄屏这 30 秒里涨了没有"，不是"现在是多少"。
     *
     * 每一条对应一种**修法**（见 docs/android.md §5 的判读表）：
     *   原生响 + JS 执行 + 出帧  => 原生可以当节拍器，**不用移植**
     *   原生响 + JS 不执行        => 投递进去了但 JS 没跑，循环必须搬进 Kotlin
     *   原生不响                  => 原生 Handler 都被冻了，先修前台服务/省电策略
     *   响而投递被跳过            => JS 根本没在收（在途一直不返回）
     */
    static metronome_verdict(prev, cur) {
      if (!cur) return '样本不足';
      if (!cur.metronomeSupported) {
        return '这个 APK 里没有节拍器（原生方法不存在）：需要重新构建安装 APK';
      }
      const d = (k) => (prev && prev[k] != null && cur[k] != null)
        ? (cur[k] - prev[k]) : null;
      const d_native = d('metroTimerFires');
      const d_exec = d('jsExecCount');
      const d_frames = d('framesSent');
      const d_deliv = d('ticksDelivered');
      const d_skip = d('ticksSkipped');
      const d_hb = d('hbCount');
      const d_ticks = d('ticks');

      const num = (v) => (v == null ? '—' : String(v));

      // 没有基线（刚打开面板）时只能给现状，不能下结论 —— 硬下结论就是编数据
      if (d_native == null) {
        return `刚建立基线：原生定时器 ${cur.metroTimerFires || 0} 次 / JS 入口执行 ` +
               `${cur.jsExecCount || 0} 次 / 出帧 ${cur.framesSent || 0}。` +
               `关屏 30 秒再回来看这一行（看的是**这 30 秒的增量**）。`;
      }

      if (d_native <= 0) {
        return `❌ 原生定时器在熄屏期间**没响**（增量为 0），但原生心跳 ${num(d_hb)}` +
               (d_hb === 0 ? '也没涨 —— 整个进程被冻/被回收了' : '仍在涨 —— 进程活着而 Handler 停了') +
               `。这是前台服务/厂商省电策略的问题，先修它，别急着搬导航循环。`;
      }
      if (d_exec == null || d_exec <= 0) {
        return `❌ 原生响了 ${d_native} 次、投递 ${num(d_deliv)} 次，但 JS 入口**执行 0 次**` +
               `（累计仍是 ${cur.jsExecCount || 0}）` +
               ((cur.ticksCallbackRejected || 0) > 0
                 ? `，且 evaluateJavascript 回调 ${cur.ticksCallbackRejected} 次回了 null` : '') +
               `。=> 页面不可见时投递进来的 JS **不会执行**：10Hz 循环必须搬进 Kotlin。`;
      }
      if (d_frames != null && d_frames > 0) {
        return `✅ 原生响了 ${d_native} 次、JS 真执行 ${d_exec} 次、产出 ${d_frames} 帧` +
               `（跳过 ${num(d_skip)} 次是防堆积的正常现象）。` +
               `=> **原生可以当节拍器，JS 导航栈原地不动就能在熄屏后继续跑，不需要移植。**`;
      }
      return `⚠️ 原生响了 ${d_native} 次、JS 执行 ${d_exec} 次，但**一帧都没发出去**` +
             `（framesSent 增量 0）。导航循环在跑，卡住的是发帧那一环：` +
             `查 BLE 是否连着 / send_frame 是否被 ble.connected 挡掉。`;
    }

    /**
     * 崩溃捕获（**本文件里唯一和"熄屏存活"无关的方法**，但同样重要）。
     *
     * 闪退时进程直接没了：页面上的 #log 一个字都留不下，JS 的 localStorage
     * 也可能连 flush 的机会都没有（WebView 渲染进程死亡就是这样）。所以
     * 关键操作前由页面调用这里，把一句话写进**原生**的 crash.log —— 那份文件
     * 在 Java 侧、跟着 App 的私有目录走，渲染进程死了它还在（见
     * android/.../NavPuckCrashLog.java 与 MainActivity 的 uncaught handler）。
     *
     * ⚠️ 不 await、失败一律吞掉：这是诊断，绝不能拖慢或挡住导航。
     *    页面侧调用点见 phone/crashlog.js 的 marker()。
     */
    note(kind, msg) {
      if (!this.plugin || typeof this.plugin.note !== 'function') return false;
      try {
        const p = this.plugin.note({ kind: String(kind || ''), msg: String(msg || '') });
        // ⚠️ 必须显式 catch：不接的话失败会变成 unhandledrejection，
        //    而那个钩子正是本模块要捕获的东西 —— 自己制造噪声。
        if (p && typeof p.catch === 'function') p.catch(() => {});
        return true;
      } catch (_e) {
        return false;
      }
    }

    /**
     * 原生侧记下来的崩溃现场（Java 未捕获异常栈 / WebView 渲染进程死亡）。
     * 页面在**下次启动**时读它，和 JS 侧的落盘日志拼在一起给用户看。
     */
    async crash_report() {
      if (!this.plugin || typeof this.plugin.getCrashReport !== 'function') {
        return { available: false };
      }
      try {
        return Object.assign({ available: true }, await this.plugin.getCrashReport());
      } catch (e) {
        return { available: true, error: String(e) };
      }
    }

    /**
     * 清空**原生**那份崩溃记录（用户按"我已记录，清掉这块"时调用）。
     * 不清的话，下一轮启动会把同一场崩溃再报一遍 —— 那样用户就分不清
     * "这是新的还是旧的"。
     */
    async clear_crash_report() {
      if (!this.plugin || typeof this.plugin.clearCrashReport !== 'function') {
        return { available: false };
      }
      try {
        return Object.assign({ available: true }, await this.plugin.clearCrashReport());
      } catch (e) {
        return { available: true, error: String(e) };
      }
    }

    /**
     * 把一次读数翻译成人话，直接给界面/日志用。
     *
     * 判据（这一版能给出的**机械**结论，不需要人肉看数字）：
     *   - hb 在涨、probe.ticks 不涨        => 进程活着，WebView 的定时器被停了
     *   - 两个都不涨                       => 整个进程被冻结/回收了
     *   - gap 很大但 ticks 还在涨          => 被限流（降频），不是被冻
     */
    static verdict(prev, cur) {
      if (!prev || !cur) return '样本不足';
      const d_hb = (cur.hbCount || 0) - (prev.hbCount || 0);
      const d_ticks = (cur.ticks || 0) - (prev.ticks || 0);
      const d_iv = (cur.ivTicks || 0) - (prev.ivTicks || 0);

      // 判据用**时间比**，不用"每秒跳数"：两次采样之间的间隔取决于原生
      // setInterval 实际有没有准时（被冻过就会拉长），而 ticks/runMs 是
      // 采样点自带的绝对时间，不受采样节奏影响。
      // 页面探针是每 100ms 一跳，所以 10Hz 需要 >= 10 跳/秒。
      const run_ms = Math.max(1, (cur.runMs || 0) - (prev.runMs || 0));
      const hz = d_ticks / (run_ms / 1000);

      if (d_hb <= 0 && d_ticks <= 0) return '原生进程和 JS 都停了（前台服务没生效或被厂商省电策略掐了）';
      if (d_hb > 0 && d_ticks <= 0) return '原生进程活着，但 JS 定时器停了 —— WebView 被冻结';
      if (hz < 5) return `JS 在跑但明显被降频（约 ${hz.toFixed(1)}Hz，10Hz 循环需要 >=5Hz 才不算掉帧）`;
      if (d_ticks > 0 && d_iv > 0) return `JS 正常（约 ${hz.toFixed(1)}Hz，timeout ${d_ticks} 跳 / interval ${d_iv} 次）`;
      return `JS 的 timeout 在走但 interval 停了（timeout ${d_ticks} 跳，interval ${d_iv} 次）`;
    }
  }

  return { ForegroundService, available, find_capacitor, find_plugin };
}));
