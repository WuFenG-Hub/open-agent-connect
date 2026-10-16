/**
 * Daemon-side blocklist handler group: the /api/block/* verbs (trust tiers
 * P2). Purely local — backed by `~/.metabot/owner/trust-local.json` via the
 * core trustLocalStore; add/remove also drop the peer's cached trust
 * resolution (blockGmid/unblockGmid composition), so the next tier check
 * never serves stale state for the changed peer.
 */

import {
  commandFailed,
  commandSuccess,
  type MetabotCommandResult,
} from '../core/contracts/commandResult';
import { normalizeGlobalMetaId } from '../core/identity/deriveIdentity';
import {
  blockGmid,
  createTrustLocalStore,
  unblockGmid,
} from '../core/trust/trustLocalStore';
import type { MetabotDaemonHttpHandlers } from './routes/types';

export interface BlockDaemonHandlersInput {
  /** The machine-wide system home that owns `~/.metabot/owner/`. */
  systemHomeDir: string;
  /** Called after a successful add/remove so consumers (e.g. the P3 peer
   *  tier resolver's short-TTL cache) can drop stale tier entries. */
  onTrustConfigChanged?: () => void;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function createBlockDaemonHandlers(
  input: BlockDaemonHandlersInput,
): NonNullable<MetabotDaemonHttpHandlers['block']> {
  const systemHomeDir = input.systemHomeDir;
  return {
    list: async () => {
      const state = await createTrustLocalStore(systemHomeDir).read();
      return commandSuccess(state);
    },

    add: async (rawInput) => {
      const globalMetaId = normalizeGlobalMetaId(normalizeText(rawInput?.globalMetaId));
      if (!globalMetaId) {
        return commandFailed('invalid_global_meta_id', 'globalMetaId must be a valid GlobalMetaID.');
      }
      try {
        const state = await blockGmid(systemHomeDir, globalMetaId);
        input.onTrustConfigChanged?.();
        return commandSuccess({ blocked: state.blocked, added: globalMetaId });
      } catch (error) {
        return commandFailed('block_add_failed', error instanceof Error ? error.message : String(error));
      }
    },

    remove: async (rawInput) => {
      const globalMetaId = normalizeGlobalMetaId(normalizeText(rawInput?.globalMetaId));
      if (!globalMetaId) {
        return commandFailed('invalid_global_meta_id', 'globalMetaId must be a valid GlobalMetaID.');
      }
      try {
        const state = await unblockGmid(systemHomeDir, globalMetaId);
        input.onTrustConfigChanged?.();
        return commandSuccess({ blocked: state.blocked, removed: globalMetaId });
      } catch (error) {
        return commandFailed('block_remove_failed', error instanceof Error ? error.message : String(error));
      }
    },
  };
}
