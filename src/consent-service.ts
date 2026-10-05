import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import {
  CATEGORIES,
  type Category,
  type ChoiceValue,
  type Choices,
  type ConsentEvent,
  type Snapshot,
  type SubmitChoicesCommand,
  type WithdrawAllCommand,
  type WriteResult,
} from "./types.js";

export interface ConsentServiceOptions {
  /** SQLite 文件路径，或 ":memory:" */
  path: string;
}

const CATEGORY_COLUMNS: Record<Category, string> = {
  cookies: "cookies",
  emailMarketing: "email_marketing",
  dataSharing: "data_sharing",
  personalization: "personalization",
};

const ALL_REJECTED: Choices = {
  cookies: "rejected",
  emailMarketing: "rejected",
  dataSharing: "rejected",
  personalization: "rejected",
};

function initialSnapshot(): Snapshot {
  return { revision: 0, choices: { ...ALL_REJECTED } };
}

interface StateRow {
  revision: number;
  cookies: number;
  email_marketing: number;
  data_sharing: number;
  personalization: number;
}

interface EventRow {
  revision: number;
  request_id: string;
  kind: string;
  touched_categories: string;
  choices_after: string;
  recorded_at: string;
}

function rowToSnapshot(row: StateRow): Snapshot {
  const value = (n: number): ChoiceValue => (n === 1 ? "granted" : "rejected");
  return {
    revision: row.revision,
    choices: {
      cookies: value(row.cookies),
      emailMarketing: value(row.email_marketing),
      dataSharing: value(row.data_sharing),
      personalization: value(row.personalization),
    },
  };
}

function isCategory(key: string): key is Category {
  return (CATEGORIES as readonly string[]).includes(key);
}

/**
 * 同意选择合并库。同一进程内可创建多个实例指向同一数据库文件。
 * 所有方法均为同步（node:sqlite 为同步驱动），进程内调用天然串行，
 * 因而结果总能按调用完成顺序线性化解释。
 */
export class ConsentService {
  private readonly db: DatabaseSync;

  constructor(options: ConsentServiceOptions) {
    this.db = openDatabase(options.path);
  }

  /** 读取用户当前快照；新用户初始全部拒绝、修订号 0 */
  getSnapshot(userId: string): Snapshot {
    const row = this.db
      .prepare(
        "SELECT revision, cookies, email_marketing, data_sharing, personalization FROM user_state WHERE user_id = ?",
      )
      .get(userId) as StateRow | undefined;
    return row ? rowToSnapshot(row) : initialSnapshot();
  }

  /** 提交部分选择 */
  submitChoices(userId: string, command: SubmitChoicesCommand): WriteResult {
    this.validateSubmit(command);
    return this.executeWrite(userId, command.requestId, () =>
      this.evaluateSubmit(userId, command),
    );
  }

  /** 一键撤回：四个类别全部设为拒绝 */
  withdrawAll(userId: string, command: WithdrawAllCommand): WriteResult {
    if (typeof command.requestId !== "string" || command.requestId.length === 0) {
      throw new TypeError("requestId must be a non-empty string");
    }
    return this.executeWrite(userId, command.requestId, () => ({
      kind: "withdrawAll" as const,
      applied: true,
      conflicts: [],
      touched: [...CATEGORIES],
      choicesAfter: { ...ALL_REJECTED },
    }));
  }

  /** 读取审计历史（按修订号升序） */
  getHistory(userId: string): ConsentEvent[] {
    const rows = this.db
      .prepare(
        "SELECT revision, request_id, kind, touched_categories, choices_after, recorded_at FROM consent_events WHERE user_id = ? ORDER BY revision ASC",
      )
      .all(userId) as unknown as EventRow[];
    return rows.map((row) => ({
      revision: row.revision,
      requestId: row.request_id,
      kind: row.kind as ConsentEvent["kind"],
      touchedCategories: JSON.parse(row.touched_categories) as Category[],
      choicesAfter: JSON.parse(row.choices_after) as Choices,
      recordedAt: row.recorded_at,
    }));
  }

  /** 正常关闭（全部调用结束后） */
  close(): void {
    this.db.close();
  }

