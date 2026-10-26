/**
 * Secret key for a group: the first 16 characters of the groupId, padded
 * with '0' when shorter. Mirrors IDBots metaWebCrypto.ts groupIdToSecretKey
 * ("直接取该群聊 groupId 的前 16 个字符").
 * Exposed so decrypt callers and tests can derive the same key.
 */
export declare function groupIdToSecretKey(groupId: string): string;
/**
 * Encrypt one group-chat message for broadcast. Returns the ciphertext bytes
 * as lowercase hex (the wire form of the simplegroupchat content field).
 * Mirrors IDBots encryptGroupMessageECB (AES-128-CBC despite the name).
 */
export declare function encryptGroupMessage(message: string, groupId: string): string;
/**
 * Decrypt one group-chat message (hex ciphertext) back to plaintext.
 * Exported for the core tests and a future group read surface; the write
 * path only ever needs encryptGroupMessage. Throws on malformed hex or
 * padding — callers decide how to surface that.
 */
export declare function decryptGroupMessage(cipherHex: string, groupId: string): string;
