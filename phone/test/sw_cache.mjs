/*
 * "改了被预缓存的文件、忘了 bump sw.js 的 CACHE"——**结构性的第一道防线**。
 *
 * 用法（在 navpuck 根目录）：
 *     node phone/test/sw_cache.mjs            # 校验（自测里那条断言就是它）
 *     node phone/test/sw_cache.mjs --print    # 只打印当前哈希与清单
 *     node phone/test/sw_cache.mjs --fix      # 修：必要时 bump CACHE + 重写清单
 *
 * ===========================================================================
 *  为什么要有它（这个坑踩了十五次）
 * ===========================================================================
 * Service Worker 是**缓存优先**的：`sw.js` 里那个 `CACHE` 名字不变，手机上的
 * PWA（和 APK）就会一直吃旧副本 —— 症状是"代码明明改了、手机上还是老样子"，
 * 而且看起来像**没修**。历史上这个坑踩了十五次，最近一次是改了 tiles.js
 * 忘了 bump，结果真机上跑的还是缓存里的旧文件（实测 51,247 B、不含新函数）。
 *
 * 光靠"记得 bump"是不行的（写这段注释的人也忘了两次）。所以这里的做法是：
 * **把"文件内容"和"缓存名字"绑成一个被自测检查的不变式**：
 *
 *     清单里的 sha256 == 当前文件的 sha256      （内容没变）
 *     清单里的 cache    == sw.js 里的 CACHE     （名字对得上）
 *
 * 任何一条不成立，`phone/test/sw.mjs` 就直接红，并打印该跑哪条命令。
 * `--fix` 会**同时**做两件事：内容变了就 bump 版本号、然后重写清单 ——
 * 所以"版本号"和"内容"不可能再各自漂移。
 *
 * ⚠️ 它只改两处：`sw.js` 里那一行 `const CACHE = '...'`，和清单文件。
 *    **不动** ASSETS 清单、不动任何注释（版本说明要人写，那是给人看的）。
 *
 * ⚠️ 这是**测试期**的防线：它只在你跑自测时生效。真正"谁都不记得也照样生效"
 *    的那一道在 `sw.js` 的**版本自检**里（运行时比对缓存与线上的字节），
 *    见 phone/test/sw.mjs 第 3 节与 sw.js 顶部那一段。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PHONE_DIR = path.resolve(__dirname, '..');
export const MANIFEST_NAME = 'shell_manifest.json';

export function sw_path(dir) { return path.join(dir || PHONE_DIR, 'sw.js'); }
export function manifest_path(dir) { return path.join(dir || PHONE_DIR, 'test', MANIFEST_NAME); }

/** 把 sw.js 里的 ASSETS 数组抽出来（顺序即预缓存顺序）。 */
export function assets_of(src) {
  const m = /const ASSETS = \[([\s\S]*?)\];/.exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** 把 sw.js 里的 CACHE 名字抽出来。 */
export function cache_of(src) {
  const m = /const CACHE = '([^']+)'/.exec(src);
  return m ? m[1] : null;
}

/** 版本号解析：navpuck-phone-v17 -> {prefix, n}；不认识的命名返回 null。 */
export function parse_cache(name) {
  const m = /^(.*-v)(\d+)$/.exec(String(name || ''));
  if (!m) return null;
  return { prefix: m[1], n: Number(m[2]), text: name };
}

/** ASSETS 里每个文件的 sha256（读的是**磁盘上的真文件**）。 */
export function hash_assets(dir, assets) {
  const out = {};
  for (const rel of assets) {
    const p = path.join(dir || PHONE_DIR, rel);
    if (!fs.existsSync(p)) { out[rel] = 'MISSING'; continue; }
    out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  return out;
}

export function read_manifest(dir) {
  try {
    const raw = fs.readFileSync(manifest_path(dir), 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !j.files) return null;
    return j;
  } catch (_e) { return null; }
}

function same_files(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return false;
    if (a[ka[i]] !== b[kb[i]]) return false;
  }
  return true;
}

/**
 * 校验不变式。返回 {ok, problems:[...], cache, hash, manifest}。
 * 自测直接用它；CLI 也用它（所以两边永远不会各判一套）。
 */
