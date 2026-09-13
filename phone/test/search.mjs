/*
 * NavPuck **地点搜索** 自测（phone/search.js + app.js 里那一栏界面）。
 *
 * 为什么要单独一套、而不是并进 ui.mjs：
 *   ui.mjs 那套 DOM 打桩是**刻意最小**的（只有 getElementById + textContent），
 *   而搜索结果是一棵**动态建出来的** DOM 树（createElement / appendChild /
 *   子节点遍历）。往那套桩里加 DOM 语义，等于同时改一个 400 多项的既有套件；
 *   这里自己带一套够用的桩，ui.mjs 那边只留"id 在不在、监听器绑没绑"。
 *
 * 这一套钉三件事，每一条都是踩过或者差点踩到的：
 *
 *   1) **位置偏置不是可选项**（search.js 文件头里有实测数据）：不带偏置搜
 *      「西湖」返回的是台湾高雄的同名地点（差 800 公里）。所以这里不仅测
 *      search.js 会不会把偏置拼进 URL，还测 **app.js 在拿得到位置时一定带上它**
 *      —— 后者才是真正防"搜到别的省"的那一道。
 *   2) **"没这个地方"和"请求失败"必须说成两句话**：`ok:true, results:[]` 是
 *      "上游明确说没有"，`ok:false` 是"这次没问成"。混成一句，用户就会对着
 *      网络问题一直换关键词。
 *   3) **点选结果必须真的成为目的地**：这里有个很隐蔽的坑 ——
 *      `read_destination()` 里"常用地点"下拉是**优先于**坐标框的（见那个方法
 *      的说明），所以点选时不清掉下拉，用户看到的坐标变了、实际用的还是旧的。
 *      这一条用 `read_destination()` 的返回值直接钉住（不是只看输入框）。
 *
 * ⚠️ 全程**不联网**：所有 fetch 都是注入的假实现。公共 Photon 是别人捐的
 *    算力，自测去打它既不稳定也不礼貌。唯一的例外是最后一节（真网络实测），
 *    它**不属于自测**，只有显式设了 NAVPUCK_SEARCH_LIVE=1 才跑。
 *
 * 怎么跑（在 navpuck 根目录）：
 *     node phone/test/search.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.resolve(__dirname, '..');

const NM = require(path.join(PHONE_DIR, 'navmath.js'));
const RT = require(path.join(PHONE_DIR, 'route.js'));
const SR = require(path.join(PHONE_DIR, 'search.js'));

// ---------------------------------------------------------------------------
// 测试框架（和别的几套同一种输出形状）
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let group = '';
let _last_total = -1;
let _last_name = '(开始)';
function section(n) {
  const total = passed + failures.length;
  if (total === _last_total) {
    const msg = `自测自身：上一节「${_last_name}」一条断言都没有执行 —— ` +
      '多半是 async IIFE 忘了调用（结尾写成 }); 而不是 })();）';
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
  _last_total = total;
  _last_name = n;
  group = n;
  console.log(`\n[${n}]`);
}
function end_sections() {
  if (passed + failures.length === _last_total) {
    const msg = `自测自身：最后一节「${_last_name}」一条断言都没有执行`;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function ok(c, l) {
  if (c) { passed += 1; console.log(`  ✓ ${l}`); }
  else { failures.push(`${group} :: ${l}`); console.log(`  ✗ ${l}`); }
}
function eq(a, b, l) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x === y) { passed += 1; console.log(`  ✓ ${l}`); }
  else {
    failures.push(`${group} :: ${l}\n      期望 ${y}\n      实得 ${x}`);
    console.log(`  ✗ ${l}\n      期望 ${y}\n      实得 ${x}`);
  }
}
function near(a, b, l, tol) {
  const t = tol === undefined ? 1e-9 : tol;
  const scale = Math.max(1, Math.abs(b));
  if (Number.isFinite(a) && Math.abs(a - b) <= t * scale) {
    passed += 1; console.log(`  ✓ ${l}  (${a})`);
  } else {
    failures.push(`${group} :: ${l}\n      期望 ${b}\n      实得 ${a}`);
    console.log(`  ✗ ${l}\n      期望 ${b}\n      实得 ${a}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 假的 Photon / Nominatim 应答。
//
// ⭐ 坐标用的是**真机/开发机上实测到的真值**（见 search.js 文件头）：
//    「广州塔」   -> 23.1088, 113.3180  building=trn
//    「西湖」(偏置杭州) -> 30.2460, 120.1431 water=lake
//    不带偏置的「杭州西湖」-> 22.7272, 120.3230（台湾高雄楠梓區，**错的**那个）
//    这样"偏置能救命"这件事在自测里也是**用真数据**说的。
// ---------------------------------------------------------------------------
function photon_feature(name, lon, lat, props) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: Object.assign({ name: name,
      osm_key: 'highway', osm_value: 'unclassified' }, props || {}),
  };
}

/** 一条假的 fetch：按 URL 路由，记录全部请求。 */
function fake_fetch(routes) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    const u = String(url);
    let hit = null;
    for (const [re, res] of routes) {
      if (re.test(u)) { hit = res; break; }
    }
    if (hit === null) throw new TypeError(`假 fetch：没有为 ${u} 配应答`);
    const r = (typeof hit === 'function') ? hit(u) : hit;
    return {
      ok: r.ok !== false,
      status: r.status === undefined ? (r.ok === false ? 500 : 200) : r.status,
      async json() {
        if (r.json_error) throw new Error(r.json_error);
        return r.json;
      },
      async text() { return JSON.stringify(r.json === undefined ? null : r.json); },
    };
  };
  f.calls = calls;
  return f;
}

