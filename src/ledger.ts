import { chainStep, eventCommitment, recordChainStep, recordKey, zeroChain } from './crypto.js';
import { encodeEvent } from './encoding.js';
import { LeafIndex, buildLayers, compareBytes, equalBytes, layerSizes, readPath } from './merkle.js';
import { buildCredential, REPORT_VERSION } from './report.js';
import { LedgerStore } from './store.js';
import type { Credential, CustodyEvent, CustodyReport, EventInput, RecordProof } from './types.js';

const SEAL_MAGIC = 0x31455343; // "CSE1"
const SEAL_VERSION = 1;
const SEAL_HEADER_SIZE = 4 + 1 + 8 + 32 + 32 + 4;
const HASH = 32;

const textEncoder = new TextEncoder();

/** 证据保管链账册。通过 CustodyLedger.open 获得。 */
export class CustodyLedger {
  private readonly store: LedgerStore;
  private sealedFlag = false;
  private count = 0;
  private globalHead: Uint8Array = zeroChain();

  // 未封存状态
  private chains: Map<string, Uint8Array> | null = new Map();
  private seqLists: Map<string, number[]> | null = new Map();
  private offsetList: number[] | null = [];

  // 已封存状态（记录元数据直接读 recBuf，不建 Map）
  private recordRoot: Uint8Array | null = null;
  private recBuf: Uint8Array | null = null;
  private seqs: Uint32Array | null = null;
  private offsets: BigUint64Array | null = null;
  private leafIndex: LeafIndex | null = null;
  /** Merkle 层字节在 seal.bin 中的起始偏移。 */
  private layersStart = 0;

  private constructor(store: LedgerStore) {
    this.store = store;
  }

  /** 打开（或创建）目录中的账册。 */
  static open(dir: string): CustodyLedger {
    const store = LedgerStore.open(dir);
    const ledger = new CustodyLedger(store);
    if (store.isSealed) {
      ledger.loadSeal();
    } else {
      ledger.rebuildFromLog();
    }
    return ledger;
  }

  get isSealed(): boolean {
    return this.sealedFlag;
  }

  get eventCount(): number {
    return this.count;
  }

  /** 追加事件，返回全局递增序号。已封存账册拒绝追加。 */
  appendEvent(input: EventInput): number {
    if (this.sealedFlag) throw new Error('ledger is sealed');
    if (typeof input.recordId !== 'string' || input.recordId.length === 0) {
      throw new Error('recordId must be a non-empty string');
    }
    const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
    if (!Number.isInteger(timestamp) || timestamp < 0) throw new Error('invalid timestamp');
    const body = typeof input.body === 'string' ? textEncoder.encode(input.body) : input.body;
    const seq = this.count + 1;
    const event: CustodyEvent = { seq, recordId: input.recordId, timestamp, actor: input.actor, body };
    const encoded = encodeEvent(event);
    const commitment = eventCommitment(encoded);
    this.globalHead = chainStep(this.globalHead, commitment);
    const prevHead = this.chains!.get(input.recordId) ?? zeroChain();
    this.chains!.set(input.recordId, recordChainStep(prevHead, commitment));
    let list = this.seqLists!.get(input.recordId);
    if (list === undefined) {
      list = [];
      this.seqLists!.set(input.recordId, list);
    }
    list.push(seq);
    const offset = this.store.appendEvent(encoded);
    this.offsetList!.push(offset);
    this.count = seq;
    return seq;
  }

