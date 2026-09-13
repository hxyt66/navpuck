/*
 * 跑齐手机端的七套自测。
 *
 * 用法（在 navpuck 根目录）：
 *     node phone/test/run-all.mjs
 *
 * （这个工程不用 npm，所以没有 `npm test`。）
 *
 * 七套各管一段：
 *   1) selftest.mjs     字节级：编/解码与 Python 完全相同（黄金向量）
 *   2) parity.mjs       语义级：路线/路口/NAV_UPDATE 与 navigator.py 相同
 *   3) tiles.mjs        离线底图：.npt 格式（真起 python 对拍）/ 瓦片缓存 /
 *                       沿路预取 / "有瓦片就不碰 Overpass"
 *   4) mapview.mjs      手机端地图：投影对拍 / 边界（跨 180°）/ **离线也能画**
 *                       （fetch 一律抛错）/ 手势 / 高 DPI / 渲染内容 / 性能
 *   5) search.mjs       地点搜索：位置偏置（不带就搜到别的省）/ "没找到"与
 *                       "失败"分得开 / 点选真的成为目的地 / 竞态
 *                       （**全程不联网**；真网络那节要 NAVPUCK_SEARCH_LIVE=1）
 *   6) integration.mjs  接线级：BLE 分片/队列/重发/看门狗/端到端闭环
 *   7) ui.mjs           index.html ↔ app.js 的界面接线
 *
 * 任何一套失败都会以非 0 退出，方便挂到 pre-commit 或者 CI 上。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  ['selftest.mjs', '字节级协议一致性（黄金向量）'],
  ['parity.mjs', 'Python ↔ JS 导航语义对拍'],
  ['tiles.mjs', '离线瓦片底图（格式对拍 / 缓存 / 预取 / 兜底顺序）'],
  ['mapview.mjs', '手机端地图（投影 / 边界 / 离线渲染 / 手势 / DPI / 性能）'],
  ['search.mjs', '地点搜索（位置偏置 / 结果渲染 / 点选 / 文案区分 / 竞态）'],
  ['integration.mjs', 'BLE / 主循环 集成'],
  ['ui.mjs', 'index.html ↔ app.js 界面接线（DOM 打桩）'],
];

const results = [];
for (const [file, desc] of SUITES) {
  console.log('\n' + '#'.repeat(66));
  console.log(`# ${file} —— ${desc}`);
  console.log('#'.repeat(66));
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..', '..'),
  });
  results.push([file, r.status]);
}

console.log('\n' + '='.repeat(66));
let failed = 0;
for (const [file, status] of results) {
  const tag = status === 0 ? '通过' : `失败（exit ${status}）`;
  if (status !== 0) failed += 1;
  console.log(`  ${tag.padEnd(16)} ${file}`);
}
console.log('='.repeat(66));
if (failed === 0) {
  console.log('  七套自测全部通过。');
} else {
  console.log(`  ${failed} 套自测失败。`);
}
process.exit(failed === 0 ? 0 : 1);
