import { describe, expect, it } from "vitest";
import { buildGeoIndex, compileDeny, type GeoRow } from "../dist/index.js";
import { Family, MAX_BITS, formatCidr, maskNetwork, parseCidr } from "../dist/ip.js";

async function* streamRows(rows: GeoRow[]): AsyncIterable<GeoRow> {
  for (const row of rows) yield row;
}

async function compileAll(
  rows: GeoRow[],
  countries: string[],
  protectedCidrs: string[],
): Promise<string[]> {
  const index = await buildGeoIndex(streamRows(rows));
  return Array.fromAsync(compileDeny(index, countries, protectedCidrs));
}

/** Independent brute-force reference: per-address longest-prefix match. */
function referenceIsDenied(
  rows: GeoRow[],
  deny: ReadonlySet<string>,
  protectedCidrs: string[],
  family: Family,
  addr: bigint,
): boolean {
  const maxBits = MAX_BITS[family];
  for (const text of protectedCidrs) {
    const p = parseCidr(text);
    if (p.family === family && maskNetwork(addr, p.prefixLen, maxBits) === p.network) {
      return false; // protected always wins
    }
  }
  let bestLen = -1;
  let bestCountry: string | undefined;
  for (const row of rows) {
    const p = parseCidr(row.cidr);
    if (p.family !== family) continue;
    if (p.prefixLen >= bestLen && maskNetwork(addr, p.prefixLen, maxBits) === p.network) {
      bestLen = p.prefixLen;
      bestCountry = row.country;
    }
  }
  return bestCountry !== undefined && deny.has(bestCountry);
}

function parseOutputs(outputs: string[], family: Family) {
  return outputs
    .map((text) => parseCidr(text))
    .filter((p) => p.family === family)
    .map((p) => ({ ...p, end: p.network + (1n << BigInt(MAX_BITS[family] - p.prefixLen)) }));
}

function expectSortedNonOverlappingMinimal(outputs: string[], family: Family): void {
  const parsed = parseOutputs(outputs, family);
  const maxBits = MAX_BITS[family];
  const seen = new Set(outputs);
  let prevEnd = -1n;
  for (const p of parsed) {
    expect(p.network).toBe(maskNetwork(p.network, p.prefixLen, maxBits)); // normalized
    // ascending; adjacent ranges (prev end == next start) are allowed
    expect(p.network >= prevEnd).toBe(true);
    prevEnd = p.end;
    if (p.prefixLen > 0) {
      const sibling = p.network ^ (1n << BigInt(maxBits - p.prefixLen));
      expect(
        seen.has(formatCidr(family, sibling, p.prefixLen)),
        `mergeable sibling pair at ${formatCidr(family, p.network, p.prefixLen)}`,
      ).toBe(false);
    }
  }
}

function coversAny(outputs: string[], family: Family, addr: bigint): boolean {
  const maxBits = MAX_BITS[family];
  return parseOutputs(outputs, family).some(
    (p) => maskNetwork(addr, p.prefixLen, maxBits) === p.network,
  );
}

describe("nested holes with protected subnet", () => {
  const rows: GeoRow[] = [
    { cidr: "192.0.2.0/24", country: "A" }, // denied
    { cidr: "192.0.2.64/26", country: "B" }, // hole
    { cidr: "192.0.2.80/28", country: "A" }, // re-included island
    { cidr: "192.0.2.96/27", country: "C" }, // unrelated hole
  ];
  const protectedCidrs = ["192.0.2.88/29"]; // carve-out inside the island

  it("matches the brute-force reference on every address", async () => {
    const outputs = await compileAll(rows, ["A"], protectedCidrs);
    const deny = new Set(["A"]);
    const base = 0xc0000200n; // 192.0.2.0
    for (let i = 0n; i < 256n; i++) {
      const addr = base + i;
      const expected = referenceIsDenied(rows, deny, protectedCidrs, Family.V4, addr);
      expect(coversAny(outputs, Family.V4, addr), `addr 192.0.2.${i}`).toBe(expected);
    }
    expectSortedNonOverlappingMinimal(outputs, Family.V4);
  });

  it("produces the exact expected CIDR list", async () => {
    const outputs = await compileAll(rows, ["A"], protectedCidrs);
    expect(outputs).toEqual([
      "192.0.2.0/26",
      "192.0.2.80/29",
      "192.0.2.128/25",
    ]);
  });
});

