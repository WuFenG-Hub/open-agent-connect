/**
 * On-chain group-chat primitives: SimpleGroupJoin and SimpleGroupChat pin
 * writers. OAC port of the IDBots group_chat tool's two on-chain actions:
 *
 * - join  (/protocols/simplegroupjoin): body {groupId, state: 1} with
 *   referrer / k carried only when non-empty (IDBots main.ts joinGroup
 *   tool-path omission form; private groups pass the protocol key field
 *   through from the caller).
 * - send  (/protocols/simplegroupchat): body {groupId, nickName, content,
 *   contentType: 'text/plain', encryption: 'aes', timestamp: <ms>} with
 *   replyPin / channelId / mention carried only when non-empty (IDBots
 *   main.ts sendGroupMessage omission rules). `content` is the ALREADY
 *   ENCRYPTED group message (encryptGroupMessage hex output) — this module
 *   never encrypts, and refuses plaintext-looking content so no caller can
 *   broadcast an unencrypted group message through this path.
 *
 * The nickName is resolved by the daemon from the acting bot's registered
 * identity name (never taken from model input — IDBots incident:
 * sender_name "claude bot"); it lands here as a plain string, '' allowed.
 */
import type { Signer } from '../signing/signer';
export declare const SIMPLE_GROUP_JOIN_PATH = "/protocols/simplegroupjoin";
export declare const SIMPLE_GROUP_CHAT_PATH = "/protocols/simplegroupchat";
/** On-chain group id shape: the group's pin id — 64 lowercase hex + "i0". */
export declare const ON_CHAIN_GROUP_ID_PATTERN: RegExp;
export declare class GroupChatPublishError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface JoinGroupChatInput {
    /** On-chain group pin id (64 lowercase hex + "i0"). */
    groupId: string;
    /** Inviter MetaID; empty for open joins. */
    referrer?: string;
    /** Protocol key field; '' for public groups, caller-provided for private. */
    k?: string;
    /** Write network; default mvc. */
    network?: string;
}
export interface JoinGroupChatResult {
    pinId: string;
    txids: string[];
    totalCost: number;
    network: string;
    groupId: string;
}
/** Publish one SimpleGroupJoin pin (state 1). */
export declare function joinGroupChat(signer: Signer, input: JoinGroupChatInput): Promise<JoinGroupChatResult>;
export interface SendGroupChatMessageInput {
    /** On-chain group pin id (64 lowercase hex + "i0"). */
    groupId: string;
    /** The ALREADY ENCRYPTED message (encryptGroupMessage hex output). */
    content: string;
    /** Acting bot's registered name, resolved daemon-side; '' allowed. */
    nickName?: string;
    /** Pin id of the message being replied to; omitted when empty. */
    replyPin?: string;
    /** Channel id within the group; omitted when empty. */
    channelId?: string;
    /** MetaID list to @mention; omitted when empty. */
    mention?: string[];
    /** Write network; default mvc. */
    network?: string;
}
export interface SendGroupChatMessageResult {
    pinId: string;
    txids: string[];
    totalCost: number;
    network: string;
    groupId: string;
}
/** Publish one SimpleGroupChat pin with the encrypted message body. */
export declare function sendGroupChatMessage(signer: Signer, input: SendGroupChatMessageInput): Promise<SendGroupChatMessageResult>;
/**
 * Human-readable success sheets mirroring the IDBots group_chat
 * formatPinResult titles. The view link follows the MetaWeb URI convention
 * (pin:// — never a Web2 viewer URL). Exposed for tests.
 */
export declare function formatJoinGroupResult(input: {
    pinId: string;
    txids: string[];
    totalCost: number;
}): string;
export declare function formatSendGroupResult(input: {
    pinId: string;
    txids: string[];
    totalCost: number;
}): string;
