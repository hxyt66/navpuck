// 临时：生成和 app.js._send_window(true) 逐字节相同的流，并跑 JS 侧切分矩阵。跑完即删。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.resolve(HERE, '..');
const P = require(path.join(PHONE_DIR, 'proto.js'));

const pts = [];
for (let i = 0; i <= 1000; i++) pts.push([i * 10, i * 2]);
const frames = [P.encode_nav_route(P.route_chunks([])[0]),
                ...P.route_chunks(pts).map((c) => P.encode_nav_route(c)),
                P.encode_nav_clock(new P.NavClock({ epoch_s: 1789226827, tz_offset_min: 480 })),
                P.encode_nav_update(new P.NavUpdate({ heading_cdeg: 9000, speed_kmh_x10: 487 })),
                P.encode_nav_text(P.TextKind.ROAD_NAME, '中山路')];
const total = frames.reduce((a, f) => a + f.length, 0);
const stream = new Uint8Array(total);
{ let o = 0; for (const f of frames) { stream.set(f, o); o += f.length; } }
fs.writeFileSync(path.join(HERE, '_scratch_stream.bin'), stream);
console.log('wrote stream', stream.length, 'bytes; frames =', frames.map((f) => f.length).join(','));

function decodeChunks(chunks) {
  const p = new P.FrameParser();
  const out = [];
  for (const c of chunks) for (const fr of p.feed(c)) out.push(`${fr.type}/${fr.payload.length}`);
  return out.join(',') + (out.length ? ',' : '');
}
function slice(a, b) { return stream.subarray(Math.max(0, a), Math.min(b, stream.length)); }
function cmp(a, b) {
  const x = decodeChunks(a); const y = decodeChunks(b);
  return x === y ? '' : `DIFF\n  want ${y}\n  got  ${x}`;
}

const whole = [stream];
const want = decodeChunks(whole);
console.log('whole ' + want);
const byteChunks = [];
for (let i = 0; i < stream.length; i++) byteChunks.push(slice(i, i + 1));
console.log('byte ' + decodeChunks(byteChunks));
let bad2 = 0;
for (let i = 1; i < stream.length; i++) {
  const d = cmp([slice(0, i), slice(i, stream.length)], whole);
  if (d) { bad2++; if (bad2 < 4) console.log('bad2 @' + i + ' ' + d); }
}
console.log(`two_way_bad ${bad2} of ${stream.length - 1}`);
const w512 = [];
for (let i = 0; i < stream.length; i += 512) w512.push(slice(i, i + 512));
console.log('w512 ' + decodeChunks(w512));
let badE = 0, totE = 0;
for (let a = 0; a <= 14; a++) for (let b = a; b <= 20; b++) {
  totE++;
  if (cmp([slice(0, a), slice(a, b), slice(b, stream.length)], whole)) badE++;
}
console.log(`empty_neighborhood_bad ${badE} of ${totE}`);
{
  const p = new P.FrameParser();
  const got = [];
  for (let i = 0; i < stream.length; i++) { const fr = p._push ? null : null; }
  for (const fr of p.feed(stream)) got.push(fr);
  console.log(`stats frames_ok=${p.frames_ok} crc_errors=${p.crc_errors} resyncs=${p.resyncs} bad_version=${p.bad_version} mid=${p.is_mid_frame()}`);
}
