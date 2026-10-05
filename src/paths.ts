export class PathError extends Error {
  readonly code: "ZIP_PATH_INVALID" | "ZIP_DUPLICATE_PATH";

  constructor(code: PathError["code"], message: string) {
    super(message);
    this.name = "PathError";
    this.code = code;
  }
}

function fail(code: PathError["code"], message: string): never {
  throw new PathError(code, message);
}

/**
 * 校验 ZIP 条目路径集合。
 * 规则：大小写敏感；"/" 为唯一分隔符；禁止绝对路径、反斜线、空路径段、
 * "." 与 ".." 段；显式目录以 "/" 结尾；去掉结尾斜线后不得重名
 * （含文件与目录同名）。
 */
export function validateEntryPaths(names: string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (name.length === 0) {
      fail("ZIP_PATH_INVALID", "条目路径为空");
    }
    if (name.includes("\\")) {
      fail("ZIP_PATH_INVALID", `条目路径含反斜线: ${name}`);
    }
    if (name.startsWith("/")) {
      fail("ZIP_PATH_INVALID", `条目路径为绝对路径: ${name}`);
    }
    const isDir = name.endsWith("/");
    const body = isDir ? name.slice(0, -1) : name;
    const segments = body.split("/");
    for (const seg of segments) {
      if (seg.length === 0) {
        fail("ZIP_PATH_INVALID", `条目路径含空路径段: ${name}`);
      }
      if (seg === "." || seg === "..") {
        fail("ZIP_PATH_INVALID", `条目路径含 "." 或 ".." 段: ${name}`);
      }
    }
    if (seen.has(body)) {
      fail("ZIP_DUPLICATE_PATH", `条目路径重名（含文件与目录同名）: ${body}`);
    }
    seen.add(body);
  }
}
