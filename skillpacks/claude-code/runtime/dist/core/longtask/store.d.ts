/**
 * Long-term task persistence, on the file layout (storage layout v2): one
 * directory per module holding one JSON file per dataset — `tasks.json`,
 * `subtasks.json`, `events.json`. Writes go through atomic write-then-rename
 * plus a per-store serialized queue, the same pattern as the surf and schedule
 * stores, so a daemon tick and an HTTP handler sharing one instance can never
 * interleave a read-modify-write cycle.
 *
 * The reference implementation keeps this in SQLite with CHECK constraints and
 * a UNIQUE(task_id, ordinal). There is no SQLite anywhere in this repository,
 * so those constraints live here as write-time validation instead — a bad
 * stage, a bad sub-task status or a duplicate ordinal is refused before the
 * file is written, not after it is read.
 *
 * Deliberately NOT stored: the board column and the progress. Both are derived
 * read-time (see derive.ts); a stored copy could disagree with the sub-tasks it
 * summarises.
 */
import type { LongTermColumn, LongTermEvent, LongTermSubtask, LongTermSubtaskStatus, LongTermTask, LongTermTaskProgress, LongTermTaskStage } from './types.js';
/**
 * The five central-registry keys this store needs. Taking them as a structural
 * shape keeps the store free of a paths-module import while staying wired to
 * the one place paths are resolved.
 */
export interface LongTermStoreRoots {
    longtermRoot: string;
    longtermTasksPath: string;
    longtermSubtasksPath: string;
    longtermEventsPath: string;
    longtermNudgeStatePath: string;
}
export interface LongTermStorePaths {
    /** Directory holding the three JSON files. */
    root: string;
    tasksPath: string;
    subtasksPath: string;
    eventsPath: string;
    nudgeStatePath: string;
}
/** A stored sub-task carries its owning task id. */
export interface LongTermStoredSubtask extends LongTermSubtask {
    taskId: string;
}
/** One board card: the task plus its read-time derivations. */
export interface LongTermBoardCard {
    task: LongTermTask;
    column: LongTermColumn | null;
    progress: LongTermTaskProgress;
    currentSubtask: LongTermSubtask | null;
}
/** Planner bookkeeping per task: what we already nudged, and when the owner was last seen. */
export interface LongTermNudgeState {
    taskId: string;
    lastNudgeAtMs: number;
    /** The newest journal event already seen when we nudged. */
    lastNudgedEventAtMs: number;
    lastOwnerActivityAtMs: number | null;
}
export interface CreateTaskInput {
    id: string;
    title: string;
    goal?: string;
    stage?: LongTermTaskStage;
    nowIso: string;
}
export interface AddSubtaskInput {
    taskId: string;
    id: string;
    ordinal: number;
    title: string;
    status?: LongTermSubtaskStatus;
    dependsOn?: string[];
    expectedMinutes?: number | null;
}
export interface LongTermStore {
    createTask(input: CreateTaskInput): Promise<LongTermTask>;
    getTask(taskId: string): Promise<LongTermTask | null>;
    listTasks(): Promise<LongTermTask[]>;
    setTaskStage(taskId: string, stage: LongTermTaskStage, nowIso: string): Promise<LongTermTask | null>;
    addSubtask(input: AddSubtaskInput): Promise<LongTermStoredSubtask>;
    listSubtasks(taskId: string): Promise<LongTermStoredSubtask[]>;
    updateSubtaskStatus(taskId: string, subtaskId: string, status: LongTermSubtaskStatus, nowIso: string): Promise<LongTermStoredSubtask | null>;
    addEvent(input: {
        taskId: string;
        subtaskId?: string | null;
        kind: string;
        actor: string;
        detail?: string | null;
        at: string;
    }): Promise<LongTermEvent>;
    listEvents(taskId: string): Promise<LongTermEvent[]>;
    getNudgeState(taskId: string): Promise<LongTermNudgeState | null>;
    setNudgeState(taskId: string, state: Omit<LongTermNudgeState, 'taskId'>): Promise<LongTermNudgeState>;
    /** The board: every task with its column, progress and current sub-task. */
    getBoard(): Promise<LongTermBoardCard[]>;
}
/** Build the store straight from `resolveMetabotPaths(...)`. */
export declare function longTermStorePaths(roots: LongTermStoreRoots): LongTermStorePaths;
export declare function createLongTermStore(paths: LongTermStorePaths): LongTermStore;
