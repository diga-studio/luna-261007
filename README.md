# task26100787

BranchForge 三方文本合并库（TypeScript）。仅处理单文件、纯内存合并：
输入共同祖先、当前分支、待合入分支的 UTF-8 文本，输出合并预览；
人工解决全部冲突后生成最终文本。

## 使用

```ts
import { mergePreview, resolveMerge } from "branchforge-merge";

const preview = mergePreview(ancestorText, currentText, incomingText);
// preview.segments: 按文档顺序排列的自动合并段与冲突段
// preview.conflicts: 全部冲突，各含 ancestor / current / incoming 三份区域文本

if (preview.conflicts.length === 0) {
  const text = resolveMerge(preview, []);
} else {
  const text = resolveMerge(preview, [
    { id: 0, choice: "current" },                 // 选当前分支
    { id: 1, choice: "incoming" },                // 选待合入分支
    { id: 2, choice: "replace", text: "..." },    // 或提供替换文本
  ]);
}
```

- 按 LF 分行，LF 属于前一行；末行允许无 LF；空文本为零行。
- 完整行逐字节比较，不做任何空白或换行规范化；结果按各段原样拼接。
- 每侧差异保证删行与插行总数最少，并列时按保留、删除、插入优先取
  字典序最小的操作序列。
- 互不影响的改动全部自动保留；互相影响的改动按传递关系归为一个冲突
  区域，两侧区域结果相同时只保留一份。
- 全部冲突解决后才有最终文本；解决只作用于冲突区域，不写入冲突标记。

## 构建与测试

```sh
npm install
npm test
```
