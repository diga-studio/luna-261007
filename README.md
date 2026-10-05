# docx-intake-validator

DOCX 入库验真库（TypeScript）。由文档上传模块直接调用，无接口层。
接收本地文件路径，判断该文件能否作为 DOCX 入库；文件名与扩展名不参与判定。
只读输入文件，不在磁盘留下任何解压残留。

## 使用

```ts
import { validateDocxFile } from "./src/index.ts";

const result = await validateDocxFile("/path/to/upload.bin");
if (result.ok) {
  // result.mainPart 为主部件包内路径，例如 "word/document.xml"
} else {
  // result.code 为拒收原因码，result.message 为可读说明
}
```

## 校验范围

- ZIP：普通 ZIP（Stored / Deflate，可带或不带签名的数据描述符）；
  本地头、中央目录、数据描述符三者一致（含流式写入本地头暂填零的合法情况）；
  逐条目校验实际解压长度与 CRC；条目范围不得重叠，拒绝前置数据、拼接归档、
  未列入中央目录的本地条目；EOCD 后仅允许其声明的注释。
  拒绝 ZIP64、加密、分卷；名称仅允许 ASCII 或正确声明的 UTF-8。
- 路径：大小写敏感，仅 `/` 分隔；禁止绝对路径、反斜线、空段、`.`、`..`；
  显式目录去尾斜线后不得重名（含文件与目录同名）。
- OOXML/OPC：必须存在 `[Content_Types].xml` 与 `_rels/.rels`；
  根关系恰有一个非外部的 officeDocument 关系且指向包内现存部件（位置不写死）；
  Target 支持包内绝对/相对路径，百分号转义按 UTF-8 解码一次后解析点段，
  不得越出包根；内容类型按 Override 优先于 Default 确定；
  主部件必须是普通 DOCX 正文类型，根元素必须是 WordprocessingML 的 `document`；
  固定部件与主部件必须是有效 XML（按命名空间识别），拒绝 DTD 与外部实体。

## 构建与测试

```sh
npm install
npm run build   # tsc --noEmit
npm test        # vitest run
```

仅依赖 Node.js 与 devDependencies（typescript、vitest），无运行时依赖。
