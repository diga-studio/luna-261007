import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { QuarantineExecutor } from "../src/index.js";

interface Fixture {
  dir: string;
  originalRoot: string;
  quarantineRoot: string;
  executor: QuarantineExecutor;
}

function setup(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-"));
  const originalRoot = path.join(dir, "original");
  const quarantineRoot = path.join(dir, "quarantine");
  fs.mkdirSync(originalRoot, { recursive: true });
  const executor = new QuarantineExecutor({
    originalRoot,
    quarantineRoot,
    dbPath: path.join(dir, "meta.sqlite"),
  });
  return { dir, originalRoot, quarantineRoot, executor };
}

function teardown(f: Fixture): void {
  f.executor.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function writeOriginal(f: Fixture, rel: string, content: Buffer): void {
  const p = path.join(f.originalRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test("正常隔离和恢复：逐字节一致，恢复后重放旧隔离命令不会再次移走文件", () => {
  const f = setup();
  try {
    const content = randomBytes(4096);
    writeOriginal(f, "sub/dir/file.bin", content);
    const digest = sha256(content);
    const srcPath = path.join(f.originalRoot, "sub/dir/file.bin");

    const q = f.executor.quarantine("cmd-q-1", "sub/dir/file.bin", digest);
    assert.deepEqual(q, { status: "ok", quarantineId: "cmd-q-1" });
    assert.equal(fs.existsSync(srcPath), false, "隔离后原路径必须为空");
    assert.equal(
      fs.readFileSync(path.join(f.quarantineRoot, "cmd-q-1.quar")).equals(content),
      true,
      "隔离区内容逐字节一致"
    );

    const r = f.executor.restore("cmd-r-1", "cmd-q-1");
    assert.deepEqual(r, { status: "ok" });
    assert.equal(fs.readFileSync(srcPath).equals(content), true, "恢复内容逐字节一致");
    assert.equal(fs.readdirSync(f.quarantineRoot).length, 0, "恢复后隔离区无残留");

    // 重放旧隔离命令：返回首次结果，但不得再次移走文件
    const q2 = f.executor.quarantine("cmd-q-1", "sub/dir/file.bin", digest);
    assert.deepEqual(q2, { status: "ok", quarantineId: "cmd-q-1" });
    assert.equal(fs.existsSync(srcPath), true, "重放隔离命令不得再次移走文件");
    assert.equal(fs.readFileSync(srcPath).equals(content), true);
  } finally {
    teardown(f);
  }
});

test("隔离后原路径被同字节文件占用：恢复冲突并保留隔离内容，重试结果不变", () => {
  const f = setup();
  try {
    const content = randomBytes(2048);
    writeOriginal(f, "a.txt", content);
    const digest = sha256(content);
    const srcPath = path.join(f.originalRoot, "a.txt");

    assert.deepEqual(f.executor.quarantine("cmd-q-2", "a.txt", digest), {
      status: "ok",
      quarantineId: "cmd-q-2",
    });

    // 原路径创建字节完全相同的新文件
    fs.writeFileSync(srcPath, content);

    const r1 = f.executor.restore("cmd-r-2", "cmd-q-2");
    assert.deepEqual(r1, { status: "conflict" }, "同字节占用也必须冲突");
    assert.equal(
      fs.existsSync(path.join(f.quarantineRoot, "cmd-q-2.quar")),
      true,
      "冲突后隔离内容必须保留"
    );

    // 路径变化（删掉占用文件）后重试同一恢复命令：仍返回首次确定的冲突结果
    fs.unlinkSync(srcPath);
    const r2 = f.executor.restore("cmd-r-2", "cmd-q-2");
    assert.deepEqual(r2, { status: "conflict" }, "冲突结果不可因路径变化而改变");
    assert.equal(fs.existsSync(srcPath), false, "重试不得执行恢复");
    assert.equal(
      fs.existsSync(path.join(f.quarantineRoot, "cmd-q-2.quar")),
      true,
      "重试后隔离内容仍保留"
    );

    // 用新命令恢复：成功
    const r3 = f.executor.restore("cmd-r-3", "cmd-q-2");
    assert.deepEqual(r3, { status: "ok" });
    assert.equal(fs.readFileSync(srcPath).equals(content), true);
    assert.equal(fs.readdirSync(f.quarantineRoot).length, 0);
  } finally {
    teardown(f);
  }
});

test("摘要不符：不改变原文件", () => {
  const f = setup();
  try {
    const content = randomBytes(1024);
    writeOriginal(f, "b.txt", content);
    const srcPath = path.join(f.originalRoot, "b.txt");

    const q = f.executor.quarantine("cmd-q-3", "b.txt", sha256(randomBytes(16)));
    assert.deepEqual(q, { status: "hash_mismatch" });
    assert.equal(fs.readFileSync(srcPath).equals(content), true, "原文件不得改变");
    assert.equal(fs.readdirSync(f.quarantineRoot).length, 0, "隔离区不得有内容");

    // 重试同一命令：仍是 hash_mismatch，文件不动
    const q2 = f.executor.quarantine("cmd-q-3", "b.txt", sha256(randomBytes(16)));
    assert.deepEqual(q2, { status: "hash_mismatch" });
    assert.equal(fs.readFileSync(srcPath).equals(content), true);
  } finally {
    teardown(f);
  }
});

test("文件不存在返回 not_found，且结果可幂等重放", () => {
  const f = setup();
  try {
    const q = f.executor.quarantine("cmd-q-4", "missing.txt", sha256(Buffer.from("x")));
    assert.deepEqual(q, { status: "not_found" });
    const q2 = f.executor.quarantine("cmd-q-4", "missing.txt", sha256(Buffer.from("x")));
    assert.deepEqual(q2, { status: "not_found" });

    const r = f.executor.restore("cmd-r-4", "no-such-quarantine");
    assert.deepEqual(r, { status: "not_found" });
  } finally {
    teardown(f);
  }
});

test("隔离命令重试幂等：相同 commandId 返回首次结果且不重复操作", () => {
  const f = setup();
  try {
    const content = randomBytes(512);
    writeOriginal(f, "c.txt", content);
    const digest = sha256(content);

    assert.deepEqual(f.executor.quarantine("cmd-q-5", "c.txt", digest), {
      status: "ok",
      quarantineId: "cmd-q-5",
    });
    // 重试：文件已不在原路径，但仍返回首次的 ok，且不报错
    const q2 = f.executor.quarantine("cmd-q-5", "c.txt", digest);
    assert.deepEqual(q2, { status: "ok", quarantineId: "cmd-q-5" });
    assert.equal(
      fs.existsSync(path.join(f.quarantineRoot, "cmd-q-5.quar")),
      true,
      "隔离内容仍在隔离区"
    );
  } finally {
    teardown(f);
  }
});
