export interface XmlElement {
  /** 命名空间 URI（无命名空间时为空字符串）。 */
  ns: string;
  /** 本地名（不含前缀）。 */
  localName: string;
  attributes: XmlAttribute[];
  children: XmlElement[];
}

export interface XmlAttribute {
  ns: string;
  localName: string;
  value: string;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

function fail(message: string): never {
  throw new XmlError(message);
}

const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

const NAME_RE =
  /^[A-Za-z_À-֏\u{100}-\u{10FFFF}][A-Za-z0-9._\-À-֏\u{100}-\u{10FFFF}]*$/u;

interface RawName {
  prefix: string | null;
  local: string;
}

function splitName(qname: string): RawName {
  const idx = qname.indexOf(":");
  if (idx === -1) {
    if (!NAME_RE.test(qname)) fail(`非法的 XML 名称: ${qname}`);
    return { prefix: null, local: qname };
  }
  const prefix = qname.slice(0, idx);
  const local = qname.slice(idx + 1);
  if (local.includes(":") || !NAME_RE.test(prefix) || !NAME_RE.test(local)) {
    fail(`非法的 XML 限定名: ${qname}`);
  }
  return { prefix, local };
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z_][A-Za-z0-9._-]*);/g, (m, body: string) => {
    switch (body) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return '"';
      case "apos": return "'";
    }
    let cp: number;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      cp = parseInt(body.slice(2), 16);
    } else if (body.startsWith("#")) {
      cp = parseInt(body.slice(1), 10);
    } else {
      fail(`未定义的实体引用: &${body};（不允许 DTD 与外部实体）`);
    }
    if (
      !Number.isFinite(cp) || cp > 0x10ffff ||
      (cp < 0x20 && cp !== 0x9 && cp !== 0xa && cp !== 0xd) ||
      (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff
    ) {
      fail(`非法的字符引用: &${body};`);
    }
    return String.fromCodePoint(cp);
  });
}

function checkText(text: string): void {
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "&") {
      const semi = text.indexOf(";", i);
      if (semi === -1) fail("文本中存在未转义的 &");
      decodeEntities(text.slice(i, semi + 1));
      i = semi + 1;
    } else if (ch === "<") {
      fail("文本中存在未转义的 <");
    } else if (ch === "]" && text.startsWith("]]>", i)) {
      fail("文本中存在非法的 ]]>");
    } else {
      i++;
    }
  }
}

interface NsFrame {
  bindings: Map<string, string>;
}

class Parser {
  private pos = 0;
  private readonly text: string;
  private nsStack: NsFrame[] = [{ bindings: new Map([["xml", XML_NS]]) }];

  constructor(text: string) {
    this.text = text;
  }

  private error(message: string): never {
    fail(`${message}（位置 ${this.pos}）`);
  }

  private startsWith(s: string): boolean {
    return this.text.startsWith(s, this.pos);
  }

  private expect(s: string): void {
    if (!this.startsWith(s)) this.error(`期望 "${s}"`);
    this.pos += s.length;
  }

  private skipWs(): void {
    while (this.pos < this.text.length && /^\s$/.test(this.text[this.pos]!)) {
      this.pos++;
    }
  }

