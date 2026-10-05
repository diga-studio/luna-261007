// Scale-test worker: builds a 500k-record geo index (>=250k distinct IPv6
// prefixes, shuffled), compiles a deny list, consumes it fully while
// verifying ordering and per-address correctness against a brute-force
// reference, and reports peak RSS plus timings as a single JSON line.
//
// Records are stored once as plain CIDR strings plus a country-index
// array; the input stream and the reference map are two deterministic
// replays of the same interleaved sequence, so no 500k-object row array
// is ever materialized.
import { performance } from "node:perf_hooks";
import { buildGeoIndex, compileDeny } from "../dist/index.js";
import { formatCidr, maskNetwork, parseCidr } from "../dist/ip.js";

const MIB = 1024 * 1024;
let peakRss = 0;
const sample = () => {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
};
const sampler = setInterval(sample, 25);

const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(0x5eed);
const randInt = (n) => Math.floor(rand() * n);
const randBits32 = () => Math.floor(rand() * 0x100000000);

const COUNTRIES = Array.from({ length: 16 }, (_, i) => `C${String(i).padStart(2, "0")}`);
const V6_LENGTHS = [24, 32, 40, 48, 56, 64];
const V4_LENGTHS = [8, 12, 16, 20, 24];
const N_V6 = 250_000;
const N_V4 = 250_000;
const TOTAL = N_V6 + N_V4;

// --- Generate the distinct IPv6 and IPv4 CIDR pools (strings kept once). ---
const v6Cidrs = [];
const seenV6 = new Set();
while (v6Cidrs.length < N_V6) {
  const network = (BigInt(randBits32()) << 32n) | BigInt(randBits32());
  const prefixLen = V6_LENGTHS[randInt(V6_LENGTHS.length)];
  const cidr = formatCidr(6, maskNetwork(network << 64n, prefixLen, 128), prefixLen);
  if (seenV6.has(cidr)) continue;
  seenV6.add(cidr);
  v6Cidrs.push(cidr);
}
const v4Cidrs = [];
for (let i = 0; i < N_V4; i++) {
  const network = BigInt(randBits32());
  const prefixLen = V4_LENGTHS[randInt(V4_LENGTHS.length)];
  v4Cidrs.push(formatCidr(4, maskNetwork(network, prefixLen, 32), prefixLen));
}
// Per-record country picks and the interleave pattern are reproducible
// from fixed seeds, so both passes see the identical shuffled stream.
const countryIdx = new Uint8Array(TOTAL);
for (let i = 0; i < TOTAL; i++) countryIdx[i] = randInt(COUNTRIES.length);
sample();

function* makeRows() {
  const interleave = mulberry32(0x11);
  let v6 = 0;
  let v4 = 0;
  for (let i = 0; i < TOTAL; i++) {
    const remaining = TOTAL - i;
    const pickV6 = v6 < N_V6 && (v4 >= N_V4 || interleave() < (N_V6 - v6) / remaining);
    const cidr = pickV6 ? v6Cidrs[v6++] : v4Cidrs[v4++];
    yield { cidr, country: COUNTRIES[countryIdx[i]] };
  }
}

// --- Protected CIDRs and deny set. ---
const PROTECTED = [];
for (let i = 0; i < 128; i++) {
  if (i % 2 === 0) {
    PROTECTED.push(formatCidr(4, BigInt(randBits32()), [8, 16, 24, 32][randInt(4)]));
  } else {
    const net = (BigInt(randBits32()) << 96n) | (BigInt(randBits32()) << 64n) |
      (BigInt(randBits32()) << 32n) | BigInt(randBits32());
    PROTECTED.push(formatCidr(6, net, [32, 48, 64, 128][randInt(4)]));
  }
}
const protMap = new Map();
for (const cidr of PROTECTED) {
  const p = parseCidr(cidr);
  protMap.set(`${p.family}:${p.network}:${p.prefixLen}`, true);
}
const DENY = new Set(COUNTRIES.slice(0, 8));

// --- Build the index from a one-shot async iterable. ---
const buildStart = performance.now();
let built = 0;
const index = await buildGeoIndex((async function* () {
  for (const row of makeRows()) {
    if (built++ % 4096 === 0) sample();
    yield row;
  }
})());
const buildMs = performance.now() - buildStart;
sample();

// --- Reference model: replay the same stream into an exact-match map
// (last write wins), then answer probes by longest-prefix descent. ---
const recMap = new Map();
for (const { cidr, country } of makeRows()) {
  recMap.set(cidr, country); // cidr strings are shared with the pools
}
const referenceDenied = (family, addr) => {
  const maxBits = family === 6 ? 128 : 32;
  for (let len = maxBits; len >= 0; len--) {
    if (protMap.has(`${family}:${maskNetwork(addr, len, maxBits)}:${len}`)) return false;
  }
  for (let len = maxBits; len >= 0; len--) {
    const hit = recMap.get(formatCidr(family, maskNetwork(addr, len, maxBits), len));
    if (hit !== undefined) return DENY.has(hit);
  }
  return false;
};

// --- Sampled addresses for online verification (sorted per family). ---
const SAMPLES = 5000;
const samplesV4 = [];
const samplesV6 = [];
for (let i = 0; i < SAMPLES; i++) {
  samplesV4.push(BigInt(randBits32()));
  samplesV6.push(
    (BigInt(randBits32()) << 96n) | (BigInt(randBits32()) << 64n) |
      (BigInt(randBits32()) << 32n) | BigInt(randBits32()),
  );
}
samplesV4.sort((a, b) => (a < b ? -1 : 1));
samplesV6.sort((a, b) => (a < b ? -1 : 1));

// --- Compile and consume fully, verifying as we stream. ---
const compileStart = performance.now();
let outputCount = 0;
let mismatches = 0;
let orderViolations = 0;
let family = 4;
let prevEnd = 0n;
let cursor = 0;
const checkUncovered = (fam, samples, upto) => {
  while (cursor < samples.length && samples[cursor] < upto) {
    if (referenceDenied(fam, samples[cursor])) mismatches++;
    cursor++;
  }
};
for await (const cidr of compileDeny(index, DENY, PROTECTED)) {
  if (outputCount % 4096 === 0) sample();
  outputCount++;
  const p = parseCidr(cidr);
  const fam = p.family;
  const maxBits = fam === 6 ? 128 : 32;
  const end = p.network + (1n << BigInt(maxBits - p.prefixLen));
  if (fam !== family) {
    checkUncovered(family, samplesV4, 1n << 32n); // flush remaining v4 samples
    family = fam;
    prevEnd = 0n;
    cursor = 0;
  }
  if (p.network < prevEnd) orderViolations++;
  prevEnd = end;
  const samples = fam === 6 ? samplesV6 : samplesV4;
  checkUncovered(fam, samples, p.network);
  while (cursor < samples.length && samples[cursor] < end) {
    if (!referenceDenied(fam, samples[cursor])) mismatches++;
    cursor++;
  }
}
checkUncovered(family, family === 6 ? samplesV6 : samplesV4, 1n << (family === 6 ? 128n : 32n));
const compileMs = performance.now() - compileStart;
sample();
clearInterval(sampler);
sample();

console.log(JSON.stringify({
  records: TOTAL,
  distinctV6: v6Cidrs.length,
  outputCount,
  mismatches,
  orderViolations,
  buildMs: Math.round(buildMs),
  compileMs: Math.round(compileMs),
  peakRssBytes: peakRss,
  peakRssMiB: Math.round((peakRss / MIB) * 10) / 10,
}));
