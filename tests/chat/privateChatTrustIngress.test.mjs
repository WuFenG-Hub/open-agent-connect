import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { resolveMetabotPaths } = require('../../dist/core/state/paths.js');
const { createPrivateChatStateStore } = require('../../dist/core/chat/privateChatStateStore.js');
const { createChatStrategyStore } = require('../../dist/core/chat/chatStrategyStore.js');
const { createPrivateChatAutoReplyOrchestrator } = require('../../dist/core/chat/privateChatAutoReply.js');
const { createPrivateChatWakeStore } = require('../../dist/core/chat/privateChatWake.js');
const { createPrivateChatAllowedSkillsResolver } = require('../../dist/core/chat/privateChatAllowedSkills.js');
const { createMetabotProfile, updateMetabotProfile } = require('../../dist/core/bot/metabotProfileManager.js');
const { createLlmBindingStore } = require('../../dist/core/llm/llmBindingStore.js');
const { createLlmRuntimeStore } = require('../../dist/core/llm/llmRuntimeStore.js');

async function createTempProfileHome() {
  const base = await mkdtempTempRoot('metabot-trust-ingress-');
  const profileRoot = path.join(base, '.metabot', 'profiles', 'test-slug');
  await fs.mkdir(profileRoot, { recursive: true });
  return { base, profileRoot };
}

function createIdentityPair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKeyHex: ecdh.getPrivateKey('hex'),
    publicKeyHex: ecdh.getPublicKey('hex', 'uncompressed'),
  };
}

function evaluation(overrides = {}) {
  return {
    tier: 'stranger',
    acceptBehavior: 'auto',
    allowedClasses: ['C0'],
    allowedSkills: [],
    ...overrides,
  };
}

async function createIngressHarness(options = {}) {
  const { profileRoot } = await createTempProfileHome();
  const paths = resolveMetabotPaths(profileRoot);
  const localKeys = createIdentityPair();
  const peerKeys = createIdentityPair();
  const localGlobalMetaId = 'idq1localbot0000000000000000000000000';
  const peerGlobalMetaId = 'idq1peerbot00000000000000000000000000';
  const writes = [];
  const runnerInputs = [];
  const sendFailureEvents = [];
  const policyCalls = [];
  const nowFn = () => options.now ?? 1_770_000_000_000;
  const stateStore = createPrivateChatStateStore(paths);

  const orchestrator = createPrivateChatAutoReplyOrchestrator({
    stateStore,
    strategyStore: createChatStrategyStore(paths),
    paths,
    signer: {
      async getIdentity() {
        throw new Error('not used');
      },
      async getPrivateChatIdentity() {
        return {
          globalMetaId: localGlobalMetaId,
          chatPublicKey: localKeys.publicKeyHex,
          privateKeyHex: localKeys.privateKeyHex,
        };
      },
      async writePin(input) {
        writes.push(input);
        return {
          txids: ['reply-tx-1'],
          pinId: `reply-pin-${writes.length}`,
          totalCost: 0,
          network: 'mvc',
          operation: 'create',
          path: input.path,
          contentType: input.contentType,
          encoding: 'utf-8',
          globalMetaId: localGlobalMetaId,
          mvcAddress: 'mvc-local',
        };
      },
    },
    selfGlobalMetaId: async () => localGlobalMetaId,
    resolvePeerChatPublicKey: async () => peerKeys.publicKeyHex,
    logSendFailure: (event) => sendFailureEvents.push(event),
    replyRunner: async (input) => {
      runnerInputs.push(input);
      return options.replyResult ?? { state: 'reply', content: 'reply from LLM' };
    },
    evaluatePeerTrustPolicy: options.evaluatePeerTrustPolicy
      ? async (peer) => {
        policyCalls.push(peer);
        const result = options.evaluatePeerTrustPolicy(peer);
        if (result instanceof Promise) return result;
        if (result && typeof result.then === 'function') return result;
        return result;
      }
      : undefined,
    now: nowFn,
  }, {
    enabled: true,
    acceptPolicy: 'accept_all',
    defaultStrategyId: null,
  });

  return {
    orchestrator,
    paths,
    peerGlobalMetaId,
    writes,
    runnerInputs,
    sendFailureEvents,
    policyCalls,
    stateStore,
    async handleInbound(overrides2 = {}) {
      return orchestrator.handleInboundMessage({
        fromGlobalMetaId: peerGlobalMetaId,
        content: 'hello local bot',
        messagePinId: `incoming-pin-${policyCalls.length + 1}`,
        fromChatPublicKey: peerKeys.publicKeyHex,
        timestamp: nowFn(),
        rawMessage: null,
        ...overrides2,
      });
    },
  };
}

