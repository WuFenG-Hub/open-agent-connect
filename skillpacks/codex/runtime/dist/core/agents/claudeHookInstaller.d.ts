export declare function claudeSettingsPath(homeDir?: string): string;
export interface ClaudeHookInstallPlan {
    settingsPath: string;
    scriptPath: string;
    events: string[];
    settingsExisted: boolean;
    alreadyInstalled: boolean;
    existingUserHookEvents: string[];
}
export interface ClaudeHookInstallResult extends ClaudeHookInstallPlan {
    changed: boolean;
    backupPath: string;
}
export declare function planClaudeHookInstall(input: {
    agentsDir: string;
    homeDir?: string;
}): Promise<ClaudeHookInstallPlan>;
export declare function installClaudeHooks(input: {
    agentsDir: string;
    homeDir?: string;
}): Promise<ClaudeHookInstallResult>;
export declare function uninstallClaudeHooks(input: {
    agentsDir: string;
    homeDir?: string;
}): Promise<{
    settingsPath: string;
    changed: boolean;
    removedScript: boolean;
}>;
export interface ClaudeHookDoctorReport {
    settingsPath: string;
    scriptPath: string;
    settingsExisted: boolean;
    installed: boolean;
    events: string[];
    existingUserHookEvents: string[];
    scriptPresent: boolean;
    endpointPublished: boolean;
}
export declare function doctorClaudeHooks(input: {
    agentsDir: string;
    homeDir?: string;
}): Promise<ClaudeHookDoctorReport>;
