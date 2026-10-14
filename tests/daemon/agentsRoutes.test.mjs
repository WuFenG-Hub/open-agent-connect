import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createHttpServer } = require('../../dist/daemon/httpServer.js');
const { createAgentStatusStore } = require('../../dist/core/agents/agentStatusStore.js');

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

function requestRaw(baseUrl, path, options = {}) {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
    }, resolve);
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function withServer(handlers, run) {
  const server = createHttpServer(handlers);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function claudeHookPayload(overrides = {}) {
  return {
    session_id: 'route-sess-1',
    cwd: '/tmp/project',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'route test',
    ...overrides,
  };
}

test('agents hook route rejects bad tokens and accepts form and JSON payloads', async () => {
  const store = createAgentStatusStore();
  await withServer({ agents: { store, token: 'token-1', agentsDir: '/tmp/metabot-agents-unused' } }, async (baseUrl) => {
    const formBody = `payload=${encodeURIComponent(JSON.stringify(claudeHookPayload()))}`;
    const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-metabot-agent-hook-token': 'wrong' };
    const forbidden = await requestRaw(baseUrl, '/api/agents/hooks/claude-code', { method: 'POST', headers, body: formBody });
    assert.equal(forbidden.statusCode, 403);
    assert.deepEqual(JSON.parse(await readBody(forbidden)).state === 'failed', true);

    const accepted = await requestRaw(baseUrl, '/api/agents/hooks/claude-code', {
      method: 'POST',
      headers: { ...headers, 'x-metabot-agent-hook-token': 'token-1' },
      body: formBody,
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(JSON.parse(await readBody(accepted)).data.accepted, true);

    const asJson = await requestRaw(baseUrl, '/api/agents/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-metabot-agent-hook-token': 'token-1' },
      body: JSON.stringify(claudeHookPayload({ hook_event_name: 'Stop' })),
    });
    assert.equal(JSON.parse(await readBody(asJson)).data.accepted, true);

    // Garbage payloads must not 500 the hook fire-and-forget path.
    const garbage = await requestRaw(baseUrl, '/api/agents/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-metabot-agent-hook-token': 'token-1' },
      body: 'not-json',
    });
    assert.equal(garbage.statusCode, 200);
    assert.equal(JSON.parse(await readBody(garbage)).data.accepted, false);

    const status = await requestRaw(baseUrl, '/api/agents/status');
    const payload = JSON.parse(await readBody(status));
    assert.equal(payload.state, 'success');
    assert.equal(payload.data.agents.length, 1);
    assert.equal(payload.data.agents[0].state, 'done');
    assert.equal(payload.data.agents[0].lastHookEvent, 'Stop');
  });
});

test('agents status route answers empty when the pipeline is not configured', async () => {
  await withServer({}, async (baseUrl) => {
    const status = await requestRaw(baseUrl, '/api/agents/status');
    assert.equal(status.statusCode, 200);
    const payload = JSON.parse(await readBody(status));
    assert.deepEqual(payload.data.agents, []);
  });
});

test('agents status SSE stream carries ingest transitions', async () => {
  const store = createAgentStatusStore();
  await withServer({ agents: { store, token: 'token-1', agentsDir: '/tmp/metabot-agents-unused' } }, async (baseUrl) => {
    const stream = await requestRaw(baseUrl, '/api/agents/status/events');
    assert.equal(stream.statusCode, 200);
    assert.match(stream.headers['content-type'], /text\/event-stream/);

    const frames = [];
    let frameResolve;
    let framePromise = new Promise((resolve) => {
      frameResolve = resolve;
    });
    stream.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          frames.push(JSON.parse(line.slice('data: '.length)));
          frameResolve();
          framePromise = new Promise((resolve) => {
            frameResolve = resolve;
          });
        }
      }
    });
    // Drain the initial retry frame pacing, then push a transition.
    await new Promise((resolve) => setTimeout(resolve, 50));
    store.ingest({
      provider: 'claude-code',
      sessionId: 'sse-sess-1',
      state: 'working',
      cwd: '',
      transcriptPath: '',
      prompt: '',
      toolName: '',
      sessionBoundary: false,
      hookEventName: 'UserPromptSubmit',
      observedAt: Date.now(),
    });
    await Promise.race([framePromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    stream.destroy();
    assert.equal(frames.length >= 1, true);
    assert.equal(frames[0].record.state, 'working');
    assert.equal(frames[0].event.hookEventName, 'UserPromptSubmit');
  });
});
