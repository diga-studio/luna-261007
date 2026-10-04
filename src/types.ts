/** Decimal integer input: bigint or base-10 integer string. */
export type IntInput = bigint | string;

/** Exact rational number, always kept in lowest terms with den > 0. */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

/** One preferred class, all at the same liquidation seniority. */
export interface PreferredClassInput {
  readonly id: string;
  /** Converted share count s > 0. */
  readonly shares: IntInput;
  /** Aggregate liquidation preference L > 0, in cents. */
  readonly preference: IntInput;
  /** Whether the class participates in the residual. */
  readonly participating: boolean;
  /** Optional total-return cap C >= L (participating classes only). */
  readonly cap?: IntInput;
}

export interface CapitalTableInput {
  readonly common: {
    readonly id: string;
    readonly shares: IntInput;
  };
  readonly preferred: readonly PreferredClassInput[];
}

/** Normalized, validated preferred class with bigint fields. */
export interface PreferredClass {
  readonly id: string;
  readonly shares: bigint;
  readonly preference: bigint;
  readonly participating: boolean;
  readonly cap?: bigint;
}

export interface CapitalTable {
  readonly common: { readonly id: string; readonly shares: bigint };
  readonly preferred: readonly PreferredClass[];
}

export interface ClassAllocation {
  readonly id: string;
  /** Exact proceeds, in cents, as a reduced rational. */
  readonly amount: Rational;
  /** True when the class converts to common stock. */
  readonly converted: boolean;
}

export interface AllocationResult {
  readonly common: ClassAllocation;
  readonly preferred: readonly ClassAllocation[];
}

/** Validate and normalize a capital table; throws on malformed input. */
export function normalizeTable(table: CapitalTableInput): CapitalTable {
  const parseIntField = (value: IntInput, what: string): bigint => {
    if (typeof value === "bigint") return value;
    if (typeof value === "string" && /^-?[0-9]+$/.test(value)) {
      return BigInt(value);
    }
    throw new Error(`${what} must be a decimal integer string or bigint`);
  };

  const commonShares = parseIntField(table.common.shares, "common shares");
  if (commonShares <= 0n) {
    throw new Error("common shares must be positive");
  }

  const seen = new Set<string>();
  const preferred: PreferredClass[] = table.preferred.map((cls) => {
    if (seen.has(cls.id)) {
      throw new Error(`duplicate class id: ${cls.id}`);
    }
    seen.add(cls.id);
    const shares = parseIntField(cls.shares, `shares of ${cls.id}`);
    const preference = parseIntField(cls.preference, `preference of ${cls.id}`);
    if (shares <= 0n) {
      throw new Error(`shares of ${cls.id} must be positive`);
    }
    if (preference <= 0n) {
      throw new Error(`preference of ${cls.id} must be positive`);
    }
    let cap: bigint | undefined;
    if (cls.cap !== undefined) {
      if (!cls.participating) {
        throw new Error(`cap on non-participating class ${cls.id}`);
      }
      cap = parseIntField(cls.cap, `cap of ${cls.id}`);
      if (cap < preference) {
        throw new Error(`cap of ${cls.id} must be >= its preference`);
      }
    }
    return {
      id: cls.id,
      shares,
      preference,
      participating: cls.participating,
      ...(cap !== undefined ? { cap } : {}),
    };
  });

  return {
    common: { id: table.common.id, shares: commonShares },
    preferred,
  };
}
