import { test } from "node:test";
import assert from "node:assert/strict";
import { SlotAllocator } from "../src/index.ts";
import { ReferenceAllocator } from "./reference.ts";
import type { CalendarSegment, DoctorId, Duration } from "../src/types.ts";

/** Deterministic PRNG (mulberry32) so failures reproduce exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DURATIONS: Duration[] = [15, 30, 60];

function randomCalendar(rand: () => number, span: number): CalendarSegment[] {
  const segs: CalendarSegment[] = [];
  let cursor = 0;
  while (cursor < span) {
    cursor += Math.floor(rand() * 30); // unopened gap
    if (cursor >= span) break;
    const len = 5 + Math.floor(rand() * 120);
    const capacity = 1 + Math.floor(rand() * 8);
    segs.push({ start: cursor, end: Math.min(cursor + len, span), capacity });
    cursor += len;
  }
  return segs;
}

function runScenario(seed: number, doctorIds: string[], span: number, ops: number): void {
  {
    const rand = rng(seed);
    const SPAN = span;
    const OPS = ops;
    const real = new SlotAllocator();
    const ref = new ReferenceAllocator();
    const doctors = doctorIds;
    const calendars = new Map<DoctorId, CalendarSegment[]>();
    for (const d of doctors) {
      const cal = randomCalendar(rand, SPAN);
      calendars.set(d, cal);
      real.setCalendar(d, cal);
      ref.setCalendar(d, cal);
    }
    const live: { realId: string; refId: string }[] = [];
    const dead: { realId: string; refId: string }[] = [];
    for (let op = 0; op < OPS; op++) {
      const doctor = doctors[Math.floor(rand() * doctors.length)]!;
      const kind = rand();
      if (kind < 0.45) {
        const qs = Math.floor(rand() * (SPAN + 50));
        const qe = qs + Math.floor(rand() * (SPAN + 50));
        const dur = DURATIONS[Math.floor(rand() * 3)]!;
        const got = real.findEarliest(doctor, qs, qe, dur);
        const want = ref.findEarliest(doctor, qs, qe, dur);
        assert.equal(got, want, `seed=${seed} op=${op} query ${doctor} [${qs},${qe}) dur=${dur}`);
      } else if (kind < 0.8) {
        const start = Math.floor(rand() * (SPAN + 30));
        const dur = DURATIONS[Math.floor(rand() * 3)]!;
        const got = real.book(doctor, start, dur);
        const want = ref.book(doctor, start, dur);
        assert.equal(got !== null, want !== null, `seed=${seed} op=${op} book ${doctor} @${start} dur=${dur}`);
        if (got !== null && want !== null) live.push({ realId: got, refId: want });
      } else {
        const pick = rand();
        if (pick < 0.6 && live.length > 0) {
          const idx = Math.floor(rand() * live.length);
          const pair = live.splice(idx, 1)[0]!;
          assert.equal(real.cancel(pair.realId), true, `seed=${seed} op=${op} cancel`);
          assert.equal(ref.cancel(pair.refId), true);
          dead.push(pair);
        } else if (pick < 0.85 && dead.length > 0) {
          const pair = dead[Math.floor(rand() * dead.length)]!;
          assert.equal(real.cancel(pair.realId), false, `seed=${seed} op=${op} double cancel`);
          assert.equal(ref.cancel(pair.refId), false);
        } else {
          assert.equal(real.cancel(`nope-${seed}-${op}`), false);
        }
      }
    }
    // Cancel everything still live.
    while (live.length > 0) {
      const pair = live.pop()!;
      assert.equal(real.cancel(pair.realId), true, `seed=${seed} final cancel`);
      assert.equal(ref.cancel(pair.refId), true);
    }
    // Queries must now match a fresh allocator holding only the initial calendars.
    const fresh = new SlotAllocator();
    for (const d of doctors) fresh.setCalendar(d, calendars.get(d)!);
    for (let q = 0; q < 50; q++) {
      const doctor = doctors[Math.floor(rand() * doctors.length)]!;
      const qs = Math.floor(rand() * (SPAN + 50));
      const qe = qs + Math.floor(rand() * (SPAN + 50));
      const dur = DURATIONS[Math.floor(rand() * 3)]!;
      const got = real.findEarliest(doctor, qs, qe, dur);
      const want = fresh.findEarliest(doctor, qs, qe, dur);
      assert.equal(got, want, `seed=${seed} restore-check ${doctor} [${qs},${qe}) dur=${dur}`);
    }
  }
}

test("random interleaved operations match the per-minute reference", () => {
  for (let seed = 1; seed <= 40; seed++) {
    runScenario(seed, ["a", "b", "c"], 400, 400);
  }
});

test("random operations across many blocks match the reference", () => {
  // One doctor, long timeline, enough bookings to force block splits.
  for (let seed = 101; seed <= 108; seed++) {
    runScenario(seed, ["hot"], 3000, 1500);
  }
});
