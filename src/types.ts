/** package-lock.json (lockfileVersion 3) 中与还原相关的条目结构。 */
export interface LockPackageEntry {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export interface PackageLock {
  name?: string;
  version?: string;
  lockfileVersion: number;
  packages: Record<string, LockPackageEntry>;
}

/** 一个解析出的安装实例（node_modules 中的实际目录）。 */
export interface PackageInstance {
  /** 安装路径，即 packages 中的键（link 解析后为目标路径）。 */
  id: string;
  /** 组件真实名称（目标条目 name，缺省取完整安装名）。 */
  name: string;
  version: string;
  /** 直接依赖的实例。 */
  dependencies: PackageInstance[];
}

/** CycloneDX 1.5 JSON 的最小相关子集。 */
export interface CycloneDxComponent {
  type: "library" | "application";
  "bom-ref": string;
  name: string;
  version: string;
}

export interface CycloneDxDependency {
  ref: string;
  dependsOn: string[];
}

export interface CycloneDxBom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: 1;
  metadata: { component: CycloneDxComponent };
  components: CycloneDxComponent[];
  dependencies: CycloneDxDependency[];
}
