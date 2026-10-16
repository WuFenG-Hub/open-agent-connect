// Contact evidence (trust tiers P2, M1): the `contact` tier is derived —
// a peer qualifies when a per-profile private-chat record shows a completed
// two-way exchange (at least one inbound AND one outbound message), or when
// the human explicitly marked the peer as a contact here. Read-only over the
// existing chat state store: no chat-path behavior changes (enforcement is
// P4). markContact/unmarkContact are the explicit-mark surface backed by the
// local trust store.
import { createPrivateChatStateStore } from '../chat/privateChatStateStore';
import type { PrivateChatState } from '../chat/privateChatTypes';
import { normalizeGlobalMetaId } from '../identity/deriveIdentity';
import { createTrustLocalStore } from './trustLocalStore';

/**
 * Pure two-way check over a chat state snapshot: true when some conversation
 * with `peerGlobalMetaId` has at least one inbound and one outbound message.
 * Messages are scoped to their conversation, so traffic with the same peer
 * in another conversation does not count.
 */
export function stateHasTwoWayExchange(
  state: Pick<PrivateChatState, 'conversations' | 'messages'>,
  peerGlobalMetaId: string,
): boolean {
  const peer = normalizeGlobalMetaId(peerGlobalMetaId);
  if (!peer) return false;
  const conversationIds = new Set(
    state.conversations
      .filter((conversation) => normalizeGlobalMetaId(conversation.peerGlobalMetaId) === peer)
      .map((conversation) => conversation.conversationId),
  );
  if (conversationIds.size === 0) return false;
  let inbound = false;
  let outbound = false;
  for (const message of state.messages) {
    if (!conversationIds.has(message.conversationId)) continue;
    if (message.direction === 'inbound') inbound = true;
    if (message.direction === 'outbound') outbound = true;
    if (inbound && outbound) return true;
  }
  return false;
}

/**
 * Read-only derivation from one profile's private-chat state. Missing or
 * unreadable state yields false (no evidence), never throws.
 */
export async function hasTwoWayExchange(profileHomeDir: string, peerGlobalMetaId: string): Promise<boolean> {
  const peer = normalizeGlobalMetaId(peerGlobalMetaId);
  if (!peer) return false;
  try {
    const state = await createPrivateChatStateStore(profileHomeDir).readState();
    return stateHasTwoWayExchange(state, peer);
  } catch {
    return false;
  }
}

/** Explicit human-approved contact mark (device-wide, via the local trust store). */
export async function markContact(systemHomeDir: string, peerGlobalMetaId: string): Promise<void> {
  await createTrustLocalStore(systemHomeDir).setContact(peerGlobalMetaId, true);
}

export async function unmarkContact(systemHomeDir: string, peerGlobalMetaId: string): Promise<void> {
  await createTrustLocalStore(systemHomeDir).setContact(peerGlobalMetaId, false);
}

export async function listMarkedContacts(systemHomeDir: string): Promise<string[]> {
  return (await createTrustLocalStore(systemHomeDir).read()).contacts;
}
