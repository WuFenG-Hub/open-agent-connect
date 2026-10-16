"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LONG_TASK_SUBCOMMANDS = void 0;
exports.runLongTaskCommand = runLongTaskCommand;
/**
 * `metabot longtask …` — the command surface for long-running tasks. Unlike the
 * group and meta task commands this needs no daemon round trip: the store is
 * file-backed under the profile's runtime dir, so the command either has the
 * injected handler or reports it as unconfigured.
 */
const commandResult_1 = require("../../core/contracts/commandResult");
const helpers_1 = require("./helpers");
/** Sub-verbs this command accepts, in help order. */
exports.LONG_TASK_SUBCOMMANDS = [
    'create', 'list', 'show', 'board', 'advance', 'add-subtask', 'set-status',
];
async function runLongTaskCommand(args, context) {
    const [subcommand] = args;
    const from = (0, helpers_1.readFromFlag)(args);
    const deps = context.dependencies.longtask;
    if (!deps) {
        return (0, commandResult_1.commandFailed)('not_implemented', 'Long-task handlers are not configured.');
    }
    switch (subcommand) {
        case 'create': {
            if (!deps.create)
                return (0, commandResult_1.commandFailed)('not_implemented', 'Long-task create is not configured.');
            const id = (0, helpers_1.readFlagValue)(args, '--id');
            const title = (0, helpers_1.readFlagValue)(args, '--title');
            if (!id)
                return (0, helpers_1.commandMissingFlag)('--id');
            if (!title)
                return (0, helpers_1.commandMissingFlag)('--title');
            return deps.create({ from, id, title, goal: (0, helpers_1.readFlagValue)(args, '--goal') ?? undefined });
        }
        case 'list':
            if (!deps.list)
                return (0, commandResult_1.commandFailed)('not_implemented', 'Long-task list is not configured.');
            return deps.list({ from });
        case 'board':
            if (!deps.board)
                return (0, commandResult_1.commandFailed)('not_implemented', 'Long-task board is not configured.');
            return deps.board({ from });
        case 'advance':
            if (!deps.advance)
                return (0, commandResult_1.commandFailed)('not_implemented', 'Long-task advance is not configured.');
            return deps.advance({ from });
        case 'show': {
            if (!deps.show)
                return (0, commandResult_1.commandFailed)('not_implemented', 'Long-task show is not configured.');
            const id = (0, helpers_1.readFlagValue)(args, '--id');
            if (!id)
                return (0, helpers_1.commandMissingFlag)('--id');
            return deps.show({ from, id });
        }
        case 'add-subtask': {
            if (!deps.addSubtask)
                return (0, commandResult_1.commandFailed)('not_implemented', 'Long-task addSubtask is not configured.');
            const id = (0, helpers_1.readFlagValue)(args, '--id');
            const subtaskId = (0, helpers_1.readFlagValue)(args, '--subtask');
            const title = (0, helpers_1.readFlagValue)(args, '--title');
            const ordinalRaw = (0, helpers_1.readFlagValue)(args, '--ordinal');
            if (!id)
                return (0, helpers_1.commandMissingFlag)('--id');
            if (!subtaskId)
                return (0, helpers_1.commandMissingFlag)('--subtask');
            if (!title)
                return (0, helpers_1.commandMissingFlag)('--title');
            if (ordinalRaw === null)
                return (0, helpers_1.commandMissingFlag)('--ordinal');
            const ordinal = Number(ordinalRaw);
            if (!Number.isInteger(ordinal)) {
                return (0, commandResult_1.commandFailed)('invalid_flag_value', `--ordinal must be an integer, got "${ordinalRaw}".`);
            }
            const dependsRaw = (0, helpers_1.readFlagValue)(args, '--depends-on');
            return deps.addSubtask({
                from, id, subtaskId, ordinal, title,
                dependsOn: dependsRaw
                    ? dependsRaw.split(',').map((entry) => entry.trim()).filter(Boolean)
                    : undefined,
            });
        }
        case 'set-status': {
            if (!deps.setSubtaskStatus) {
                return (0, commandResult_1.commandFailed)('not_implemented', 'Long-task setSubtaskStatus is not configured.');
            }
            const id = (0, helpers_1.readFlagValue)(args, '--id');
            const subtaskId = (0, helpers_1.readFlagValue)(args, '--subtask');
            const status = (0, helpers_1.readFlagValue)(args, '--status');
            if (!id)
                return (0, helpers_1.commandMissingFlag)('--id');
            if (!subtaskId)
                return (0, helpers_1.commandMissingFlag)('--subtask');
            if (!status)
                return (0, helpers_1.commandMissingFlag)('--status');
            return deps.setSubtaskStatus({ from, id, subtaskId, status });
        }
        default:
            return (0, helpers_1.commandUnknownSubcommand)(`longtask${subcommand ? ` ${subcommand}` : ''}`);
    }
}
