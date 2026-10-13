import assert from 'node:assert/strict';
import { mkdirSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { mkdtempTempRootSync } from '../helpers/tempRoots.mjs';

// Group-task turns for a Grok Bot-bound profile ride the llm-task webhook
// channel. The daemon's runLlmTurn (src/cli/runtime.ts) is inline, so this file
// composes the same two tiers around the real engine and the real channel:
// webhook completion first, then the "no healthy runtime" failure.

const require = createRequire(import.meta.url);
const { createGroupTaskEngine, GROUP_TASK_CHAIR_FAILURE_SINCE_KV_PREFIX, GROUP_TASK_PLANNED_KV_PREFIX }
  = require('../../dist/core/grouptask/engine.js');
const { createGroupTaskStore } = require('../../dist/core/grouptask/store.js');
const { resolveMetabotPaths } = require('../../dist/core/state/paths.js');
const { decryptGroupContent } = require('../../dist/core/appSession/groupChat.js');
const { createGrokBotWebhookCompletion } = require('../../dist/core/host/grokBotLlmChannel.js');
const {
  grokBotBindingPathForProfile,
  normalizeGrokBotBinding,
  readGrokBotBinding,
  writeGrokBotBinding,
} = require('../../dist/core/host/grokBotBinding.js');

function pinPlaintext(pin) {
  try {
    const payload = JSON.parse(pin.payload);
    return decryptGroupContent(String(payload.content ?? ''), String(payload.groupId ?? ''));
  } catch {
    return '';
  }
}

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

const LLM_DOWN = 'No healthy LLM runtime is available for MetaBot twin-bot.';

function createHarness(prefix, { engineNow } = {}) {
  const systemHome = mkdtempTempRootSync(prefix);
  const pins = [];
  let pinSeq = 0;

  const makeProfile = (slug, botType, gmid) => {
    const homeDir = path.join(systemHome, '.metabot', 'profiles', slug);
    mkdirSync(homeDir, { recursive: true });
    return {
      slug,
      homeDir,
      name: slug.replace(/-/gu, ' '),
      globalMetaId: gmid,
      metaId: `meta-${slug}`,
      botType,
      avatar: null,
    };
  };
  const profiles = [
    makeProfile('twin-bot', 'twin', 'IDTWIN'),
    makeProfile('worker-1', 'worker', 'IDWORKER1'),
  ];

  const bindChairWebhook = async () => {
    await writeGrokBotBinding(grokBotBindingPathForProfile(profiles[0].homeDir), {
      ...normalizeGrokBotBinding(null),
      assistantId: 'asst-chair',
      assistantName: 'Twin Bot',
      boundAt: '2026-10-10T01:02:03.000Z',
      webhook: { url: 'https://grok.example.com/routine/chair', secret: 'tok-chair', configuredAt: '2026-10-10T01:02:03.000Z' },
    });
  };

  const makeSigner = (label) => ({
    async writePin(request) {
      pinSeq += 1;
      const pinId = `pin-${label}-${pinSeq}`;
      pins.push({ label, pinId, ...request });
      return { pinId, txId: `tx-${pinSeq}` };
    },
  });

  const history = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes('/group-chat-list-by-index')) {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get('startIndex'));
      const size = Number(parsed.searchParams.get('size'));
      const slice = history.filter((item) => item.index >= start).slice(0, size);
      return jsonResponse({ code: 0, data: { list: slice } });
    }
    if (url.includes('/group-info')) {
      return jsonResponse({ code: 0, data: { groupId: new URL(url).searchParams.get('groupId') } });
    }
    if (url.includes('/group-member-list')) {
      return jsonResponse({ code: 0, data: { list: [] } });
    }
    throw new Error(`Unexpected fake indexer URL: ${url}`);
  };

  const stores = new Map();
  const storeForProfile = (profile) => {
    let store = stores.get(profile.slug);
    if (!store) {
      store = createGroupTaskStore(resolveMetabotPaths(profile.homeDir));
      stores.set(profile.slug, store);
    }
    return store;
  };

  // Mirrors the daemon's runLlmTurn tiering for a profile with no local
  // runtime: Grok Bot webhook first, then the "no healthy runtime" failure.
  const webhookPosts = [];
  let grokTimeoutMs = 2_000;
  let webhookBehavior = () => ({ status: 200, output: 'unscripted' });
  const llmCalls = [];
  const runLlmTurn = async (turn) => {
    llmCalls.push(turn);
    const text = await createGrokBotWebhookCompletion({
      homeDir: turn.profile.homeDir,
      timeoutMs: grokTimeoutMs,
      pollIntervalMs: 5,
      retryDelayMs: 1,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        webhookPosts.push({ url, init, body });
        const behavior = webhookBehavior(body);
        if (behavior.output !== undefined) {
          await fsp.mkdir(path.dirname(body.responsePath), { recursive: true });
          await fsp.writeFile(body.responsePath, JSON.stringify({
            taskId: body.taskId, status: 'ok', output: behavior.output,
          }), 'utf8');
        }
        return new Response('{}', { status: behavior.status });
      },
    })({
      botSlug: turn.profile.slug,
      system: turn.systemPrompt,
      user: turn.prompt,
      ...(turn.role === 'chair' ? { maxTokens: 8192 } : {}),
    });
    if (text !== null) return text;
    throw new Error(LLM_DOWN);
  };

  const ctx = {
    listProfiles: async () => profiles,
    getProfile: async (slug) => profiles.find((profile) => profile.slug === slug) ?? null,
    signerForSlug: async (slug) => makeSigner(slug),
    ownerIdentity: async () => ({
      globalMetaId: 'IDOWNER', metaId: 'meta-owner', name: 'Owner', signer: makeSigner('owner'),
    }),
    storeForProfile,
    transport: { indexerHosts: ['https://fake-indexer.test'], fetchImpl },
  };

  const engine = createGroupTaskEngine({
    ctx,
    runLlmTurn,
    loadPersona: async () => ({}),
    workerCooldownMs: 0,
    chairCooldownMs: 0,
    workerSessions: false,
    ...(engineNow ? { now: engineNow } : {}),
  });

  let historyIndex = 0;
  const pushHistory = (gmid, content, opts = {}) => {
    const index = historyIndex;
    historyIndex += 1;
    history.push({
      index,
      txId: `tx-h${index}`,
      pinId: `hpin-${index}`,
      groupId: opts.groupId ?? 'grp-engine',
      globalMetaId: gmid,
      metaId: `meta-h${index}`,
      content,
      contentType: 'text/plain',
      encryption: '0',
      timestamp: Math.floor(Date.now() / 1000) - 600 + index,
      userInfo: { name: gmid.toLowerCase() },
      ...(opts.mention ? { mention: opts.mention } : {}),
    });
    return index;
  };

  const chairStore = storeForProfile(profiles[0]);
  const seedTask = async (status = 'planning') => {
    const task = await chairStore.createTask({
      groupId: 'grp-engine',
      title: 'Chair outage test task',
      goal: 'Survive the outage',
      acceptanceCriteria: 'No silent wedges',
      chairSlug: 'twin-bot',
      chairGlobalMetaId: 'IDTWIN',
      createdBy: 'user',
      sourceSessionId: 'session-outage-origin',
    });
    await chairStore.addMember({ taskId: task.id, slug: 'twin-bot', globalMetaId: 'IDTWIN', role: 'chair' });
    await chairStore.addMember({ taskId: task.id, slug: 'worker-1', globalMetaId: 'IDWORKER1', role: 'worker' });
    if (status !== 'planning') {
      await chairStore.updateTaskStatus(task.id, status);
      await chairStore.kvSet(`${GROUP_TASK_PLANNED_KV_PREFIX}${task.id}`, '1');
    }
    return (await chairStore.getTaskById(task.id));
  };

  return { ctx, engine, pins, llmCalls, webhookPosts, setWebhook: (fn) => { webhookBehavior = fn; }, setTimeoutMs: (ms) => { grokTimeoutMs = ms; }, pushHistory, chairStore, seedTask, profiles, bindChairWebhook };
}


