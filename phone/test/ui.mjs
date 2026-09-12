/*
 * NavPuck 手机端 **界面接线自测**（无浏览器）。
 *
 * 为什么需要它：
 *   selftest / parity / integration 三套测的都是"零件和接线"，它们把 DOM
 *   整个绕开了。而 app.js 里的 App 类恰恰是**唯一在本机从来没被执行过**的
 *   一大块代码 —— 它每次 `$('some-id')` 拿到的都是 null（因为
 *   `document` 是 undefined），所以哪怕 id 写错、初始化顺序错、事件绑定到
 *   不存在的元素上，前三套测试也全都报绿。
 *
 *   这一套用一个**从 index.html 真实解析出来的**极简 DOM 打桩，把
 *   index.html 里真实存在的 id 集合喂给 App.init()，然后：
 *     1) 断言 app.js 引用的每个 id 在 index.html 里都存在（防拼写错误）
 *     2) 断言 App.init() 能跑完不抛异常
 *     3) 断言按钮真的绑上了监听器
 *     4) 模拟点击"连接设备" / "用当前位置作起点" / "规划并开始导航"，
 *        走一遍 App 的真实代码路径（BLE 与 geolocation 都是伪造的）
 *     5) 断言状态面板真的被 update 写进去了
 *     6) 走一遍"高级 / 手动定位"：勾选 -> 应用 -> 导航中换源 -> 非法输入被拒，
 *        并断言手输航向真的进了 NAV_UPDATE（地图旋转就靠它）
 *
 * 怎么跑（在 navpuck 根目录）：
 *     node phone/test/ui.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1) 从 index.html 里把真实的 id 集合和元素类型解析出来
// ---------------------------------------------------------------------------
const HTML = fs.readFileSync(path.join(PHONE_DIR, 'index.html'), 'utf8');

/** 抽出所有 <tag ... id="x" ...>，记下 tag 名与 id。 */
function parse_elements(html) {
  const out = [];
  const re = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const idm = /\bid="([^"]+)"/.exec(m[2]);
    if (idm) out.push({ tag: m[1].toLowerCase(), id: idm[1], attrs: m[2] });
  }
  return out;
}
const ELEMENTS = parse_elements(HTML);
const HTML_IDS = new Set(ELEMENTS.map((e) => e.id));

/** 抽出 <script src="..."> 的顺序，验证加载顺序契约。 */
const SCRIPT_SRCS = [...HTML.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);

/** 抽出所有 for="..." 的 label，验证它们指向存在的 id。 */
const LABEL_FORS = [...HTML.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);

/** 抽出 option value（预设目的地）。 */
const PRESET_VALUES = [...HTML.matchAll(/<option\s+value="([^"]*)"/g)].map((m) => m[1]);

/** 只取 #dest-preset 那个 <select> 里的 option value。 */
function preset_values_of(html, select_id) {
  const start = html.indexOf(`id="${select_id}"`);
  if (start < 0) return [];
  const end = html.indexOf('</select>', start);
  const block = html.slice(start, end < 0 ? html.length : end);
  return [...block.matchAll(/<option\s+value="([^"]*)"/g)].map((m) => m[1]);
}
const DEST_PRESETS = preset_values_of(HTML, 'dest-preset');

// ---------------------------------------------------------------------------
// 2) 极简 DOM 打桩
// ---------------------------------------------------------------------------
class FakeClassList {
  constructor(el) { this.el = el; this._s = new Set(); }
  add(c) { this._s.add(c); }
  remove(c) { this._s.delete(c); }
  contains(c) { return this._s.has(c); }
  toggle(c, on) {
    const want = on === undefined ? !this._s.has(c) : !!on;
    if (want) this._s.add(c); else this._s.delete(c);
    return want;
  }
}

class FakeElement {
  constructor(tag, id, attrs) {
    this.tagName = tag.toUpperCase();
    this.id = id || '';
    this.attrs = attrs || '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.dataset = {};
    this.classList = new FakeClassList(this);
    this.style = {};
    this.children = [];
    this._listeners = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    // 把 HTML 里的初始属性搬过来（checked / value / hidden / data-state 等）
    const a = this.attrs;
    if (/\bchecked\b/.test(a)) this.checked = true;
    const vm = /\bvalue="([^"]*)"/.exec(a);
    if (vm) this.value = vm[1];
    if (/\bhidden\b/.test(a)) this.hidden = true;
    const ds = /\bdata-state="([^"]*)"/.exec(a);
    if (ds) this.dataset.state = ds[1];
  }
  addEventListener(ev, cb) {
    (this._listeners[ev] = this._listeners[ev] || []).push(cb);
  }
  /** 触发事件（模拟用户操作）。 */
  fire(ev) {
    const list = this._listeners[ev] || [];
    for (const cb of list) cb({ target: this, type: ev });
    return list.length;
  }
  hasListener(ev) { return (this._listeners[ev] || []).length > 0; }
}

const BY_ID = new Map();
for (const e of ELEMENTS) {
  // 同名 id 只保留第一个（重复 id 会在下面单独报错）
  if (!BY_ID.has(e.id)) BY_ID.set(e.id, new FakeElement(e.tag, e.id, e.attrs));
}

