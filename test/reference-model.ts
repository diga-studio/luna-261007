import type {
  EngineSnapshot,
  MemberId,
  RegistrationStatus,
} from "../src/types.ts";

interface RefRecord {
  id: number;
  seq: number;
  trackId: number;
  memberIds: readonly MemberId[];
  status: RegistrationStatus;
}

/**
 * 参考模型：直接按规格用全量扫描实现，正确性优先、不计性能。
 * 每次变更后重复扫描全部候补，录取当前可整体录取且序号最小者，直到无可录取。
 */
export class ReferenceModel {
  private readonly capacities: number[];
  private readonly conflicts: ReadonlyArray<readonly [number, number]>;
  private readonly records: RefRecord[] = [];
  private nextSeq = 0;

  constructor(capacities: readonly number[], conflicts: ReadonlyArray<readonly [number, number]>) {
    this.capacities = [...capacities];
    this.conflicts = conflicts;
  }

  register(trackId: number, memberIds: readonly MemberId[]): number {
    const id = this.nextSeq;
    this.records.push({
      id,
      seq: this.nextSeq,
      trackId,
      memberIds: [...memberIds],
      status: "waitlisted",
    });
    this.nextSeq += 1;
    this.promote();
    return id;
  }

  withdraw(registrationId: number): void {
    const record = this.records[registrationId];
    if (!record || record.status === "withdrawn") {
      throw new Error(`unknown or already withdrawn registration: ${registrationId}`);
    }
    record.status = "withdrawn";
    this.promote();
  }

  inspect(): EngineSnapshot {
    const occupied = this.capacities.map(() => 0);
    for (const record of this.records) {
      if (record.status === "admitted") {
        occupied[record.trackId] =
          (occupied[record.trackId] as number) + record.memberIds.length;
      }
    }
    return {
      registrations: this.records.map((record) => ({
        id: record.id,
        seq: record.seq,
        trackId: record.trackId,
        memberIds: [...record.memberIds],
        status: record.status,
      })),
      tracks: this.capacities.map((capacity, trackId) => ({
        trackId,
        capacity,
        occupied: occupied[trackId] as number,
      })),
    };
  }

  private tracksConflict(a: number, b: number): boolean {
    if (a === b) return true;
    return this.conflicts.some(
      ([x, y]) => (x === a && y === b) || (x === b && y === a),
    );
  }

  private admissible(record: RefRecord): boolean {
    const occupied = this.capacities.map(() => 0);
    for (const other of this.records) {
      if (other.status === "admitted") {
        occupied[other.trackId] =
          (occupied[other.trackId] as number) + other.memberIds.length;
      }
    }
    if (
      (occupied[record.trackId] as number) + record.memberIds.length >
      (this.capacities[record.trackId] as number)
    ) {
      return false;
    }
    for (const member of record.memberIds) {
      for (const other of this.records) {
        if (other.status !== "admitted") continue;
        if (!other.memberIds.includes(member)) continue;
        if (this.tracksConflict(other.trackId, record.trackId)) return false;
      }
    }
    return true;
  }

  private promote(): void {
    for (;;) {
      let best: RefRecord | undefined;
      for (const record of this.records) {
        if (record.status !== "waitlisted") continue;
        if (best && record.seq >= best.seq) continue;
        if (this.admissible(record)) best = record;
      }
      if (!best) return;
      best.status = "admitted";
    }
  }
}