  private readName(): string {
    const m = /^[^\s=/?<>"']+/.exec(this.text.slice(this.pos));
    if (!m) this.error("期望名称");
    this.pos += m[0].length;
    return m[0];
  }

  private lookupNs(prefix: string): string | undefined {
    for (let i = this.nsStack.length - 1; i >= 0; i--) {
      const v = this.nsStack[i]!.bindings.get(prefix);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  parseDocument(): XmlElement {
    this.skipWs();
    if (this.startsWith("<?xml")) {
      this.parseXmlDecl();
    }
    for (;;) {
      this.skipWs();
      if (this.pos >= this.text.length) this.error("文档没有根元素");
      if (this.startsWith("<!--")) { this.skipComment(); continue; }
      if (this.startsWith("<?")) { this.skipPi(); continue; }
      if (this.startsWith("<!DOCTYPE") || this.startsWith("<!doctype")) {
        this.error("不允许 DTD（DOCTYPE 声明）");
      }
      if (this.startsWith("<!")) this.error("非法的标记声明");
      break;
    }
    const root = this.parseElement();
    for (;;) {
      this.skipWs();
      if (this.pos >= this.text.length) break;
      if (this.startsWith("<!--")) { this.skipComment(); continue; }
      if (this.startsWith("<?")) { this.skipPi(); continue; }
      this.error("根元素之后存在多余内容");
    }
    return root;
  }

  private parseXmlDecl(): void {
    const end = this.text.indexOf("?>", this.pos);
    if (end === -1) this.error("XML 声明未闭合");
    const body = this.text.slice(this.pos + 5, end);
    const enc = /encoding\s*=\s*["']([^"']+)["']/i.exec(body);
    if (enc && !/^(utf-8|us-ascii|ascii)$/i.test(enc[1]!)) {
      this.error(`不支持的 XML 编码: ${enc[1]}`);
    }
    this.pos = end + 2;
  }

  private skipComment(): void {
    const end = this.text.indexOf("-->", this.pos + 4);
    if (end === -1) this.error("注释未闭合");
    if (this.text.slice(this.pos + 4, end).includes("--")) {
      this.error("注释中包含非法的 --");
    }
    this.pos = end + 3;
  }

  private skipPi(): void {
    const end = this.text.indexOf("?>", this.pos + 2);
    if (end === -1) this.error("处理指令未闭合");
    this.pos = end + 2;
  }

  private applyNamespaceDecls(
    rawAttrs: { qname: string; value: string }[],
    frame: NsFrame,
  ): void {
    for (const a of rawAttrs) {
      if (a.qname === "xmlns" || a.qname.startsWith("xmlns:")) {
        const prefix = a.qname === "xmlns" ? "" : a.qname.slice(6);
        if (prefix === "xml" || prefix === "xmlns") {
          fail(`非法的命名空间绑定: ${a.qname}`);
        }
        frame.bindings.set(prefix, a.value);
      }
    }
  }

  private parseElement(): XmlElement {
    this.expect("<");
    if (this.startsWith("/")) this.error("意外的结束标签");
    const qname = this.readName();
    const rawAttrs: { qname: string; value: string }[] = [];
    const frame: NsFrame = { bindings: new Map() };
    this.nsStack.push(frame);
    try {
      for (;;) {
        this.skipWs();
        if (this.startsWith("/>")) {
          this.pos += 2;
          this.applyNamespaceDecls(rawAttrs, frame);
          return this.finishElement(qname, rawAttrs, []);
        }
        if (this.startsWith(">")) {
          this.pos += 1;
          this.applyNamespaceDecls(rawAttrs, frame);
          break;
        }
        const attrName = this.readName();
        this.skipWs();
        this.expect("=");
        this.skipWs();
        const quote = this.text[this.pos];
        if (quote !== '"' && quote !== "'") this.error("属性值未加引号");
        this.pos++;
        const end = this.text.indexOf(quote, this.pos);
        if (end === -1) this.error("属性值未闭合");
        const rawValue = this.text.slice(this.pos, end);
        if (rawValue.includes("<")) this.error("属性值中包含 <");
        this.pos = end + 1;
        rawAttrs.push({ qname: attrName, value: decodeEntities(rawValue) });
      }
      const children: XmlElement[] = [];
      for (;;) {
        if (this.pos >= this.text.length) this.error("元素未闭合");
        if (this.startsWith("</")) {
          this.pos += 2;
          const closeName = this.readName();
          this.skipWs();
          this.expect(">");
          if (closeName !== qname) {
            this.error(`标签不匹配: <${qname}> 与 </${closeName}>`);
          }
          return this.finishElement(qname, rawAttrs, children);
        }
        if (this.startsWith("<!--")) { this.skipComment(); continue; }
        if (this.startsWith("<?")) { this.skipPi(); continue; }
        if (this.startsWith("<![CDATA[")) {
          const end = this.text.indexOf("]]>", this.pos + 9);
          if (end === -1) this.error("CDATA 未闭合");
          this.pos = end + 3;
          continue;
        }
        if (this.startsWith("<!")) this.error("元素内容中出现非法声明");
        if (this.startsWith("<")) {
          children.push(this.parseElement());
          continue;
        }
        const next = this.text.indexOf("<", this.pos);
        checkText(this.text.slice(this.pos, next === -1 ? undefined : next));
        this.pos = next === -1 ? this.text.length : next;
      }
    } finally {
      this.nsStack.pop();
    }
  }

  private finishElement(
    qname: string,
    rawAttrs: { qname: string; value: string }[],
    children: XmlElement[],
  ): XmlElement {
    const frame = this.nsStack[this.nsStack.length - 1]!;
    const seen = new Set<string>();
    const { prefix, local } = splitName(qname);
    let ns: string;
    if (prefix === null) {
      ns = frame.bindings.get("") ?? this.lookupNs("") ?? "";
    } else {
      const bound = frame.bindings.get(prefix) ?? this.lookupNs(prefix);
      if (bound === undefined || bound === "") {
        fail(`元素 ${qname} 使用未绑定的命名空间前缀`);
      }
      ns = bound;
    }
    const attributes: XmlAttribute[] = [];
    for (const a of rawAttrs) {
      if (a.qname === "xmlns" || a.qname.startsWith("xmlns:")) {
        const localName = a.qname === "xmlns" ? "xmlns" : a.qname.slice(6);
        const key = `${XMLNS_NS}${localName}`;
        if (seen.has(key)) fail(`重复的属性: ${a.qname}`);
        seen.add(key);
        attributes.push({ ns: XMLNS_NS, localName, value: a.value });
        continue;
      }
      const an = splitName(a.qname);
      let ans = "";
      if (an.prefix !== null) {
        const bound = frame.bindings.get(an.prefix) ?? this.lookupNs(an.prefix);
        if (bound === undefined || bound === "") {
          fail(`属性 ${a.qname} 使用未绑定的命名空间前缀`);
        }
        ans = bound;
      }
      const key = `${ans}${an.local}`;
      if (seen.has(key)) fail(`重复的属性: ${a.qname}`);
      seen.add(key);
      attributes.push({ ns: ans, localName: an.local, value: a.value });
    }
    return { ns, localName: local, attributes, children };
  }
}

/**
 * 解析 XML 文档为受限 DOM。拒绝 DTD 与外部实体，仅支持 UTF-8。
 * 解析失败抛出 XmlError。
 */
export function parseXml(data: Uint8Array): XmlElement {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    fail("XML 不是有效的 UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return new Parser(text).parseDocument();
}
