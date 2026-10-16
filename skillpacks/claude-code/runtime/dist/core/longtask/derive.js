"use strict";
/**
 * Long-term task board — the three read-time derivations, ported verbatim from
 * the IDBots store. All three are pure: no IO, no clock, no storage. The board
 * (and any surface that shows progress) consumes these instead of persisting a
 * copy, which is what keeps a card from disagreeing with its sub-tasks.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveColumn = deriveColumn;
exports.deriveProgress = deriveProgress;
exports.deriveCurrentSubtask = deriveCurrentSubtask;
/**
 * The board column of a task, from its stage and its current sub-task. A
 * cancelled task keeps its data but is off the board (null).
 */
function deriveColumn(stage, currentSubtaskStatus) {
    if (stage === 'defining')
        return 'defining';
    if (stage === 'paused')
        return 'paused';
    if (stage === 'done')
        return 'done';
    if (stage === 'cancelled')
        return null; // stays in the data, off the board
    if (currentSubtaskStatus === 'waiting_owner')
        return 'waiting_owner';
    if (currentSubtaskStatus === 'waiting_external')
        return 'waiting_external';
    return 'in_progress';
}
/**
 * Progress over the NON-SKIPPED sub-tasks. A skipped sub-task leaves both the
 * numerator and the denominator, so skipping work raises the percentage instead
 * of parking it.
 */
function deriveProgress(subtasks) {
    const live = subtasks.filter((subtask) => subtask.status !== 'skipped');
    const accepted = live.filter((subtask) => subtask.status === 'accepted').length;
    const total = live.length;
    return { accepted, total, percent: total === 0 ? 0 : Math.round((accepted / total) * 100) };
}
/**
 * The sub-task the board should focus on. An explicit pin wins while it is
 * still open; otherwise the lowest-ordinal open sub-task whose dependencies are
 * all accepted, falling back to the lowest-ordinal open one (dependency
 * blocked) so the card never shows a blank "current".
 */
function deriveCurrentSubtask(pinnedId, subtasks) {
    const open = subtasks
        .filter((subtask) => subtask.status !== 'accepted' && subtask.status !== 'skipped')
        .sort((left, right) => left.ordinal - right.ordinal);
    if (open.length === 0)
        return null;
    if (pinnedId) {
        const pinned = open.find((subtask) => subtask.id === pinnedId);
        if (pinned)
            return pinned;
    }
    const acceptedIds = new Set(subtasks.filter((subtask) => subtask.status === 'accepted').map((subtask) => subtask.id));
    return open.find((subtask) => subtask.dependsOn.every((dep) => acceptedIds.has(dep))) ?? open[0];
}
