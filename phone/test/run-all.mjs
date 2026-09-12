/*
 * 跑齐手机端的四套自测。
 *
 * 用法（在 navpuck 根目录）：
 *     node phone/test/run-all.mjs
 *
 * （这个工程不用 npm，所以没有 `npm test`。）
 *
 * 四套各管一段：
 *   1) selftest.mjs     字节级：编/解码与 Python 完全相同（黄金向量）
 *   2) parity.mjs       语义级：路线/路口/NAV_UPDATE 与 navigator.py 相同
 *   3) integration.mjs  接线级：BLE 分片/队列/重发/看门狗/端到端闭环
 *   4) ui.mjs           index.html ↔ app.js 的界面接线
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
  console.log('  四套自测全部通过。');
} else {
  console.log(`  ${failed} 套自测失败。`);
}
process.exit(failed === 0 ? 0 : 1);
