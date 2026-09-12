// 临时实验：任意写边界下 FrameParser 会不会丢帧。跑完即删。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PHONE_DIR = path.dirname(fileURLToPath(import.meta.url)) + path.sep + '..';
const P = require(path.join(PHONE_DIR, 'proto.js'));

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');

// ---- 造和 app.js._send_window(true) 逐字节相同的字节流 ----
const pts = [];
for (let i = 0; i <= 1000; i++) pts.push([i * 10, i * 2]);
const frames = [P.encode_nav_route(P.route_chunks([])[0]),
                ...P.route_chunks(pts).map((c) => P.encode_nav_route(c))];
console.log('帧长：', frames.map((f) => f.length).join(', '));
console.log('空片字节：', hex(frames[0]));
const total = frames.reduce((a, f) => a + f.length, 0);
const stream = new Uint8Array(total);
{ let o = 0; for (const f of frames) { stream.set(f, o); o += f.length; } }
console.log('总字节：', total);

const want = frames.map((f) => `${f[3]}/${f[4] | (f[5] << 8)}`);

function run(chunks, label) {
  const p = new P.FrameParser();
  const got = [];
  for (const c of chunks) for (const fr of p.feed(c)) got.push(`${fr.type}/${fr.payload.length}`);
  const okAll = JSON.stringify(got) === JSON.stringify(want);
  if (!okAll) {
    console.log(`  ✗ ${label}`);
    console.log(`     want ${JSON.stringify(want)}`);
    console.log(`     got  ${JSON.stringify(got)}`);
    console.log(`     crc_errors=${p.crc_errors} resyncs=${p.resyncs} mid=${p.is_mid_frame()}`);
  }
  return okAll;
}

// 1) 一次喂完
console.log('1) 整块：', run([stream], 'whole') ? 'OK' : 'FAIL');

// 2) 逐字节
const byteChunks = [];
for (let i = 0; i < stream.length; i++) byteChunks.push(stream.subarray(i, i + 1));
console.log('2) 逐字节：', run(byteChunks, 'byte') ? 'OK' : 'FAIL');

// 3) 所有 2 段切分点
let bad2 = 0;
for (let i = 1; i < stream.length; i++) {
  if (!run([stream.subarray(0, i), stream.subarray(i)], `2split@${i}`)) bad2++;
}
console.log(`3) 全部 ${stream.length - 1} 个二段切分点：坏 ${bad2} 个`);

// 4) 512 字节写边界（和 ble.js 的分片完全一样）
const w512 = [];
for (let i = 0; i < stream.length; i += 512) w512.push(stream.subarray(i, Math.min(i + 512, stream.length)));
console.log('4) 512 字节写：', run(w512, '512') ? 'OK' : 'FAIL',
            `边界=${w512.map((c) => c.length).join('/')}`);

// 5) 只围绕 14 字节空片做所有切分：把空片从中间劈开、把边界放在空片两侧
let badE = 0;
for (let a = 0; a <= 14; a++) {
  for (let b = a; b <= 20; b++) {
    const cs = [stream.subarray(0, a), stream.subarray(a, b), stream.subarray(b)];
    if (!run(cs, `empty ${a}/${b}`)) badE++;
  }
}
console.log(`5) 空片附近三段的 ${7 * 21} 种切法：坏 ${badE} 个`);

// 6) 对照：上一版说法里的"23205"到底怎么才能出现
//    len 字段 = buf[4]|buf[5]<<8，要得到 0x5AA5，必须 buf[4]=0xA5 buf[5]=0x5A，
//    也就是解析器必须在"真帧头"前 4 个字节处就以为自己在帧里。
{
  const p = new P.FrameParser();
  // 造一个错位的输入：在空片前插入 4 个字节，让 A5 5A 落在 buf[4..5]
  const junk = new Uint8Array([0xA5, 0x5A, 0x01, 0x04, 0xA5, 0x5A]);
  const got = [];
  for (const fr of p.feed(junk)) got.push(`${fr.type}/${fr.payload.length}`);
  console.log('6) 手工错位 6 字节：', JSON.stringify(got), 'resyncs=', p.resyncs, 'mid=', p.is_mid_frame());
}
