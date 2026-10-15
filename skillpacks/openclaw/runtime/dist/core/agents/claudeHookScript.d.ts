export declare const CLAUDE_HOOK_SCRIPT_NAME = "metabot-claude-hook.sh";
export declare const CLAUDE_HOOK_SPOOL_MAX_BYTES: number;
export declare function claudeHookScriptPath(agentsDir: string): string;
/** Ownership marker: managed settings entries always reference this file. */
export declare function isManagedClaudeHookCommand(command: string): boolean;
export declare function renderClaudeHookScript(agentsDir: string): string;
