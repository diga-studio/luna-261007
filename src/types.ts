/** 公历日期，格式 "YYYY-MM-DD"。 */
export type IsoDate = string;

/** 金额以整数分表示；对外同时接受 number 与 bigint，内部一律用 bigint 精确计算。 */
export type Cents = number | bigint;

/** 固定资产输入。资产集合在 build 后不可变。 */
export interface AssetInput {
  readonly id: string;
  /** 购置日，公历日，"YYYY-MM-DD"。 */
  readonly purchaseDate: IsoDate;
  /** 购置价 P，整数分。 */
  readonly purchasePrice: Cents;
  /** 残值 S，整数分。 */
  readonly salvage: Cents;
  /** 寿命 L，单位月，>= 1。 */
  readonly lifeMonths: number;
  /** 递减倍数 r，万分数：20000 表示 200%。 */
  readonly rate: number;
}

/** 单次查询请求。 */
export interface BookValueRequest {
  readonly assetId: string;
  readonly date: IsoDate;
}

/** build 返回的句柄：只读、可重复用于任意批次查询。 */
export interface DepreciationHandle {
  readonly assetCount: number;
}
