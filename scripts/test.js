// 测试入口：以 --expose-gc 启动子进程跑 node:test，
// 使规模测试可以主动触发 GC、准确测量峰值内存。
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const result = spawnSync(
  process.execPath,
  ['--expose-gc', '--test', path.join(__dirname, '..', 'dist', 'test', '*.test.js')],
  { stdio: 'inherit' }
);
process.exit(result.status === null ? 1 : result.status);
