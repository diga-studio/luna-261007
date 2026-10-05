/** 版本区间边界：缺省表示该方向无界。 */
export interface VersionBound {
  /** 三段十进制版本，如 "1.2.0"，每段 0-65535。 */
  version: string;
  /** 是否包含边界本身。 */
  inclusive: boolean;
}

/** 闭区间化之前的版本区间（上下界均可缺省）。 */
export interface VersionRange {
  lower?: VersionBound;
  upper?: VersionBound;
}

/** CVE 的一个适用项。 */
export interface ApplicabilityItem {
  vendor: string;
  product: string;
  range: VersionRange;
  /** 排除区间，仅作用于本适用项。 */
  exclusions?: VersionRange[];
}

/** 漏洞库中的一条 CVE。 */
export interface CveEntry {
  id: string;
  items: ApplicabilityItem[];
}

/** 漏洞库 JSON 文件格式。 */
export interface VulnerabilityDatabaseFile {
  cves: CveEntry[];
}

/** 一条软件安装记录。 */
export interface InstallRecord {
  id: string;
  vendor: string;
  product: string;
  version: string;
}

/** 软件清单 JSON 文件格式。 */
export interface InventoryFile {
  records: InstallRecord[];
}

/** 一条命中关系：安装记录 id 命中 CVE 编号。 */
export interface MatchRelation {
  recordId: string;
  cveId: string;
}