test('a Grok Bot-bound chair answers a group message through the llm-task webhook', async () => {
  const h = createHarness('metabot-gt-grok-turn-');
  await h.bindChairWebhook();
  const task = await h.seedTask('executing');
  h.pushHistory('IDOWNER', 'status update from the owner');
  h.setWebhook(() => ({ status: 200, output: 'noted, owner — the chair is on it' }));

  await h.engine.tick();

  assert.equal(h.webhookPosts.length, 1, 'exactly one webhook task for the chair turn');
  const post = h.webhookPosts[0];
  assert.equal(post.body.type, 'llm-task');
  assert.equal(post.body.host, 'grok-bot');
  assert.equal(post.body.slug, 'twin-bot');
  assert.ok(post.body.system.length > 0 && post.body.prompt.includes('status update from the owner'));
  assert.equal(post.init.headers.authorization, 'Bearer tok-chair');

  const updated = await h.chairStore.getTaskById(task.id);
  assert.equal(updated.lastProcessedIndex, 0, 'cursor advanced past the answered message');
  const chairPins = h.pins.filter((pin) => pin.label === 'twin-bot');
  assert.equal(chairPins.length, 1);
  assert.match(pinPlaintext(chairPins[0]), /the chair is on it/);

  // The webhook secret never reaches the group transcript or the binding ledger.
  assert.ok(!h.pins.some((pin) => pin.payload.includes('tok-chair')));
  const binding = await readGrokBotBinding(grokBotBindingPathForProfile(h.profiles[0].homeDir));
  assert.equal(binding.lastWebhookDelivery.kind, 'llm-task');
  assert.equal(binding.lastWebhookDelivery.status, 'ok');
});

