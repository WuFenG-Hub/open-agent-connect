/**
 * `metabot agents` — the local agent status pipeline surface.
 *
 * `agents status` reads the daemon's live snapshot of locally running agent
 * CLI sessions (managed-hook-fed). `agents hooks install|uninstall|doctor`
 * manage the Claude Code hook entries that feed the pipeline; install is
 * confirm-gated because it writes into the user's ~/.claude/settings.json.
 */
import { type MetabotCommandResult } from '../../core/contracts/commandResult';
import type { CliRuntimeContext } from '../types';
export declare function runAgentsCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>>;
export declare function renderAgentsStatusRows(rows: Array<{
    provider: string;
    sessionId: string;
    state: string;
    prompt: string;
    toolName: string;
    updatedAt: number;
}>): string;