function photon_payload(features) { return { type: 'FeatureCollection', features: features }; }

// 广州塔（真值）
const GZ_TOWER = photon_feature('广州塔', 113.3180, 23.1088,
  { osm_key: 'building', osm_value: 'trn', city: '广州市', state: '广东省', country: '中国' });
// 杭州西湖（真值）
const HZ_LAKE = photon_feature('西湖', 120.1431, 30.2460,
  { osm_key: 'water', osm_value: 'lake', city: '杭州市', state: '浙江省',
    district: '西湖区', country: '中国' });
// 台湾高雄的同名地点（不带偏置时排第一的那个，真值）
const KH_LAKE = photon_feature('西湖', 120.3230, 22.7272,
  { osm_key: 'water', osm_value: 'lake', city: '高雄市', state: '臺灣', country: '台湾' });

// ---------------------------------------------------------------------------
// 1) search.js 本体（注入假 fetch，不联网）
// ---------------------------------------------------------------------------
await (async () => {
  section('1] search.js 本体：偏置、归一化、去重、"没找到"与"失败"、缓存、超时');
  SR.clear_cache();

  // ---- 空查询：**一个请求都不许发** ----
  {
    const f = fake_fetch([[/.*/, { json: photon_payload([]) }]]);
    const r = await SR.search('   ', { fetch: f });
    eq(f.calls.length, 0, '空/空白查询不发任何请求');
    eq(r.ok, true, '空查询也算 ok（不是错误）');
    eq(r.results, [], '空查询返回空结果');
  }

  // ---- 偏置：必须出现在 URL 里（这是"别搜到别的省"的唯一手段）----
  {
    const f = fake_fetch([[/photon/, { json: photon_payload([HZ_LAKE]) }]]);
    const r = await SR.search('西湖', { lat: 30.2545, lon: 120.1350, fetch: f });
    const u = f.calls[0].url;
    ok(/lat=30\.2545/.test(u) && /lon=120\.135/.test(u),
       `带偏置时 URL 里有 lat/lon：${u.replace(/^.*\?/, '?')}`);
    ok(/zoom=14/.test(u), `偏置还带上 zoom=${SR.BIAS_ZOOM}（Photon 用它算排序距离）`);
    eq(r.biased, true, '返回值里 biased=true（界面据此判断要不要提示）');
    eq(r.source, 'photon', '来源标成 photon');
    eq(r.results.length, 1, '解析出 1 条');
    eq(r.results[0].name, '西湖', '取到名称');
    eq(r.results[0].lat, 30.2460, '纬度就是实测的那个（30.2460）');
    eq(r.results[0].lon, 120.1431, '经度就是实测的那个（120.1431）');
    eq(r.results[0].kind, 'water=lake', 'kind 保留 OSM 类型（water=lake）');
    ok(/杭州市/.test(r.results[0].detail) && /浙江省/.test(r.results[0].detail),
       `副标题里有省和市（用来分辨同名地点）：${r.results[0].detail}`);
  }

  // ---- 不带偏置：URL 里不许有 lat/lon，而且 biased=false ----
  {
    SR.clear_cache();
    const f = fake_fetch([[/photon/, { json: photon_payload([KH_LAKE]) }]]);
    const r = await SR.search('杭州西湖', { fetch: f });
    const u = f.calls[0].url;
    ok(!/lat=/.test(u) && !/lon=/.test(u), '不带偏置时 URL 里没有 lat/lon');
    eq(r.biased, false, '返回值里 biased=false —— 界面必须据此提示"结果可能来自别的城市"');
    // ⭐ 这就是那个真的踩过的坑：不带偏置搜「杭州西湖」拿到的是高雄那个
    const d_km = NM.distance_m(30.2545, 120.1350, r.results[0].lat, r.results[0].lon) / 1000;
    ok(d_km > 700,
       `⭐ 不带偏置时的第一条离杭州 ${d_km.toFixed(0)} km（实测 800 公里量级，跨了一个省）`);
  }

  // ---- 去重：同一坐标的多条只留一条 ----
  {
    SR.clear_cache();
    const a = photon_feature('西湖', 120.1431, 30.2460, { osm_key: 'water', osm_value: 'lake' });
    const b = photon_feature('西湖', 120.14312, 30.24601, { osm_key: 'place', osm_value: 'locality' });
    const f = fake_fetch([[/photon/, { json: photon_payload([a, b, GZ_TOWER]) }]]);
    const r = await SR.search('重复', { lat: 30, lon: 120, fetch: f });
    eq(r.results.length, 2, '坐标几乎相同的两条被去重（4 位小数 ≈ 11 米）');
  }

  // ---- 归一化：坏数据一律丢掉，不许变成 NaN 坐标 ----
  {
    SR.clear_cache();
    const bad = [
      { type: 'Feature' },                                        // 没有 geometry
      { geometry: { type: 'Point', coordinates: ['x', 'y'] } },    // 坐标不是数
      { geometry: { type: 'Point', coordinates: [200, 95] } },     // 超范围
      photon_feature('好的一条', 120.1, 30.2, {}),
    ];
    const f = fake_fetch([[/photon/, { json: photon_payload(bad) }]]);
    const r = await SR.search('坏数据', { fetch: f });
    eq(r.ok, true, '上游给了坏数据也算"这次问成了"（不是请求失败）');
    eq(r.results.length, 1, '3 条坏数据被丢掉，只剩 1 条好的');
    eq(SR._from_photon({ geometry: { type: 'Point', coordinates: [1, 2] } }).kind, '',
       '没有 osm_key/osm_value 时 kind 是空串（不是 undefined）');
    eq(SR._from_photon(null), null, '_from_photon(null) 返回 null（不抛）');
  }

  // ---- 上游"没有这个地方"：ok:true + 空数组（**不是**失败）----
  {
    SR.clear_cache();
    const f = fake_fetch([[/photon/, { json: photon_payload([]) }]]);
    const r = await SR.search('zzzz不存在的地名', { lat: 30, lon: 120, fetch: f });
    eq(r.ok, true, '上游返回 0 条 -> ok:true（"没这个地方"是成功的一种）');
    eq(r.results, [], '结果为空数组');
    eq(r.error, '', 'error 是空串（界面不能拿它当失败）');
    eq(f.calls.length, 1, '只问了 Photon 一次，没有因为"空结果"去兜底（空 ≠ 失败）');
  }

  // ---- 请求失败：Photon 挂了 -> 自动兜底 Nominatim；两个都挂才是 ok:false ----
  {
    SR.clear_cache();
    const f = fake_fetch([
      [/photon/, { ok: false, status: 503 }],
      [/nominatim/, { json: [{ lat: '30.2460', lon: '120.1431', name: '西湖',
        display_name: '西湖, 西湖区, 杭州市, 浙江省, 中国', type: 'lake' }] }],
    ]);
    const r = await SR.search('西湖', { lat: 30.25, lon: 120.15, fetch: f });
    eq(f.calls.length, 2, 'Photon 失败后**真的**去问了兜底 Nominatim（共 2 次请求）');
    ok(/photon/.test(f.calls[0].url) && /nominatim/.test(f.calls[1].url), '两跳顺序：先 Photon 后 Nominatim');
    ok(/viewbox=/.test(f.calls[1].url), '兜底那一次也带上了位置（viewbox）');
    eq(r.ok, true, '兜底成功 -> ok:true');
    eq(r.source, 'nominatim', '来源标成 nominatim');
    eq(r.results[0].lat, 30.2460, 'Nominatim 的 lat（字符串）被转成了数字');
    ok(/杭州市/.test(r.results[0].detail), 'Nominatim 的 display_name 变成副标题');

    // 两个都挂 -> ok:false，error 里两个原因都在
    SR.clear_cache();
    const f2 = fake_fetch([[/photon/, { ok: false, status: 503 }],
                           [/nominatim/, { ok: false, status: 502 }]]);
    const r2 = await SR.search('西湖', { lat: 30.25, lon: 120.15, fetch: f2 });
    eq(r2.ok, false, '两条路都失败 -> ok:false');
    ok(/Photon 失败/.test(r2.error) && /Nominatim/.test(r2.error),
       `error 里两个原因都写了：${r2.error}`);
    eq(r2.results, [], '失败时结果为空');

    // mirror:'photon' 明确只要 Photon 时**不许**去打扰 Nominatim
    SR.clear_cache();
    const f3 = fake_fetch([[/photon/, { ok: false, status: 503 }],
                           [/nominatim/, { json: [] }]]);
    const r3 = await SR.search('西湖', { fetch: f3, mirror: 'photon' });
    eq(f3.calls.length, 1, "mirror:'photon' 时不做兜底（只发 1 次请求）");
    eq(r3.ok, false, '只问 Photon 且失败 -> ok:false');
  }

  // ---- fetch 自己抛（DNS/断网）：**永不 reject** ----
  {
    SR.clear_cache();
    let rejected = false;
    const boom = async () => { throw new TypeError('Failed to fetch'); };
    const r = await SR.search('西湖', { fetch: boom, mirror: 'photon' })
      .catch(() => { rejected = true; return null; });
    eq(rejected, false, 'fetch 抛异常时 search() **不 reject**（永远 resolve）');
    eq(r.ok, false, '而是返回 ok:false');
    ok(/Failed to fetch/.test(r.error), `error 里带上了底层原因：${r.error}`);

    // 没有 fetch 可用（老环境）
    const r2 = await SR.search('西湖', { fetch: null, mirror: 'photon' });
    // ⚠️ Node 里有全局 fetch，所以这里给的是"显式传 null"——它会退回全局 fetch。
    //    真正"没有 fetch"的环境（老浏览器）走的是另一条分支，见下一条。
    ok(r2 === null || typeof r2.ok === 'boolean', '显式传 fetch:null 时不会炸（退回全局 fetch）');
  }

  // ---- 缓存：同一查询第二次不联网；clear_cache 之后恢复 ----
  {
    SR.clear_cache();
    const f = fake_fetch([[/photon/, { json: photon_payload([GZ_TOWER]) }]]);
    const r1 = await SR.search('广州塔', { lat: 23.1, lon: 113.3, fetch: f });
    eq(r1.from_cache, false, '第一次不是缓存命中');
    const r2 = await SR.search('广州塔', { lat: 23.1, lon: 113.3, fetch: f });
    eq(f.calls.length, 1, '第二次**零网络请求**（内存缓存命中）');
    eq(r2.from_cache, true, '第二次标成 from_cache=true');
    eq(r2.results.length, r1.results.length, '缓存给的结果和第一次一样');

    // 偏置挪动 0.1 度以内仍然命中（骑手挪几百米不该让缓存全失效）
    const r3 = await SR.search('广州塔', { lat: 23.14, lon: 113.34, fetch: f });
    eq(f.calls.length, 1, '偏置挪动 <0.1° 仍然命中缓存');
    // 挪够远就重新查
    await SR.search('广州塔', { lat: 24.1, lon: 113.3, fetch: f });
    eq(f.calls.length, 2, '偏置挪动 >0.1° 会重新查（缓存不是永久的）');

    // 失败**不进缓存**：否则"网断一秒"会变成"一直搜不到"
    SR.clear_cache();
    const f2 = fake_fetch([[/photon/, { ok: false, status: 500 }]]);
    await SR.search('失败不进缓存', { fetch: f2, mirror: 'photon' });
    await SR.search('失败不进缓存', { fetch: f2, mirror: 'photon' });
    eq(f2.calls.length, 2, '失败的查询不写缓存（第二次仍然真的去问了）');

    SR.clear_cache();
    await SR.search('广州塔', { lat: 23.1, lon: 113.3, fetch: f });
    eq(f.calls.length, 3, 'clear_cache() 之后同一个查询会重新联网');
  }

  // ---- 超时：一直不回的 fetch 必须在 timeout_ms 内被掐掉 ----
  {
    SR.clear_cache();
    const hang = (url, opts) => new Promise((_res, rej) => {
      if (opts && opts.signal && opts.signal.addEventListener) {
        opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
      }
    });
    const t0 = Date.now();
    const r = await SR.search('超时', { fetch: hang, mirror: 'photon', timeout_ms: 40 });
    const dt = Date.now() - t0;
    eq(r.ok, false, '超时 -> ok:false');
    ok(dt < 2000, `超时被真的掐掉了（${dt} ms，timeout_ms=40）`);
    ok(/abort/i.test(r.error) || /超时|aborted/.test(r.error),
       `error 里能看出是超时/中止：${r.error}`);
  }

  // ---- 上限与合法性 ----
  {
    SR.clear_cache();
    const many = [];
    for (let i = 0; i < 30; i += 1) {
      many.push(photon_feature('点' + i, 120 + i * 0.01, 30 + i * 0.01, {}));
    }
    const f = fake_fetch([[/photon/, { json: photon_payload(many) }]]);
    const r = await SR.search('很多', { fetch: f, limit: 3 });
    eq(r.results.length, 3, 'limit 生效（要 3 条就给 3 条）');
    ok(/limit=3/.test(f.calls[0].url), 'limit 也拼进了 URL');
    SR.clear_cache();
    const r2 = await SR.search('很多', { fetch: f, limit: 999 });
    ok(r2.results.length <= 25, `limit 被夹到上限 25（实得 ${r2.results.length}）`);
    eq(SR._valid_latlon(NaN, 120), false, '_valid_latlon 拒绝 NaN');
    eq(SR._valid_latlon(30, 200), false, '_valid_latlon 拒绝超范围经度');
    eq(SR._valid_latlon(30, 120), true, '_valid_latlon 接受正常值');
  }

  // ---- 常量：界面文案和自测都读它们 ----
  {
    ok(/^https:\/\/photon\.komoot\.io\//.test(SR.PHOTON_URL), `Photon 端点是 ${SR.PHOTON_URL}`);
    ok(/^https:\/\/nominatim\.openstreetmap\.org\//.test(SR.NOMINATIM_URL),
       `兜底端点是 ${SR.NOMINATIM_URL}`);
    eq(SR.SEARCH_TIMEOUT_MS, 8000, '默认超时 8 秒');
    eq(SR.SEARCH_LIMIT_DEFAULT, 8, '默认返回 8 条');
  }
})();

// ---------------------------------------------------------------------------
// DOM 打桩
//
// 比 ui.mjs 那套多三样东西：createElement / appendChild / 子节点遍历。
// 结果列表是**动态建出来的**，没有这三样就测不到"渲染"和"点选"。
// id 集合照样从**真实的 index.html** 里解析 —— 拼错 id 会被抓出来。
// ---------------------------------------------------------------------------
const HTML = fs.readFileSync(path.join(PHONE_DIR, 'index.html'), 'utf8');

class El {
  constructor(tag, id) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = id || '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.className = '';
    this.style = {};
    this.dataset = {};
    this.children = [];
    this._listeners = {};
    this._cls = new Set();
    const self = this;
    this.classList = {
      add(c) { self._cls.add(c); },
      remove(c) { self._cls.delete(c); },
      contains(c) { return self._cls.has(c); },
      toggle(c, on) {
        const want = (on === undefined) ? !self._cls.has(c) : !!on;
        if (want) self._cls.add(c); else self._cls.delete(c);
        return want;
      },
    };
  }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  appendChild(ch) { this.children.push(ch); return ch; }
  removeChild(ch) {
    const i = this.children.indexOf(ch);
    if (i >= 0) this.children.splice(i, 1);
    return ch;
  }
  addEventListener(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); }
  removeEventListener(ev, cb) {
    this._listeners[ev] = (this._listeners[ev] || []).filter((f) => f !== cb);
  }
  fire(ev, extras) {
    const list = this._listeners[ev] || [];
    for (const cb of list) {
      cb(Object.assign({ target: this, type: ev, preventDefault() {} }, extras || {}));
    }
    return list.length;
  }
  hasListener(ev) { return (this._listeners[ev] || []).length > 0; }
  /** 把整棵子树摊平成数组（断言用）。 */
  descendants() {
    const out = [];
    for (const ch of this.children) { out.push(ch); out.push(...ch.descendants()); }
    return out;
  }
  /** 按 class 找子孙（断言用）。 */
  by_class(cls) { return this.descendants().filter((e) => e.className === cls); }
}

