"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_HOOK_SPOOL_MAX_AGE_MS = exports.AGENT_HOOK_SPOOL_MAX_BYTES = exports.AGENT_HOOK_SPOOL_DIRNAME = exports.AGENT_HOOK_ENDPOINT_FILENAME = exports.AGENT_HOOK_PROTOCOL_VERSION = void 0;
exports.endpointFilePath = endpointFilePath;
exports.spoolDirPath = spoolDirPath;
exports.newAgentHookToken = newAgentHookToken;
exports.renderEndpointFile = renderEndpointFile;
exports.writeAgentHookEndpointFile = writeAgentHookEndpointFile;
exports.readAgentHookEndpointFile = readAgentHookEndpointFile;
exports.drainAgentHookSpool = drainAgentHookSpool;
/**
 * Endpoint publication for managed agent hooks. Hook scripts are installed
 * into third-party CLIs and outlive daemon restarts, so they re-discover the
 * daemon on every invocation by sourcing this endpoint file instead of
 * holding a baked-in port. The token rotates per daemon boot; the file is
 * written atomically with tight permissions, and values are restricted to a
 * safe charset so the file can never smuggle shell syntax when sourced.
 */
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
exports.AGENT_HOOK_PROTOCOL_VERSION = '1';
exports.AGENT_HOOK_ENDPOINT_FILENAME = 'hook-endpoint.env';
exports.AGENT_HOOK_SPOOL_DIRNAME = 'spool';
exports.AGENT_HOOK_SPOOL_MAX_BYTES = 5 * 1024 * 1024;
exports.AGENT_HOOK_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_VALUE = /^[A-Za-z0-9._:/-]+$/;
function endpointFilePath(agentsDir) {
    return node_path_1.default.join(agentsDir, exports.AGENT_HOOK_ENDPOINT_FILENAME);
}
function spoolDirPath(agentsDir) {
    return node_path_1.default.join(agentsDir, exports.AGENT_HOOK_SPOOL_DIRNAME);
}
function newAgentHookToken() {
    return (0, node_crypto_1.randomUUID)();
}
function renderEndpointFile(endpoint) {
    const lines = [
        `METABOT_AGENT_HOOK_PORT=${endpoint.port}`,
        `METABOT_AGENT_HOOK_TOKEN=${endpoint.token}`,
        `METABOT_AGENT_HOOK_VERSION=${endpoint.version}`,
    ];
    for (const line of lines) {
        const value = line.slice(line.indexOf('=') + 1);
        if (!SAFE_VALUE.test(value)) {
            throw new Error(`Agent hook endpoint value is not safe to source: ${line.slice(0, line.indexOf('='))}`);
        }
    }
    return `${lines.join('\n')}\n`;
}
/** Atomic, 0600 write; the parent dir is created 0700. */
async function writeAgentHookEndpointFile(agentsDir, endpoint) {
    await node_fs_1.promises.mkdir(agentsDir, { recursive: true, mode: 0o700 });
    const target = endpointFilePath(agentsDir);
    const temp = `${target}.tmp-${(0, node_crypto_1.randomUUID)()}`;
    await node_fs_1.promises.writeFile(temp, renderEndpointFile(endpoint), { encoding: 'utf8', mode: 0o600 });
    await node_fs_1.promises.rename(temp, target);
}
async function readAgentHookEndpointFile(agentsDir) {
    let raw;
    try {
        raw = await node_fs_1.promises.readFile(endpointFilePath(agentsDir), 'utf8');
    }
    catch {
        return null;
    }
    const values = new Map();
    for (const line of raw.split('\n')) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match)
            values.set(match[1], match[2]);
    }
    const port = Number(values.get('METABOT_AGENT_HOOK_PORT'));
    const token = values.get('METABOT_AGENT_HOOK_TOKEN') ?? '';
    if (!Number.isInteger(port) || port <= 0 || !token)
        return null;
    return { port, token, version: values.get('METABOT_AGENT_HOOK_VERSION') || exports.AGENT_HOOK_PROTOCOL_VERSION };
}
/**
 * Replay spooled hook records written while the daemon was down. Only
 * newline-terminated records are read (a torn trailing line belongs to a
 * still-writing hook); the file is truncated in place so concurrent appenders
 * keep their inode.
 */
async function drainAgentHookSpool(dir, ingest, now = Date.now) {
    let files;
    try {
        files = await node_fs_1.promises.readdir(dir);
    }
    catch {
        return 0;
    }
    let ingested = 0;
    for (const name of files) {
        if (!name.endsWith('.jsonl'))
            continue;
        const file = node_path_1.default.join(dir, name);
        let raw;
        try {
            raw = await node_fs_1.promises.readFile(file, 'utf8');
        }
        catch {
            continue;
        }
        const lastNewline = raw.lastIndexOf('\n');
        if (lastNewline === -1)
            continue;
        const complete = raw.slice(0, lastNewline + 1);
        const remainder = raw.slice(lastNewline + 1);
        let changed = false;
        for (const line of complete.split('\n')) {
            if (!line.trim())
                continue;
            try {
                const record = JSON.parse(line);
                const source = typeof record.source === 'string' ? record.source : '';
                const receivedAt = Number(record.receivedAt);
                // Spool writers embed the hook payload either as a raw JSON object or
                // as an escaped string (older script form) — accept both.
                const payload = typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload;
                if (!source || !payload || !Number.isFinite(receivedAt) || now() - receivedAt > exports.AGENT_HOOK_SPOOL_MAX_AGE_MS) {
                    continue;
                }
                ingest({ source, payload, receivedAt });
                ingested += 1;
                changed = true;
            }
            catch {
                // Skip unparseable lines.
            }
        }
        if (changed) {
            const handle = await node_fs_1.promises.open(file, 'r+').catch(() => null);
            if (handle) {
                try {
                    await handle.writeFile(remainder, 'utf8');
                    await handle.truncate(remainder.length);
                }
                finally {
                    await handle.close();
                }
            }
        }
    }
    return ingested;
}
