/*
 * NavPuck **Service Worker 与"版本一致性"** 自测（phone/sw.js +
 * phone/test/sw_cache.mjs + app.js 里那一段版本自检）。
 *
 * 为什么值得单独一套：这个工程里**唯一**一个"代码改了、手机上却还是老样子"
 * 的坑就是它 —— 改了被预缓存的文件而忘了 bump `sw.js` 的 `CACHE`。历史上踩了
 * **十五次**，最近一次（父 agent 现场抓的）是改完 `tiles.js` 直接重建 APK，
 * 结果 Service Worker 继续发 `navpuck-phone-v16` 缓存里的旧 tiles.js
 * （实测 51,247 B、不含新加的 `_adopt_root`），修复在包里但从没被执行过，
 * 真机症状和"没修"一模一样。而且它**极难看出来**：网络、CORS、IndexedDB 全都正常。
 *
 * 这一套钉两道防线（两道都装上了，因为它们各自的失效场景不同）：
 *
 *   ① **测试期**（最早能发现的地方）：`phone/test/sw_cache.mjs` 把 ASSETS 里每个
 *      文件的 sha256 记在 `shell_manifest.json` 里，和 `sw.js` 的 `CACHE` 绑成
 *      一个不变式。内容变了而版本号没变 -> 这一套直接红，并打印该跑哪条命令。
 *   ② **运行时**（谁都不记得也照样生效）：Service Worker 会按页面请求做一次
 *      "版本自检" —— 用 `no-store` 把 ASSETS 重新取一遍、和缓存**逐字节**比对，
 *      不一样就把缓存整体更新并回一句话；页面在**没在导航、蓝牙没连着**的时候
 *      自动刷新。于是修复**当次打开就生效**，不需要任何人记得做任何事。
 *
 *    ⚠️ 为什么不做成"JS/CSS 走 network-first"（那是更常见的解法）：
 *       弱网下脚本请求会一直挂着等（可能几十秒），而**缓存优先**是立刻起来；
 *       摩托车的场景恰恰是"信号时有时无"。而且 network-first 还会造出
 *       "新 app.js + 旧 index.html"的版本错配（这个工程里 id 契约很严，
 *       错配会直接白屏）。所以服务策略一个字没改，只加了后台自检。
 *
 * 怎么跑（在 navpuck 根目录）：
 *     node phone/test/sw.mjs
 *
 * ⚠️ Service Worker 在 Node 里跑不起来 —— 所以这一套自己造了一个**够真的**
 *    假 SW 环境（self / caches / fetch / Response / Request），把 sw.js 当经典
 *    脚本注进去驱动。造得够真的判据是：sw.js 里那几处"容易写错"的分支
 *    （/tiles/ 不拦、非导航请求失败**不**回 index.html、新 SW 接管才装缓存）
 *    都能被这一套抓到。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(PHONE_DIR, '..');

const SWC = await import('./sw_cache.mjs');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1) 测试期防线：预缓存清单（内容 ↔ 版本号）的不变式
// ---------------------------------------------------------------------------
section('1] 预缓存清单：ASSETS 的内容哈希必须和 CACHE 版本号一起变');
{
  const SW_SRC = fs.readFileSync(path.join(PHONE_DIR, 'sw.js'), 'utf8');
  const v = SWC.verify(PHONE_DIR);
  if (!v.ok) {
    for (const p of v.problems) console.log(`      → ${p}`);
  }
  ok(v.ok, '⭐ 预缓存清单一致（内容哈希 + CACHE 版本号）——' +
           '改了被预缓存的文件而没 bump 的话，这里会红');
  ok(/^navpuck-phone-v\d+$/.test(v.cache || ''),
     `CACHE 名字是 navpuck-phone-v<数字>（实得 ${v.cache}）`);
  const manifest = SWC.read_manifest(PHONE_DIR);
  ok(!!manifest, 'shell_manifest.json 存在且能解析');
  eq(Object.keys(v.hash).length, v.assets.length,
     `清单里记录了全部 ${v.assets.length} 个被预缓存的文件`);
  ok(Object.values(v.hash).every((h) => /^[0-9a-f]{64}$/.test(h)),
     '每条记录都是 sha256（64 位十六进制）');

  // sw.js **自己**不在清单里 —— 它由浏览器按字节比对自动更新，
  // 这正是"改了 sw.js 不需要 bump 任何东西"的原因（但改了别的文件需要）。
  ok(!v.assets.includes('sw.js'), 'sw.js 自己不在 ASSETS 里（浏览器会按字节比对它）');

  // 清单是"内容 → 版本号"的唯一真相：两个人同时改文件时，
  // 谁能改的只有一处（--fix），所以不会出现"清单说 v18、sw.js 说 v19"。
  eq(manifest.cache, v.cache, '清单里的版本号和 sw.js 里的完全一致');

  // ASSETS 必须覆盖 index.html 里加载的每一个脚本（漏一个就是"手机上少一块"）
  const HTML = fs.readFileSync(path.join(PHONE_DIR, 'index.html'), 'utf8');
  const scripts = [...HTML.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  eq(scripts.filter((s) => !v.assets.includes(s)), [],
     'index.html 里每个 <script> 都在 ASSETS 里（漏了的话手机上那个文件取不到）');

  // ⭐ 反向验证：把某个文件的哈希改掉，verify 必须**报错**（而不是默默通过）。
  //    这是"守卫本身有没有用"的证明 —— 直接喂一份假的清单目录。
  {
    const tmp = fs.mkdtempSync(path.join(ROOT_DIR, '.sw_cache_probe_'));
    try {
      // 造一个最小环境：sw.js + 两个文件
      fs.writeFileSync(path.join(tmp, 'sw.js'),
        "const CACHE = 'navpuck-phone-v99';\nconst ASSETS = ['a.js', 'b.css'];\n", 'utf8');
      fs.mkdirSync(path.join(tmp, 'test'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'a.js'), 'A1', 'utf8');
      fs.writeFileSync(path.join(tmp, 'b.css'), 'B1', 'utf8');
      // 清单：内容对得上
      const hash = SWC.hash_assets(tmp, SWC.assets_of(fs.readFileSync(path.join(tmp, 'sw.js'), 'utf8')));
      fs.writeFileSync(path.join(tmp, 'test', SWC.MANIFEST_NAME),
        JSON.stringify({ cache: 'navpuck-phone-v99', files: hash }), 'utf8');
      ok(SWC.verify(tmp).ok, '（前置）人造环境里清单一致 -> verify 通过');
      // 改内容但不改版本号 -> 必须红
      fs.writeFileSync(path.join(tmp, 'a.js'), 'A2-改过了', 'utf8');
      const bad = SWC.verify(tmp);
      eq(bad.ok, false, '⭐ 内容变了、版本号没变 -> verify **必须**失败');
      ok(bad.problems.some((p) => /版本号没跟着变/.test(p)),
         '失败原因直指"没 bump 版本号"');
      ok(bad.problems.some((p) => /--fix/.test(p)), '并且告诉你怎么修（跑 --fix）');
      // --fix: 应该同时 bump 版本号 + 重写清单
      const fx = SWC.fix(tmp);
      eq(fx.bumped_from, 'navpuck-phone-v99', '--fix 从 v99 开始 bump');
      eq(fx.bumped_to, 'navpuck-phone-v100', '--fix bump 到 v100');
      ok(/const CACHE = 'navpuck-phone-v100'/.test(fs.readFileSync(path.join(tmp, 'sw.js'), 'utf8')),
         '⭐ --fix 真的改了 sw.js 里那一行');
      ok(SWC.verify(tmp).ok, '⭐ --fix 之后 verify 通过（内容与版本号重新绑上）');
      // 内容没再变时再 --fix：不该继续 bump
      const fx2 = SWC.fix(tmp);
      eq(fx2.bumped_to, 'navpuck-phone-v100', '--fix 幂等：内容没变就不再 bump');
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* 忽略 */ }
    }
  }
}

