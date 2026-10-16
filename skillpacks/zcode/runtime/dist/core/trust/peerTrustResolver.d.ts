import type { PeerTrustTier } from './capabilityClasses';
import { type RootOwnerResolver } from './rootOwnerResolver';
import { type TrustedOwnerResolver } from './trustedOwnerResolver';
export interface ResolvePeerTrustTierInput {
    peerGlobalMetaId: string;
    /** Profile home used for contact-evidence lookup (two-way chat exchange). */
    profileHomeDir?: string;
    /** Defaults to the gmids registered in the device profile manager. */
    localProfileGmids?: string[];
}
export interface PeerTrustTierResolver {
    resolvePeerTrustTier(input: ResolvePeerTrustTierInput): Promise<PeerTrustTier>;
    /** Drop cached tiers: one peer, or everything when omitted. */
    invalidate(peerGlobalMetaId?: string): void;
}
export interface CreatePeerTrustResolverInput {
    /** Anchors the blocklist, the device identity, and the default caches. */
    systemHomeDir: string;
    /** Test seams — default to the real P1/P2 resolvers over systemHomeDir. */
    rootOwnerResolver?: RootOwnerResolver;
    trustedOwnerResolver?: TrustedOwnerResolver;
    contactEvidence?: (profileHomeDir: string, peerGlobalMetaId: string) => Promise<boolean>;
    listLocalProfileGmids?: () => Promise<string[]>;
    tierCacheTtlMs?: number;
    now?: () => number;
}
export declare function createPeerTrustResolver(input: CreatePeerTrustResolverInput): PeerTrustTierResolver;
