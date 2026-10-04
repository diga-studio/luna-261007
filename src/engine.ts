import type {
  EngineConfig,
  EngineDiagnostics,
  EngineSnapshot,
  MemberId,
  RegistrationStatus,
} from "./types.ts";
import { MinHeap } from "./heap.ts";

const MAX_TRACKS = 64;
const MAX_TEAM_SIZE = 20;

interface RegistrationRecord {
  id: number;
  seq: number;
  trackId: number;
  memberIds: readonly MemberId[];
  status: RegistrationStatus;
  /**
   * 该候补当前被多少“成员占用”阻断：
   * 每存在一对（本队成员 m，已录取报名 a）满足 m 属于 a 且 a 所在赛道与本报名赛道冲突，计数加一。
   * 大于 0 时必定不可录取；归零时进入对应赛道的 ready 集合。
   * 注意按（成员, 已录取报名）对计数而非按成员计数，
   * 这样录取/撤回时的增量增减才能精确对冲（冲突非传递时，
   * 同一成员可能同时录取在多条与本赛道冲突的赛道上）。
   */
  memberBlocks: number;
}

/**
 * 团队报名候补引擎：进程内、串行调用、无持久化。
 * 每次 register/withdraw 返回前完成确定性递补。
 *
 * 递补通过“候选最小堆 + 惰性失效”实现：
 * 只有占用状态发生变化的成员所关联的候补、以及容量被释放赛道上
 * 当前无成员阻断的候补，才会被重新投入候选堆。
 */
export class WaitlistEngine {
  /** 诊断计数（只读视图，用于测试与性能验证）。 */
  readonly diagnostics: EngineDiagnostics = {
    candidatesPushed: 0,
    candidatesPopped: 0,
    memberBlockUpdates: 0,
  };

  private readonly capacities: number[];
  private readonly occupied: number[];
  /** 每条赛道的冲突位掩码（含自身位），最多 64 条赛道。 */
  private readonly conflictMask: bigint[];

  private readonly records = new Map<number, RegistrationRecord>();
  /** 成员 -> 含该成员的候递补报名 id 集合。 */
  private readonly waitlistedByMember = new Map<MemberId, Set<number>>();
  /** 成员 -> 含该成员的已录取报名 id 集合。 */
  private readonly admittedByMember = new Map<MemberId, Set<number>>();
  /** 每条赛道上 memberBlocks 为 0 的候补（容量维度的候选集）。 */
  private readonly readyByTrack: Array<Set<number>>;

  private readonly heap = new MinHeap();
  private readonly inHeap = new Set<number>();

  private nextSeq = 0;

  constructor(config: EngineConfig) {
    const { capacities, conflicts = [] } = config;
    if (capacities.length === 0 || capacities.length > MAX_TRACKS) {
      throw new Error(`track count must be 1..${MAX_TRACKS}`);
    }
    for (const cap of capacities) {
      if (!Number.isInteger(cap) || cap < 0) {
        throw new Error("capacity must be a non-negative integer");
      }
    }
    this.capacities = [...capacities];
    this.occupied = capacities.map(() => 0);
    this.conflictMask = capacities.map((_, i) => 1n << BigInt(i));
    for (const [a, b] of conflicts) {
      this.assertTrack(a);
      this.assertTrack(b);
      (this.conflictMask[a] as bigint) |= 1n << BigInt(b);
      (this.conflictMask[b] as bigint) |= 1n << BigInt(a);
    }
    this.readyByTrack = capacities.map(() => new Set<number>());
  }

  /** 创建报名，返回报名标识；完成递补后返回。 */
  register(trackId: number, memberIds: readonly MemberId[]): number {
    this.assertTrack(trackId);
    if (memberIds.length === 0 || memberIds.length > MAX_TEAM_SIZE) {
      throw new Error(`team size must be 1..${MAX_TEAM_SIZE}`);
    }
    if (new Set(memberIds).size !== memberIds.length) {
      throw new Error("memberIds must not contain duplicates");
    }

    const id = this.nextSeq;
    const record: RegistrationRecord = {
      id,
      seq: this.nextSeq,
      trackId,
      memberIds: [...memberIds],
      status: "waitlisted",
      memberBlocks: 0,
    };
    this.nextSeq += 1;
    this.records.set(id, record);

    for (const member of memberIds) {
      this.addToIndex(this.waitlistedByMember, member, id);
      record.memberBlocks += this.countMemberConflicts(member, trackId);
    }
    if (record.memberBlocks === 0) {
      (this.readyByTrack[trackId] as Set<number>).add(id);
      this.pushCandidate(record);
    }

    this.promote();
    return id;
  }