const BY_ID = new Map();
for (const m of HTML.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)>/g)) {
  const idm = /\bid="([^"]+)"/.exec(m[2]);
  if (idm && !BY_ID.has(idm[1])) BY_ID.set(idm[1], new El(m[1], idm[1]));
}

const BODY = new El('body', '');
globalThis.document = {
  readyState: 'loading',            // ⚠️ 见下：别让 app.js 顶层真的去跑 init()
  visibilityState: 'visible',
  body: BODY,
  getElementById: (id) => BY_ID.get(id) || null,
  createElement: (tag) => new El(tag, ''),
  addEventListener() {},
};
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

// app.js 是经典脚本 IIFE，从 globalThis 上取依赖；顺序与 index.html 一致。
globalThis.NavPuckMath = NM;
globalThis.NavPuckProto = require(path.join(PHONE_DIR, 'proto.js'));
globalThis.NavPuckRoute = RT;
globalThis.NavPuckTiles = require(path.join(PHONE_DIR, 'tiles.js'));
globalThis.NavPuckMap = require(path.join(PHONE_DIR, 'map.js'));
globalThis.NavPuckMapView = require(path.join(PHONE_DIR, 'mapview.js'));
globalThis.NavPuckSearch = SR;
const APP = require(path.join(PHONE_DIR, 'app.js'));

