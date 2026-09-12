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
//
// `ui_writes` 把**手机写出去的全部字节**记下来：第 10 节要在这里面找
// NAV_CLOCK 那一帧（不记下来就只能测"send_clock 被调过"，而"调过"不等于
// "发出去的字节是对的"）。
const ui_writes = [];
const fake_characteristic = () => ({
  async writeValueWithoutResponse(bytes) { ui_writes.push(Uint8Array.from(bytes)); },
  async writeValue(bytes) { ui_writes.push(Uint8Array.from(bytes)); },
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
  // ⚠️ 这条断言是"index.html 的 <script> 列表与依赖顺序一致"。加 Android/Capacitor
  //    那套东西时**必须**同步更新：ble_native.js（原生 BLE 传输，ble.js 会去查
  //    NavPuckBleNative）、fgs.js（前台服务封装）、fgs_ui.js（后台运行面板）都是
  //    新增的独立模块，顺序上必须在 ble.js / app.js 之前。
  //    —— 改这里不是因为代码错了，而是因为这条契约本身就是"当前文件清单"。
  //    底图改成离线优先后新增了 tiles.js（瓦片格式解码 + IndexedDB 缓存 +
  //    沿路预取）。map.js 在构造 OsmMapSource 时就要用 root.NavPuckTiles，
  //    所以它必须排在 route.js **之后**、map.js **之前**。
  eq(SCRIPT_SRCS,
     ['crashlog.js', 'navmath.js', 'proto.js', 'route.js', 'tiles.js', 'map.js',
      'ble_native.js', 'ble.js', 'fgs.js', 'fgs_ui.js', 'app.js'],
     'script 加载顺序与依赖顺序一致（crashlog -> navmath -> proto -> route -> tiles -> map -> ble_native -> ble -> fgs -> fgs_ui -> app）');

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

  // ⚠️ fgs_ui.js 是另一块界面接线（后台运行 + 探针 + 原生节拍器），它**不在**
  //    app.js 里取 id，所以上面那条断言覆盖不到它。以前这里没查它，代价是
  //    "按钮 id 打错一个字 -> 点了没反应、编译不报错、测试也不报错"。
  //    原生节拍器那三个按钮尤其要紧：它们是这次设备实验的唯一入口。
  {
    const FGS_UI_SRC = fs.readFileSync(path.join(PHONE_DIR, 'fgs_ui.js'), 'utf8');
    const fgs_refs = new Set();
    for (const m of FGS_UI_SRC.matchAll(/\$\('([^']+)'\)/g)) fgs_refs.add(m[1]);
    for (const m of FGS_UI_SRC.matchAll(/on\('([^']+)',\s*'([^']+)'/g)) fgs_refs.add(m[1]);
    const fgs_missing = [...fgs_refs].filter((id) => !HTML_IDS.has(id)).sort();
    eq(fgs_missing, [],
       `fgs_ui.js 引用/绑定的 ${fgs_refs.size} 个 id 全部在 index.html 里存在`);

    // 原生节拍器的读数面板必须真的在页面里（否则 bind 不到、读数无处可显示）
    for (const id of ['fgs-metro-btn', 'fgs-metro-stop', 'fgs-cmp-btn', 'fgs-metro-out']) {
      ok(HTML_IDS.has(id), `index.html 里有 #${id}（原生节拍器的按钮/读数）`);
    }
    // 这三个按钮的绑定必须真的写出来了（漏一个 = 用户在手机上按不动）
    for (const [id, ev] of [['fgs-metro-btn', 'click'], ['fgs-metro-stop', 'click'],
                            ['fgs-cmp-btn', 'click']]) {
      ok(new RegExp(`on\\('${id}',\\s*'${ev}'`).test(FGS_UI_SRC),
         `fgs_ui.js 给 #${id} 绑了 ${ev}`);
    }
    // 读数里那几根针的名字必须和 docs/android.md 的判读表逐字对应 ——
    // 对不上的话，用户照着文档找不到界面上的那一行。
    for (const k of ['metroTimerFires', 'ticksDelivered', 'ticksSkipped',
                     'ticksCallbackRejected', 'jsExecCount', 'framesSent',
                     'workerTicks', 'workerMainTicks', 'hbCount', 'ticks']) {
      ok(FGS_UI_SRC.includes(k), `fgs_ui.js 的读数里带着 ${k}`);
    }
  }
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
section('8] 模拟行驶（沿航线自动推进）：室内没有 GPS 也能看到车真的在动');
// ---------------------------------------------------------------------------
// 这一节对着 tools/navigator.py 的 SimSource（PC 版是参考实现）：
// 勾选 -> 位置沿**规划出来的航线**按 km/h 前进 -> 航向取航线切线（所以过弯会转）
// -> 到终点停住。手动位置横幅之外再加一条"模拟行驶"横幅，是因为这个模式车
// 是真的在动，比静态坐标更容易被误读成真实定位。
{
  const app = APP.app;
  ok(typeof APP.RouteSimSource === 'function', 'app.js 导出了 RouteSimSource');
  ok(APP.RouteSimSource !== APP.SimSource, 'RouteSimSource 与静态 SimSource 是两个类');

  // --- 1) 界面元素：开关 + 速度(km/h) + 起点偏移 + 实时读数 + 横幅 ---
  const cb = BY_ID.get('opt-simdrive');
  const cb_attrs = (ELEMENTS.find((e) => e.id === 'opt-simdrive') || {}).attrs || '';
  ok(cb && cb.tagName === 'INPUT' && /type="checkbox"/.test(cb_attrs),
     '#opt-simdrive 是 <input type="checkbox">（模拟行驶开关）');
  const sp = BY_ID.get('sim-speed');
  const sp_attrs = (ELEMENTS.find((e) => e.id === 'sim-speed') || {}).attrs || '';
  ok(sp && sp.tagName === 'INPUT' && /type="number"/.test(sp_attrs) &&
     /step="any"/.test(sp_attrs) && /inputmode="decimal"/.test(sp_attrs),
     '#sim-speed 是 <input type="number" step="any" inputmode="decimal">（速度，km/h）');
  eq(String(sp.value), '42', '速度默认 42 km/h（与 PC 版 --speed 的默认值一致）');
  const st = BY_ID.get('sim-start');
  const st_attrs = (ELEMENTS.find((e) => e.id === 'sim-start') || {}).attrs || '';
  ok(st && st.tagName === 'INPUT' && /type="number"/.test(st_attrs) &&
     /step="any"/.test(st_attrs),
     '#sim-start 是 <input type="number" step="any">（起点偏移，对应 PC 版 --start）');
  eq(String(st.value), '0', '起点偏移默认 0（= 从航线起点开始）');
  ok(BY_ID.get('sim-apply').hasListener('click'), '#sim-apply 绑上了 click');
  ok(cb.hasListener('change') && sp.hasListener('change') && st.hasListener('change'),
     '开关/速度/起点偏移都绑上了 change');
  ok(HTML_IDS.has('sim-info'), 'index.html 里有 sim-info（模拟行驶的实时读数）');
  ok(HTML_IDS.has('sim-badge'), 'index.html 里有 sim-badge（模拟行驶横幅）');
  ok(/模拟行驶/.test(HTML), 'index.html 的文案里写明"模拟行驶"');
  ok(BY_ID.get('sim-badge').hidden === true, '初始不显示"模拟行驶"横幅');
  ok(BY_ID.get('sim-info').hidden === true, '初始不显示模拟读数');
  ok(cb.checked === false && app.simdrive === false,
     '初始不模拟行驶（这是测试模式，刻意不持久化、不自动恢复）');

  // --- 2) 勾选：不需要任何 GPS，起点自动取内置演示航线起点 ---
  app.start_lat = null;
  app.start_lon = null;
  // 先造出"**完全没有 GPS fix**"的状态（室内就是这样的），再开模拟行驶 ——
  // 整条链路必须一个定位都不需要。
  app.geo.lat = null;
  app.geo.lon = null;
  eq(app.geo.has_fix(), false, '先把 GPS 源清成"没有任何 fix"（模拟室内）');
  sp.value = '36';                              // 10 m/s，好算
  st.value = '0';
  cb.checked = true;
  cb.fire('change');

  ok(app.simdrive === true, '勾选后 app.simdrive = true');
  eq(app.geo.has_fix(), false, '此时 GPS 仍然没有任何 fix（不靠它）');
  eq(BY_ID.get('sim-badge').hidden, false, '"模拟行驶"横幅显示出来（模拟运行一眼可辨）');
  eq(BY_ID.get('sim-badge').dataset.state, 'running', '横幅 data-state = running');
  eq(BY_ID.get('gps-state').dataset.state, 'simdrive', '定位状态 = simdrive');
  eq(BY_ID.get('gps-state').textContent, '模拟行驶', '定位状态文字 = 模拟行驶');
  ok(/不是真实 GPS/.test(BY_ID.get('gps-error').textContent),
     `详情写明不是真实 GPS：${BY_ID.get('gps-error').textContent}`);
  eq([app.start_lat, app.start_lon], [RT.DEMO_ROUTE[0][0], RT.DEMO_ROUTE[0][1]],
     '没有起点时自动取内置演示航线的起点（室内不必手输坐标）');
  ok(/模拟起点/.test(BY_ID.get('start-info').textContent),
     `界面上写明是模拟起点：${BY_ID.get('start-info').textContent}`);
  ok(/\[sim\]/.test(BY_ID.get('log').textContent), '日志里有 [sim] 行');

  // --- 3) 规划并开始导航：位置源换成 RouteSimSource，而且**真的在推进** ---
  BY_ID.get('route-btn').fire('click');
  await sleep(1200);                            // OSRM 失败后回退直线航点
  ok(app.nav !== null, '模拟行驶下"规划并开始导航"起得来（一个 GPS fix 都不需要）');
  if (app.nav) {
    eq(app.nav.source, app.routesim, 'Navigator 拿到的就是 RouteSimSource');
    eq(app.active_source(), app.routesim, 'active_source() = 模拟行驶源');
    ok(app.routesim.has_route(), '模拟源已经拿到本次航线');
    ok(app.routesim.route.maneuvers.length >= 5,
       `无网（测试环境 fetch 必失败）时模拟行驶退回**内置演示航线**：` +
       `${(app.routesim.route.total_m / 1000).toFixed(2)} km / ` +
       `${app.routesim.route.maneuvers.length} 个转向点 —— 过弯一定测得到（直线就没有转弯了）`);

    const s1 = app.routesim.s;
    await sleep(300);                           // 10Hz 跑几帧：36km/h = 10m/s
    const s2 = app.routesim.s;
    const walked = s2 - s1;
    ok(s2 > s1, `位置沿航线在推进：${s1.toFixed(2)} -> ${s2.toFixed(2)} m`);
    ok(walked > 1.2 && walked < 6.0,
       `0.3 秒走了 ${walked.toFixed(2)} m（36km/h=10m/s，用的是真实流逝时间，不是固定步长）`);
    ok(Math.abs(app.nav.last_update.speed_kmh - 36) < 0.2,
       `速度栏 = 配置的 36 km/h（实得 ${app.nav.last_update.speed_kmh}）`);
    eq(BY_ID.get('speed').textContent, '36.0', '状态面板"速度"格被写进去');
    ok(/^\d+%$/.test(BY_ID.get('progress').textContent),
       `进度格被写进去：${BY_ID.get('progress').textContent}`);
    ok(BY_ID.get('sim-info').hidden === false &&
       /模拟行驶：沿航线/.test(BY_ID.get('sim-info').textContent) &&
       /km\/h/.test(BY_ID.get('sim-info').textContent) &&
       /航向 /.test(BY_ID.get('sim-info').textContent),
       `实时读数写出里程/速度/航向：${BY_ID.get('sim-info').textContent}`);

    // --- 3b) 两个模拟模式同时开着：生效的必须是"模拟行驶"，界面不许撒谎 ---
    app.set_manual_active(true);
    eq(app.active_source(), app.routesim, '两个都开着时 active_source() 仍然是模拟行驶源');
    eq(BY_ID.get('manual-badge').hidden, true,
       '模拟行驶真的在链路里时，"手动位置"横幅不亮（手动源不在链路里，亮着就是假的）');
    eq(BY_ID.get('sim-badge').hidden, false, '"模拟行驶"横幅仍然亮着');
    eq(BY_ID.get('gps-state').dataset.state, 'simdrive',
       '状态面板跟着真正生效的那个源走');
    app.set_manual_active(false);
    eq(BY_ID.get('sim-badge').hidden, false, '关掉手动位置不影响模拟行驶');
    eq(app.active_source(), app.routesim, '位置源还是模拟行驶');
  }

  // --- 4) 接上闭环演示航线（7 个转向点）：航向必须跟着路转弯 ---
  app.stop_nav();
  const demo = new RT.Route(RT.DEMO_ROUTE.map((p) => [p[0], p[1], p[2]]), true);
  const M1_IDX = demo.maneuvers[0][0];
  const M1_DELTA = demo.maneuvers[0][1];
  const M1_S = demo.points[M1_IDX].cum_m;
  app.routesim.set_speed_kmh(36.0);             // 10 m/s
  app.routesim.set_route(demo);
  app.routesim.restart((M1_S - 40.0) / demo.total_m);   // 放到第一个转弯前 40m
  app.routesim.active = true;
  app.nav = new APP.Navigator(demo, app.routesim, {
    send: () => true,
    onLog: (l) => app.log(l),
    onUi: (d) => app.on_ui(d),
    config: { rate_hz: 10, no_map: true },
  });
  let unwrapped = 0;
  let prev_h = app.routesim.heading;
  let s_prev = app.routesim.s;
  let ok_frames = true;
  for (let i = 0; i < 100; i++) {
    const u = app.nav.cycle(0.1);
    if (u === null) { ok_frames = false; break; }
    if (!(app.routesim.s >= s_prev)) ok_frames = false;
    if (Math.abs(NM.shortest_delta(u.heading_deg, demo.tangent_deg(app.routesim.s))) > 0.02) {
      ok_frames = false;
    }
    if (!Number.isFinite(u.heading_deg) || !Number.isFinite(u.pos_east_m) ||
        !Number.isFinite(u.pos_north_m)) ok_frames = false;
    unwrapped += NM.shortest_delta(prev_h, u.heading_deg);
    prev_h = u.heading_deg;
    s_prev = app.routesim.s;
  }
  ok(ok_frames, '100 帧：位置单调前进、航向每帧都等于航线切线、帧里没有 NaN');
  ok(unwrapped > M1_DELTA * 0.8,
     `过弯时航向真的转了（累计 ${unwrapped.toFixed(1)}°，转弯点标称 +${M1_DELTA.toFixed(1)}°）`);
  ok(/航向 \d+°/.test(BY_ID.get('sim-info').textContent),
     `实时读数里带着当前航向：${BY_ID.get('sim-info').textContent}`);

  // --- 5) 到终点：停住 + 明确写"已到终点"，不绕回起点 ---
  app.routesim.restart(1.0);
  app.nav.cycle(0.1);
  eq(app.routesim.s, demo.total_m, 's 正好停在终点');
  eq(BY_ID.get('progress').textContent, '100%', '进度格 = 100%');
  eq(BY_ID.get('speed').textContent, '0.0', '速度格归零（车停了，不是还写着 36）');
  ok(/已到终点/.test(BY_ID.get('sim-info').textContent),
     `实时读数写明已到终点：${BY_ID.get('sim-info').textContent}`);
  eq(BY_ID.get('sim-badge').dataset.state, 'arrived', '横幅换成"已到终点"的样式');
  ok(/模拟行驶已到终点/.test(BY_ID.get('toast').textContent),
     '到终点时弹一次提示');
  for (let i = 0; i < 20; i++) app.nav.cycle(0.1);
  eq(app.routesim.s, demo.total_m, '再跑 20 帧仍然停在终点（刻意不绕回起点重跑）');
  ok(/已到终点/.test(BY_ID.get('sim-info').textContent),
     '读数保持"已到终点"（不会自己变回"在跑"）');

  // --- 6) 收尾：关掉模拟行驶，界面回到真实定位 ---
  app.stop_nav();
  // 先让 GPS 重新拿到一个 fix（等价于"走到窗边定位上了"），再看切回来的样子
  geo_success({
    coords: { latitude: 30.2546, longitude: 120.1351, accuracy: 8, speed: 0, heading: null },
    timestamp: Date.now(),
  });
  cb.checked = false;
  cb.fire('change');
  eq(app.simdrive, false, '取消勾选后 app.simdrive = false');
  eq(BY_ID.get('sim-badge').hidden, true, '"模拟行驶"横幅收起');
  eq(BY_ID.get('sim-info').hidden, true, '模拟读数收起');
  eq(BY_ID.get('gps-state').dataset.state, 'ok',
     '切回真实定位（横幅收起后不会再被误当成模拟）');
  ok(app.active_source() !== app.routesim, '位置源不再是模拟行驶');
}

// ---------------------------------------------------------------------------
section('9] 街道路网底图：状态说得清楚、关掉就真的不发请求');
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
section('9b] 屏幕常亮（Wake Lock）与后台限流：状态说得清楚，绝不拖累导航');
// ---------------------------------------------------------------------------
//
// 这一节钉两件事，都是现场反馈"切到后台就特别卡"的直接回答：
//
//   1. **屏幕常亮**（Screen Wake Lock）。摩托车上那块屏本来就该常亮，而
//      "锁屏 / 页面切后台"正是浏览器把定时器压到 ~1Hz 的直接原因。生命周期
//      三条：导航开始申请、停止导航释放、**页面回到前台必须重新申请**
//      （浏览器在页面隐藏时一定会把锁收走；不重新要，用户切出去看一眼消息
//      回来屏幕就再也不常亮了，而界面上完全看不出来）。
//      三条都不许因为 API 缺失或申请被拒而中断导航。
//   2. **把症状说出来**：循环周期超过阈值时，状态面板直接写
//      "页面在后台，帧率已降"，并往日志写一行 —— 用户就不会以为导航坏了。
//
// ⚠️ 这一节必须排在第 10 节（NAV_CLOCK，它会点"连接设备"）之前：DOM 桩是
//    共享的，多挂一个 App 实例的监听器是我们在这里**刻意**避免的事。
{
  const app = APP.app;

  ok(typeof APP.ScreenWakeLock === 'function', 'app.js 导出了 ScreenWakeLock（可单测）');
  ok(HTML_IDS.has('loop-info') && HTML_IDS.has('wake-info') && HTML_IDS.has('loop-detail'),
     'index.html 里有 loop-info / wake-info / loop-detail（循环与屏幕常亮的状态）');

  // ---- 1) 浏览器**没有** Wake Lock API：说清楚、导航照常 ----
  //     （前面的第 4/7/8/9 节就是在"没有这个 API"的 navigator 上跑完整条
  //      导航链路的，所以这条路已经被真实走过了。）
  const wake = app.wake();
  eq(wake.supported, false, '这个测试 navigator 上没有 wakeLock（正好是 Safari/旧版 Chrome）');
  eq(wake.requests, 0, '没有 API 时**一次都不去调** request()（先探测能力，再动手）');
  ok(app.log_lines.some((l) => /不支持屏幕常亮/.test(l)),
     '日志里写明了"这个浏览器不支持屏幕常亮"（而不是悄悄什么都不做）');

  // ---- 2) 装上假的 Wake Lock：导航开始申请、停止释放 ----
  const wake_requests = [];
  const sentinels = [];
  const fake_wake_lock = {
    async request(type) {
      wake_requests.push(type);
      const s = {
        released: false,
        _cbs: [],
        addEventListener(ev, cb) { if (ev === 'release') this._cbs.push(cb); },
        async release() { this.released = true; for (const cb of this._cbs.slice()) cb(); },
        // 模拟"浏览器自己把锁收走"（页面隐藏时一定会发生）
        fire_release() { for (const cb of this._cbs.slice()) cb(); },
      };
      sentinels.push(s);
      return s;
    },
  };
  globalThis.navigator.wakeLock = fake_wake_lock;      // 同一个 navigator 对象，现读现用
  eq(app.wake().supported, true, '装上 API 后立刻就"支持"了（能力是懒判断的，不缓存）');

  app.start_lat = 30.2545;
  app.start_lon = 120.1350;
  await app.do_route();
  await sleep(200);
  ok(app.nav !== null, '导航起得来（和屏幕常亮完全解耦）');
  eq(wake_requests.length, 1, '导航开始时申请了一次屏幕常亮');
  eq(wake_requests[0], 'screen', '申请的类型是 screen（守规范，别传别的东西）');
  eq(app.wake().state().state, 'held', '状态 = held（真的拿着）');
  eq(BY_ID.get('wake-info').textContent, '已保持',
     `状态面板"屏幕常亮"那一格 = 已保持（实得 ${BY_ID.get('wake-info').textContent}）`);
  eq(BY_ID.get('wake-info').dataset.state, 'ok', '那一格带 data-state=ok（配色用）');
  ok(app.log_lines.some((l) => /已申请到屏幕常亮/.test(l)), '日志记了一次"已申请到屏幕常亮"');

  // ---- 3) 停止导航：立刻释放（空闲时不该占着屏幕常亮）----
  app.stop_nav();
  await sleep(0);
  eq(sentinels.length >= 1 && sentinels[0].released, true, '停止导航时那把锁**真的释放了**');
  eq(app.wake().state().state, 'idle', '状态回到 idle');
  eq(app.wake().state().want, false, '并且记着"现在不该持有"（空闲时不会偷偷再要一把）');
  eq(BY_ID.get('wake-info').textContent, '空闲', '状态面板回到"空闲"');
  eq(wake_requests.length, 1, '空闲期间**不再**申请（不导航就不持有屏幕常亮）');

  // ---- 4) 页面隐藏 -> 浏览器收走锁；回到前台 -> **必须重新申请** ----
  await app.do_route();
  await sleep(150);
  eq(wake_requests.length, 2, '第二次导航又申请了一次（每次导航一把新锁）');
  const held_before_hide = app.wake().state().state;

  DOC.visibilityState = 'hidden';
  DOC.fire('visibilitychange');
  eq(app.nav && app.nav.hidden, true, 'Navigator 被告知"页面在后台"（限流文案靠它）');
  eq(app.wake().state().state, 'released',
     '页面隐藏时本地认为锁已经没了（浏览器一定会收走，不能自己骗自己）');

  DOC.visibilityState = 'visible';
  DOC.fire('visibilitychange');
  await sleep(0);
  eq(wake_requests.length, 3, '**回到前台重新申请了一把**（这一步最容易漏：漏了屏幕从此不再常亮）');
  eq(app.wake().state().state, 'held', '回到前台后状态又回到 held');
  ok(held_before_hide === 'held', '（隐藏之前确实是 held —— 对比才有意义）');

  // ---- 5) 申请被拒（低电量 / 页面不可见）：日志说清楚，导航照常 ----
  app.wake().on_hidden();                              // 先把手上那把清掉
  const orig_request = fake_wake_lock.request;
  fake_wake_lock.request = async () => { throw new Error('NotAllowedError: 电量太低'); };
  const ok_request = await app.wake().request();
  eq(ok_request, false, '申请被拒时 request() 返回 false（不抛异常）');
  eq(app.wake().state().state, 'failed', '状态 = failed（界面写"失败"）');
  ok(/电量太低/.test(app.wake().state().reason), `原因原样留着：${app.wake().state().reason}`);
  ok(app.log_lines.some((l) => /屏幕常亮申请被拒/.test(l)),
     '日志里写明了"申请被拒、导航照常"（不是静默吞掉）');
  const frames_before_reject = app.nav.frames_sent;
  await sleep(200);
  ok(app.nav.frames_sent > frames_before_reject,
     `锁没拿到也照样发 NAV_UPDATE（${frames_before_reject} -> ${app.nav.frames_sent} 帧）`);
  fake_wake_lock.request = orig_request;

  // ---- 6) 后台限流：状态面板直接写"页面在后台，帧率已降" + 日志一行 ----
  //
  // 真实浏览器里这件事没法在 Node 里复现（没有浏览器、没有真的后台节流），
  // 所以这里**直接把实测周期喂进去** —— note_loop_gap() 就是 _tick() 里那个
  // 唯一的判据，喂它 1000ms 与"浏览器把后台标签页压到 1Hz"完全等价。
  app.nav.stop();                                      // 停掉真实定时器，让喂进去的值稳定
  const nav = app.nav;
  nav.set_hidden(true);
  const slow = nav.note_loop_gap(1000);
  eq(slow, true, '周期 1000ms 被判为"掉出 10Hz"（阈值 400ms = 10Hz 的 4 倍）');
  ok(/帧率已降/.test(app.log_lines.join('\n')), '日志里有 [loop] 帧率已降 那一行');

  nav.cycle(0.1);                                      // 走一帧真实的 on_ui
  eq(BY_ID.get('loop-info').textContent, '页面在后台，帧率已降',
     `状态面板"循环"那一格就是这句话（实得 ${BY_ID.get('loop-info').textContent}）`);
  eq(BY_ID.get('loop-info').dataset.state, 'bad', '那一格带 data-state=bad（红）');
  const loop_detail = BY_ID.get('loop-detail').textContent;
  ok(BY_ID.get('loop-detail').hidden === false, '详情那一行是**可见的**（日志默认收起，不能只写日志）');
  ok(/1000 ms/.test(loop_detail) && /切回前台/.test(loop_detail),
     `详情说清了实测周期和怎么恢复：${loop_detail.slice(0, 70)}…`);
  ok(/不支持屏幕常亮|申请被拒|屏幕常亮/.test(BY_ID.get('wake-info').textContent + loop_detail),
     `同一行里也带着屏幕常亮的状态：${BY_ID.get('wake-info').textContent}`);

  // ---- 7) 回到前台：确认循环恢复 10Hz、帧计数继续涨 ----
  const frames_before_recover = nav.frames_sent;
  nav.set_hidden(false);
  eq(nav.note_loop_gap(100), false, '周期回到 100ms（10Hz）后不再是"掉帧"');
  ok(/已恢复/.test(app.log_lines.join('\n')),
     '日志里确认了恢复（"已恢复 10Hz"）—— 用户能看出是自己切走了还是真坏了');
  nav.cycle(0.1);
  ok(!/页面在后台/.test(BY_ID.get('loop-info').textContent),
     `恢复后那一格不再是"页面在后台，帧率已降"（实得 ${BY_ID.get('loop-info').textContent}）`);
  ok(/Hz/.test(BY_ID.get('loop-info').textContent), '恢复后显示实测帧率');
  ok(nav.frames_sent > frames_before_recover,
     `帧计数在恢复前后一直在涨（${frames_before_recover} -> ${nav.frames_sent}）`);

  // ---- 8) 收尾：恢复"没有任何 wakeLock"的初始状态，别留给后面的用例 ----
  app.stop_nav();
  delete globalThis.navigator.wakeLock;
  DOC.visibilityState = 'visible';
  eq(app.wake().state().state, 'idle', '收尾：停止导航后锁是放开的');
}

// ---------------------------------------------------------------------------
section('10] NAV_CLOCK：点"连接设备"后真的把手机时间发出去了');
// ---------------------------------------------------------------------------
//
// ⚠️ 这一节必须排在**最后一个用共享 DOM 桩的用例之后**（也就是紧挨着
//    "不支持 Web Bluetooth"那一节之前）：它会点一次"连接设备"，共享 DOM 桩上
//    会挂上第二个 App 实例的点击监听器。这个坑和上面第 9 节说的是同一件事。
//
// 为什么必须在这里（而不是只测 proto.js）：proto.js 的自测只能证明
// "给了两个字段能编出对字节"。真正会出错的恰恰是**接线**：
//   - 忘了在连上时发（设备上就一直 --:--）；
//   - 时区符号写反（`getTimezoneOffset()` 是"UTC 减本地"，协议要的是反过来）；
//   - 把毫秒当秒发出去（设备显示 1970 年之后的某个离谱年份）。
// 这三条都只在"点连接 -> 字节真的写出去"这一整条路上才看得见。
{
  const P = require(path.join(PHONE_DIR, 'proto.js'));

  // 清空写入记录，然后走一遍真实的"连接设备"路径。
  ui_writes.length = 0;
  const t_before = Math.floor(Date.now() / 1000);
  BY_ID.get('connect-btn').fire('click');
  await sleep(60);
  const t_after = Math.floor(Date.now() / 1000);

  // 在写出去的字节流里找 type == 0x06 的帧（帧头：A5 5A ver type len_lo len_hi）
  const clockFrames = ui_writes.filter(
    (b) => b.length >= 8 && b[0] === P.MAGIC0 && b[1] === P.MAGIC1 &&
           b[3] === P.MsgType.NAV_CLOCK);
  ok(clockFrames.length >= 1,
     `点"连接设备"后写出去的字节里有 NAV_CLOCK 帧（共 ${ui_writes.length} 次写、` +
     `${clockFrames.length} 帧时钟）`);
  ok(ui_writes.length > 0, '连接后确实有字节写出去（不是只改了界面）');

  if (clockFrames.length >= 1) {
    const f = clockFrames[0];
    eq(f[4] | (f[5] << 8), P.NAV_CLOCK_LEN,
       `NAV_CLOCK 帧的 len 字段 = ${P.NAV_CLOCK_LEN}`);
    const payload = f.slice(P.HEADER_LEN, P.HEADER_LEN + P.NAV_CLOCK_LEN);
    const ck = P.NavClock.unpack(payload);
    ok(ck.epoch_s >= t_before - 2 && ck.epoch_s <= t_after + 2,
       `epoch 是**秒**而且就是当前时间（${ck.epoch_s}，本机 ${t_before}..${t_after}）` +
       '——写成毫秒会落到这个区间之外');
    eq(ck.tz_offset_min, -new Date().getTimezoneOffset(),
       `时区 = -getTimezoneOffset()（本机 ${-new Date().getTimezoneOffset()} 分钟）` +
       '——符号写反会让设备上的钟差一整个时区');
  }

  // ---- tick_clock()：到点才补发，不到点一个字节都不写 ----
  // 直接调这个方法（挂在 1 秒看门狗上，见 app.js 的说明），
  // 这样"30 秒补一次"这件事是**确定性的**，不依赖真实定时器。
  const A = APP.app;
  ok(typeof A.tick_clock === 'function', 'app.js 有 tick_clock()（补发时钟的入口）');

  ui_writes.length = 0;
  A._clock_next_ms = Date.now() + 60_000;        // 把"下次该发"推到一分钟之后
  A.tick_clock();
  eq(ui_writes.filter((b) => b[3] === P.MsgType.NAV_CLOCK).length, 0,
     '没到 30 秒时 tick_clock() 一个字节都不写');

  A._clock_next_ms = Date.now() - 1;             // 到点了
  A.tick_clock();
  eq(ui_writes.filter((b) => b[3] === P.MsgType.NAV_CLOCK).length, 1,
     '到点后 tick_clock() 补发 1 帧 NAV_CLOCK');
  ok(A._clock_next_ms > Date.now(),
     '发完把"下次该发"推到未来（否则每个 tick 都会重复发）');

  // 断开链路之后 **不能再发**：一个还在往断开链路上写时钟的页面，
  // 会一直以为自己在"维持设备时间"，而设备那边什么都没收到。
  BY_ID.get('disconnect-btn').fire('click');
  await sleep(30);
  ui_writes.length = 0;
  A._clock_next_ms = 0;                          // 即使标记成"立刻该发"
  A.tick_clock();
  eq(ui_writes.length, 0, '链路断开后 tick_clock() 不再写任何字节');
}

// ---------------------------------------------------------------------------
section('11] 原生节拍器：入口、计数、切换（"要不要把循环搬进原生"那把尺子）');
// ---------------------------------------------------------------------------
//
// 这一节钉住的是**这次设备实验能不能得出结论**所依赖的那几件事。
// 设备上的现象我在这里测不了（那是真机实验），但下面这些是纯逻辑，
// 任何一条错了，手机上那次实验就是白跑：
//   1. window.__navpuckNativeTick 真的被 do_route 装上（没装 = 读数是 0 =
//      看起来跟"JS 被冻住"一模一样，会把结论做反）；
//   2. 入口调的是**同一个**循环体（帧数真的涨），不是另写一份影子逻辑；
//   3. exec_count 只在**入口真的执行**时涨（唯一能证明"JS 跑了"的量）；
//   4. set_metronome(true) 会把 setInterval 停掉（双驱动会让读数翻倍）。
{
  const RT = require(path.join(PHONE_DIR, 'route.js'));
  const FGS = require(path.join(PHONE_DIR, 'fgs.js'));

  // 自带的一条小航线（与集成自测同一个套路：不依赖网络、不依赖 GPS）
  const route = new RT.Route(RT.DEMO_ROUTE.map((p) => [p[0], p[1], p[2]]), true);

  const A = new APP.App();
  A.init();
  const sim = new APP.RouteSimSource({});
  sim.set_route(route);
  sim.active = true;
  const nav = new APP.Navigator(route, sim, {
    send: () => true, onLog: () => {}, onUi: () => {},
    config: { no_map: true },
  });
  A.nav = nav;
  nav.start();

  // ---- 1) 入口装上 / 摘掉 ----
  eq(typeof globalThis.__navpuckNativeTick, 'undefined',
     'init() 之后入口还没装（它由 do_route 装，不是全局常驻）');
  A._install_native_tick();
  eq(typeof globalThis.__navpuckNativeTick, 'function',
     'do_route 的那一步装上 window.__navpuckNativeTick');
  ok(globalThis.__navpuckNativeState &&
     typeof globalThis.__navpuckNativeState.executions === 'number',
     '同时挂上只读状态快照 __navpuckNativeState（原生每帧读回 executions/frames）');

  // ---- 2) 幂等：连调 5 次 = 走 5 帧 ----
  const f0 = nav.frames_sent;
  const e0 = nav.exec_count;
  for (let i = 0; i < 5; i++) globalThis.__navpuckNativeTick();
  eq(nav.exec_count - e0, 5, '入口被调 5 次就执行 5 次（真正的 _tick，不是影子逻辑）');
  ok(nav.frames_sent - f0 >= 4,
     `5 次调用真的产出了导航帧（${f0} -> ${nav.frames_sent}）——` +
     '只数调用次数而不动导航的话，这个实验就白做了');
  eq(globalThis.__navpuckNativeState.executions, nav.exec_count,
     '__navpuckNativeState.executions 与 Navigator 自己的 exec_count 一致');

  // ---- 3) 节拍器开关：把 setInterval 让出来 / 还回去 ----
  eq(nav.metronome, false, '默认没开节拍器（浏览器/PWA 那条路一个字都不变）');
  nav.set_metronome(true);
  eq(nav.metronome, true, 'set_metronome(true) 生效');
  eq(nav.running, false, '开了节拍器就把 setInterval 停掉（双驱动会让读数翻倍）');
  const f1 = nav.frames_sent;
  globalThis.__navpuckNativeTick();
  ok(nav.frames_sent > f1, '节拍器模式下，循环体仍然每调一帧地出帧');
  nav.set_metronome(false);
  eq(nav.running, true, '关掉节拍器立刻把 setInterval 起回来（导航不能没人推）');
  eq(nav.set_metronome(false), false, '重复关闭是幂等的（返回 false = 状态没变）');

  // ---- 4) 导航停了以后入口必须安全（原生可能还没收到"停"） ----
  A.stop_nav();
  eq(A.nav, null, 'stop_nav() 把 nav 置空');
  eq(typeof globalThis.__navpuckNativeTick, 'undefined',
     'stop_nav() 顺手把入口摘掉（留着它 = 往一个不存在的循环里投帧，看起来像"JS 不执行"）');
  const before = nav.exec_count;
  eq(nav.native_tick() >= 0, true, '（脱手后直接调 Navigator.native_tick 也不抛错）');
  eq(nav.exec_count, before + 1, '（这一条只是确认计数仍然自洽）');

  // ---- 5) metronome_verdict：判读表本身 ----
  // 这个纯函数是整份实验的判据，每一行对应一种**修法**，必须逐条钉住。
  const R = (o) => Object.assign({
    metronomeSupported: true, running: true,
    metroTimerFires: 0, ticksDelivered: 0, ticksSkipped: 0,
    ticksCallbackRejected: 0, jsExecCount: 0, framesSent: 0,
    workerTicks: 0, workerMainTicks: 0, hbCount: 0, ticks: 0,
  }, o);
  const base = R({ hbCount: 10, ticks: 1000, metroTimerFires: 0, jsExecCount: 0, framesSent: 0 });

  ok(/没有节拍器/.test(FGS.ForegroundService.metronome_verdict(base,
       R({ metronomeSupported: false }))),
     '旧 APK（原生方法不存在）=> 明说"这个 APK 里没有节拍器"，不硬下结论');

  // ⚠️ 第一次采样时 prev 是 null（面板刚打开）—— 这时**不能**下结论：
  //    增量还不存在，"全都没动"和"刚建立基线"在数字上完全一样，
  //    硬下结论就会把"还没开始测"说成"JS 被冻住了"。
  ok(/刚建立基线/.test(FGS.ForegroundService.metronome_verdict(null, base)),
     '没有基线（prev=null）时不编结论，只说"先关屏 30 秒"');

  ok(/没响/.test(FGS.ForegroundService.metronome_verdict(base,
       R({ hbCount: 40, metroTimerFires: 0 }))),
     '原生定时器不涨 => 先修前台服务/省电策略（不是搬循环）');

  ok(/执行 0 次/.test(FGS.ForegroundService.metronome_verdict(base,
       R({ hbCount: 40, metroTimerFires: 300, ticksDelivered: 300,
           jsExecCount: 0, framesSent: 0 }))) &&
     /必须搬进 Kotlin/.test(FGS.ForegroundService.metronome_verdict(base,
       R({ hbCount: 40, metroTimerFires: 300, ticksDelivered: 300,
           jsExecCount: 0, framesSent: 0 }))),
     '原生响了、JS 执行 0 次 => **循环必须搬进 Kotlin**（这是要移植的那一行）');

  ok(/不需要移植/.test(FGS.ForegroundService.metronome_verdict(base,
       R({ hbCount: 40, metroTimerFires: 300, ticksDelivered: 300, ticksSkipped: 2,
           jsExecCount: 300, framesSent: 295 }))),
     '原生响了、JS 执行了、出帧了 => **原生可以当节拍器，不用移植**');

  ok(/一帧都没发出去/.test(FGS.ForegroundService.metronome_verdict(base,
       R({ hbCount: 40, metroTimerFires: 300, ticksDelivered: 300,
           jsExecCount: 300, framesSent: 0 }))),
     '循环在跑但一帧没出 => 指向发帧那一环（BLE/连接），不是架构问题');
}

// ---------------------------------------------------------------------------
section('11.5] NAV_CLOCK 走**原生**（APK）那条路：点连接后设备真的收到时间');
// ---------------------------------------------------------------------------
//
// 第 10 节盖的是 **PWA / Web Bluetooth** 那条路（link.rx 是 RX 特征）。
// 但用户实在用的是 APK，而 APK 走的是**原生适配器**那一条：ble.js 的
// _gatt_connect() 在原生分支里**故意**把 rx/tx 置空，字节由
// transport.write_frame() 写下去。
//
// 就是因为这一点不同，"连上就发时钟"在 APK 里曾经**整条死掉**：_drain() 用
// `!this.rx` 判"链路能不能写"，于是每一帧都被当成"链路不可用"整队清掉 ——
// 手机侧日志照样写"已下发设备时间"、界面照样显示"已连接"，设备却一个字节
// 都收不到，主页永远 --:--。第 10 节测的是 Web 路径，所以它一路全绿。
//
// 这一节就是把第 10 节原样搬到**原生**路径上：假装在 Capacitor 壳里，
// 点一次"连接设备"，然后证明设备的字节流里**真的**出现了 NAV_CLOCK。
// 这才是用户报的那个现象对应的那一层。
{
  const NATIVE = require(path.join(PHONE_DIR, 'ble_native.js'));
  const PN = require(path.join(PHONE_DIR, 'proto.js'));

  /**
   * 十六进制字符串 -> Uint8Array。
   *
   * 真插件底层收的就是这个（`BluetoothLe.kt:674/698` 的 `call.getString("value", null)`
   * 再交给 `Conversion.kt:28-39` 的 `stringToBytes()`：偶数长度、每两个字符一字节、
   * `Character.digit(c,16)` 解）。桩按同一个契约解 —— **桩不能比真插件宽容**，
   * 否则"传下去的东西类型不对"这类 bug 会在全绿的自测里活下来（这次就发生了）。
   *
   * 契约不符时**必须抛**，不能悄悄收下：
   *   · 不是字符串 -> 真插件报 `Value required.`（DataView 过桥变成 `{}`，getString 返回 null）；
   *   · 长度奇数 / 有非十六进制字符 -> 真插件在 `stringToBytes()` 里抛。
   */
  function hex_to_u8(value) {
    if (typeof value !== 'string') {
      const got = (value && typeof value === 'object')
        ? (value.constructor && value.constructor.name) || 'object'
        : typeof value;
      throw new Error(`Value required.（写载荷必须是十六进制字符串，实得 ${got}）`);
    }
    if (value.length % 2 !== 0) {
      throw new Error(`Input string must have an even length, not ${value.length}`);
    }
    const out = new Uint8Array(value.length / 2);
    for (let i = 0; i < out.length; i++) {
      const pair = value.substring(i * 2, i * 2 + 2);
      const hi = parseInt(pair[0], 16);
      const lo = parseInt(pair[1], 16);
      if (Number.isNaN(hi) || Number.isNaN(lo)) {
        throw new Error(`Invalid Hexadecimal Character: ${pair}`);
      }
      out[i] = (hi << 4) + lo;
    }
    return out;
  }

  // 假插件：只实现 ble_native.js 真正会调的那几个方法。
  // `device_writes` = 设备侧**真实收到**的字节（分片按顺序拼起来）。
  const device_writes = [];
  const plugin = {
    connected: false,
    async initialize() {},
    async checkPermissions() { return { scan: 'granted', connect: 'granted', location: 'granted' }; },
    async requestPermissions() { return { scan: 'granted', connect: 'granted', location: 'granted' }; },
    async requestDevice() { return { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'NavPuck-NATIVE' }; },
    async addListener() { return { remove: async () => {} }; },
    async connect() { this.connected = true; },
    async requestMtu() {},
    async getMtu() { return { value: 247 }; },
    async discoverServices() {},
    async startNotifications() {},
    async writeWithoutResponse(args) {
      // ⚠️ 写载荷的契约是**十六进制字符串**（键名 `value:`），不是 DataView。
      //
      // 这里以前写的是 `new Uint8Array(args.value.buffer, args.value.byteOffset, …)`
      // —— 也就是假设载荷是 DataView。那个假设是**错的**：插件底层
      // （BluetoothLe.kt:674/698）是 `call.getString("value", null)`，拿不到字符串就
      // reject("Value required.")；而 DataView 过 Capacitor 的桥会被
      // `JSON.stringify` 压成 `{}`，于是真机上**每一片**都写失败（和分片大小无关，
      // 所以降档阶梯一路降到 20 字节也没用）。
      //
      // 这个桩以前"给什么收什么"，比真插件宽容，于是那一版真机 bug 在本套自测里
      // 一片全绿。现在按真插件契约解（与 phone/test/native.cjs 的
      // `_decode_write_value()` 同一套规则：每字节两位、无分隔符）。
      const u8 = hex_to_u8(args.value);
      for (const b of u8) device_writes.push(b);
    },
    async disconnect() { this.connected = false; },
  };

  // 装成"在 Capacitor 壳里"。必须在这个 App 实例 init() **之前**装 ——
  // app.js 的 init() 就是在这个时刻决定"用原生还是 Web"的。
  // ⚠️ 用完必须拆掉：第 12 节要验"没有 navigator.bluetooth 时的提示"，
  //    留着它 native_ble 就为真，那个提示永远不会出现（12 节会假失败）。
  globalThis.NavPuckBleNative = NATIVE;
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    Plugins: { BluetoothLe: plugin },
  };

  try {
    const A = new APP.App();
    A.init();
    ok(A.ble.transport !== null,
       'init() 认出原生环境，走的是原生传输（APK 的真实路径，不是 Web Bluetooth）');

    device_writes.length = 0;
    const t_before = Math.floor(Date.now() / 1000);
    await A.ble.connect();                   // 等价于点"连接设备"
    await sleep(80);                         // 等异步 drain 真的写出去
    const t_after = Math.floor(Date.now() / 1000);

    eq(A.ble.rx, null, '（前置事实）原生路径下 rx = null —— 所以判据不能看 rx');
    ok(device_writes.length > 0,
       `连接后字节**真的到了设备**（${device_writes.length} 字节；` +
       '只是入队而没写出去的话，这里就是 0 —— 那正是 APK 里时钟丢失的样子）');

    const clockFrames = [];
    for (const f of new PN.FrameParser().feed(Uint8Array.from(device_writes))) {
      if (f.type === PN.MsgType.NAV_CLOCK) clockFrames.push(f);
    }
    ok(clockFrames.length >= 1,
       `设备的字节流里有 NAV_CLOCK 帧（共 ${clockFrames.length} 帧）` +
       '——设备收到它才会把主页上的 --:-- 换成真实时间');

    if (clockFrames.length >= 1) {
      const ck = PN.NavClock.unpack(clockFrames[0].payload);
      eq(clockFrames[0].payload.length, PN.NAV_CLOCK_LEN, `载荷 ${PN.NAV_CLOCK_LEN} 字节`);
      ok(ck.epoch_s >= t_before - 2 && ck.epoch_s <= t_after + 2,
         `epoch 是秒且就是当前时间（${ck.epoch_s}，本机 ${t_before}..${t_after}）`);
      eq(ck.tz_offset_min, -new Date().getTimezoneOffset(),
         `时区 = -getTimezoneOffset()（本机 ${-new Date().getTimezoneOffset()} 分钟）`);
    }
    ok(A.log_lines.some((l) => /\[clock\]/.test(l) && /已下发/.test(l)),
       '手机侧日志如实写了"已下发"（而在修好之前它也会这么写 —— 所以日志不能当证据）');

    await A.ble.disconnect();
  } finally {
    delete globalThis.NavPuckBleNative;
    delete globalThis.Capacitor;
  }
}

// ---------------------------------------------------------------------------
section('11.7] 原生扫描失败：三类失败在界面上必须分得开（+「重试扫描」）');
// ---------------------------------------------------------------------------
//
// 用户报的现象是"APK 里点连接设备报没找到设备，同一个手机用网页能连上"。
// 根因的修法（扫描与定位解耦）在 native.cjs 第 8b 节钉；这一节钉**界面**这一半：
//
//   权限被拒 / 蓝牙没开   -> "根本没扫成"（红）+ 点明是哪一个 + 去哪开
//   扫完了但 0 条广播     -> "扫了但没有"（黄）+ 计数 + "设备可能被别处连着"
//   扫到并选中            -> 绿 + **广播条数**（"扫描真的在收包"的证据）
//
// 以前这三种都只显示一句"没找到设备"，而它们的修法完全不同 —— 用户只能反复试。
// 还有一条同样重要：**PWA 那条路一个字都不能变**（它是好的，不该被这次改动碰到）。
{
  const NATIVE = require(path.join(PHONE_DIR, 'ble_native.js'));

  // ---- (0) PWA：这两行 + 重试按钮永远不显示 ----
  const apwa = new APP.App();
  apwa.init();
  eq(apwa.ble.transport, null, '（前置）PWA 下没有原生传输对象');
  await apwa.do_connect();                 // Web 路径照旧走（假 navigator.bluetooth）
  await sleep(20);
  eq(BY_ID.get('scan-state').hidden, true, 'PWA 里 #scan-state 永远 hidden（Web 路径行为不变）');
  eq(BY_ID.get('scan-hint').hidden, true, 'PWA 里也不显示"现在该做什么"那一行');
  eq(BY_ID.get('rescan-btn').hidden, true, 'PWA 里不出现「重试扫描」（那是原生才有的入口）');

  // ---- 假原生插件：照真插件的行为写（别名权限 / LEScan / isEnabled）----
  const plugin = {
    mode: 'denied',
    scan_cb: null,
    async initialize() { if (this.mode === 'denied') throw new Error('Permission denied.'); },
    async checkPermissions() {
      const v = (this.mode === 'denied') ? 'denied' : 'granted';
      return {
        ACCESS_COARSE_LOCATION: v, ACCESS_FINE_LOCATION: v,
        BLUETOOTH: 'granted', BLUETOOTH_ADMIN: 'granted',
        BLUETOOTH_SCAN: v, BLUETOOTH_CONNECT: v,
      };
    },
    async requestPermissions() { return this.checkPermissions(); },
    async isEnabled() { return { value: this.mode !== 'adapter_off' }; },
    async getConnectedDevices() { return { devices: [] }; },
    async addListener(ev, cb) {
      if (ev === 'onScanResult') this.scan_cb = cb;
      return { remove: async () => {} };
    },
    async requestLEScan() {
      if (this.mode === 'empty') return;              // 扫描真的在跑，就是没有广播
      this.scan_cb({ device: { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'NavPuck-UI' }, rssi: -55 });
      this.scan_cb({ device: { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'NavPuck-UI' }, rssi: -50 });
    },
    async stopLEScan() {},
    async connect() {}, async requestMtu() {},
    async getMtu() { return { value: 247 }; },
    async discoverServices() {}, async startNotifications() {},
    async writeWithoutResponse() {}, async disconnect() {},
  };
  globalThis.NavPuckBleNative = NATIVE;
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: { BluetoothLe: plugin } };

  try {
    const A = new APP.App();
    A.init();
    ok(A.ble.transport !== null, '认出原生环境（这一节走的就是 APK 那条路）');
    ok(BY_ID.get('rescan-btn').hasListener('click'), '「重试扫描」绑上了 click 监听器');
    ok(A.ble.transport.scan_window_ms >= 1000,
       `生产的扫描窗口是真的（${A.ble.transport.scan_window_ms}ms，不是自测里那个 0）`);

    const st = BY_ID.get('scan-state');
    const hint = BY_ID.get('scan-hint');
    const rb = BY_ID.get('rescan-btn');

    // ---- (1) 权限被拒：红 + 点名 + 去处 ----
    await A.do_connect();
    eq(st.hidden, false, '权限被拒：诊断行露出来（不再只弹一句"没找到设备"）');
    eq(st.dataset.state, 'bad', '权限被拒 = 红（根本没扫成）');
    const t_perm = st.textContent;
    ok(/扫描没能开始/.test(t_perm) && /权限/.test(t_perm), `第一行说清"没扫成 + 权限"：${t_perm.slice(0, 40)}…`);
    ok(!/没找到设备|没有扫描到/.test(t_perm), '**不会**退化成"没找到设备"（那会把用户引到错方向）');
    eq(hint.hidden, false, '第二行给出"现在该做什么"');
    ok(/附近的设备/.test(hint.textContent) && /重试扫描/.test(hint.textContent),
       '点明去哪儿开权限、以及可以重试');
    eq(rb.hidden, false, '「重试扫描」露出来');

    // ---- (2) 蓝牙没开：红，但和权限那一类文案不同 ----
    plugin.mode = 'adapter_off';
    await A.do_connect();
    const t_bt = st.textContent;
    eq(st.dataset.state, 'bad', '蓝牙没开 = 红（同样根本没扫成）');
    ok(/蓝牙/.test(t_bt) && /关闭/.test(t_bt), `点明是蓝牙开关：${t_bt.slice(0, 40)}…`);
    ok(t_bt !== t_perm, '和"权限被拒"不是同一句话（用户看得出区别）');

    // ---- (3) 扫完了但 0 条广播：黄，并且和上面两种明显不同 ----
    plugin.mode = 'empty';
    await A.do_connect();
    const t_empty = st.textContent;
    eq(st.dataset.state, 'warn', '扫完了没有 = 黄（**不是**红：扫描确实执行了）');
    ok(/扫描已经跑完/.test(t_empty), `第一行说清"扫完了"：${t_empty.slice(0, 40)}…`);
    ok(/0 条广播/.test(t_empty), '把实测到的广播条数写出来（0 条 = 扫描真的在收包但什么都没收到）');
    eq(hint.dataset.state, 'warn', '"该怎么办"那一行跟着变成黄');
    ok(/停止广播/.test(hint.textContent) && /网页/.test(hint.textContent),
       '提示第七种可能性：设备被别的中心连着时会停止广播');
    ok(t_empty !== t_perm && t_empty !== t_bt, '和"根本没扫成"那两种都不是同一句话');
    eq(A.ble.transport.adverts_seen, 0, '传输对象上的广播计数 = 0（界面读数与它同源）');

    // ---- (4) 扫到并选中：绿 + 广播条数 ----
    plugin.mode = 'ok';
    await A.do_connect();
    eq(st.dataset.state, 'ok', '扫到并连上 = 绿');
    ok(/2 条广播/.test(st.textContent) && /1 台设备/.test(st.textContent),
       `把广播条数/设备台数写出来（这是"扫描确实在收包"的证据）：${st.textContent}`);
    ok(/NavPuck-UI/.test(st.textContent), '并且写清楚选中了哪一台');
    eq(rb.hidden, true, '连上之后「重试扫描」收起来（没有东西可重试）');

    // ---- (5) 「重试扫描」真的能再来一次 ----
    plugin.mode = 'denied';
    await A.do_connect();
    eq(st.dataset.state, 'bad', '（前置）又失败一次，诊断行回到红');
    plugin.mode = 'ok';
    rb.fire('click');                        // 用户点「重试扫描」
    await sleep(30);
    eq(st.dataset.state, 'ok', '点「重试扫描」后重新扫一遍并连上（不是个摆设按钮）');
  } finally {
    delete globalThis.NavPuckBleNative;
    delete globalThis.Capacitor;
  }
}

// ---------------------------------------------------------------------------
section('11.9] 崩溃捕获：闪退之后"上一轮走到哪一步"必须留得下、读得回、看得见');
// ---------------------------------------------------------------------------
//
// 这一节钉的是 phone/crashlog.js —— 现场反馈只有一句"连接板子后规划导航直接会
// 闪退"，而闪退 = 进程没了：页面上那块 #log 一个字都留不下。所以唯一的线索就是
// **危险操作之前同步写进 localStorage 的那几十行**。
//
// 这里能测的（不需要真机）：
//   1. 关键操作前 marker() 是**同步落盘**的（崩在下一行也已经写下去了）；
//   2. 上一轮没正常结束 => 报告里必须含崩前那几行；渲染到 #crash-block；
//   3. 上一轮正常结束 => **不报**（否则每次打开都喊"上次异常"，用户会当噪声）；
//   4. onerror / unhandledrejection 被记录（且**不吞**：不该返回值/不
//      preventDefault，错误照旧冒到控制台）；
//   5. 环形缓冲有上限（不让 localStorage 无限长）；
//   6. App.log() 真的把日志喂进来了（否则报告里只有 crashlog 自己的两行）；
//   7. PWA 里 fgs.note()/crash_report() 返回中性值，一个异常都不抛。
{
  const CL = require(path.join(PHONE_DIR, 'crashlog.js'));

  function mk_store() {
    const m = new Map();
    return {
      _m: m,
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  }
  /** 造一个"够 crashlog 用"的 window（不碰全局，避免污染其它节）。 */
  function mk_win(store) {
    const added = {};
    return {
      _added: added,
      localStorage: store,
      navigator: { userAgent: 'ui.mjs-test' },
      onerror: null,
      onunhandledrejection: null,
      addEventListener(ev, cb) { added[ev] = cb; },
      document: {
        readyState: 'complete',
        visibilityState: 'visible',
        getElementById: (id) => BY_ID.get(id) || null,
        addEventListener() {},
      },
    };
  }

  const store = mk_store();
  const w1 = mk_win(store);
  const c1 = CL.create({ window: w1, storage: store });
  c1.install();

  ok(!!store.getItem(CL.KEY), '开新会话时立刻落盘（进程随时可能死，不能等退出才写）');
  eq(c1.status().prev_abnormal, false, '第一次启动：没有上一轮 => 不报异常');
  eq(c1.report_text(), null, '第一次启动：report_text() 是 null（不编造报告）');
  eq(BY_ID.get('crash-block').hidden !== false, true, '第一块崩溃报告面板是收起的');

  // 崩前的那几笔：一行普通日志 + 两笔关键操作前的 marker
  c1.note('app', '普通日志一行');
  c1.marker('nav_start_begin', 'window_pts=1001 mtu=517 chunk=514');
  c1.marker('first_write', 'frame=1034B 片=514B hex=1028字符');
  const persisted = store.getItem(CL.KEY);
  ok(/nav_start_begin/.test(persisted), 'marker() 里的字**当场**就在 localStorage 里（同步落盘）');
  ok(/first_write/.test(persisted), '第二笔 marker 也在（不是攒着等定时器）');

  // ── 模拟"进程被杀"：不调 end_clean，直接用同一份 storage 再开一轮 ────────
  const w2 = mk_win(store);
  const c2 = CL.create({ window: w2, storage: store });
  c2.install();
  const rep = c2.report_text();
  ok(!!rep, '上一轮没有正常结束 => 生成"上次异常结束"报告');
  ok(/没有\*\*正常结束|没有正常结束/.test(rep), '报告里明说"上一轮没有正常结束"');
  ok(/first_write/.test(rep) && /window_pts=1001/.test(rep),
     '报告里带着崩前最后那几行（含第一次写入的尺寸）');
  ok(/frame=1034B/.test(rep), '报告里的行是**原样**的日志，不是转述');
  ok(!/普通日志一行/.test(rep) === false || /普通日志一行/.test(rep),
     '普通日志行也在报告里（App.log 的被喂进来了）');

  await c2.render();
  eq(BY_ID.get('crash-block').hidden, false, '报告真的被显示出来（#crash-block 取消隐藏）');
  ok(/first_write/.test(BY_ID.get('crash-report').textContent),
     '#crash-report 里就是那份报告原文（用户截图/复制用的就是它）');
  ok(/截图|复制|发/.test(BY_ID.get('crash-hint').textContent), '#crash-hint 告诉用户"把它发出来"');

  // 用户按"我已记录，清掉这块"
  c2.clear();
  eq(c2.report_text(), null, 'clear() 之后不再报同一场崩溃');
  eq(BY_ID.get('crash-block').hidden, true, 'clear() 把面板也收起来');

  // ── 环形缓冲上限：不让 localStorage 无限长 ─────────────────────────────
  const store_big = mk_store();
  const cbig = CL.create({ window: mk_win(store_big), storage: store_big });
  cbig.install();
  for (let i = 0; i < CL.MAX_LINES + 50; i++) cbig.note('app', `第 ${i} 行`);
  eq(cbig.snapshot().lines.length, CL.MAX_LINES,
     `行数被夹在 ${CL.MAX_LINES} 行（滚动缓冲，不是无限增长）`);
  ok(/第 \d+ 行/.test(cbig.snapshot().lines[CL.MAX_LINES - 1][1]),
     '保留的是**最后**那些行（崩前最近的现场）');
  // ⚠️ note() 是**节流**落盘的（最多 1 秒一次，localStorage 是同步 IO）：
  //    所以上面那一串 note 之后，盘上那份还不是最新的 —— 这正是设计。
  cbig.flush_now();
  ok(JSON.parse(store_big.getItem(CL.KEY)).lines.length === CL.MAX_LINES,
     '显式落盘之后，盘上那份也同样是夹住的');

  // ── 正常结束 => 不报异常 ───────────────────────────────────────────────
  const store_clean = mk_store();
  const cc1 = CL.create({ window: mk_win(store_clean), storage: store_clean });
  cc1.install();
  cc1.note('app', '一切正常');
  cc1.end_clean('pagehide');
  ok(JSON.parse(store_clean.getItem(CL.KEY)).ended_clean === true,
     'end_clean() 把"正常结束"写进落盘状态');
  const cc2 = CL.create({ window: mk_win(store_clean), storage: store_clean });
  cc2.install();
  eq(cc2.report_text(), null, '上一轮正常结束 => **不报**异常（避免每次都喊狼来了）');

  // ── 未捕获错误：记录，但**不吞** ───────────────────────────────────────
  const store_err = mk_store();
  const w_err = mk_win(store_err);
  const c_err = CL.create({ window: w_err, storage: store_err });
  c_err.install();
  ok(typeof w_err.onerror === 'function', 'window.onerror 被装上（不再让错误无声无息）');
  ok(typeof w_err.onunhandledrejection === 'function', 'window.onunhandledrejection 被装上');
  const ret = w_err.onerror('TypeError: x is not a function', 'app.js', 123, 4,
                            new Error('TypeError: x is not a function'));
  ok(ret === false || ret === undefined,
     'onerror 的返回值**不是 true**（记录，但不 preventDefault —— 错误该冒还冒）');
  ok(/TypeError/.test(store_err.getItem(CL.KEY)), '错误内容立刻落盘（下一次可能没机会）');
  ok(/app\.js:123:4/.test(store_err.getItem(CL.KEY)), '错误位置（文件:行:列）也在里面');
  w_err.onunhandledrejection({ reason: new Error('未处理的拒绝') });
  ok(/未处理的拒绝/.test(store_err.getItem(CL.KEY)), 'unhandledrejection 也被记下来');

  // ── 没有 localStorage 也不能炸（file:// / 隐私模式）────────────────────
  const w_nostore = {
    navigator: {}, onerror: null,
    document: { readyState: 'complete', getElementById: () => null, addEventListener() {} },
  };
  Object.defineProperty(w_nostore, 'localStorage', {
    get() { throw new Error('SecurityError: 访问被拒'); },
  });
  let threw = false;
  try {
    const c_ns = CL.create({ window: w_nostore });
    c_ns.install();
    c_ns.note('app', '一行');
    c_ns.marker('x', 'y');
  } catch (e) { threw = true; }
  eq(threw, false, '拿不到 localStorage 时退化成内存缓冲，**一个异常都不抛**');

  // ── App.log() 真的喂进来了（否则报告里只有 crashlog 自己的两行）───────
  {
    const store_app = mk_store();
    const C = CL.create({ window: mk_win(store_app), storage: store_app });
    C.install();
    const saved = globalThis.NavPuckCrash;
    globalThis.NavPuckCrash = C;
    try {
      const A = new APP.App();
      A.log('这一行必须进崩溃黑匣子');
      C.flush_now();   // 普通日志是节流落盘的（见上面那条），这里显式刷一次
      ok(/这一行必须进崩溃黑匣子/.test(store_app.getItem(CL.KEY)),
         'App.log() 的每一行都进了崩溃黑匣子（闪退时 #log 里的东西不会白丢）');
      A.crash_marker('unit_test', 'marker-from-app');
      ok(/marker-from-app/.test(store_app.getItem(CL.KEY)),
         'App.crash_marker() 同步落盘（危险操作前的最后一句话）');
    } finally {
      if (saved === undefined) delete globalThis.NavPuckCrash;
      else globalThis.NavPuckCrash = saved;
    }
  }

  // ── PWA 里 fgs 的崩溃接口必须是中性的（不抛错、不假装有原生）────────────
  {
    const FGS = require(path.join(PHONE_DIR, 'fgs.js'));
    const f = new FGS.ForegroundService({ window: { Capacitor: null } });
    eq(f.note('x', 'y'), false, 'PWA 里 fgs.note() 返回 false（没有原生可写）');
    const r = await f.crash_report();
    eq(r.available, false, 'PWA 里 fgs.crash_report() 返回 {available:false}');
    const rc = await f.clear_crash_report();
    eq(rc.available, false, 'PWA 里 fgs.clear_crash_report() 同样');
  }

  // ── index.html 里那三个 id 必须真的存在（否则报告无处可显示）──────────
  for (const id of ['crash-block', 'crash-report', 'crash-hint', 'crash-clear']) {
    ok(HTML_IDS.has(id), `index.html 里有 #${id}`);
  }
}

// ---------------------------------------------------------------------------
// 11.95] ⭐ BLE 分片面板：真机闪退修复后的那个旋钮（必须真的能拧、且记得住）
// ---------------------------------------------------------------------------
//
// 现场：Redmi / Android 16，getMtu() 报 517，旧代码按 MTU-3 发 **514** 字节，
// 进程当场死掉（BluetoothGatt.writeCharacteristic 里 value.length > 512 就抛，
// 异常同步抛在插件线程上，JS 接不住）。所以：
//   · 界面上必须**看得见**当前分片（不然用户没有任何判断依据）；
//   · 必须能**调**（上限 / 锁定 / 清空学习记录），因为"多大才安全"最后只有
//     真机能回答；
//   · 面板里必须写清楚**代价**（20 字节/片时一条路线窗口要几百次写），
//     否则用户会把"慢"当成新 bug。
{
  // ⚠️ 这一套自测（ui.mjs）跑的是 **PWA 形状**的环境：它从来不注册
  //    NavPuckBleNative（原生传输在 PWA 里就是不存在）。但分片面板在 PWA 里
  //    也要能显示/能存，所以这里按 index.html 的真实顺序把它挂上再测。
  globalThis.NavPuckBleNative = require(path.join(PHONE_DIR, 'ble_native.js'));

  // 面板与控件必须真的在 index.html 里（否则 bind 不到、读数无处显示）
  for (const id of ['chunk-block', 'chunk-info', 'chunk-detail', 'opt-chunk-auto',
                    'opt-chunk-ceiling', 'chunk-reset']) {
    ok(HTML_IDS.has(id), `index.html 里有 #${id}`);
  }
  const sel = ELEMENTS.find((e) => e.id === 'opt-chunk-ceiling') || {};
  eq(sel.tag, 'select', '#opt-chunk-ceiling 是 <select>（上限只能从阶梯里挑）');
  const opts = [...HTML.matchAll(/<select id="opt-chunk-ceiling">([\s\S]*?)<\/select>/g)][0][1];
  const vals = [...opts.matchAll(/value="(\d+)"/g)].map((m) => m[1]);
  eq(vals, ['20', '64', '128', '185', '244', '512'],
     '上限选项就是升档阶梯（含 512 = 框架硬上限、20 = 规范默认）');
  ok(/value="512" selected/.test(opts), '默认选中 512（= 可证明的硬上限，不是 514）');

  // 面板正文必须把"代价"和"为什么默认是 20"说清楚（这是 UI 的一部分，不是文档）
  ok(/512/.test(HTML) && /BluetoothGatt\.writeCharacteristic|框架/.test(HTML),
     '面板里写明 512 是框架硬常量（用户能自己对照）');
  ok(/70 片/.test(HTML) && /285 片/.test(HTML),
     '面板里写明了 20 字节/片的代价（多少片：底图 70 片、整轮 285 片）');
  ok(/无法被 JS 接住|接不住/.test(HTML), '面板里写明"分片太大会闪退、且 JS 接不住"');

  // 真的拧一下：新造一个 App（共享 DOM），走 init()，然后动控件
  const A3 = new APP.App();
  A3.init();
  ok(!!A3.chunk_policy, 'App.init() 建好了分片策略（NavPuckBleNative 已加载）');
  const st0 = A3.chunk_policy.snapshot();
  eq(st0.learned, 20, 'PWA/新装：起步就是 20 字节');
  eq(st0.auto, true, '默认自动升档（推荐路径）');

  const ceiling_el = BY_ID.get('opt-chunk-ceiling');
  const auto_el = BY_ID.get('opt-chunk-auto');
  ceiling_el.value = '244';
  ceiling_el.fire('change');
  eq(A3.chunk_policy.snapshot().ceiling, 244, '把上限拧到 244 => 策略上限 = 244');
  const stored = globalThis.localStorage.getItem('navpuck.ble.chunk.v1');
  ok(/"ceiling":244/.test(stored), '上限**当场落盘**（下次打开还是它）');
  ok(/244/.test(BY_ID.get('chunk-detail').textContent),
     `详情那一行跟着更新：${BY_ID.get('chunk-detail').textContent.slice(0, 60)}…`);

  auto_el.checked = false;
  auto_el.fire('change');
  eq(A3.chunk_policy.snapshot().auto, false, '关掉"自动升档" => 锁在所选上限内');
  eq(A3.chunk_policy.size(null), 20, '锁定也照样被 MTU 未知这条夹到 20（不会拿去乱写）');
  eq(A3.chunk_policy.size(517), 244, '锁定 + MTU 517 => 就用 244（用户自己选的那一档）');

  BY_ID.get('chunk-reset').fire('click');
  const st2 = A3.chunk_policy.snapshot();
  eq(st2.learned, 20, '"清空分片学习记录" => 回到 20 起步');
  eq(st2.ceiling, 512, '清空也会把上限复位（否则用户以为清了其实没清）');

  // 当前分片必须能一眼看到（状态面板那一格）
  A3.update_chunk_ui();
  ok(/B$/.test(BY_ID.get('chunk-info').textContent.trim()),
     `状态面板"分片"那一格显示当前值：${BY_ID.get('chunk-info').textContent}`);

  // PWA 里不会崩：没有 transport 也要画得出来（这一格不能是空白）
  eq(BY_ID.get('chunk-detail').textContent.length > 0, true, '详情行永远有内容（PWA 里说明走哪条路）');
}

// ---------------------------------------------------------------------------
section('12] "不支持 Web Bluetooth" 的提示路径');
// ---------------------------------------------------------------------------
// ⚠️ 这一节必须放在最后：它会再新建一个 App 实例，而 DOM 桩是共享的 ——
//    新实例 init() 会把**它自己的**监听器绑到同一批元素上，之后任何一次
//    点击/输入都会同时走到两个实例的处理函数（它没有 fix，会把状态面板改回
//    waiting）。第 9、10 节已经建过第二个实例了，所以这里更得排在最后 ——
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
