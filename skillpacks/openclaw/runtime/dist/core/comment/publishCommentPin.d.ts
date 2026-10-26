/**
 * On-chain comment publishing via the paycomment protocol. OAC port of the
 * IDBots comment_pin semantics: any pin can be commented on (a buzz, a note,
 * a question, an answer, …) — the comment pin joins the target's public
 * thread. Payload-only write (no uploads), same posture as the paylike
 * reaction writer.
 */
import type { Signer } from '../signing/signer';
export declare const PAYCOMMENT_PATH = "/protocols/paycomment";
export declare class CommentPublishError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface PublishCommentPinInput {
    /** pinId of the pin being commented on. */
    pinId: string;
    /** Comment body — plain text or markdown, non-empty. */
    content: string;
    /** Write network; default mvc. */
    network?: string;
}
export interface PublishCommentPinResult {
    /** The comment pin's own id. */
    pinId: string;
    txids: string[];
    totalCost: number;
    network: string;
    /** The commented-on pin's id. */
    targetPinId: string;
    content: string;
}
/** Publish one paycomment pin (payload-only write, no upload). */
export declare function publishCommentPin(signer: Signer, input: PublishCommentPinInput): Promise<PublishCommentPinResult>;
/**
 * Human-readable success sheet for comment_pin. The view link follows the
 * MetaWeb URI convention (pin:// — never a Web2 viewer URL). Exposed for
 * tests.
 */
export declare function formatCommentPinResult(input: {
    commentPinId: string;
    txids: string[];
    totalCost: number;
    targetPinId: string;
}): string;
