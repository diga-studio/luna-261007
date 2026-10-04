/** 儿童比例类别：婴儿 / 幼儿 / 学前儿童 */
export type RatioCategory = 'infant' | 'toddler' | 'preschool';

/** 每名儿童的比例类别、初始班级与最终目标班级，均由调用方给定 */
export interface ChildInput {
  readonly id: string;
  readonly category: RatioCategory;
  readonly initialClassId: string;
  readonly targetClassId: string;
}

/** 正式班：教师人数固定 */
export interface ClassInput {
  readonly id: string;
  readonly teachers: number;
}

/** 一次规划的完整输入；规划期间保持不变，且不会被修改 */
export interface PlanInput {
  readonly classes: readonly ClassInput[];
  readonly children: readonly ChildInput[];
}

/** 一步交接动作 */
export type Move =
  | { readonly kind: 'direct'; readonly childId: string; readonly fromClassId: string; readonly toClassId: string }
  | { readonly kind: 'toHolding'; readonly childId: string; readonly fromClassId: string }
  | { readonly kind: 'fromHolding'; readonly childId: string; readonly toClassId: string };

export type PlanResult =
  | { readonly ok: true; readonly moves: readonly Move[] }
  | { readonly ok: false; readonly reason: string };
