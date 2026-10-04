import { isClassCompliant, isTransferAreaCompliant } from "./compliance.js";
import type {
  ClassInput,
  Move,
  PlanInput,
  PlanOptions,
  PlanResult,
  RatioCategory,
} from "./types.js";
import { TRANSFER_AREA_ID } from "./types.js";

const DEFAULT_MAX_STATES = 2_000_000;

/** Children that must change class, grouped by (origin, target, category). */
interface MoverGroup {
  originClassId: string;
  targetClassId: string;
  category: RatioCategory;
  childIds: string[];
}

/** BFS state: for each group, how many children are still at origin / in the transfer area. */
interface SearchNode {
  atOrigin: number[];
  atTransfer: number[];
  parentKey: string | null;
  /** Move that led to this node (undefined for the root). */
  move?: GroupMove;
}

interface GroupMove {
  groupIndex: number;
  kind: "origin-to-transfer" | "origin-to-target" | "transfer-to-target";
}

const MOVE_KINDS: ReadonlyArray<GroupMove["kind"]> = [
  "origin-to-target",
  "origin-to-transfer",
  "transfer-to-target",
];

function stateKey(atOrigin: number[], atTransfer: number[]): string {
  let key = "";
  for (let i = 0; i < atOrigin.length; i++) {
    key += `${atOrigin[i]},${atTransfer[i]};`;
  }
  return key;
}

/**
 * Counts children currently present in a class, per category, including the
 * fixed stayers and the movers located in that class (at origin or arrived).
 */
function classComposition(
  classIndex: number,
  stayers: Array<Partial<Record<RatioCategory, number>>>,
  groups: MoverGroup[],
  groupClassRoles: Array<Array<{ groupIndex: number; role: "origin" | "target" }>>,
  atOrigin: number[],
  atTransfer: number[],
): Partial<Record<RatioCategory, number>> {
  const counts: Partial<Record<RatioCategory, number>> = { ...stayers[classIndex] };
  for (const { groupIndex, role } of groupClassRoles[classIndex]) {
    const group = groups[groupIndex];
    const located =
      role === "origin"
        ? atOrigin[groupIndex]
        : group.childIds.length - atOrigin[groupIndex] - atTransfer[groupIndex];
    if (located > 0) {
      counts[group.category] = (counts[group.category] ?? 0) + located;
    }
  }
  return counts;
}

function compositionToCategories(
  counts: Partial<Record<RatioCategory, number>>,
): RatioCategory[] {
  const categories: RatioCategory[] = [];
  for (const category of Object.keys(counts) as RatioCategory[]) {
    for (let i = 0; i < (counts[category] ?? 0); i++) {
      categories.push(category);
    }
  }
  return categories;
}

function validateInput(input: PlanInput): string | null {
  const classIds = new Set<string>();
  for (const classDef of input.classes) {
    if (classDef.id === TRANSFER_AREA_ID) {
      return `Class id "${TRANSFER_AREA_ID}" is reserved for the transfer area.`;
    }
    if (classIds.has(classDef.id)) {
      return `Duplicate class id "${classDef.id}".`;
    }
    classIds.add(classDef.id);
  }
  const childIds = new Set<string>();
  for (const child of input.children) {
    if (childIds.has(child.id)) {
      return `Duplicate child id "${child.id}".`;
    }
    childIds.add(child.id);
    if (child.initialClassId === TRANSFER_AREA_ID || child.targetClassId === TRANSFER_AREA_ID) {
      return `Child "${child.id}" uses the reserved transfer area id.`;
    }
    if (!classIds.has(child.initialClassId)) {
      return `Child "${child.id}" references unknown initial class "${child.initialClassId}".`;
    }
    if (!classIds.has(child.targetClassId)) {
      return `Child "${child.id}" references unknown target class "${child.targetClassId}".`;
    }
  }
  return null;
}

/**
 * Computes a complete, globally move-minimal transfer sequence.
 * Never mutates the caller's input.
 */
