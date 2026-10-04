import {
  Inspection,
  MemberId,
  RegistrationId,
  RegistrationStatus,
  TrackId,
  TrackSpec,
} from "../src/types";

interface RefReg {
  id: RegistrationId;
  seq: number;
  trackId: TrackId;
  memberIds: readonly MemberId[];
  status: RegistrationStatus;
}

/**
 * 参考模型：每次操作后全量扫描候补，反复录取“可整体录取且序号最小”者。
 * 只追求明显正确，不追求效率；生产实现不得借用此代码。
 */
export class ReferenceEngine {
  private capacity = new Map<TrackId, number>();
  private occupied = new Map<TrackId, number>();
  private conflicts = new Map<TrackId, Set<TrackId>>();
  private regs: RefReg[] = [];
  private lastSeq = 0;

  constructor(
    tracks: TrackSpec[],
    conflicts: ReadonlyArray<readonly [TrackId, TrackId]>,
  ) {
    for (const t of tracks) {
      this.capacity.set(t.id, t.capacity);
      this.occupied.set(t.id, 0);
      this.conflicts.set(t.id, new Set([t.id]));
    }
    for (const [a, b] of conflicts) {
      this.conflicts.get(a)!.add(b);
      this.conflicts.get(b)!.add(a);
    }
  }

  register(trackId: TrackId, memberIds: readonly MemberId[]): RegistrationId {
    const id = ++this.lastSeq;
    this.regs.push({
      id,
      seq: id,
      trackId,
      memberIds: Object.freeze([...memberIds]),
      status: "waiting",
    });
    this.promote();
    return id;
  }

  withdraw(id: RegistrationId): void {
    const reg = this.regs.find((r) => r.id === id);
    if (!reg) throw new Error(`unknown registration: ${id}`);
    if (reg.status === "withdrawn") throw new Error(`already withdrawn: ${id}`);
    if (reg.status === "admitted") {
      this.occupied.set(
        reg.trackId,
        this.occupied.get(reg.trackId)! - reg.memberIds.length,
      );
    }
    reg.status = "withdrawn";
    this.promote();
  }

  inspect(): Inspection {
    return {
      registrations: this.regs.map((r) => ({
        id: r.id,
        seq: r.seq,
        trackId: r.trackId,
        memberIds: r.memberIds,
        status: r.status,
      })),
      tracks: [...this.capacity.keys()].map((id) => ({
        id,
        capacity: this.capacity.get(id)!,
        occupied: this.occupied.get(id)!,
      })),
    };
  }

  private promote(): void {
    for (;;) {
      let best: RefReg | undefined;
      for (const reg of this.regs) {
        if (reg.status !== "waiting") continue;
        if (!this.canAdmit(reg)) continue;
        if (!best || reg.seq < best.seq) best = reg;
      }
      if (!best) return;
      best.status = "admitted";
      this.occupied.set(
        best.trackId,
        this.occupied.get(best.trackId)! + best.memberIds.length,
      );
    }
  }

  private canAdmit(reg: RefReg): boolean {
    const free =
      this.capacity.get(reg.trackId)! - this.occupied.get(reg.trackId)!;
    if (reg.memberIds.length > free) return false;
    for (const m of reg.memberIds) {
      for (const other of this.regs) {
        if (other.status !== "admitted") continue;
        if (!other.memberIds.includes(m)) continue;
        if (this.conflicts.get(reg.trackId)!.has(other.trackId)) return false;
      }
    }
    return true;
  }
}
