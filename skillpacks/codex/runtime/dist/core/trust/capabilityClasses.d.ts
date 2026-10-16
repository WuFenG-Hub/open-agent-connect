export type CapabilityClass = 'C0' | 'C1' | 'C2' | 'C3' | 'C4';
export declare const CAPABILITY_CLASSES: readonly CapabilityClass[];
export declare function isCapabilityClass(value: unknown): value is CapabilityClass;
export type PeerTrustTier = 'local' | 'team' | 'trusted' | 'contact' | 'stranger' | 'blocked';
export declare const PEER_TRUST_TIERS: readonly PeerTrustTier[];
export declare function isPeerTrustTier(value: unknown): value is PeerTrustTier;
/**
 * The spec permission matrix. `contact` carries C0 only here; the policy
 * engine adds C2 for the grouptask context ("C2 group-task context only").
 * `blocked` allows nothing. `local` excludes C4 (human-only).
 */
export declare const TIER_ALLOWED_CLASSES: Record<PeerTrustTier, readonly CapabilityClass[]>;
/** Classes a tier allows in a given policy context (contact unlocks C2 in grouptask). */
export declare function allowedClassesFor(tier: PeerTrustTier, context: 'chat' | 'grouptask' | 'invite'): readonly CapabilityClass[];
