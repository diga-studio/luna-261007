import { createHash } from "node:crypto";
import type { FileTree, MutableFileTree } from "./types.js";

/** 规范化为绝对路径（POSIX 语义，解析 . 与 ..，保证以 / 开头） */
export function normalizePath(p: string): string {
  if (p.length === 0) throw new Error("empty path");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

export function hashBytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 树的确定性内容哈希：路径集合 + 每个文件字节 */
export function hashTree(tree: FileTree): string {
  const hash = createHash("sha256");
  const paths = [...tree.keys()].sort();
  for (const p of paths) {
    const bytes = tree.get(p)!;
    hash.update(p, "utf8");
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function cloneTree(tree: FileTree): MutableFileTree {
  return new Map(tree);
}

/** 返回 tree 中位于 dir 下的子树，键为相对 dir 的路径 */
export function subtree(tree: FileTree, dir: string): Map<string, Uint8Array> {
  const prefix = dir === "/" ? "/" : dir + "/";
  const out = new Map<string, Uint8Array>();
  for (const [p, bytes] of tree) {
    if (p.startsWith(prefix)) {
      out.set(p.slice(prefix.length), bytes);
    }
  }
  return out;
}
