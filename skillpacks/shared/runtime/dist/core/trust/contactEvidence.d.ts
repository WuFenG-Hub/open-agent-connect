import type { PrivateChatState } from '../chat/privateChatTypes';
/**
 * Pure two-way check over a chat state snapshot: true when some conversation
 * with `peerGlobalMetaId` has at least one inbound and one outbound message.
 * Messages are scoped to their conversation, so traffic with the same peer
 * in another conversation does not count.
 */
export declare function stateHasTwoWayExchange(state: Pick<PrivateChatState, 'conversations' | 'messages'>, peerGlobalMetaId: string): boolean;
/**
 * Read-only derivation from one profile's private-chat state. Missing or
 * unreadable state yields false (no evidence), never throws.
 */
export declare function hasTwoWayExchange(profileHomeDir: string, peerGlobalMetaId: string): Promise<boolean>;
/** Explicit human-approved contact mark (device-wide, via the local trust store). */
export declare function markContact(systemHomeDir: string, peerGlobalMetaId: string): Promise<void>;
export declare function unmarkContact(systemHomeDir: string, peerGlobalMetaId: string): Promise<void>;
export declare function listMarkedContacts(systemHomeDir: string): Promise<string[]>;