test('stranger: auto reply with an EMPTY skill filter (plain chat, no skills)', async () => {
  const h = await createIngressHarness({
    evaluatePeerTrustPolicy: () => evaluation({ tier: 'stranger', allowedSkills: [] }),
  });
  await h.handleInbound();

  assert.equal(h.runnerInputs.length, 1, 'the auto-reply turn runs');
  assert.deepEqual(h.runnerInputs[0].trustPolicyAllowedSkills, [], 'strangers get no skills — the P4a behavior change');
  assert.equal(h.writes.length, 1, 'the chat reply is delivered');
  assert.equal(h.policyCalls.length, 1);
});

test('team peer: reply carries the class-filtered skill list to the runner', async () => {
  const h = await createIngressHarness({
    evaluatePeerTrustPolicy: () => evaluation({
      tier: 'team',
      allowedClasses: ['C0', 'C1', 'C2', 'C3'],
      allowedSkills: ['metabot-memory', 'metabot-browser'],
    }),
  });
  await h.handleInbound();

  assert.deepEqual(h.runnerInputs[0].trustPolicyAllowedSkills, ['metabot-memory', 'metabot-browser']);
  assert.equal(h.writes.length, 1);
});

test('queue: message persisted, conversation paused, pending guidance set, no reply', async () => {
  const h = await createIngressHarness({
    evaluatePeerTrustPolicy: () => evaluation({ tier: 'stranger', acceptBehavior: 'queue' }),
  });
  await h.handleInbound();

  assert.equal(h.runnerInputs.length, 0, 'no auto-reply turn');
  assert.equal(h.writes.length, 0, 'nothing is sent to the peer');
  const conversation = await h.stateStore.getConversationByPeer(h.peerGlobalMetaId);
  assert.equal(conversation.state, 'paused');
  assert.match(conversation.pendingGuidanceText, /Queued by trust policy/);
  assert.match(conversation.pendingGuidanceText, new RegExp(h.peerGlobalMetaId));
  // The inbound itself is persisted.
  const messages = await h.stateStore.getRecentMessages(conversation.conversationId, 10);
  assert.equal(messages.filter((m) => m.direction === 'inbound').length, 1);
});

test('ignore (blocked): no reply, no runner turn, no wake armed for the message', async () => {
  const h = await createIngressHarness({
    evaluatePeerTrustPolicy: () => evaluation({ tier: 'blocked', acceptBehavior: 'ignore', allowedClasses: [], allowedSkills: [] }),
  });
  await h.handleInbound();

  assert.equal(h.runnerInputs.length, 0);
  assert.equal(h.writes.length, 0);
  const wakeStore = createPrivateChatWakeStore(h.paths);
  assert.deepEqual(await wakeStore.readWakes(), [], 'no silent-tail wake can be scheduled');
  const conversation = await h.stateStore.getConversationByPeer(h.peerGlobalMetaId);
  assert.notEqual(conversation.state, 'paused');
});

