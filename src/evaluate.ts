import type { AddressRule, EvaluationResult, NapProfile } from "./types.js";
import { tokenizeStreet } from "./tokenize.js";
import { bestInterpretations } from "./interpretations.js";

const SEQUENCE_SEPARATOR = "";

function sequenceKey(tokens: readonly string[]): string {
  return tokens.join(SEQUENCE_SEPARATOR);
}

function distinctSequences(
  interpretations: readonly { tokens: readonly string[] }[],
): Map<string, readonly string[]> {
  const sequences = new Map<string, readonly string[]>();
  for (const interpretation of interpretations) {
    const key = sequenceKey(interpretation.tokens);
    if (!sequences.has(key)) sequences.set(key, interpretation.tokens);
  }
  return sequences;
}

/**
 * 处理一家门店及其预期目录资料，返回判定与核验依据。
 * 纯函数，无持久化副作用。
 */
export function evaluateStore(
  canonical: NapProfile,
  directory: NapProfile | null,
  rules: readonly AddressRule[],
): EvaluationResult {
  if (directory === null) {
    return { verdict: "missing" };
  }

  // 名称、电话、城市、州、邮编、独立单元号逐项精确比较。
  if (
    canonical.name !== directory.name ||
    canonical.phone !== directory.phone ||
    canonical.city !== directory.city ||
    canonical.state !== directory.state ||
    canonical.postalCode !== directory.postalCode ||
    canonical.unit !== directory.unit
  ) {
    return { verdict: "conflict" };
  }

  // 只有街道文本参与歧义判定；双方分别应用适合其州的规则。
  const canonicalSequences = distinctSequences(
    bestInterpretations(tokenizeStreet(canonical.street), rules, canonical.state),
  );
  const directorySequences = distinctSequences(
    bestInterpretations(tokenizeStreet(directory.street), rules, directory.state),
  );

  const commonKeys = [...canonicalSequences.keys()].filter((key) =>
    directorySequences.has(key),
  );

  // 双方全部有效解释都得到同一个词元序列。
  if (
    canonicalSequences.size === 1 &&
    directorySequences.size === 1 &&
    commonKeys.length === 1
  ) {
    return { verdict: "consistent" };
  }

  if (commonKeys.length === 0) {
    return { verdict: "conflict" };
  }

  // 待核验：附一个共同序列，以及双方各一个彼此不同的有效序列。
  const commonSequence = canonicalSequences.get(commonKeys[0])!;
  let canonicalOnly: readonly string[] | undefined;
  let directoryOnly: readonly string[] | undefined;
  for (const candidate of canonicalSequences.values()) {
    for (const other of directorySequences.values()) {
      if (sequenceKey(candidate) !== sequenceKey(other)) {
        canonicalOnly = candidate;
        directoryOnly = other;
        break;
      }
    }
    if (canonicalOnly !== undefined) break;
  }

  return {
    verdict: "needs_review",
    evidence: {
      commonSequence,
      canonicalOnlySequence: canonicalOnly!,
      directoryOnlySequence: directoryOnly!,
    },
  };
}
