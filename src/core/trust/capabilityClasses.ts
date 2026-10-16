// Capability classes and the trust-tier permission matrix (trust tiers P3).
// Everything a remote peer can make a local Bot do is grouped into five
// classes (design: 2026-10-16-trust-tiers-permission-matrix-design.md);
// TIER_ALLOWED_CLASSES implements the spec matrix exactly. C4 is NEVER
// reachable through a remote message at any tier — it requires the local
// human (CLI/UI on the device), so `local` tops out at C3 here.

export type CapabilityClass = 'C0' | 'C1' | 'C2' | 'C3' | 'C4';

export const CAPABILITY_CLASSES: readonly CapabilityClass[] = ['C0', 'C1', 'C2', 'C3', 'C4'];

export function isCapabilityClass(value: unknown): value is CapabilityClass {
  return value === 'C0' || value === 'C1' || value === 'C2' || value === 'C3' || value === 'C4';
}

export type PeerTrustTier = 'local' | 'team' | 'trusted' | 'contact' | 'stranger' | 'blocked';

export const PEER_TRUST_TIERS: readonly PeerTrustTier[] = ['local', 'team', 'trusted', 'contact', 'stranger', 'blocked'];

export function isPeerTrustTier(value: unknown): value is PeerTrustTier {
  return value === 'local' || value === 'team' || value === 'trusted'
    || value === 'contact' || value === 'stranger' || value === 'blocked';
}

/**
 * The spec permission matrix. `contact` carries C0 only here; the policy
 * engine adds C2 for the grouptask context ("C2 group-task context only").
 * `blocked` allows nothing. `local` excludes C4 (human-only).
 */
export const TIER_ALLOWED_CLASSES: Record<PeerTrustTier, readonly CapabilityClass[]> = {
  local: ['C0', 'C1', 'C2', 'C3'],
  team: ['C0', 'C1', 'C2', 'C3'],
  trusted: ['C0', 'C1', 'C2'],
  contact: ['C0'],
  stranger: ['C0'],
  blocked: [],
};

/** Classes a tier allows in a given policy context (contact unlocks C2 in grouptask). */
export function allowedClassesFor(tier: PeerTrustTier, context: 'chat' | 'grouptask' | 'invite'): readonly CapabilityClass[] {
  if (tier === 'contact' && context === 'grouptask') {
    return ['C0', 'C2'];
  }
  return TIER_ALLOWED_CLASSES[tier];
}
