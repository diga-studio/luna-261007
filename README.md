# task26100768

限时考核提交与本地证书签发组件（TypeScript）。

- 账本持久化：SQLite（Node.js 内置 `node:sqlite`，无原生依赖）
- 证书：真实 JSON 文件，原子写入（临时文件 + fsync + rename）
- 故障注入：`ExamServiceOptions.hooks`（`afterBeginPersist` / `afterSubmitPersist` / `afterCertificateWrite`）

```bash
npm install
npm test
```

要求 Node.js >= 22.5（内置 `node:sqlite`）。API 见 `src/index.ts`：
`begin` / `submit` / `result` / `recover`。
