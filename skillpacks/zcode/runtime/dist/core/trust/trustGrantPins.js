"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrustGrantError = exports.SIMPLETRUST_VERSION = exports.SIMPLETRUST_PATH = void 0;
exports.buildTrustGrantPayload = buildTrustGrantPayload;
exports.buildTrustRevokePayload = buildTrustRevokePayload;
exports.parseSimpletrustPin = parseSimpletrustPin;
exports.publishTrustGrant = publishTrustGrant;
exports.publishTrustRevoke = publishTrustRevoke;
const deriveIdentity_1 = require("../identity/deriveIdentity");
const identityChainPublisher_1 = require("../owner/identityChainPublisher");
exports.SIMPLETRUST_PATH = '/protocols/simpletrust';
exports.SIMPLETRUST_VERSION = 1;
class TrustGrantError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'TrustGrantError';
    }
}
exports.TrustGrantError = TrustGrantError;
function buildTrustGrantPayload(input) {
    const trustedOwner = (0, deriveIdentity_1.normalizeGlobalMetaId)(input.trustedOwner);
    if (!trustedOwner) {
        throw new TrustGrantError('invalid_trusted_owner', `trustedOwner is not a valid GlobalMetaID: ${String(input.trustedOwner)}`);
    }
    const payload = { version: exports.SIMPLETRUST_VERSION, trustedOwner, ts: Math.floor(input.ts) };
    const note = (input.note ?? '').trim();
    if (note)
        payload.note = note;
    return JSON.stringify(payload);
}
function buildTrustRevokePayload(input) {
    const revoke = (input.revoke ?? '').trim();
    if (!revoke) {
        throw new TrustGrantError('invalid_revoke_target', 'revoke must name the grant pinId to cancel.');
    }
    const payload = { version: exports.SIMPLETRUST_VERSION, revoke, ts: Math.floor(input.ts) };
    return JSON.stringify(payload);
}
/** Lenient parser: returns null for anything that is not a well-formed simpletrust pin. */
function parseSimpletrustPin(raw) {
    if (!raw || typeof raw !== 'string')
        return null;
    let parsed;
    try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return null;
        parsed = value;
    }
    catch {
        return null;
    }
    if (parsed.version !== exports.SIMPLETRUST_VERSION)
        return null;
    const ts = Number(parsed.ts);
    if (!Number.isFinite(ts))
        return null;
    const revoke = typeof parsed.revoke === 'string' ? parsed.revoke.trim() : '';
    if (revoke) {
        return { kind: 'revoke', revoke, ts: Math.floor(ts) };
    }
    const trustedOwner = (0, deriveIdentity_1.normalizeGlobalMetaId)(parsed.trustedOwner);
    if (!trustedOwner)
        return null;
    const note = typeof parsed.note === 'string' && parsed.note.trim() ? parsed.note.trim() : undefined;
    return note ? { kind: 'grant', trustedOwner, note, ts: Math.floor(ts) } : { kind: 'grant', trustedOwner, ts: Math.floor(ts) };
}
function buildSimpletrustWrite(payload) {
    return {
        operation: 'create',
        path: exports.SIMPLETRUST_PATH,
        contentType: 'application/json',
        payload,
        encoding: 'utf-8',
        encryption: '0',
        version: '1.0',
        network: 'mvc',
    };
}
/** Publish one trust grant pin from the owner identity (`signer` = owner signer). */
async function publishTrustGrant(input) {
    const payload = buildTrustGrantPayload({
        trustedOwner: input.trustedOwner,
        note: input.note,
        ts: input.ts ?? Date.now() / 1000,
    });
    const { chainWrite, subsidy } = await (0, identityChainPublisher_1.publishIdentityPin)({
        identity: input.owner,
        signer: input.signer,
        requestSubsidy: input.requestSubsidy,
        request: buildSimpletrustWrite(payload),
    });
    return { payload, chainWrite, subsidy };
}
/** Publish one revoke pin cancelling the grant named by `revoke` (a grant pinId). */
async function publishTrustRevoke(input) {
    const payload = buildTrustRevokePayload({ revoke: input.revoke, ts: input.ts ?? Date.now() / 1000 });
    const { chainWrite, subsidy } = await (0, identityChainPublisher_1.publishIdentityPin)({
        identity: input.owner,
        signer: input.signer,
        requestSubsidy: input.requestSubsidy,
        request: buildSimpletrustWrite(payload),
    });
    return { payload, chainWrite, subsidy };
}
