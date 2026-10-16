"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stateHasTwoWayExchange = stateHasTwoWayExchange;
exports.hasTwoWayExchange = hasTwoWayExchange;
exports.markContact = markContact;
exports.unmarkContact = unmarkContact;
exports.listMarkedContacts = listMarkedContacts;
// Contact evidence (trust tiers P2, M1): the `contact` tier is derived —
// a peer qualifies when a per-profile private-chat record shows a completed
// two-way exchange (at least one inbound AND one outbound message), or when
// the human explicitly marked the peer as a contact here. Read-only over the
// existing chat state store: no chat-path behavior changes (enforcement is
// P4). markContact/unmarkContact are the explicit-mark surface backed by the
// local trust store.
const privateChatStateStore_1 = require("../chat/privateChatStateStore");
const deriveIdentity_1 = require("../identity/deriveIdentity");
const trustLocalStore_1 = require("./trustLocalStore");
/**
 * Pure two-way check over a chat state snapshot: true when some conversation
 * with `peerGlobalMetaId` has at least one inbound and one outbound message.
 * Messages are scoped to their conversation, so traffic with the same peer
 * in another conversation does not count.
 */
function stateHasTwoWayExchange(state, peerGlobalMetaId) {
    const peer = (0, deriveIdentity_1.normalizeGlobalMetaId)(peerGlobalMetaId);
    if (!peer)
        return false;
    const conversationIds = new Set(state.conversations
        .filter((conversation) => (0, deriveIdentity_1.normalizeGlobalMetaId)(conversation.peerGlobalMetaId) === peer)
        .map((conversation) => conversation.conversationId));
    if (conversationIds.size === 0)
        return false;
    let inbound = false;
    let outbound = false;
    for (const message of state.messages) {
        if (!conversationIds.has(message.conversationId))
            continue;
        if (message.direction === 'inbound')
            inbound = true;
        if (message.direction === 'outbound')
            outbound = true;
        if (inbound && outbound)
            return true;
    }
    return false;
}
/**
 * Read-only derivation from one profile's private-chat state. Missing or
 * unreadable state yields false (no evidence), never throws.
 */
async function hasTwoWayExchange(profileHomeDir, peerGlobalMetaId) {
    const peer = (0, deriveIdentity_1.normalizeGlobalMetaId)(peerGlobalMetaId);
    if (!peer)
        return false;
    try {
        const state = await (0, privateChatStateStore_1.createPrivateChatStateStore)(profileHomeDir).readState();
        return stateHasTwoWayExchange(state, peer);
    }
    catch {
        return false;
    }
}
/** Explicit human-approved contact mark (device-wide, via the local trust store). */
async function markContact(systemHomeDir, peerGlobalMetaId) {
    await (0, trustLocalStore_1.createTrustLocalStore)(systemHomeDir).setContact(peerGlobalMetaId, true);
}
async function unmarkContact(systemHomeDir, peerGlobalMetaId) {
    await (0, trustLocalStore_1.createTrustLocalStore)(systemHomeDir).setContact(peerGlobalMetaId, false);
}
async function listMarkedContacts(systemHomeDir) {
    return (await (0, trustLocalStore_1.createTrustLocalStore)(systemHomeDir).read()).contacts;
}
