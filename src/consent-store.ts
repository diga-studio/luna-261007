import { DatabaseSync } from "node:sqlite";
import type {
  Category,
  CommandResult,
  ConsentEvent,
  EventKind,
  PartialChoiceCommand,
  Selections,
  Snapshot,
} from "./types.ts";
import { CATEGORIES, initialSelections } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS states (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  selections TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  touched TEXT NOT NULL,
  selections_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, revision)
);
CREATE TABLE IF NOT EXISTS event_categories (
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  category TEXT NOT NULL,
  PRIMARY KEY (user_id, revision, category)
);
CREATE INDEX IF NOT EXISTS idx_event_categories_lookup
  ON event_categories (user_id, category, revision);
CREATE TABLE IF NOT EXISTS requests (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  snapshot_selections TEXT NOT NULL,
  conflicting TEXT NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
`;

interface StateRow {
  revision: number;
  selections: string;
}

interface RequestRow {
  status: string;
  snapshot_revision: number;
  snapshot_selections: string;
  conflicting: string;
}

interface EventRow {
  revision: number;
  request_id: string;
  kind: string;
  touched: string;
  selections_after: string;
  created_at: string;
}

export class ConsentStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  async getSnapshot(userId: string): Promise<Snapshot> {
    return this.readSnapshot(userId);
  }

  async submitPartialChoice(
    command: PartialChoiceCommand,
  ): Promise<CommandResult> {
    return this.runWrite(command.userId, command.requestId, (current) => {
      const conflicting = this.findConflictingGrants(command);
      if (conflicting.length > 0) {
        return {
          status: "conflict",
          snapshot: current,
          conflictingCategories: conflicting,
        };
      }
      const selections: Selections = { ...current.selections };
      const touched: Category[] = [];
      for (const category of CATEGORIES) {
        const value = command.choices[category];
        if (value !== undefined) {
          selections[category] = value;
          touched.push(category);
        }
      }
      const snapshot = this.applyEvent(
        command.userId,
        command.requestId,
        "partial",
        current,
        selections,
        touched,
      );
      return { status: "applied", snapshot, conflictingCategories: [] };
    });
  }

  async withdrawAll(userId: string, requestId: string): Promise<CommandResult> {
    return this.runWrite(userId, requestId, (current) => {
      const selections = initialSelections();
      const snapshot = this.applyEvent(
        userId,
        requestId,
        "withdraw_all",
        current,
        selections,
        [...CATEGORIES],
      );
      return { status: "applied", snapshot, conflictingCategories: [] };
    });
  }

  async getAuditHistory(userId: string): Promise<ConsentEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT revision, request_id, kind, touched, selections_after, created_at
         FROM events WHERE user_id = ? ORDER BY revision ASC`,
      )
      .all(userId) as unknown as EventRow[];
    return rows.map((row) => ({
      userId,
      revision: row.revision,
      requestId: row.request_id,
      kind: row.kind as EventKind,
      touchedCategories: JSON.parse(row.touched) as Category[],
      selectionsAfter: JSON.parse(row.selections_after) as Selections,
      createdAt: row.created_at,
    }));
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private readSnapshot(userId: string): Snapshot {
    const row = this.db
      .prepare("SELECT revision, selections FROM states WHERE user_id = ?")
      .get(userId) as unknown as StateRow | undefined;
    if (row === undefined) {
      return { revision: 0, selections: initialSelections() };
    }
    return {
      revision: row.revision,
      selections: JSON.parse(row.selections) as Selections,
    };
  }

  private runWrite(
    userId: string,
    requestId: string,
    execute: (current: Snapshot) => CommandResult,
  ): CommandResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          `SELECT status, snapshot_revision, snapshot_selections, conflicting
           FROM requests WHERE user_id = ? AND request_id = ?`,
        )
        .get(userId, requestId) as unknown as RequestRow | undefined;
      if (existing !== undefined) {
        const result: CommandResult = {
          status: existing.status as CommandResult["status"],
          snapshot: {
            revision: existing.snapshot_revision,
            selections: JSON.parse(existing.snapshot_selections) as Selections,
          },
          conflictingCategories: JSON.parse(existing.conflicting) as Category[],
        };
        this.db.exec("COMMIT");
        return result;
      }
      const current = this.readSnapshot(userId);
      const result = execute(current);
      this.db
        .prepare(
          `INSERT INTO requests
             (user_id, request_id, status, snapshot_revision, snapshot_selections, conflicting)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          requestId,
          result.status,
          result.snapshot.revision,
          JSON.stringify(result.snapshot.selections),
          JSON.stringify(result.conflictingCategories),
        );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private findConflictingGrants(command: PartialChoiceCommand): Category[] {
    const stmt = this.db.prepare(
      `SELECT 1 FROM event_categories
       WHERE user_id = ? AND category = ? AND revision > ? LIMIT 1`,
    );
    const conflicting: Category[] = [];
    for (const category of CATEGORIES) {
      if (command.choices[category] !== true) {
        continue;
      }
      const hit = stmt.get(command.userId, category, command.baseRevision);
      if (hit !== undefined) {
        conflicting.push(category);
      }
    }
    return conflicting;
  }

  private applyEvent(
    userId: string,
    requestId: string,
    kind: EventKind,
    current: Snapshot,
    selections: Selections,
    touched: Category[],
  ): Snapshot {
    const revision = current.revision + 1;
    const snapshot: Snapshot = { revision, selections };
    this.db
      .prepare(
        `INSERT INTO states (user_id, revision, selections) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           revision = excluded.revision, selections = excluded.selections`,
      )
      .run(userId, revision, JSON.stringify(selections));
    this.db
      .prepare(
        `INSERT INTO events
           (user_id, revision, request_id, kind, touched, selections_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        revision,
        requestId,
        kind,
        JSON.stringify(touched),
        JSON.stringify(selections),
        new Date().toISOString(),
      );
    const touchStmt = this.db.prepare(
      `INSERT INTO event_categories (user_id, revision, category) VALUES (?, ?, ?)`,
    );
    for (const category of touched) {
      touchStmt.run(userId, revision, category);
    }
    return snapshot;
  }
}