test('policy evaluator failure: fails safe as stranger (reply continues, no skills), loop survives', async () => {
  const h = await createIngressHarness({
    evaluatePeerTrustPolicy: async () => {
      throw new Error('chain indexer unreachable');
    },
  });
  await h.handleInbound();
  await h.handleInbound({ messagePinId: 'incoming-pin-second', content: 'are you there?' });

  assert.equal(h.runnerInputs.length, 2, 'both turns still ran — the orchestrator loop survives');
  for (const input of h.runnerInputs) {
    assert.deepEqual(input.trustPolicyAllowedSkills, [], 'fail-safe grants no skills');
  }
  assert.equal(h.writes.length, 2);
  assert.equal(h.sendFailureEvents.length, 2);
  for (const event of h.sendFailureEvents) {
    assert.equal(event.kind, 'trust_policy_failed');
    assert.match(event.error, /chain indexer unreachable/);
  }
});

test('policy gate absent (legacy wiring): full allowChatSkills scope, behavior unchanged', async () => {
  const h = await createIngressHarness();
  await h.handleInbound();

  assert.equal(h.runnerInputs.length, 1);
  assert.equal(h.runnerInputs[0].trustPolicyAllowedSkills, null, 'null = unfiltered legacy scope');
  assert.equal(h.writes.length, 1);
});

test('allowed-skills resolver intersects its scope with the policy filter', async (t) => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-skills-');
  t.after(async () => {
    await fs.rm(systemHomeDir, { recursive: true, force: true });
  });
  const profile = await createMetabotProfile(systemHomeDir, { name: 'Policy Bot' });
  const paths = resolveMetabotPaths(profile.homeDir);
  await updateMetabotProfile(systemHomeDir, profile.slug, {
    allowChatSkills: ['metabot-weather', 'metabot-missing'],
  });
  const skillsRoot = path.join(systemHomeDir, '.codex', 'skills');
  await fs.mkdir(path.join(skillsRoot, 'metabot-weather'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, 'metabot-weather', 'SKILL.md'), '# weather\n', 'utf8');

  const runtimeStore = createLlmRuntimeStore(paths);
  const bindingStore = createLlmBindingStore(paths);
  const now = '2026-05-07T00:00:00.000Z';
  await runtimeStore.write({
    version: 1,
    runtimes: [{
      id: 'runtime-codex',
      provider: 'codex',
      displayName: 'codex runtime',
      binaryPath: '/bin/codex',
      version: '1.0.0',
      authState: 'authenticated',
      health: 'healthy',
      capabilities: ['tool-use'],
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    }],
  });
  await bindingStore.write({
    version: 1,
    bindings: [{
      id: 'binding-codex-primary',
      metaBotSlug: profile.slug,
      llmRuntimeId: 'runtime-codex',
      role: 'primary',
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }],
  });

  const resolver = createPrivateChatAllowedSkillsResolver({
    paths,
    metaBotSlug: profile.slug,
    runtimeStore,
    bindingStore,
    env: {},
  });

  // No filter: legacy full scope.
  const unfiltered = await resolver();
  assert.deepEqual(unfiltered.skills, ['metabot-weather']);

  // Team-tier filter keeps the installed skill.
  const teamFiltered = await resolver(['metabot-weather', 'metabot-browser']);
  assert.deepEqual(teamFiltered.skills, ['metabot-weather']);
  assert.deepEqual(Object.keys(teamFiltered.skillSourcePaths), ['metabot-weather']);
  assert.equal(teamFiltered.skillDetails.length, 1);

  // Stranger filter (empty list): plain chat, no skills at all.
  const strangerFiltered = await resolver([]);
  assert.deepEqual(strangerFiltered.skills, []);
  assert.deepEqual(strangerFiltered.skillDetails, []);
  assert.deepEqual(Object.keys(strangerFiltered.skillSourcePaths), []);

  // Filter naming a skill that is NOT installed resolves to nothing.
  const missingFiltered = await resolver(['metabot-missing']);
  assert.deepEqual(missingFiltered.skills, []);
});
