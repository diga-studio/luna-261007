import { createHash } from 'node:crypto';
import type { FileTree, RunOutput } from './types.js';

/** 规范化为绝对路径：保证以 / 开头，解析 . 与 ..，折叠重复斜杠。 */
export function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return '/' + segments.join('/');
}

/** 对字节计算内容哈希。 */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 对整棵树计算确定性清单哈希（路径集合 + 每个文件字节）。 */
export function hashTree(tree: FileTree): string {
  const hash = createHash('sha256');
  const paths = [...tree.keys()].sort();
  for (const path of paths) {
    hash.update(path);
    hash.update(new Uint8Array([0]));
    hash.update(tree.get(path)!);
    hash.update(new Uint8Array([0]));
  }
  return hash.digest('hex');
}

function joinPath(dir: string, rel: string): string {
  return dir === '/' ? '/' + rel : dir + '/' + rel;
}

/**
 * 把 src 树中 source 处的文件或目录子树复制到 dest 树中 destPath 处。
 * 文件复制到给定目标路径；目录按相对路径复制到目标目录。
 * 覆盖同名文件，保留其他文件。返回新树。
 */
export function copyInto(
  dest: FileTree,
  src: FileTree,
  source: string,
  destPath: string,
): Map<string, Uint8Array> {
  const from = normalizePath(source);
  const to = normalizePath(destPath);
  const result = new Map(dest);

  const file = src.get(from);
  if (file !== undefined) {
    result.set(to, file);
    return result;
  }

  const prefix = from === '/' ? '/' : from + '/';
  let matched = false;
  for (const [path, bytes] of src) {
    if (path.startsWith(prefix)) {
      result.set(joinPath(to, path.slice(prefix.length)), bytes);
      matched = true;
    }
  }
  if (!matched) {
    throw new Error(`COPY source not found: ${from}`);
  }
  return result;
}

/** 应用 run 输出（先删除后写入），返回新树。 */
export function applyRunOutput(tree: FileTree, output: RunOutput): Map<string, Uint8Array> {
  const result = new Map(tree);
  for (const raw of output.deletes ?? []) {
    const path = normalizePath(raw);
    result.delete(path);
    const prefix = path === '/' ? '/' : path + '/';
    for (const key of [...result.keys()]) {
      if (key.startsWith(prefix)) result.delete(key);
    }
  }
  for (const [raw, bytes] of output.writes ?? []) {
    result.set(normalizePath(raw), bytes);
  }
  return result;
}
