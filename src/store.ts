import {
  closeSync, existsSync, fstatSync, fsyncSync, mkdirSync,
  openSync, readSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { decodeEvent } from './encoding.js';
import type { CustodyEvent } from './types.js';

const EVENTS_FILE = 'events.log';
const SEAL_FILE = 'seal.bin';
const READ_CHUNK = 8 * 1024 * 1024;

/** 账册文件的持久化：追加日志 events.log + 一次性写入的封存产物 seal.bin。 */
export class LedgerStore {
  private readonly dir: string;
  private readonly eventsPath: string;
  private readonly sealPath: string;
  private fd: number;
  private sealFd: number | null = null;
  private fileSize: number;
  private sealed: boolean;
  private closed = false;

  private constructor(dir: string) {
    this.dir = dir;
    this.eventsPath = join(dir, EVENTS_FILE);
    this.sealPath = join(dir, SEAL_FILE);
    mkdirSync(dir, { recursive: true });
    this.sealed = existsSync(this.sealPath);
    const existed = existsSync(this.eventsPath);
    this.fd = openSync(this.eventsPath, existed ? 'r+' : 'w+');
    this.fileSize = fstatSync(this.fd).size;
  }

  /** 打开（必要时创建）目录中的账册。 */
  static open(dir: string): LedgerStore {
    return new LedgerStore(dir);
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  /** 追加一个已编码事件，返回其字节偏移。 */
  appendEvent(encoded: Uint8Array): number {
    this.assertWritable();
    const offset = this.fileSize;
    writeSync(this.fd, encoded, 0, encoded.length, offset);
    this.fileSize += encoded.length;
    return offset;
  }

  /** 按偏移读取并解码事件。 */
  readEventAt(offset: number): CustodyEvent {
    this.assertOpen();
    const lenBuf = Buffer.allocUnsafe(4);
    readSync(this.fd, lenBuf, 0, 4, offset);
    const total = lenBuf.readUInt32LE(0);
    const buf = Buffer.allocUnsafe(total);
    readSync(this.fd, buf, 0, total, offset);
    return decodeEvent(buf, 0).event;
  }

  /** 顺序遍历全部事件及其字节偏移（封存前重建索引用），分块读取避免整文件入内存。 */
  *iterateEvents(): Generator<{ event: CustodyEvent; offset: number }> {
    this.assertOpen();
    let pending = Buffer.allocUnsafe(0);
    let pos = 0;
    while (pos < this.fileSize) {
      const want = Math.min(READ_CHUNK, this.fileSize - pos);
      const chunk = Buffer.allocUnsafe(pending.length + want);
      pending.copy(chunk, 0);
      readSync(this.fd, chunk, pending.length, want, pos);
      pos += want;
      let o = 0;
      const base = pos - want - pending.length;
      while (o + 4 <= chunk.length) {
        const total = chunk.readUInt32LE(o);
        if (o + total > chunk.length) break;
        yield { event: decodeEvent(chunk, o).event, offset: base + o };
        o += total;
      }
      pending = chunk.subarray(o);
    }
    if (pending.length !== 0) throw new Error('corrupt events log: trailing bytes');
  }

  /** 写入封存产物（凭证数据 + 索引），只能写一次。 */
  writeSeal(data: Uint8Array): void {
    this.assertWritable();
    fsyncSync(this.fd);
    writeFileSync(this.sealPath, data, { flag: 'wx' });
    this.sealed = true;
  }

  /** 封存产物总字节数；未封存返回 null。 */
  sealSize(): number | null {
    if (!this.sealed) return null;
    return fstatSync(this.sealFd ?? (this.sealFd = openSync(this.sealPath, 'r'))).size;
  }

  /** 定位读取封存产物的一段，避免整文件入内存。 */
  readSealAt(offset: number, length: number): Buffer {
    if (!this.sealed) throw new Error('ledger is not sealed');
    if (this.sealFd === null) this.sealFd = openSync(this.sealPath, 'r');
    const buf = Buffer.allocUnsafeSlow(length);
    readSync(this.sealFd, buf, 0, length, offset);
    return buf;
  }

  close(): void {
    if (this.closed) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    if (this.sealFd !== null) {
      closeSync(this.sealFd);
      this.sealFd = null;
    }
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('ledger store is closed');
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.sealed) throw new Error('ledger is sealed');
  }
}
