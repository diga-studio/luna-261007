/**
 * 增量 UTF-8 校验器：逐字节喂入，拒绝超长短、代理区、>U+10FFFF 等非法序列。
 * 状态可跨 chunk 保持；仅使用固定大小的内部状态。
 */
export class Utf8Validator {
  private remaining = 0;
  private lo = 0x80;
  private hi = 0xbf;
  private failed = false;

  /** 喂入一个字节；非法时返回 false（此后状态不再可用）。 */
  push(byte: number): boolean {
    if (this.failed) return false;
    if (this.remaining > 0) {
      if (byte < this.lo || byte > this.hi) {
        this.failed = true;
        return false;
      }
      this.remaining -= 1;
      this.lo = 0x80;
      this.hi = 0xbf;
      return true;
    }
    if (byte <= 0x7f) return true;
    if (byte >= 0xc2 && byte <= 0xdf) {
      this.remaining = 1;
    } else if (byte === 0xe0) {
      this.remaining = 2;
      this.lo = 0xa0;
    } else if ((byte >= 0xe1 && byte <= 0xec) || (byte >= 0xee && byte <= 0xef)) {
      this.remaining = 2;
    } else if (byte === 0xed) {
      this.remaining = 2;
      this.hi = 0x9f;
    } else if (byte === 0xf0) {
      this.remaining = 3;
      this.lo = 0x90;
    } else if (byte >= 0xf1 && byte <= 0xf3) {
      this.remaining = 3;
    } else if (byte === 0xf4) {
      this.remaining = 3;
      this.hi = 0x8f;
    } else {
      this.failed = true;
      return false;
    }
    return true;
  }

  /** 当前是否位于码点边界（EOF 时必须为 true）。 */
  atBoundary(): boolean {
    return !this.failed && this.remaining === 0;
  }
}
