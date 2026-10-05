import { InstanceGraph, LockEntry, PackageLock, ResolvedInstance } from "./types";

/** 去掉路径末尾的 "/node_modules/<安装名>"，得到包含该条目的父目录。 */
function linkParentDir(path: string): string {
  const idx = path.lastIndexOf("node_modules/");
  if (idx < 0) return "";
  return path.slice(0, idx).replace(/\/$/, "");
}

/** 规范化相对路径（处理 "." 与 ".."），不使用任何平台路径分隔符。 */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** link 条目沿 resolved 解析到真实目标路径；非 link 条目返回自身。 */
function canonicalPath(packages: Record<string, LockEntry>, path: string): string {
  const entry = packages[path];
  if (entry && entry.link === true && typeof entry.resolved === "string") {
    const target = normalizePath(
      linkParentDir(path) === ""
        ? entry.resolved
        : `${linkParentDir(path)}/${entry.resolved}`,
    );
    const targetEntry = packages[target];
    if (!targetEntry) {
      throw new Error(`link "${path}" resolved to missing target "${target}"`);
    }
    if (targetEntry.link === true) {
      throw new Error(`link "${path}" resolved to another link "${target}"`);
    }
    return target;
  }
  return path;
}

/** 从安装路径推导完整安装名（保留作用域）。 */
function installName(path: string): string {
  const idx = path.lastIndexOf("node_modules/");
  if (idx >= 0) return path.slice(idx + "node_modules/".length);
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** 收集运行时依赖的安装名：dependencies + optionalDependencies + peerDependencies。 */
function runtimeDeps(entry: LockEntry): { names: string[]; optional: Set<string> } {
  const names = new Set<string>();
  const optional = new Set<string>();
  for (const key of Object.keys(entry.dependencies ?? {})) names.add(key);
  for (const key of Object.keys(entry.optionalDependencies ?? {})) {
    names.add(key);
    optional.add(key);
  }
  const peerMeta = entry.peerDependenciesMeta ?? {};
  for (const key of Object.keys(entry.peerDependencies ?? {})) {
    names.add(key);
    if (peerMeta[key]?.optional === true) optional.add(key);
  }
  return { names: [...names].sort(), optional };
}

/** 从声明者目录向上做就近查找，返回第一个可见的安装路径。 */
function findVisible(
  packages: Record<string, LockEntry>,
  fromDir: string,
  name: string,
): string | undefined {
  let dir: string | undefined = fromDir;
  while (dir !== undefined) {
    const candidate = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (packages[candidate] !== undefined) return candidate;
    if (dir === "") return undefined;
    const slash = dir.lastIndexOf("/");
    dir = slash >= 0 ? dir.slice(0, slash) : "";
  }
  return undefined;
}

/**
 * 从锁文件构建运行时可达的安装实例图。
 * 仅遍历 dependencies / optionalDependencies / peerDependencies。
 * 找不到非可选依赖的可见实例时抛错。
 */
export function resolveInstances(lock: PackageLock): InstanceGraph {
  if (lock.lockfileVersion !== 3) {
    throw new Error(`unsupported lockfileVersion: ${lock.lockfileVersion}`);
  }
  const packages = lock.packages;
  if (!packages || typeof packages !== "object") {
    throw new Error("lockfile has no packages section");
  }
  const rootEntry = packages[""];
  if (!rootEntry) {
    throw new Error('lockfile packages has no root entry ""');
  }

  const instances = new Map<string, ResolvedInstance>();

  const getInstance = (rawPath: string): ResolvedInstance => {
    const path = canonicalPath(packages, rawPath);
    const existing = instances.get(path);
    if (existing) return existing;

    const entry = packages[path];
    if (!entry) throw new Error(`missing package entry for "${path}"`);
    const fallbackName = path === "" ? lock.name ?? "root" : installName(path);
    const instance: ResolvedInstance = {
      path,
      name: entry.name ?? fallbackName,
      dependencies: [],
    };
    if (entry.version !== undefined) instance.version = entry.version;
    instances.set(path, instance);

    const { names, optional } = runtimeDeps(entry);
    const seen = new Set<string>();
    for (const name of names) {
      const visible = findVisible(packages, path, name);
      if (visible === undefined) {
        if (optional.has(name)) continue;
        throw new Error(
          `cannot resolve dependency "${name}" required by "${path === "" ? "(root)" : path}"`,
        );
      }
      const target = getInstance(visible);
      if (!seen.has(target.path)) {
        seen.add(target.path);
        instance.dependencies.push(target);
      }
    }
    return instance;
  };

  const root = getInstance("");
  return { root, instances };
}
