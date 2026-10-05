/** package-lock.json (lockfileVersion 3) 中的单个 packages 条目。 */
export interface LockEntry {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
}

/** package-lock.json 的顶层结构（仅保留本库关心的字段）。 */
export interface PackageLock {
  name?: string;
  version?: string;
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
}

/** 一个已解析的安装实例（组件与之一一对应）。 */
export interface ResolvedInstance {
  /** 规范化后的安装路径（link 指向其目标路径），作为实例身份。 */
  path: string;
  /** 组件真实名称（条目 name，缺省时取完整安装名）。 */
  name: string;
  /** 组件版本（条目 version，可能缺失）。 */
  version?: string;
  /** 运行时可达的依赖实例（按安装路径引用）。 */
  dependencies: ResolvedInstance[];
}

/** 解析结果：根实例 + 全部可达实例（按路径索引）。 */
export interface InstanceGraph {
  root: ResolvedInstance;
  instances: Map<string, ResolvedInstance>;
}

/** CycloneDX 1.5 组件。 */
export interface CdxComponent {
  "bom-ref": string;
  type: "library" | "application";
  name: string;
  version?: string;
}

/** CycloneDX 1.5 依赖关系条目。 */
export interface CdxDependency {
  ref: string;
  dependsOn: string[];
}

/** CycloneDX 1.5 BOM。 */
export interface CdxBom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: number;
  metadata: {
    component: CdxComponent;
  };
  components: CdxComponent[];
  dependencies: CdxDependency[];
}