  /** 撤回候补或已录取报名；完成递补后返回。 */
  withdraw(registrationId: number): void {
    const record = this.records.get(registrationId);
    if (!record || record.status === "withdrawn") {
      throw new Error(`unknown or already withdrawn registration: ${registrationId}`);
    }

    if (record.status === "waitlisted") {
      record.status = "withdrawn";
      this.detachWaitlisted(record);
      return;
    }

    record.status = "withdrawn";
    (this.occupied as number[])[record.trackId] =
      (this.occupied[record.trackId] as number) - record.memberIds.length;

    for (const member of record.memberIds) {
      const admitted = this.admittedByMember.get(member);
      admitted?.delete(record.id);
      if (admitted && admitted.size === 0) this.admittedByMember.delete(member);

      const affected = this.waitlistedByMember.get(member);
      if (!affected) continue;
      for (const otherId of affected) {
        const other = this.records.get(otherId);
        if (!other) continue;
        if (!this.tracksConflict(record.trackId, other.trackId)) continue;
        other.memberBlocks -= 1;
        this.diagnostics.memberBlockUpdates += 1;
        if (other.memberBlocks === 0) {
          (this.readyByTrack[other.trackId] as Set<number>).add(otherId);
          this.pushCandidate(other);
        }
      }
    }

    // 容量被释放的赛道上，所有无成员阻断的候补都可能变为可录取。
    for (const readyId of this.readyByTrack[record.trackId] as Set<number>) {
      const ready = this.records.get(readyId);
      if (ready) this.pushCandidate(ready);
    }

    this.promote();
  }

  /** 读取状态快照，不改变引擎状态。 */
  inspect(): EngineSnapshot {
    const registrations = [...this.records.values()].map((record) => ({
      id: record.id,
      seq: record.seq,
      trackId: record.trackId,
      memberIds: [...record.memberIds],
      status: record.status,
    }));
    const tracks = this.capacities.map((capacity, trackId) => ({
      trackId,
      capacity,
      occupied: this.occupied[trackId] as number,
    }));
    return { registrations, tracks };
  }

  /**
   * 确定性递补：反复从候选堆中取出创建序号最小的候补，
   * 精确判定后录取；判定失败的条目被丢弃出堆，
   * 之后若其阻断因素消除会被重新投入。堆空即不存在可录取候补。
   */
  private promote(): void {
    for (;;) {
      const id = this.heap.pop();
      if (id === undefined) return;
      this.inHeap.delete(id);
      this.diagnostics.candidatesPopped += 1;
      const record = this.records.get(id);
      if (!record || record.status !== "waitlisted") continue;
      if (record.memberBlocks > 0) continue;
      const occupied = this.occupied[record.trackId] as number;
      const capacity = this.capacities[record.trackId] as number;
      if (occupied + record.memberIds.length > capacity) continue;
      this.admit(record);
    }
  }

  private admit(record: RegistrationRecord): void {
    record.status = "admitted";
    (this.occupied as number[])[record.trackId] =
      (this.occupied[record.trackId] as number) + record.memberIds.length;
    (this.readyByTrack[record.trackId] as Set<number>).delete(record.id);

    for (const member of record.memberIds) {
      const waitlisted = this.waitlistedByMember.get(member);
      waitlisted?.delete(record.id);
      if (waitlisted && waitlisted.size === 0) {
        this.waitlistedByMember.delete(member);
      }
      this.addToIndex(this.admittedByMember, member, record.id);

      const affected = this.waitlistedByMember.get(member);
      if (!affected) continue;
      for (const otherId of affected) {
        const other = this.records.get(otherId);
        if (!other) continue;
        if (!this.tracksConflict(record.trackId, other.trackId)) continue;
        other.memberBlocks += 1;
        this.diagnostics.memberBlockUpdates += 1;
        if (other.memberBlocks === 1) {
          (this.readyByTrack[other.trackId] as Set<number>).delete(otherId);
        }
      }
    }
  }

  private detachWaitlisted(record: RegistrationRecord): void {
    (this.readyByTrack[record.trackId] as Set<number>).delete(record.id);
    for (const member of record.memberIds) {
      const waitlisted = this.waitlistedByMember.get(member);
      waitlisted?.delete(record.id);
      if (waitlisted && waitlisted.size === 0) {
        this.waitlistedByMember.delete(member);
      }
    }
  }

  private pushCandidate(record: RegistrationRecord): void {
    if (this.inHeap.has(record.id)) return;
    this.inHeap.add(record.id);
    this.heap.push(record.id, record.seq);
    this.diagnostics.candidatesPushed += 1;
  }

  private countMemberConflicts(member: MemberId, trackId: number): number {
    const admitted = this.admittedByMember.get(member);
    if (!admitted) return 0;
    let count = 0;
    for (const otherId of admitted) {
      const other = this.records.get(otherId);
      if (other && this.tracksConflict(other.trackId, trackId)) count += 1;
    }
    return count;
  }

  private tracksConflict(a: number, b: number): boolean {
    return (((this.conflictMask[a] as bigint) >> BigInt(b)) & 1n) !== 0n;
  }

  private addToIndex(
    index: Map<MemberId, Set<number>>,
    member: MemberId,
    id: number,
  ): void {
    let set = index.get(member);
    if (!set) {
      set = new Set<number>();
      index.set(member, set);
    }
    set.add(id);
  }

  private assertTrack(trackId: number): void {
    if (
      !Number.isInteger(trackId) ||
      trackId < 0 ||
      trackId >= this.capacities.length
    ) {
      throw new Error(`unknown track: ${trackId}`);
    }
  }
}