describe("IPv6 edge cases", () => {
  it("/0 minus a single /128 yields exactly 128 CIDRs", async () => {
    const outputs = await compileAll(
      [{ cidr: "::/0", country: "X" }],
      ["X"],
      ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128"],
    );
    expect(outputs).toHaveLength(128);
    expect(outputs[outputs.length - 1]).toBe("ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe/128");
    expect(outputs[0]).toBe("::/1");
    expectSortedNonOverlappingMinimal(outputs, Family.V6);
  });

  it("does not lose low-bit precision near a protected /128", async () => {
    const rows: GeoRow[] = [{ cidr: "::/0", country: "X" }];
    const protectedCidrs = ["::ffff:ffff:ffff:ffff/128"];
    const outputs = await compileAll(rows, ["X"], protectedCidrs);
    expect(outputs).toHaveLength(128);
    const deny = new Set(["X"]);
    // Addresses differing only in the lowest bits must not be misjudged.
    const probes = [
      0xffffffffffffffffn, // the protected address itself
      0xfffffffffffffffen,
      0xffffffffffffff00n,
      0xffffffffffffff01n,
      0x8000000000000001n,
      1n,
    ];
    for (const addr of probes) {
      const expected = referenceIsDenied(rows, deny, protectedCidrs, Family.V6, addr);
      expect(coversAny(outputs, Family.V6, addr), `addr ${addr.toString(16)}`).toBe(expected);
    }
  });

  it("keeps IPv4-mapped IPv6 in the IPv6 space", async () => {
    const rows: GeoRow[] = [
      { cidr: "::ffff:10.0.0.0/104", country: "A" },
      { cidr: "10.0.0.0/8", country: "B" },
    ];
    const denyA = await compileAll(rows, ["A"], []);
    expect(denyA).toEqual(["::ffff:a00:0/104"]);
    const denyB = await compileAll(rows, ["B"], []);
    expect(denyB).toEqual(["10.0.0.0/8"]);
  });
});

