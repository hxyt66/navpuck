/*
 * 自测用的小工具：一个**能真的出像素**的 CanvasRenderingContext2D 替身 + PNG 编码。
 *
 * 为什么需要它（这一条值得写下来）：
 *   phone/mapview.js 画的是一张图，而"画得对不对"最有力的证据是**看一眼**。
 *   但开发机上没有浏览器、工程里也没有（也不该有）canvas 这种原生依赖 ——
 *   所以这一版自测里的"渲染"是**两件事分开证**的：
 *
 *     1. 记录型 ctx（见 mapview.mjs 的 RecCtx）：把 mapview 真正发出的
 *        每一个 moveTo/lineTo/stroke/arc/fillText 记下来，用**调用序列**
 *        断言"投影对了、颜色/线宽/图层顺序对了、该抽稀的抽稀了"。
 *     2. 这个文件：把**同一批调用**真的栅格化成一个 PNG，用眼睛确认它长成
 *        一张地图（而不是一堆散线）。
 *
 * ⚠️ 它是**给自测用的近似实现**，不是浏览器：不做抗锯齿、不做字体（文本不画，
 *    只在旁边记一笔）、不做路径裁剪以外的任何高级特性。所以：
 *      - **不要**拿它当性能基准（真实性能看 mapview.mjs 那一节的记录型 ctx，
 *        以及文件里写明的"这只算了 JS 侧"这条边界）；
 *      - 它的唯一用途是"肉眼可验证"，出图只在设了 NAVPUCK_MV_PNG 时发生。
 */

import zlib from 'node:zlib';
import fs from 'node:fs';

// ---- 颜色 ----------------------------------------------------------------

/** '#rgb' / '#rrggbb' / '#rrggbbaa' / 'rgba(r,g,b,a)' / 'rgb(...)' -> [r,g,b,a]。 */
export function parse_color(s) {
  const t = String(s || '').trim();
  if (t.startsWith('#')) {
    const h = t.slice(1);
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16), 1];
    }
    if (h.length === 6 || h.length === 8) {
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16), a];
    }
  }
  const m = /rgba?\(([^)]+)\)/.exec(t);
  if (m) {
    const p = m[1].split(',').map((v) => parseFloat(v));
    return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
  }
  return [0, 0, 0, 1];
}

// ---- PNG 编码（zlib 是 Node 自带的，不需要任何依赖）----------------------

