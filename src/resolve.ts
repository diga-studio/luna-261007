import { LockPackageEntry, PackageInstance, PackageLock } from "./types";

/** 取路径的上一级目录，根返回 ""。 */
function parentDir(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

/** 从安装路径推导安装名（最后一个 node_modules 之后的部分，保留作用域）。 */
function installNameFromPath(path: string): string {
  const marker = "/node_modules/";
  const idx = path.lastIndexOf(marker);
  if (idx !== -1) return path.slice(idx + marker.length);
  if (path.startsWith("node_modules/")) return path.slice("node_modules/".length);
  const idx2 = path.lastIndexOf("/");
  return idx2 === -1 ? path : path.slice(idx2 + 1);
}

/** 解析 link 条目的目标路径（目标保证存在且不是 link）。 */
function resolveLinkTarget(lock: PackageLock, linkPath: string, resolved: string): string {
  const norm = resolved.replace(/^\.\//, "").replace(/\/+$/, "");
  if (lock.packages[norm]) return norm;
  // 兼容相对路径写法：相对于 link 所在目录解析。
  let dir = parentDir(linkPath);
  for (const seg of norm.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") dir = parentDir(dir);
    else dir = dir === "" ? seg : dir + "/" + seg;
  }
  if (lock.packages[dir]) return dir;
  throw new Error(`link "${linkPath}" 的目标 "${resolved}" 在 packages 中不存在`);
}

/** 计算声明者可见的依赖目标路径（就近安装可见性）。 */
function findVisible(lock: PackageLock, declarerDir: string, name: string): string | undefined {
  let dir = declarerDir;
  for (;;) {
    const candidate = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (dir === "") return undefined;
    dir = parentDir(dir);
  }
}

/** 汇总运行时依赖声明：dependencies + optionalDependencies（覆盖）+ peerDependencies。 */
function runtimeDeclarations(entry: LockPackageEntry): Map<string, { optional: boolean }> {
  const result = new Map<string, { optional: boolean }>();
  const deps = entry.dependencies ?? {};
  const optDeps = entry.optionalDependencies ?? {};
  const peerDeps = entry.peerDependencies ?? {};
  const peerMeta = entry.peerDependenciesMeta ?? {};
  for (const name of Object.keys(deps)) {
    if (!(name in optDeps)) result.set(name, { optional: false });
  }
  for (const name of Object.keys(optDeps)) {
    result.set(name, { optional: true });
  }
  for (const name of Object.keys(peerDeps)) {
    if (!result.has(name)) {
      result.set(name, { optional: peerMeta[name]?.optional === true });
    }
  }
  return result;
}

/**
 * 从锁文件根出发，解析运行时可达的安装实例图。
 * 返回的数组第一个元素是根实例；闭环通过共享对象保留。
 * 必需的依赖找不到可见实例时抛出错误。
 */
export function resolveInstances(lock: PackageLock): PackageInstance[] {
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object" || lock.packages === null) {
    throw new Error("仅支持 lockfileVersion 为 3 且含 packages 的锁文件");
  }
  const rootEntry = lock.packages[""];
  if (!rootEntry) {
    throw new Error('锁文件缺少根条目（packages[""]）');
  }

  // link 路径 -> 目标路径 的缓存。
  const linkTargets = new Map<string, string>();
  const canonicalPath = (path: string): string => {
    const cached = linkTargets.get(path);
    if (cached !== undefined) return cached;
    const entry = lock.packages[path];
    let target = path;
    if (entry && entry.link === true) {
      if (typeof entry.resolved !== "string") {
        throw new Error(`link 条目 "${path}" 缺少 resolved`);
      }
      target = resolveLinkTarget(lock, path, entry.resolved);
    }
    linkTargets.set(path, target);
    return target;
  };

  const instances: PackageInstance[] = [];
  const byPath = new Map<string, PackageInstance>();

  const build = (path: string): PackageInstance => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const entry = lock.packages[path];
    if (!entry) {
      throw new Error(`packages 中不存在条目 "${path}"`);
    }
    const instance: PackageInstance = {
      id: path,
      name: entry.name ?? installNameFromPath(path),
      version: entry.version ?? "",
      dependencies: [],
    };
    byPath.set(path, instance);
    instances.push(instance);

    // 目标自身的依赖按其真实目录解释。
    const declarerDir = path;
    for (const [name, { optional }] of runtimeDeclarations(entry)) {
      const visible = findVisible(lock, declarerDir, name);
      if (visible === undefined) {
        if (optional) continue;
        throw new Error(`"${path || "."}" 声明的依赖 "${name}" 找不到可见的安装实例`);
      }
      instance.dependencies.push(build(canonicalPath(visible)));
    }
    return instance;
  };

  build("");
  return instances;
}
