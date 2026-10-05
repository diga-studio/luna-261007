import { readFile } from "node:fs/promises";
import { validateOoxmlPackage } from "./ooxml/package.ts";
import { PathError, validateEntryPaths } from "./paths.ts";
import { fail, type ValidationResult } from "./types.ts";
import { readZipArchive, ZipError } from "./zip/reader.ts";

/**
 * 校验本地文件是否为可入库的 DOCX（OOXML Transitional，普通 ZIP）。
 * 只读取输入文件，不做任何写操作，不产生解压残留。
 */
export async function validateDocxFile(
  filePath: string,
): Promise<ValidationResult> {
  let buf: Uint8Array;
  try {
    buf = await readFile(filePath);
  } catch (err) {
    return fail(
      "IO_ERROR",
      `无法读取文件: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let archive;
  try {
    archive = readZipArchive(buf);
  } catch (err) {
    if (err instanceof ZipError) {
      return fail(err.code, err.message);
    }
    throw err;
  }

  try {
    validateEntryPaths(archive.entries.map((e) => e.name));
  } catch (err) {
    if (err instanceof PathError) {
      return fail(err.code, err.message);
    }
    throw err;
  }

  return validateOoxmlPackage(archive);
}
