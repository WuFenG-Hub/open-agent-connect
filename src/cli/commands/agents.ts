/**
 * `metabot agents` — the local agent status pipeline surface.
 *
 * `agents status` reads the daemon's live snapshot of locally running agent
 * CLI sessions (managed-hook-fed). `agents hooks install|uninstall|doctor`
 * manage the Claude Code hook entries that feed the pipeline; install is
 * confirm-gated because it writes into the user's ~/.claude/settings.json.
 */
import { commandAwaitingConfirmation, commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { commandMissingFlag, commandUnknownSubcommand, readFlagValue } from './helpers';
import type { CliRuntimeContext } from '../types';

const SUPPORTED_HOOK_HOSTS = ['claude-code'] as const;

export async function runAgentsCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  const section = args[0];

  if (section === 'status') {
    const handler = context.dependencies.agents?.status;
    if (!handler) return commandFailed('not_implemented', 'Agents status handler is not configured.');
    return handler({ json: args.includes('--json') });
  }

  if (section === 'hooks') {
    const action = args[1];
    const host = readFlagValue(args, '--host');
    if (!host) return commandMissingFlag('--host');
    if (!(SUPPORTED_HOOK_HOSTS as readonly string[]).includes(host)) {
      return commandFailed(
        'invalid_argument',
        `Unsupported --host value: ${host}. Supported values: ${SUPPORTED_HOOK_HOSTS.join(', ')} (Codex and OpenCode arrive in a later release).`,
      );
    }
    const deps = context.dependencies.agents;
    if (action === 'install') {
      const handler = deps?.installHooks;
      if (!handler) return commandFailed('not_implemented', 'Agents hooks install handler is not configured.');
      return handler({ host, confirm: args.includes('--confirm') });
    }
    if (action === 'uninstall') {
      const handler = deps?.uninstallHooks;
      if (!handler) return commandFailed('not_implemented', 'Agents hooks uninstall handler is not configured.');
      return handler({ host });
    }
    if (action === 'doctor') {
      const handler = deps?.hooksDoctor;
      if (!handler) return commandFailed('not_implemented', 'Agents hooks doctor handler is not configured.');
      return handler({ host });
    }
    return commandUnknownSubcommand(`agents hooks ${action ?? ''}`.trim());
  }

  return commandUnknownSubcommand(`agents ${section ?? ''}`.trim());
}

export function renderAgentsStatusRows(rows: Array<{ provider: string; sessionId: string; state: string; prompt: string; toolName: string; updatedAt: number }>): string {
  if (!rows.length) {
    return 'No local agent sessions reporting status. Install hooks with `metabot agents hooks install --host claude-code --confirm`, then run any Claude Code session.';
  }
  const lines = rows.map((row) => {
    const detail = row.prompt
      ? ` — ${row.prompt.slice(0, 60)}`
      : row.toolName
        ? ` — tool: ${row.toolName}`
        : '';
    return `${row.provider}  ${row.state.padEnd(8)} session ${row.sessionId.slice(0, 8)}${detail}`;
  });
  return lines.join('\n');
}
