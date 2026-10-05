import { readFile } from "node:fs/promises";
import { reject, type ValidationResult } from "./result.js";
import { readZipArchive, ZipError } from "./zip/reader.js";
import { extractEntry } from "./zip/extract.js";
import { validateOpcPackage } from "./opc/package.js";

export type { ValidationResult, RejectCode } from "./result.js";

export async function validateDocx(filePath: string): Promise<ValidationResult> {
  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return reject("IO_ERROR", `cannot read input file: ${detail}`);
  }

  try {
    const archive = readZipArchive(data);
    const contents = new Map<string, Buffer>();
    for (const entry of archive.entries) {
      contents.set(entry.name, extractEntry(data, entry));
    }
    return validateOpcPackage(archive, (name) => contents.get(name)!);
  } catch (err) {
    if (err instanceof ZipError) {
      return reject(err.code, err.message);
    }
    throw err;
  }
}
