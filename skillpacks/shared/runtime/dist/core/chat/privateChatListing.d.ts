import type { PeerConversationSummary } from '../a2a/conversationProjection';
import type { A2AConversationMessage } from '../a2a/conversationTypes';
import type { PrivateChatConversation, PrivateChatMessage } from './privateChatTypes';
export declare function privateChatConversationId(localGlobalMetaId: string, peerGlobalMetaId: string): string;
export declare function mergeStoredPrivateChatsWithA2A(input: {
    localGlobalMetaId: string;
    stored: PrivateChatConversation[];
    summaries: PeerConversationSummary[];
}): PrivateChatConversation[];
export declare function peerGlobalMetaIdForConversation(input: {
    conversationId: string;
    localGlobalMetaId: string;
    stored: PrivateChatConversation[];
    summaries: PeerConversationSummary[];
}): string | null;
export declare function mergePrivateChatMessages(input: {
    conversationId: string;
    localGlobalMetaId: string;
    stored: PrivateChatMessage[];
    a2aMessages: A2AConversationMessage[];
    limit: number;
}): PrivateChatMessage[];
