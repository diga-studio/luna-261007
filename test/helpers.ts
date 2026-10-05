import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsentEvent, Selections, Snapshot } from "../src/types.ts";
import { initialSelections } from "../src/types.ts";

export interface TempDb {
  path: string;
  cleanup: () => void;
}

export function tempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "consent-merge-"));
  return {
    path: join(dir, "consent.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function snapshotAtRevision(
  history: ConsentEvent[],
  revision: number,
): Snapshot {
  let selections: Selections = initialSelections();
  for (const event of history) {
    if (event.revision > revision) {
      break;
    }
    const next: Selections = { ...selections };
    for (const category of event.touchedCategories) {
      next[category] = event.selectionsAfter[category];
    }
    selections = next;
  }
  return { revision, selections };
}
