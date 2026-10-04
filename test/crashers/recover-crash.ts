// 恢复过程中处理第一个未完成发布时“被杀”，用于验证恢复可重入。
import { SnapshotRepository } from '../../src/index.js';

const [dir] = process.argv.slice(2);
const repo = SnapshotRepository.open(dir!, {
  duringRecovery: () => process.exit(45),
});
repo.close();
