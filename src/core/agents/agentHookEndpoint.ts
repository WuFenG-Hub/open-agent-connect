/**
 * Endpoint publication for managed agent hooks. Hook scripts are installed
 * into third-party CLIs and outlive daemon restarts, so they re-discover the
 * daemon on every invocation by sourcing this endpoint file instead of
 * holding a baked-in port. The token rotates per daemon boot; the file is
 * written atomically with tight permissions, and values are restricted to a
 * safe charset so the file can never smuggle shell syntax when sourced.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentStatusEvent } from './agentStatusTypes';

export const AGENT_HOOK_PROTOCOL_VERSION = '1';
export const AGENT_HOOK_ENDPOINT_FILENAME = 'hook-endpoint.env';
export const AGENT_HOOK_SPOOL_DIRNAME = 'spool';
export const AGENT_HOOK_SPOOL_MAX_BYTES = 5 * 1024 * 1024;
export const AGENT_HOOK_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SAFE_VALUE = /^[A-Za-z0-9._:/-]+$/;

export interface AgentHookEndpoint {
  port: number;
  token: string;
  version: string;
}

export function endpointFilePath(agentsDir: string): string {
  return path.join(agentsDir, AGENT_HOOK_ENDPOINT_FILENAME);
}

export function spoolDirPath(agentsDir: string): string {
  return path.join(agentsDir, AGENT_HOOK_SPOOL_DIRNAME);
}

export function newAgentHookToken(): string {
  return randomUUID();
}

export function renderEndpointFile(endpoint: AgentHookEndpoint): string {
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
export async function writeAgentHookEndpointFile(agentsDir: string, endpoint: AgentHookEndpoint): Promise<void> {
  await fs.mkdir(agentsDir, { recursive: true, mode: 0o700 });
  const target = endpointFilePath(agentsDir);
  const temp = `${target}.tmp-${randomUUID()}`;
  await fs.writeFile(temp, renderEndpointFile(endpoint), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, target);
}

export async function readAgentHookEndpointFile(agentsDir: string): Promise<AgentHookEndpoint | null> {
  let raw: string;
  try {
    raw = await fs.readFile(endpointFilePath(agentsDir), 'utf8');
  } catch {
    return null;
  }
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2]);
  }
  const port = Number(values.get('METABOT_AGENT_HOOK_PORT'));
  const token = values.get('METABOT_AGENT_HOOK_TOKEN') ?? '';
  if (!Number.isInteger(port) || port <= 0 || !token) return null;
  return { port, token, version: values.get('METABOT_AGENT_HOOK_VERSION') || AGENT_HOOK_PROTOCOL_VERSION };
}

/**
 * Replay spooled hook records written while the daemon was down. Only
 * newline-terminated records are read (a torn trailing line belongs to a
 * still-writing hook); the file is truncated in place so concurrent appenders
 * keep their inode.
 */
export async function drainAgentHookSpool(
  dir: string,
  ingest: (record: { source: string; payload: unknown; receivedAt: number }) => void,
  now: () => number = Date.now,
): Promise<number> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let ingested = 0;
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lastNewline = raw.lastIndexOf('\n');
    if (lastNewline === -1) continue;
    const complete = raw.slice(0, lastNewline + 1);
    const remainder = raw.slice(lastNewline + 1);
    let changed = false;
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { source?: unknown; payload?: unknown; receivedAt?: unknown };
        const source = typeof record.source === 'string' ? record.source : '';
        const receivedAt = Number(record.receivedAt);
        // Spool writers embed the hook payload either as a raw JSON object or
        // as an escaped string (older script form) — accept both.
        const payload = typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload;
        if (!source || !payload || !Number.isFinite(receivedAt) || now() - receivedAt > AGENT_HOOK_SPOOL_MAX_AGE_MS) {
          continue;
        }
        ingest({ source, payload, receivedAt });
        ingested += 1;
        changed = true;
      } catch {
        // Skip unparseable lines.
      }
    }
    if (changed) {
      const handle = await fs.open(file, 'r+').catch(() => null);
      if (handle) {
        try {
          await handle.writeFile(remainder, 'utf8');
          await handle.truncate(remainder.length);
        } finally {
          await handle.close();
        }
      }
    }
  }
  return ingested;
}
