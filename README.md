# stl-stream-analyzer

TypeScript 实现的 STL 流式元数据分析库。以任意大小的 chunk 喂入字节流，
在 EOF 处一次性产出元数据；工作内存与输入大小无关（固定约数百字节）。

## 用法

```ts
import { StlAnalyzer } from 'stl-stream-analyzer';

const analyzer = new StlAnalyzer();
for await (const chunk of stream) {
  analyzer.push(chunk); // 返回后可立即复用 chunk 内存
}
const meta = analyzer.finish(); // EOF：完整验证通过才返回，否则抛错
```

`finish()` 返回：

```ts
interface StlMetadata {
  format: 'binary' | 'ascii';
  triangleCount: number;
  sha256: string;              // 原始字节流的 SHA-256（hex）
  boundingBox: BoundingBox | null; // 英寸；零三角形时为 null
  dimensions: Vec3 | null;         // 三轴尺寸（英寸）；零三角形时为 null
}
```

顶点按毫米解释，25.4 mm = 1 英寸；包围盒只统计顶点，不含法线。
错误时抛出 `StlFormatError`（两种格式均无效）或 `StlSizeError`
（超过 500 MiB），绝不返回部分元数据。

## 格式判定

二进制与 ASCII 解析器并行、完整地消费同一份字节流，不按文件前缀猜格式
（二进制头部即使以 `solid` 开头也能正确处理）。两者均完整有效时优先二进制，
否则选择唯一有效者，都无效则报格式错误。

- 二进制：80 字节任意头部 + 4 字节 LE 三角形数 + N 条 50 字节记录；
  12 个 Float32 分量必须有限；缺失记录或尾随字节均无效。
- ASCII：一个或多个 solid 块；`solid`/`endsolid` 独占一行，可带任意长度的
  合法 UTF-8 名称（增量校验，不缓存）；facet 结构严格有序；几何 token 由
  空格/制表符/CR/LF 分隔且最长 64 字节；数字为十进制（可带符号、小数、指数）
  且必须有限；支持 LF 与 CRLF，最后一条 `endsolid` 可在 EOF 结束。

## 约束

- 单文件最大 500 MiB；chunk 可小至 1 字节，也可包含整份文件。
- 不缓存完整文件、名称或文本行；除调用方当前 chunk 与固定运行时开销外，
  分析器工作内存远低于 1 MiB。
- 不回读输入、不写临时文件、不把输入整体转为字符串。

## 开发

```sh
npm install
npm test   # tsc 构建 + node --test（含内存有界性测试）
```

测试对同一批有效/无效文件分别用整块、单字节、固定种子随机切块处理并核对
结果一致性；内存测试用惰性生成的 ≥64 MiB 名称与百万级三角形验证堆增长上界。
