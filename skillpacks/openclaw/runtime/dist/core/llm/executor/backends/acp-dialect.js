"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acpToolNameFromTitle = acpToolNameFromTitle;
/**
 * Map a human tool title plus a fallback kind onto the canonical tool-name
 * vocabulary the Hermes/Kimi/Kiro ACP servers share ("terminal: pwd" ->
 * "terminal", kind "read" -> "read_file").
 */
function acpToolNameFromTitle(title, kind) {
    const safeTitle = title?.trim() ?? '';
    if (safeTitle === 'execute code')
        return 'execute_code';
    const colonIndex = safeTitle.indexOf(':');
    if (colonIndex > 0) {
        const name = safeTitle.slice(0, colonIndex).trim();
        if (name === 'terminal')
            return 'terminal';
        if (name === 'read')
            return 'read_file';
        if (name === 'write')
            return 'write_file';
        if (name.startsWith('patch'))
            return 'patch';
        if (name === 'search')
            return 'search_files';
        if (name === 'web search')
            return 'web_search';
        if (name === 'extract')
            return 'web_extract';
        if (name === 'delegate')
            return 'delegate_task';
        if (name === 'analyze image')
            return 'vision_analyze';
        return name;
    }
    switch (kind) {
        case 'read':
            return 'read_file';
        case 'edit':
            return 'write_file';
        case 'execute':
            return 'terminal';
        case 'search':
            return 'search_files';
        case 'fetch':
            return 'web_search';
        case 'think':
            return 'thinking';
        default:
            return safeTitle || kind || 'tool';
    }
}
