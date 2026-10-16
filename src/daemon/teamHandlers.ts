/**
 * Daemon-side team handler group: the /api/team/* verbs backing the
 * `metabot team *` CLI surface (trust tiers P5). The team registry lists
 * REMOTE Bots bound to the same root owner — candidates for cross-device
 * group-task seating. `add` verifies the peer's root owner == my root owner
 * on-chain before recording; `list` combines local profiles with registry
 * entries (manual + auto-recorded).
 */

import {
  commandFailed,
  commandSuccess,
  type MetabotCommandResult,
} from '../core/contracts/commandResult';
import { normalizeGlobalMetaId } from '../core/identity/deriveIdentity';
import { listIdentityProfiles } from '../core/identity/identityProfiles';
import { readOwnerIdentity } from '../core/owner/ownerIdentity';
import type { RootOwnerResolver } from '../core/trust/rootOwnerResolver';
import { createTeamRegistryStore } from '../core/trust/teamRegistryStore';
import type { MetabotDaemonHttpHandlers } from './routes/types';

export interface TeamDaemonHandlersInput {
  /** The machine-wide system home that owns `~/.metabot/owner/`. */
  systemHomeDir: string;
  /**
   * Root-owner resolver for the `add` verification (walks /info/owner chains).
   * Absent = `team add` fails with team_verification_unavailable (fail closed).
   */
  rootOwnerResolver?: RootOwnerResolver;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function createTeamDaemonHandlers(
  input: TeamDaemonHandlersInput,
): NonNullable<MetabotDaemonHttpHandlers['team']> {
  const systemHomeDir = input.systemHomeDir;
  const registry = createTeamRegistryStore(systemHomeDir);

  return {
    list: async () => {
      const profiles = (await listIdentityProfiles(systemHomeDir).catch(() => []))
        .map((profile) => ({
          slug: profile.slug,
          name: profile.name,
          globalMetaId: normalizeGlobalMetaId(profile.globalMetaId),
          local: true,
          source: 'local',
        }));
      const registryEntries = (await registry.list())
        .map((entry) => ({ ...entry, local: false }));
      return commandSuccess({ profiles, registry: registryEntries });
    },

    add: async (rawInput) => {
      const globalMetaId = normalizeGlobalMetaId(normalizeText(rawInput?.globalMetaId));
      if (!globalMetaId) {
        return commandFailed('invalid_global_meta_id', 'globalMetaId must be a valid GlobalMetaID.');
      }
      if (!input.rootOwnerResolver) {
        return commandFailed(
          'team_verification_unavailable',
          'Root-owner verification is not wired in this daemon; cannot verify team membership.',
        );
      }
      const device = await readOwnerIdentity(systemHomeDir).catch(() => null);
      if (!device) {
        return commandFailed(
          'device_identity_missing',
          'No device identity on this machine. Finish onboarding first.',
        );
      }
      try {
        const myRootOwner = normalizeGlobalMetaId(
          (await input.rootOwnerResolver.resolveRootOwner(device.globalMetaId)).rootOwnerGlobalMetaId,
        );
        const peerRootOwner = normalizeGlobalMetaId(
          (await input.rootOwnerResolver.resolveRootOwner(globalMetaId)).rootOwnerGlobalMetaId,
        );
        if (!myRootOwner || !peerRootOwner || peerRootOwner !== myRootOwner) {
          return commandFailed(
            'team_not_same_owner',
            `${globalMetaId} is not bound to your root owner (its root owner: ${peerRootOwner ?? 'unresolvable'}; yours: ${myRootOwner ?? 'unresolvable'}). Only Bots from the same owner team can be added.`,
          );
        }
        const entries = await registry.upsert({
          globalMetaId,
          source: 'manual',
          addedAt: new Date().toISOString(),
        });
        return commandSuccess({ entry: entries.find((entry) => entry.globalMetaId === globalMetaId), registry: entries });
      } catch (error) {
        return commandFailed(
          'team_root_owner_unresolved',
          `Could not verify ${globalMetaId}'s root owner: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    remove: async (rawInput) => {
      const globalMetaId = normalizeGlobalMetaId(normalizeText(rawInput?.globalMetaId));
      if (!globalMetaId) {
        return commandFailed('invalid_global_meta_id', 'globalMetaId must be a valid GlobalMetaID.');
      }
      try {
        const entries = await registry.remove(globalMetaId);
        return commandSuccess({ removed: globalMetaId, registry: entries });
      } catch (error) {
        return commandFailed('team_remove_failed', error instanceof Error ? error.message : String(error));
      }
    },
  };
}
