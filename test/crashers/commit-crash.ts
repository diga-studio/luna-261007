// 提交到指定阶段后“被杀”：staged=暂存完成，renamed=制品已就位但数据库未标记。
import { SnapshotRepository } from '../../src/index.js';
import type { Manifest } from '../../src/index.js';

const [dir, releaseId, manifestJson, pomPath, jarPath, phase] = process.argv.slice(2);
const manifest = JSON.parse(manifestJson!) as Manifest;
const repo = SnapshotRepository.open(dir!, {
  afterStaged: () => {
    if (phase === 'staged') process.exit(43);
  },
  afterArtifactsRenamed: () => {
    if (phase === 'renamed') process.exit(44);
  },
});
repo.register(releaseId!, manifest);
repo.commit(releaseId!, pomPath!, jarPath!);
repo.close();
