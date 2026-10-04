import { isClassCompliant, isTransferAreaCompliant } from "./compliance.js";
import type { ClassInput, ChildInput, Move, PlanInput, VerifyResult } from "./types.js";
import { TRANSFER_AREA_ID } from "./types.js";

function fail(moveIndex: number | undefined, reason: string): VerifyResult {
  return moveIndex === undefined ? { ok: false, reason } : { ok: false, moveIndex, reason };
}

/**
 * Replays a move sequence against the input, checking every rule step by
 * step and confirming the final placement matches the targets.
 */
export function verifyMoves(input: PlanInput, moves: Move[]): VerifyResult {
  const classById = new Map<string, ClassInput>();
  for (const classDef of input.classes) {
    if (classById.has(classDef.id)) {
      return fail(undefined, `Duplicate class id "${classDef.id}".`);
    }
    classById.set(classDef.id, classDef);
  }

  const childById = new Map<string, ChildInput>();
  const locationOf = new Map<string, string>();
  const rosterOf = new Map<string, Set<string>>();
  for (const classDef of input.classes) {
    rosterOf.set(classDef.id, new Set());
  }
  const transferArea = new Set<string>();

  for (const child of input.children) {
    if (childById.has(child.id)) {
      return fail(undefined, `Duplicate child id "${child.id}".`);
    }
    childById.set(child.id, child);
    const roster = rosterOf.get(child.initialClassId);
    if (!roster) {
      return fail(undefined, `Child "${child.id}" references unknown class "${child.initialClassId}".`);
    }
    if (!classById.has(child.targetClassId)) {
      return fail(undefined, `Child "${child.id}" references unknown class "${child.targetClassId}".`);
    }
    roster.add(child.id);
    locationOf.set(child.id, child.initialClassId);
  }

  const checkClass = (classId: string, moveIndex: number): VerifyResult | null => {
    const roster = rosterOf.get(classId)!;
    const categories = [...roster].map((id) => childById.get(id)!.category);
    if (!isClassCompliant(classById.get(classId)!, categories)) {
      return fail(moveIndex, `Class "${classId}" violates its ratio/capacity after this move.`);
    }
    return null;
  };

  for (let moveIndex = 0; moveIndex < moves.length; moveIndex++) {
    const move = moves[moveIndex];
    const child = childById.get(move.childId);
    if (!child) {
      return fail(moveIndex, `Unknown child "${move.childId}".`);
    }
    const current = locationOf.get(move.childId)!;
    if (current !== move.from) {
      return fail(
        moveIndex,
        `Child "${move.childId}" is in "${current}", not in "${move.from}".`,
      );
    }
    if (move.to !== TRANSFER_AREA_ID && !classById.has(move.to)) {
      return fail(moveIndex, `Unknown destination "${move.to}".`);
    }

    if (current === TRANSFER_AREA_ID) {
      if (move.to !== child.targetClassId) {
        return fail(
          moveIndex,
          `Child "${move.childId}" may only leave the transfer area for target class "${child.targetClassId}".`,
        );
      }
    } else {
      if (current === child.targetClassId) {
        return fail(
          moveIndex,
          `Child "${move.childId}" has already reached target class "${child.targetClassId}" and must not move again.`,
        );
      }
      if (current !== child.initialClassId) {
        return fail(
          moveIndex,
          `Child "${move.childId}" is in unexpected class "${current}".`,
        );
      }
      if (move.to !== TRANSFER_AREA_ID && move.to !== child.targetClassId) {
        return fail(
          moveIndex,
          `Child "${move.childId}" may only move to the transfer area or to target class "${child.targetClassId}".`,
        );
      }
    }

    // Apply the move.
    if (current === TRANSFER_AREA_ID) {
      transferArea.delete(move.childId);
    } else {
      rosterOf.get(current)!.delete(move.childId);
    }
    if (move.to === TRANSFER_AREA_ID) {
      transferArea.add(move.childId);
    } else {
      rosterOf.get(move.to)!.add(move.childId);
    }
    locationOf.set(move.childId, move.to);

    if (!isTransferAreaCompliant(transferArea.size)) {
      return fail(moveIndex, "Transfer area exceeds its capacity of 2 children.");
    }
    if (current !== TRANSFER_AREA_ID) {
      const violation = checkClass(current, moveIndex);
      if (violation) return violation;
    }
    if (move.to !== TRANSFER_AREA_ID) {
      const violation = checkClass(move.to, moveIndex);
      if (violation) return violation;
    }
  }

  for (const child of input.children) {
    if (locationOf.get(child.id) !== child.targetClassId) {
      return fail(
        undefined,
        `Child "${child.id}" ends in "${locationOf.get(child.id)}" instead of target class "${child.targetClassId}".`,
      );
    }
  }
  return { ok: true };
}