export function planTransfers(input: PlanInput, options?: PlanOptions): PlanResult {
  const maxStates = options?.maxStates ?? DEFAULT_MAX_STATES;

  const validationError = validateInput(input);
  if (validationError) {
    return { ok: false, reason: validationError };
  }

  const classes: ClassInput[] = input.classes;
  const classIndexById = new Map<string, number>();
  classes.forEach((classDef, index) => classIndexById.set(classDef.id, index));

  // Split children into stayers (never move) and mover groups.
  const stayers: Array<Partial<Record<RatioCategory, number>>> = classes.map(() => ({}));
  const groupByKey = new Map<string, MoverGroup>();
  for (const child of input.children) {
    if (child.initialClassId === child.targetClassId) {
      const classIndex = classIndexById.get(child.initialClassId)!;
      const counts = stayers[classIndex];
      counts[child.category] = (counts[child.category] ?? 0) + 1;
      continue;
    }
    const key = `${child.initialClassId}|${child.targetClassId}|${child.category}`;
    let group = groupByKey.get(key);
    if (!group) {
      group = {
        originClassId: child.initialClassId,
        targetClassId: child.targetClassId,
        category: child.category,
        childIds: [],
      };
      groupByKey.set(key, group);
    }
    group.childIds.push(child.id);
  }
  const groups = [...groupByKey.values()];

  // Per class, which groups have children physically located there (and why).
  const groupClassRoles: Array<Array<{ groupIndex: number; role: "origin" | "target" }>> =
    classes.map(() => []);
  groups.forEach((group, groupIndex) => {
    groupClassRoles[classIndexById.get(group.originClassId)!].push({ groupIndex, role: "origin" });
    groupClassRoles[classIndexById.get(group.targetClassId)!].push({ groupIndex, role: "target" });
  });

  const compositionOf = (classIndex: number, atOrigin: number[], atTransfer: number[]) =>
    classComposition(classIndex, stayers, groups, groupClassRoles, atOrigin, atTransfer);

  const isCompliantComposition = (
    classIndex: number,
    counts: Partial<Record<RatioCategory, number>>,
  ) => isClassCompliant(classes[classIndex], compositionToCategories(counts));

  // Sanity-check the guaranteed-compliant initial and final placements.
  const initialAtOrigin = groups.map((group) => group.childIds.length);
  const initialAtTransfer = groups.map(() => 0);
  for (let classIndex = 0; classIndex < classes.length; classIndex++) {
    if (!isCompliantComposition(classIndex, compositionOf(classIndex, initialAtOrigin, initialAtTransfer))) {
      return {
        ok: false,
        reason: `Initial placement of class "${classes[classIndex].id}" is not compliant.`,
      };
    }
  }
  const finalAtOrigin = groups.map(() => 0);
  for (let classIndex = 0; classIndex < classes.length; classIndex++) {
    if (!isCompliantComposition(classIndex, compositionOf(classIndex, finalAtOrigin, initialAtTransfer))) {
      return {
        ok: false,
        reason: `Target placement of class "${classes[classIndex].id}" is not compliant.`,
      };
    }
  }

  if (groups.length === 0) {
    return { ok: true, moves: [] };
  }

  const isGoal = (atOrigin: number[], atTransfer: number[]) =>
    atOrigin.every((count) => count === 0) && atTransfer.every((count) => count === 0);

  // Breadth-first search: every move costs 1, so the first goal reached is optimal.
  const nodes = new Map<string, SearchNode>();
  const rootKey = stateKey(initialAtOrigin, initialAtTransfer);
  nodes.set(rootKey, {
    atOrigin: initialAtOrigin,
    atTransfer: initialAtTransfer,
    parentKey: null,
  });
  let frontier: string[] = [rootKey];
  let goalKey: string | null = null;

  while (frontier.length > 0 && goalKey === null) {
    if (nodes.size > maxStates) {
      return {
        ok: false,
        reason: `Search aborted after exploring ${maxStates} states (limit reached; impossibility not proven).`,
      };
    }
    const nextFrontier: string[] = [];
    for (const key of frontier) {
      const node = nodes.get(key)!;
      const transferCount = node.atTransfer.reduce((sum, count) => sum + count, 0);

      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex];
        const targetClassIndex = classIndexById.get(group.targetClassId)!;

        for (const kind of MOVE_KINDS) {
          if (kind === "origin-to-target" && node.atOrigin[groupIndex] === 0) continue;
          if (kind === "origin-to-transfer" && node.atOrigin[groupIndex] === 0) continue;
          if (kind === "transfer-to-target" && node.atTransfer[groupIndex] === 0) continue;
          if (kind === "origin-to-transfer" && !isTransferAreaCompliant(transferCount + 1)) {
            continue;
          }

          // For moves into the target class, the target must stay compliant.
          if (kind !== "origin-to-transfer") {
            const counts = compositionOf(targetClassIndex, node.atOrigin, node.atTransfer);
            counts[group.category] = (counts[group.category] ?? 0) + 1;
            if (!isCompliantComposition(targetClassIndex, counts)) {
              continue;
            }
          }

          const nextAtOrigin = [...node.atOrigin];
          const nextAtTransfer = [...node.atTransfer];
          if (kind === "origin-to-transfer") {
            nextAtOrigin[groupIndex]--;
            nextAtTransfer[groupIndex]++;
          } else if (kind === "origin-to-target") {
            nextAtOrigin[groupIndex]--;
          } else {
            nextAtTransfer[groupIndex]--;
          }
          const nextKey = stateKey(nextAtOrigin, nextAtTransfer);
          if (nodes.has(nextKey)) continue;

          nodes.set(nextKey, {
            atOrigin: nextAtOrigin,
            atTransfer: nextAtTransfer,
            parentKey: key,
            move: { groupIndex, kind },
          });
          if (isGoal(nextAtOrigin, nextAtTransfer)) {
            goalKey = nextKey;
            break;
          }
          nextFrontier.push(nextKey);
        }
        if (goalKey !== null) break;
      }
      if (goalKey !== null) break;
    }
    frontier = nextFrontier;
  }

  if (goalKey === null) {
    return {
      ok: false,
      reason:
        "No legal move sequence reaches the target placement while keeping every class and the transfer area compliant.",
    };
  }

  // Walk back the BFS tree, then replay forward to assign concrete child ids.
  const groupMoves: GroupMove[] = [];
  for (let key: string | null = goalKey; key !== null; ) {
    const node: SearchNode = nodes.get(key)!;
    if (node.move) {
      groupMoves.push(node.move);
    }
    key = node.parentKey;
  }
  groupMoves.reverse();

  const atOriginIds = groups.map((group) => [...group.childIds]);
  const atTransferIds: string[][] = groups.map(() => []);
  const moves: Move[] = [];
  for (const groupMove of groupMoves) {
    const group = groups[groupMove.groupIndex];
    if (groupMove.kind === "origin-to-transfer") {
      const childId = atOriginIds[groupMove.groupIndex].shift()!;
      atTransferIds[groupMove.groupIndex].push(childId);
      moves.push({ childId, from: group.originClassId, to: TRANSFER_AREA_ID });
    } else if (groupMove.kind === "origin-to-target") {
      const childId = atOriginIds[groupMove.groupIndex].shift()!;
      moves.push({ childId, from: group.originClassId, to: group.targetClassId });
    } else {
      const childId = atTransferIds[groupMove.groupIndex].shift()!;
      moves.push({ childId, from: TRANSFER_AREA_ID, to: group.targetClassId });
    }
  }

  return { ok: true, moves };
}
