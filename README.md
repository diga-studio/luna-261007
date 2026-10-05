# docx-intake-validator

DOCX 入库验真库（TypeScript，零运行时依赖）。由文档上传模块直接以函数方式调用，无接口层。

## 用法

```ts
import { validateDocx } from "docx-intake-validator";

const result = await validateDocx("/path/to/uploaded-file");
if (result.ok) {
  // 可以入库
} else {
  console.warn(result.code, result.message);
}
```

- 输入为本地文件路径；文件名与扩展名不参与判定。
- 返回 `ValidationResult`：`{ ok: true }` 或 `{ ok: false, code, message }`。
- 验证全程在内存中进行：不产生解压临时文件，不修改输入文件。

## 判定规则摘要

- **容器**：仅普通 ZIP（Stored/Deflate，可带数据描述符）；拒绝 ZIP64、加密、分卷、前置数据、拼接归档、未列入中央目录的本地条目；本地头 / 中央目录 / 数据描述符三者必须一致；逐条目校验实际解压长度与 CRC；条目范围不得重叠，EOCD 后仅允许其声明的注释。
- **路径**：大小写敏感，`/` 为唯一分隔符；禁止绝对路径、反斜线、空段、`.` / `..` 段；显式目录去尾斜线后不得与任何条目重名。
- **OPC**：必须含 `[Content_Types].xml` 与 `_rels/.rels`；根关系中恰有一个非外部的 `officeDocument` 关系且指向包内现存部件（主部件位置不写死）；Target 支持包内绝对 / 相对路径，百分号按 UTF-8 解码一次后解析点段，不得越出包根。
- **内容类型**：Override 优先于 Default；主部件必须是普通 DOCX 正文类型（拒绝宏、模板及其他 Office 类型）。
- **XML**：上述固定部件与主部件必须是有效 XML，按命名空间识别；主部件根元素必须是 WordprocessingML 的 `document`；拒绝 DTD 与外部实体，仅接受 UTF-8。

## 开发

```sh
npm install
npm test        # 构建并运行全部测试
npm run build   # 仅构建到 dist/
```

测试不依赖任何外部服务，fixture 由 `test/helpers/zip.ts` 按字节构造，
覆盖合法变体（主部件换目录、Stored、数据描述符、UTF-8 名称等）与伪装攻击
（中央目录与本地头矛盾、重叠条目、拼接归档、路径逃逸、DTD 注入等）。
