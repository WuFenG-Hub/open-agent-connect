import { type CapabilityClass, type PeerTrustTier } from './capabilityClasses';
import { type PeerTrustTierResolver } from './peerTrustResolver';
export type TrustPolicyContext = 'chat' | 'grouptask' | 'invite';
export type TrustAcceptBehavior = 'auto' | 'queue' | 'ignore' | 'decline';
export declare const TRUST_ACCEPT_BEHAVIORS: readonly TrustAcceptBehavior[];
/** Per-profile accept overrides: `trust.chatTrustPolicy` in profile config. */
export interface ChatTrustPolicyConfig {
    chat?: Partial<Record<PeerTrustTier, TrustAcceptBehavior>>;
    invite?: Partial<Record<PeerTrustTier, TrustAcceptBehavior>>;
    grouptask?: Partial<Record<PeerTrustTier, TrustAcceptBehavior>>;
}
/** Defensive normalizer for the `trust.chatTrustPolicy` config field. */
export declare function normalizeChatTrustPolicy(value: unknown): ChatTrustPolicyConfig;
/** Spec defaults for accept behavior (enforcement points 1-2 of the design). */
export declare const DEFAULT_ACCEPT_BEHAVIOR: Record<TrustPolicyContext, Record<PeerTrustTier, TrustAcceptBehavior>>;
/** The profile fields the policy engine needs (P4 passes the real records). */
export interface TrustPolicyProfileView {
    /** Raw `allowChatSkills` from the profile record (string[]). */
    allowChatSkills?: unknown;
    /** Raw `trust.skillClassOverrides` from profile config. */
    skillClassOverrides?: unknown;
    /** Raw `trust.chatTrustPolicy` from profile config. */
    chatTrustPolicy?: unknown;
}
export interface PeerPolicyEvaluation {
    tier: PeerTrustTier;
    acceptBehavior: TrustAcceptBehavior;
    allowedClasses: CapabilityClass[];
    /** allowChatSkills ∩ registry classes ∩ overrides, filtered by the tier. */
    allowedSkills: string[];
}
export interface EvaluatePeerPolicyInput {
    peerGlobalMetaId: string;
    profile: TrustPolicyProfileView;
    profileHomeDir?: string;
    localProfileGmids?: string[];
    context: TrustPolicyContext;
    systemHomeDir: string;
    /** Test seam — defaults to a process-wide resolver per systemHomeDir. */
    tierResolver?: PeerTrustTierResolver;
}
/**
 * Evaluate the effective policy for one peer in one context. Pure decision
 * layer: no chat/invite behavior changes happen here (P4 wires the
 * enforcement points).
 */
export declare function evaluatePeerPolicy(input: EvaluatePeerPolicyInput): Promise<PeerPolicyEvaluation>;
