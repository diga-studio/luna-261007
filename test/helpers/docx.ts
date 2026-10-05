import type { EntrySpec } from "./zip.js";

export const CT_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
export const REL_OFFICE_DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

export function contentTypesXml(overrides: Array<[string, string]>, defaults?: Array<[string, string]>): string {
  const d = (defaults ?? [["rels", "application/vnd.openxmlformats-package.relationships+xml"], ["xml", "application/xml"]])
    .map(([ext, ct]) => `<Default Extension="${ext}" ContentType="${ct}"/>`)
    .join("");
  const o = overrides
    .map(([part, ct]) => `<Override PartName="${part}" ContentType="${ct}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${d}${o}</Types>`;
}

export function rootRelsXml(rels: Array<{ id?: string; type?: string; target?: string; mode?: string }>): string {
  const body = rels
    .map(
      (r, i) =>
        `<Relationship Id="${r.id ?? `rId${i + 1}`}" Type="${r.type ?? REL_OFFICE_DOC}" Target="${r.target ?? "word/document.xml"}"${r.mode ? ` TargetMode="${r.mode}"` : ""}/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
}

export const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>`;

export interface DocxFixtureOptions {
  mainPart?: string;
  mainXml?: string;
  contentTypes?: string;
  rootRels?: string;
  extraEntries?: EntrySpec[];
  transform?: (entries: EntrySpec[]) => EntrySpec[];
}

export function docxEntries(opts: DocxFixtureOptions = {}): EntrySpec[] {
  const mainPart = opts.mainPart ?? "word/document.xml";
  const entries: EntrySpec[] = [
    {
      name: "[Content_Types].xml",
      data: opts.contentTypes ?? contentTypesXml([[`/${mainPart}`, CT_MAIN]]),
    },
    {
      name: "_rels/.rels",
      data: opts.rootRels ?? rootRelsXml([{ target: mainPart }]),
    },
    { name: mainPart, data: opts.mainXml ?? DOCUMENT_XML },
    ...(opts.extraEntries ?? []),
  ];
  return opts.transform ? opts.transform(entries) : entries;
}
