# firmware-elf-validator

固件接收前的 ELF 内存映射校验库（TypeScript）。仅处理小端 ELF32 / ET_EXEC / EM_ARM、
版本 1、ELF 头 52 字节、program header 项 32 字节；只装载 PT_LOAD，section 表不参与判定。

## API

```ts
import { analyzeFirmware, readFlash, FirmwareError } from "firmware-elf-validator";

const result = analyzeFirmware(bytes, {
  flashSize: 0x10000,
  flashAliases: [0x0800_0000, 0x1000_0000], // 每个别名都是等长窗口，映射同一物理 flash
  ramBase: 0x2000_0000,
  ramSize: 0x1000_0000,
  flashBudget: 0x10000,
  ramBudget: 0x1000_0000,
});
// result.flashUsed / result.ramUsed 为归一化后的占用（空洞不计）

const page = readFlash(result, 0x2000, 256); // 未覆盖位置为 0xFF，单次最多 64 KiB
```

- 结构错误、映射冲突、越界或预算超限时抛出 `FirmwareError`，不返回部分结果。
- flash 重叠载荷（含别名之间）仅当逐字节相同才合法；RAM 运行区重叠时初始化后的字节必须相同。
- 所有边界按数学整数计算，地址末端允许等于 2^32，不发生回绕。
- 内存占用与声明的 flash/RAM/BSS 容量无关，只随段数与文件大小增长。

## 构建与测试

```sh
npm install
npm test
```

测试中的 ELF 字节由 `test/elf.ts` 手工构造，不依赖工具链产物。
