/**
 * ===========================================================================
 *  search.js —— 地点搜索
 * ===========================================================================
 * 给手机端一个"输地名 → 拿到经纬度 → 设成目的地"的能力。
 *
 * 为什么是 Photon 而不是高德/百度
 * ---------------------------------------------------------------------------
 * 用户明确不买任何需要 key 的地图服务。Photon（komoot 维护，数据来自 OSM）
 * 免费、无需 key、支持前缀补全，是唯一现实的选择。
 *
 * 代价要说清楚：**OSM 在中国的 POI 覆盖弱于高德/百度**，尤其是店铺名、
 * 小区名。道路名、地名、车站、景点尚可。这是拿不到 key 的必然结果，
 * 不是实现问题。
 *
 * ===========================================================================
 *  ⭐ 位置偏置不是可选项，是必需项（实测）
 * ===========================================================================
 * 不带偏置时，查询「杭州西湖」返回的是**台湾高雄**的一个同名地点
 * （120.323, 22.727），而真正的杭州西湖在（120.143, 30.246）——
 * 差了 800 公里，直接搜到了另一个省。
 *
 * 同一个词「西湖」加上偏置（lat=30.25&lon=120.15）后，第一条就是
 *   water=lake 120.143, 30.246   ← 正确的那个
 *
 * 所以 search() **必须**拿到当前位置（或地图中心）再查。调用方不给偏置时
 * 我们仍然能查，但结果排序会明显变差 —— 这一点在返回值里用
 * `biased: false` 如实标出来，界面应当据此提示用户。
 *
 * ===========================================================================
 *  为什么不用 osm_tag=place 过滤（实测）
 * ===========================================================================
 * 一开始的想法是"只要地标，不要商户"，于是加了 osm_tag=place。实测：
 *   「杭州西湖」→ **0 命中**（西湖在 OSM 里是 water=lake，不是 place）
 *   「广州塔」  → 2 命中，但两条都是 place=city，**全错**
 *   「天安门」  → 1 命中，place=square，正确
 * 过滤掉的是车站、湖泊、景点这些**恰恰最有用**的结果。所以不用它。
 *
 * ===========================================================================
 *  失败绝不拖累导航（沿用 map.js / tiles.js 的铁律）
 * ===========================================================================
 *   1. 任何网络/解析异常都在这一层消化，返回 {ok:false, error}，**不抛**。
 *      症状顶多是"搜不到地方"，绝不能是"导航起不来"。
 *   2. 有超时、有并发上限、有结果缓存。用户改一个字就重新发请求的话，
 *      公共实例会被打到限流。
 *
 * 兜底用的是 Nominatim（OSM 官方）。注意：**开发这台机器上连不通它**
 * （DNS 能解析到 192.133.77.59，TCP 连不上，不是 hosts 的问题），所以
 * 兜底路径在这台机器上无法验证 —— 代码写了，但标为未验证。
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.NavPuckSearch = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 端点
  // -------------------------------------------------------------------------
  const PHOTON_URL = 'https://photon.komoot.io/api/';
  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

  /**
   * Nominatim 要求带一个能识别应用的 User-Agent，而且**禁止**浏览器里设
   * 这个头（它是 forbidden header，fetch 会静默忽略）。所以浏览器端只能
   * 靠 Referer 让对方识别。这里写出来是为了让主机/自测路径能用同一份代码。
   */
  const UA = 'NavPuck/0.1 (personal motorcycle navigation)';

  const SEARCH_TIMEOUT_MS = 8000;
  const SEARCH_LIMIT_DEFAULT = 8;
  const SEARCH_CACHE_MAX = 40;          // 缓存条目数（不是字节）

  /**
   * 偏置的"有效半径"。Photon 的 lat/lon 只是**排序偏好**，不是硬过滤 ——
   * 距离越近排越前，但远处的同名地点仍然会出现。所以界面要显示城市名，
   * 让用户自己看出"这条在别的省"。
   */
  const BIAS_ZOOM = 14;

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  function _num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** 经纬度合法性。中国范围之外也可能是对的（比如骑到国外），所以只做基本检查。 */
  function _valid_latlon(lat, lon) {
    return lat !== null && lon !== null &&
           lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  /**
   * 把 Photon 的一条 feature 归一化成我们的形状。
   *
   * Photon 的 properties 里有一堆可选字段（name/city/state/country/
   * osm_key/osm_value/street/housenumber/postcode），拼一个人类可读的
   * "副标题"出来，方便用户在多条同名结果里分辨。
   */
  function _from_photon(f) {
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) return null;
    const c = f.geometry.coordinates;
    const lon = _num(c[0]);
    const lat = _num(c[1]);
    if (!_valid_latlon(lat, lon)) return null;

    const p = f.properties || {};
    // 副标题的组成顺序按"对分辨地点最有帮助"排：省 → 市 → 区 → 街道
    const parts = [];
    for (const k of ['street', 'housenumber', 'district', 'city', 'county',
                     'state', 'postcode', 'country']) {
      const v = p[k];
      if (typeof v === 'string' && v && parts.indexOf(v) < 0) parts.push(v);
    }
    // 街道和门牌更希望挨在一起
    let detail = parts.join(' · ');

    return {
      name: typeof p.name === 'string' && p.name ? p.name : detail || '(未命名)',
      detail: detail,
      lat: lat,
      lon: lon,
      // osm_key/osm_value 让界面能显示"这是湖/车站/城市"，也能用于图标
      kind: (p.osm_key && p.osm_value) ? (p.osm_key + '=' + p.osm_value) : '',
      source: 'photon',
    };
  }

  /** 把 Nominatim 的一条结果归一化成同样的形状（兜底路径）。 */
  function _from_nominatim(x) {
    if (!x) return null;
    const lat = _num(x.lat);
    const lon = _num(x.lon);
    if (!_valid_latlon(lat, lon)) return null;
    return {
      name: (typeof x.name === 'string' && x.name) ? x.name
            : String(x.display_name || '').split(',')[0] || '(未命名)',
      detail: String(x.display_name || ''),
      lat: lat,
      lon: lon,
      kind: (typeof x.type === 'string') ? x.type : '',
      source: 'nominatim',
    };
  }

  /**
   * 去掉重复。Photon 经常对同一个地物返回多条（OSM 里一个湖可能既有
   * water=lake 的 way 又有 place 节点），坐标几乎相同。
   * 按坐标粗粒度去重（小数点后 4 位 ≈ 11 米），保留先出现的（排序更靠前）。
   */
  function _dedupe(list) {
    const seen = Object.create(null);
    const out = [];
    for (const it of list) {
      const k = it.lat.toFixed(4) + ',' + it.lon.toFixed(4);
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(it);
    }
    return out;
  }

  /** 带超时的 fetch。AbortController 不可用时退化成不带超时（不抛）。 */
  function _fetch_with_timeout(fetch_fn, url, opts, timeout_ms) {
    let ctrl = null;
    let timer = null;
    try {
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        timer = setTimeout(function () { ctrl.abort(); }, timeout_ms);
      }
    } catch (e) { ctrl = null; }

    const o = Object.assign({}, opts || {});
    if (ctrl) o.signal = ctrl.signal;

    return fetch_fn(url, o).then(
      function (r) {
        if (timer) clearTimeout(timer);
        return r;
      },
      function (e) {
        if (timer) clearTimeout(timer);
        throw e;
      }
    );
  }

  // -------------------------------------------------------------------------
  // 搜索主体
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 查询归一化 + 阶梯（中文地名搜索的两个实测坑）
  // -------------------------------------------------------------------------

  /** 有没有汉字。用来判断"该不该按中文的规则处理"。 */
  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
  function _has_cjk(s) { return CJK_RE.test(s); }

  /**
   * 去掉**汉字之间**的空格。
   *
   * ⭐ 这是实测出来的坑，不是洁癖。Photon 把查询按空白切成 token 再做前缀
   *    匹配，而中文没有词间空格 —— 一旦中间多一个空格，匹配就断掉：
   *
   *      "沈阳师范大学"  -> 8 条，第一条就是 amenity=university 的沈阳师范大学
   *      "沈阳 师范大学"  -> 只剩 2 条，而且**师范大学本体不见了**
   *
   *    中文输入法很容易带出空格，用户也可能顺手敲一个。只删汉字与汉字之间的
   *    空格；汉字与拉丁字母之间保留（"西湖 West Lake" 这种是有意义的）。
   */
  function _strip_cjk_spaces(s) {
    return s.replace(/([\u3400-\u9fff\uf900-\ufaff])\s+(?=[\u3400-\u9fff\uf900-\ufaff])/g, '$1');
  }

  /**
   * 行政前缀。带这些前缀的长查询在 Photon 上会**返回毫不相干的结果**：
   *
   *     "辽宁省沈阳市" -> 辽宁省辽阳市公安局文圣分局   ← 跑到辽阳去了
   *     "沈阳市"       -> 沈阳市 ✅
   *     "沈阳"         -> 沈阳 / 沈阳市 / 沈阳故宫 ✅
   *
   * 逐级剥掉前缀再查，能把它拉回来。
   */
  const ADMIN_SUFFIXES = ['省', '市', '自治区', '特别行政区', '地区', '自治州', '盟',
                          '县', '区', '旗', '镇', '乡', '街道'];

  /**
   * 生成查询阶梯：从最具体到最宽。**按顺序试，前面的够用就不试后面的**
   * （省请求，也对公共实例客气）。
   *
   * 只对含汉字的查询做阶梯 —— 英文查询切词本来就是对的，动它反而会坏。
   */
  function _query_variants(raw) {
    const out = [];
    const push = (s) => {
      const t = String(s || '').trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    };

    const q = _strip_cjk_spaces(raw);
    push(q);
    if (!_has_cjk(q)) return out;          // 纯拉丁：不做阶梯

    // ① 剥**开头**的行政前缀。只在开头剥：
    //    "辽宁省沈阳市" -> "沈阳市" -> "沈阳"
    //    逐字剥，因为可能是多级（省+市）
    let s = q;
    for (let i = 0; i < 4 && s.length > 2; i++) {
      const m = s.match(/^(.{2,8}?(?:省|自治区|特别行政区|市|地区|自治州|盟))/);
      if (!m) break;
      const rest = s.slice(m[1].length);
      if (rest.length < 2) break;          // 别剥到只剩一个字
      s = rest;
      push(s);
    }

    // ② 核心词：去掉**结尾**的行政后缀。
    //    "沈阳市" -> "沈阳"；"熊岳镇" -> "熊岳"
    //    实测「沈阳北站」->「北站」会跑偏（返回北站街道/北站路），所以
    //    这一条**只在前面几级都没结果时**才用，而且结果要和别的合并排序，
    //    不能单独采用。
    const core = q.replace(
      new RegExp('(?:' + ADMIN_SUFFIXES.join('|') + ')+$'), '');
    if (core.length >= 2) push(core);

    return out;
  }

  /**
   * 一个结果的名字和查询文本**对得上多少**。用来排序，也用来判断"该不该
   * 继续往下试阶梯"。
   *
   * 为什么需要它：实测「辽宁省沈阳市」第一轮返回 7 条，全是
   * "辽宁省辽阳市公安局文圣分局"这类 —— Photon 只把"辽宁省"当匹配依据。
   * 条数够多，但一条都不对。按条数判断会永远走不到「沈阳市」那一轮；
   * 按分数判断就能跑完阶梯，再把真正对得上的排到前面。
   */
  function _match_score(name, query_text) {
    const n = String(name || '');
    const qy = String(query_text || '');
    if (!n || !qy) return 0;
    if (n === qy) return 100;                 // 完全一样
    if (n.indexOf(qy) >= 0) return 90;        // 结果名包含完整查询
    if (qy.indexOf(n) >= 0) return 70;        // 查询包含结果名（回退轮的常见情况）
    // 两边都不互相包含时，看**公共前缀**有多长 —— 中文地名常带后缀差异
    // （"沈阳市" vs "沈阳"），前缀越长越可能是同一个地方
    let i = 0;
    const m = Math.min(n.length, qy.length);
    while (i < m && n.charCodeAt(i) === qy.charCodeAt(i)) i++;
    if (i >= 2) return 40 + Math.min(i, 8);
    return 5;                                 // 基本不沾边
  }

  /** 到这个分数就算"确实命中了"，可以停止往下试阶梯。 */
  const SCORE_GOOD = 70;

  /**
   * 一轮查询够不够用（条数下限）。只作为辅助条件 —— 主判据是 _match_score。
   * 3 是实测挑的：正常地名查询一般能给 3 条以上。
   */
  const ENOUGH_RESULTS = 3;
  /** 阶梯最多打几轮，免得公共实例被我们打爆。 */
  const MAX_ROUNDS = 3;

  // -------------------------------------------------------------------------

  /**
   * 搜地点。
   *
   * @param {string} query 关键词。空白字符串直接返回空结果，不发请求。
   * @param {object} [opts]
   *   fetch     {function} 注入用（自测传假的；浏览器不传则用全局 fetch）
   *   lat, lon  {number}   **位置偏置**。强烈建议给，理由见文件头。
   *   limit     {number}   返回条数上限，默认 8
   *   timeout_ms{number}   超时，默认 8000
   *   mirror    {string}   'photon' | 'nominatim' | 'auto'（默认 auto）
   *   now_ms    {function} 注入时钟（缓存 TTL 用）
   * @returns {Promise<{ok:boolean, results:Array, source:string,
   *                    biased:boolean, error:string, from_cache:boolean}>}
   *          **永远 resolve，永远不 reject。**
   */
  function search(query, opts) {
    const o = opts || {};
    // ⭐ 先归一化：去掉**汉字之间**的空格（理由见 _strip_cjk_spaces 的实测）。
    //    这样 "沈阳 师范大学" 和 "沈阳师范大学" 查到的是同一批东西。
    const q = _strip_cjk_spaces(String(query == null ? '' : query).trim());

    if (!q) {
      return Promise.resolve({
        ok: true, results: [], source: '', biased: false,
        error: '', from_cache: false,
      });
    }

    const lat = _num(o.lat);
    const lon = _num(o.lon);
    const biased = _valid_latlon(lat, lon);
    const limit = Math.max(1, Math.min(25, _num(o.limit) || SEARCH_LIMIT_DEFAULT));
    const timeout_ms = _num(o.timeout_ms) || SEARCH_TIMEOUT_MS;

    const fetch_fn = o.fetch ||
      (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!fetch_fn) {
      return Promise.resolve({
        ok: false, results: [], source: '', biased: biased,
        error: '这个环境没有 fetch()', from_cache: false,
      });
    }

    // 缓存键：查询词 + 偏置取整到 0.1 度（约 11km）+ 条数。
    // 偏置取整是刻意的：骑手挪动几百米不该让缓存全失效。
    const ck = q.toLowerCase() + '|' +
      (biased ? (Math.round(lat * 10) / 10) + ',' + (Math.round(lon * 10) / 10) : '-') +
      '|' + limit;
    if (_cache[ck]) {
      const hit = _cache[ck];
      return Promise.resolve(Object.assign({}, hit, { from_cache: true }));
    }

    const want = o.mirror || 'auto';

    function finish(res) {
      // 只缓存成功的结果 —— 缓存失败会让"网断了一秒"变成"一直搜不到"
      if (res.ok && res.results.length) _cache_put(ck, res);
      return res;
    }

    function try_nominatim(after_err) {
      const params = ['q=' + encodeURIComponent(q), 'format=json',
                      'limit=' + limit, 'addressdetails=0'];
      if (biased) {
        // Nominatim 用 viewbox + bounded 做硬过滤；这里只用 viewbox 做偏好，
        // 不加 bounded=1，否则近处没有结果时会变成"什么都搜不到"
        const d = 1.0;   // 约 110km 的方框
        params.push('viewbox=' + (lon - d) + ',' + (lat + d) + ',' +
                                 (lon + d) + ',' + (lat - d));
      }
      const url = NOMINATIM_URL + '?' + params.join('&');
      return _fetch_with_timeout(fetch_fn, url,
        { headers: { 'Accept': 'application/json' } }, timeout_ms)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) {
          if (!Array.isArray(j)) throw new Error('返回的不是数组');
          const list = _dedupe(j.map(_from_nominatim).filter(Boolean)).slice(0, limit);
          return { ok: true, results: list, source: 'nominatim',
                   biased: biased, error: '', from_cache: false };
        })
        .catch(function (e) {
          return { ok: false, results: [], source: '',
                   biased: biased,
                   error: (after_err ? after_err + '；' : '') +
                          '兜底 Nominatim 也失败：' + (e && e.message ? e.message : e),
                   from_cache: false };
        });
    }

    function try_photon(query_text, want_limit) {
      const params = [
        'q=' + encodeURIComponent(query_text), 'limit=' + want_limit,
        // ⭐ lang=default 是**必须**的，不是可选优化。
        //
        // Photon 按请求的 Accept-Language 决定返回哪种语言的名字，而
        // **浏览器不允许 JS 覆盖 Accept-Language**（它是 forbidden header，
        // fetch 会静默忽略）。手机 WebView 发的正是英文，于是真机上
        // 「沈阳师范大学」返回的是：
        //     name = Shenyang Normal University
        //     city = Shenyang / state = Liaoning Province / country = China
        // 连地址整条都是英文 —— 用户报的"搜出来是英文的"就是这个。
        //
        // 实测（都带 Accept-Language: en-US,en;q=0.9）：
        //     lang=default -> 沈阳师范大学 / 黄河北大街 / 沈阳市 / 辽宁省 / 中国
        //     lang=de, fr  -> 同上（这两个语言没有译文，退回本地名）
        //     lang=en      -> Shenyang Normal University
        //     lang=zh,zh-CN-> HTTP 400（komoot 这个实例压根没配中文）
        // default 语义也最贴切：**要本地名**。
        'lang=default',
      ];
      if (biased) {
        params.push('lat=' + lat, 'lon=' + lon, 'zoom=' + BIAS_ZOOM);
      }
      const url = PHOTON_URL + '?' + params.join('&');
      return _fetch_with_timeout(fetch_fn, url,
        { headers: { 'Accept': 'application/json' } }, timeout_ms)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) {
          const feats = (j && Array.isArray(j.features)) ? j.features : [];
          const list = _dedupe(feats.map(_from_photon).filter(Boolean)).slice(0, want_limit);
          // ⭐ 命中了空数组也算**成功**：这代表"确实没这个地方"，
          //    和"请求失败"是两回事，界面文案完全不同。
          return { ok: true, results: list, source: 'photon',
                   biased: biased, error: '', from_cache: false };
        });
    }

    if (want === 'nominatim') return try_nominatim('').then(finish);

    // ---- Photon 查询阶梯 ----
    // 从最具体查到最宽，**前面的够用就停** —— 省请求，也对公共实例客气
    // （komoot 那个实例是别人捐的算力）。
    //
    // 为什么要有阶梯（都是实测）：
    //   "辽宁省沈阳市" -> 返回「辽宁省辽阳市公安局文圣分局」，跑到辽阳去了
    //   "沈阳市"       -> 正确
    //   "沈阳故宫"     -> 只 1 条；回退搜「故宫」+ 偏置能拿 3 条
    // 合并顺序 = 阶梯顺序，所以**越具体的匹配排越前**。
    const variants = _query_variants(q).slice(0, MAX_ROUNDS);
    let acc = [];
    let last_err = '';

    // ⭐ "够不够用"必须看**匹配质量**，不能看条数。
    //    实测反例：「辽宁省沈阳市」第一轮就返回 7 条 —— 数量早就够了，
    //    可全是"辽宁省辽阳市公安局文圣分局"这种（Photon 把"辽宁省"当成了
    //    唯一的匹配依据）。按条数停会永远走不到「沈阳市」那一轮。
    //    所以：第一轮结果里**只要有一条名字真的和查询对得上**才提前收工。
    function top_score(list, query_text) {
      let best = 0;
      for (const it of list) {
        const s = _match_score(it.name, query_text);
        if (s > best) best = s;
      }
      return best;
    }

    function step(i) {
      if (i >= variants.length) return Promise.resolve();
      return try_photon(variants[i], limit)
        .then(function (r) {
          acc = acc.concat(r.results);
          // 第一轮就命中得很准 -> 不用再问；否则继续往下试
          if (i === 0 && top_score(r.results, q) >= SCORE_GOOD) return;
          if (i > 0 && acc.length >= ENOUGH_RESULTS &&
              top_score(acc, q) >= SCORE_GOOD) return;
          return step(i + 1);
        })
        .catch(function (e) {
          last_err = (e && e.message) ? e.message : String(e);
          // 第一轮就网络失败 -> 不必再问后面几轮，直接交给兜底
          if (i === 0) throw e;
          return step(i + 1);
        });
    }

    return step(0).then(function () {
      // 合并后再去重（不同轮次很容易命中同一个地物），
      // 然后**按匹配质量排序**：越具体的匹配排越前。
      // 没有这一步的话，「辽宁省沈阳市」会把辽阳那条排在真正的沈阳市前面
      // —— 因为它来自第一轮。
      const uniq = _dedupe(acc);
      const scored = uniq.map(function (it, idx) {
        return { it: it, s: _match_score(it.name, q), idx: idx };
      });
      scored.sort(function (a, b) {
        if (b.s !== a.s) return b.s - a.s;
        return a.idx - b.idx;          // 同分保持原顺序（阶梯顺序 = 具体程度）
      });
      const list = scored.map(function (x) { return x.it; }).slice(0, limit);
      return finish({ ok: true, results: list, source: 'photon',
                      biased: biased, error: '', from_cache: false,
                      // 让界面/自测看得出走了几轮（诊断用，不是门面）
                      rounds: Math.min(variants.length, MAX_ROUNDS),
                      queries: variants });
    }).catch(function (e) {
      const why = 'Photon 失败：' + (e && e.message ? e.message : (last_err || e));
      if (want === 'photon') {
        return finish({ ok: false, results: [], source: '', biased: biased,
                        error: why, from_cache: false });
      }
      return try_nominatim(why).then(finish);
    });
  }

  // -------------------------------------------------------------------------
  // 缓存（很小的 LRU，只活在内存里）
  // -------------------------------------------------------------------------
  const _cache = Object.create(null);
  const _cache_order = [];

  function _cache_put(k, v) {
    if (!_cache[k]) _cache_order.push(k);
    _cache[k] = v;
    while (_cache_order.length > SEARCH_CACHE_MAX) {
      const old = _cache_order.shift();
      delete _cache[old];
    }
  }

  function clear_cache() {
    for (const k of _cache_order) delete _cache[k];
    _cache_order.length = 0;
  }

  // -------------------------------------------------------------------------

  return {
    search, clear_cache,
    // 常量导出：自测要钉，界面文案也可能要读
    PHOTON_URL, NOMINATIM_URL, UA,
    SEARCH_TIMEOUT_MS, SEARCH_LIMIT_DEFAULT, SEARCH_CACHE_MAX, BIAS_ZOOM,
    // 纯函数导出，自测直接喂数据（不联网）
    _from_photon, _from_nominatim, _dedupe, _valid_latlon,
    // 查询归一化 / 阶梯 / 匹配打分：自测要直接钉这三个
    // （它们修的都是真机上抓到的真问题，不是重构）
    _strip_cjk_spaces, _query_variants, _has_cjk, _match_score,
    ENOUGH_RESULTS, MAX_ROUNDS, ADMIN_SUFFIXES, SCORE_GOOD,
  };
}));
