/*
 * NavPuck 路网底图 —— tools/navigator.py 的 OsmMapSource 的 JavaScript 移植。
 *
 * 从 Overpass API（免费、不需要 API key）拉周边路网，做成设备能画的矢量底图，
 * 投影到**路线起点**为原点的正北平面（米），和 NAV_ROUTE 同源。
 *
 * ⚠️ 与 Python 版一致的三条关键行为，别改：
 *
 * 1. **必须检查 remark。** Overpass 被限流/超时的时候**不报错**，而是返回
 *    HTTP 200 + elements:[] + remark:"runtime error: Query timed out"。
 *    不看 remark 就会把它当成"这里本来就没有路"，症状是"底图偶尔不画"。
 *
 * 2. **缓存命中就完全不联网**，而且锚点用**缓存时的位置**，不是当前请求的位置 ——
 *    build() 会按当前位置重新投影，所以路网必须相对正确的参考点解释。
 *
 * 3. **抓取绝不能阻塞导航循环。** Python 版用后台线程；浏览器里用 fetch 的
 *    天然异步性 —— refresh() 只负责发起，build() 永远拿"上一份好数据"继续画。
 *    绝对不要在这里 await 之后再发帧。
 *
 * ---------------------------------------------------------------------------
 * 失败要快、要说得清楚、绝不能拖累导航
 * ---------------------------------------------------------------------------
 * 公共 Overpass 实例**真的会整体挂掉**。开发机上实测（手机侧同样的网络环境）：
 *   - overpass-api.de：只解析到 IPv6，TCP 443 不通；
 *   - overpass.kumi.systems：/api/status 回 200，但真正的
 *     way[highway](around:...);out geom; 查询 **>90 秒**没有响应。
 * 没有这一层的话，用户看到的就是永远停在"等待路网" —— 既不知道这是上游故障，
 * 也不知道**导航其实完全没受影响**。所以这一版：
 *
 *   1. **每个镜像单独超时**（MAP_ENDPOINT_TIMEOUT_MS = 12 秒，AbortController），
 *      一整轮刷新还有**总预算**（MAP_REFRESH_BUDGET_MS = 30 秒）。一个不响应的
 *      镜像最多吃掉一个切片，绝不可能吃掉整轮 —— refresh() 的墙钟时间因此是
 *      **有界的**（集成自测 12 节钉着这条）。
 *   2. **失败后从下一个镜像开始**（轮换）：排在最前面但长期挂掉的实例不会把后面
 *      的镜像永远饿死。再配合指数退避冷却（60 → 120 → … → 600 秒），服务刚恢复
 *      时不会被我们一群客户端重新打死（打限流的后果比"少几条路"严重得多）。
 *   3. **缓存不分镜像**：缓存键里没有 endpoint，所以镜像列表怎么改，手机上的旧
 *      缓存都还能用。过期缓存也**先用上**（状态标"缓存已旧"），而不是让屏幕空着。
 *   4. **状态机说得清楚**（status()）：在试第几个镜像 / 不可用（含逐镜像的失败
 *      原因）/ 好（多少段多少点、是否来自缓存）。界面直接照抄，不再有含糊的
 *      "等待路网"。文案常量就在这个文件里，只有一份。
 *
 * 存储从磁盘文件换成 localStorage：
 *   - 每份 15KB 左右，localStorage 一般有 5MB，60 份约 900KB，够用；
 *   - 超配额时（QuotaExceededError）**丢掉最旧的一半再重试**，失败就算了 ——
 *     缓存没了只是下次要重新联网，不能让导航崩掉。
 */

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./navmath.js'), require('./proto.js'),
                             require('./route.js'));
  } else {
    root.NavPuckMap = factory(root.NavPuckMath, root.NavPuckProto, root.NavPuckRoute);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (nm, proto, rt) {

  const MAP_CACHE_KEY = 'navpuck.osm_cache.v1';

  // ---- 网络预算（毫秒；见文件头那段说明）----------------------------------
  //
  // ⚠️ 这几个数是"用户会盯着等多久"的直接来源，改之前先想清楚：
  //   - 单个镜像 12 秒：公共实例被限流时经常二三十秒才回 504，再短会误杀
  //     "只是慢"的正常查询；再长用户就盯着"拉取中"发呆了。
  //   - 整轮 30 秒：一个不响应的镜像最多吃掉 12 秒，后面的镜像仍然有机会被试到。
  //   - 剩余预算不足 2.5 秒就不再开新镜像 —— 开了也几乎必然超时，只会把
  //     "失败"这件事拖得更久。
  const MAP_ENDPOINT_TIMEOUT_MS = 12000;
  const MAP_REFRESH_BUDGET_MS = 30000;
  const MAP_MIN_ENDPOINT_SLICE_MS = 2500;
  // 服务端自己的 [timeout:N] 要比客户端的 abort **早**这么多秒：这样它还有机会
  // 回一个带 remark 的 200（"Query timed out"），我们能把它当"限流/超时"记下来，
  // 而不是只留下一个没有上下文的 AbortError。
  const MAP_QUERY_TIMEOUT_MARGIN_S = 2;
  // 失败退避的上限（秒）。指数退避：60 -> 120 -> 240 -> 480 -> 600。
  // 服务刚恢复时最怕一堆客户端同时回来把它再打死。
  const MAP_FAIL_COOLDOWN_MAX_S = 600;

  // ---- 界面文案 ----------------------------------------------------------
  //
  // 这两句话同时被 map.js 的 status() 和 app.js 用（"map.js 都没加载成功"
  // 那条路径也得说同一句话）。**只有这一份**，改文案改这里。
  const MAP_DOWN_TEXT = '底图服务（Overpass）暂时无响应，不影响导航，路线和箭头照常工作。';
  const MAP_DISABLED_TEXT =
    '街道路网底图已关闭：不再向 Overpass 发任何请求。不影响导航 —— ' +
    '路线、箭头、转向提示和 10Hz 更新都照常；勾选"显示街道路网底图"可以重新打开。';

  /**
   * Overpass 实例。按顺序尝试，全失败才算失败。
   *
   * 前两个是 Python 版就有的行为：公共实例会轮到某个 504/超时，换一个就能过。
   * 第三个是 rOpenSci 的 osmdata 包默认采样的公共实例之一（见该包的
   * list_overpass_urls()，它列的就是 overpass-api.de 和 maps.mail.ru 这两个）。
   *
   * ⚠️ 这三条**都是"文档上真实存在"的公共实例，但开发机（以及手机所处的网络）
   *    一个都连不上通**（见文件头那段实测），所以**没有任何一条的可用性/限流
   *    策略/CORS 响应头是在这里验证过的**。别把"写在列表里"当成"能用"。
   */
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];

  /** 从 endpoint URL 里取主机名，只用于界面显示。 */
  function _host_of(ep) {
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(ep || ''));
    return m ? m[1] : String(ep || '');
  }

  /** 把年龄（秒）说成人话，给界面用。 */
  function _age_text(age_s) {
    if (!Number.isFinite(age_s) || age_s < 0) return '时间未知';
    if (age_s < 90) return `${Math.max(0, Math.floor(age_s))} 秒前`;
    if (age_s < 5400) return `${Math.floor(age_s / 60)} 分钟前`;
    if (age_s < 172800) return `${Math.floor(age_s / 3600)} 小时前`;
    return `${Math.floor(age_s / 86400)} 天前`;
  }

  /** fetch 抛出来的东西 -> 一句能给用户看的中文原因。 */
  function _err_text(e) {
    const name = e && e.name ? String(e.name) : '';
    const msg = (e && e.message !== undefined) ? String(e.message) : String(e);
    if (name === 'AbortError' || /abort/i.test(msg)) return '请求被中断';
    // fetch 连不上时抛的是 TypeError: Failed to fetch / fetch failed：
    // 对用户来说这就是"网络到不了那个镜像"。
    if (name === 'TypeError' || /fetch failed|failed to fetch|network/i.test(msg)) {
      return `网络不可达（${msg}）`;
    }
    return msg;
  }

  class OsmMapSource {
    /**
     * @param {object} opts
     *   fetch       注入的 fetch（自测用）
     *   storage     注入的 {getItem,setItem}（自测用；默认 localStorage）
     *   now         注入的时钟（秒），只用于缓存时间戳
     *   now_ms      注入的时钟（毫秒），只用于算"这一轮还剩多少预算"
     *   endpoints   Overpass 实例列表
     *   endpoint_timeout_ms / budget_ms / min_slice_ms  网络预算（自测会调小）
     *   enabled     false = 彻底关掉底图：一个 Overpass 请求都不发
     *   radius_m / max_points / max_segs  抓取与裁剪预算
     */
    constructor(opts) {
      const o = opts || {};
      this.radius_m = o.radius_m === undefined ? rt.MAP_RADIUS_M : o.radius_m;
      // 帧长是可以调的：设备端接收环到底吃不吃得下大帧，靠扫这几个值就能测出来。
      // 但注意 MAX_PAYLOAD = 1536 这条硬线：60 段 / 330 点的 payload 是 1384，
      // 再往上调就会 encode_nav_map() 抛错（见 proto.js 里那段说明）。
      this.max_points = o.max_points === undefined ? rt.MAP_MAX_POINTS : o.max_points;
      this.max_segs = o.max_segs === undefined ? rt.MAP_MAX_SEGMENTS : o.max_segs;
      this.endpoints = o.endpoints || ENDPOINTS;
      this.endpoint_timeout_ms = o.endpoint_timeout_ms === undefined
        ? MAP_ENDPOINT_TIMEOUT_MS : o.endpoint_timeout_ms;
      this.budget_ms = o.budget_ms === undefined ? MAP_REFRESH_BUDGET_MS : o.budget_ms;
      this.min_slice_ms = o.min_slice_ms === undefined
        ? MAP_MIN_ENDPOINT_SLICE_MS : o.min_slice_ms;
      this.enabled = o.enabled === undefined ? true : !!o.enabled;
      this._fetch = o.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      this._storage = o.storage === undefined ? _defaultStorage() : o.storage;
      this._now = o.now || (() => Date.now() / 1000);
      this._now_ms = o.now_ms || (() => Date.now());

      this.ways = [];                     // [[rank, [[lat,lon],...]], ...]
      this.anchor = null;                 // [lat, lon]
      this.last_fetch_t = -1e9;
      this.fail_until_t = -1e9;
      this.last_error = '';
      this.fetch_count = 0;               // 自测/诊断用：真正联网的**轮数**
      this.cache_hits = 0;
      this._fetching = false;
      this.clock_now = 0.0;
      this.cache = [];
      this._load_cache();

      // ---- 状态机（status() 的原料，界面只读它）----
      // idle | trying | ok | cached | stale | unavailable | disabled
      this.state = this.enabled ? 'idle' : 'disabled';
      this.attempt = 0;                   // 这一轮试到第几个镜像（1 起）
      this.current_endpoint = '';
      this.errors = [];                   // [{endpoint, reason, ms}] 最近的失败原因
      this.from_cache = false;
      this.stale = false;
      this.cache_t = null;                // 当前这份缓存的抓取时刻（秒）
      this.cache_endpoint = '';           // 当前这份缓存当初是谁给的（只用于显示）
      this.consecutive_fails = 0;
      this.fail_cooldown_used_s = 0;
      // 下一次从哪个镜像开始试（失败后轮换，见 _endpoint_order）
      this._start = 0;
      this._used_endpoint = '';
      this.last_ok_t = -1e9;
      this.built_segs = 0;                // build() 真的画出去过多少段/点（界面读）
      this.built_pts = 0;
    }

    // -- 存储 --------------------------------------------------------------
    _load_cache() {
      try {
        const raw = this._storage ? this._storage.getItem(MAP_CACHE_KEY) : null;
        if (!raw) { this.cache = []; return; }
        const j = JSON.parse(raw);
        this.cache = (j && j.entries) || [];
      } catch (e) {
        // 缓存坏了就当作没有 —— 绝不能因为一份垃圾 JSON 让导航起不来
        this.last_error = `缓存读取失败（忽略）：${e}`;
        this.cache = [];
      }
    }

    _save_cache() {
      if (!this._storage) return;
      const entries = this.cache.slice(-rt.MAP_CACHE_MAX);
      const write = (list) => this._storage.setItem(
        MAP_CACHE_KEY, JSON.stringify({ entries: list }));
      try {
        write(entries);
      } catch (e) {
        // 配额爆了：丢掉最旧的一半再试一次。再失败就放弃本轮写入。
        try {
          write(entries.slice(Math.floor(entries.length / 2)));
          this.cache = entries.slice(Math.floor(entries.length / 2));
        } catch (_e2) {
          this.last_error = `缓存写入失败（忽略）：${e}`;
        }
      }
    }

    /**
     * 找一份锚点离当前位置足够近的缓存。
     *
     * ⚠️ **不**看新旧、**不**看当初是哪个镜像抓的：过期由调用方决定怎么用
     * （先用上再刷新），endpoint 只写进缓存里供显示。镜像列表变化时旧缓存
     * 照样能用 —— 这是"公共实例换了一批，手机上的缓存就全废了"那种坑的解药。
     */
    _cache_lookup(lat, lon) {
      let best = null;
      let best_d = Infinity;
      for (const e of this.cache) {
        if (!e || typeof e.lat !== 'number' || typeof e.lon !== 'number') continue;
        const d = nm.distance_m(lat, lon, e.lat, e.lon);
        if (d < best_d) { best = e; best_d = d; }
      }
      if (best !== null && best_d <= rt.MAP_CACHE_REUSE_M) return best;
      return null;
    }

    _apply_cache(e) {
      // 缓存里存的是 [[rank, [[lat,lon],...]], ...]，转回同样的结构
      this.ways = e.ways.map(([r, g]) => [Number(r), g.map(([a, b]) => [Number(a), Number(b)])]);
      // 关键：锚点用**缓存时的位置**，不是当前请求的位置
      this.anchor = [e.lat, e.lon];
    }

    /** 某份缓存是否已经过期（OSM 路网变化很慢，一周足够新）。 */
    static _is_stale(e, now_s) {
      if (!e || typeof e.t !== 'number') return true;
      return (now_s - e.t) > rt.MAP_CACHE_MAX_AGE_S;
    }

    /**
     * 开关底图。
     *
     * 关掉是**真的关掉**：refresh() 直接返回，不发任何请求（abort 掉在飞的那一轮
     * 不必要 —— 它顶多再跑完剩下的预算，结果会被下一次 refresh 忽略）。
     * 重新打开等同于**一次手动重试**：把退避清掉，下一轮立刻试。
     *
     * @returns {boolean} 现在的状态（true = 打开）
     */
    set_enabled(on) {
      const want = !!on;
      this.enabled = want;
      if (!want) {
        this.state = 'disabled';
        return false;
      }
      this.consecutive_fails = 0;
      this.fail_cooldown_used_s = 0;
      this.fail_until_t = -1e9;
      this.errors = [];
      this.state = (this.anchor !== null)
        ? (this.from_cache ? (this.stale ? 'stale' : 'cached') : 'ok')
        : 'idle';
      return true;
    }

    // -- 联网 --------------------------------------------------------------
    _build_query(lat, lon, timeout_ms) {
      const server_s = Math.max(5,
        Math.floor(timeout_ms / 1000) - MAP_QUERY_TIMEOUT_MARGIN_S);
      return `[out:json][timeout:${server_s}];` +
             `way[highway](around:${Math.trunc(this.radius_m)},${lat.toFixed(6)},${lon.toFixed(6)});` +
             `out geom;`;
    }

    /** 解析 Overpass 的响应，过滤出本工程认识的 highway 等级。 */
    static _parse_ways(j) {
      const ways = [];
      for (const el of ((j && j.elements) || [])) {
        const tags = el.tags || {};
        const rank = rt.HIGHWAY_RANK[tags.highway];
        if (rank === undefined) continue;
        const geom = el.geometry || [];
        if (geom.length < 2) continue;
        ways.push([rank, geom.map((g) => [g.lat, g.lon])]);
      }
      ways.sort((a, b) => a[0] - b[0]);   // 点预算不够时先丢次要道路
      return ways;
    }

    /** 这一轮按什么顺序试镜像：从 _start 起绕一圈（失败后会轮换）。 */
    _endpoint_order() {
      const n = this.endpoints.length;
      if (n <= 1) return this.endpoints.slice();
      const start = ((this._start % n) + n) % n;
      return this.endpoints.slice(start).concat(this.endpoints.slice(0, start));
    }

    /**
     * 试**一个**镜像，最多花 timeout_ms 毫秒。
     *
     * 两层保险，缺一不可：
     *   1. AbortController —— 真去掐断那个连接（省流量、省电）；
     *   2. Promise.race 的定时器 —— 有些实现（包括自测里的假 fetch）在 abort
     *      之后并不会立刻 reject，只靠 signal 的话一个装死的镜像能把整轮预算
     *      无限拖下去。没有 AbortController 的老浏览器就只剩这一层。
     *
     * @returns {Promise<{ok:boolean, json?:object, reason?:string, ms:number}>}
     *          永远 resolve，不抛 —— 调用方只需要看 ok。
     */
    async _try_endpoint(ep, q, timeout_ms) {
      const t0 = this._now_ms();
      const secs = Math.max(1, Math.floor(timeout_ms / 1000));
      let timer = null;
      let ac = null;
      try {
        if (!this._fetch) throw new Error('这个环境没有 fetch()');
        if (typeof AbortController !== 'undefined') ac = new AbortController();
        const work = (async () => {
          const resp = await this._fetch(ep, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(q),
            signal: ac ? ac.signal : undefined,
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const j = await resp.json();
          // 关键：Overpass 限流/超时时是 HTTP 200 + 空 elements + remark。
          if (j && j.remark) throw new Error(`Overpass remark: ${j.remark}`);
          return j;
        })();
        const timeout = new Promise((_res, rej) => {
          timer = setTimeout(() => {
            if (ac) { try { ac.abort(); } catch (_e) { /* 忽略 */ } }
            rej(new Error('请求超时'));
          }, timeout_ms);
        });
        // race 已经收下失败，这里再挂一个空 catch，免得 work 稍后 reject 时
        // 变成 unhandled rejection（Node 里会直接终止进程）。
        work.catch(() => {});
        const j = await Promise.race([work, timeout]);
        return { ok: true, json: j, ms: this._now_ms() - t0 };
      } catch (e) {
        const msg = (e && e.message !== undefined) ? String(e.message) : String(e);
        const timed_out = /请求超时/.test(msg) || (e && e.name === 'AbortError');
        return {
          ok: false,
          ms: this._now_ms() - t0,
          reason: timed_out ? `请求超时（${secs} 秒）` : _err_text(e),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    /** 把 errors 拼成一句给界面看的"各镜像失败原因"。 */
    _reasons_text() {
      if (this.errors.length === 0) return '';
      return this.errors.map((e) => `${_host_of(e.endpoint)}：${e.reason}`).join('；');
    }

    /**
     * 记一次失败并进入冷却。
     *
     * 退避是**指数**的：60 → 120 → 240 → 480 → 600（上限
     * MAP_FAIL_COOLDOWN_MAX_S）。公共实例恢复的瞬间最怕一堆客户端同时回来把它
     * 再打死一次 —— 那会变成"服务回来了但所有人都还在被限流"。
     */
    _note_failure() {
      this.consecutive_fails += 1;
      const exp = Math.min(Math.max(this.consecutive_fails - 1, 0), 8);
      const s = Math.min(rt.MAP_FAIL_COOLDOWN_S * Math.pow(2, exp),
                         MAP_FAIL_COOLDOWN_MAX_S);
      this.fail_cooldown_used_s = s;
      this.fail_until_t = this.clock_now + s;
    }

    /** 失败收尾：轮换起点镜像、进冷却、并且**在没有数据时**才报 unavailable。 */
    _finish_failure() {
      const n = Math.max(1, this.endpoints.length);
      this._start = (this._start + 1) % n;
      this.last_error = this._reasons_text() || '没有可用的 Overpass 镜像';
      this._note_failure();
      // 手上有旧数据（过期缓存）就继续画，只是标"缓存已旧"——
      // "宁可画一份旧的，也不要让屏幕空着"。
      this.state = (this.ways && this.ways.length > 0) ? 'stale' : 'unavailable';
    }

    /**
     * 需要时**在后台**重新拉数据。立即返回，不阻塞。
     *
     * 返回 true 表示这一轮**拿到了新数据**；缓存命中/冷却中/关掉/失败都返回
     * false（底图始终用上一份好数据继续画，所以导航不会因为网络卡顿而中断）。
     *
     * 注意这个方法本身是 async，但**调用方不要 await 它** ——
     * await 会把导航循环卡在网络上，那正是 Python 版当初踩过的坑
     * （Overpass 超时 30 秒 -> 整条导航循环停 30 秒 -> 设备显示断链）。
     * 就算调用方 await 了，它也只会在**有界的预算**内返回（见文件头）。
     */
    async refresh(lat, lon, now_s) {
      try {
        return await this._refresh(lat, lon, now_s);
      } catch (err) {
        // refresh() 永远不抛：底图出任何问题都不该让 10Hz 循环看到异常。
        // 但也**不能**把异常吞掉 —— 这是"代码自己有 bug"和"上游挂了"的分水岭：
        // 原样写进状态，否则症状会变成一句说不出原因的"底图不可用"。
        this._fetching = false;
        this.last_error = String(err && err.message ? err.message : err);
        this.errors.push({
          endpoint: this.current_endpoint || '（本地）',
          reason: `内部错误：${this.last_error}`,
          ms: 0,
        });
        this._note_failure();
        this.state = (this.ways && this.ways.length > 0) ? 'stale' : 'unavailable';
        return false;
      }
    }

    async _refresh(lat, lon, now_s) {
      this.clock_now = now_s;

      if (!this.enabled) {
        // 关掉之后一个请求都不发 —— 这是界面上那个勾选的承诺，不是建议。
        this.state = 'disabled';
        return false;
      }
      if (this._fetching) return false;

      let need = true;
      if (this.anchor !== null) {
        const moved = nm.distance_m(lat, lon, this.anchor[0], this.anchor[1]);
        if ((now_s - this.last_fetch_t) < rt.MAP_REFRESH_S && moved < rt.MAP_REFRESH_MOVE_M) {
          need = false;
        }
      }

      // 缓存优先：**不论新旧**，命中就先画上，界面上立刻有东西。
      const e = this._cache_lookup(lat, lon);
      if (e !== null) {
        this._apply_cache(e);
        this.from_cache = true;
        this.cache_hits += 1;
        this.cache_t = (typeof e.t === 'number') ? e.t : null;
        this.cache_endpoint = e.ep ? String(e.ep) : '';
        this.stale = OsmMapSource._is_stale(e, this._now());
        if (!this.stale) {
          // 新鲜缓存：**完全不联网**。公共 Overpass 会限流、会 504，
          // 没这条的话每次跑导航都得看对方脸色。
          this.last_fetch_t = now_s;
          this.last_error = '';
          this.errors = [];
          this.state = 'cached';
          return false;
        }
        // 过期缓存：先用上（界面标"缓存已旧"），下面继续尝试联网刷新。
        this.state = 'stale';
      }

      if (!need) return false;
      if (now_s < this.fail_until_t) {
        // 冷却中：不重试。手里有数据就还是"缓存已旧"，没有就是"不可用"。
        this.state = (this.ways && this.ways.length > 0) ? 'stale' : 'unavailable';
        return false;
      }

      this._fetching = true;
      this.fetch_count += 1;
      this.errors = [];
      this.current_endpoint = '';
      this.attempt = 0;
      const started_ms = this._now_ms();
      const order = this._endpoint_order();
      let json = null;
      let used = '';

      for (let i = 0; i < order.length; i += 1) {
        const left = this.budget_ms - (this._now_ms() - started_ms);
        if (left < this.min_slice_ms) {
          // 预算用完：把还没试的镜像也记上原因 —— 界面上要能看出"是没轮到"，
          // 而不是让用户以为它也被试过了。
          this.errors.push({
            endpoint: order[i], ms: 0,
            reason: `未尝试（本轮 ${Math.floor(this.budget_ms / 1000)} 秒预算已用完）`,
          });
          break;
        }
        const slice = Math.min(this.endpoint_timeout_ms, left);
        const ep = order[i];
        this.current_endpoint = ep;
        this.attempt = i + 1;
        this.state = 'trying';
        // 注意这一句**没有** await 之外的副作用：它只发一个 HTTP 请求，
        // 不碰 this.ways / this.anchor，所以正在画的那份数据不会被改坏。
        const r = await this._try_endpoint(ep, this._build_query(lat, lon, slice), slice);
        if (r.ok) { json = r.json; used = ep; break; }
        this.errors.push({ endpoint: ep, reason: r.reason, ms: r.ms });
      }

      this._fetching = false;

      if (json === null) {
        this._finish_failure();
        return false;
      }

      const ways = OsmMapSource._parse_ways(json);
      if (ways.length === 0) {
        // HTTP 200 但没有一条认识的路：也算失败（remark 那条已经在
        // _try_endpoint 里拦住了，走到这里就是"真的空"）。
        this.errors.push({ endpoint: used, reason: '返回 0 条可用道路', ms: 0 });
        this._finish_failure();
        return false;
      }

      this.ways = ways;
      this.anchor = [lat, lon];
      this.last_fetch_t = now_s;
      this.last_error = '';
      this.errors = [];
      this.from_cache = false;
      this.stale = false;
      this.cache_t = null;
      this.cache_endpoint = '';
      this.current_endpoint = used;
      this._used_endpoint = used;
      this.consecutive_fails = 0;
      this.fail_cooldown_used_s = 0;
      this.fail_until_t = -1e9;
      this.last_ok_t = this._now();
      this.state = 'ok';

      // 落盘，下次这一带就离线可用。注意缓存里**没有**任何"端点"约束
      // （ep 只是给界面看"当初是谁给的"），所以镜像列表以后怎么改都不影响它。
      this.cache.push({
        lat, lon, t: this._now(), ep: _host_of(used),
        ways: ways.map(([r, g]) => [r, g]),
      });
      if (this.cache.length > rt.MAP_CACHE_MAX * 2) {
        this.cache = this.cache.slice(-rt.MAP_CACHE_MAX);
      }
      this._save_cache();
      return true;
    }

    /** "42段/330点"（还没 build 过就退回"N条路"）。 */
    _size_text() {
      if (this.built_segs > 0) return `${this.built_segs}段/${this.built_pts}点`;
      if (this.ways && this.ways.length > 0) return `${this.ways.length}条路`;
      return '无数据';
    }

    /**
     * 给界面用的一份状态快照。
     *
     * 契约（app.js 的 #map-info / #map-detail 和测试都钉着它）：
     *   state    idle | trying | ok | cached | stale | unavailable | disabled
     *   short    很短，塞进状态面板"底图"那一格
     *   summary  一句话（unavailable 时就是固定的那句"不影响导航"）
     *   detail   完整说明：现在在干什么 / 每个镜像为什么失败 / 下一步做什么
     *   reasons  每个镜像的失败原因（数组，元素形如 "overpass-api.de：请求超时（12 秒）"）
     *
     * @param {number} now_s 导航时钟（秒）。给了才能算出"还有几秒重试"。
     */
    status(now_s) {
      const now = (typeof now_s === 'number') ? now_s : this.clock_now;
      const retry_in = Math.max(0, this.fail_until_t - now);
      const out = {
        state: this.state,
        short: '—',
        summary: '',
        detail: '',
        endpoint: this.current_endpoint,
        endpoint_host: this.current_endpoint ? _host_of(this.current_endpoint) : '',
        attempt: this.attempt,
        attempts: this.endpoints.length,
        reasons: this.errors.map((e) => `${_host_of(e.endpoint)}：${e.reason}`),
        errors: this.errors.map((e) => ({
          endpoint: e.endpoint, host: _host_of(e.endpoint), reason: e.reason,
        })),
        from_cache: !!this.from_cache,
        stale: !!this.stale,
        segs: this.built_segs,
        pts: this.built_pts,
        ways: this.ways ? this.ways.length : 0,
        cooldown_s: Math.floor(this.fail_cooldown_used_s),
        retry_in_s: retry_in > 0 ? Math.ceil(retry_in) : 0,
        endpoint_timeout_ms: this.endpoint_timeout_ms,
        budget_ms: this.budget_ms,
        enabled: !!this.enabled,
      };
      const size = this._size_text();
      const why = out.reasons.length
        ? `各镜像失败原因：${out.reasons.join('；')}。` : '';
      const retry_text = out.retry_in_s > 0
        ? `已暂停，约 ${out.retry_in_s} 秒后自动重试（退避上限 ` +
          `${MAP_FAIL_COOLDOWN_MAX_S} 秒）；也可以取消勾选"显示街道路网底图"彻底关掉它。`
        : '稍后会自动重试；也可以取消勾选"显示街道路网底图"彻底关掉它。';

      switch (this.state) {
        case 'disabled':
          out.short = '已关闭';
          out.summary = '街道路网底图已关闭（不影响导航）。';
          out.detail = MAP_DISABLED_TEXT;
          break;

        case 'idle':
          // ⚠️ 这里**不写**"等待路网…"那种含糊话：它只在导航刚启动、还没发出
          //    第一次请求的那半秒里出现，详情已经说清楚"会去拉、多久给结论"。
          out.short = '未开始拉取';
          out.summary = '还没有请求过街道路网底图。';
          out.detail = `还没有请求过街道路网底图：开始导航后会自动拉取，` +
            `单个镜像最多 ${Math.floor(this.endpoint_timeout_ms / 1000)} 秒、` +
            `整轮最多 ${Math.floor(this.budget_ms / 1000)} 秒就会给结论。`;
          break;

        case 'trying':
          out.short = `拉取中 ${this.attempt}/${this.endpoints.length}`;
          out.summary = '正在请求街道路网底图。';
          out.detail = `正在请求街道路网底图：第 ${this.attempt}/${this.endpoints.length} ` +
            `个镜像 ${out.endpoint_host}（单个镜像最多 ` +
            `${Math.floor(this.endpoint_timeout_ms / 1000)} 秒，整轮最多 ` +
            `${Math.floor(this.budget_ms / 1000)} 秒）。导航不受影响。`;
          break;

        case 'ok':
          out.short = size;
          out.summary = `底图正常：${size}。`;
          out.detail = `底图正常：来自 ${out.endpoint_host}，${size}（本次实时抓取）。`;
          break;

        case 'cached':
          out.short = `${size}·缓存`;
          out.summary = `底图来自本地缓存：${size}（本次没有联网）。`;
          out.detail = `底图来自本地缓存（抓取于 ${_age_text(this._now() - this.cache_t)}）：` +
            `${size}。本次没有联网，也就不会碰到 Overpass 的限流。`;
          break;

        case 'stale':
          out.short = `${size}·缓存已旧`;
          out.summary = `底图来自本地缓存，数据偏旧：${size}。`;
          out.detail = `底图来自本地缓存，但数据已经偏旧（抓取于 ` +
            `${_age_text(this._now() - this.cache_t)}）：${size}。` +
            (out.reasons.length
              ? `刷新暂时失败，${why}导航不受影响。`
              : '正在后台尝试刷新，导航不受影响。');
          break;

        default: {   // 'unavailable' 以及任何没料到的状态
          out.state = 'unavailable';
          out.short = out.retry_in_s > 0
            ? `不可用 · ${out.retry_in_s}s后重试` : '底图不可用';
          out.summary = MAP_DOWN_TEXT;
          out.detail = `${MAP_DOWN_TEXT}${why}${retry_text}`;
          break;
        }
      }
      if (!out.summary) out.summary = out.detail;
      return out;
    }

    /**
     * 把路网投影到**路线起点**为原点的正北平面（米），和 NAV_ROUTE 同源。
     *
     * 裁剪窗口按**当前位置**算（只看车附近的路），但坐标是相对路线起点的 ——
     * 所以设备那边只要减掉 NavUpdate 里的车位置就能画，底图不必跟着车重投影。
     */
    build(origin_lat, origin_lon, lat, lon, view_m) {
      // 取一份本地引用：抓取完成时会整体替换 this.ways，引用赋值是原子的，
      // 所以这里拿到的要么全是旧数据、要么全是新数据，不会读到半截
      const ways = this.ways;
      if (!ways || ways.length === 0) {
        this.built_segs = 0;
        this.built_pts = 0;
        return new proto.NavMap();
      }

      const cos_lat = Math.cos(origin_lat * nm.DEG2RAD);
      const clip_m = view_m * 1.6;        // 离车超出这个范围的点直接丢

      const segs = [];
      let total = 0;
      for (const [_rank, geom] of ways) {
        if (segs.length >= this.max_segs || total >= this.max_points) break;

        const pts = [];
        let last_kept = null;
        for (const [plat, plon] of geom) {
          // 抽稀：离上一个保留点太近就跳过
          if (last_kept !== null &&
              nm.distance_m(last_kept[0], last_kept[1], plat, plon) < rt.MAP_SIMPLIFY_M) {
            continue;
          }
          last_kept = [plat, plon];

          // 裁剪用"相对车"的距离
          const dn_c = (plat - lat) * rt.EARTH_M_PER_DEG_LAT;
          const de_c = (plon - lon) * rt.EARTH_M_PER_DEG_LON_EQ * cos_lat;
          if (Math.abs(de_c) > clip_m || Math.abs(dn_c) > clip_m) continue;

          // 坐标用"相对当前路线原点"的米
          const dn = (plat - origin_lat) * rt.EARTH_M_PER_DEG_LAT;
          const de = (plon - origin_lon) * rt.EARTH_M_PER_DEG_LON_EQ * cos_lat;
          // i16 米的上限是 ±32767。裁剪半径只有 view*1.6（≈256m），所以正常
          // 到不了；夹一下只是"绝不发出一个解码器会当成负数的坐标"的保险。
          // ⚠️ 路线重锚（原点跟着骑手往前挪）时这份底图必须同一轮重建，
          //    否则它会整体偏掉"原点移动量"。
          pts.push([_clamp_i16(nm.pyround(de)), _clamp_i16(nm.pyround(dn))]);
        }

        if (pts.length < 2) continue;
        // 整条装不下就跳过 —— 半条路画出来是错的，不如不画
        if (total + pts.length > this.max_points) continue;
        segs.push(pts);
        total += pts.length;
      }

      if (segs.length === 0) {
        this.built_segs = 0;
        this.built_pts = 0;
        return new proto.NavMap();
      }
      // 界面要显示"多少段多少点"，而 build() 是唯一知道这件事的地方
      // （refresh 只知道抓回来多少条路）。纯记账，不影响投影结果。
      this.built_segs = segs.length;
      this.built_pts = total;
      return new proto.NavMap({
        seg_count: segs.length,
        flags: 0,
        total_pts: total,
        seg_pts: segs.map((s) => s.length),
        pts: segs.flat(),
      });
    }

    /** 诊断用：清空缓存（界面上"清空路网缓存"按钮会调）。 */
    clear_cache() {
      this.cache = [];
      this.from_cache = false;
      this.stale = false;
      this.cache_t = null;
      this.cache_endpoint = '';
      if (this.state === 'cached' || this.state === 'stale') this.state = 'idle';
      try { if (this._storage) this._storage.removeItem(MAP_CACHE_KEY); } catch (_e) { /* 忽略 */ }
    }
  }

  function _clamp_i16(v) {
    if (!Number.isFinite(v)) return 0;
    v = Math.trunc(v);
    return v < -32767 ? -32767 : (v > 32767 ? 32767 : v);
  }

  function _defaultStorage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (_e) { /* 隐私模式下访问 localStorage 会抛异常 */ }
    return null;
  }

  return {
    MAP_CACHE_KEY, ENDPOINTS, OsmMapSource, _clamp_i16,
    // 预算常量：自测和界面文案都要读，所以导出（不是"内部细节"）
    MAP_ENDPOINT_TIMEOUT_MS, MAP_REFRESH_BUDGET_MS, MAP_MIN_ENDPOINT_SLICE_MS,
    MAP_FAIL_COOLDOWN_MAX_S, MAP_QUERY_TIMEOUT_MARGIN_S,
    // 固定文案：app.js 在"map.js 都没加载成功"时也要说同一句话
    MAP_DOWN_TEXT, MAP_DISABLED_TEXT,
    _host_of, _age_text,
  };
}));
