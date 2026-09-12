/*
 * NavPuck —— 把"后台运行（前台服务）+ 后台存活探针"接到界面上。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 为什么单独一个文件，而不是写进 app.js
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * app.js 是这个工程的核心（10Hz 循环、位置源、界面接线），而且**别的 agent
 * 正在同时改它**（map 重锚、wake lock、NAV_CLOCK、设备端主页）。往里面塞一块
 * 与导航无关的"原生诊断界面"，只会让两边的改动互相踩。
 *
 * 所以这里的原则是：**app.js 侧只加一行调用**（App.init() 里的
 * setup_foreground_service() 一行 + 传给 BleLink 的 transport），其余全在本文件。
 * 它只读 app 对象上已经存在的东西（app.ble / app.nav / app.log / app.toast），
 * 不回头改 app.js 的内部状态。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 它在界面上做什么
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   1. "开启后台运行" -> 前台服务（常驻通知、type=location），这是熄屏后
 *      进程不被回收的唯一依据（见 android/…/NavPuckForegroundService.java）
 *   2. "启动探针"     -> 实测熄屏后 WebView 里的 JS 定时器还在不在跑
 *   3. 读数面板       -> JS 跳数 / 原生心跳 / 页面可见性 / 最大间隔 / 结论
 *   4. "开启原生节拍器" -> 让**原生**每 100ms 调一次 JS 循环本体，回答那个
 *      探针回答不了的问题：**页面不可见时，原生主动投递进来的 JS 会不会执行？**
 *      （会 -> 原生当节拍器，导航栈不用移植；不会 -> 循环必须搬进 Kotlin）
 *   5. 节拍器读数面板 -> 原生定时器响铃 / JS 入口执行 / 出帧 / worker 消息，
 *      四根针分开看，增量一眼可辨，底下带一句机械结论
 *
 * 这几件事回答的是同一个问题："手机揣兜里、屏幕熄灭之后，导航还活着吗？"
 */

'use strict';