test('a rejected webhook falls through to the runtime-unavailable path and defers instead of posting', async () => {
  const h = createHarness('metabot-gt-grok-turn-down-');
  await h.bindChairWebhook();
  const task = await h.seedTask('executing');
  h.pushHistory('IDOWNER', 'status update from the owner');
  h.setWebhook(() => ({ status: 503 }));

  await h.engine.tick();

  const updated = await h.chairStore.getTaskById(task.id);
  assert.equal(updated.lastProcessedIndex, -1, 'cursor stays on the message');
  assert.ok(await h.chairStore.kvGet(`${GROUP_TASK_CHAIR_FAILURE_SINCE_KV_PREFIX}${task.id}`), 'outage clock armed');
  assert.equal(h.pins.filter((pin) => pin.label === 'twin-bot').length, 0, 'nothing posted');
});

test('a webhook that is accepted but never answered times out and defers without posting', async () => {
  const h = createHarness('metabot-gt-grok-turn-timeout-');
  await h.bindChairWebhook();
  const task = await h.seedTask('executing');
  h.pushHistory('IDOWNER', 'status update from the owner');
  h.setTimeoutMs(60);
  h.setWebhook(() => ({ status: 200 })); // POST accepted, no response file ever written

  await h.engine.tick();

  assert.equal(h.webhookPosts.length, 1, 'one task posted, no resend inside the turn');
  const updated = await h.chairStore.getTaskById(task.id);
  assert.equal(updated.lastProcessedIndex, -1, 'cursor stays on the message');
  assert.ok(await h.chairStore.kvGet(`${GROUP_TASK_CHAIR_FAILURE_SINCE_KV_PREFIX}${task.id}`), 'outage clock armed');
  assert.equal(h.pins.filter((pin) => pin.label === 'twin-bot').length, 0, 'nothing posted');
  const leftovers = await fsp.readdir(resolveMetabotPaths(h.profiles[0].homeDir).grokBotLlmTasksRoot).catch(() => []);
  assert.deepEqual(leftovers, [], 'task files cleaned up after the timeout');
});

test('a chair without a Grok Bot webhook never posts to one', async () => {
  const h = createHarness('metabot-gt-grok-turn-unbound-');
  const task = await h.seedTask('executing');
  h.pushHistory('IDOWNER', 'status update from the owner');

  await h.engine.tick();

  assert.equal(h.webhookPosts.length, 0);
  const updated = await h.chairStore.getTaskById(task.id);
  assert.equal(updated.lastProcessedIndex, -1);
});
