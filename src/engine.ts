import { MinHeap } from "./heap";
import {
  EngineStats,
  Inspection,
  MemberId,
  RegistrationId,
  RegistrationStatus,
  TrackId,
  TrackSpec,
} from "./types";

const MAX_TRACKS = 64;
const MAX_TEAM_SIZE = 20;

interface Reg {
  id: RegistrationId;
  seq: number;
  trackIdx: number;
  memberIds: readonly MemberId[];
  size: number;
  status: RegistrationStatus;
  /** true 时条目挂在成员阻塞索引中（按成员反查）。 */
  memBlocked: boolean;
  /** true 时条目挂在赛道容量索引（按人数分桶）中。 */
  inCapIndex: boolean;
}

interface MemberOccupancy {
  /** 已录取报名占用的赛道 -> 次数（同一成员可被多条已录取报名占用）。 */
  counts: Map<number, number>;
  /** counts 的位图缓存：被占用赛道的 bit 并集。 */
  mask: bigint;
}

/**
 * 确定性候补引擎。
 *
 * 递补规则等价于：反复在全部候补中取“当前可整体录取且创建序号最小”的一条录取，
 * 直到不存在可录取候补。实现不为每次操作扫描全部候补，而是维护：
 *  - readyHeap：按序号排序的“可能可录取”候补（提示结构，弹出时完整复检）；
 *  - 容量索引：未因成员冲突阻塞的候补，按赛道 + 团队人数分桶，容量从 f1 增至 f2
 *    时只访问人数落在 (f1, f2] 桶内的条目；
 *  - 成员阻塞索引：因成员冲突阻塞的候补，按其成员反查，仅在这些成员的占用
 *    状态变化（撤回已录取报名）时被访问。
 * 录取只会消耗容量与成员资格，不可能让原本不可录取的候补变为可录取，因此
 * 只需在“容量增加 / 成员释放 / 新增候补”三类事件上触发上述索引。
 */
export class WaitlistEngine {
  private trackIdxById = new Map<TrackId, number>();
  private trackIds: TrackId[] = [];
  private capacities: number[] = [];
  private free: number[] = [];
  /** 每条赛道的冲突位图（含自身 bit）。 */
  private conflictMask: bigint[] = [];

  private regs = new Map<RegistrationId, Reg>();
  private lastSeq = 0;

  private occupancy = new Map<MemberId, MemberOccupancy>();
  /** 成员 -> 因该成员（可能还含其他成员）冲突而阻塞的候补 id 集合。 */
  private memberBlockedIndex = new Map<MemberId, Set<RegistrationId>>();
  /** 赛道 -> 人数(1..20) -> 候补 id 集合。 */
  private capIndex: Array<Array<Set<RegistrationId>>> = [];

  private readyHeap = new MinHeap();

  private statRechecks = 0;
  private statIndexedVisited = 0;

  constructor(
    tracks: TrackSpec[],
    conflicts: ReadonlyArray<readonly [TrackId, TrackId]>,
  ) {
    if (tracks.length === 0 || tracks.length > MAX_TRACKS) {
      throw new Error(`track count must be 1..${MAX_TRACKS}`);
    }
    for (const t of tracks) {
      if (this.trackIdxById.has(t.id)) throw new Error(`duplicate track: ${t.id}`);
      if (!Number.isInteger(t.capacity) || t.capacity < 0) {
        throw new Error(`invalid capacity for track ${t.id}`);
      }
      const idx = this.trackIds.length;
      this.trackIdxById.set(t.id, idx);
      this.trackIds.push(t.id);
      this.capacities.push(t.capacity);
      this.free.push(t.capacity);
      this.conflictMask.push(1n << BigInt(idx));
      this.capIndex.push(Array.from({ length: MAX_TEAM_SIZE + 1 }, () => new Set()));
    }
    for (const [a, b] of conflicts) {
      const ia = this.trackIndexOf(a);
      const ib = this.trackIndexOf(b);
      this.conflictMask[ia]! |= 1n << BigInt(ib);
      this.conflictMask[ib]! |= 1n << BigInt(ia);
    }
  }