// ---------------------------------------------------------------------------
// 假 SW 环境
// ---------------------------------------------------------------------------
const ORIGIN = 'https://localhost';

class FakeResponse {
  constructor(body, opts) {
    const o = opts || {};
    this._buf = Buffer.from(body === undefined ? '' : String(body));
    this.status = o.status || 200;
    this.ok = this.status >= 200 && this.status < 300;
    // 真 Response 的 type 是只读的；sw.js 会用它判断"是不是自己站点的响应"
    this.type = o.type || 'basic';
    this.headers = new Map(Object.entries(o.headers || {}));
  }
  clone() {
    const r = new FakeResponse('');
    r._buf = Buffer.from(this._buf);
    r.status = this.status; r.ok = this.ok; r.type = this.type;
    r.headers = new Map(this.headers);
    return r;
  }
  async arrayBuffer() {
    return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength);
  }
  async text() { return this._buf.toString('utf8'); }
  async json() { return JSON.parse(this._buf.toString('utf8')); }
}

class FakeRequest {
  constructor(url, mode) {
    this.url = new URL(url, ORIGIN + '/').href;
    this.method = 'GET';
    this.mode = mode || 'cors';
  }
}

function _key_of(req, ignoreSearch) {
  const u = (typeof req === 'string') ? new URL(req, ORIGIN + '/') : new URL(req.url);
  return ignoreSearch ? u.pathname : (u.pathname + u.search);
}

class FakeCache {
  constructor(env) { this.env = env; this.map = new Map(); }
  async match(req, opts) {
    const k = _key_of(req, opts && opts.ignoreSearch);
    const v = this.map.get(k);
    return v ? v.clone() : undefined;
  }
  async put(req, res) { this.map.set(_key_of(req, false), res.clone()); }
  async add(url) {
    const res = await this.env.fetch(url, {});
    if (!res.ok) throw new Error('add failed: ' + url);
    await this.put(typeof url === 'string' ? new FakeRequest(url) : url, res);
  }
  async addAll(list) { for (const u of list) await this.add(u); }
  async keys() { return [...this.map.keys()].map((k) => new FakeRequest(ORIGIN + k)); }
}

