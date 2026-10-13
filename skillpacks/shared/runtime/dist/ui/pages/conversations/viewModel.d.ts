export interface LocalBotOptionViewModel {
    label: string;
    slug: string;
    globalMetaId: string;
    avatar: string;
    isSelected: boolean;
}
export interface ConversationSummaryViewModel {
    conversationId: string;
    conversationIdPreview: string;
    localGlobalMetaId: string;
    localAvatar: string;
    peerLabel: string;
    peerGlobalMetaId: string;
    peerAvatar: string;
    peerLlmPrimaryProvider: string;
    peerLlmPrimaryProviderLabel: string;
    latestText: string;
    latestAt: number;
    latestAtLabel: string;
    kinds: string[];
    stateLabel: string;
    messageCountLabel: string;
    localBotLabel: string;
    isSelected: boolean;
}
export interface ConversationMessageViewModel {
    messageId: string;
    direction: string;
    directionLabel: string;
    kindLabel: string;
    content: string;
    contentType: string;
    isMarkdown: boolean;
    senderLabel: string;
    senderAvatar: string;
    txid: string;
    txidPreview: string;
    timestampLabel: string;
    hostStatus: boolean;
    deliveryStatus: string;
    isAttachment: boolean;
    /**
     * The pin id of the chain pin this message was built from. Quoting targets
     * this value, so it must be the on-chain pin id — never a synthesized local
     * row id, which would produce a quote pointer that resolves to nothing.
     */
    quotePinId: string;
    /** Resolved quote context, or null when this message quotes nothing. */
    replyInfo: ConversationReplyInfoViewModel | null;
}
/** View-ready shape of a quoted message; mirrors core ChatReplyInfo. */
export interface ConversationReplyInfoViewModel {
    pinId: string;
    content: string;
    truncated: boolean;
    unresolved: boolean;
    senderLabel: string;
    timestampLabel: string;
}
export interface ConversationsEmptyStateViewModel {
    title: string;
    message: string;
}
export interface ConversationsPageViewModel {
    localBots: LocalBotOptionViewModel[];
    selectedLocalGlobalMetaId: string;
    selectedPeerGlobalMetaId: string;
    conversations: ConversationSummaryViewModel[];
    selectedConversation: ConversationSummaryViewModel | null;
    messages: ConversationMessageViewModel[];
    emptyState: ConversationsEmptyStateViewModel;
    detailEmptyState: ConversationsEmptyStateViewModel;
}
export interface ConversationsPageViewModelInput {
    localBots?: unknown[];
    botProfilesResponse?: unknown;
    conversations?: unknown[];
    conversationsResponse?: unknown;
    traceSessions?: unknown[];
    traceSessionsResponse?: unknown;
    messages?: unknown[];
    messagesResponse?: unknown;
    selectedLocalGlobalMetaId?: string;
    selectedPeerGlobalMetaId?: string;
    selectedConversationId?: string;
}
export declare function buildConversationsPageViewModel(input?: ConversationsPageViewModelInput): ConversationsPageViewModel;
export declare function buildConversationsPageViewModelRuntimeSource(): string;