// readyState = 'loading' + addEventListener 什么都不做 => app.js 顶层的 init()
// 不会被调用。这一套只测"搜索"那一块，不需要整套界面接线（那是 ui.mjs 的活）。

function new_app() {
  const app = new APP.App();
  app.log = () => {};                     // 屏蔽控制台噪声
  app.geo = null;
  app.manual = false;
  app.simdrive = false;
  app.start_lat = null;
  app.start_lon = null;
  return app;
}

// ---------------------------------------------------------------------------
// 2) 偏置从哪来（这是"必须带偏置"的第一道防线）
// ---------------------------------------------------------------------------
await (async () => {
  section('2] 偏置来源：当前位置 > 导航起点 > 地图中心 > 没有');

  const app = new_app();
  eq(app.search_bias(), null, '什么都没有时返回 null（界面应当提示"未按位置排序"）');

  app.mapview = { view: { lat: 30.30, lon: 120.30 } };
  eq(app.search_bias(), { lat: 30.30, lon: 120.30, from: 'map' },
     '只有地图视图时用**地图中心**');
  eq(app._bias_text(app.search_bias()), '按地图中心排序', '文案说得出是"按地图中心排序"');

  app.start_lat = 30.20; app.start_lon = 120.20;
  eq(app.search_bias(), { lat: 30.20, lon: 120.20, from: 'start' },
     '有导航起点时优先用它（比地图中心更贴近"我要从哪出发"）');
  eq(app._bias_text(app.search_bias()), '按导航起点排序', '文案说得出是"按导航起点排序"');

  app.geo = { lat: 30.2545, lon: 120.1350, heading: 0 };
  eq(app.search_bias(), { lat: 30.2545, lon: 120.1350, from: 'gps' },
     '有定位时**当前位置**最优先');
  eq(app._bias_text(app.search_bias()), '按当前位置排序', '文案说得出"按当前位置排序"');

  app.geo = { lat: null, lon: null, heading: null };
  eq(app.search_bias().from, 'start', '定位字段是 null 时不会当成有效偏置（退回起点）');
  app.start_lat = NaN;
  eq(app.search_bias().from, 'map', '起点的纬度是 NaN 时也退回地图中心');
  app.mapview = { view: { lat: NaN, lon: 120 } };
  eq(app.search_bias(), null, '地图中心是 NaN 时判定为"没有偏置"（不是拿 NaN 去查）');
})();

