import { deflateRawSync } from "node:zlib";
import { crc32 } from "../../src/crc32.ts";

export interface EntrySpec {
  name: string;
  /** 文本或字节内容；目录条目可省略。 */
  data?: string | Uint8Array;
  method?: 0 | 8;
  /** 显式目录（名称自动补 "/"）。 */
  directory?: boolean;
  /** 使用数据描述符："sig" 带签名，"nosig" 不带签名。 */
  descriptor?: "sig" | "nosig";
  /** 名称按 UTF-8 编码并设置 UTF-8 标志；默认仅 ASCII。 */
  utf8?: boolean;
  /** 名称字节不使用 UTF-8 标志但仍写入原始字节（伪装用）。 */
  rawNameBytes?: Uint8Array;
  /** 覆盖本地头字段（伪装用）。 */
  local?: { crc?: number; compSize?: number; uncompSize?: number; flags?: number; method?: number };
  /** 覆盖中央目录字段（伪装用）。 */
  cd?: { crc?: number; compSize?: number; uncompSize?: number; flags?: number; method?: number; localHeaderOffset?: number };
  /** 附加到归档末尾、中央目录之前的额外本地条目（未列入 CD，伪装用）。 */
}

export interface BuiltZip {
  buf: Uint8Array;
  /** 每个条目的本地头偏移。 */
  localOffsets: number[];
  /** 每个条目的中央目录条目偏移。 */
  cdOffsets: number[];
  eocdOffset: number;
  cdOffset: number;
}

function u16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}

function u32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}

export function buildZip(
  entries: EntrySpec[],
  opts: {
    comment?: string;
    prefix?: Uint8Array;
    /** EOCD 注释之后追加的多余字节（伪装用）。 */
    suffix?: Uint8Array;
    /** 中央目录与 EOCD 之间插入的字节（伪装用）。 */
    betweenCdAndEocd?: Uint8Array;
    /** 追加到末尾（CD 之前）的未列入 CD 的本地条目。 */
    orphanLocal?: EntrySpec;
    eocdPatch?: (eocd: number[]) => void;
  } = {},
): BuiltZip {
  const out: number[] = [];
  if (opts.prefix) out.push(...opts.prefix);
  const localOffsets: number[] = [];
  const cdRecords: number[][] = [];
  const cdOffsets: number[] = [];

  const writeLocal = (spec: EntrySpec): { cd: number[] } => {
    const nameBytes = spec.rawNameBytes
      ?? new TextEncoder().encode(spec.directory ? spec.name.replace(/\/?$/, "/") : spec.name);
    const utf8Flag = spec.utf8 ? 0x0800 : 0;
    const raw = spec.data === undefined
      ? new Uint8Array(0)
      : typeof spec.data === "string"
        ? new TextEncoder().encode(spec.data)
        : spec.data;
    const method = spec.directory ? 0 : (spec.method ?? 8);
    const compressed = spec.directory
      ? new Uint8Array(0)
      : method === 8
        ? new Uint8Array(deflateRawSync(raw))
        : raw;
    const crc = crc32(spec.directory ? new Uint8Array(0) : raw);
    const uncompSize = spec.directory ? 0 : raw.length;
    const useDd = spec.descriptor !== undefined;
    let flags = utf8Flag | (useDd ? 0x0008 : 0);
    if (spec.local?.flags !== undefined) flags = spec.local.flags;
    const localCrc = spec.local?.crc ?? (useDd ? 0 : crc);
    const localComp = spec.local?.compSize ?? (useDd ? 0 : compressed.length);
    const localUncomp = spec.local?.uncompSize ?? (useDd ? 0 : uncompSize);
    const localMethod = spec.local?.method ?? method;

    localOffsets.push(out.length);
    out.push(
      ...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(localMethod),
      ...u16(0), ...u16(0), ...u32(localCrc), ...u32(localComp),
      ...u32(localUncomp), ...u16(nameBytes.length), ...u16(0),
      ...nameBytes, ...compressed,
    );
    if (useDd) {
      if (spec.descriptor === "sig") out.push(...u32(0x08074b50));
      out.push(...u32(crc), ...u32(compressed.length), ...u32(uncompSize));
    }

    const cdFlags = spec.cd?.flags ?? flags;
    const cdMethod = spec.cd?.method ?? method;
    const cd = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(cdFlags),
      ...u16(cdMethod), ...u16(0), ...u16(0),
      ...u32(spec.cd?.crc ?? crc),
      ...u32(spec.cd?.compSize ?? compressed.length),
      ...u32(spec.cd?.uncompSize ?? uncompSize),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(spec.cd?.localHeaderOffset ?? localOffsets[localOffsets.length - 1]!),
      ...nameBytes,
    ];
    return { cd };
  };

  for (const spec of entries) {
    cdRecords.push(writeLocal(spec).cd);
  }
  if (opts.orphanLocal) {
    const saveLen = localOffsets.length;
    writeLocal(opts.orphanLocal);
    localOffsets.length = saveLen;
  }

  const cdOffset = out.length;
  for (const rec of cdRecords) {
    cdOffsets.push(out.length);
    out.push(...rec);
  }
  const cdSize = out.length - cdOffset;
  if (opts.betweenCdAndEocd) out.push(...opts.betweenCdAndEocd);

  const comment = new TextEncoder().encode(opts.comment ?? "");
  const eocdOffset = out.length;
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(cdRecords.length), ...u16(cdRecords.length),
    ...u32(cdSize), ...u32(cdOffset), ...u16(comment.length),
  ];
  opts.eocdPatch?.(eocd);
  out.push(...eocd, ...comment);
  if (opts.suffix) out.push(...opts.suffix);

  return {
    buf: new Uint8Array(out),
    localOffsets,
    cdOffsets,
    eocdOffset,
    cdOffset,
  };
}

export const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

export const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body>
</w:document>`;

export function docxEntries(overrides: Partial<{
  contentTypes: string;
  rootRels: string;
  document: string;
  documentPath: string;
  extra: EntrySpec[];
}> = {}): EntrySpec[] {
  const docPath = overrides.documentPath ?? "word/document.xml";
  return [
    { name: "[Content_Types].xml", data: overrides.contentTypes ?? CONTENT_TYPES_XML },
    { name: "_rels/.rels", data: overrides.rootRels ?? ROOT_RELS_XML },
    { name: docPath, data: overrides.document ?? DOCUMENT_XML },
    ...(overrides.extra ?? []),
  ];
}
