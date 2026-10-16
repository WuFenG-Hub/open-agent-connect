"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.longTermStorePaths = longTermStorePaths;
exports.createLongTermStore = createLongTermStore;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const derive_js_1 = require("./derive.js");
const FILE_VERSION = 1;
const TASK_STAGES = ['defining', 'active', 'paused', 'done', 'cancelled'];
const SUBTASK_STATUSES = [
    'pending', 'in_progress', 'waiting_owner', 'waiting_external',
    'accepted', 'rejected', 'skipped',
];
const isStage = (value) => typeof value === 'string' && TASK_STAGES.includes(value);
const isSubtaskStatus = (value) => typeof value === 'string' && SUBTASK_STATUSES.includes(value);
const asText = (value) => (typeof value === 'string' ? value : '');
/** Build the store straight from `resolveMetabotPaths(...)`. */
function longTermStorePaths(roots) {
    return {
        root: roots.longtermRoot,
        tasksPath: roots.longtermTasksPath,
        subtasksPath: roots.longtermSubtasksPath,
        eventsPath: roots.longtermEventsPath,
        nudgeStatePath: roots.longtermNudgeStatePath,
    };
}
function createLongTermStore(paths) {
    // Every read-modify-write cycle runs through this chain, so two concurrent
    // callers can never drop each other's row.
    let chain = Promise.resolve();
    function enqueue(task) {
        const run = chain.then(task, task);
        chain = run.then(() => undefined, () => undefined);
        return run;
    }
    async function writeJsonAtomic(filePath, file) {
        await node_fs_1.promises.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await node_fs_1.promises.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
        await node_fs_1.promises.rename(tmp, filePath);
    }
    async function readJsonFile(filePath, empty, pick) {
        try {
            const raw = await node_fs_1.promises.readFile(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return empty();
            return pick(parsed);
        }
        catch {
            return empty();
        }
    }
    const emptyTasks = () => ({ version: FILE_VERSION, tasks: [] });
    const emptySubtasks = () => ({ version: FILE_VERSION, subtasks: [] });
    const emptyEvents = () => ({ version: FILE_VERSION, events: [] });
    const emptyNudgeState = () => ({ version: FILE_VERSION, states: [] });
    const readTasks = () => readJsonFile(paths.tasksPath, emptyTasks, (raw) => ({
        version: FILE_VERSION,
        tasks: Array.isArray(raw.tasks)
            ? raw.tasks.filter((entry) => {
                const row = entry;
                return !!row && typeof row.id === 'string' && isStage(row.stage);
            })
            : [],
    }));
    const readSubtasks = () => readJsonFile(paths.subtasksPath, emptySubtasks, (raw) => ({
        version: FILE_VERSION,
        subtasks: Array.isArray(raw.subtasks)
            ? raw.subtasks.filter((entry) => {
                const row = entry;
                return !!row && typeof row.id === 'string' && typeof row.taskId === 'string'
                    && typeof row.ordinal === 'number' && isSubtaskStatus(row.status);
            }).map((row) => ({ ...row, dependsOn: Array.isArray(row.dependsOn) ? row.dependsOn : [] }))
            : [],
    }));
    const readNudgeStates = () => readJsonFile(paths.nudgeStatePath, emptyNudgeState, (raw) => ({
        version: FILE_VERSION,
        states: Array.isArray(raw.states)
            ? raw.states.filter((entry) => {
                const row = entry;
                return !!row && typeof row.taskId === 'string' && typeof row.lastNudgeAtMs === 'number';
            })
            : [],
    }));
    const readEvents = () => readJsonFile(paths.eventsPath, emptyEvents, (raw) => ({
        version: FILE_VERSION,
        events: Array.isArray(raw.events)
            ? raw.events.filter((entry) => {
                const row = entry;
                return !!row && typeof row.id === 'string' && typeof row.taskId === 'string';
            })
            : [],
    }));
    async function appendEvent(event) {
        const file = await readEvents();
        file.events.push(event);
        await writeJsonAtomic(paths.eventsPath, file);
        return event;
    }
    const listTasksSorted = async () => {
        const file = await readTasks();
        return [...file.tasks].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    };
    return {
        async createTask(input) {
            return enqueue(async () => {
                const stage = input.stage ?? 'defining';
                if (!isStage(stage))
                    throw new Error(`long-term task: unknown stage "${String(input.stage)}"`);
                const id = asText(input.id);
                if (!id)
                    throw new Error('long-term task: id is required.');
                const file = await readTasks();
                if (file.tasks.some((task) => task.id === id)) {
                    throw new Error(`long-term task ${id} already exists.`);
                }
                const task = {
                    id,
                    title: asText(input.title),
                    goal: asText(input.goal),
                    stage,
                    currentSubtaskId: null,
                    createdAt: input.nowIso,
                    updatedAt: input.nowIso,
                };
                file.tasks.push(task);
                await writeJsonAtomic(paths.tasksPath, file);
                return task;
            });
        },
        async getTask(taskId) {
            const file = await readTasks();
            return file.tasks.find((task) => task.id === taskId) ?? null;
        },
        async listTasks() {
            return listTasksSorted();
        },
        async setTaskStage(taskId, stage, nowIso) {
            return enqueue(async () => {
                if (!isStage(stage))
                    throw new Error(`long-term task: unknown stage "${String(stage)}"`);
                const file = await readTasks();
                const task = file.tasks.find((entry) => entry.id === taskId);
                if (!task)
                    return null;
                task.stage = stage;
                task.updatedAt = nowIso;
                await writeJsonAtomic(paths.tasksPath, file);
                return task;
            });
        },
        async addSubtask(input) {
            return enqueue(async () => {
                const status = input.status ?? 'pending';
                if (!isSubtaskStatus(status)) {
                    throw new Error(`long-term subtask: unknown status "${String(input.status)}"`);
                }
                if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
                    throw new Error('long-term subtask: ordinal must be a non-negative integer.');
                }
                const tasks = await readTasks();
                if (!tasks.tasks.some((task) => task.id === input.taskId)) {
                    throw new Error(`long-term subtask: no such task "${input.taskId}".`);
                }
                const file = await readSubtasks();
                // UNIQUE(task_id, ordinal) — the reference keeps this in SQL.
                const clash = file.subtasks.find((row) => row.taskId === input.taskId && row.ordinal === input.ordinal);
                if (clash) {
                    throw new Error(`long-term subtask: ordinal ${input.ordinal} is already used by "${clash.id}" in task ${input.taskId}.`);
                }
                if (file.subtasks.some((row) => row.taskId === input.taskId && row.id === input.id)) {
                    throw new Error(`long-term subtask ${input.id} already exists in task ${input.taskId}.`);
                }
                const subtask = {
                    taskId: input.taskId,
                    id: input.id,
                    ordinal: input.ordinal,
                    title: asText(input.title),
                    status,
                    dependsOn: Array.isArray(input.dependsOn) ? [...input.dependsOn] : [],
                    expectedMinutes: typeof input.expectedMinutes === 'number' && Number.isInteger(input.expectedMinutes)
                        && input.expectedMinutes > 0
                        ? input.expectedMinutes
                        : null,
                };
                file.subtasks.push(subtask);
                await writeJsonAtomic(paths.subtasksPath, file);
                return subtask;
            });
        },
        async listSubtasks(taskId) {
            const file = await readSubtasks();
            return file.subtasks
                .filter((row) => row.taskId === taskId)
                .sort((left, right) => left.ordinal - right.ordinal);
        },
        async updateSubtaskStatus(taskId, subtaskId, status, nowIso) {
            return enqueue(async () => {
                if (!isSubtaskStatus(status)) {
                    throw new Error(`long-term subtask: unknown status "${String(status)}"`);
                }
                const file = await readSubtasks();
                const row = file.subtasks.find((entry) => entry.taskId === taskId && entry.id === subtaskId);
                if (!row)
                    return null;
                const previous = row.status;
                row.status = status;
                await writeJsonAtomic(paths.subtasksPath, file);
                if (previous !== status) {
                    await appendEvent({
                        id: `${taskId}:${subtaskId}:${nowIso}:${status}`,
                        taskId,
                        subtaskId,
                        kind: 'subtask_status',
                        actor: 'local',
                        detail: `${previous} -> ${status}`,
                        at: nowIso,
                    });
                }
                const tasks = await readTasks();
                const task = tasks.tasks.find((entry) => entry.id === taskId);
                if (task) {
                    task.updatedAt = nowIso;
                    await writeJsonAtomic(paths.tasksPath, tasks);
                }
                return row;
            });
        },
        async addEvent(input) {
            return enqueue(() => appendEvent({
                id: `${input.taskId}:${input.kind}:${input.at}`,
                taskId: input.taskId,
                subtaskId: input.subtaskId ?? null,
                kind: input.kind,
                actor: input.actor,
                detail: input.detail ?? null,
                at: input.at,
            }));
        },
        async getNudgeState(taskId) {
            const file = await readNudgeStates();
            return file.states.find((state) => state.taskId === taskId) ?? null;
        },
        async setNudgeState(taskId, state) {
            return enqueue(async () => {
                const file = await readNudgeStates();
                const existing = file.states.findIndex((entry) => entry.taskId === taskId);
                const next = { taskId, ...state };
                if (existing >= 0)
                    file.states[existing] = next;
                else
                    file.states.push(next);
                await writeJsonAtomic(paths.nudgeStatePath, file);
                return next;
            });
        },
        async listEvents(taskId) {
            const file = await readEvents();
            return file.events
                .filter((event) => event.taskId === taskId)
                .sort((left, right) => left.at.localeCompare(right.at));
        },
        async getBoard() {
            const tasks = await listTasksSorted();
            const file = await readSubtasks();
            return tasks.map((task) => {
                const subtasks = file.subtasks
                    .filter((row) => row.taskId === task.id)
                    .sort((left, right) => left.ordinal - right.ordinal);
                const currentSubtask = (0, derive_js_1.deriveCurrentSubtask)(task.currentSubtaskId, subtasks);
                return {
                    task,
                    column: (0, derive_js_1.deriveColumn)(task.stage, currentSubtask?.status ?? null),
                    progress: (0, derive_js_1.deriveProgress)(subtasks),
                    currentSubtask,
                };
            });
        },
    };
}
