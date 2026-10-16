/**
 * Long-term task board — the three read-time derivations, ported verbatim from
 * the IDBots store. All three are pure: no IO, no clock, no storage. The board
 * (and any surface that shows progress) consumes these instead of persisting a
 * copy, which is what keeps a card from disagreeing with its sub-tasks.
 */
import type { LongTermColumn, LongTermSubtask, LongTermSubtaskStatus, LongTermTaskProgress, LongTermTaskStage } from './types';
/**
 * The board column of a task, from its stage and its current sub-task. A
 * cancelled task keeps its data but is off the board (null).
 */
export declare function deriveColumn(stage: LongTermTaskStage, currentSubtaskStatus: LongTermSubtaskStatus | null): LongTermColumn | null;
/**
 * Progress over the NON-SKIPPED sub-tasks. A skipped sub-task leaves both the
 * numerator and the denominator, so skipping work raises the percentage instead
 * of parking it.
 */
export declare function deriveProgress(subtasks: LongTermSubtask[]): LongTermTaskProgress;
/**
 * The sub-task the board should focus on. An explicit pin wins while it is
 * still open; otherwise the lowest-ordinal open sub-task whose dependencies are
 * all accepted, falling back to the lowest-ordinal open one (dependency
 * blocked) so the card never shows a blank "current".
 */
export declare function deriveCurrentSubtask(pinnedId: string | null, subtasks: LongTermSubtask[]): LongTermSubtask | null;
