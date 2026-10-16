import { type CapabilityClass } from '../trust/capabilityClasses';
export type SkillCapabilityClass = CapabilityClass;
export declare const DEFAULT_UNKNOWN_SKILL_CAPABILITY_CLASS: SkillCapabilityClass;
/**
 * Default class per shipped skill, each classified by its most privileged
 * action:
 *   C0 chat        — pure conversational knowledge transfer
 *   C1 read-local  — read-only local/chain state access
 *   C2 collab      — on-chain writes + sandbox-local (<profile>/.runtime) writes
 *   C3 write-local — local execution, real browser control, host/platform changes
 *   C4 admin       — funds and identity operations (human-only, never remote)
 */
export declare const DEFAULT_SKILL_CAPABILITY_CLASSES: Record<string, SkillCapabilityClass>;
/**
 * Effective class for a skill: per-profile override wins, then the default
 * table; unknown skills are C3 (conservative).
 */
export declare function classifySkill(skillName: string, overrides?: Record<string, SkillCapabilityClass>): SkillCapabilityClass;
/** Defensive normalizer for the `trust.skillClassOverrides` config field. */
export declare function normalizeSkillClassOverrides(value: unknown): Record<string, SkillCapabilityClass>;