  private validateSubmit(command: SubmitChoicesCommand): void {
    if (typeof command.requestId !== "string" || command.requestId.length === 0) {
      throw new TypeError("requestId must be a non-empty string");
    }
    if (!Number.isInteger(command.baseRevision) || command.baseRevision < 0) {
      throw new TypeError("baseRevision must be a non-negative integer");
    }
    for (const [key, value] of Object.entries(command.choices)) {
      if (!isCategory(key)) {
        throw new TypeError(`unknown category: ${key}`);
      }
      if (value !== "granted" && value !== "rejected") {
        throw new TypeError(`invalid choice value for ${key}: ${String(value)}`);
      }
    }
  }

  private evaluateSubmit(
    userId: string,
    command: SubmitChoicesCommand,
  ): {
    kind: "submit";
    applied: boolean;
    conflicts: Category[];
    touched: Category[];
    choicesAfter: Choices;
  } {
    const current = this.getSnapshot(userId);
    const entries = Object.entries(command.choices) as [Category, ChoiceValue][];
    const conflicts: Category[] = [];
    for (const [category, value] of entries) {
      if (value !== "granted") continue;
      const touched = this.db
        .prepare(
          "SELECT 1 AS x FROM event_categories WHERE user_id = ? AND category = ? AND revision > ? LIMIT 1",
        )
        .get(userId, category, command.baseRevision);
      if (touched !== undefined) {
        conflicts.push(category);
      }
    }
    const choicesAfter: Choices = { ...current.choices };
    if (conflicts.length === 0) {
      for (const [category, value] of entries) {
        choicesAfter[category] = value;
      }
    }
    return {
      kind: "submit",
      applied: conflicts.length === 0,
      conflicts,
      touched: entries.map(([category]) => category),
      choicesAfter,
    };
  }

  /**
   * 幂等执行写入命令：同一 (userId, requestId) 重复投递时，
   * 直接返回首次处理的结果（含首次处理时的快照），不重新执行。
   */
  private executeWrite(
    userId: string,
    requestId: string,
    evaluate: () => {
      kind: "submit" | "withdrawAll";
      applied: boolean;
      conflicts: Category[];
      touched: Category[];
      choicesAfter: Choices;
    },
  ): WriteResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT result FROM processed_requests WHERE user_id = ? AND request_id = ?",
        )
        .get(userId, requestId) as { result: string } | undefined;
      if (existing !== undefined) {
        const result = JSON.parse(existing.result) as WriteResult;
        this.db.exec("COMMIT");
        return result;
      }

      const outcome = evaluate();
      const current = this.getSnapshot(userId);
      let result: WriteResult;
      if (outcome.applied) {
        const revision = current.revision + 1;
        const recordedAt = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO user_state (user_id, revision, cookies, email_marketing, data_sharing, personalization)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET
               revision = excluded.revision,
               cookies = excluded.cookies,
               email_marketing = excluded.email_marketing,
               data_sharing = excluded.data_sharing,
               personalization = excluded.personalization`,
          )
          .run(
            userId,
            revision,
            outcome.choicesAfter.cookies === "granted" ? 1 : 0,
            outcome.choicesAfter.emailMarketing === "granted" ? 1 : 0,
            outcome.choicesAfter.dataSharing === "granted" ? 1 : 0,
            outcome.choicesAfter.personalization === "granted" ? 1 : 0,
          );
        this.db
          .prepare(
            `INSERT INTO consent_events
               (user_id, revision, request_id, kind, touched_categories, choices_after, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            revision,
            requestId,
            outcome.kind,
            JSON.stringify(outcome.touched),
            JSON.stringify(outcome.choicesAfter),
            recordedAt,
          );
        const insertCategory = this.db.prepare(
          "INSERT INTO event_categories (user_id, category, revision) VALUES (?, ?, ?)",
        );
        for (const category of new Set(outcome.touched)) {
          insertCategory.run(userId, category, revision);
        }
        result = {
          status: "applied",
          snapshot: { revision, choices: outcome.choicesAfter },
        };
      } else {
        result = {
          status: "conflict",
          snapshot: current,
          conflicts: outcome.conflicts,
        };
      }
      this.db
        .prepare(
          "INSERT INTO processed_requests (user_id, request_id, result) VALUES (?, ?, ?)",
        )
        .run(userId, requestId, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
