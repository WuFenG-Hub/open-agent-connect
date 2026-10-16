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
import {
  allowedClassesFor,
  isPeerTrustTier,
  type CapabilityClass,
  type PeerTrustTier,
} from './capabilityClasses';
import {
  createPeerTrustResolver,
  type PeerTrustTierResolver,
} from './peerTrustResolver';
import {
  classifySkill,
  normalizeSkillClassOverrides,
  type SkillCapabilityClass,
} from '../services/skillCapabilityClasses';

export type TrustPolicyContext = 'chat' | 'grouptask' | 'invite';

export type TrustAcceptBehavior = 'auto' | 'queue' | 'ignore' | 'decline';

export const TRUST_ACCEPT_BEHAVIORS: readonly TrustAcceptBehavior[] = ['auto', 'queue', 'ignore', 'decline'];

function isTrustAcceptBehavior(value: unknown): value is TrustAcceptBehavior {
  return value === 'auto' || value === 'queue' || value === 'ignore' || value === 'decline';
}

/** Per-profile accept overrides: `trust.chatTrustPolicy` in profile config. */
export interface ChatTrustPolicyConfig {
  chat?: Partial<Record<PeerTrustTier, TrustAcceptBehavior>>;
  invite?: Partial<Record<PeerTrustTier, TrustAcceptBehavior>>;
  grouptask?: Partial<Record<PeerTrustTier, TrustAcceptBehavior>>;
}

function normalizeBehaviorMap(
  value: unknown,
): Partial<Record<PeerTrustTier, TrustAcceptBehavior>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Partial<Record<PeerTrustTier, TrustAcceptBehavior>> = {};
  for (const [tier, behavior] of Object.entries(value as Record<string, unknown>)) {
    if (isPeerTrustTier(tier) && isTrustAcceptBehavior(behavior)) {
      result[tier] = behavior;
    }
  }
  return result;
}

/** Defensive normalizer for the `trust.chatTrustPolicy` config field. */
export function normalizeChatTrustPolicy(value: unknown): ChatTrustPolicyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: ChatTrustPolicyConfig = {};
  for (const context of ['chat', 'invite', 'grouptask'] as const) {
    const normalized = normalizeBehaviorMap(source[context]);
    if (Object.keys(normalized).length > 0) {
      result[context] = normalized;
    }
  }
  return result;
}

/** Spec defaults for accept behavior (enforcement points 1-2 of the design). */
export const DEFAULT_ACCEPT_BEHAVIOR: Record<TrustPolicyContext, Record<PeerTrustTier, TrustAcceptBehavior>> = {
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

const defaultTierResolvers = new Map<string, PeerTrustTierResolver>();

function defaultTierResolver(systemHomeDir: string): PeerTrustTierResolver {
  let resolver = defaultTierResolvers.get(systemHomeDir);
  if (!resolver) {
    resolver = createPeerTrustResolver({ systemHomeDir });
    defaultTierResolvers.set(systemHomeDir, resolver);
  }
  return resolver;
}

function normalizeAllowChatSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Evaluate the effective policy for one peer in one context. Pure decision
 * layer: no chat/invite behavior changes happen here (P4 wires the
 * enforcement points).
 */
export async function evaluatePeerPolicy(input: EvaluatePeerPolicyInput): Promise<PeerPolicyEvaluation> {
  const tierResolver = input.tierResolver ?? defaultTierResolver(input.systemHomeDir);
  const tier = await tierResolver.resolvePeerTrustTier({
    peerGlobalMetaId: input.peerGlobalMetaId,
    profileHomeDir: input.profileHomeDir,
    localProfileGmids: input.localProfileGmids,
  });

  const allowedClasses = [...allowedClassesFor(tier, input.context)];
  const overrides: Record<string, SkillCapabilityClass> = normalizeSkillClassOverrides(
    input.profile.skillClassOverrides,
  );
  const allowedSkillSet = new Set(allowedClasses);
  const allowedSkills = normalizeAllowChatSkills(input.profile.allowChatSkills)
    .filter((skillName) => allowedSkillSet.has(classifySkill(skillName, overrides)));

  const policy = normalizeChatTrustPolicy(input.profile.chatTrustPolicy);
  const acceptBehavior = policy[input.context]?.[tier] ?? DEFAULT_ACCEPT_BEHAVIOR[input.context][tier];

  return { tier, acceptBehavior, allowedClasses, allowedSkills };
}