  register(trackId: TrackId, memberIds: readonly MemberId[]): RegistrationId {
    const trackIdx = this.trackIndexOf(trackId);
    if (
      memberIds.length === 0 ||
      memberIds.length > MAX_TEAM_SIZE ||
      new Set(memberIds).size !== memberIds.length
    ) {
      throw new Error("memberIds must be 1..20 unique members");
    }
    const id = ++this.lastSeq;
    const reg: Reg = {
      id,
      seq: id,
      trackIdx,
      memberIds: Object.freeze([...memberIds]),
      size: memberIds.length,
      status: "waiting",
      memBlocked: false,
      inCapIndex: false,
    };
    this.regs.set(id, reg);
    if (this.isMemberBlocked(reg)) {
      this.addToMemberIndex(reg);
    } else {
      this.addToCapIndex(reg);
      if (reg.size <= this.free[trackIdx]!) this.readyHeap.push(reg.seq, id);
    }
    this.promote();
    return id;
  }

  withdraw(id: RegistrationId): void {
    const reg = this.regs.get(id);
    if (!reg) throw new Error(`unknown registration: ${id}`);
    if (reg.status === "withdrawn") throw new Error(`already withdrawn: ${id}`);

    const wasAdmitted = reg.status === "admitted";
    reg.status = "withdrawn";
    this.detachFromIndexes(reg);

    if (wasAdmitted) {
      const trackIdx = reg.trackIdx;
      const oldFree = this.free[trackIdx]!;
      this.free[trackIdx] = oldFree + reg.size;
      const newFree = this.free[trackIdx]!;
      for (const m of reg.memberIds) this.releaseMember(m, trackIdx);
      // 容量窗口触发：只有人数落在 (oldFree, newFree] 的候补可能因此变为容量可行。
      const buckets = this.capIndex[trackIdx]!;
      for (let size = oldFree + 1; size <= Math.min(newFree, MAX_TEAM_SIZE); size++) {
        for (const candId of buckets[size]!) {
          this.statIndexedVisited++;
          const cand = this.regs.get(candId)!;
          if (cand.status !== "waiting" || !cand.inCapIndex) continue;
          this.readyHeap.push(cand.seq, cand.id);
        }
      }
      // 成员释放触发：只访问占用状态发生变化的成员所关联的候补。
      const candidates = new Set<RegistrationId>();
      for (const m of reg.memberIds) {
        const set = this.memberBlockedIndex.get(m);
        if (!set) continue;
        for (const candId of set) {
          this.statIndexedVisited++;
          candidates.add(candId);
        }
      }
      for (const candId of candidates) {
        const cand = this.regs.get(candId)!;
        if (cand.status !== "waiting" || !cand.memBlocked) continue;
        if (!this.isMemberBlocked(cand)) {
          this.removeFromMemberIndex(cand);
          this.addToCapIndex(cand);
          if (cand.size <= this.free[cand.trackIdx]!) {
            this.readyHeap.push(cand.seq, cand.id);
          }
        }
      }
    }
    this.promote();
  }

  inspect(): Inspection {
    const registrations = [...this.regs.values()].map((r) => ({
      id: r.id,
      seq: r.seq,
      trackId: this.trackIds[r.trackIdx]!,
      memberIds: r.memberIds,
      status: r.status,
    }));
    const tracks = this.trackIds.map((id, i) => ({
      id,
      capacity: this.capacities[i]!,
      occupied: this.capacities[i]! - this.free[i]!,
    }));
    return { registrations, tracks };
  }

  get stats(): EngineStats {
    return {
      rechecks: this.statRechecks,
      indexedEntriesVisited: this.statIndexedVisited,
    };
  }

