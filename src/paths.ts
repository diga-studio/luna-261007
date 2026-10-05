import type { PathSegment } from "./types.js";

/**
 * 解析字段路径（如 "a.b.*.c"）为段序列。
 * 规则：段非空；首段必须是属性（记录本身是对象）；
 * "*" 表示数组通配层，最多出现一次；非法路径返回 null。
 */
export function parsePath(path: string): PathSegment[] | null {
  if (typeof path !== "string" || path.length === 0) return null;
  const parts = path.split(".");
  const segments: PathSegment[] = [];
  let arrayCount = 0;
  for (const part of parts) {
    if (part === "*") {
      arrayCount += 1;
      if (arrayCount > 1 || segments.length === 0) return null;
      segments.push({ kind: "array" });
    } else {
      if (part.length === 0) return null;
      segments.push({ kind: "prop", name: part });
    }
  }
  return segments;
}

/** 将段序列格式化为路径字符串（用于错误信息）。 */
export function formatPath(segments: PathSegment[]): string {
  return segments
    .map((seg) => (seg.kind === "array" ? "*" : seg.name))
    .join(".");
}