// ---------------------------------------------------------------------------
// 3) do_search：界面这一层的行为
// ---------------------------------------------------------------------------
await (async () => {
  section('3] do_search / render_search_results / pick_search_result');

  const app = new_app();
  const input = BY_ID.get('search-input');
  const info = BY_ID.get('search-info');
  const box = BY_ID.get('search-results');
  const la = BY_ID.get('dest-lat');
  const lo = BY_ID.get('dest-lon');
  const sel = BY_ID.get('dest-preset');

  // ---- 空输入：不发请求、把话说清楚 ----
  {
    SR.clear_cache();
    let calls = 0;
    app._search_fetch = async () => { calls += 1; throw new Error('不该被调到'); };
    input.value = '   ';
    const r = await app.do_search();
    eq(calls, 0, '⭐ 空输入**一个请求都不发**');
    eq(r, null, '空输入返回 null（没有结果对象）');
    eq(info.dataset.state, 'idle', '状态是 idle');
    ok(/请输入地名/.test(info.textContent), `文案是"请输入地名…"：${info.textContent}`);
    eq(box.hidden, true, '结果列表收起来（不占地方）');
    eq(box.children.length, 0, '列表里没有残留的旧条目');
  }

  // ---- 成功：列表渲染 + 文案 + 偏置说明 ----
  {
    SR.clear_cache();
    const f = fake_fetch([[/photon/, { json: photon_payload([GZ_TOWER, HZ_LAKE]) }]]);
    app._search_fetch = f;
    app.geo = { lat: 23.10, lon: 113.30, heading: 0 };   // 广州塔附近
    input.value = '塔';
    const res = await app.do_search();
    eq(res.ok, true, '搜索成功');
    eq(app.search_results.length, 2, 'app 存下了 2 条结果');
    eq(box.children.length, 2, '列表里画了 2 条');
    eq(box.hidden, false, '列表显示出来');
    eq(info.dataset.state, 'done', '状态是 done');
    ok(/找到 2 条/.test(info.textContent), `文案说"找到 2 条"：${info.textContent}`);
    ok(/按当前位置排序/.test(info.textContent), '文案写明这次是**按当前位置**排的');

    // ⭐ URL 里必须真的有偏置 —— 这是"别搜到别的省"的最终防线
    const u = f.calls[0].url;
    ok(/lat=23\.1\b/.test(u) && /lon=113\.3\b/.test(u),
       `⭐ 请求真的带上了当前位置：${u.replace(/^.*\?/, '?')}`);

    // 每条 = 名称 + 副标题（+ 距离）
    const first = box.children[0];
    eq(first.tagName, 'BUTTON', '每一条都是 <button>（可点、可聚焦）');
    eq(first.by_class('search-name').length, 1, '有名称元素');
    eq(first.by_class('search-detail').length, 1, '有副标题元素（分辨同名地点用）');
    eq(first.by_class('search-dist').length, 1, '有距离元素（有偏置时才画）');
    eq(first.by_class('search-name')[0].textContent, '广州塔', '名称是"广州塔"');
    ok(/广东省/.test(first.by_class('search-detail')[0].textContent),
       `副标题里有省份：${first.by_class('search-detail')[0].textContent}`);
    eq(first.dataset.far, undefined, '近处的结果没有"太远"标记');
    ok(/距按当前位置/.test(first.by_class('search-dist')[0].textContent),
       `距离文案指明是相对哪里：${first.by_class('search-dist')[0].textContent}`);

    // 杭州西湖离广州 ~1000km -> 必须被标出来
    const second = box.children[1];
    eq(second.dataset.far, '1', '⭐ 1000 公里外的结果带上 data-far=1（黄框）');
    ok(/km/.test(second.by_class('search-dist')[0].textContent),
       `距离用 km 写出来：${second.by_class('search-dist')[0].textContent}`);
    eq(first.dataset.index, '0', '每条都带 index（点选时按它取）');
  }

  // ---- 不带偏置：文案必须提示，而且不许假装有偏置 ----
  {
    SR.clear_cache();
    const f = fake_fetch([[/photon/, { json: photon_payload([KH_LAKE]) }]]);
    app._search_fetch = f;
    app.geo = null; app.start_lat = null; app.mapview = null;
    input.value = '杭州西湖';
    await app.do_search();
    ok(/未按位置排序/.test(info.textContent) && /没有位置/.test(info.textContent),
       `⭐ 没有位置时界面如实提示：${info.textContent}`);
    const u = f.calls[0].url;
    ok(!/lat=/.test(u), '没位置时 URL 里确实没有 lat（不是拿 0,0 去当偏置）');
    eq(info.dataset.state, 'done', '这条仍然是"成功"（搜到了，只是排得可能不对）');
    eq(box.children[0].by_class('search-dist').length, 0,
       '没有偏置时不画距离（画不出来，也不许瞎写）');
    eq(box.children[0].dataset.far, undefined, '没有偏置时不做"太远"判定');
  }

  // ---- ⭐ "没这个地方" 和 "请求失败" 必须是两句不同的话 ----
  {
    SR.clear_cache();
    app.geo = { lat: 30.25, lon: 120.14, heading: 0 };
    // (a) 上游明确说没有
    const f_empty = fake_fetch([[/photon/, { json: photon_payload([]) }]]);
    app._search_fetch = f_empty;
    input.value = '不存在的地方';
    const r1 = await app.do_search();
    eq(r1.ok, true, '(a) 上游返回空 -> ok:true');
    eq(info.dataset.state, 'empty', '(a) 状态是 empty（不是 error）');
    ok(/没找到/.test(info.textContent), `(a) 文案说"没找到"：${info.textContent}`);
    ok(!/失败/.test(info.textContent), '(a) 文案里**不能**出现"失败"');
    eq(box.hidden, true, '(a) 列表收起来');
    const text_empty = info.textContent;

    // (b) 请求失败
    SR.clear_cache();
    const f_fail = fake_fetch([[/photon/, { ok: false, status: 503 }]]);
    app._search_fetch = f_fail;
    input.value = '西湖';
    const r2 = await app.do_search();
    eq(r2.ok, false, '(b) 请求失败 -> ok:false');
    eq(info.dataset.state, 'error', '(b) 状态是 error');
    ok(/搜索失败/.test(info.textContent), `(b) 文案说"搜索失败"：${info.textContent}`);
    ok(!/没找到/.test(info.textContent), '(b) 文案里**不能**出现"没找到"');
    ok(info.textContent !== text_empty, '(b) 两句话必须不一样（这是这一节的整条理由）');
    ok(/导航不受影响/.test(info.textContent), '(b) 失败文案里带上"导航不受影响"和下一步怎么办');
  }

  // ---- 竞态：先发的慢请求回来时不能覆盖后发的快请求 ----
  {
    SR.clear_cache();
    let release_slow = null;
    const slow = (url) => new Promise((res) => {
      release_slow = () => res({
        ok: true, status: 200,
        async json() { return photon_payload([KH_LAKE]); },   // 旧答案：高雄
        async text() { return ''; },
      });
    });
    const f = fake_fetch([[/photon/, slow]]);
    app._search_fetch = f;
    input.value = '西湖';
    const p1 = app.do_search();            // 先发（慢）
    await sleep(0);
    app._search_fetch = fake_fetch([[/photon/, { json: photon_payload([HZ_LAKE]) }]]);
    input.value = '西湖 杭州';
    const p2 = await app.do_search();      // 后发（快，先回来）
    eq(app.search_results.length, 1, '后发的搜索先回来，界面是它的结果');
    eq(app.search_results[0].lat, 30.2460, '界面显示的是后发那条（杭州西湖）');
    if (release_slow) release_slow();      // 现在才让那个慢请求回来
    await p1;
    await sleep(10);
    eq(app.search_results.length, 1, '慢请求回来后仍然是 1 条（旧响应被丢掉）');
    eq(app.search_results[0].lat, 30.2460,
       '⭐ 过期响应**没有**覆盖新结果（否则用户会看到自己搜过的上一个词的结果）');
  }

  // ---- ⭐ 点选：必须真的成为目的地（含那个"预设优先"的坑）----
  {
    SR.clear_cache();
    const f = fake_fetch([[/photon/, { json: photon_payload([HZ_LAKE, GZ_TOWER]) }]]);
    app._search_fetch = f;
    app.geo = { lat: 30.25, lon: 120.14, heading: 0 };
    input.value = '西湖';
    await app.do_search();

    // 先制造那个坑：让"常用地点"下拉停在一个**别的**地点上
    sel.value = '39.9097,116.3974';        // 北京天安门
    la.value = '39.9097';
    lo.value = '116.3974';
    eq(app.read_destination(), [39.9097, 116.3974], '（前置）下拉选中时目的地就是下拉里那个');

    const picked = app.pick_search_result(0);
    eq(picked.name, '西湖', '点选返回被选中的那一条');
    eq(sel.value, '', '⭐ 点选后"常用地点"被清回"自定义坐标"（否则预设会盖掉新坐标）');
    eq(la.value, '30.246000', '纬度填进去了（6 位小数）');
    eq(lo.value, '120.143100', '经度填进去了');
    eq(app.read_destination(), [30.246, 120.1431],
       '⭐ read_destination() 现在返回的是**点选的那个地点**（这才是真正被规划用的坐标）');
    eq(app._search_picked, 0, '记下选了第几条');
    eq(box.children[0].dataset.picked, '1', '被选中的那条打了标记（用户看得出刚点的是哪个）');
    eq(box.children[1].dataset.picked, undefined, '没选的那条没有标记（切回来会清掉）');
    ok(/已选/.test(info.textContent) && /西湖/.test(info.textContent),
       `状态行说"已选：…"：${info.textContent}`);

    // 再选另一条：标记要跟着换
    app.pick_search_result(1);
    eq(box.children[0].dataset.picked, undefined, '改选之后旧的那条标记被清掉');
    eq(box.children[1].dataset.picked, '1', '新的那条被标上');
    eq(app.read_destination(), [23.1088, 113.3180], '再点一条，目的地跟着变');

    // 越界下标：不能炸
    eq(app.pick_search_result(99), null, '点一个不存在的下标返回 null（不抛）');
    eq(app.pick_search_result(-1), null, '负下标也安全');
  }

  // ---- 点选之后地图会挪过去（"这条在哪个城市"最直观的答案）----
  {
    SR.clear_cache();
    const MVm = globalThis.NavPuckMapView;
    const rec = {
      setTransform() {}, fillRect() {}, beginPath() {}, closePath() {},
      moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {}, fillText() {},
      measureText: () => ({ width: 5 }),
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
      font: '', textAlign: '', textBaseline: '',
    };
    const mv = new MVm.MapView(null, { ctx: rec, w: 240, h: 240,
                                       center: [30.25, 120.14], zoom: 16,
                                       now_ms: () => 1000000 });
    mv.view = MVm.make_view({ lat: 30.25, lon: 120.14, zoom: 16, w: 240, h: 240 });
    mv.follow = true;
    app.mapview = mv;
    const f = fake_fetch([[/photon/, { json: photon_payload([HZ_LAKE]) }]]);
    app._search_fetch = f;
    app.geo = { lat: 30.25, lon: 120.14, heading: 0 };
    input.value = '西湖';
    await app.do_search();
    app.pick_search_result(0);
    near(mv.view.lat, 30.2460, '地图中心挪到了选中那个地点', 1e-6);
    near(mv.view.lon, 120.1431, '经度也是', 1e-6);
    eq(mv.follow, false, '挪过去时**关掉跟随**（否则下一帧就被定位拽回去 = 等于没看）');
    app.mapview = null;
  }

  // ---- search.js 没加载成功：说清楚，不抛 ----
  {
    // app.js 在**加载时**就把 root.NavPuckSearch 抓进闭包了，所以只置空全局没用，
    // 必须重新 require 一遍（模拟"search.js 那个 <script> 没加载成功"）。
    const app_path = path.join(PHONE_DIR, 'app.js');
    globalThis.NavPuckSearch = undefined;
    delete require.cache[require.resolve(app_path)];
    const APP2 = require(app_path);
    const app2 = new APP2.App();
    const logs2 = [];
    app2.log = (l) => { logs2.push(String(l)); };
    input.value = '西湖';
    let threw = false;
    let r = null;
    try { r = await app2.do_search(); } catch (e) { threw = true; }
    ok(!threw, 'search.js 缺失时 do_search 不抛');
    eq(r, null, '返回 null');
    eq(info.dataset.state, 'error', '状态是 error');
    ok(/搜索模块（search\.js）没加载成功/.test(info.textContent),
       `文案说清楚是模块没加载：${info.textContent}`);
    ok(/手输/.test(info.textContent), '并且告诉用户还能怎么办（手输坐标）');
    ok(logs2.some((l) => /search\.js 没加载成功/.test(l)), '日志里也留了一行');
    ok(app2.search_bias() === null, 'search.js 缺失不影响偏置计算（它不依赖搜索模块）');
    globalThis.NavPuckSearch = SR;
    delete require.cache[require.resolve(app_path)];
    require(app_path);                     // 恢复（后面的节还要用原来的 APP）
  }

  // ---- 清空（type=search 的小叉）----
  {
    SR.clear_cache();
    const f = fake_fetch([[/photon/, { json: photon_payload([GZ_TOWER]) }]]);
    app._search_fetch = f;
    input.value = '塔';
    await app.do_search();
    ok(box.children.length > 0, '（前置）列表里有内容');
    app.clear_search_results();
    eq(box.children.length, 0, 'clear_search_results() 把列表清空');
    eq(box.hidden, true, '并且收起来');
    eq(app.search_results, [], '内存里的结果也清了');
  }
})();

