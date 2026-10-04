/**
 * Stress test at the required scale:
 *  - 100 doctors, 2000 open-calendar segments total, 20-year spans
 *  - 200k active bookings, heavily concentrated on one "hot" doctor whose
 *    dense region is littered with gaps shorter than any duration
 *  - measured phase: 50k queries interleaved with 10k successful
 *    books/cancels; must finish within 15s and 384 MiB peak RSS
 *  - every returned hot-doctor slot is verified against an independent
 *    per-minute occupancy model; sampled queries are also checked for
 *    "no earlier answer" by a direct minute scan
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { SlotAllocator, type CalendarSegment, type Duration, DURATIONS } from "../src/index";
import { Rng } from "./util";

const MiB = 1024 * 1024;
const YEAR_MINUTES = 365 * 24 * 60;
const SPAN = 20 * YEAR_MINUTES; // 20 years in minutes
const DOCTOR_COUNT = 100;
const SEGMENTS_PER_DOCTOR = 20;
const TOTAL_BOOKINGS = 200_000;
const HOT_BOOKINGS = 150_000;
const HOT_DENSE_MINUTES = 700_000; // ~16 months of dense booking
const QUERY_COUNT = 50_000;
const MUTATION_COUNT = 10_000;
const TIME_BUDGET_MS = 15_000;
const RSS_BUDGET = 384 * MiB;

const HOT_DOCTOR = "doctor-0";

function buildCalendars(rng: Rng): Map<string, CalendarSegment[]> {
  const calendars = new Map<string, CalendarSegment[]>();
  for (let d = 0; d < DOCTOR_COUNT; d++) {
    const id = `doctor-${d}`;
    const segments: CalendarSegment[] = [];
    // 20 touching year-long segments covering the whole 20-year span.
    for (let s = 0; s < SEGMENTS_PER_DOCTOR; s++) {
      const start = s * YEAR_MINUTES;
      const capacity = d === 0 ? 8 : rng.int(1, 9);
      segments.push({ start, end: start + YEAR_MINUTES, capacity });
    }
    calendars.set(id, segments);
  }
  return calendars;
}

test("stress: 100 doctors, 2000 segments, 200k bookings, 60k mixed ops", () => {
  const rng = new Rng(0x5eed);
  const calendars = buildCalendars(rng);

  // ---- initialization (reported, not part of the measured phase) ----
  const initStart = performance.now();
  const allocator = new SlotAllocator();
  for (const [id, segments] of calendars) allocator.addDoctor(id, segments);

  // Independent per-minute model of the hot doctor for verification.
  const hotCap = new Uint8Array(SPAN);
  const hotOcc = new Uint8Array(SPAN);
  for (const seg of calendars.get(HOT_DOCTOR) as CalendarSegment[]) {
    hotCap.fill(seg.capacity, seg.start, seg.end);
  }

  const activeByDoctor = new Map<string, string[]>();
  const bookingSpan = new Map<string, [string, number, Duration]>();
  const recordActive = (doctorId: string, bookingId: string, start: number, duration: Duration) => {
    let list = activeByDoctor.get(doctorId);
    if (list === undefined) {
      list = [];
      activeByDoctor.set(doctorId, list);
    }
    list.push(bookingId);
    bookingSpan.set(bookingId, [doctorId, start, duration]);
    if (doctorId === HOT_DOCTOR) {
      for (let m = start; m < start + duration; m++) hotOcc[m] = (hotOcc[m] as number) + 1;
    }
  };

  // Hot doctor: 8 capacity "lanes" swept over the dense region, leaving
  // many gaps shorter than 15/30/60 minutes between bookings.
  let hotBooked = 0;
  for (let lane = 0; lane < 8; lane++) {
    let cursor = lane * 7; // desynchronize lanes
    while (cursor + 60 < HOT_DENSE_MINUTES && hotBooked < HOT_BOOKINGS) {
      const duration = rng.pick(DURATIONS);
      const id = allocator.book(HOT_DOCTOR, cursor, duration);
      assert.ok(id !== null, `hot lane booking should succeed at ${cursor}`);
      recordActive(HOT_DOCTOR, id, cursor, duration);
      hotBooked += 1;
      cursor += duration;
      const roll = rng.int(0, 10);
      if (roll < 3) cursor += rng.int(1, 15); // gap shorter than any duration
      else if (roll < 4) cursor += rng.int(15, 45); // gap hosts only short bookings
    }
  }
  // Remaining bookings spread over the other 99 doctors.
  let totalBooked = hotBooked;
  while (totalBooked < TOTAL_BOOKINGS) {
    const doctorId = `doctor-${rng.int(1, DOCTOR_COUNT)}`;
    const duration = rng.pick(DURATIONS);
    const start = rng.int(0, SPAN - duration);
    const id = allocator.book(doctorId, start, duration);
    if (id !== null) {
      recordActive(doctorId, id, start, duration);
      totalBooked += 1;
    }
  }
  const initMs = performance.now() - initStart;

  // ---- measured phase: 50k queries + 10k successful mutations ----
  // Freed intervals come from the initial compatible booking set, so
  // rebooking any of them is guaranteed to succeed.
  const freed: Array<[string, number, Duration]> = [];
  let peakRss = process.memoryUsage().rss;
  let queriesDone = 0;
  let mutationsDone = 0;
  let availabilityChecks = 0;
  let earliestChecks = 0;

  const measuredStart = performance.now();
  const totalOps = QUERY_COUNT + MUTATION_COUNT;
  for (let op = 0; op < totalOps; op++) {
    const doQuery = op % 6 !== 5; // 5 queries per mutation
    if (doQuery) {
      const duration = rng.pick(DURATIONS);
      const roll = rng.int(0, 10);
      let doctorId: string;
      let qs: number;
      let qe: number;
      if (roll < 6) {
        // Dense-region query on the hot doctor.
        doctorId = HOT_DOCTOR;
        qs = rng.int(0, HOT_DENSE_MINUTES);
        qe = qs + rng.int(0, Math.min(SPAN - qs, 200_000));
      } else if (roll < 8) {
        // Wide-range query on the hot doctor.
        doctorId = HOT_DOCTOR;
        qs = rng.int(0, SPAN - 1);
        qe = qs + rng.int(0, SPAN - qs);
      } else {
        doctorId = `doctor-${rng.int(1, DOCTOR_COUNT)}`;
        qs = rng.int(0, SPAN - 1);
        qe = qs + rng.int(0, SPAN - qs);
      }
      const answer = allocator.findEarliest(doctorId, qs, qe, duration);
      queriesDone += 1;
      if (doctorId === HOT_DOCTOR && answer !== null) {
        // Returned slot must be truly available on every minute.
        assert.ok(answer >= qs && answer + duration <= qe, "answer inside query range");
        for (let m = answer; m < answer + duration; m++) {
          assert.ok(
            (hotOcc[m] as number) < (hotCap[m] as number),
            `minute ${m} of returned slot is full`,
          );
        }
        availabilityChecks += 1;
        // Sampled full check: no earlier answer exists.
        if (earliestChecks < 200 && answer - qs <= 1_000_000 && rng.int(0, 10) === 0) {
          let lastBad = qs - 1;
          let want: number | null = null;
          for (let m = qs; m < answer + duration; m++) {
            if ((hotOcc[m] as number) >= (hotCap[m] as number)) lastBad = m;
            const s = m + 1 - duration;
            if (s >= qs && s > lastBad) {
              want = s;
              break;
            }
          }
          assert.equal(answer, want, "no earlier feasible start may exist");
          earliestChecks += 1;
        }
      }
    } else {
      // Mutation: rebook a freed interval, or cancel a random active booking.
      const doctorId = rng.int(0, 4) === 0 ? `doctor-${rng.int(1, DOCTOR_COUNT)}` : HOT_DOCTOR;
      const freedIndex = freed.findIndex((f) => f[0] === doctorId);
      if (freedIndex >= 0 && rng.int(0, 2) === 0) {
        const [, start, duration] = freed.splice(freedIndex, 1)[0] as [string, number, Duration];
        const id = allocator.book(doctorId, start, duration);
        assert.ok(id !== null, "rebooking a freed interval must succeed");
        recordActive(doctorId, id, start, duration);
      } else {
        const list = activeByDoctor.get(doctorId);
        if (list !== undefined && list.length > 0) {
          const index = rng.int(0, list.length);
          const bookingId = list.splice(index, 1)[0] as string;
          const [doc, start, duration] = bookingSpan.get(bookingId) as [string, number, Duration];
          assert.equal(allocator.cancel(bookingId), true);
          freed.push([doc, start, duration]);
          if (doc === HOT_DOCTOR) {
            for (let m = start; m < start + duration; m++) hotOcc[m] = (hotOcc[m] as number) - 1;
          }
        }
      }
      mutationsDone += 1;
    }
    if ((op & 0x3ff) === 0) {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
  }
  const measuredMs = performance.now() - measuredStart;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  console.log(
    `    [stress] init: ${initMs.toFixed(0)} ms (excluded), ` +
      `measured: ${measuredMs.toFixed(0)} ms for ${queriesDone} queries + ${mutationsDone} mutations, ` +
      `peak RSS: ${(peakRss / MiB).toFixed(1)} MiB, ` +
      `verified slots: ${availabilityChecks}, full earliest checks: ${earliestChecks}`,
  );
  assert.equal(queriesDone, QUERY_COUNT);
  assert.equal(mutationsDone, MUTATION_COUNT);
  assert.ok(availabilityChecks > 1000, "should have verified many returned slots");
  assert.ok(earliestChecks > 20, "should have fully verified sampled queries");
  assert.ok(measuredMs < TIME_BUDGET_MS, `measured phase ${measuredMs}ms exceeds ${TIME_BUDGET_MS}ms`);
  assert.ok(peakRss < RSS_BUDGET, `peak RSS ${(peakRss / MiB).toFixed(1)} MiB exceeds 384 MiB`);
});

test("stress: only availability is a window near the end of the range", () => {
  // Capacity-1 doctor booked solid except 15-minute gaps every 300 minutes
  // and a single 60-minute window [11880, 11940) at the end.
  const allocator = new SlotAllocator();
  allocator.addDoctor("doc", [{ start: 0, end: 12_000, capacity: 1 }]);
  for (let m = 0; m < 11_880; m += 15) {
    if (m > 0 && m % 300 === 0) continue; // short gap, too small for 30/60
    assert.ok(allocator.book("doc", m, 15) !== null, `booking at ${m}`);
  }
  for (let m = 11_940; m < 12_000; m += 15) {
    assert.ok(allocator.book("doc", m, 15) !== null, `booking at ${m}`);
  }
  assert.equal(allocator.findEarliest("doc", 0, 12_000, 15), 300);
  assert.equal(allocator.findEarliest("doc", 0, 12_000, 30), 11_880);
  assert.equal(allocator.findEarliest("doc", 0, 12_000, 60), 11_880);
  assert.equal(allocator.findEarliest("doc", 0, 11_939, 60), null, "window no longer fits");
  assert.equal(allocator.findEarliest("doc", 0, 11_940, 60), 11_880);
  assert.equal(allocator.findEarliest("doc", 11_881, 12_000, 60), null, "past the last window");
});
