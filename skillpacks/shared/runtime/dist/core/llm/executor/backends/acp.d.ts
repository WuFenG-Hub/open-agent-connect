import { type BlockedArgSpec, type LlmBackend } from './backend';
import type { AcpDialect } from './acp-dialect';
export interface AcpBackendOptions {
    provider: string;
    binaryPath: string;
    env?: Record<string, string>;
    baseArgs: string[];
    blockedArgs: Record<string, BlockedArgSpec>;
    forcedEnv?: Record<string, string>;
    resumeMethod: 'session/resume' | 'session/load';
    includeModelInNewSession?: boolean;
    includeMcpServersInResume?: boolean;
    sendPromptContentAlias?: boolean;
    gateNotificationsUntilPrompt?: boolean;
    /** Per-provider deviations; see acp-dialect.ts. */
    dialect?: AcpDialect;
    /** Inbound ndjson line cap; oversized lines are classified and rejected. */
    maxLineBytes?: number;
}
export declare function createAcpBackend(options: AcpBackendOptions): LlmBackend;
