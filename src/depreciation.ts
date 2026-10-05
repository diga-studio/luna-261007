import { addMonths, compare, parseIso, type CivilDate } from "./date.js";
import type { AssetInput, BookValueRequest, Cents, DepreciationHandle } from "./types.js";

const RATE_SCALE = 10000n; // r 为万分数

/** 一笔折旧入账记录：入账日及入账后的账面值。 */
interface ScheduleEntry {
  readonly date: CivilDate;
  readonly bookValueAfter: bigint;
}

interface AssetSchedule {
  readonly purchaseDate: CivilDate;
  readonly purchasePrice: bigint;
  readonly entries: readonly ScheduleEntry[]; // 按入账日升序，共 L 笔
}

interface HandleState {
  readonly assets: ReadonlyMap<string, AssetSchedule>;
}

function toCents(value: Cents, field: string, assetId: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`asset ${assetId}: ${field} must be a safe integer, got ${value}`);
    }
    return BigInt(value);
  }
  return value;
}

function validateAsset(asset: AssetInput): void {
  if (!Number.isInteger(asset.lifeMonths) || asset.lifeMonths < 1) {
    throw new Error(`asset ${asset.id}: lifeMonths must be a positive integer`);
  }
  if (!Number.isInteger(asset.rate) || asset.rate < 0) {
    throw new Error(`asset ${asset.id}: rate must be a non-negative integer (per 10000)`);
  }
}

/** 预计算某项资产的完整折旧计划（共 L 笔），不响应任何查询。 */
function computeSchedule(asset: AssetInput): AssetSchedule {
  validateAsset(asset);
  const purchaseDate = parseIso(asset.purchaseDate);
  const purchasePrice = toCents(asset.purchasePrice, "purchasePrice", asset.id);
  const salvage = toCents(asset.salvage, "salvage", asset.id);
  if (purchasePrice < 0n || salvage < 0n || salvage > purchasePrice) {
    throw new Error(`asset ${asset.id}: require 0 <= salvage <= purchasePrice`);
  }

  const life = asset.lifeMonths;
  const rate = BigInt(asset.rate);
  const divisor = RATE_SCALE * BigInt(life);
  const entries: ScheduleEntry[] = [];
  let bookValue = purchasePrice;

  for (let k = 1; k <= life; k += 1) {
    let depreciation: bigint;
    if (k < life) {
      // 月初账面值 * r / (10000 * L)，向下取整，且不超过账面值减 S。
      depreciation = (bookValue * rate) / divisor;
      const maxDepreciation = bookValue - salvage;
      if (depreciation > maxDepreciation) depreciation = maxDepreciation;
    } else {
      // 第 L 笔扣至残值 S。
      depreciation = bookValue - salvage;
    }
    bookValue -= depreciation;
    entries.push({ date: addMonths(purchaseDate, k), bookValueAfter: bookValue });
  }
  return { purchaseDate, purchasePrice, entries: Object.freeze(entries) };
}

class Handle implements DepreciationHandle {
  readonly #state: HandleState;

  constructor(state: HandleState) {
    this.#state = state;
    Object.freeze(this);
  }

  get assetCount(): number {
    return this.#state.assets.size;
  }

  lookup(assetId: string): AssetSchedule {
    const schedule = this.#state.assets.get(assetId);
    if (schedule === undefined) {
      throw new Error(`unknown asset id: ${JSON.stringify(assetId)}`);
    }
    return schedule;
  }
}

/** 构建查询句柄。只预计算折旧计划，不执行任何查询。资产集合此后不可变。 */
export function build(assets: readonly AssetInput[]): DepreciationHandle {
  const map = new Map<string, AssetSchedule>();
  for (const asset of assets) {
    if (map.has(asset.id)) {
      throw new Error(`duplicate asset id: ${JSON.stringify(asset.id)}`);
    }
    map.set(asset.id, computeSchedule(asset));
  }
  return new Handle({ assets: map });
}

/** 在升序 entries 中找最后一个 date <= target 的下标，无则返回 -1。 */
function lastEntryNotAfter(entries: readonly ScheduleEntry[], target: CivilDate): number {
  let lo = 0;
  let hi = entries.length; // 答案在 [lo-1, hi-1] 区间内收缩
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const entry = entries[mid];
    if (entry !== undefined && compare(entry.date, target) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1;
}

function bookValueAt(schedule: AssetSchedule, date: CivilDate): bigint | null {
  if (compare(date, schedule.purchaseDate) < 0) {
    return null; // 购置前
  }
  const index = lastEntryNotAfter(schedule.entries, date);
  if (index < 0) {
    return schedule.purchasePrice; // 首笔折旧入账前
  }
  const entry = schedule.entries[index];
  return entry !== undefined ? entry.bookValueAfter : schedule.purchasePrice;
}

/**
 * 批量查询账面值。结果与请求一一对应（含重复项），顺序与请求一致。
 * 购置日前返回 null；寿命结束后固定为残值 S。
 * 每个查询结果与独立逐月执行规则的结果逐分相等，
 * 不受请求乱序、重复或批次历史影响。
 */
export function bookValues(
  handle: DepreciationHandle,
  requests: readonly BookValueRequest[],
): (bigint | null)[] {
  if (!(handle instanceof Handle)) {
    throw new Error("handle must be created by build()");
  }
  return requests.map((request) =>
    bookValueAt(handle.lookup(request.assetId), parseIso(request.date)),
  );
}
