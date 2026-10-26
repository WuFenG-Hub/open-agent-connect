"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommentPublishError = exports.PAYCOMMENT_PATH = void 0;
exports.publishCommentPin = publishCommentPin;
exports.formatCommentPinResult = formatCommentPinResult;
const uri_1 = require("../metaweb/uri");
exports.PAYCOMMENT_PATH = '/protocols/paycomment';
const PAYCOMMENT_PROTOCOL_VERSION = '1.0.0';
class CommentPublishError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'CommentPublishError';
        this.code = code;
    }
}
exports.CommentPublishError = CommentPublishError;
/** Publish one paycomment pin (payload-only write, no upload). */
async function publishCommentPin(signer, input) {
    const pinId = typeof input.pinId === 'string' ? input.pinId.trim() : '';
    if (!pinId) {
        throw new CommentPublishError('missing_field', 'comment_pin requires `pin_id` (non-empty pinId of the target pin).');
    }
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content) {
        throw new CommentPublishError('missing_field', 'comment_pin requires non-empty `content`.');
    }
    const network = (typeof input.network === 'string' && input.network.trim()) || 'mvc';
    const chainWrite = await signer.writePin({
        operation: 'create',
        path: exports.PAYCOMMENT_PATH,
        encryption: '0',
        version: PAYCOMMENT_PROTOCOL_VERSION,
        contentType: 'application/json',
        payload: JSON.stringify({ commentTo: pinId, content, contentType: 'text/markdown' }),
        network,
    });
    return {
        pinId: chainWrite.pinId,
        txids: Array.isArray(chainWrite.txids) ? chainWrite.txids : [],
        totalCost: chainWrite.totalCost,
        network: chainWrite.network,
        targetPinId: pinId,
        content,
    };
}
/**
 * Human-readable success sheet for comment_pin. The view link follows the
 * MetaWeb URI convention (pin:// — never a Web2 viewer URL). Exposed for
 * tests.
 */
function formatCommentPinResult(input) {
    const lines = [`Commented on pin ${input.targetPinId} — comment published on-chain.`];
    if (input.commentPinId)
        lines.push(`- comment pinId: ${input.commentPinId}`);
    if (input.txids.length)
        lines.push(`- txids: ${input.txids.join(', ')}`);
    lines.push(`- target pinId: ${input.targetPinId}`);
    lines.push(`- cost: ${input.totalCost} sats`);
    if (input.commentPinId) {
        lines.push(`- view link: ${(0, uri_1.markdownSelfLink)(`pin://${input.commentPinId}`)}`);
    }
    return lines.join('\n');
}
