export const CATEGORIES = [
  "cookies",
  "email_marketing",
  "data_sharing",
  "personalization",
] as const;

export type Category = (typeof CATEGORIES)[number];

export type Selections = Record<Category, boolean>;

export interface Snapshot {
  revision: number;
  selections: Selections;
}

export interface PartialChoiceCommand {
  userId: string;
  requestId: string;
  baseRevision: number;
  choices: Partial<Record<Category, boolean>>;
}

export type CommandStatus = "applied" | "conflict";

export interface CommandResult {
  status: CommandStatus;
  snapshot: Snapshot;
  conflictingCategories: Category[];
}

export type EventKind = "partial" | "withdraw_all";

export interface ConsentEvent {
  userId: string;
  revision: number;
  requestId: string;
  kind: EventKind;
  touchedCategories: Category[];
  selectionsAfter: Selections;
  createdAt: string;
}

export function initialSelections(): Selections {
  return {
    cookies: false,
    email_marketing: false,
    data_sharing: false,
    personalization: false,
  };
}