class FakeCaches {
  constructor(env) { this.env = env; this.store = new Map(); }
  async open(name) {
    if (!this.store.has(name)) this.store.set(name, new FakeCache(this.env));
    return this.store.get(name);
  }
  async keys() { return [...this.store.keys()]; }
  async delete(name) { return this.store.delete(name); }
}

/**
 * 把 sw.js 当**经典脚本**注进去跑（Node 里没有 ServiceWorkerGlobalScope，
 * 所以自己造一个够真的）。返回 {fire, env, listeners}。
 */
function load_sw(src, server, opts) {
  const o = opts || {};
  const env = {
    server: server,               // {url: string|Buffer} = 站点上的文件；**null = 网络全挂**
    fetch_log: [],
    skipped: false,
    claimed: false,
    navigated: [],                // SW 主动重载过的页面地址
    posted: [],                   // SW 发给页面的消息（navigate 被挡时的退路）
    block_navigate: false,        // 模拟 WebView 把 navigate() 挡掉
    pages: [ORIGIN + '/'],        // 当前打开着的页面（clients.matchAll 用）
    navigator: { onLine: o.online === undefined ? true : !!o.online },
    cache_name: null,
  };
  /**
   * ⚠️ 这里要处理三种入参：裸文件名（install 的 ASSETS / cache.add）、
   *    Request 对象（fetch 处理器里 `fetch(req)`）、跨域绝对 URL。
   *    都用"去掉开头的 / 的 pathname"当键，和 server 的键对得上。
   */
  function server_key(u) {
    const s = (typeof u === 'string') ? u : ((u && u.url) ? u.url : String(u));
    if (/^https?:/i.test(s)) return new URL(s).pathname.replace(/^\//, '');
    return s;
  }
  env.fetch = async (url, init) => {
    const key = String(url);
    env.fetch_log.push({ url: key, cache: (init || {}).cache || '' });
    // server === null 表示"网络根本不通"：真 fetch 在这种时候是**抛**的，
    // 不是回 404 —— 这两件事在 sw.js 里走的是完全不同的分支（回退 index.html
    // 只在抛的时候发生），所以这里必须能分别模拟。
    if (env.server === null) throw new TypeError('Failed to fetch');
    const k = server_key(url);
    const hit = env.server[k];
    if (hit === undefined) return new FakeResponse('Not Found', { status: 404 });
    return new FakeResponse(hit, { status: 200 });
  };
  env.caches = new FakeCaches(env);

  const listeners = {};
  const self = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    skipWaiting: async () => { env.skipped = true; },
    clients: {
      claim: async () => { env.claimed = true; },
      // 页面列表：SW 靠它把"跑着旧代码"的页面顶掉重载（见 sw.js 的 reload_clients）
      matchAll: async () => env.pages.map((url) => ({
        url: url,
        navigate: async (u) => {
          if (env.block_navigate) throw new Error('navigate blocked (WebView)');
          env.navigated.push(String(u));
          return null;
        },
        postMessage: (m) => { env.posted.push(m); },
      })),
    },
    location: { origin: ORIGIN },
  };
  const fn = new Function('self', 'caches', 'fetch', 'Response', 'Request', 'URL',
                          'navigator', 'console',
                          src + '\n//# sourceURL=phone/sw.js');
  fn(self, env.caches, env.fetch, FakeResponse, FakeRequest, URL, env.navigator, console);

  /** 触发一个事件；返回 waitUntil 的 promise（没有就返回 null）。 */
  function fire(type, extra) {
    const list = listeners[type] || [];
    let waited = null;
    for (const fn2 of list) {
      const ev = Object.assign({
        waitUntil(p) { waited = p; },
        respondWith(p) { waited = p; },
      }, extra || {});
      fn2(ev);
    }
    return waited;
  }
  return { self, listeners, fire, env };
}

/** 读缓存里某个 key 的字节（sw.js 里存的就是 utf8 文本，方便比对）。 */
async function cache_text(env, name, key) {
  const c = await env.caches.open(name);
  const r = await c.match(key);
  if (!r) return null;
  return r.text();
}

