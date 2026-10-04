// 登记事务提交后立即“被杀”（afterRegister 钩子中退出）。
import { SnapshotRepository } from '../../src/index.js';
import type { Manifest } from '../../src/index.js';

const [dir, releaseId, manifestJson] = process.argv.slice(2);
const manifest = JSON.parse(manifestJson!) as Manifest;
const repo = SnapshotRepository.open(dir!, {
  afterRegister: () => process.exit(42),
});
repo.register(releaseId!, manifest);
repo.close();
