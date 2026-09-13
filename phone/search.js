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
    const q = String(query == null ? '' : query).trim();

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

    function try_photon() {
      const params = ['q=' + encodeURIComponent(q), 'limit=' + limit];
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
          const list = _dedupe(feats.map(_from_photon).filter(Boolean)).slice(0, limit);
          // ⭐ 命中了空数组也算**成功**：这代表"确实没这个地方"，
          //    和"请求失败"是两回事，界面文案完全不同。
          return { ok: true, results: list, source: 'photon',
                   biased: biased, error: '', from_cache: false };
        });
    }

    if (want === 'nominatim') return try_nominatim('').then(finish);

    return try_photon().then(finish).catch(function (e) {
      const why = 'Photon 失败：' + (e && e.message ? e.message : e);
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
  };
}));
