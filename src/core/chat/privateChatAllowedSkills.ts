import type { LlmBindingStore } from '../llm/llmBindingStore';
import type { LlmRuntimeStore } from '../llm/llmRuntimeStore';
import type { MetabotPaths } from '../state/paths';
import { getMetabotProfile } from '../bot/metabotProfileManager';
import {
  resolveAllowChatSkillsForPlatform,
  resolveAllowChatSkillsForRuntime,
  writeChatSkillResolution,
} from '../services/chatSkillPolicy';
import { getActiveHostLlmExecutorBridge } from '../llm/hostLlmExecutorBridge';

export interface PrivateChatAllowedSkillDetail {
  name: string;
  description: string | null;
  // Absolute path to the skill's SKILL.md in its source root. The chat prompt
  // points the model here so it always reads the fresh skill document.
  location: string | null;
}

export interface PrivateChatAllowedSkillScope {
  skills: string[];
  skillSourcePaths: Record<string, string>;
  skillDetails: PrivateChatAllowedSkillDetail[];
  skippedSkills: string[];
  warning: string | null;
}

export type PrivateChatAllowedSkillsResolver = (
  /**
   * Optional trust-tier policy filter (trust tiers P4a): when provided, the
   * resolved scope is intersected with this list — the policy already applied
   * the tier's capability-class ceiling to the profile's allowChatSkills, and
   * this resolver keeps only the installed-and-validated remainder.
   */
  policyAllowedSkills?: string[] | null,
) => Promise<PrivateChatAllowedSkillScope>;

export function emptyPrivateChatAllowedSkillScope(): PrivateChatAllowedSkillScope {
  return {
    skills: [],
    skillSourcePaths: {},
    skillDetails: [],
    skippedSkills: [],
    warning: null,
  };
}

export function createPrivateChatAllowedSkillsResolver(input: {
  paths: MetabotPaths;
  metaBotSlug: string;
  runtimeStore: LlmRuntimeStore;
  bindingStore: LlmBindingStore;
  env?: NodeJS.ProcessEnv;
  logWarning?: (scope: string, message: string) => void;
  /**
   * While a host executor is connected, allowed skills resolve against the
   * DSH platform scope (~/.dsh/skills + ~/.agents/skills) — the surface the
   * reply turn actually executes on in host agent mode — instead of the
   * primary local runtime's platform. Defaults to the active bridge.
   */
  hostExecutorConnected?: () => boolean;
}): PrivateChatAllowedSkillsResolver {
  const hostExecutorConnected = input.hostExecutorConnected
    ?? (() => (getActiveHostLlmExecutorBridge()?.connectedExecutors() ?? 0) > 0);
  // Persist the last resolution outcome so operators can see configured
  // skills that no longer resolve. Strictly best-effort: a failed write must
  // never affect the chat turn.
  const persistResolution = (scope: PrivateChatAllowedSkillScope) => writeChatSkillResolution(
    input.paths.chatSkillResolutionPath,
    {
      resolved: scope.skills,
      skipped: scope.skippedSkills,
      warning: scope.warning,
      checkedAt: new Date().toISOString(),
    },
  ).catch(() => undefined);

  return async (policyAllowedSkills?: string[] | null) => {
    const profile = await getMetabotProfile(input.paths.systemHomeDir, input.metaBotSlug);
    if (!profile || profile.allowChatSkills.length === 0) {
      const emptyScope = emptyPrivateChatAllowedSkillScope();
      await persistResolution(emptyScope);
      return emptyScope;
    }

    const policyInput = {
      metaBotSlug: input.metaBotSlug,
      allowChatSkills: profile.allowChatSkills,
      runtimeStore: input.runtimeStore,
      bindingStore: input.bindingStore,
      systemHomeDir: input.paths.systemHomeDir,
      projectRoot: input.paths.profileRoot,
      env: input.env,
    };
    const result = hostExecutorConnected()
      ? await resolveAllowChatSkillsForPlatform({ ...policyInput, platformId: 'dsh' })
      : await resolveAllowChatSkillsForRuntime(policyInput);

    if (result.warning) {
      input.logWarning?.('[private chat allowed skills]', result.warning);
    }

    let scope = {
      skills: result.skills.map((skill) => skill.skillName),
      skillSourcePaths: result.skillSourcePaths,
      skillDetails: result.skills.map((skill) => ({
        name: skill.skillName,
        description: typeof skill.description === 'string' && skill.description.trim()
          ? skill.description.trim()
          : null,
        location: typeof skill.skillDocumentPath === 'string' && skill.skillDocumentPath.trim()
          ? skill.skillDocumentPath.trim()
          : null,
      })),
      skippedSkills: result.skippedSkills,
      warning: result.warning ?? null,
    };

    // Trust-tier policy (P4a): keep only the skills this peer's tier allows.
    // An empty filter list means "plain chat, no skill execution" (e.g. a
    // stranger) — NOT "no filtering"; absence of the argument is the legacy
    // unfiltered path.
    if (policyAllowedSkills) {
      const allowed = new Set(policyAllowedSkills);
      const skills = scope.skills.filter((skillName) => allowed.has(skillName));
      scope = {
        ...scope,
        skills,
        skillSourcePaths: Object.fromEntries(
          Object.entries(scope.skillSourcePaths).filter(([skillName]) => allowed.has(skillName)),
        ),
        skillDetails: scope.skillDetails.filter((detail) => allowed.has(detail.name)),
      };
    }
    await persistResolution(scope);
    return scope;
  };
}