// ---------------------------------------------------------------------------
// 2) Service Worker 本体：装/激活/取（服务策略一个字没改，必须仍然是缓存优先）
// ---------------------------------------------------------------------------
await (async () => {
  section('2] sw.js 本体：预缓存 / 缓存优先 / 离线回退 / 不碰瓦片');
  const SW_SRC = fs.readFileSync(path.join(PHONE_DIR, 'sw.js'), 'utf8');
  const v = SWC.verify(PHONE_DIR);
  const CACHE = v.cache;

  // 站点的"文件"：内容随便，但每个文件不一样，方便比对
  const server = {};
  for (const a of v.assets) server[a] = `CONTENT-OF-${a}`;

  // ---- 2a) install：把所有 ASSETS 装进缓存 ----
  {
    const w = load_sw(SW_SRC, server);
    await w.fire('install');
    await sleep(10);
    const cache = await w.env.caches.open(CACHE);
    // ⚠️ 缓存里除了 17 个文件，还有一条 SW 自己的元信息（安装判断/自检时刻）
    const keys = (await cache.keys()).map((r) => new URL(r.url).pathname)
      .filter((p) => v.assets.includes(p.replace(/^\//, '')));
    eq(keys.length, v.assets.length, `install 预缓存了全部 ${v.assets.length} 个文件`);
    eq(v.assets.filter((a) => !keys.includes('/' + a)), [], '一个都不缺');
    eq(await cache_text(w.env, CACHE, 'app.js'), 'CONTENT-OF-app.js', '内容就是站点上的那份');
    eq(await cache_text(w.env, CACHE, 'app.js'), 'CONTENT-OF-app.js', '（同一条再确认）');
    eq(w.env.skipped, true, 'install 最后调了 skipWaiting（不等旧的 SW 自己退场）');
    const meta = JSON.parse(await cache_text(w.env, CACHE, 'navpuck-shell-install.v1'));
    eq(meta.had_previous, false, '第一次装：meta.had_previous = false');
    eq(meta.changed, false, '第一次装：不算"内容变了"（没有旧的可以比）');
  }

  // ---- 2b) fetch：缓存优先（命中时一个网络请求都不发）----
  {
    const w = load_sw(SW_SRC, server);
    await w.fire('install');
    await sleep(10);
    const before = w.env.fetch_log.length;
    const p = w.fire('fetch', { request: new FakeRequest(ORIGIN + '/app.js') });
    const res = await p;
    eq(w.env.fetch_log.length, before, '⭐ 缓存命中时**零网络请求**（缓存优先）');
    eq(await res.text(), 'CONTENT-OF-app.js', '内容来自缓存');
  }

  // ---- 2c) fetch：没缓存 -> 联网 + 写缓存 ----
  {
    const w = load_sw(SW_SRC, server);
    // ⚠️ 刻意**不**跑 install：模拟"缓存里没有这个文件"
    const p = w.fire('fetch', { request: new FakeRequest(ORIGIN + '/app.js') });
    const res = await p;
    eq(await res.text(), 'CONTENT-OF-app.js', '没缓存时联网取到内容');
    await sleep(10);
    eq(await cache_text(w.env, CACHE, 'app.js'), 'CONTENT-OF-app.js', '顺手写进缓存');
  }

  // ---- 2d) 离线：导航请求回退 index.html，**别的请求绝不回退 HTML** ----
  {
    const w = load_sw(SW_SRC, null);          // server=null = 网络全挂（fetch 直接抛）
    const cache = await w.env.caches.open(CACHE);
    await cache.put('index.html', new FakeResponse('<html>壳</html>'));
    await cache.put('app.js', new FakeResponse('CONTENT-OF-app.js'));

    // 导航请求（地址栏跳转/打开 PWA）
    const navres = await w.fire('fetch', { request: new FakeRequest(ORIGIN + '/whatever', 'navigate') });
    eq(await navres.text(), '<html>壳</html>', '⭐ 离线打开（navigate）回退到缓存里的 index.html');

    // 脚本请求失败：**不许**回退 HTML
    let threw = false;
    let out = null;
    try {
      out = await w.fire('fetch', { request: new FakeRequest(ORIGIN + '/nope.js') });
    } catch (_e) { threw = true; }
    ok(threw, '⭐ 非导航请求失败时**抛**（绝不回退 index.html —— ' +
              '否则浏览器会拿一页 HTML 当 JS 解析，报的错和真正的原因毫无关系）');
    eq(out, null, '没有拿到任何响应');

    // 缓存里有的脚本，离线照样能服务（这才是"离线可用"）
    const cached = await w.fire('fetch', { request: new FakeRequest(ORIGIN + '/app.js') });
    eq(await cached.text(), 'CONTENT-OF-app.js', '⭐ 缓存里有的脚本离线照样服务');
  }

  // ---- 2e) /tiles/ 下的请求完全不走 SW（瓦片由 tiles.js 的 IndexedDB 管）----
  {
    const w = load_sw(SW_SRC, server);
    await w.fire('install');
    await sleep(10);
    const before = w.env.fetch_log.length;
    const p = w.fire('fetch', { request: new FakeRequest('https://hxyt66.github.io/navpuck/tiles/14/1/2.npt') });
    eq(p, null, '⭐ /tiles/ 的请求 SW 不拦（respondWith 都没调）');
    eq(w.env.fetch_log.length, before, '也没有替它去下载');
  }

  // ---- 2f) 跨域请求不管 ----
  {
    const w = load_sw(SW_SRC, server);
    const p = w.fire('fetch', { request: new FakeRequest('https://overpass-api.de/api/interpreter') });
    eq(p, null, '跨域请求直接交给浏览器（SW 不管）');
  }

  // ---- 2h) navigate() 被挡时的退路：给页面发消息让它自己刷 ----
  {
    const server = {};
    for (const a of v.assets) server[a] = `NEW-${a}`;
    const w = load_sw(SW_SRC, server);
    w.env.block_navigate = true;              // 模拟 WebView 拦掉了 navigate
    const old = await w.env.caches.open('navpuck-phone-v0');
    for (const a of v.assets) await old.put(a, new FakeResponse(`OLD-${a}`));
    await w.fire('install');
    await sleep(10);
    await w.fire('activate');
    await sleep(10);
    eq(w.env.navigated.length, 0, '（前置）navigate 被挡住了，一次都没有成功');
    eq(w.env.posted.length > 0, true,
       '⭐ 那就给页面发一条 shell-install-changed（页面收到后自己决定什么时候刷）');
    eq(w.env.posted[0].type, 'shell-install-changed', '消息类型对得上');
  }

  // ---- 2g) ⭐⭐ activate 时必须**由 SW 自己**把页面顶掉重载 ----
  //
  //  真机上抓到的自举问题：装完新 APK 打开，页面跑的是**缓存里的旧代码**，
  //  而"页面自己问一句缓存新不新"这条路在旧代码里根本不存在。所以只有 SW
  //  （它一定是新的：浏览器按字节比对 sw.js）能把这最后一环补上。
  {
    // (1) 升级（有旧缓存 + 内容变了）-> 必须重载
    const server = {};
    for (const a of v.assets) server[a] = `NEW-${a}`;
    const w = load_sw(SW_SRC, server);
    // 先造一个"上一版"的缓存（名字不同 = 正常 bump 过）
    const old = await w.env.caches.open('navpuck-phone-v0');
    for (const a of v.assets) await old.put(a, new FakeResponse(`OLD-${a}`));
    await w.fire('install');
    await sleep(10);
    await w.fire('activate');
    await sleep(10);
    eq(w.env.claimed, true, 'activate 里 claim 了页面');
    eq(w.env.navigated.length, 1, '⭐ 升级之后 SW 主动把页面重载了一次（自举那一环）');
    ok(/localhost/.test(w.env.navigated[0]), `重载的是页面自己的地址：${w.env.navigated[0]}`);
    eq(await cache_text(w.env, CACHE, 'app.js'), 'NEW-app.js', '缓存里已经是新内容');
    eq((await w.env.caches.keys()).includes('navpuck-phone-v0'), false,
       '旧的缓存被清掉了（否则手机上会留一堆几十 MB 的旧缓存）');

    // (2) 第一次装（没有任何旧缓存）-> **不**重载（别让首次访问白刷一次）
    const w2 = load_sw(SW_SRC, server);
    await w2.fire('install');
    await sleep(10);
    await w2.fire('activate');
    await sleep(10);
    eq(w2.env.navigated.length, 0, '第一次安装不重载（没有旧代码要顶）');

    // (3) sw.js 变了但**内容没变**（比如只改了注释）-> 也不重载
    const w3 = load_sw(SW_SRC, server);
    const same = await w3.env.caches.open('navpuck-phone-v0');
    for (const a of v.assets) await same.put(a, new FakeResponse(`NEW-${a}`));
    await w3.fire('install');
    await sleep(10);
    await w3.fire('activate');
    await sleep(10);
    eq(w3.env.navigated.length, 0, '内容没变就不重载（不做无谓的刷新）');

    // (4) 没 bump CACHE、但同一个缓存里的字节变了 -> 也要重载
    //     （这正是"改了文件忘了 bump"的形状：缓存名字没变）
    const w4 = load_sw(SW_SRC, server);
    const cur = await w4.env.caches.open(CACHE);
    for (const a of v.assets) await cur.put(a, new FakeResponse(`OLD-${a}`));
    await w4.fire('install');
    await sleep(10);
    await w4.fire('activate');
    await sleep(10);
    eq(w4.env.navigated.length, 1,
       '⭐ 同一个 CACHE 名字下内容变了 -> SW 照样把页面顶掉重载（这就是"忘了 bump"的形状）');
    eq(await cache_text(w4.env, CACHE, 'tiles.js'), 'NEW-tiles.js', '缓存被换成新的');
  }
})();

// ---------------------------------------------------------------------------
// 3) ⭐ 版本自检：SW **自己**发现缓存过期并整体更新（"忘了 bump"的运行时防线）
// ---------------------------------------------------------------------------
await (async () => {
  section('3] 版本自检：缓存不是最新的 -> 整体更新并通知页面（这就是第十六次的解药）');
  const SW_SRC = fs.readFileSync(path.join(PHONE_DIR, 'sw.js'), 'utf8');
  const v = SWC.verify(PHONE_DIR);
  const CACHE = v.cache;

  const mk_server = (tag) => {
    const s = {};
    for (const a of v.assets) s[a] = `${tag}-${a}`;
    return s;
  };
  /** 造一个"缓存里是旧版本"的 SW 环境。 */
  async function mk_stale(server, opts) {
    const w = load_sw(SW_SRC, server, opts);
    await w.fire('install');
    await sleep(10);
    return w;
  }
  /** 让页面问一句，并拿回回答。 */
  async function ask(w, opts) {
    const o = opts || {};
    let reply = null;
    const port = { postMessage: (m) => { reply = m; } };
    const p = w.fire('message', { data: { type: 'check-shell' }, ports: [port] });
    if (p) await p;
    await sleep(10);
    if (reply === null && o.source) { /* 用 source 回的情况 */ }
    return reply;
  }

  // ---- 3a) ⭐⭐ 父 agent 那次真机事故的最小复现 ----
  //
  //  缓存里是**旧的** tiles.js，站点上是**新的**（模拟"改了文件忘了 bump"）。
  //  自检必须发现它、把缓存整体换掉 —— 之后取 tiles.js 拿到的是新内容。
  {
    const server = mk_server('NEW');
    const w = await mk_stale(server);
    // 把缓存里的某个文件换回"旧版本"（等价于：这次发布改了它但没 bump CACHE）
    const cache = await w.env.caches.open(CACHE);
    await cache.put('tiles.js', new FakeResponse('OLD-tiles.js-不含新函数'));
    eq(await cache_text(w.env, CACHE, 'tiles.js'), 'OLD-tiles.js-不含新函数',
       '（前置）缓存里是旧 tiles.js');

    const rep = await ask(w);
    ok(!!rep, '自检给出了回答');
    eq(rep.checked, true, '真的查了（不是被节流/离线跳过）');
    eq(rep.changed, true, '⭐ 发现缓存不是最新的');
    eq(rep.files, ['tiles.js'], '并指名道姓说清是哪个文件');
    eq(await cache_text(w.env, CACHE, 'tiles.js'), 'NEW-tiles.js',
       '⭐ 缓存里的 tiles.js 已经被整体换成了线上的那一份');

    // 之后再取一次：拿到的就是新内容（"修复当次生效"的证据）
    const res = await w.fire('fetch', { request: new FakeRequest(ORIGIN + '/tiles.js') });
    eq(await res.text(), 'NEW-tiles.js',
       '⭐ 同一个缓存名字（没有 bump！）之后服务的就是新文件 —— 这就是那个坑的解药');
  }

  // ---- 3b) 缓存已经是最新的 -> changed:false（页面不该白刷一次）----
  {
    const server = mk_server('SAME');
    const w = await mk_stale(server);
    const rep = await ask(w);
    eq(rep.checked, true, '查了');
    eq(rep.changed, false, '内容一致 -> changed:false（页面于是不会刷新）');
    eq(rep.files, [], '没有变化的文件');
  }

  // ---- 3c) 少了文件（比如新加的 search.js 不在缓存里）也要被发现 ----
  {
    const server = mk_server('X');
    const w = await mk_stale(server);
    const cache = await w.env.caches.open(CACHE);
    // 模拟：缓存里根本没有这个文件（老版本缓存 + 新版本 ASSETS 列表）
    cache.map.delete('/search.js');
    const rep = await ask(w);
    eq(rep.changed, true, '缓存里缺文件 -> 视为需要更新');
    ok(rep.files.includes('search.js'), `缺的那个文件被点出来了：${rep.files.join('、')}`);
    eq(await cache_text(w.env, CACHE, 'search.js'), 'X-search.js', '并把它补进缓存');
  }

  // ---- 3d) 只取到一半就失败 -> **一个字都不改**（不留半新半旧）----
  {
    const server = mk_server('OK');
    const w = await mk_stale(server);
    const cache = await w.env.caches.open(CACHE);
    await cache.put('tiles.js', new FakeResponse('OLD'));
    await cache.put('app.js', new FakeResponse('OLDAPP'));
    // 让其中一个文件在"服务器上"消失（模拟部署到一半/网络半路断）
    delete server['map.js'];
    const rep = await ask(w);
    eq(rep.checked, false, '有文件取不到时 checked:false（这一次不算查过）');
    eq(rep.reason, 'fetch-failed', '理由写的是"取不全"（任何一跳失败都整体放弃）');
    eq(await cache_text(w.env, CACHE, 'tiles.js'), 'OLD',
       '⭐ 取不全就**一个字都不改**：缓存里的旧 tiles.js 还在（不留半新半旧）');
    eq(await cache_text(w.env, CACHE, 'app.js'), 'OLDAPP', 'app.js 也没被改');
  }

  // ---- 3e) 明确离线：一个请求都不发 ----
  {
    const server = mk_server('OFF');
    const w = await mk_stale(server, { online: false });
    const before = w.env.fetch_log.length;
    const rep = await ask(w);
    eq(rep.checked, false, '离线时 checked:false');
    eq(rep.reason, 'offline', '理由 = offline');
    eq(w.env.fetch_log.length, before, '⭐ 离线时**一个请求都没发**');
  }

  // ---- 3f) 节流：6 小时内只查一次（no-store 是真的重新下载，不能每次启动都跑）----
  {
    const real_now = Date.now;
    let clock = 1000000000000;
    try {
      Date.now = () => clock;
      const server = mk_server('T');
      const w = await mk_stale(server);
      const r1 = await ask(w);
      eq(r1.checked, true, '第一次真的查了');
      const before = w.env.fetch_log.length;
      const r2 = await ask(w);
      eq(r2.checked, false, '紧接着再问一次 -> 被节流');
      eq(r2.reason, 'throttled', '理由 = throttled');
      eq(w.env.fetch_log.length, before, '⭐ 节流期间一个请求都不发');

      clock += 6 * 3600 * 1000 + 1000;         // 过了 6 小时
      const cache = await w.env.caches.open(CACHE);
      await cache.put('app.js', new FakeResponse('CHANGED-LATER'));
      const r3 = await ask(w);
      eq(r3.checked, true, '过了节流窗口 -> 又查了');
      eq(r3.changed, true, '并发现了变化');
      eq(await cache_text(w.env, CACHE, 'app.js'), 'T-app.js', '缓存被更新');
    } finally {
      Date.now = real_now;
    }
  }

  // ---- 3g) 没人问就什么都不做（自检是**页面驱动**的，不在后台偷偷跑）----
  {
    const server = mk_server('QUIET');
    const w = await mk_stale(server);
    const before = w.env.fetch_log.length;
    await sleep(30);
    eq(w.env.fetch_log.length, before, '页面不主动问，SW 不会自己去重新下载（省流量）');
    eq(await ask(w, {}).then((r) => r.checked), true, '（对照）一问就查');
  }
})();

// ---------------------------------------------------------------------------
// 4) app.js 这一侧：问一句、按安全条件刷新
// ---------------------------------------------------------------------------
await (async () => {
  section('4] app.js：问 SW 要版本状态，并且**只在安全的时候**自动刷新');

  // 最小 DOM + 全局（app.js 是经典脚本 IIFE，依赖从 globalThis 取）
  const HTML = fs.readFileSync(path.join(PHONE_DIR, 'index.html'), 'utf8');
  class El {
    constructor(tag, id) {
      this.tagName = String(tag || 'div').toUpperCase(); this.id = id || '';
      this.textContent = ''; this.value = ''; this.checked = false; this.hidden = false;
      this.dataset = {}; this.style = {}; this.children = []; this._listeners = {};
      const self = this;
      this._cls = new Set();
      this.classList = {
        add(c) { self._cls.add(c); }, remove(c) { self._cls.delete(c); },
        contains(c) { return self._cls.has(c); },
        toggle(c, on) {
          const want = (on === undefined) ? !self._cls.has(c) : !!on;
          if (want) self._cls.add(c); else self._cls.delete(c);
          return want;
        },
      };
    }
    addEventListener(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); }
    removeEventListener() {}
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  }
  const BY_ID = new Map();
  for (const m of HTML.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)>/g)) {
    const idm = /\bid="([^"]+)"/.exec(m[2]);
    if (idm && !BY_ID.has(idm[1])) BY_ID.set(idm[1], new El(m[1], idm[1]));
  }
  globalThis.document = {
    readyState: 'loading',                // 别让 app.js 顶层去跑 init()
    visibilityState: 'visible',
    body: { classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } } },
    getElementById: (id) => BY_ID.get(id) || null,
    createElement: (t) => new El(t, ''),
    addEventListener() {},
  };
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, val) { this._m.set(k, String(val)); },
    removeItem(k) { this._m.delete(k); },
  };
  globalThis.NavPuckMath = require(path.join(PHONE_DIR, 'navmath.js'));
  globalThis.NavPuckProto = require(path.join(PHONE_DIR, 'proto.js'));
  globalThis.NavPuckRoute = require(path.join(PHONE_DIR, 'route.js'));
  globalThis.NavPuckTiles = require(path.join(PHONE_DIR, 'tiles.js'));
  globalThis.NavPuckMap = require(path.join(PHONE_DIR, 'map.js'));
  globalThis.NavPuckMapView = require(path.join(PHONE_DIR, 'mapview.js'));
  globalThis.NavPuckSearch = require(path.join(PHONE_DIR, 'search.js'));
  const APP = require(path.join(PHONE_DIR, 'app.js'));

  // 假 navigator.serviceWorker
  const sw_calls = [];
  let sw_reply = null;
  let controller_listener = null;
  const fake_sw = {
    controller: {
      postMessage(msg, ports) {
        sw_calls.push(msg);
        if (ports && ports[0] && sw_reply) ports[0].postMessage(sw_reply);
      },
    },
    addEventListener(t, fn) { if (t === 'controllerchange') controller_listener = fn; },
  };
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { onLine: true, serviceWorker: fake_sw },
  });
  // location.reload 的探针（Node 里没有 location，能定义就定义）
  const loc_desc = Object.getOwnPropertyDescriptor(globalThis, 'location');
  let reloads = 0;
  let loc_ok = true;
  try {
    Object.defineProperty(globalThis, 'location', {
      configurable: true, writable: true,
      value: { reload() { reloads += 1; }, href: ORIGIN + '/' },
    });
  } catch (_e) { loc_ok = false; }

  try {
    const app = new APP.App();
    const logs = [];
    app.log = (l) => { logs.push(String(l)); };

    // ---- 4a) 问一句 ----
    sw_reply = { type: 'shell-status', checked: true, changed: false, files: [], reason: '' };
    eq(app.shell_check(), true, 'shell_check() 真的发出去了（有 SW 在控制页面）');
    eq(sw_calls.length, 1, '发了一条消息');
    eq(sw_calls[0].type, 'check-shell', '消息类型是 check-shell');
    await sleep(10);
    ok(logs.some((l) => /缓存里的就是最新的/.test(l)), '没变化时只记一行日志');

    // ---- 4b) 有变化 + 安全（没导航、蓝牙没连）-> 立刻刷新 ----
    sw_reply = { type: 'shell-status', checked: true, changed: true, files: ['tiles.js'], reason: '' };
    app.shell_check();
    await sleep(10);
    ok(logs.some((l) => /发现缓存\*\*不是\*\*最新的：tiles\.js/.test(l)),
       '日志里说清是哪个文件变了');
    eq(app._shell_reloaded, true, '⭐ 安全时立刻决定刷新');
    await sleep(400);                       // 刷新是 250ms 之后才调的
    if (loc_ok) eq(reloads, 1, '⭐ 真的调了 location.reload()（修复当次打开就生效）');
    else console.log('      （Node 里没法定义 location：这一条跳过）');

    // ---- 4c) 正在导航 / 蓝牙连着 -> **绝不**刷新，押后 ----
    {
      const app2 = new APP.App();
      app2.log = () => {};
      app2.nav = { stop() {} };                   // 假装正在导航
      app2._shell_reloaded = false;
      const before = reloads;
      const r = app2.shell_reload_when_safe('shell-changed');
      eq(r, false, '⭐ 正在导航时**不**刷新（刷新会掐断 BLE 和 10Hz 循环）');
      eq(app2._shell_reload_pending, 'shell-changed', '记下"押后刷新"');
      await sleep(300);
      eq(reloads, before, '确实没有刷新');

      // 停止导航 -> 补上那次刷新
      app2.nav = null;
      const r2 = app2.shell_reload_when_safe('deferred');
      eq(r2, true, '⭐ 导航停了之后补上刷新');
      eq(app2._shell_reload_pending, '', '押后标记被清掉');

      // 蓝牙连着也算"不安全"
      const app3 = new APP.App();
      app3.log = () => {};
      app3.ble = { connected: true };
      eq(app3.shell_reload_when_safe('x'), false, '蓝牙连着时也不刷新');
      eq(app3._shell_reload_pending, 'x', '同样押后');
    }

    // ---- 4d) 只会刷一次（不会形成刷新循环）----
    {
      const app4 = new APP.App();
      app4.log = () => {};
      app4._shell_reloaded = false;
      const first = app4.shell_reload_when_safe('a');
      const second = app4.shell_reload_when_safe('b');
      eq([first, second], [true, false], '同一次会话里只会刷一次');
    }

    // ---- 4e) 没有 SW / 没有 controller：什么都不做（file:// 直开也是这样）----
    {
      Object.defineProperty(globalThis, 'navigator',
        { configurable: true, writable: true, value: { onLine: true } });
      const app5 = new APP.App();
      const logs5 = [];
      app5.log = (l) => { logs5.push(String(l)); };
      eq(app5.shell_check(), false, '没有 serviceWorker 时返回 false（不抛）');
      Object.defineProperty(globalThis, 'navigator',
        { configurable: true, writable: true, value: { onLine: true, serviceWorker: { controller: null } } });
      eq(app5.shell_check(), false, '有 SW 但还没有 controller 时也返回 false');
    }

    // ---- 4f) controllerchange（新 SW 接管）也会触发一次安全刷新判定 ----
    {
      await sleep(500);                 // 先把前面几次 250ms 后的刷新定时器排空
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true, writable: true,
        value: { onLine: true, serviceWorker: fake_sw },
      });
      const app6 = new APP.App();
      const logs6 = [];
      app6.log = (l) => { logs6.push(String(l)); };
      sw_reply = { type: 'shell-status', checked: true, changed: false, files: [], reason: '' };
      app6.shell_check();
      ok(!!controller_listener, '挂上了 controllerchange 监听');
      const before6 = reloads;
      controller_listener();
      eq(app6._shell_reloaded, true, '新 SW 接管 -> 也走同一条"安全时刷新"的路');
      await sleep(400);
      if (loc_ok) eq(reloads, before6 + 1, '确实刷新了一次');
      else eq(app6._shell_reloaded, true, '（Node 里没法定义 location：只看标志）');
    }
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    if (loc_desc) Object.defineProperty(globalThis, 'location', loc_desc);
    else { try { delete globalThis.location; } catch (_e) { /* 忽略 */ } }
  }
})();

end_sections();

console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`  Service Worker / 版本一致性自测通过：${passed} 项全部通过。`);
} else {
  console.log(`  ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log('='.repeat(66));
process.exit(failures.length === 0 ? 0 : 1);
