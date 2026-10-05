import { TextDecoder } from "node:util";

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

export interface XmlElement {
  localName: string;
  namespaceUri: string | null;
  attributes: ReadonlyMap<string, string>;
  children: XmlElement[];
}

export interface XmlDocument {
  root: XmlElement;
}

export function getAttr(el: XmlElement, name: string): string | undefined {
  return el.attributes.get(name);
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

const NAME_START = /[:A-Z_a-zÀ-˿豈-﷏ﷰ-�]/;
const NAME_CHAR = /[-.:0-9A-Z_a-z·À-˿豈-﷏ﷰ-�]/;

function isValidXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

class Parser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parseDocument(): XmlDocument {
    if (this.startsWith("<?xml")) {
      this.parseXmlDecl();
    }
    this.skipMisc();
    if (this.eof()) this.error("no root element");
    const root = this.parseElement(new Map());
    this.skipMisc();
    if (!this.eof()) this.error("content after root element");
    return { root };
  }

  private eof(): boolean {
    return this.pos >= this.text.length;
  }

  private startsWith(s: string): boolean {
    return this.text.startsWith(s, this.pos);
  }

  private error(message: string): never {
    throw new XmlError(`${message} at offset ${this.pos}`);
  }

  private skipMisc(): void {
    for (;;) {
      while (!this.eof() && /\s/.test(this.text[this.pos]!)) this.pos++;
      if (this.startsWith("<!--")) {
        this.parseComment();
      } else if (this.startsWith("<?")) {
        this.parsePI();
      } else if (this.startsWith("<!DOCTYPE") || this.startsWith("<!doctype")) {
        this.error("DTD is not allowed");
      } else {
        return;
      }
    }
  }

  private parseXmlDecl(): void {
    const end = this.text.indexOf("?>", this.pos + 2);
    if (end < 0) this.error("unterminated XML declaration");
    const body = this.text.slice(this.pos + 5, end);
    if (!/^\s+version\s*=\s*("1\.[0-9]+"|'1\.[0-9]+')(\s+encoding\s*=\s*("[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(\s+standalone\s*=\s*("(?:yes|no)"|'(?:yes|no)'))?\s*$/.test(body)) {
      this.error("malformed XML declaration");
    }
    const encMatch = /encoding\s*=\s*["']([A-Za-z][A-Za-z0-9._-]*)["']/.exec(body);
    if (encMatch && encMatch[1]!.toLowerCase() !== "utf-8" && encMatch[1]!.toLowerCase() !== "utf8") {
      this.error(`unsupported XML encoding: ${encMatch[1]}`);
    }
    this.pos = end + 2;
  }

  private parseComment(): void {
    const end = this.text.indexOf("-->", this.pos + 4);
    if (end < 0) this.error("unterminated comment");
    if (this.text.indexOf("--", this.pos + 4) !== end) {
      this.error("'--' inside comment");
    }
    this.pos = end + 3;
  }

  private parsePI(): void {
    const end = this.text.indexOf("?>", this.pos + 2);
    if (end < 0) this.error("unterminated processing instruction");
    const target = /^<\?([^\s?>]+)/.exec(this.text.slice(this.pos, end + 2));
    if (!target || !NAME_START.test(target[1]!)) this.error("malformed processing instruction");
    if (target[1]!.toLowerCase() === "xml") this.error("reserved processing instruction target");
    this.pos = end + 2;
  }

  private parseName(): string {
    if (this.eof() || !NAME_START.test(this.text[this.pos]!)) {
      this.error("expected name");
    }
    const start = this.pos;
    this.pos++;
    while (!this.eof() && NAME_CHAR.test(this.text[this.pos]!)) this.pos++;
    return this.text.slice(start, this.pos);
  }

  private skipSpaces(): boolean {
    const start = this.pos;
    while (!this.eof() && /\s/.test(this.text[this.pos]!)) this.pos++;
    return this.pos > start;
  }

  private parseReference(): string {
    const semi = this.text.indexOf(";", this.pos + 1);
    if (semi < 0 || semi - this.pos > 12) this.error("unterminated reference");
    const body = this.text.slice(this.pos + 1, semi);
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    if (body in named) {
      this.pos = semi + 1;
      return named[body]!;
    }
    const m = /^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/.exec(body);
    if (!m) this.error(`unknown entity reference: &${body};`);
    const cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2]!, 10);
    if (!isValidXmlChar(cp)) this.error(`invalid character reference: &${body};`);
    this.pos = semi + 1;
    return String.fromCodePoint(cp);
  }

  private parseAttValue(): string {
    const quote = this.text[this.pos];
    if (quote !== '"' && quote !== "'") this.error("expected quoted attribute value");
    this.pos++;
    let out = "";
    for (;;) {
      if (this.eof()) this.error("unterminated attribute value");
      const ch = this.text[this.pos]!;
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch === "&") {
        out += this.parseReference();
      } else if (ch === "<") {
        this.error("'<' in attribute value");
      } else if (ch === "\t" || ch === "\n" || ch === "\r") {
        out += " ";
        this.pos++;
      } else {
        if (!isValidXmlChar(ch.codePointAt(0)!)) this.error("invalid character in attribute");
        out += ch;
        this.pos++;
      }
    }
  }

  private parseElement(inheritedNs: ReadonlyMap<string, string | null>): XmlElement {
    if (this.text[this.pos] !== "<") this.error("expected element");
    if (this.startsWith("<!--")) {
      this.parseComment();
      return this.parseElement(inheritedNs);
    }
    if (this.startsWith("<![CDATA[")) this.error("CDATA outside of element content");
    if (this.startsWith("<!")) this.error("DTD is not allowed");
    if (this.startsWith("<?")) this.error("unexpected processing instruction");
    this.pos++;
    const qname = this.parseName();

    const rawAttrs: Array<[string, string]> = [];
    const seenRaw = new Set<string>();
    let selfClosing = false;
    for (;;) {
      const hadSpace = this.skipSpaces();
      if (this.startsWith("/>")) {
        this.pos += 2;
        selfClosing = true;
        break;
      }
      if (this.startsWith(">")) {
        this.pos++;
        break;
      }
      if (!hadSpace) this.error("expected whitespace before attribute");
      const attrName = this.parseName();
      if (seenRaw.has(attrName)) this.error(`duplicate attribute: ${attrName}`);
      seenRaw.add(attrName);
      this.skipSpaces();
      if (this.text[this.pos] !== "=") this.error("expected '=' after attribute name");
      this.pos++;
      this.skipSpaces();
      rawAttrs.push([attrName, this.parseAttValue()]);
    }

    const ns = new Map(inheritedNs);
    for (const [name, value] of rawAttrs) {
      if (name === "xmlns") {
        if (value === XMLNS_NS) this.error("cannot bind default namespace to xmlns URI");
        ns.set("", value === "" ? null : value);
      } else if (name.startsWith("xmlns:")) {
        const prefix = name.slice(6);
        if (prefix === "xmlns") this.error("cannot redeclare xmlns prefix");
        if (value === "" ) this.error("cannot undeclare a prefix");
        if (prefix === "xml" && value !== XML_NS) this.error("cannot rebind xml prefix");
        if (value === XML_NS && prefix !== "xml") this.error("xml URI reserved");
        if (value === XMLNS_NS) this.error("xmlns URI reserved");
        ns.set(prefix, value);
      }
    }
    ns.set("xml", XML_NS);

    const { prefix: elPrefix, local: elLocal } = splitQName(qname);
    let namespaceUri: string | null;
    if (elPrefix !== null) {
      const bound = ns.get(elPrefix);
      if (bound === undefined || bound === null) {
        this.error(`unbound namespace prefix: ${elPrefix}`);
      }
      namespaceUri = bound;
    } else {
      namespaceUri = ns.get("") ?? null;
    }

    const attributes = new Map<string, string>();
    for (const [name, value] of rawAttrs) {
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      const { prefix, local } = splitQName(name);
      let key: string;
      if (prefix !== null) {
        const bound = ns.get(prefix);
        if (bound === undefined || bound === null) {
          this.error(`unbound namespace prefix on attribute: ${prefix}`);
        }
        key = `{${bound}}${local}`;
      } else {
        key = local;
      }
      if (attributes.has(key)) this.error(`duplicate attribute: ${name}`);
      attributes.set(key, value);
    }

    const children: XmlElement[] = [];
    if (!selfClosing) {
      for (;;) {
        if (this.eof()) this.error(`unterminated element: ${qname}`);
        if (this.startsWith("</")) {
          this.pos += 2;
          const closeName = this.parseName();
          this.skipSpaces();
          if (this.text[this.pos] !== ">") this.error("malformed closing tag");
          this.pos++;
          if (closeName !== qname) this.error(`mismatched closing tag: ${closeName}`);
          break;
        }
        if (this.startsWith("<!--")) {
          this.parseComment();
          continue;
        }
        if (this.startsWith("<![CDATA[")) {
          this.parseCdata();
          continue;
        }
        if (this.startsWith("<?")) {
          this.parsePI();
          continue;
        }
        if (this.startsWith("<!")) this.error("DTD is not allowed");
        if (this.text[this.pos] === "<") {
          children.push(this.parseElement(ns));
          continue;
        }
        this.parseCharData();
      }
    }

    return { localName: elLocal, namespaceUri, attributes, children };
  }

  private parseCdata(): void {
    const end = this.text.indexOf("]]>", this.pos + 9);
    if (end < 0) this.error("unterminated CDATA section");
    for (let i = this.pos + 9; i < end; i++) {
      if (!isValidXmlChar(this.text.codePointAt(i)!)) this.error("invalid character in CDATA");
    }
    this.pos = end + 3;
  }

  private parseCharData(): void {
    for (;;) {
      if (this.eof()) return;
      const ch = this.text[this.pos]!;
      if (ch === "<") return;
      if (ch === "&") {
        this.parseReference();
        continue;
      }
      if (ch === "]" && this.startsWith("]]>") ) {
        this.error("']]>' in character data");
      }
      if (!isValidXmlChar(ch.codePointAt(0)!)) this.error("invalid character in content");
      this.pos++;
    }
  }
}

function splitQName(qname: string): { prefix: string | null; local: string } {
  const idx = qname.indexOf(":");
  if (idx < 0) return { prefix: null, local: qname };
  if (idx === 0 || idx === qname.length - 1 || qname.indexOf(":", idx + 1) >= 0) {
    throw new XmlError(`malformed qualified name: ${qname}`);
  }
  return { prefix: qname.slice(0, idx), local: qname.slice(idx + 1) };
}

export function parseXml(data: Buffer): XmlDocument {
  let bytes = data;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  } else if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    throw new XmlError("UTF-16 encoded XML is not supported");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new XmlError("XML part is not valid UTF-8");
  }
  if (text.length > 0 && text.codePointAt(0)! === 0xfeff) {
    text = text.slice(1);
  }
  return new Parser(text).parseDocument();
}
