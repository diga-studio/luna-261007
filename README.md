# BranchForge

三方文本合并库（TypeScript）。上层提供同一文件的共同祖先、当前分支、
待合入分支三份 UTF-8 文本，BranchForge 在内存中完成单文件合并：
自动生成合并预览（区分自动合并段与冲突段），并根据人工选择生成最终文本。
不管理仓库与分支，不读写磁盘，三个版本与结果只存内存。

## 安装与测试

```sh
npm install
npm test        # 编译并运行 node:test 测试
npm run build   # 产出 dist/（CommonJS + 类型声明）
```

唯一开发依赖是 `typescript`，测试使用 Node.js 内置的 `node:test`，
不依赖任何本机服务。

## API

```ts
import { previewMerge, resolveMerge } from "branchforge";

const preview = previewMerge(ancestorText, oursText, theirsText);
// preview.segments: (AutoSegment | ConflictSegment)[]，按祖先顺序排列
//   - { kind: "auto", text }                自动合并好的正文
//   - { kind: "conflict", ancestor, ours, theirs }  需人工决定的三份区域文本
// preview.conflicts: 所有冲突段，与解决选择一一对应

const finalText = resolveMerge(preview, [
  { side: "ours" },                          // 取当前分支
  { side: "theirs" },                        // 取待合入分支
  { side: "custom", text: "手工文本\n" },     // 或提供替换文本
]);
// resolutions 数量必须与 preview.conflicts 一致，否则抛错；
// 选择只作用于冲突段，不覆盖自动合并内容，不向正文写入冲突标记。
```

底层工具也可单独使用：`splitLines` / `joinLines`（分行与拼接）、
`diffLines`（一侧相对祖先的行级差异）。

## 合并规则

- 按 LF 分行，LF 属于前一行；末行允许无 LF；空文本为零行，末尾 LF 不产生
  额外空行。完整行逐字节相同才可保留，不规范化空白或换行，结果按各段原样拼接。
- 每侧差异以删行与插行总数最少为准；并列时操作序列按 保留 < 删除 < 插入
  取字典序最小。连续删除和插入合为一个改动，保留行隔开改动；纯插入定位在
  祖先的行间位置。
- 两侧非空改动区间有交集才互相影响（首尾相接不算）；纯插入严格落在另一侧
  非空区间内部才互相影响（恰在起点或终点不算）；两侧同一位置的纯插入互相
  影响。起点插入排在替换文本前，终点插入排在后。
- 互相影响的改动按传递关系归为同一冲突区域，范围是这些改动在祖先中的最小
  覆盖区间；两侧各自只应用归入该区域的本侧改动并保留其余祖先行，得到两份
  区域文本，相同则只保留一份，不同才产生冲突。互不影响的改动全部保留。

## 实现说明

- `src/lines.ts`：分行与拼接。
- `src/diff.ts`：LCS 动态规划求最小编辑脚本，回溯时按 保留 < 删除 < 插入
  的优先级取字典序最小解，再把连续删/插合并为改动。时间复杂度 O(n·m)，
  n、m 为两侧行数。
- `src/merge.ts`：并查集把互相影响的改动按传递关系归并为区域，逐区域生成
  两侧文本，拼装预览并按选择产出最终文本。