const BODY = new FakeElement('body', '', '');
const DOC = {
  readyState: 'complete',
  body: BODY,
  visibilityState: 'visible',
  _listeners: {},
  getElementById: (id) => BY_ID.get(id) || null,
  addEventListener(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); },
  fire(ev) { for (const cb of (this._listeners[ev] || [])) cb({ type: ev }); },
};
globalThis.document = DOC;

// 伪造 geolocation（watchPosition 立刻回一个 fix；错误回调也留着，
// 用来验证"权限被拒/不可用"在界面上到底长什么样 —— 室内等不到定位是最常见的反馈）
let geo_success = null;
let geo_error = null;
const FAKE_GEOLOCATION = {
  watchPosition(ok, err, opts) {
    geo_success = ok;
    geo_error = err;
    return 1;
  },
  clearWatch() {},
};

// 伪造 GATT：必须**完整**实现 ble.js 真正会调的那几个方法
// （getPrimaryService -> getCharacteristic -> startNotifications /
//   addEventListener / writeValueWithoutResponse），
// 否则测到的是"假接口不全"，而不是 app.js 的真实行为。
// 上一版就是漏了 getPrimaryService，于是连接停在 connecting 状态。
const fake_characteristic = () => ({
  async writeValueWithoutResponse(bytes) { /* 收下就行 */ },
  async writeValue(bytes) { /* 收下就行 */ },
  async startNotifications() { return this; },
  addEventListener() {},
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    geolocation: FAKE_GEOLOCATION,
    bluetooth: {
      async requestDevice() {
        return {
          name: 'NavPuck-TEST',
          gatt: {
            connected: false,
            async connect() { this.connected = true; return this; },
            disconnect() { this.connected = false; },
            async getPrimaryService() {
              return { async getCharacteristic() { return fake_characteristic(); } };
            },
          },
          addEventListener() {},
        };
      },
    },
  },
});
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, v); },
  removeItem(k) { this._m.delete(k); },
};

// 伪造 fetch：这一套自测**不允许**真的联网。公共 Overpass / OSRM 会限流，
// 联网还会让结果变得又慢又不确定（不同机器、不同网络下断言会飘）。
// 默认实现直接失败 —— 正好就是"底图服务挂了"这条路，也正是这一版要修的场景；
// 具体用例可以换掉 fetch_impl 来数"到底发了几个请求"。
let fetch_impl = async () => { throw new TypeError('测试环境：不允许联网'); };
globalThis.fetch = (...args) => fetch_impl(...args);

// ---------------------------------------------------------------------------
// 3) 加载模块（顺序与 index.html 一致）
// ---------------------------------------------------------------------------
const P = require(path.join(PHONE_DIR, 'proto.js'));
const NM = require(path.join(PHONE_DIR, 'navmath.js'));
const RT = require(path.join(PHONE_DIR, 'route.js'));
const MAP = require(path.join(PHONE_DIR, 'map.js'));
const BLE = require(path.join(PHONE_DIR, 'ble.js'));
globalThis.NavPuckMath = NM;
globalThis.NavPuckProto = P;
globalThis.NavPuckRoute = RT;
globalThis.NavPuckMap = MAP;
globalThis.NavPuckBle = BLE;