(function (root) {
  const F = root.NavPuckFgs;

  /**
   * 装界面。
   *
   * 在 PWA 里这一步几乎什么都不做：NavPuckFgs 没有（fgs.js 里 available() 为
   * false），整块折叠隐藏。**PWA 的行为不能被这个文件改变**，这是硬要求。
   */
  function setup(app) {
    if (!app) return null;

    const W = (F && F.ForegroundService) ? F.ForegroundService : null;
    const avail = !!(W && W.available(root));

    const log = (l) => { try { app.log(l); } catch (_e) { /* 日志不能反过来影响功能 */ } };
    const toast = (t, ms) => { try { app.toast(t, ms); } catch (_e) { /* 同上 */ } };
    const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

    // ---- PWA：整块隐藏，什么都不做 ----------------------------------------
    if (!avail) {
      const d = $('fgs-block');
      if (d) d.hidden = true;
      log('[fgs] 不在 APK 里运行：前台服务不可用（PWA 只能靠屏幕常亮，见 phone/README）');
      return null;
    }

    // ⚠️ 必须**显式取消 hidden**。
    //    index.html 里这块带 `hidden` 属性（为了 PWA 下不闪一下），
    //    而这里以前只有 `hidden = true` 一条路径、从来没有把它打开过 ——
    //    结果就是**面板在任何环境下都永远不显示**，包括 APK 里。
    //    这个 bug 编译不报错、测试也抓不到（ui.mjs 当时只断言了 PWA 下隐藏），
    //    只有真的在手机上打开才会发现。
    {
      const d = $('fgs-block');
      if (d) d.hidden = false;
    }

    const fgs = new W({
      window: root,
      onLog: log,
      onStateChange: (running) => set_state(running ? 'running' : 'stopped'),
      onProbe: (sample) => on_sample(sample),
    });

    let prev = null;

    function set_state(state) {
      const el = $('fgs-state');
      if (!el) return;
      el.textContent = {
        starting: '启动中…', running: '后台运行中', stopped: '未开启', error: '启动失败',
      }[state] || state;
      el.dataset.state = state;
    }

    function set_hint(t) {
      const el = $('fgs-hint');
      if (el) el.textContent = t;
    }

    /**
     * 一条探针读数。
     *
     * 把两根秒针对上：
     *   hbCount  原生前台服务每秒 +1            -> 进程活着
     *   ticks    页面嵌套 setTimeout 每 100ms +1 -> JS 定时器还在被调度
     *   gaps     页面实测到的 >250ms 间隔        -> 被限流/冻结的**幅度**
     * 只有这两根针分开看，才能区分"进程被杀了"和"进程活着但 WebView 被冻了"
     * —— 这两种情况的修法完全不同（前者修权限/厂商省电，后者要把循环搬进原生）。
     */
    function on_sample(s) {
      if (!s) return;
      const verdict = W.verdict(prev, s);

      if (prev && ((s.ticks || 0) - (prev.ticks || 0)) < 5) {
        log(`[probe] ⚠️ JS 定时器变慢/停了：本秒只跑了 ${(s.ticks || 0) - (prev.ticks || 0)} 跳；` +
            `原生心跳 ${s.hbCount || 0}` +
            (s.gaps && s.gaps.length ? `；最大间隔 ${Math.max.apply(null, s.gaps)}ms` : ''));
      }
      prev = s;

      const el = $('fgs-probe-out');
      if (!el) return;
      const max_gap = (s.gaps && s.gaps.length) ? Math.max.apply(null, s.gaps) : 0;
      el.textContent =
        `JS ${s.ticks || 0} 跳 / interval ${s.ivTicks || 0} 次  |  ` +
        `原生心跳 ${s.hbCount || 0}  |  ` +
        `页面可见性 ${s.visibility || '?'}  |  ` +
        `最大间隔 ${max_gap}ms  |  ` +
        `原生戳 ${s.probeSent || 0} 次、页面应答 ${s.probeAcked || 0} 次\n` +
        `结论：${verdict}`;
    }

    const on = (id, ev, fn) => {
      const el = $(id);
      if (el) el.addEventListener(ev, fn);
    };

    on('fgs-start-btn', 'click', async () => {
      set_state('starting');
      try {
        const r = await fgs.start();
        // ⚠️ Android 14+ 的硬限制：location 类型的前台服务**只能在 App 处于
        //    前台时启动**（ForegroundServiceStartNotAllowedException）。
        //    所以这个按钮必须由用户在页面可见时点，不能在后台被唤起时才调。
        set_state(r && r.running ? 'running' : 'stopped');
        toast('后台运行已开启：可以关屏把手机放兜里了');
      } catch (e) {
        set_state('error');
        toast(`前台服务启动失败：${e && e.message ? e.message : e}`, 6000);
      }
    });

    on('fgs-stop-btn', 'click', async () => {
      try {
        await fgs.stop();
        toast('后台运行已停止');
      } catch (e) {
        toast(`停止失败：${e}`, 5000);
      }
    });

    on('fgs-probe-btn', 'click', async () => {
      try {
        await fgs.probe_start();
        prev = await fgs.state();     // 记基线，之后的读数才有对比对象
        on_sample(prev);
        set_hint('探针已启动：把 App 切到后台（或直接关屏），等 30 秒再回来看这一行。');
      } catch (e) {
        set_hint(`探针启动失败：${e}`);
      }
    });

    on('fgs-probe-stop', 'click', async () => {
      try {
        await fgs.probe_stop();
        set_hint('探针已停止。上面的读数就是最后一次采样。');
      } catch (e) {
        set_hint(`停止探针失败：${e}`);
      }
    });

    // ---- 原生节拍器：本实验的主角 ----------------------------------------
    //
    // 探针已经证明"熄屏后 JS 定时器被冻住"，但它数的是**定时器回调**。
    // 真正决定架构的是另一个问题：**原生主动调 evaluateJavascript 里的 JS，
    // 页面不可见时会不会执行？** 会 -> 原生当节拍器，JS 导航栈原地不动；
    // 不会 -> 循环必须搬进 Kotlin。
    //
    // 这个按钮就是那把尺子：原生每 100ms 调一次 window.__navpuckNativeTick()，
    // 而那正是 10Hz 循环本体。读数分成三根独立的针，谁涨谁不涨一眼可辨。

    /** JS 侧此刻的状态（入口在不在、执行了几次）。**任何异常都吞掉**。 */
    function js_state() {
      try {
        const n = (app && app.nav) ? app.nav : null;
        const st = root.__navpuckNativeState || {};
        return {
          installed: typeof root.__navpuckNativeTick === 'function',
          on: !!(n && n.metronome),
          navigable: !!(n && n.route),
          executions: st.executions || 0,
          frames_total: st.frames || 0,
          last_error: st.lastError || '',
          timer_running: !!(n && n.running),
        };
      } catch (_e) {
        return { installed: false, on: false, navigable: false, executions: 0,
                 frames_total: 0, last_error: '', timer_running: false };
      }
    }

    let cmp_prev = null;
    let cmp_cur = null;
    // ⚠️ 定时器句柄必须**先声明**再被 start_refresh/stop_refresh 引用。
    //    `let` 有暂时性死区，写在函数后面虽然也能跑（首次调用发生在声明之后），
    //    但那是靠"人肉确认调用顺序"撑着 —— 以后有人在 setup() 里提前调一次
    //    start_refresh() 就是一个 ReferenceError。
    let cmp_timer = null;
    // "本次已跑 N 秒"的起点：每次重建基线都重置，这样那个秒数永远是
    // "距上一次基线多久"，而不是"面板打开多久"（后者会让人误以为读数很新）。
    let base_ms = Date.now();

    /**
     * 采一次两边的读数，把读数面板画出来。
     *
     * 面板是**自解释**的：每一行左边是"谁在数"，右边是"这个数证明什么"。
     * 用户只有 30 秒，不能指望他回来以后还记得哪根针是哪根。
     */
    async function refresh_compare(rebuild_base) {
      const el = $('fgs-metro-out');
      if (!el) return;
      const js = js_state();
      let s = null;
      try {
        s = await fgs.metronome_stats();
      } catch (e) {
        s = { available: true, error: String(e) };
      }
      s = s || {};
      if (rebuild_base) { cmp_prev = null; }

      // 基线：第一次进来（或刚点开启/停止）时先记一笔，之后看的都是**增量**。
      // ⚠️ 没有基线就不下结论 —— 硬下结论等于编数据。
      const cur = Object.assign({}, s, {
        jsExecCount: js.executions,        // ⚠️ 用页面此刻的实测值，不用缓存
        jsFramesTotal: js.frames_total,
      });
      // 这一笔是不是"刚建立的基线"？界面要据此把"增量全是 0"解释清楚 ——
      // 否则用户会以为"全都没动"（那是完全相反的结论）。
      const is_base = (cmp_prev === null);
      if (is_base) cmp_prev = cur;
      cmp_cur = cur;
      if (is_base) base_ms = Date.now();

      const d = (k) => ((cmp_prev && cmp_prev[k] != null && cur[k] != null)
        ? (cur[k] - cmp_prev[k]) : 0);
      const arrow = (v) => ((v > 0) ? ` ↑+${v}` : ' →0');
      const verdict = W.metronome_verdict(cmp_prev, cur);
      const secs = Math.round((Date.now() - base_ms) / 1000);
      const vis = (typeof document !== 'undefined') ? document.visibilityState : '?';

      const lines = [];
      lines.push(`【原生节拍器】${s.running ? '已开启（原生每 100ms 调一次 JS）' : '未开启'}` +
                 `  本次已跑 ${secs}s   页面可见性 ${vis}`);
      lines.push('');
      lines.push('原生侧（证明"原生这边动了没"）');
      lines.push(`  原生定时器响铃   ${cur.metroTimerFires || 0}${arrow(d('metroTimerFires'))}   ← 涨 = 原生 Handler 没被冻`);
      lines.push(`  投递给 JS        ${cur.ticksDelivered || 0}${arrow(d('ticksDelivered'))}`);
      lines.push(`  因在途而跳过     ${cur.ticksSkipped || 0}${arrow(d('ticksSkipped'))}   ← 防堆积，涨是正常的`);
      lines.push(`  回调返回 null    ${cur.ticksCallbackRejected || 0}${arrow(d('ticksCallbackRejected'))}   ← 涨 = 投递进去了但 JS 一个值都没回`);
      lines.push('');
      lines.push('页面侧（证明"JS 真的跑了没"）');
      lines.push(`  JS 入口执行次数  ${cur.jsExecCount || 0}${arrow(d('jsExecCount'))}   ← **这一根才是答案**`);
      lines.push(`  发出的导航帧数   ${cur.framesSent || 0}${arrow(d('framesSent'))}   ← 涨 = 导航真的在产出`);
      lines.push(`  入口是否已装上   ${js.installed ? '是' : '否 —— 没在导航！先点"规划并开始导航"'}`);
      lines.push(`  JS 自身的定时器  ${js.timer_running ? '在跑' : (js.on ? '已让位给原生节拍器（正常）' : '没在跑')}`);
      lines.push('');
      lines.push('Worker 备选答案（主线程被冻时，worker 的消息还会不会被处理）');
      lines.push(`  worker 跳数      ${cur.workerTicks || 0}${arrow(d('workerTicks'))}   ← 涨 = worker 里的定时器没被冻`);
      lines.push(`  主线程处理消息   ${cur.workerMainTicks || 0}${arrow(d('workerMainTicks'))}   ← 涨 = 主线程愿意处理 worker 的消息`);
      lines.push(`  worker 模式      ${cur.workerMode || '未安装'}${cur.workerErrors ? `（错误 ${cur.workerErrors}）` : ''}`);
      lines.push('');
      lines.push('参照（上一版探针的旧读数）');
      lines.push(`  旧定时器跳数     ${cur.ticks == null ? '—（探针没开）' : cur.ticks}`);
      lines.push(`  旧 interval 次数 ${cur.ivTicks == null ? '—' : cur.ivTicks}`);
      lines.push(`  原生心跳         ${cur.hbCount || 0}${arrow(d('hbCount'))}   ← 涨 = 进程活着`);
      lines.push('');
      lines.push(`结论：${verdict}`);
      if (is_base) {
        lines.push('（以上是**基线**，增量全是 0。关屏 30 秒再回来看增量。）');
      }
      el.textContent = lines.join('\n');
    }

    /**
     * 1 秒一次刷新读数。
     *
     * ⚠️ 这个 setInterval **刻意不随页面可见性做任何特殊处理**：页面被隐藏时
     *    它自己就会被 Chromium 冻住（这正是我们要测的现象）。回到前台它会
     *    恢复，配合 visibilitychange 里那次补采，用户看到的读数是新鲜的。
     */
    function start_refresh() {
      if (cmp_timer !== null) return;
      cmp_timer = setInterval(() => { refresh_compare(false).catch(() => {}); }, 1000);
    }
    function stop_refresh() {
      if (cmp_timer !== null) { clearInterval(cmp_timer); cmp_timer = null; }
    }

    on('fgs-metro-btn', 'click', async () => {
      // ⚠️ 入口是 do_route() 装的。没在导航时开节拍器 = 每 100ms 调一个不存在的
      //    函数，"JS 入口执行次数"会是 0 —— 那看起来跟"被冻住"一模一样，
      //    会把整个实验做成假阴性。所以这里必须挡住，并说清楚为什么。
      if (!js_state().installed) {
        set_hint('⚠️ 请先点上面的"规划并开始导航"：节拍器调的就是导航循环本体，' +
                 '没有导航时它无处可调（读数会一直是 0，会被误判成"JS 被冻结"）。');
        toast('先开始导航，再开节拍器', 6000);
        return;
      }
      try {
        const r = await fgs.metronome_start();
        if (r && r.unsupported) {
          set_hint('这个 APK 里没有节拍器（原生方法不存在）：需要重新构建并安装 APK。');
          return;
        }
        if (r && r.error) {
          set_hint(`节拍器启动失败：${r.error}`);
          return;
        }
        // 让 Navigator 把 setInterval 停掉，改由原生驱动（避免双驱动翻倍）
        try { if (app && app.nav) app.nav.set_metronome(true); } catch (_e) { /* 不影响实验 */ }
        refresh_compare(true);
        start_refresh();
        set_hint('节拍器已开（原生在驱动 JS 循环）。现在关屏 30 秒，回来这一行就是答案。');
        toast('原生节拍器已开启：可以关屏了');
      } catch (e) {
        set_hint(`节拍器启动失败：${e}`);
      }
    });

    on('fgs-metro-stop', 'click', async () => {
      try {
        // ⚠️ 先刷一次、**再**停原生。顺序反了的话，原生计数已经被清空，
        //    用户看到的增量变成 0 —— 而"熄屏那 30 秒涨了多少"正是他要抄下来的
        //    数字。这里刻意**不重建基线**：让最后一次增量留在屏幕上。
        await refresh_compare(false);
        await fgs.metronome_stop();
        // 交还给页面自己的 setInterval（导航不能因为"关掉诊断"而停摆）
        try { if (app && app.nav) app.nav.set_metronome(false); } catch (_e) { /* 同上 */ }
        stop_refresh();
        const got = cmp_cur || {};
        set_hint(`节拍器已停，循环交还给页面。本次结果已留在上面：` +
                 `原生响了 ${got.metroTimerFires || 0} 次 / JS 入口执行了 ${got.jsExecCount || 0} 次 / ` +
                 `出帧 ${got.framesSent || 0}（这些是**累计值**，增量见上面的 ↑+N）。`);
        toast('原生节拍器已停止');
      } catch (e) {
        set_hint(`停止节拍器失败：${e}`);
      }
    });

    on('fgs-cmp-btn', 'click', async () => {
      await refresh_compare(true);
      set_hint('已把当前读数设为基线（增量从这里重新开始算）。');
    });

    // 回到前台时补一次读数：被冻结期间页面收不到任何事件，只有回到前台
    // 才能把"刚才冻了多久"问出来。gaps 里最大的那个数就是答案。
    //
    // ⚠️ 节拍器的读数**也必须**在这里补一次：熄屏期间那个 1 秒刷新定时器
    //    自己就被冻住了（那正是被测现象），所以"回来看到的第一眼"只能靠
    //    这个事件去问。少了这一句，用户解锁后看到的是**熄屏前的旧数字**，
    //    结论会正好反过来。
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        fgs.probe_report().then((r) => {
          if (r && !r.error) {
            on_sample(r);
            set_hint('回到前台，已补采一次读数（看"最大间隔"，那就是刚才被冻结/限流的最长时间）。');
          }
        }).catch(() => { /* 探针没开就忽略 */ });
        refresh_compare(false).catch(() => { /* 节拍器读数同理，失败不影响导航 */ });
      });
    }

    set_state('stopped');
    set_hint('点"开启后台运行"后，前台服务会让系统不回收本进程。' +
             '点"启动探针"可以实测熄屏后 JS 是否还在跑 —— 这是唯一必须上车验证的事。');

    log('[fgs] 原生后台运行能力就绪（前台服务 + 后台存活探针 + 原生节拍器）');
    return fgs;
  }

  root.NavPuckFgsUi = { setup };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.NavPuckFgsUi;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
