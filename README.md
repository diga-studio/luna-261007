# firmware-elf-validator

固件接收前的 ELF 内存映射校验库（TypeScript，零运行时依赖）。

仅处理小端 ELF32、`ET_EXEC`、`EM_ARM`、版本 1（ELF 头 52 字节，program header
项 32 字节）。只使用 `PT_LOAD`，section 表不参与判定，非 `PT_LOAD` 的载荷不读取。

## 使用

```ts
import { analyzeFirmware, readFlash } from "./src/analyze.js";

const result = analyzeFirmware(bytes, {
  flashSize: 0x10000,
  flashAliases: [0x08000000, 0x10000000], // 每个别名都是等长窗口，映射同一物理 flash
  ramBase: 0x20000000,
  ramSize: 0x10000,
  flashBudget: 0x8000,
  ramBudget: 0x4000,
});

if (result.ok) {
  console.log(result.flashUsed, result.ramUsed);
  const page = readFlash(result.image, 0x100, 0x40); // 未覆盖处为 0xFF
} else {
  console.error(result.error);
}
```

- `analyzeFirmware(bytes, target)`：结构错误、映射冲突、越界或预算超限时返回
  `{ ok: false, error }`，不返回部分可用结果。
- `readFlash(image, offset, length)`：按物理 flash 偏移读取，单次不超过 64 KiB，
  参数非法时抛 `RangeError`。

## 设计要点

- 所有地址按数学整数（半开区间，末端允许等于 2^32）计算，不发生 32 位回绕。
- flash 与 RAM 的已覆盖区域用有序不交叉区间表表示，重叠部分逐字节比对
  （flash 对文件字节，RAM 对“文件字节 / 零填充”两种来源），相同则共享、
  不同则拒绝；判定与段表顺序无关。
- `flashUsed` / `ramUsed` 为区间并集长度，空洞不计；不展开整个 flash、RAM
  或 BSS 零尾，内存占用与声明容量无关。
- 核心解析手工完成（`DataView`），不依赖外部命令或现成 ELF 库。

## 构建与测试

```sh
npm install
npm test   # tsc 编译后运行 node:test 测试
```

测试用 ELF 字节由 `test/elfBuilder.ts` 手工构造，覆盖别名重叠、段序无关性、
RAM/BSS 重叠、窗口贴边/跨界/回绕、段表与载荷截断等场景。
