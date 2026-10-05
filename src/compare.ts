import { validInterpretations } from "./interpret.js";
import { tokenize } from "./tokenize.js";
import type { AddressRule, Judgment, NapRecord } from "./types.js";

/** 除街道外逐项精确比较的字段。 */
const EXACT_FIELDS = ["name", "phone", "city", "state", "zip", "unit"] as const;

function sequenceKey(sequence: readonly string[]): string {
  return sequence.join("");
}

/** 判定一家门店的规范资料与目录资料（为空表示缺失）的 NAP 一致性。 */
export function judgeNap(
  canonical: NapRecord,
  directory: NapRecord | null,
  rules: readonly AddressRule[],
): Judgment {
  if (directory === null) {
    return { verdict: "missing" };
  }

  const conflictFields = EXACT_FIELDS.filter(
    (field) => canonical[field] !== directory[field],
  );
  if (conflictFields.length > 0) {
    return { verdict: "conflict", conflictFields };
  }

  const canonicalSequences = validInterpretations(
    tokenize(canonical.street),
    canonical.state,
    rules,
  );
  const directorySequences = validInterpretations(
    tokenize(directory.street),
    directory.state,
    rules,
  );

  const directoryKeys = new Set(directorySequences.map(sequenceKey));
  const common = canonicalSequences.filter((sequence) =>
    directoryKeys.has(sequenceKey(sequence)),
  );

  const allSequences = new Map<string, readonly string[]>();
  for (const sequence of [...canonicalSequences, ...directorySequences]) {
    allSequences.set(sequenceKey(sequence), sequence);
  }

  if (allSequences.size === 1) {
    return { verdict: "consistent" };
  }
  if (common.length === 0) {
    return { verdict: "conflict", conflictFields: ["street"] };
  }

  let canonicalSequence: readonly string[] | undefined;
  let directorySequence: readonly string[] | undefined;
  for (const candidate of canonicalSequences) {
    const other = directorySequences.find(
      (sequence) => sequenceKey(sequence) !== sequenceKey(candidate),
    );
    if (other !== undefined) {
      canonicalSequence = candidate;
      directorySequence = other;
      break;
    }
  }
  if (canonicalSequence === undefined || directorySequence === undefined) {
    for (const candidate of directorySequences) {
      const other = canonicalSequences.find(
        (sequence) => sequenceKey(sequence) !== sequenceKey(candidate),
      );
      if (other !== undefined) {
        directorySequence = candidate;
        canonicalSequence = other;
        break;
      }
    }
  }

  return {
    verdict: "needs_review",
    evidence: {
      commonSequence: common[0],
      canonicalSequence: canonicalSequence ?? canonicalSequences[0],
      directorySequence: directorySequence ?? directorySequences[0],
    },
  };
}
