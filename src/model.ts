import type { BigIntLike, CapitalTable } from "./types.js";

export interface PreferredClass {
  id: string;
  shares: bigint;
  liquidation: bigint;
  participating: boolean;
  cap: bigint | null;
}

export interface Model {
  commonShares: bigint;
  preferred: PreferredClass[];
  /** Sum of all liquidation preferences. */
  totalPreference: bigint;
}

const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

export function toBigInt(value: BigIntLike, name: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${name}: number must be a safe integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!DECIMAL_INTEGER.test(trimmed)) {
      throw new Error(`${name}: expected a non-negative decimal integer string, got ${JSON.stringify(value)}`);
    }
    return BigInt(trimmed);
  }
  throw new Error(`${name}: unsupported value type`);
}

export function normalizeTable(table: CapitalTable): Model {
  const commonShares = toBigInt(table.commonShares, "commonShares");
  if (commonShares <= 0n) {
    throw new Error("commonShares must be a positive integer");
  }
  const seen = new Set<string>();
  const preferred: PreferredClass[] = [];
  let totalPreference = 0n;
  for (const input of table.preferred) {
    if (typeof input.id !== "string" || input.id.length === 0) {
      throw new Error("each preferred class needs a non-empty string id");
    }
    if (seen.has(input.id)) {
      throw new Error(`duplicate preferred class id: ${input.id}`);
    }
    seen.add(input.id);
    const shares = toBigInt(input.shares, `preferred[${input.id}].shares`);
    if (shares <= 0n) {
      throw new Error(`preferred[${input.id}].shares must be a positive integer`);
    }
    const liquidation = toBigInt(input.liquidation, `preferred[${input.id}].liquidation`);
    if (liquidation <= 0n) {
      throw new Error(`preferred[${input.id}].liquidation must be a positive integer`);
    }
    let cap: bigint | null = null;
    if (input.cap !== undefined) {
      if (!input.participating) {
        throw new Error(`preferred[${input.id}].cap is only allowed on participating classes`);
      }
      cap = toBigInt(input.cap, `preferred[${input.id}].cap`);
      if (cap < liquidation) {
        throw new Error(`preferred[${input.id}].cap must be >= liquidation`);
      }
    }
    totalPreference += liquidation;
    preferred.push({ id: input.id, shares, liquidation, participating: input.participating, cap });
  }
  return { commonShares, preferred, totalPreference };
}
