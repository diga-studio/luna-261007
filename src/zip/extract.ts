import { inflateRawSync } from "node:zlib";
import { crc32 } from "./crc32.js";
import { ZipError, type ZipEntry } from "./reader.js";

export function extractEntry(archiveData: Buffer, entry: ZipEntry): Buffer {
  const compressed = archiveData.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  let plain: Buffer;
  if (entry.compressionMethod === 0) {
    plain = Buffer.from(compressed);
  } else {
    try {
      plain = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
    } catch {
      throw new ZipError("ZIP_ENTRY_CORRUPT", `cannot inflate entry ${entry.name}`);
    }
  }
  if (plain.length !== entry.uncompressedSize) {
    throw new ZipError(
      "ZIP_ENTRY_CORRUPT",
      `uncompressed size mismatch for entry ${entry.name}`,
    );
  }
  if (crc32(plain) !== entry.crc32) {
    throw new ZipError("ZIP_ENTRY_CORRUPT", `CRC mismatch for entry ${entry.name}`);
  }
  return plain;
}
