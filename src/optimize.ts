/**
 * 方案比较键：先比暴露量，再比授权数量，最后比编号序列字典序。
 */
interface Candidate {
  exposure: number;
  count: number;
  sortedIds: number[];
}

function isBetter(a: Candidate, b: Candidate | null): boolean {
  if (b === null) return true;
  if (a.exposure !== b.exposure) return a.exposure < b.exposure;
  if (a.count !== b.count) return a.count < b.count;
  for (let i = 0; i < a.sortedIds.length; i++) {
    if (a.sortedIds[i] !== b.sortedIds[i]) return a.sortedIds[i] < b.sortedIds[i];
  }
  return false;
}

/**
 * 在候选授权中精确搜索全局最优保留方案。
 *
 * 目标（按优先级）：
 * 1. 可行：证据三元组全部被保留授权覆盖；
 * 2. 暴露最小：保留授权覆盖范围并集中、未出现在证据中的键数量最少；
 * 3. 保留授权数量最少；
 * 4. 编号升序序列字典序最小。
 *
 * 复杂度为 O(2^n)，n 为与证据有交集的授权数量；治理场景下单用户
 * 授权数量有限，且搜索带有充分剪枝。
 *
 * @param grantIds     候选授权编号（任意顺序，结果与之无关）
 * @param coverageKeys 每个授权覆盖的三元组键集合（与 grantIds 对齐）
 * @param evidenceKeys 必须被覆盖的证据三元组键
 * @returns 保留授权编号，按数值升序
 */
export function findOptimalKeep(
  grantIds: readonly number[],
  coverageKeys: readonly ReadonlySet<string>[],
  evidenceKeys: ReadonlySet<string>,
): number[] {
  // 按编号升序固定搜索顺序，保证行为与输入顺序无关。
  const order = grantIds
    .map((id, index) => ({ id, index }))
    .sort((a, b) => a.id - b.id);
  const n = order.length;

  // 每个授权覆盖的证据键、以及暴露键（覆盖但不在证据中的键）。
  const evidenceParts: string[][] = [];
  const excessParts: string[][] = [];
  for (const { index } of order) {
    const ev: string[] = [];
    const ex: string[] = [];
    for (const key of coverageKeys[index]) {
      if (evidenceKeys.has(key)) ev.push(key);
      else ex.push(key);
    }
    evidenceParts.push(ev);
    excessParts.push(ex);
  }

  let best: Candidate | null = null;
  const chosen: number[] = [];
  const covered = new Set<string>();
  const exposed = new Set<string>();

  function evaluate(): void {
    const candidate: Candidate = {
      exposure: exposed.size,
      count: chosen.length,
      sortedIds: [...chosen].sort((a, b) => a - b),
    };
    if (isBetter(candidate, best)) best = candidate;
  }

  function dfs(pos: number): void {
    // 剪枝：暴露量或授权数量已不可能更优。
    if (best !== null) {
      if (exposed.size > best.exposure) return;
      if (exposed.size === best.exposure && chosen.length >= best.count) return;
    }
    // 证据已全部覆盖：继续增加授权只会变差，直接评估。
    if (covered.size === evidenceKeys.size) {
      evaluate();
      return;
    }
    if (pos === n) return;

    // 分支一：选择 order[pos]。
    const addedCovered: string[] = [];
    for (const key of evidenceParts[pos]) {
      if (!covered.has(key)) {
        covered.add(key);
        addedCovered.push(key);
      }
    }
    const addedExposed: string[] = [];
    for (const key of excessParts[pos]) {
      if (!exposed.has(key)) {
        exposed.add(key);
        addedExposed.push(key);
      }
    }
    chosen.push(order[pos].id);
    dfs(pos + 1);
    chosen.pop();
    for (const key of addedCovered) covered.delete(key);
    for (const key of addedExposed) exposed.delete(key);

    // 分支二：不选 order[pos]。
    dfs(pos + 1);
  }

  dfs(0);
  // 题设保证成功访问均能被当前授权覆盖，因此必有可行解。
  const getBest = (): Candidate | null => best;
  return getBest()?.sortedIds ?? [];
}