  /** 反复录取当前可整体录取且序号最小的候补，直到没有可录取候补。 */
  private promote(): void {
    for (;;) {
      const top = this.readyHeap.peek();
      if (!top) return;
      const reg = this.regs.get(top.id);
      if (!reg || reg.status !== "waiting") {
        this.readyHeap.pop();
        continue;
      }
      this.statRechecks++;
      if (reg.size <= this.free[reg.trackIdx]! && !this.isMemberBlocked(reg)) {
        this.readyHeap.pop();
        this.admit(reg);
        continue;
      }
      // 不可录取：出堆并重新归类，等待未来的触发事件再次入堆。
      this.readyHeap.pop();
      if (this.isMemberBlocked(reg)) {
        if (reg.inCapIndex) this.removeFromCapIndex(reg);
        this.addToMemberIndex(reg);
      }
      // 仅容量不足：留在容量索引中，等容量窗口触发。
    }
  }

  private admit(reg: Reg): void {
    reg.status = "admitted";
    this.free[reg.trackIdx] = this.free[reg.trackIdx]! - reg.size;
    if (reg.inCapIndex) this.removeFromCapIndex(reg);
    for (const m of reg.memberIds) {
      let occ = this.occupancy.get(m);
      if (!occ) {
        occ = { counts: new Map(), mask: 0n };
        this.occupancy.set(m, occ);
      }
      const prev = occ.counts.get(reg.trackIdx) ?? 0;
      occ.counts.set(reg.trackIdx, prev + 1);
      occ.mask |= 1n << BigInt(reg.trackIdx);
    }
  }

  private releaseMember(member: MemberId, trackIdx: number): void {
    const occ = this.occupancy.get(member);
    if (!occ) return;
    const prev = occ.counts.get(trackIdx);
    if (prev === undefined) return;
    if (prev === 1) {
      occ.counts.delete(trackIdx);
      occ.mask &= ~(1n << BigInt(trackIdx));
    } else {
      occ.counts.set(trackIdx, prev - 1);
    }
  }

  /** 某位成员当前已录取占用的赛道集合是否与该候补赛道冲突（含同赛道）。 */
  private memberConflicts(member: MemberId, trackIdx: number): boolean {
    const occ = this.occupancy.get(member);
    if (!occ) return false;
    return (occ.mask & this.conflictMask[trackIdx]!) !== 0n;
  }

  private isMemberBlocked(reg: Reg): boolean {
    for (const m of reg.memberIds) {
      if (this.memberConflicts(m, reg.trackIdx)) return true;
    }
    return false;
  }

  private addToMemberIndex(reg: Reg): void {
    reg.memBlocked = true;
    for (const m of reg.memberIds) {
      let set = this.memberBlockedIndex.get(m);
      if (!set) {
        set = new Set();
        this.memberBlockedIndex.set(m, set);
      }
      set.add(reg.id);
    }
  }

  private removeFromMemberIndex(reg: Reg): void {
    reg.memBlocked = false;
    for (const m of reg.memberIds) {
      const set = this.memberBlockedIndex.get(m);
      if (set) {
        set.delete(reg.id);
        if (set.size === 0) this.memberBlockedIndex.delete(m);
      }
    }
  }

  private addToCapIndex(reg: Reg): void {
    reg.inCapIndex = true;
    this.capIndex[reg.trackIdx]![reg.size]!.add(reg.id);
  }

  private removeFromCapIndex(reg: Reg): void {
    reg.inCapIndex = false;
    this.capIndex[reg.trackIdx]![reg.size]!.delete(reg.id);
  }

  private detachFromIndexes(reg: Reg): void {
    if (reg.memBlocked) this.removeFromMemberIndex(reg);
    if (reg.inCapIndex) this.removeFromCapIndex(reg);
  }

  private trackIndexOf(id: TrackId): number {
    const idx = this.trackIdxById.get(id);
    if (idx === undefined) throw new Error(`unknown track: ${id}`);
    return idx;
  }
}
