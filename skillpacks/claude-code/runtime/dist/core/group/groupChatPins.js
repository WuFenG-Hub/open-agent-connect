"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GroupChatPublishError = exports.ON_CHAIN_GROUP_ID_PATTERN = exports.SIMPLE_GROUP_CHAT_PATH = exports.SIMPLE_GROUP_JOIN_PATH = void 0;
exports.joinGroupChat = joinGroupChat;
exports.sendGroupChatMessage = sendGroupChatMessage;
exports.formatJoinGroupResult = formatJoinGroupResult;
exports.formatSendGroupResult = formatSendGroupResult;
const uri_1 = require("../metaweb/uri");
exports.SIMPLE_GROUP_JOIN_PATH = '/protocols/simplegroupjoin';
exports.SIMPLE_GROUP_CHAT_PATH = '/protocols/simplegroupchat';
const GROUP_PROTOCOL_VERSION = '1.0';
/** On-chain group id shape: the group's pin id — 64 lowercase hex + "i0". */
exports.ON_CHAIN_GROUP_ID_PATTERN = /^[0-9a-f]{64}i0$/;
/** AES ciphertext wire shape: lowercase hex, whole 16-byte blocks (>= 1 block). */
const CIPHERTEXT_HEX_PATTERN = /^[0-9a-f]{32,}$/;
class GroupChatPublishError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'GroupChatPublishError';
        this.code = code;
    }
}
exports.GroupChatPublishError = GroupChatPublishError;
function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function requireOnChainGroupId(value) {
    const groupId = normalizeText(value);
    if (!exports.ON_CHAIN_GROUP_ID_PATTERN.test(groupId)) {
        throw new GroupChatPublishError('invalid_group_id', `Invalid group_id "${groupId}": an on-chain group id is the group's pin id — exactly 64 lowercase hex chars followed by "i0" (66 characters). `
            + 'A bare number such as "65" is the TASK number, not a group id. Do not guess; ask for the real group id.');
    }
    return groupId;
}
/** Reject plaintext-looking content: broadcasting it would leak the message. */
function requireEncryptedContent(value) {
    const content = normalizeText(value);
    if (!content) {
        throw new GroupChatPublishError('missing_field', 'send_group_message requires non-empty `content` (the plaintext message; the caller encrypts it with encryptGroupMessage).');
    }
    if (!CIPHERTEXT_HEX_PATTERN.test(content) || content.length % 32 !== 0) {
        throw new GroupChatPublishError('content_not_encrypted', 'send_group_message `content` must be the AES-encrypted hex produced by encryptGroupMessage(message, groupId) — not plaintext. '
            + 'Writing an unencrypted group payload would leak the message; encrypt first (the group_chat tool does this automatically).');
    }
    return content;
}
/** Publish one SimpleGroupJoin pin (state 1). */
async function joinGroupChat(signer, input) {
    const groupId = requireOnChainGroupId(input.groupId);
    // IDBots main.ts joinGroup tool-path omission form: the base body is
    // exactly {groupId, state: 1}; referrer / k ride only when non-empty
    // (normalize-then-omit), so the pin bytes match the IDBots tool's.
    const body = { groupId, state: 1 };
    const referrer = normalizeText(input.referrer);
    if (referrer)
        body.referrer = referrer;
    const k = normalizeText(input.k);
    if (k)
        body.k = k;
    const chainWrite = await signer.writePin({
        operation: 'create',
        path: exports.SIMPLE_GROUP_JOIN_PATH,
        encryption: '0',
        version: GROUP_PROTOCOL_VERSION,
        contentType: 'application/json',
        payload: JSON.stringify(body),
        network: (typeof input.network === 'string' && input.network.trim()) || 'mvc',
    });
    return {
        pinId: chainWrite.pinId,
        txids: Array.isArray(chainWrite.txids) ? chainWrite.txids : [],
        totalCost: chainWrite.totalCost,
        network: chainWrite.network,
        groupId,
    };
}
/** Publish one SimpleGroupChat pin with the encrypted message body. */
async function sendGroupChatMessage(signer, input) {
    const groupId = requireOnChainGroupId(input.groupId);
    const content = requireEncryptedContent(input.content);
    const payload = {
        groupId,
        nickName: normalizeText(input.nickName),
        content,
        contentType: 'text/plain',
        encryption: 'aes',
        timestamp: Date.now(),
    };
    const replyPin = normalizeText(input.replyPin);
    if (replyPin)
        payload.replyPin = replyPin;
    const channelId = normalizeText(input.channelId);
    if (channelId)
        payload.channelId = channelId;
    const mention = Array.isArray(input.mention)
        ? input.mention.map((entry) => normalizeText(entry)).filter(Boolean)
        : [];
    if (mention.length)
        payload.mention = mention;
    const chainWrite = await signer.writePin({
        operation: 'create',
        path: exports.SIMPLE_GROUP_CHAT_PATH,
        encryption: '0',
        version: GROUP_PROTOCOL_VERSION,
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        network: (typeof input.network === 'string' && input.network.trim()) || 'mvc',
    });
    return {
        pinId: chainWrite.pinId,
        txids: Array.isArray(chainWrite.txids) ? chainWrite.txids : [],
        totalCost: chainWrite.totalCost,
        network: chainWrite.network,
        groupId,
    };
}
/**
 * Human-readable success sheets mirroring the IDBots group_chat
 * formatPinResult titles. The view link follows the MetaWeb URI convention
 * (pin:// — never a Web2 viewer URL). Exposed for tests.
 */
function formatJoinGroupResult(input) {
    return formatGroupPinResult('Joined group on-chain (SimpleGroupJoin).', input);
}
function formatSendGroupResult(input) {
    return formatGroupPinResult('Group message sent (SimpleGroupChat).', input);
}
function formatGroupPinResult(title, input) {
    const lines = [title];
    if (input.pinId)
        lines.push(`- pinId: ${input.pinId}`);
    if (input.txids.length)
        lines.push(`- txids: ${input.txids.join(', ')}`);
    lines.push(`- cost: ${input.totalCost} sats`);
    if (input.pinId) {
        lines.push(`- pin link: ${(0, uri_1.markdownSelfLink)(`pin://${input.pinId}`)}`);
    }
    return lines.join('\n');
}
