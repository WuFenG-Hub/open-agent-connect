/**
 * `metabot longtask …` — the command surface for long-running tasks. Unlike the
 * group and meta task commands this needs no daemon round trip: the store is
 * file-backed under the profile's runtime dir, so the command either has the
 * injected handler or reports it as unconfigured.
 */
import { type MetabotCommandResult } from '../../core/contracts/commandResult';
import type { CliRuntimeContext } from '../types';
/** Sub-verbs this command accepts, in help order. */
export declare const LONG_TASK_SUBCOMMANDS: readonly ["create", "list", "show", "board", "advance", "add-subtask", "set-status"];
export declare function runLongTaskCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>>;