// ---------------------------------------------------------------------------
// 测试框架
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let group = '';
function section(n) { group = n; console.log(`\n[${n}]`); }
function ok(c, l) {
  if (c) { passed += 1; console.log(`  ✓ ${l}`); }
  else { failures.push(`${group} :: ${l}`); console.log(`  ✗ ${l}`); }
}
function eq(a, b, l) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x === y) { passed += 1; console.log(`  ✓ ${l}`); }
  else { failures.push(`${group} :: ${l}\n      期望 ${y}\n      实得 ${x}`); console.log(`  ✗ ${l}\n      期望 ${y}\n      实得 ${x}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
section('1] index.html 自身的完整性');
// ---------------------------------------------------------------------------
{
  eq(SCRIPT_SRCS, ['navmath.js', 'proto.js', 'route.js', 'map.js', 'ble.js', 'app.js'],
     'script 加载顺序与依赖顺序一致（navmath -> proto -> route -> map -> ble -> app）');

  // 重复 id 会让 getElementById 静默取到第一个，是"界面上有个元素永远不更新"的经典原因
  const seen = new Map();
  const dups = [];
  for (const e of ELEMENTS) {
    if (seen.has(e.id)) dups.push(e.id);
    seen.set(e.id, true);
  }
  eq(dups, [], 'index.html 里没有重复 id');

  // label for 必须指向存在的 id，否则点标签不会聚焦到输入框
  const bad_for = LABEL_FORS.filter((f) => !HTML_IDS.has(f));
  eq(bad_for, [], `${LABEL_FORS.length} 个 <label for> 全部指向存在的 id`);

  // 预设必须都是合法的 "lat,lon"（第一项空值表示"自定义坐标"）。
  // ⚠️ 只取 #dest-preset 里的 option：页面里还有 #opt-osrm-profile 那个
  //    <select>，它的 value 是 driving/cycling/foot —— 全都不是坐标。
  //    一开始这里扫了整个 html 的 <option>，于是把这三个当成非法坐标报错。
  const presets = DEST_PRESETS.filter((v) => v !== '');
  let bad_preset = [];
  for (const v of presets) {
    const parts = v.split(',');
    if (parts.length !== 2) { bad_preset.push(v); continue; }
    const la = parseFloat(parts[0]); const lo = parseFloat(parts[1]);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
      bad_preset.push(v);
    }
  }
  eq(bad_preset, [], `#dest-preset 里的 ${presets.length} 个预设坐标全部合法`);
  ok(presets.length >= 5, `预设数量 ${presets.length} >= 5（够用）`);
  ok(DEST_PRESETS.includes(''), '预设里有一个空 value（= 自定义坐标）');
  ok(HTML_IDS.has('opt-mounted'), 'index.html 里有 opt-mounted（app.js 会读它）');

  // 目的地必须能直接输坐标（完全离线于 GPS 的测试路径：起点手动、终点手输）
  for (const id of ['dest-lat', 'dest-lon']) {
    const e = ELEMENTS.find((x) => x.id === id);
    const attrs = e ? e.attrs : '';
    ok(!!e && e.tag === 'input' && /type="number"/.test(attrs) && /step="any"/.test(attrs),
       `#${id} 是可输十进制度的 <input type="number" step="any">`);
  }

  // 手动位置：必须是能输小数的 number 输入框，否则"十进制度"根本打不进去
  for (const id of ['man-lat', 'man-lon', 'man-heading', 'man-speed']) {
    const e = ELEMENTS.find((x) => x.id === id);
    const attrs = e ? e.attrs : '';
    ok(!!e && e.tag === 'input' && /type="number"/.test(attrs) && /step="any"/.test(attrs) &&
       /inputmode="decimal"/.test(attrs),
       `#${id} 是 <input type="number" step="any" inputmode="decimal">`);
  }
  ok(HTML_IDS.has('manual-badge'), 'index.html 里有 manual-badge（手动位置横幅）');
  ok(HTML_IDS.has('gps-error') && HTML_IDS.has('gps-fixes') &&
     HTML_IDS.has('gps-accuracy') && HTML_IDS.has('gps-hint'),
     'index.html 里有定位错误/次数/精度/下一步提示四个读数');
}

// ---------------------------------------------------------------------------
section('2] app.js 引用的每个 id 都真实存在');
// ---------------------------------------------------------------------------
const APP_SRC = fs.readFileSync(path.join(PHONE_DIR, 'app.js'), 'utf8');
{
  const refs = new Set();
  for (const m of APP_SRC.matchAll(/\$\('([^']+)'\)/g)) refs.add(m[1]);
  const missing = [...refs].filter((id) => !HTML_IDS.has(id)).sort();
  eq(missing, [],
     `app.js 用 $() 取了 ${refs.size} 个 id，全部在 index.html 里存在`);

  // 事件绑定用的 id 也必须存在（漏了会让按钮静默失效 —— 最难查的一种）
  const on_refs = new Set();
  for (const m of APP_SRC.matchAll(/on\('([^']+)',\s*'([^']+)'/g)) on_refs.add(m[1]);
  const missing_on = [...on_refs].filter((id) => !HTML_IDS.has(id)).sort();
  eq(missing_on, [], `app.js 给 ${on_refs.size} 个元素绑了事件，全部存在`);

  // 反向：html 里有哪些 id 是 app.js 完全没用到的（可能是多余的/写错的）
  const unused = [...HTML_IDS].filter((id) => {
    return !APP_SRC.includes(`'${id}'`) && !APP_SRC.includes(`"${id}"`);
  }).sort();
  // 这些是有意留着的（结构/样式钩子），列出来是为了可见性，不算失败
  console.log(`      （html 里未被 app.js 引用的 id：${unused.length ? unused.join(', ') : '无'}）`);
  ok(true, '反向引用检查完成（上面这行是信息，不是断言）');
}

// ---------------------------------------------------------------------------
section('3] App.init() 能跑完，并绑上事件');
// ---------------------------------------------------------------------------
const APP = require(path.join(PHONE_DIR, 'app.js'));
{
  let threw = null;
  try {
    APP.app.init();
  } catch (e) {
    threw = e;
  }
  ok(threw === null, `App.init() 不抛异常${threw ? `（实得 ${threw}）` : ''}`);

  // 关键按钮必须真的绑上了 click
  for (const id of ['connect-btn', 'disconnect-btn', 'use-gps-btn', 'route-btn',
                    'stop-btn', 'opt-log', 'dest-preset', 'opt-mounted']) {
    const el = BY_ID.get(id);
    const ev = (id === 'opt-log' || id === 'opt-mounted' || id === 'dest-preset') ? 'change' : 'click';
    ok(el && el.hasListener(ev), `#${id} 绑上了 ${ev} 监听器`);
  }

  // "高级 / 手动定位"整组也必须绑上：室内没有 GPS 时，这条路是唯一的测试入口，
  // 少绑一个（比如 man-apply）就是"按钮点了没反应"那个老毛病
  for (const id of ['opt-manual', 'man-lat', 'man-lon', 'man-heading', 'man-speed', 'man-apply']) {
    const el = BY_ID.get(id);
    const ev = (id === 'man-apply') ? 'click' : 'change';
    ok(el && el.hasListener(ev), `#${id} 绑上了 ${ev} 监听器`);
  }

  // init 之后的初始状态
  eq(BY_ID.get('link-state').dataset.state, 'idle', '初始链路状态 = idle');
  ok(BY_ID.get('connect-btn').disabled === false, '初始时"连接设备"可点');
  eq(BY_ID.get('battery').textContent, '—', '初始电池显示占位符');

  // 定位读数：没有 fix 时次数 0、精度 —，并且**已经**给出"下一步做什么"
  eq(BY_ID.get('gps-fixes').textContent, '0', '初始定位次数 = 0');
  eq(BY_ID.get('gps-accuracy').textContent, '—', '初始精度 = —（还没有 fix）');
  ok(BY_ID.get('gps-error').textContent.length > 0,
     `初始定位详情有文字：${BY_ID.get('gps-error').textContent}`);
  ok(BY_ID.get('gps-hint').textContent.length > 0 && BY_ID.get('gps-hint').hidden === false,
     `初始就显示"该怎么办"：${BY_ID.get('gps-hint').textContent.slice(0, 46)}…`);

  // 手动位置默认关闭，横幅不显示
  ok(BY_ID.get('manual-badge').hidden === true, '初始不显示"手动位置"横幅');
  ok(BY_ID.get('opt-manual').checked === false, '初始"使用手动位置"未勾选');
  ok(BY_ID.get('man-lat').value === '' && BY_ID.get('man-lon').value === '',
     '手动位置的坐标框**不预填**（免得被误当成真实定位）');
  eq(BY_ID.get('man-heading').value, '0', '手动航向默认 0（正北）');

  // 目的地输入框被填了演示坐标（第一次打开就能试）
  ok(BY_ID.get('dest-lat').value !== '' && BY_ID.get('dest-lon').value !== '',
     `初始目的地已填充（${BY_ID.get('dest-lat').value}, ${BY_ID.get('dest-lon').value}）`);
}

// ---------------------------------------------------------------------------
section('4] 走一遍用户操作：连接 -> 定位 -> 规划 -> 停止');
// ---------------------------------------------------------------------------
{
  // --- 点"连接设备" ---
  BY_ID.get('connect-btn').fire('click');
  await sleep(50);
  eq(BY_ID.get('link-state').dataset.state, 'up', '点"连接设备"后链路状态 = up');
  eq(BY_ID.get('device-name').textContent, 'NavPuck-TEST', '设备名显示出来');
  ok(BY_ID.get('connect-btn').disabled === true, '连上后"连接设备"置灰');
  ok(BY_ID.get('disconnect-btn').disabled === false, '连上后"断开"可点');

  // --- 模拟定位回调，再点"用当前位置作起点" ---
  ok(typeof geo_success === 'function', 'init() 里启动了 watchPosition');
  geo_success({
    coords: { latitude: 30.2545, longitude: 120.1350, accuracy: 5, speed: 8.3, heading: 90 },
    timestamp: Date.now(),
  });
  eq(BY_ID.get('gps-state').dataset.state, 'ok', '定位回调后 gps-state = ok');
  eq(BY_ID.get('gps-state').textContent, '已定位', '定位状态文字 = 已定位');
  eq(BY_ID.get('gps-fixes').textContent, '1', '定位次数被记下来：1');
  eq(BY_ID.get('gps-accuracy').textContent, '±5 m', '精度显示为 ±5 m');
  eq(BY_ID.get('gps-error').textContent, '定位正常', '定位正常时详情写"定位正常"');
  ok(BY_ID.get('gps-hint').hidden === true, '定位正常时不占地方显示"该怎么办"');

  BY_ID.get('use-gps-btn').fire('click');
  ok(/30\.25/.test(BY_ID.get('start-info').textContent),
     `点"用当前位置作起点"后显示起点：${BY_ID.get('start-info').textContent}`);
  ok(/起点已设为当前位置/.test(BY_ID.get('toast').textContent),
     '弹出"起点已设为当前位置"提示');

  // --- 点"规划并开始导航"：OSRM 会失败（Node 里 fetch 到不了外网/被沙箱拦），
  //     正好验证**回退到直线航点**这条分支 ---
  BY_ID.get('route-btn').fire('click');
  await sleep(1200);                          // OSRM 会超时/失败后回退
  const log_text = BY_ID.get('log').textContent;
  ok(log_text.length > 0, `日志有内容（${log_text.split('\n').length} 行）`);
  ok(/\[osrm\]|\[route\]/.test(log_text), 'OSRM 与路线阶段都记了日志');
  ok(/\[nav\] 10Hz 循环已启动|无法开始导航/.test(log_text),
     '要么起了循环，要么明确报错（不会静默失败）');
  ok(BY_ID.get('route-info').textContent !== '',
     `route-info 被写入：${BY_ID.get('route-info').textContent.slice(0, 60)}`);

  // --- 状态面板：等一两帧 NAV_UPDATE 之后必须被填上 ---
  await sleep(400);
  const speed = BY_ID.get('speed').textContent;
  const remaining = BY_ID.get('remaining').textContent;
  ok(speed !== '' && speed !== '—', `速度栏被写入：${speed}`);
  ok(remaining !== '' && remaining !== '—', `剩余栏被写入：${remaining}`);
  eq(BY_ID.get('view-range').textContent, '160 m', '视距栏 = 160 m（固定视野）');
  const frames = BY_ID.get('frames').textContent;
  ok(/^\d+/.test(frames), `已发帧栏被写入：${frames}`);

  // --- 选项：勾上"显示日志"应给 body 加 show-log ---
  BY_ID.get('opt-log').checked = true;
  BY_ID.get('opt-log').fire('change');
  ok(DOC.body.classList.contains('show-log'), '勾选"显示日志"后 body 带 show-log');
  BY_ID.get('opt-log').checked = false;
  BY_ID.get('opt-log').fire('change');
  ok(!DOC.body.classList.contains('show-log'), '取消勾选后 show-log 被移除');

  // --- 预设切换应同步到坐标框 ---
  //
  // ⚠️ app.js 是直接把**数字**赋给 input.value 的（`la.value = d[0]`）。
  //    真 DOM 里 input.value 是 DOMString，赋值会自动 toString()；
  //    这里的桩保留了数字。所以比较时要 String() 一下 —— 否则测的是
  //    "我的桩没实现 DOM 的字符串强制转换"，而不是 app.js 的行为。
  const sel = BY_ID.get('dest-preset');
  sel.value = '39.9097,116.3974';
  sel.fire('change');
  eq([String(BY_ID.get('dest-lat').value), String(BY_ID.get('dest-lon').value)],
     ['39.9097', '116.3974'],
     '选预设后坐标框同步为北京天安门');

  // --- 点"停止" ---
  BY_ID.get('stop-btn').fire('click');
  ok(/已停止导航/.test(BY_ID.get('toast').textContent), '点"停止"后弹出提示');

  // --- 点"断开" ---
  BY_ID.get('disconnect-btn').fire('click');
  await sleep(50);
  eq(BY_ID.get('link-state').dataset.state, 'idle', '点"断开"后链路状态 = idle');
}

// ---------------------------------------------------------------------------
section('5] GPS 错误分类必须显示在面板上，并给出"该怎么办"');
// ---------------------------------------------------------------------------
{
  ok(typeof geo_error === 'function', 'watchPosition 注册了错误回调');

  // code 1 = 权限被拒
  geo_error({ code: 1, message: 'User denied Geolocation' });
  eq(BY_ID.get('gps-state').dataset.state, 'denied', 'code 1 -> 状态 denied');
  eq(BY_ID.get('gps-state').textContent, '权限被拒', 'code 1 -> 文字"权限被拒"');
  ok(/定位权限被拒绝/.test(BY_ID.get('gps-error').textContent),
     `详情显示最后一次错误：${BY_ID.get('gps-error').textContent}`);
  ok(/锁图标|允许/.test(BY_ID.get('gps-hint').textContent) && BY_ID.get('gps-hint').hidden === false,
     '被拒时提示怎么恢复权限（不是只报状态）');
  ok(/手动定位/.test(BY_ID.get('gps-hint').textContent),
     '被拒时提示可以先用"高级 / 手动定位"测试');

  // code 2 = 定位不可用（室内最典型）
  geo_error({ code: 2, message: 'kGEOErrorPositionUnavailable' });
  eq(BY_ID.get('gps-state').dataset.state, 'unavailable', 'code 2 -> 状态 unavailable');
  ok(/没信号|不可用/.test(BY_ID.get('gps-error').textContent),
     `详情显示"不可用"：${BY_ID.get('gps-error').textContent}`);
  ok(/窗边|室外/.test(BY_ID.get('gps-hint').textContent),
     `提示去窗边/室外：${BY_ID.get('gps-hint').textContent.slice(0, 40)}…`);

  // code 3 = 超时：还能继续等，所以状态留在 waiting
  geo_error({ code: 3 });
  eq(BY_ID.get('gps-state').dataset.state, 'waiting', 'code 3 -> 状态 waiting（还能再等）');
  eq(BY_ID.get('gps-error').textContent, '最近一次错误：定位超时', '超时也留在详情里');

  // 日志一行都不能少（用户就是靠它读的）
  const log_text = BY_ID.get('log').textContent;
  ok(/定位权限被拒绝/.test(log_text) && /定位超时/.test(log_text),
     '错误文本仍然写进日志（原有日志行没有被删）');

  // 再成功一次，状态必须能回到 ok，错误文本清掉
  geo_success({
    coords: { latitude: 30.2546, longitude: 120.1351, accuracy: 8, speed: 0, heading: null },
    timestamp: Date.now(),
  });
  eq(BY_ID.get('gps-state').dataset.state, 'ok', '重新定位成功后回到 ok');
  eq(BY_ID.get('gps-fixes').textContent, '2', '定位次数累加到 2');
  eq(BY_ID.get('gps-error').textContent, '定位正常', '错误文本被清掉');
}

// ---------------------------------------------------------------------------
section('6] 非法目的地输入必须被拒绝');
// ---------------------------------------------------------------------------
{
  const sel = BY_ID.get('dest-preset');
  sel.value = '';                              // 切到"自定义坐标"
  BY_ID.get('dest-lat').value = '999';         // 纬度越界
  BY_ID.get('dest-lon').value = '120.1';
  const app = APP.app;
  eq(app.read_destination(), null, '纬度 999 被拒绝');

  BY_ID.get('dest-lat').value = 'abc';
  eq(app.read_destination(), null, '非数字纬度被拒绝');

  BY_ID.get('dest-lat').value = '30.25';
  BY_ID.get('dest-lon').value = '200';
  eq(app.read_destination(), null, '经度 200 被拒绝');

  BY_ID.get('dest-lon').value = '120.13';
  eq(app.read_destination(), [30.25, 120.13], '合法坐标被接受');

  // 预设优先于坐标框
  sel.value = '22.5431,114.0579';
  eq(app.read_destination(), [22.5431, 114.0579], '选了预设时预设优先');
  sel.value = '';
}

// ---------------------------------------------------------------------------
section('7] 手动位置（模拟定位）：室内没有 GPS 也能跑通整条链路');
// ---------------------------------------------------------------------------
{
  const app = APP.app;
  const SIM = APP.SimSource;
  ok(typeof SIM === 'function', 'app.js 导出了 SimSource');
  ok(SIM !== APP.GeoSource, 'SimSource 是独立的类（没有把手动输入塞进真实 geolocation 对象）');

  // --- 1) 位置源本身：字段与方法必须与 GeoSource 同形 ---
  const s = new SIM({});
  eq(s.has_fix(), false, 'SimSource 初始没有 fix');
  eq(s.fix(0), null, '没有坐标时 fix() 返回 null（Navigator 会安全跳过这一帧）');
  eq(s.set(30.2545, 120.135, 90, 0), null, 'set() 返回 null = 成功');
  eq(s.has_fix(), true, 'set() 之后 has_fix() = true');
  eq(s.fix(0), [30.2545, 120.135, 90, 0],
     'fix() 与 GeoSource 同形状：[lat, lon, heading, speed_mps]');
  eq(s.heading_source, 'manual', "heading_source = 'manual'（不会被当噪声丢掉）");
  eq(s.fix_count, 1, 'fix_count 正常计数');
  ok(s.set(999, 0, 0, 0) !== null, '纬度越界时 set() 返回错误文本');
  ok(s.set(30.2, 120.1, 725, 3) === null && s.fix(0)[2] === 5,
     '航向 725° 被归一化到 5°（wrap360）');

  // --- 2) 勾选"使用手动位置" -> 整个 App 切到 SimSource ---
  BY_ID.get('man-lat').value = '30.2545';
  BY_ID.get('man-lon').value = '120.1350';
  BY_ID.get('man-heading').value = '90';
  BY_ID.get('man-speed').value = '4';
  BY_ID.get('opt-manual').checked = true;
  BY_ID.get('opt-manual').fire('change');

  ok(app.manual === true, '勾选后 app.manual = true');
  eq(app.active_source(), app.sim, 'active_source() 换成 SimSource');
  eq(BY_ID.get('manual-badge').hidden, false, '"手动位置"横幅显示出来（模拟运行一眼可辨）');
  eq(BY_ID.get('gps-state').dataset.state, 'manual', '定位状态 = manual');
  eq(BY_ID.get('gps-state').textContent, '手动定位', '定位状态文字 = 手动定位');
  ok(/不是真实 GPS/.test(BY_ID.get('gps-error').textContent),
     `详情写明是模拟：${BY_ID.get('gps-error').textContent}`);
  ok(/30\.254500/.test(BY_ID.get('start-info').textContent) &&
     /手动位置/.test(BY_ID.get('start-info').textContent),
     `起点被设为手输坐标：${BY_ID.get('start-info').textContent}`);
  ok(/\[sim\]/.test(BY_ID.get('log').textContent), '日志里有 [sim] 行');

  // --- 3) 完全不需要 GPS：直接规划并开始导航 ---
  BY_ID.get('route-btn').fire('click');
  await sleep(1200);                            // OSRM 失败后回退直线航点
  ok(app.nav !== null, '手动位置下"规划并开始导航"起得来（一个 GPS fix 都不需要）');
  if (app.nav) {
    eq(app.nav.source, app.sim, 'Navigator 拿到的就是 SimSource');
    await sleep(300);
    const u = app.nav.last_update;
    ok(u !== null && Math.abs(u.heading_deg - 90) < 1,
       `手输航向 90° 真的进了 NAV_UPDATE：${u ? u.heading_deg : 'null'}`);

    // --- 3b) 改航向框立即生效（设备没有磁力计，地图旋转只能这样验证）---
    BY_ID.get('man-heading').value = '180';
    BY_ID.get('man-heading').fire('change');
    eq(app.sim.fix(0)[2], 180, '改航向输入框后马上生效，不用再按"应用"');
    await sleep(250);
    ok(Math.abs(app.nav.last_update.heading_deg - 180) < 1,
       `NAV_UPDATE 里的航向跟着变成 ${app.nav.last_update.heading_deg}°`);
  }

  // --- 4) 导航中切回 GPS：位置源立刻换掉，不用重启循环 ---
  BY_ID.get('opt-manual').checked = false;
  BY_ID.get('opt-manual').fire('change');
  ok(app.manual === false, '取消勾选后 app.manual = false');
  eq(BY_ID.get('manual-badge').hidden, true, '横幅收起（GPS 运行不会被误标成模拟）');
  eq(app.active_source(), app.geo, 'active_source() 回到 GeoSource');
  if (app.nav) eq(app.nav.source, app.geo, '正在跑的 Navigator 也换回了 GeoSource');
  eq(BY_ID.get('gps-state').dataset.state, 'ok',
     '切回后按真实 GPS 重画状态（前面已经拿到过 fix）');
  app.stop_nav();

  // --- 5) 非法坐标必须被拒绝，而且界面不能停在"写着手动其实没生效" ---
  BY_ID.get('man-lat').value = '999';
  BY_ID.get('man-lon').value = '120.1';
  BY_ID.get('opt-manual').checked = true;
  BY_ID.get('opt-manual').fire('change');
  ok(app.manual === false, '纬度 999 被拒绝：没有切到手动位置');
  eq(BY_ID.get('opt-manual').checked, false, '复选框被自动取消（界面与真实状态一致）');
  eq(BY_ID.get('manual-badge').hidden, true, '横幅不显示');
  ok(/请填合法/.test(BY_ID.get('toast').textContent),
     `弹出坐标非法提示：${BY_ID.get('toast').textContent}`);

  // --- 6) 没勾复选框，直接按"应用"也要能启用（少一步操作）---
  BY_ID.get('man-lat').value = '30.2545';
  BY_ID.get('man-lon').value = '120.1350';
  BY_ID.get('man-apply').fire('click');
  ok(app.manual === true, '按"应用"（复选框没勾）也会启用');
  eq(BY_ID.get('opt-manual').checked, true, '"应用"后复选框同步为勾上');

  // 手动位置同时也是"起点"：这条路不需要先拿到 GPS
  app.start_lat = null;
  app.start_lon = null;
  BY_ID.get('use-gps-btn').fire('click');
  ok(app.start_lat === 30.2545 && app.start_lon === 120.135,
     '"用当前位置作起点"取的是手输坐标');
  ok(/手动位置/.test(BY_ID.get('toast').textContent),
     `提示说明用的是手动位置：${BY_ID.get('toast').textContent}`);

  // 收尾：切回 GPS，别把状态留给后面的用例
  app.set_manual_active(false);
}

// ---------------------------------------------------------------------------
section('8] 街道路网底图：状态说得清楚、关掉就真的不发请求');
// ---------------------------------------------------------------------------
{
  const app = APP.app;

  // --- 1) 复选框与刻意保留的读数 ---
  const cb = BY_ID.get('opt-map');
  const attrs = (ELEMENTS.find((e) => e.id === 'opt-map') || {}).attrs || '';
  ok(cb && cb.tagName === 'INPUT' && /type="checkbox"/.test(attrs),
     '#opt-map 是 <input type="checkbox">');
  ok(/显示街道路网底图/.test(HTML), '选项文案是"显示街道路网底图"');
  ok(cb.hasListener('change'), '#opt-map 绑上了 change 监听器');
  ok(HTML_IDS.has('map-info'), 'index.html 里有 map-info（底图状态那一格）');
  ok(HTML_IDS.has('map-detail'), 'index.html 里有 map-detail（底图详情那一行）');

  // 从这里开始数 Overpass 请求：地址里带 interpreter 的才算（OSRM 不算）
  let overpass_calls = 0;
  fetch_impl = async (url) => {
    if (/interpreter/.test(String(url))) overpass_calls += 1;
    throw new TypeError('测试环境：不允许联网');
  };

  // --- 2) 关掉底图，然后开始导航：一个 Overpass 请求都不许发 ---
  cb.checked = false;
  cb.fire('change');
  eq(app.map_enabled, false, '取消勾选后 app.map_enabled = false');
  eq(globalThis.localStorage.getItem('navpuck.opt.map.v1'), '0',
     '选择被持久化（下次打开还是关的）');
  const off = app.map_status();
  eq(off.state, 'disabled', '底图状态 = disabled');
  eq(off.short, '已关闭', '短状态 = 已关闭');
  ok(/不影响导航/.test(off.detail), `关闭时详情说明不影响导航：${off.detail}`);

  app.start_lat = 30.2545;
  app.start_lon = 120.1350;
  await app.do_route();
  await sleep(400);                            // 跑几帧 10Hz 循环
  ok(app.nav !== null, '导航起得来（底图关着也一样）');
  eq(app.nav.map_src, null, '关掉底图时 Navigator 上**没有**底图源（不是只把复选框画成没勾）');
  eq(overpass_calls, 0, '关掉底图后一个 Overpass 请求都没有发');
  eq(BY_ID.get('map-info').textContent, '已关闭', '状态面板上底图那一格 = 已关闭');
  eq(BY_ID.get('map-info').dataset.state, 'disabled', '那一格带 data-state=disabled（配色用）');
  ok(/Overpass/.test(BY_ID.get('map-detail').textContent),
     `详情写明了"不再向 Overpass 发请求"：${BY_ID.get('map-detail').textContent.slice(0, 40)}…`);
  ok(BY_ID.get('map-detail').hidden === false, '详情那一行是可见的（不能只写进默认收起的日志）');

  // --- 3) 导航中打开：底图源立刻挂回去，失败要说得明明白白 ---
  cb.checked = true;
  cb.fire('change');
  eq(app.map_enabled, true, '勾上后 app.map_enabled = true');
  eq(globalThis.localStorage.getItem('navpuck.opt.map.v1'), '1', '选择又被存成"打开"');
  eq(app.nav.map_src, app.map_source, '打开后底图源立刻挂回正在跑的 Navigator');

  await sleep(500);                            // 让 10Hz 循环真的去试一次（失败）
  eq(overpass_calls >= 1, true, `打开后真的去试了 Overpass（${overpass_calls} 次请求）`);
  const st = app.map_status();
  eq(st.state, 'unavailable', 'Overpass 连不上时状态 = unavailable');
  const info = BY_ID.get('map-info').textContent;
  const detail = BY_ID.get('map-detail').textContent;
  ok(/不可用/.test(info), `底图那一格写"不可用"：${info}`);
  ok(!/等待路网/.test(info), '不再出现含糊的"等待路网"');
  ok(/底图服务（Overpass）暂时无响应，不影响导航，路线和箭头照常工作/.test(detail),
     `详情里就是那句"不影响导航"：${detail.slice(0, 60)}…`);
  ok(/overpass-api\.de/.test(detail) && /maps\.mail\.ru/.test(detail),
     '详情里逐个列出了失败的镜像');
  ok(/不影响导航/.test(detail) && BY_ID.get('map-detail').classList.contains('warn'),
     '失败时详情条高亮成警告样式');
  ok(st.reasons.length >= 1, `状态里带着逐镜像的原因：${st.reasons.join('；')}`);

  // 导航本身：底图挂了也一帧不少
  const frames_before = app.nav.frames_sent;
  await sleep(300);
  ok(app.nav.frames_sent > frames_before,
     `底图不可用时 NAV_UPDATE 照发（${frames_before} -> ${app.nav.frames_sent} 帧）`);
  ok(/^\d+/.test(BY_ID.get('frames').textContent), '面板上的"已发帧"还在涨');

  // --- 4) 再关掉：底图源要**摘下来**（不然界面说关了、其实还在打 Overpass）---
  cb.checked = false;
  cb.fire('change');
  eq(app.nav.map_src, null, '再关掉时底图源从 Navigator 上摘下来了');
  const calls_snapshot = overpass_calls;
  await sleep(300);
  eq(overpass_calls, calls_snapshot, '关掉之后不再发任何 Overpass 请求');
  eq(BY_ID.get('map-info').textContent, '已关闭', '面板回到"已关闭"');
  app.stop_nav();

  // --- 5) 选择会被记住：新开一个 App（等价于重新打开页面）照上次的选择来 ---
  const A2 = new APP.App();
  A2.init();
  eq(A2.map_enabled, false, '重新打开页面后仍然是"关掉底图"（选择被记住了）');
  eq(BY_ID.get('opt-map').checked, false, '复选框也恢复成没勾');
  // 收尾：切回"打开"，别把状态留给后面的用例
  app.set_map_enabled(true, true);
  eq(globalThis.localStorage.getItem('navpuck.opt.map.v1'), '1', '收尾：选择恢复成"打开"');
}

// ---------------------------------------------------------------------------
section('9] "不支持 Web Bluetooth" 的提示路径');
// ---------------------------------------------------------------------------
// ⚠️ 这一节必须放在最后：它会再新建一个 App 实例，而 DOM 桩是共享的 ——
//    新实例 init() 会把**它自己的**监听器绑到同一批元素上，之后任何一次
//    点击/输入都会同时走到两个实例的处理函数（它没有 fix，会把状态面板改回
//    waiting）。第 8 节已经建过第二个实例了，所以这里更得排在最后 ——
//    与其掩盖这个"多实例 + 共享 DOM"的真实坑，不如把用例都排在它前面。
{
  // document 里没有 'bluetooth' in navigator 时，init() 应该显出 #unsupported
  const saved = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { geolocation: FAKE_GEOLOCATION },     // 没有 bluetooth
  });
  const unsupported = BY_ID.get('unsupported');
  unsupported.hidden = true;
  // 新建一个 App 走一遍 init（用同一个 DOM 桩）
  const A2 = new APP.App();
  A2.init();
  eq(unsupported.hidden, false, '没有 navigator.bluetooth 时显示 #unsupported 提示');
  ok(/navigator\.bluetooth/.test(BY_ID.get('log').textContent),
     '日志里写明了缺少 navigator.bluetooth');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true, value: saved,
  });
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(62));
if (failures.length === 0) {
  console.log(`  手机端界面接线自测通过：${passed} 项全部通过`);
  console.log('='.repeat(62));
  process.exit(0);
} else {
  console.log(`  ${passed} 项通过 / ${failures.length} 项失败`);
  console.log('='.repeat(62));
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
