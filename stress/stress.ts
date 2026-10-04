import { SlotAllocator } from "../src/index.ts";
import type { CalendarSegment, Duration } from "../src/types.ts";

/**
 * Stress test at the required scale:
 *   100 doctors, 2000 calendar segments total, 200k active appointments
 *   (heavily concentrated on one "hot" doctor), 20-year calendar span.
 * Then 50k queries interleaved with 10k successful book/cancel operations.
 * Reports init time, operation time and peak RSS, and independently verifies
 * a sample of query answers (slot really usable, no earlier answer exists).
 */

const DAY = 1440;
const YEAR = 365 * DAY;
const SPAN = 20 * YEAR;
const DOCTOR_COUNT = 100;
const SEGMENT_TOTAL = 2000;
const INITIAL_BOOKINGS = 200_000;
const QUERY_OPS = 50_000;
const MUTATION_OPS = 10_000;
const VERIFY_EVERY = 50; // verify every Nth hot-doctor windowed query

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
const HOT = "doc-0";
const HOT_REGION_END = 2 * YEAR; // hot doctor's dense region: first 2 years

interface LiveBooking {
  doctor: string;
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------
function buildCalendars(rand: () => number): Map<string, CalendarSegment[]> {
  const calendars = new Map<string, CalendarSegment[]>();
  // Hot doctor: 120 contiguous segments over the first 2 years, capacity 6..8,
  // so random packing leaves many gaps shorter than a requested duration.
  const hotSegs: CalendarSegment[] = [];
  const hotSegCount = 120;
  const hotLen = Math.floor(HOT_REGION_END / hotSegCount);
  for (let i = 0; i < hotSegCount; i++) {
    hotSegs.push({
      start: i * hotLen,
      end: i === hotSegCount - 1 ? HOT_REGION_END : (i + 1) * hotLen,
      capacity: 6 + (i % 3),
    });
  }
  calendars.set(HOT, hotSegs);

  // Other doctors share the remaining segments, scattered over 20 years.
  const remaining = SEGMENT_TOTAL - hotSegCount;
  const perDoctor = Math.floor(remaining / (DOCTOR_COUNT - 1));
  for (let d = 1; d < DOCTOR_COUNT; d++) {
    const segs: CalendarSegment[] = [];
    let cursor = Math.floor(rand() * YEAR);
    for (let i = 0; i < perDoctor; i++) {
      cursor += Math.floor(rand() * 30 * DAY);
      if (cursor >= SPAN) break;
      const len = (4 + Math.floor(rand() * 20)) * 60; // 4..24 hours
      const capacity = 1 + Math.floor(rand() * 8);
      segs.push({ start: cursor, end: Math.min(cursor + len, SPAN), capacity });
      cursor += len;
    }
    calendars.set(`doc-${d}`, segs);
  }
  return calendars;
}

// ---------------------------------------------------------------------------
// Independent verifier: exact earliest-start scan over a bounded window,
// computed from raw segments + raw active bookings (minute-exact because
// occupancy and capacity are constant between consecutive boundaries).
// ---------------------------------------------------------------------------
function independentEarliest(
  segments: CalendarSegment[],
  bookings: LiveBooking[],
  qs: number,
  qe: number,
  dur: number,
): number | null {
  const bounds = new Set<number>([qs, qe]);
  const diff = new Map<number, number>();
  for (const b of bookings) {
    const s = Math.max(b.start, qs);
    const e = Math.min(b.end, qe);
    if (s < e) {
      diff.set(s, (diff.get(s) ?? 0) + 1);
      diff.set(e, (diff.get(e) ?? 0) - 1);
      bounds.add(s);
      bounds.add(e);
    }
  }
  for (const seg of segments) {
    const s = Math.max(seg.start, qs);
    const e = Math.min(seg.end, qe);
    if (s < e) {
      bounds.add(s);
      bounds.add(e);
    }
  }
  const pts = [...bounds].sort((a, b) => a - b);
  let occ = 0;
  let segIdx = 0;
  let carry = 0;
  let runStart = qs;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    occ += diff.get(a) ?? 0;
    while (segIdx < segments.length && segments[segIdx]!.end <= a) segIdx++;
    let cap = 0;
    if (segIdx < segments.length) {
      const seg = segments[segIdx]!;
      if (seg.start <= a && a < seg.end) cap = seg.capacity;
    }
    if (occ < cap) {
      if (carry === 0) runStart = a;
      carry += b - a;
      if (carry >= dur) return runStart;
    } else {
      carry = 0;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const rand = rng(20261005);
const calendars = buildCalendars(rand);
const doctors = [...calendars.keys()];

const alloc = new SlotAllocator();
const live = new Map<string, LiveBooking>();
// Persistent per-doctor booking arrays (swap-remove) so verification does not
// rebuild a 200k-entry array for every sampled query.
const hotLive: LiveBooking[] = [];
const hotIds: string[] = [];
const hotPos = new Map<string, number>();

function hotAdd(id: string, b: LiveBooking): void {
  hotPos.set(id, hotLive.length);
  hotLive.push(b);
  hotIds.push(id);
}
function hotRemove(id: string): void {
  const i = hotPos.get(id)!;
  const lastId = hotIds.pop()!;
  const lastB = hotLive.pop()!;
  if (lastId !== id) {
    hotLive[i] = lastB;
    hotIds[i] = lastId;
    hotPos.set(lastId, i);
  }
  hotPos.delete(id);
}

function rssMiB(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}
let peakRss = 0;
function sampleRss(): void {
  peakRss = Math.max(peakRss, rssMiB());
}

// ---- init (reported separately) ----
let t0 = performance.now();
for (const d of doctors) alloc.setCalendar(d, calendars.get(d)!);
const tCal = performance.now();

let booked = 0;
let attempts = 0;
while (booked < INITIAL_BOOKINGS) {
  attempts++;
  const start = Math.floor(rand() * (HOT_REGION_END - 60));
  const dur = DURATIONS[Math.floor(rand() * 3)]!;
  const id = alloc.book(HOT, start, dur);
  if (id !== null) {
    const b = { doctor: HOT, start, end: start + dur };
    live.set(id, b);
    hotAdd(id, b);
    booked++;
  }
  if (attempts > 20 * INITIAL_BOOKINGS) throw new Error("cannot place initial bookings");
}
const tInit = performance.now();
sampleRss();
console.log(`init: calendars ${(tCal - t0).toFixed(0)} ms, bulk load ${booked} bookings in ${(tInit - tCal).toFixed(0)} ms (${attempts} attempts)`);
console.log(`after init: RSS ${rssMiB().toFixed(1)} MiB`);

// ---- interleaved ops ----
const hotSegs = calendars.get(HOT)!;
let queries = 0;
let books = 0;
let cancels = 0;
let verifyCount = 0;
let verifyFailed = 0;
let lateAnswers = 0; // answers in the last decile of their query window
const cancelPool: string[] = [];

t0 = performance.now();
let tVerify = 0;
while (queries < QUERY_OPS || books + cancels < MUTATION_OPS) {
  const doQuery = queries < QUERY_OPS && (books + cancels >= MUTATION_OPS || rand() < QUERY_OPS / (QUERY_OPS + MUTATION_OPS));
  if (doQuery) {
    queries++;
    const kind = rand();
    let doctor: string;
    let qs: number;
    let qe: number;
    if (kind < 0.15) {
      // full hot-region scan, answer (if any) is wherever a gap remains
      doctor = HOT;
      qs = 0;
      qe = HOT_REGION_END;
    } else if (kind < 0.7) {
      // dense window on the hot doctor
      doctor = HOT;
      qs = Math.floor(rand() * (HOT_REGION_END - 4000));
      qe = qs + 60 + Math.floor(rand() * 3940);
    } else {
      // random doctor, wide window
      doctor = doctors[1 + Math.floor(rand() * (DOCTOR_COUNT - 1))]!;
      qs = Math.floor(rand() * (SPAN - 60));
      qe = Math.min(SPAN, qs + 60 + Math.floor(rand() * (10 * YEAR)));
    }
    const dur = DURATIONS[Math.floor(rand() * 3)]!;
    const got = alloc.findEarliest(doctor, qs, qe, dur);
    if (got !== null && qe > qs && got - qs > 0.9 * (qe - qs - dur)) lateAnswers++;
    if (doctor === HOT && qe - qs <= 4000 && queries % VERIFY_EVERY === 0) {
      // independent verification: usable slot + no earlier answer
      const tv = performance.now();
      verifyCount++;
      const want = independentEarliest(hotSegs, hotLive, qs, qe, dur);
      if (got !== want) {
        verifyFailed++;
        console.error(`VERIFY FAIL: got ${got} want ${want} window [${qs},${qe}) dur=${dur}`);
      }
      tVerify += performance.now() - tv;
    }
  } else if (books < MUTATION_OPS / 2 && (cancels >= MUTATION_OPS / 2 || rand() < 0.5)) {
    // successful book: locate a slot, then occupy it
    const doctor = rand() < 0.8 ? HOT : doctors[1 + Math.floor(rand() * (DOCTOR_COUNT - 1))]!;
    const dur = DURATIONS[Math.floor(rand() * 3)]!;
    const regionEnd = doctor === HOT ? HOT_REGION_END : SPAN;
    let start: number | null = null;
    for (let tries = 0; tries < 4 && start === null; tries++) {
      const w0 = Math.floor(rand() * (regionEnd - 2 * dur));
      start = alloc.findEarliest(doctor, w0, Math.min(regionEnd, w0 + 5000), dur);
    }
    start ??= alloc.findEarliest(doctor, 0, regionEnd, dur);
    if (start === null) continue; // doctor full; counts as no op, loop continues
    const id = alloc.book(doctor, start, dur);
    if (id === null) {
      console.error(`BOOK FAIL at returned slot: ${doctor} @${start} dur=${dur}`);
      verifyFailed++;
      continue;
    }
    const b = { doctor, start, end: start + dur };
    live.set(id, b);
    if (doctor === HOT) hotAdd(id, b);
    cancelPool.push(id);
    books++;
  } else {
    // successful cancel of a random live booking
    if (cancelPool.length === 0) continue;
    const idx = Math.floor(rand() * cancelPool.length);
    const id = cancelPool.splice(idx, 1)[0]!;
    const info = live.get(id)!;
    if (!alloc.cancel(id)) {
      console.error(`CANCEL FAIL: ${id}`);
      verifyFailed++;
      continue;
    }
    live.delete(id);
    if (info.doctor === HOT) hotRemove(id);
    cancels++;
  }
  if ((queries + books + cancels) % 5000 === 0) sampleRss();
}
const tOps = performance.now();
sampleRss();

console.log(`ops: ${queries} queries + ${books} books + ${cancels} cancels in ${(tOps - t0 - tVerify).toFixed(0)} ms (verification excluded: ${tVerify.toFixed(0)} ms)`);
console.log(`verified ${verifyCount} sampled queries independently, failures: ${verifyFailed}`);
console.log(`answers in last decile of query window: ${lateAnswers}`);
console.log(`peak RSS: ${peakRss.toFixed(1)} MiB (limit 384 MiB)`);
console.log(`op-time budget: ${((tOps - t0 - tVerify) / 1000).toFixed(2)} s (limit 15 s)`);
if (verifyFailed > 0) {
  console.error("STRESS TEST FAILED");
  process.exit(1);
}
if (tOps - t0 - tVerify > 15_000) {
  console.error("TIME BUDGET EXCEEDED");
  process.exit(1);
}
if (peakRss > 384) {
  console.error("MEMORY BUDGET EXCEEDED");
  process.exit(1);
}
console.log("STRESS TEST PASSED");