// ---------------------------------------------------------------------------
// 4) 跨文件契约（这一个文件清单类的东西改起来最容易漏）
// ---------------------------------------------------------------------------
await (async () => {
  section('4] 跨文件契约：sw 预缓存 / 脚本顺序 / 不许 innerHTML');

  const SW = fs.readFileSync(path.join(PHONE_DIR, 'sw.js'), 'utf8');
  const APPJS = fs.readFileSync(path.join(PHONE_DIR, 'app.js'), 'utf8');
  const scripts = [...HTML.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);

  const assets = [...SW.matchAll(/^\s*'([a-z_]+\.js)',?$/gm)].map((m) => m[1]);
  ok(assets.includes('search.js'), 'sw.js 的预缓存清单里有 search.js');
  ok(/const CACHE = 'navpuck-phone-v17'/.test(SW),
     'sw.js 的缓存版本号 bump 到 v17（忘了的话手机上的 PWA 里就没有 search.js）');
  eq(scripts.filter((s) => !assets.includes(s)), [],
     'index.html 里的每个 <script> 都在 sw.js 的预缓存清单里');
  const i_s = scripts.indexOf('search.js');
  ok(i_s > scripts.indexOf('mapview.js'), 'search.js 排在 mapview.js 之后');
  ok(i_s >= 0 && i_s < scripts.indexOf('app.js'), 'search.js 排在 app.js 之前');

  // ⭐ 安全：结果里的 name/detail 是**第三方（OSM）来的字符串**，绝不能拼进 HTML
  const seg = APPJS.slice(APPJS.indexOf('render_search_results('),
                          APPJS.indexOf('pick_search_result('));
  ok(seg.length > 500, '（前置）截到了搜索渲染那一段源码');
  // ⚠️ 检查前必须**先把注释去掉**：这段代码的注释里正大光明地写着
  //    "刻意不用 innerHTML"，不去注释的话这条断言会因为自己那句注释而失败
  //    （第一版就是这么假红了一次）。
  const code = seg.replace(/\/\*[\s\S]*?\*\//g, '')
                 .replace(/^\s*\/\/.*$/gm, '');
  ok(!/innerHTML/.test(code), '⭐ 搜索渲染那一段里**没有** innerHTML（远程字符串只走 textContent）');
  ok(!/insertAdjacentHTML|outerHTML|document\.write/.test(code),
     '也没有 insertAdjacentHTML / outerHTML / document.write');
  ok(/createElement/.test(code) && /textContent/.test(code), '用的是 createElement + textContent');

  // 界面文案里那两种状态必须真的不一样（源码级再确认一次）
  ok(/没找到/.test(APPJS) && /搜索失败/.test(APPJS), 'app.js 里"没找到"和"搜索失败"是两套文案');
})();

// ---------------------------------------------------------------------------
// 5) 真网络实测（**不属于自测**：只有显式设了环境变量才跑）
//
// 为什么单独放一节、还要用环境变量挡住：公共 Photon 是别人捐的算力，
// 挂在每次自测里既慢又不稳定（网络抖动 => 红）。要真跑一次拿证据：
//     $env:NAVPUCK_SEARCH_LIVE = "1"; node phone/test/search.mjs
// ---------------------------------------------------------------------------
if (process.env.NAVPUCK_SEARCH_LIVE) {
  section('5] 真网络实测（NAVPUCK_SEARCH_LIVE=1 时才跑）');
  SR.clear_cache();
  const cases = [
    ['广州塔', 23.1088, 113.3180],
    ['西湖', 30.2545, 120.1350],
    ['天安门', 39.9097, 116.3974],
  ];
  for (const [q, lat, lon] of cases) {
    const t0 = Date.now();
    const r = await SR.search(q, { lat: lat, lon: lon });
    const ms = Date.now() - t0;
    ok(r.ok, `「${q}」查通了（${r.results.length} 条 / ${ms} ms）`);
    if (r.results.length) {
      const x = r.results[0];
      console.log(`      第一条：${x.name}  ${x.lat}, ${x.lon}  [${x.kind}]  ` +
                  `${x.detail}`);
      console.log(`      离偏置点 ${(NM.distance_m(lat, lon, x.lat, x.lon) / 1000).toFixed(2)} km`);
      ok(true, `「${q}」拿到了带坐标的结果`);
    } else {
      ok(false, `「${q}」0 条（按理不该：这是实测过能搜到的词）`);
    }
    SR.clear_cache();
  }
}

end_sections();

console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`  地点搜索自测通过：${passed} 项全部通过。`);
} else {
  console.log(`  ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log('='.repeat(66));
process.exit(failures.length === 0 ? 0 : 1);
