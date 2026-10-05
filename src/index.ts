import { compileFamily } from "./compile.js";
import { Family, MAX_BITS, formatCidr, parseCidr } from "./ip.js";
import { TableBuilder, type RecordTable } from "./table.js";

/** One parsed geo attribution record. */
export interface GeoRow {
  cidr: string;
  country: string;
}

/** Read-only, reusable geo index produced by {@link buildGeoIndex}. */
export interface GeoIndex {
  readonly recordCount: number;
  /** Internal per-family sorted record tables; read-only views. */
  readonly v4: RecordTable;
  readonly v6: RecordTable;
  readonly countries: readonly string[];
}

/** Consume a one-shot stream of geo rows into a reusable read-only index. */
export async function buildGeoIndex(rows: AsyncIterable<GeoRow>): Promise<GeoIndex> {
  const v4 = new TableBuilder(MAX_BITS[Family.V4]);
  const v6 = new TableBuilder(MAX_BITS[Family.V6]);
  const countryIds = new Map<string, number>();
  const countries: string[] = [];
  let recordCount = 0;

  for await (const row of rows) {
    const parsed = parseCidr(row.cidr);
    let countryId = countryIds.get(row.country);
    if (countryId === undefined) {
      countryId = countries.length;
      countries.push(row.country);
      countryIds.set(row.country, countryId);
    }
    const builder = parsed.family === Family.V6 ? v6 : v4;
    builder.add(parsed.network, parsed.prefixLen, countryId);
    recordCount++;
  }

  return Object.freeze({
    recordCount,
    v4: v4.finish(),
    v6: v6.finish(),
    countries: Object.freeze(countries.slice()),
  });
}

/**
 * Compile the exact minimal deny CIDR set for the given countries.
 * Protected CIDRs always win. Yields IPv4 CIDRs (ascending) then IPv6
 * CIDRs (ascending), one at a time.
 */
export function compileDeny(
  index: GeoIndex,
  countries: Iterable<string>,
  protectedCidrs: Iterable<string>,
): AsyncIterable<string> {
  const countryIds = new Map<string, number>();
  index.countries.forEach((name, id) => countryIds.set(name, id));
  const denied = new Set<number>();
  for (const name of countries) {
    const id = countryIds.get(name);
    if (id !== undefined) denied.add(id);
  }
  const isDenied = (countryId: number): boolean => denied.has(countryId);

  const protectedV4 = new TableBuilder(MAX_BITS[Family.V4]);
  const protectedV6 = new TableBuilder(MAX_BITS[Family.V6]);
  for (const text of protectedCidrs) {
    const parsed = parseCidr(text);
    const builder = parsed.family === Family.V6 ? protectedV6 : protectedV4;
    builder.add(parsed.network, parsed.prefixLen, 0);
  }

  const families = [
    { records: index.v4, protectedTable: protectedV4.finish(), family: Family.V4 },
    { records: index.v6, protectedTable: protectedV6.finish(), family: Family.V6 },
  ] as const;

  return (async function* (): AsyncGenerator<string> {
    for (const { records, protectedTable, family } of families) {
      const maxBits = MAX_BITS[family];
      for (const { network, prefixLen } of compileFamily(
        records,
        protectedTable,
        isDenied,
        maxBits,
      )) {
        yield formatCidr(family, network, prefixLen);
      }
    }
  })();
}
