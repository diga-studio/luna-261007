/** 闭/开区间边界：version 为 "major.minor.patch"，inclusive 表示是否包含该边界。 */
export interface VersionBound {
  version: string;
  inclusive: boolean;
}

/** 版本区间，上下界均可缺省（缺省表示无界）。 */
export interface VersionRange {
  lower?: VersionBound;
  upper?: VersionBound;
}

/** 一条 CVE 适用项：厂商 + 产品 + 适用区间 + 若干排除区间。 */
export interface ApplicableItem {
  vendor: string;
  product: string;
  range: VersionRange;
  exclusions?: VersionRange[];
}

/** 漏洞库中的一条 CVE。 */
export interface CveEntry {
  cveId: string;
  items: ApplicableItem[];
}

/** 漏洞库 JSON 文件的顶层结构。 */
export interface VulnerabilityDbFile {
  cves: CveEntry[];
}

/** 一条软件安装记录。 */
export interface InstallationRecord {
  id: string;
  vendor: string;
  product: string;
  version: string;
}

/** 一条命中关系。 */
export interface MatchRelation {
  installationId: string;
  cveId: string;
}
