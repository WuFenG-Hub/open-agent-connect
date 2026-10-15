import type { PeerConversationSummary } from '../a2a/conversationProjection';
import type { A2AConversationMessage } from '../a2a/conversationTypes';
import type { PrivateChatConversation, PrivateChatMessage } from './privateChatTypes';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function privateChatConversationId(localGlobalMetaId: string, peerGlobalMetaId: string): string {
  return `pc-${localGlobalMetaId}-${peerGlobalMetaId}`;
}

export function mergeStoredPrivateChatsWithA2A(input: {
  localGlobalMetaId: string;
  stored: PrivateChatConversation[];
  summaries: PeerConversationSummary[];
}): PrivateChatConversation[] {
  const knownPeers = new Set(
    input.stored.map((conversation) => normalizeText(conversation.peerGlobalMetaId).toLowerCase()),
  );
  const extras: PrivateChatConversation[] = [];
  for (const summary of input.summaries) {
    if (!summary.kinds.includes('private_chat')) {
      continue;
    }
    const peerGlobalMetaId = normalizeText(summary.peerGlobalMetaId);
    if (!peerGlobalMetaId || knownPeers.has(peerGlobalMetaId.toLowerCase())) {
      continue;
    }
    knownPeers.add(peerGlobalMetaId.toLowerCase());
    const state = summary.state === 'closed' || summary.state === 'paused' ? summary.state : 'active';
    extras.push({
      conversationId: privateChatConversationId(input.localGlobalMetaId, peerGlobalMetaId),
      peerGlobalMetaId,
      peerName: summary.peerName,
      topic: null,
      strategyId: null,
      state,
      turnCount: 0,
      lastDirection: 'outbound',
      createdAt: summary.latestAt,
      updatedAt: summary.latestAt,
      pendingGuidanceText: null,
      pendingGuidanceCreatedAt: null,
      pendingGuidanceLeaseId: null,
      pendingGuidanceLeaseExpiresAt: null,
    });
  }
  return [...input.stored, ...extras];
}

export function peerGlobalMetaIdForConversation(input: {
  conversationId: string;
  localGlobalMetaId: string;
  stored: PrivateChatConversation[];
  summaries: PeerConversationSummary[];
}): string | null {
  const stored = input.stored.find((conversation) => conversation.conversationId === input.conversationId);
  if (stored) {
    return normalizeText(stored.peerGlobalMetaId) || null;
  }
  const prefix = `${privateChatConversationId(input.localGlobalMetaId, '')}`;
  if (input.conversationId.startsWith(prefix)) {
    return normalizeText(input.conversationId.slice(prefix.length)) || null;
  }
  const summary = input.summaries.find((entry) => entry.conversationId === input.conversationId);
  return normalizeText(summary?.peerGlobalMetaId) || null;
}

export function mergePrivateChatMessages(input: {
  conversationId: string;
  localGlobalMetaId: string;
  stored: PrivateChatMessage[];
  a2aMessages: A2AConversationMessage[];
  limit: number;
}): PrivateChatMessage[] {
  const seen = new Set(input.stored.map((message) => message.messageId));
  const fromA2A: PrivateChatMessage[] = [];
  for (const message of input.a2aMessages) {
    if (message.kind !== 'private_chat' || seen.has(message.messageId)) {
      continue;
    }
    seen.add(message.messageId);
    fromA2A.push({
      conversationId: input.conversationId,
      messageId: message.messageId,
      direction: message.direction === 'incoming' ? 'inbound' : 'outbound',
      senderGlobalMetaId: normalizeText(message.sender?.globalMetaId)
        || (message.direction === 'incoming' ? '' : input.localGlobalMetaId),
      content: message.content,
      messagePinId: normalizeText(message.pinId) || null,
      extensions: null,
      timestamp: message.timestamp,
    });
  }
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? Math.trunc(input.limit) : 50;
  return [...input.stored, ...fromA2A]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-limit);
}
