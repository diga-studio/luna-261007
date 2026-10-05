import { readFileSync } from "node:fs";
import type { InstallRecord, InventoryFile } from "./types";

/** 从本地 JSON 文件加载一批软件安装记录。 */
export function loadInventoryFile(path: string): InstallRecord[] {
  const text = readFileSync(path, "utf8");
  const data = JSON.parse(text) as InventoryFile;
  if (!Array.isArray(data?.records)) {
    throw new Error("invalid inventory file: missing records array");
  }
  for (const record of data.records) {
    if (
      typeof record?.id !== "string" ||
      typeof record?.vendor !== "string" ||
      typeof record?.product !== "string" ||
      typeof record?.version !== "string"
    ) {
      throw new Error("invalid install record: missing id, vendor, product or version");
    }
  }
  return data.records;
}
