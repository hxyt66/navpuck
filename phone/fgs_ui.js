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
 *
 * 这三件事回答的是同一个问题："手机揣兜里、屏幕熄灭之后，导航还活着吗？"
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

    // 回到前台时补一次读数：被冻结期间页面收不到任何事件，只有回到前台
    // 才能把"刚才冻了多久"问出来。gaps 里最大的那个数就是答案。
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        fgs.probe_report().then((r) => {
          if (r && !r.error) {
            on_sample(r);
            set_hint('回到前台，已补采一次读数（看"最大间隔"，那就是刚才被冻结/限流的最长时间）。');
          }
        }).catch(() => { /* 探针没开就忽略 */ });
      });
    }

    set_state('stopped');
    set_hint('点"开启后台运行"后，前台服务会让系统不回收本进程。' +
             '点"启动探针"可以实测熄屏后 JS 是否还在跑 —— 这是唯一必须上车验证的事。');

    log('[fgs] 原生后台运行能力就绪（前台服务 + 后台存活探针）');
    return fgs;
  }

  root.NavPuckFgsUi = { setup };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.NavPuckFgsUi;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