describe("duplicate normalized CIDRs", () => {
  const rows: GeoRow[] = [
    { cidr: "10.1.2.3/8", country: "A" }, // normalizes to 10.0.0.0/8
    { cidr: "10.255.0.1/8", country: "B" }, // same normalized prefix
    { cidr: "10.0.0.0/8", country: "C" }, // last write wins
    { cidr: "2001:db8::1/32", country: "A" },
    { cidr: "2001:db8:ffff::/32", country: "B" }, // same normalized prefix, last wins
  ];

  it("honours the last record only", async () => {
    expect(await compileAll(rows, ["A"], [])).toEqual([]);
    expect(await compileAll(rows, ["B"], [])).toEqual(["2001:db8::/32"]);
    expect(await compileAll(rows, ["C"], [])).toEqual(["10.0.0.0/8"]);
    expect(await compileAll(rows, ["B", "C"], [])).toEqual([
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);
  });
});

describe("nested records sharing one network address", () => {
  // Regression: a run of records at the same network with different prefix
  // lengths must apply the longest one that still covers the node.
  const rows: GeoRow[] = [
    { cidr: "10.0.0.0/8", country: "A" },
    { cidr: "10.0.0.0/16", country: "B" },
  ];

  it("carves the inner prefix out of the outer one", async () => {
    const outputs = await compileAll(rows, ["A"], []);
    expect(outputs).toEqual([
      "10.1.0.0/16",
      "10.2.0.0/15",
      "10.4.0.0/14",
      "10.8.0.0/13",
      "10.16.0.0/12",
      "10.32.0.0/11",
      "10.64.0.0/10",
      "10.128.0.0/9",
    ]);
    expect(await compileAll(rows, ["B"], [])).toEqual(["10.0.0.0/16"]);
  });

  it("applies last-wins before nesting decisions", async () => {
    const layered: GeoRow[] = [
      { cidr: "10.3.0.0/16", country: "D" },
      { cidr: "10.3.69.213/18", country: "B" }, // normalizes to 10.3.64.0/18
      { cidr: "10.3.74.57/18", country: "C" }, // same normalized prefix: C wins
      { cidr: "10.3.116.0/24", country: "A" },
    ];
    const outputs = await compileAll(layered, ["A", "D"], []);
    expect(outputs).toEqual(["10.3.0.0/18", "10.3.116.0/24", "10.3.128.0/17"]);
  });
});

describe("repeated compiles on one index", () => {
  it("does not leak protected CIDRs between compiles", async () => {
    const rows: GeoRow[] = [
      { cidr: "10.0.0.0/8", country: "A" },
      { cidr: "2001:db8::/32", country: "A" },
    ];
    const index = await buildGeoIndex(streamRows(rows));

    const unprotected = await Array.fromAsync(compileDeny(index, ["A"], []));
    expect(unprotected).toEqual(["10.0.0.0/8", "2001:db8::/32"]);

    const withProtection = await Array.fromAsync(
      compileDeny(index, ["A"], ["10.0.0.0/9", "2001:db8::/48"]),
    );
    expect(withProtection).toEqual([
      "10.128.0.0/9",
      "2001:db8:1::/48",
      "2001:db8:2::/47",
      "2001:db8:4::/46",
      "2001:db8:8::/45",
      "2001:db8:10::/44",
      "2001:db8:20::/43",
      "2001:db8:40::/42",
      "2001:db8:80::/41",
      "2001:db8:100::/40",
      "2001:db8:200::/39",
      "2001:db8:400::/38",
      "2001:db8:800::/37",
      "2001:db8:1000::/36",
      "2001:db8:2000::/35",
      "2001:db8:4000::/34",
      "2001:db8:8000::/33",
    ]);

    // A later compile with a different (or empty) protection list is unaffected.
    const again = await Array.fromAsync(compileDeny(index, ["A"], []));
    expect(again).toEqual(unprotected);
    const other = await Array.fromAsync(compileDeny(index, ["A"], ["10.0.0.0/10"]));
    expect(other).toEqual(["10.64.0.0/10", "10.128.0.0/9", "2001:db8::/32"]);
  });

  it("lets callers consume results lazily without storing them", async () => {
    const index = await buildGeoIndex(streamRows([{ cidr: "::/0", country: "X" }]));
    const iterable = compileDeny(index, ["X"], ["::/128"]);
    const iterator = iterable[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe("::1/128");
    await iterator.return?.(); // abandon mid-stream; nothing was materialized
  });
});

describe("empty and boundary inputs", () => {
  it("returns nothing when no country matches or nothing is indexed", async () => {
    const index = await buildGeoIndex(streamRows([{ cidr: "10.0.0.0/8", country: "A" }]));
    expect(await Array.fromAsync(compileDeny(index, ["ZZ"], []))).toEqual([]);
    const empty = await buildGeoIndex(streamRows([]));
    expect(await Array.fromAsync(compileDeny(empty, ["A"], []))).toEqual([]);
  });

  it("emits a single /0 when a whole family is denied", async () => {
    const outputs = await compileAll(
      [
        { cidr: "0.0.0.0/0", country: "A" },
        { cidr: "::/0", country: "A" },
      ],
      ["A"],
      [],
    );
    expect(outputs).toEqual(["0.0.0.0/0", "::/0"]);
  });

  it("protecting /0 suppresses the whole family", async () => {
    const outputs = await compileAll(
      [
        { cidr: "0.0.0.0/0", country: "A" },
        { cidr: "::/0", country: "A" },
      ],
      ["A"],
      ["0.0.0.0/0", "::/0"],
    );
    expect(outputs).toEqual([]);
  });
});
