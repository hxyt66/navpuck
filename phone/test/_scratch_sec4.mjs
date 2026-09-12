// 临时实验 2：复现 section 4，看空片到底在哪一步消失。跑完即删。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PHONE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.document = undefined;
const NM_ = require(path.join(PHONE_DIR, 'navmath.js'));
const P_ = require(path.join(PHONE_DIR, 'proto.js'));
const RT_ = require(path.join(PHONE_DIR, 'route.js'));
const MAP_ = require(path.join(PHONE_DIR, 'map.js'));
const BLE_ = require(path.join(PHONE_DIR, 'ble.js'));
globalThis.NavPuckMath = NM_; globalThis.NavPuckProto = P_;
globalThis.NavPuckRoute = RT_; globalThis.NavPuckMap = MAP_; globalThis.NavPuckBle = BLE_;
const P = P_, RT = RT_, BLE = BLE_;
const APP = require(path.join(PHONE_DIR, 'app.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeDevice {
  constructor() {
    this.parser = new P.FrameParser();
    this.frames = []; this.writes = []; this.chunk_sizes = new Set();
    this.fail_above = Infinity; this.notify_cb = null; this.subscribed = false;
  }
  receive(bytes) {
    this.writes.push(bytes.length);
    this.chunk_sizes.add(bytes.length);
    if (bytes.length > this.fail_above) { const e = new Error('x'); e.name = 'NetworkError'; throw e; }
    const got = this.parser.feed(bytes);
    for (const fr of got) this.frames.push(fr);
    if (bytes.length === 14) {
      console.log('  [dev] 收到 14 字节写，解出', got.length, '帧，',
                  '首字节', Array.from(bytes).map((b) => b.toString(16)).join(' '));
    }
  }
  frames_of_type(t) { return this.frames.filter((f) => f.type === t); }
}
function fake_bluetooth(device, opts) {
  const o = opts || {};
  const rx = { async writeValueWithoutResponse(b) { if (o.reject_without_response) throw new Error('x'); device.receive(b); },
               async writeValue(b) { device.receive(b); } };
  const tx = { async startNotifications() { device.subscribed = true; return tx; },
               addEventListener(ev, cb) { if (ev === 'characteristicvaluechanged') device.notify_cb = cb; } };
  const gatt = { connected: false, async connect() { gatt.connected = true; return gatt; },
                 disconnect() { gatt.connected = false; if (device._disc_cb) device._disc_cb(); } };
  const bt = { async requestDevice() { return { name: o.name || 'NavPuck-A1B2', gatt,
      addEventListener(ev, cb) { if (ev === 'gattserverdisconnected') device._disc_cb = cb; } }; } };
  return { bt, rx, tx, gatt };
}
async function make_link(device, opts) {
  const o = opts || {};
  const f = fake_bluetooth(device, o);
  const link = new BLE.BleLink({ navigator: { bluetooth: f.bt }, onLog: () => {} });
  link._gatt_connect = async function () {
    await f.gatt.connect(); this.server = f.gatt; this.rx = f.rx; this.tx = f.tx;
    await f.tx.startNotifications();
    this.tx.addEventListener('characteristicvaluechanged', (ev) => this._on_notify(ev));
    this.parser.reset(); this.chunk_size = 512; this._chunk_known = false;
    this._last_rx_t = Date.now(); this._setState('up', { name: this.device_name });
  };
  return { link, f };
}
class ScriptSource {
  constructor(fixes) { this.fixes = fixes; this.i = 0; this.heading_source = 'gps'; }
  has_fix() { return true; }
  fix() { const f = this.fixes[Math.min(this.i, this.fixes.length - 1)]; this.i += 1; return f; }
  advance(n) { this.i += n; }
}
function demo_route() { return new RT.Route(RT.DEMO_ROUTE.map((p) => [p[0], p[1], p[2]]), true); }
function fixes_along(route, n, speed_mps) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = route.total_m * k / Math.max(1, n - 1) * 0.9;
    const [la, lo] = route.point_at(s);
    out.push([la, lo, route.tangent_deg(s), speed_mps]);
  }
  return out;
}

// ============================ section 4 ============================
const dev = new FakeDevice();
const { link } = await make_link(dev);
await link.connect();

const route = demo_route();
const source = new ScriptSource(fixes_along(route, 400, 12.0));

const sent = [];
const nav = new APP.Navigator(route, source, {
  send: (frame, kind, prio) => { sent.push({ frame, kind, prio, len: frame.length }); return link.send(frame, kind, prio); },
  onLog: () => {}, onUi: () => {},
  config: { rate_hz: 10, no_map: true },
});
nav.set_ble(link);

for (let i = 0; i < 30; i++) nav.cycle(0.1);
console.log('sent kinds:', JSON.stringify(sent.map((s) => `${s.kind}:${s.len}`)));
console.log('link.frames_sent =', link.frames_sent, 'frames_dropped =', link.frames_dropped,
            'queue =', link._queue.length);
console.log('QUEUE =', JSON.stringify(link._queue.map((f) => `${f.kind}:${f.length}:type${f.bytes[3]}:${f.priority}`)));
const realrx = link.rx;
link.rx = { async writeValueWithoutResponse(b) {
  console.log(`  [write ${b.length}B type=${b[3]} first=${Array.from(b.slice(0, 8)).map((x) => x.toString(16)).join(' ')}]`);
  return realrx.writeValueWithoutResponse(b);
} };
const t0 = Date.now();
while (link._queue.length > 0 && Date.now() - t0 < 8000) await sleep(20);
console.log('drained. frames_sent =', link.frames_sent, 'frames_dropped =', link.frames_dropped);
console.log('dev.writes =', dev.writes.join(','));
const rf = dev.frames_of_type(P.MsgType.NAV_ROUTE);
console.log('dev NAV_ROUTE frames =', rf.length,
            rf.map((f) => P.NavRoute.unpack(f.payload).total_points).join(','));
console.log('dev NAV_UPDATE =', dev.frames_of_type(P.MsgType.NAV_UPDATE).length);
console.log('parser: frames_ok=', dev.parser.frames_ok, 'crc_errors=', dev.parser.crc_errors,
            'resyncs=', dev.parser.resyncs, 'mid=', dev.parser.is_mid_frame());
