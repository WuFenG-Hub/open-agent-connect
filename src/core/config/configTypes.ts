import {
  createDefaultBrowserConfig,
  type BotHomepageTemplateId,
  type BrowserNameResolutionConfig,
} from '@openagentinternet/agent-browser-core';
import type { CapabilityClass } from '../trust/capabilityClasses';
import type { ChatTrustPolicyConfig } from '../trust/trustPolicy';

export interface A2AConfig {
  simplemsgListenerEnabled: boolean;
}

export interface AutoReplyConfig {
  enabled: boolean;
  maxTurns: number;
  cooldownMs: number;
}

export interface AutomationConfig {
  /**
   * Daemon nightly dream tick (dream due → run + pre-dream surf gate +
   * memory-hygiene tail) for this profile. Default enabled so non-DSH
   * installs get nightly dreams out of the box; the tick also stands down
   * while the DSH host-executor bridge is connected.
   */
  dreamTickEnabled: boolean;
  /**
   * Daemon chain-history summary drain (bounded on-chain read/write
   * summarization) for this profile. Default enabled; same DSH stand-down
   * as the dream tick.
   */
  chainHistorySummaryEnabled: boolean;
}

export const AUTO_REPLY_MAX_TURNS_OPTIONS: readonly number[] = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
export const AUTO_REPLY_COOLDOWN_MS_OPTIONS: readonly number[] = [60_000, 300_000, 600_000, 1_800_000, 3_600_000];
// IDBots parity: 50 turns per active private-chat session by default.
export const DEFAULT_AUTO_REPLY_MAX_TURNS = 50;
export const DEFAULT_AUTO_REPLY_COOLDOWN_MS = 60_000;

export type DefaultWriteNetwork = 'mvc' | 'btc' | 'doge' | 'opcat';

export const DEFAULT_WRITE_NETWORKS: DefaultWriteNetwork[] = ['mvc', 'btc', 'doge', 'opcat'];
const DEFAULT_BLOCK_EXPLORER_BASE_URL = 'https://www.mvcscan.com/tx';

export interface ChainConfig {
  defaultWriteNetwork: DefaultWriteNetwork;
  mvcSponsorUploadEnabled: boolean;
}

export interface BrowserConfig {
  renderCustomBotPages: boolean;
  nameResolution: BrowserNameResolutionConfig;
  blockExplorerBaseUrl?: string;
  walletApiBaseUrl?: string;
  botHomepageTemplateId: BotHomepageTemplateId;
  defaultChainName: DefaultWriteNetwork;
  localMode: boolean;
}

/**
 * Trust-tier policy configuration (trust tiers P3): per-profile overrides
 * over the spec defaults. `skillClassOverrides` re-classes individual
 * skills; `chatTrustPolicy` overrides per-context/per-tier accept behavior.
 * Both are optional maps — empty means "follow the spec defaults".
 */
export interface TrustConfig {
  skillClassOverrides: Record<string, CapabilityClass>;
  chatTrustPolicy: ChatTrustPolicyConfig;
}

export interface MetabotConfig {
  chain: ChainConfig;
  a2a: A2AConfig;
  autoReply: AutoReplyConfig;
  automation: AutomationConfig;
  browser: BrowserConfig;
  trust: TrustConfig;
}

export function isDefaultWriteNetwork(value: unknown): value is DefaultWriteNetwork {
  return typeof value === 'string' && DEFAULT_WRITE_NETWORKS.includes(value as DefaultWriteNetwork);
}

export function createDefaultConfig(): MetabotConfig {
  const browserDefaults = createDefaultBrowserConfig();
  return {
    chain: {
      defaultWriteNetwork: 'mvc',
      mvcSponsorUploadEnabled: true,
    },
    a2a: {
      simplemsgListenerEnabled: true,
    },
    autoReply: {
      enabled: true,
      maxTurns: DEFAULT_AUTO_REPLY_MAX_TURNS,
      cooldownMs: DEFAULT_AUTO_REPLY_COOLDOWN_MS,
    },
    automation: {
      dreamTickEnabled: true,
      chainHistorySummaryEnabled: true,
    },
    browser: {
      botHomepageTemplateId: browserDefaults.botHomepageTemplateId,
      renderCustomBotPages: browserDefaults.renderCustomBotPages,
      nameResolution: browserDefaults.nameResolution,
      blockExplorerBaseUrl: DEFAULT_BLOCK_EXPLORER_BASE_URL,
      defaultChainName: 'mvc',
      localMode: true,
    },
    trust: {
      skillClassOverrides: {},
      chatTrustPolicy: {},
    },
  };
}
