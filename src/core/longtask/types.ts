/**
 * Long-term task board — the shared contract. Ported from IDBots
 * `renderer/types/longTermTask` plus the store's CHECK constraints.
 *
 * A long-term task is a FIRST-CLASS entity, not a projection of the delegation
 * ledger: group tasks, scheduled tasks and one-shot delegations never appear
 * here. The column and the progress are DERIVED read-time (see derive.ts) and
 * are deliberately never stored — a stored copy could disagree with the
 * sub-tasks it summarises.
 */

/** Board columns, in display order. */
export const LONG_TERM_COLUMN_ORDER = [
  'waiting_owner',
  'in_progress',
  'waiting_external',
  'defining',
  'paused',
  'done',
] as const;

export type LongTermColumn = (typeof LONG_TERM_COLUMN_ORDER)[number];

/** The stored task stage. The board column is derived from it. */
export type LongTermTaskStage = 'defining' | 'active' | 'paused' | 'done' | 'cancelled';

export type LongTermSubtaskStatus =
  | 'pending'
  | 'in_progress'
  | 'waiting_owner'
  | 'waiting_external'
  | 'accepted'
  | 'rejected'
  | 'skipped';

export interface LongTermSubtask {
  id: string;
  /** Position within the task; the board orders by it. */
  ordinal: number;
  title: string;
  status: LongTermSubtaskStatus;
  /** Sub-task ids that must be accepted before this one can start. */
  dependsOn: string[];
  /** Positive integer minutes, or null when unestimated. */
  expectedMinutes: number | null;
}

export interface LongTermTaskProgress {
  accepted: number;
  /** Non-skipped sub-tasks — a skipped one leaves both counts. */
  total: number;
  percent: number;
}

/** A long-term task: a first-class entity with its own lifecycle. */
export interface LongTermTask {
  id: string;
  title: string;
  goal: string;
  stage: LongTermTaskStage;
  /** Explicit board pin, honoured only while that sub-task is still open. */
  currentSubtaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Append-only audit line for a task (status moves, escalations, owner nudges). */
export interface LongTermEvent {
  id: string;
  taskId: string;
  subtaskId: string | null;
  kind: string;
  actor: string;
  detail: string | null;
  at: string;
}