let _crc_table = null;
function crc32(buf) {
  if (_crc_table === null) {
    _crc_table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crc_table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = _crc_table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** RGB 缓冲（h 行 w 列各 3 字节）-> PNG 字节。 */
export function png_bytes(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;                       // filter type 0
    rgb.copy
      ? rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : Buffer.from(rgb.buffer, y * stride, stride)
        .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 2;      // color type: truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 上下文替身 ----------------------------------------------------------

/**
 * @param {number} w @param {number} h 逻辑（CSS）像素尺寸
 * @param {number} scale 设备像素倍率（模拟 devicePixelRatio：缓冲按
 *        w*scale × h*scale 分配，和 mapview.js 的 setTransform 一起用）
 */
export function make_png_ctx(w, h, scale) {
  const s = Math.max(1, Math.round(scale || 1));
  const W = Math.round(w * s);
  const H = Math.round(h * s);
  const buf = Buffer.alloc(W * H * 3);
  // 当前变换：只有 setTransform(dpr,0,0,dpr,0,0) 这一种，所以存一个倍率就够。
  let tf = 1;

  const ctx = {
    _buf: buf, _W: W, _H: H, _scale: s,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', font: '', textAlign: 'left',
    textBaseline: 'alphabetic',
    texts: 0, strokes: 0, fills: 0,
    _path: [],
    _sub: null,

    _px(x, y, c) {
      const px = Math.round(x * tf);
      const py = Math.round(y * tf);
      if (px < 0 || py < 0 || px >= W || py >= H) return;
      const i = (py * W + px) * 3;
      const a = c[3];
      if (a >= 1) {
        buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
      } else {
        buf[i] = Math.round(c[0] * a + buf[i] * (1 - a));
        buf[i + 1] = Math.round(c[1] * a + buf[i + 1] * (1 - a));
        buf[i + 2] = Math.round(c[2] * a + buf[i + 2] * (1 - a));
      }
    },
    _disc(cx, cy, r, c) {
      const x0 = Math.floor(cx * tf - r * tf) - 1;
      const x1 = Math.ceil(cx * tf + r * tf) + 1;
      const y0 = Math.floor(cy * tf - r * tf) - 1;
      const y1 = Math.ceil(cy * tf + r * tf) + 1;
      const rr = r * tf;
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const dx = (x + 0.5) - cx * tf;
          const dy = (y + 0.5) - cy * tf;
          if (dx * dx + dy * dy <= rr * rr) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const i = (y * W + x) * 3;
            const a = c[3];
            if (a >= 1) { buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; }
            else {
              buf[i] = Math.round(c[0] * a + buf[i] * (1 - a));
              buf[i + 1] = Math.round(c[1] * a + buf[i + 1] * (1 - a));
              buf[i + 2] = Math.round(c[2] * a + buf[i + 2] * (1 - a));
            }
          }
        }
      }
    },

    setTransform(a) { tf = a || 1; },
    save() {}, restore() {},

    fillRect(x, y, rw, rh) {
      const c = parse_color(this.fillStyle);
      for (let yy = Math.round(y * tf); yy < Math.round((y + rh) * tf); yy += 1) {
        for (let xx = Math.round(x * tf); xx < Math.round((x + rw) * tf); xx += 1) {
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const i = (yy * W + xx) * 3;
          buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
        }
      }
    },

    beginPath() { this._path = []; },
    moveTo(x, y) { this._sub = [[x, y]]; this._path.push(this._sub); },
    lineTo(x, y) {
      if (!this._sub) this.moveTo(x, y);
      else this._sub.push([x, y]);
    },
    closePath() {
      if (this._sub && this._sub.length) this._sub.push(this._sub[0].slice());
    },
    arc(x, y, r) { this._sub = { circle: [x, y, r] }; this._path.push(this._sub); },
    rect() {},

    stroke() {
      const c = parse_color(this.strokeStyle);
      const r = Math.max(0.5, this.lineWidth * 0.5);
      for (const sub of this._path) {
        if (sub.circle) { this._disc(sub.circle[0], sub.circle[1], sub.circle[2], c); continue; }
        for (let i = 1; i < sub.length; i += 1) {
          const a = sub[i - 1];
          const b = sub[i];
          const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const n = Math.max(1, Math.ceil(d * tf));
          for (let k = 0; k <= n; k += 1) {
            const t = k / n;
            this._disc(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, r, c);
          }
        }
      }
      this.strokes += 1;
    },

    /** 偶奇规则的扫描线填充（足够画箭头/圆点）。 */
    fill() {
      const c = parse_color(this.fillStyle);
      for (const sub of this._path) {
        if (sub.circle) { this._disc(sub.circle[0], sub.circle[1], sub.circle[2], c); continue; }
        const pts = sub;
        if (pts.length < 3) continue;
        let ymin = Infinity, ymax = -Infinity;
        for (const p of pts) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
        const y0 = Math.floor(ymin * tf), y1 = Math.ceil(ymax * tf);
        for (let y = y0; y <= y1; y += 1) {
          const sy = (y + 0.5) / tf;
          const xs = [];
          for (let i = 0; i < pts.length; i += 1) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            if ((a[1] > sy) === (b[1] > sy)) continue;
            xs.push(a[0] + (sy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
          }
          xs.sort((p, q) => p - q);
          for (let i = 0; i + 1 < xs.length; i += 2) {
            for (let x = Math.round(xs[i] * tf); x <= Math.round(xs[i + 1] * tf); x += 1) {
              this._px(x / tf, (y + 0.5) / tf, c);
            }
          }
        }
      }
      this.fills += 1;
    },

    // 文本不进像素（这个替身没有字体），只记一笔 —— 视觉验证看的是路网/航线/车标
    fillText() { this.texts += 1; },
    measureText(s) { return { width: String(s).length * 6.0 }; },

    /** 存成 PNG。返回字节数。 */
    to_png(file) {
      const bytes = png_bytes(W, H, buf);
      fs.writeFileSync(file, bytes);
      return bytes.length;
    },
  };
  return ctx;
}