export function verify(dir) {
  const d = dir || PHONE_DIR;
  const src = fs.readFileSync(sw_path(d), 'utf8');
  const assets = assets_of(src);
  const cache = cache_of(src);
  const hash = assets ? hash_assets(d, assets) : {};
  const manifest = read_manifest(d);
  const problems = [];

  if (!assets) problems.push('sw.js 里找不到 `const ASSETS = [...]`');
  if (!cache) problems.push("sw.js 里找不到 `const CACHE = '...'`");
  if (!parse_cache(cache)) {
    problems.push(`CACHE 名字 "${cache}" 不符合 <前缀>-v<数字> 的写法，--fix 没法自动 bump`);
  }
  const missing = Object.keys(hash).filter((k) => hash[k] === 'MISSING');
  if (missing.length) problems.push(`ASSETS 里这些文件在磁盘上不存在：${missing.join('、')}`);

  if (!manifest) {
    problems.push(`清单不存在（${path.relative(d, manifest_path(d))}）：` +
                  '跑 `node phone/test/sw_cache.mjs --fix` 建立基线');
  } else {
    if (!same_files(manifest.files, hash)) {
      problems.push('被预缓存的文件内容变了，但缓存版本号没跟着变 —— ' +
                    '**手机上（PWA 和 APK 都是）会继续吃旧副本**。' +
                    '跑 `node phone/test/sw_cache.mjs --fix`：它会 bump CACHE 并重写清单');
    }
    if (manifest.cache !== cache) {
      problems.push(`清单里记的是 ${manifest.cache}，sw.js 里是 ${cache}：` +
                    '两边对不上，跑 `node phone/test/sw_cache.mjs --fix` 对齐');
    }
  }
  return { ok: problems.length === 0, problems, cache, hash, manifest, assets };
}

/**
 * 修：内容变了就 bump 版本号（sw.js 那一行 + 清单），然后重写清单。
 * @returns {{ok, bumped_from, bumped_to, wrote, cache, reasons}}
 */
export function fix(dir) {
  const d = dir || PHONE_DIR;
  const p = sw_path(d);
  let src = fs.readFileSync(p, 'utf8');
  const assets = assets_of(src);
  const before = cache_of(src);
  const hash = hash_assets(d, assets);
  const manifest = read_manifest(d);
  const reasons = [];
  let cache = before;

  const content_changed = !manifest || !same_files(manifest.files, hash);
  if (content_changed) {
    const parsed = parse_cache(before);
    if (!parsed) {
      return { ok: false, bumped_from: before, bumped_to: null, wrote: false, cache: before,
               reasons: [`CACHE 名字 "${before}" 不符合 <前缀>-v<数字>，没法自动 bump`] };
    }
    cache = parsed.prefix + (parsed.n + 1);
    src = src.replace(`const CACHE = '${before}'`, `const CACHE = '${cache}'`);
    fs.writeFileSync(p, src, 'utf8');
    reasons.push(`内容变了 -> CACHE ${before} -> ${cache}`);
  } else if (manifest.cache !== before) {
    reasons.push(`内容没变，只把清单里的版本号对齐成 ${before}`);
  }

  const out = {
    note: '被 sw.js 预缓存的文件的 sha256。⚠️ 改了它们中的任何一个，' +
          '就必须让 CACHE 版本号一起变 —— 跑 `node phone/test/sw_cache.mjs --fix` ' +
          '（它会 bump sw.js 里那一行并重写本文件）。',
    cache: cache,
    files: hash,
  };
  fs.writeFileSync(manifest_path(d), JSON.stringify(out, null, 2) + '\n', 'utf8');
  return { ok: true, bumped_from: before, bumped_to: cache, wrote: true,
           cache: cache, reasons: reasons };
}

// ---- CLI ------------------------------------------------------------------
const is_cli = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (is_cli) {
  const mode = process.argv.includes('--fix') ? 'fix'
    : (process.argv.includes('--print') ? 'print' : 'verify');
  if (mode === 'print') {
    const v = verify(PHONE_DIR);
    console.log(JSON.stringify({ cache: v.cache, files: v.hash }, null, 2));
  } else if (mode === 'fix') {
    const r = fix(PHONE_DIR);
    console.log(r.ok ? '已修正：' : '修正失败：');
    for (const x of r.reasons) console.log('  - ' + x);
    if (r.ok) {
      console.log(`  当前 CACHE = ${r.cache}`);
      console.log('  ⚠️ 记得在 sw.js 顶部的版本说明里补一行"这一版改了什么"（那是给人看的）。');
    }
    process.exit(r.ok ? 0 : 1);
  } else {
    const v = verify(PHONE_DIR);
    if (v.ok) {
      console.log(`预缓存清单一致：CACHE=${v.cache}，${Object.keys(v.hash).length} 个文件`);
      process.exit(0);
    }
    console.log('预缓存清单**不一致**：');
    for (const x of v.problems) console.log('  ✗ ' + x);
    process.exit(1);
  }
}
