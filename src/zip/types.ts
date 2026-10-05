/** 一个通过全部结构校验的 ZIP 条目。 */
export interface ZipEntry {
  /** 原始名称字节按声明编码解码后的路径（未做规范化）。 */
  name: string;
  /** 是否为显式目录（名称以 "/" 结尾）。 */
  isDirectory: boolean;
  /** 解压后的内容；目录条目为空数组。 */
  data: Uint8Array;
}

export interface ZipArchive {
  entries: ZipEntry[];
}