  /** 封存账册，返回 ≤128 字节的凭证。只能封存一次。 */
  seal(): Credential {
    if (this.sealedFlag) throw new Error('ledger already sealed');
    const entries = [...this.chains!.entries()].map(([recordId, head]) => ({
      recordId,
      key: recordKey(recordId),
      head,
    }));
    entries.sort((a, b) => compareBytes(a.key, b.key));

    const seqs = new Uint32Array(this.count);
    const offsets = new BigUint64Array(this.count);
    for (let i = 0; i < this.count; i++) offsets[i] = BigInt(this.offsetList![i]);

    // 记录段：ridLen u16 | rid | key 32 | head 32 | seqStart u32 | seqCount u32（按键升序）
    const ridBytes = entries.map((e) => textEncoder.encode(e.recordId));
    let recordsSize = 0;
    for (const r of ridBytes) recordsSize += 2 + r.length + HASH + HASH + 4 + 4;
    const recBuf = Buffer.allocUnsafeSlow(recordsSize);
    const keyOffs = new Uint32Array(entries.length);
    const ridOffs = new Uint32Array(entries.length);
    let o = 0;
    let seqPos = 0;
    for (let i = 0; i < entries.length; i++) {
      ridOffs[i] = o;
      recBuf.writeUInt16LE(ridBytes[i].length, o); o += 2;
      recBuf.set(ridBytes[i], o); o += ridBytes[i].length;
      keyOffs[i] = o;
      recBuf.set(entries[i].key, o); o += HASH;
      recBuf.set(entries[i].head, o); o += HASH;
      const list = this.seqLists!.get(entries[i].recordId)!;
      const seqStart = seqPos;
      for (const s of list) seqs[seqPos++] = s;
      recBuf.writeUInt32LE(seqStart, o); o += 4;
      recBuf.writeUInt32LE(list.length, o); o += 4;
    }
    const leafIndex = new LeafIndex(recBuf, keyOffs, ridOffs);
    const { layersBlob, root: recordRoot } = buildLayers(leafIndex);

    const header = Buffer.allocUnsafe(SEAL_HEADER_SIZE);
    header.writeUInt32LE(SEAL_MAGIC, 0);
    header.writeUInt8(SEAL_VERSION, 4);
    header.writeBigUInt64LE(BigInt(this.count), 5);
    header.set(this.globalHead, 13);
    header.set(recordRoot, 45);
    header.writeUInt32LE(entries.length, 77);
    const blob = Buffer.concat([
      header,
      recBuf,
      Buffer.from(seqs.buffer, seqs.byteOffset, seqs.byteLength),
      Buffer.from(offsets.buffer, offsets.byteOffset, offsets.byteLength),
      Buffer.from(layersBlob.buffer, layersBlob.byteOffset, layersBlob.byteLength),
    ]);
    this.store.writeSeal(new Uint8Array(blob.buffer, blob.byteOffset, blob.length));

    this.sealedFlag = true;
    this.recordRoot = recordRoot;
    this.recBuf = recBuf;
    this.seqs = seqs;
    this.offsets = offsets;
    this.leafIndex = leafIndex;
    this.layersStart = SEAL_HEADER_SIZE + recordsSize + this.count * 4 + this.count * 8;
    this.chains = null;
    this.seqLists = null;
    this.offsetList = null;
    return buildCredential(this.count, this.globalHead, recordRoot);
  }

  /** 已封存账册的凭证（供调用方另行保管）。 */
  credential(): Credential {
    if (!this.sealedFlag) throw new Error('ledger is not sealed');
    return buildCredential(this.count, this.globalHead, this.recordRoot!);
  }

  /** 生成单条记录的报告（封存后可用；无匹配事件时为空报告）。 */
  generateReport(recordId: string): CustodyReport {
    if (!this.sealedFlag) throw new Error('ledger is not sealed');
    const idx = this.leafIndex!.findIndex(recordId);
    if (idx === null) {
      return { version: REPORT_VERSION, recordId, events: [], proof: this.exclusionProof(recordId) };
    }
    const seqStart = this.leafIndex!.seqStartAt(idx);
    const seqCount = this.leafIndex!.seqCountAt(idx);
    const events: CustodyEvent[] = [];
    for (let j = 0; j < seqCount; j++) {
      const seq = this.seqs![seqStart + j];
      events.push(this.store.readEventAt(Number(this.offsets![seq - 1])));
    }
    // 自检：账册文件被改动时拒绝产出报告
    let head = zeroChain();
    for (const e of events) head = recordChainStep(head, eventCommitment(encodeEvent(e)));
    const headOff = this.leafIndex!.keyOffs[idx] + HASH;
    const committed = this.recBuf!.subarray(headOff, headOff + HASH);
    if (!equalBytes(head, committed)) throw new Error('ledger file corrupted: record chain mismatch');
    events.sort((a, b) => (a.timestamp - b.timestamp) || (a.seq - b.seq));
    return { version: REPORT_VERSION, recordId, events, proof: this.inclusionProof(recordId) };
  }

  close(): void {
    this.store.close();
  }

  private readLayerAt = (offset: number, length: number): Uint8Array =>
    this.store.readSealAt(this.layersStart + offset, length);

