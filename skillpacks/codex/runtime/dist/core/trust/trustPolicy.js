"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ACCEPT_BEHAVIOR = exports.TRUST_ACCEPT_BEHAVIORS = void 0;
exports.normalizeChatTrustPolicy = normalizeChatTrustPolicy;
exports.evaluatePeerPolicy = evaluatePeerPolicy;
// Trust policy engine (trust tiers P3): the pure decision layer that maps a
// peer + profile + context to { tier, acceptBehavior, allowedClasses,
// allowedSkills }. Enforcement points (chat ingress, invite acceptance,
// group-task seating) consume this in P4 — P3 delivers no behavior changes.
//
// Accept-behavior defaults follow the spec enforcement points: chat replies
// stay `auto` for every non-blocked tier (strangers keep C0-only chat);
// invites queue strangers as pending and silently decline the blocked;
// grouptask seating mirrors invites. All of it is overridable per profile
// via `trust.chatTrustPolicy` (per-context, per-tier).
const capabilityClasses_1 = require("./capabilityClasses");
const peerTrustResolver_1 = require("./peerTrustResolver");
const skillCapabilityClasses_1 = require("../services/skillCapabilityClasses");
exports.TRUST_ACCEPT_BEHAVIORS = ['auto', 'queue', 'ignore', 'decline'];
function isTrustAcceptBehavior(value) {
    return value === 'auto' || value === 'queue' || value === 'ignore' || value === 'decline';
}
function normalizeBehaviorMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const result = {};
    for (const [tier, behavior] of Object.entries(value)) {
        if ((0, capabilityClasses_1.isPeerTrustTier)(tier) && isTrustAcceptBehavior(behavior)) {
            result[tier] = behavior;
        }
    }
    return result;
}
/** Defensive normalizer for the `trust.chatTrustPolicy` config field. */
function normalizeChatTrustPolicy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const source = value;
    const result = {};
    for (const context of ['chat', 'invite', 'grouptask']) {
        const normalized = normalizeBehaviorMap(source[context]);
        if (Object.keys(normalized).length > 0) {
            result[context] = normalized;
        }
    }
    return result;
}
/** Spec defaults for accept behavior (enforcement points 1-2 of the design). */
exports.DEFAULT_ACCEPT_BEHAVIOR = {
    chat: {
        local: 'auto',
        team: 'auto',
        trusted: 'auto',
        contact: 'auto',
        stranger: 'auto',
        blocked: 'ignore',
    },
    invite: {
        local: 'auto',
        team: 'auto',
        trusted: 'auto',
        contact: 'auto',
        stranger: 'queue',
        blocked: 'decline',
    },
    grouptask: {
        local: 'auto',
        team: 'auto',
        trusted: 'auto',
        contact: 'auto',
        stranger: 'queue',
        blocked: 'decline',
    },
};
const defaultTierResolvers = new Map();
function defaultTierResolver(systemHomeDir) {
    let resolver = defaultTierResolvers.get(systemHomeDir);
    if (!resolver) {
        resolver = (0, peerTrustResolver_1.createPeerTrustResolver)({ systemHomeDir });
        defaultTierResolvers.set(systemHomeDir, resolver);
    }
    return resolver;
}
function normalizeAllowChatSkills(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
}
/**
 * Evaluate the effective policy for one peer in one context. Pure decision
 * layer: no chat/invite behavior changes happen here (P4 wires the
 * enforcement points).
 */
async function evaluatePeerPolicy(input) {
    const tierResolver = input.tierResolver ?? defaultTierResolver(input.systemHomeDir);
    const tier = await tierResolver.resolvePeerTrustTier({
        peerGlobalMetaId: input.peerGlobalMetaId,
        profileHomeDir: input.profileHomeDir,
        localProfileGmids: input.localProfileGmids,
    });
    const allowedClasses = [...(0, capabilityClasses_1.allowedClassesFor)(tier, input.context)];
    const overrides = (0, skillCapabilityClasses_1.normalizeSkillClassOverrides)(input.profile.skillClassOverrides);
    const allowedSkillSet = new Set(allowedClasses);
    const allowedSkills = normalizeAllowChatSkills(input.profile.allowChatSkills)
        .filter((skillName) => allowedSkillSet.has((0, skillCapabilityClasses_1.classifySkill)(skillName, overrides)));
    const policy = normalizeChatTrustPolicy(input.profile.chatTrustPolicy);
    const acceptBehavior = policy[input.context]?.[tier] ?? exports.DEFAULT_ACCEPT_BEHAVIOR[input.context][tier];
    return { tier, acceptBehavior, allowedClasses, allowedSkills };
}
