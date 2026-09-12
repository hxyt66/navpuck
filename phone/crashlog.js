/*
 * NavPuck —— 崩溃/"上次为什么死了"捕获（经典脚本，UMD）。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 为什么需要这个文件（这一版最该存在的东西）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 现场反馈只有一句："连接板子后规划导航直接会闪退"。
 *
 * 闪退 = **进程没了**，所以页面上那块 #log（只在内存里、只画在 DOM 上）在
 * 崩溃发生时**一个字都不会留下** —— 用户能看到的只有"应用不见了"。
 * 于是每一轮都只能靠猜，猜错一次就是一个来回。
 *
 * 这个文件只做一件事，但必须做得可靠：**在下一次可能崩的操作之前，先把
 * "我刚走到哪一步"写进 localStorage**。localStorage 是磁盘上的，进程被杀、
 * WebView 渲染进程死掉、手机重启，它都还在。下次启动时把上一轮的最后几十行
 * 原样摊在界面上 —— 那一块文字就是下一轮唯一需要的东西。
 *
 * 三条独立的路（缺一条就会出现"不知道自己是怎么死的"）：
 *   A. 页面日志落盘：App.log() 每一行都喂进来（内存环形 + 节流落盘），
 *      **关键操作前**用 marker() 同步落盘（"正要开始下发 1001 点路线…"）。
 *   B. 未捕获错误：window.onerror / unhandledrejection 全部记下来。
 *      ⚠️ 记录 ≠ 吞掉：不写 preventDefault，错误该冒到控制台还冒到控制台。
 *   C. 原生记录：APK 里 NavPuckFgs.getCrashReport() 会带回 Java 侧的东西
 *      （未捕获异常栈 / WebView 渲染进程死亡），因为**真正的闪退多数不是 JS
 *      干的**：Java 主线程未捕获异常、或者 WebView 渲染进程死了而 Capacitor
 *      没有接住（见 docs/android.md 第 8 节）。JS 侧崩溃前反倒可能是静默的。
 *
 * ⚠️ 这个文件在 PWA 里也必须**完全无害**：拿不到 localStorage 就退化成内存
 *    环形缓冲（不抛错、不阻塞），一个 DOM 元素都不碰（除非报告真的存在）。
 *    它也不改 App 的任何状态 —— 只读全局，单向写盘。
 */

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.NavPuckCrash = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /** localStorage 的键。带版本号：结构变了就换键，免得读到半旧半新的数据。 */
  const KEY = 'navpuck.crash.v1';

  /** 环形缓冲的行数上限。够覆盖"最后 1~2 分钟的现场"，又不会把 localStorage 撑爆。 */
  const MAX_LINES = 120;
  /** 单行长度上限（超长行截断）：一行 8KB 的日志会让落盘变成卡顿。 */
  const MAX_LINE = 220;
  /** 落盘节流：页面正常时最多每秒写一次盘（localStorage 是同步 IO）。 */
  const FLUSH_MS = 1000;
  /** 报告里给用户看几行。 */
  const REPORT_LINES = 40;
  /** 心跳：证明"上一轮活到了什么时候"（崩溃时刻 = 最后一跳 + 最多 5 秒）。 */
  const HB_MS = 5000;
  /** 原生记录的返回上限（Java 侧也会截断，这里是第二道保险）。 */
  const MAX_NATIVE_CHARS = 6000;

  function now_ms() {
    const d = new Date();
    return d.getTime();
  }

  /** 一行日志前面的时间戳：HH:MM:SS.mmm（本地时间，用户对着手机看的就是这个）。 */
  function stamp(ms) {
    const d = new Date(ms);
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  /** 安全取 localStorage：file:// 或隐私模式下访问会抛，必须包起来。 */
  function pick_storage(win, given) {
    if (given) return given;
    try {
      const s = win && win.localStorage;
      if (!s) return null;
      // 探一次读写：有些环境里 localStorage 存在但一写就抛。
      const probe = '__navpuck_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (_e) {
      return null;
    }
  }

  function clamp_line(s) {
    const t = String(s === undefined || s === null ? '' : s).replace(/\s+$/, '');
    return t.length > MAX_LINE ? t.slice(0, MAX_LINE) + '…' : t;
  }

  /**
   * 造一个捕获器实例。
   *
   * opts：
   *   window   注入的 window（自测用；默认 globalThis）
   *   storage  注入的 localStorage 形状对象（自测用）
   *   now      注入的时钟（自测用）
   */
  function create(opts) {
    const o = opts || {};
    const win = o.window || (typeof globalThis !== 'undefined' ? globalThis : null);
    const store = pick_storage(win, o.storage);
    const clock = o.now || now_ms;

    /** 当前会话在内存里的状态；落盘就是把这个对象 JSON 化。 */
    let cur = null;
    let last_flush = 0;
    let hb_timer = null;
    let dirty = false;
    let persist_ok = true;
    let native_note_ok = true;
    /** 上一次会话的异常报告（没有异常就是 null）。 */
    let prev_report = null;
    let prev_data = null;
    let installed = false;
    let error_count = 0;

    function blank_session(t) {
      return {
        v: 1,
        session: t,
        started: new Date(t).toISOString(),
        ended_clean: false,
        clean_at: null,
        visibility: 'visible',
        hb: 0,
        hb_last_ms: t,
        errors: 0,
        ua: (win && win.navigator && win.navigator.userAgent) ? String(win.navigator.userAgent).slice(0, 120) : '',
        lines: [],
      };
    }

    function read_prev() {
      if (!store) return null;
      try {
        const raw = store.getItem(KEY);
        if (!raw) return null;
        const d = JSON.parse(raw);
        if (!d || d.v !== 1 || !Array.isArray(d.lines)) return null;
        return d;
      } catch (_e) {
        return null;
      }
    }

    function write_now() {
      if (!store || !cur || !persist_ok) return;
      try {
        store.setItem(KEY, JSON.stringify(cur));
        last_flush = clock();
        dirty = false;
      } catch (_e) {
        // 配额/权限问题：先砍一半历史再试一次，还不行就放弃落盘（内存缓冲继续用）。
        try {
          cur.lines = cur.lines.slice(-Math.floor(MAX_LINES / 2));
          store.setItem(KEY, JSON.stringify(cur));
          last_flush = clock();
          dirty = false;
        } catch (_e2) {
          persist_ok = false;
        }
      }
    }

    /** 节流落盘（页面正常时用这个，避免每条日志都写盘）。 */
    function flush_soon() {
      dirty = true;
      const t = clock();
      if (t - last_flush >= FLUSH_MS) write_now();
    }

    /** 立刻落盘（**危险操作前**用这个：崩了也要留下这一行）。 */
    function flush_now() { write_now(); }

    function push(text) {
      if (!cur) return;
      cur.lines.push([stamp(clock()), clamp_line(text)]);
      if (cur.lines.length > MAX_LINES) cur.lines = cur.lines.slice(-MAX_LINES);
    }

    /**
     * 记一行。**不抛错、不阻塞**：日志本身绝不能成为新的崩溃源。
     */
    function note(tag, msg) {
      try {
        if (!cur) return;
        const t = tag ? `[${tag}] ` : '';
        push(t + (msg === undefined ? '' : msg));
        flush_soon();
      } catch (_e) { /* 忽略 */ }
    }

    /**
     * 关键操作前的一道"黑匣子"记录：**同步落盘**，并把同一句话递给原生
     * （这样即使 WebView 渲染进程整个死掉，Java 侧的 crash.log 里也有这一行）。
     */
    function marker(kind, data) {
      try {
        const extra = (data === undefined || data === null) ? ''
          : (typeof data === 'string' ? data : JSON.stringify(data));
        const line = `[crash] ${kind}${extra ? ' ' + extra : ''}`;
        if (cur) {
          push(line);
          cur.hb_last_ms = clock();
          write_now();
        }
        note_native(kind, extra);
      } catch (_e) { /* 忽略 */ }
    }

    /**
     * 原生那条路的句柄（APK 里才有）。
     *
     * ⚠️ 这里**不碰 fgs_ui 那个实例**（它绑着一堆界面），只借用 fgs.js 的封装：
     *    它在 PWA 里同样存在，且所有方法都返回中性值、一个异常都不抛。
     *    懒加载 + 缓存一次，避免每次落盘都 new 一个。
     */
    let fgs_handle = null;
    let fgs_probed = false;
    function fgs() {
      if (fgs_probed) return fgs_handle;
      fgs_probed = true;
      try {
        const F = win && win.NavPuckFgs;
        const W = F && F.ForegroundService;
        if (W && W.available && W.available(win)) {
          fgs_handle = new W({ window: win, onLog: () => {} });
        }
      } catch (_e) {
        fgs_handle = null;
      }
      return fgs_handle;
    }

    /** 递一句话给原生（APK 里才有；PWA 里直接跳过）。 */
    function note_native(kind, extra) {
      if (!native_note_ok) return;
      try {
        // 只借道，不 await：marker() 必须是同步的，绝不能因为原生慢而挡住导航。
        const f = fgs();
        if (f && typeof f.note === 'function') f.note(kind, extra);
      } catch (_e) {
        native_note_ok = false;   // 原生那条路坏一次就不要再试（不影响页面）
      }
    }

    /** 记一个未捕获错误（onerror / unhandledrejection 共用）。 */
    function note_error(kind, detail) {
      try {
        error_count += 1;
        if (cur) cur.errors = error_count;
        push(`[${kind}] ${detail}`);
        write_now();          // 错误一律立刻落盘：下一次可能就没机会了
      } catch (_e) { /* 忽略 */ }
    }

    /** 上一轮是不是"没正常结束"。 */
    function prev_is_abnormal() {
      if (!prev_data) return false;
      return prev_data.ended_clean !== true;
    }

    /** 上一轮崩溃前的最后 REPORT_LINES 行（纯文本，带时间戳）。 */
    function prev_report_text() {
      if (!prev_data) return null;
      const lines = (prev_data.lines || []).slice(-REPORT_LINES)
        .map((l) => (Array.isArray(l) ? `[${l[0]}] ${l[1]}` : String(l)));
      const ended = prev_data.ended_clean === true
        ? '（上一轮是正常结束的）'
        : `（上一轮**没有**正常结束：最后心跳 ${stamp(prev_data.hb_last_ms || prev_data.session || 0)}，` +
          `当时页面可见性=${prev_data.visibility || '?'}）`;
      return ended + '\n' + (lines.length ? lines.join('\n') : '（上一轮没有留下任何日志行）');
    }

    /** 上一轮的原生记录（Java 异常栈 / 渲染进程死亡）。异步，拿不到就返回 null。 */
    async function fetch_native_report() {
      try {
        const f = fgs();
        if (!f || typeof f.crash_report !== 'function') return null;
        const r = await f.crash_report();
        if (!r || r.available === false) return null;
        const text = String(r.text || '').trim();
        if (!text) return null;
        return text.length > MAX_NATIVE_CHARS
          ? '…（只显示最后一段）\n' + text.slice(-MAX_NATIVE_CHARS)
          : text;
      } catch (_e) {
        return null;
      }
    }

    /** 把报告画进 index.html 里那块 #crash-block（存在才画）。 */
    async function render() {
      try {
        const doc = win && win.document;
        if (!doc) return null;
        const box = doc.getElementById('crash-block');
        const out = doc.getElementById('crash-report');
        const hint = doc.getElementById('crash-hint');
        if (!box || !out) return null;
        if (!prev_report) {
          box.hidden = true;
          return null;
        }
        let text = prev_report;
        const native = await fetch_native_report();
        if (native) text += '\n\n--- 原生侧记录（Java / WebView）---\n' + native;
        out.textContent = text;
        if (hint) {
          hint.textContent = '把这一整块截图或复制发出来 —— 这就是上一轮崩溃前的现场。';
        }
        box.hidden = false;
        return text;
      } catch (_e) {
        return null;
      }
    }

    /** 报告文本（不碰 DOM，给自测和"复制"按钮用）。 */
    function report_text() { return prev_report; }

    /** 清掉上一轮的报告（用户自己按的，避免每次打开都弹同一块）。 */
    function clear() {
      prev_report = null;
      prev_data = null;
      try {
        const doc = win && win.document;
        const box = doc && doc.getElementById('crash-block');
        if (box) box.hidden = true;
      } catch (_e) { /* 忽略 */ }
      // 原生那份也一起清（否则下一轮启动会把同一场崩溃再报一遍）
      try {
        const f = fgs();
        if (f && typeof f.clear_crash_report === 'function') {
          const p = f.clear_crash_report();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (_e) { /* 忽略 */ }
    }

    /** 心跳：写进落盘状态里，证明"上一轮活到了这一秒"。 */
    function beat() {
      try {
        if (!cur) return;
        cur.hb += 1;
        cur.hb_last_ms = clock();
        cur.visibility = visibility_state();
        write_now();
      } catch (_e) { /* 忽略 */ }
    }

    function visibility_state() {
      try {
        const doc = win && win.document;
        return (doc && doc.visibilityState) ? String(doc.visibilityState) : 'unknown';
      } catch (_e) { return 'unknown'; }
    }

    /** 正常结束的标记。**只有它被写上，"下次启动报异常"才会安静。** */
    function end_clean(why) {
      try {
        if (!cur) return;
        cur.ended_clean = true;
        cur.clean_at = new Date(clock()).toISOString();
        cur.visibility = visibility_state();
        push(`[crash] 正常结束（${why}）`);
        write_now();
      } catch (_e) { /* 忽略 */ }
    }

    /**
     * 装钩子。安装本身也必须无害：任何一步失败都只影响诊断，绝不影响导航。
     */
    function install() {
      if (installed) return api;
      installed = true;

      // 1) 上一轮：读出来 → 判断是否异常 → 开新会话（先写盘，再谈别的）
      prev_data = read_prev();
      prev_report = prev_is_abnormal() ? prev_report_text() : null;
      cur = blank_session(clock());
      const boot_line = `会话开始（上一轮${prev_report ? '**异常结束**' : (prev_data ? '正常结束' : '：没有记录')}）`;
      push(boot_line);
      if (prev_report) push('上一轮最后一行：' + (prev_report.split('\n').pop() || ''));
      write_now();

      // 2) 未捕获错误：记录，但**不吞**（不写 preventDefault / 不 return true）
      try {
        const prev_onerror = win.onerror;
        win.onerror = function (msg, src, line, col, err) {
          let d = String(msg);
          if (src) d += ` @ ${src}:${line}:${col}`;
          if (err && err.stack) d += ` | ${String(err.stack).split('\n').slice(0, 3).join(' ⏎ ')}`;
          note_error('JS错误', d);
          if (typeof prev_onerror === 'function') {
            try { return prev_onerror.apply(this, arguments); } catch (_e) { /* 忽略 */ }
          }
          return false;
        };
      } catch (_e) { /* 忽略 */ }

      try {
        const prev_rej = win.onunhandledrejection;
        win.onunhandledrejection = function (ev) {
          let d = '';
          try {
            const r = ev && ev.reason;
            d = (r && (r.stack || r.message)) ? String(r.stack || r.message) : String(r);
          } catch (_e) { d = '（reason 无法转成字符串）'; }
          note_error('未处理的Promise拒绝', d);
          if (typeof prev_rej === 'function') {
            try { return prev_rej.apply(this, arguments); } catch (_e) { /* 忽略 */ }
          }
          return undefined;
        };
      } catch (_e) { /* 忽略 */ }

      // 3) 心跳 + 生命周期：心跳证明"活到哪一秒"，pagehide 证明"是正常走的"
      try {
        if (win.setInterval) hb_timer = win.setInterval(beat, HB_MS);
      } catch (_e) { /* 忽略 */ }

      try {
        const doc = win.document;
        if (doc && doc.addEventListener) {
          doc.addEventListener('visibilitychange', () => {
            try {
              if (!cur) return;
              cur.visibility = visibility_state();
              flush_now();
            } catch (_e) { /* 忽略 */ }
          });
        }
        if (win.addEventListener) {
          // pagehide/beforeunload：WebView 里"页面被销毁/重载"会走这里。
          // ⚠️ 它**不等于**进程安全退出，但对"崩溃 vs 正常关闭"的区分已经够用，
          //    而且这是唯一可用的信号（Android 不给页面"我要杀你了"的回调）。
          win.addEventListener('pagehide', () => end_clean('pagehide'));
          win.addEventListener('beforeunload', () => end_clean('beforeunload'));
        }
      } catch (_e) { /* 忽略 */ }

      // 4) 把上一轮的报告画出来（DOM 元素存在才画）
      try {
        const doc = win.document;
        if (doc) {
          if (doc.readyState === 'loading' && doc.addEventListener) {
            doc.addEventListener('DOMContentLoaded', () => { render(); });
          } else {
            render();
          }
          const btn = doc.getElementById && doc.getElementById('crash-clear');
          if (btn && btn.addEventListener) {
            btn.addEventListener('click', () => { clear(); note('crash', '用户清掉了上一轮的报告'); });
          }
        }
      } catch (_e) { /* 忽略 */ }

      return api;
    }

    /** 当前会话的落盘内容（自测用）。 */
    function snapshot() {
      return cur ? JSON.parse(JSON.stringify(cur)) : null;
    }

    /** 当前会话的行数/持久化是否可用（自测用）。 */
    function status() {
      return {
        installed,
        persist_ok,
        has_storage: !!store,
        session: cur ? cur.session : null,
        lines: cur ? cur.lines.length : 0,
        hb: cur ? cur.hb : 0,
        errors: error_count,
        prev: prev_data,
        prev_abnormal: !!prev_report,
      };
    }

    /** 只读上一次会话的原始数据（自测用）。 */
    function prev_session() {
      return prev_data ? JSON.parse(JSON.stringify(prev_data)) : null;
    }

    const api = {
      KEY, MAX_LINES, FLUSH_MS, REPORT_LINES,
      install, note, marker, flush_now, flush_soon,
      report_text, render, clear, snapshot, status, prev_session,
      note_error, end_clean, beat,
      _set_prev_for_test(d) { prev_data = d; prev_report = prev_is_abnormal() ? prev_report_text() : null; },
    };
    return api;
  }

  /**
   * 浏览器（页面 / WebView）里**自动装一次**：装钩子、开新会话、把上一轮的报告
   * 画出来。
   *
   * ⚠️ 刻意**不在 CommonJS（require）下自动装**：phone/test/ 那几套 Node 自测
   *    会 require 这个文件，而它们自己伪造了 document/localStorage —— 自动装会
   *    在测试进程里挂一个心跳定时器、还会往假的 localStorage 里写字。自测里用
   *    create() 自己造实例（见 phone/test/ui.mjs 第 14 节）。
   */
  let singleton = null;
  try {
    const via_require = (typeof module !== 'undefined' && module.exports);
    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
    if (!via_require && g && g.document) {
      singleton = create({ window: g });
      singleton.install();
    }
  } catch (_e) {
    singleton = null;
  }

  /** 全局 API：没装成（Node / 极端环境）时全部退化成空操作，绝不抛错。 */
  const noop = () => {};
  const facade = {
    KEY, MAX_LINES, MAX_LINE, FLUSH_MS, REPORT_LINES, HB_MS,
    create, stamp, instance: singleton, installed: !!singleton,
  };
  for (const k of ['install', 'note', 'marker', 'flush_now', 'flush_soon',
                   'render', 'clear', 'snapshot', 'prev_session',
                   'note_error', 'end_clean', 'beat']) {
    facade[k] = singleton ? singleton[k].bind(singleton) : noop;
  }
  facade.report_text = singleton ? singleton.report_text : () => null;
  facade.status = singleton ? singleton.status : () => ({ installed: false, has_storage: false });
  return facade;
}));