  private inclusionProof(recordId: string): RecordProof {
    const idx = this.leafIndex!.findIndex(recordId)!;
    return {
      kind: 'inclusion',
      leafIndex: idx,
      leafCount: this.leafIndex!.leafCount,
      recordHead: this.leafIndex!.headAt(idx),
      path: readPath(this.readLayerAt, this.leafIndex!.leafCount, idx),
    };
  }

  private exclusionProof(recordId: string): RecordProof {
    const index = this.leafIndex!;
    const at = index.insertionPoint(recordId);
    const mk = (idx: number) => ({
      leafIndex: idx,
      recordId: index.recordIdAt(idx),
      recordHead: index.headAt(idx),
      path: readPath(this.readLayerAt, index.leafCount, idx),
    });
    return {
      kind: 'exclusion',
      leafCount: index.leafCount,
      left: at > 0 ? mk(at - 1) : null,
      right: at < index.leafCount ? mk(at) : null,
    };
  }

  /** 未封存账册重开：顺序扫描日志重建内存索引。 */
  private rebuildFromLog(): void {
    for (const { event, offset } of this.store.iterateEvents()) {
      if (event.seq !== this.count + 1) throw new Error('corrupt events log: bad sequence');
      const commitment = eventCommitment(encodeEvent(event));
      this.globalHead = chainStep(this.globalHead, commitment);
      const prevHead = this.chains!.get(event.recordId) ?? zeroChain();
      this.chains!.set(event.recordId, recordChainStep(prevHead, commitment));
      let list = this.seqLists!.get(event.recordId);
      if (list === undefined) {
        list = [];
        this.seqLists!.set(event.recordId, list);
      }
      list.push(event.seq);
      this.offsetList!.push(offset);
      this.count = event.seq;
    }
  }

  /** 已封存账册重开：分段解析 seal.bin，加载索引并重建 Merkle 树。 */
  private loadSeal(): void {
    const total = this.store.sealSize();
    if (total === null || total < SEAL_HEADER_SIZE) throw new Error('corrupt seal file');
    const header = this.store.readSealAt(0, SEAL_HEADER_SIZE);
    if (header.readUInt32LE(0) !== SEAL_MAGIC) throw new Error('bad seal magic');
    if (header.readUInt8(4) !== SEAL_VERSION) throw new Error('unsupported seal version');
    this.count = Number(header.readBigUInt64LE(5));
    this.globalHead = new Uint8Array(header.subarray(13, 45));
    this.recordRoot = new Uint8Array(header.subarray(45, 77));
    const recordCount = header.readUInt32LE(77);
    const layersSize = layerSizes(recordCount).reduce((a, b) => a + b, 0) * HASH;
    const recordsSize = total - SEAL_HEADER_SIZE - this.count * 4 - this.count * 8 - layersSize;
    if (recordsSize < 0) throw new Error('corrupt seal file');
    const recBuf = this.store.readSealAt(SEAL_HEADER_SIZE, recordsSize);
    const keyOffs = new Uint32Array(recordCount);
    const ridOffs = new Uint32Array(recordCount);
    let o = 0;
    for (let i = 0; i < recordCount; i++) {
      ridOffs[i] = o;
      const ridLen = recBuf.readUInt16LE(o); o += 2;
      o += ridLen;
      keyOffs[i] = o; o += HASH;
      o += HASH;
      o += 4;
      o += 4;
    }
    if (o !== recordsSize) throw new Error('corrupt seal file: records section size mismatch');
    const seqBuf = this.store.readSealAt(SEAL_HEADER_SIZE + recordsSize, this.count * 4);
    const seqs = new Uint32Array(seqBuf.buffer, 0, this.count);
    const offBuf = this.store.readSealAt(SEAL_HEADER_SIZE + recordsSize + this.count * 4, this.count * 8);
    const offsets = new BigUint64Array(offBuf.buffer, 0, this.count);
    const leafIndex = new LeafIndex(recBuf, keyOffs, ridOffs);
    leafIndex.checkSorted();
    this.recBuf = recBuf;
    this.seqs = seqs;
    this.offsets = offsets;
    this.leafIndex = leafIndex;
    this.layersStart = SEAL_HEADER_SIZE + recordsSize + this.count * 4 + this.count * 8;
    this.sealedFlag = true;
    this.chains = null;
    this.seqLists = null;
    this.offsetList = null;
  }
}
