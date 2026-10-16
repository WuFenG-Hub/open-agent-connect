import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const {
  DEFAULT_ACCEPT_BEHAVIOR,
  evaluatePeerPolicy,
  normalizeChatTrustPolicy,
} = require('../../dist/core/trust/trustPolicy.js');

const PEER = 'idq1policypeer000000000000000000000000';

const ALLOW_SKILLS = [
  'metabot-help',        // C0
  'metabot-metaweb',     // C1
  'metabot-memory',      // C2
  'metabot-browser',     // C3
  'metabot-wallet-manage', // C4
  'custom-unknown-skill',  // unknown -> C3
];

function tierResolverFor(tier) {
  return { resolvePeerTrustTier: async () => tier, invalidate: () => {} };
}

function evaluate(tier, context, profile = {}) {
  return evaluatePeerPolicy({
    peerGlobalMetaId: PEER,
    profile: { allowChatSkills: ALLOW_SKILLS, ...profile },
    context,
    systemHomeDir: '/unused-with-injected-resolver',
    tierResolver: tierResolverFor(tier),
  });
}

test('chat: strangers get C0 only — plain chat, no skill execution', async () => {
  const result = await evaluate('stranger', 'chat');
  assert.equal(result.tier, 'stranger');
  assert.equal(result.acceptBehavior, 'auto');
  assert.deepEqual(result.allowedClasses, ['C0']);
  assert.deepEqual(result.allowedSkills, ['metabot-help']);
});

test('chat: contact gets C0; team gets C0-C3; trusted gets C0-C2; C4 is never allowed', async () => {
  const contact = await evaluate('contact', 'chat');
  assert.deepEqual(contact.allowedClasses, ['C0']);
  assert.deepEqual(contact.allowedSkills, ['metabot-help']);

  const team = await evaluate('team', 'chat');
  assert.deepEqual(team.allowedClasses, ['C0', 'C1', 'C2', 'C3']);
  assert.deepEqual(team.allowedSkills, [
    'metabot-help', 'metabot-metaweb', 'metabot-memory', 'metabot-browser', 'custom-unknown-skill',
  ], 'team may use every non-admin skill (unknown skills are C3); wallet-manage (C4) stays excluded');
  assert.ok(!team.allowedSkills.includes('metabot-wallet-manage'));
  assert.ok(!team.allowedClasses.includes('C4'));

  const trusted = await evaluate('trusted', 'chat');
  assert.deepEqual(trusted.allowedClasses, ['C0', 'C1', 'C2']);
  assert.deepEqual(trusted.allowedSkills, ['metabot-help', 'metabot-metaweb', 'metabot-memory']);
});

test('grouptask: contact unlocks C2 (group-task context only)', async () => {
  const result = await evaluate('contact', 'grouptask');
  assert.equal(result.acceptBehavior, 'auto');
  assert.deepEqual(result.allowedClasses, ['C0', 'C2']);
  assert.deepEqual(result.allowedSkills, ['metabot-help', 'metabot-memory']);
});

test('blocked: no classes, no skills; chat ignores, invite/grouptask decline', async () => {
  const chat = await evaluate('blocked', 'chat');
  assert.deepEqual(chat.allowedClasses, []);
  assert.deepEqual(chat.allowedSkills, []);
  assert.equal(chat.acceptBehavior, 'ignore');

  const invite = await evaluate('blocked', 'invite');
  assert.equal(invite.acceptBehavior, 'decline');
  const grouptask = await evaluate('blocked', 'grouptask');
  assert.equal(grouptask.acceptBehavior, 'decline');
});

test('invite: strangers queue as pending; everyone else auto', async () => {
  assert.equal((await evaluate('stranger', 'invite')).acceptBehavior, 'queue');
  for (const tier of ['local', 'team', 'trusted', 'contact']) {
    assert.equal((await evaluate(tier, 'invite')).acceptBehavior, 'auto', `${tier} invite auto-accepts`);
  }
  assert.equal((await evaluate('stranger', 'grouptask')).acceptBehavior, 'queue');
});

test('skillClassOverrides re-classify individual skills', async () => {
  const relaxed = await evaluate('trusted', 'chat', {
    skillClassOverrides: { 'metabot-browser': 'C2', 'metabot-wallet-manage': 'C2' },
  });
  assert.deepEqual(relaxed.allowedSkills, [
    'metabot-help', 'metabot-metaweb', 'metabot-memory', 'metabot-browser', 'metabot-wallet-manage',
  ]);

  const tightened = await evaluate('team', 'chat', {
    skillClassOverrides: { 'metabot-browser': 'C4', 'metabot-memory': 'C4' },
  });
  assert.deepEqual(tightened.allowedSkills, ['metabot-help', 'metabot-metaweb', 'custom-unknown-skill'], 'overrides can also restrict');
});

test('chatTrustPolicy overrides per-context/per-tier accept behavior', async () => {
  const result = await evaluate('stranger', 'chat', {
    chatTrustPolicy: { chat: { stranger: 'queue' } },
  });
  assert.equal(result.acceptBehavior, 'queue', 'chat override applied');
  assert.equal((await evaluate('stranger', 'invite', {
    chatTrustPolicy: { chat: { stranger: 'queue' } },
  })).acceptBehavior, 'queue', 'invite keeps its own default (spec default)');
  assert.equal((await evaluate('stranger', 'invite', {
    chatTrustPolicy: { invite: { stranger: 'decline' } },
  })).acceptBehavior, 'decline');
});

test('normalizeChatTrustPolicy drops unknown tiers and behaviors', () => {
  assert.deepEqual(normalizeChatTrustPolicy(undefined), {});
  assert.deepEqual(normalizeChatTrustPolicy({ chat: { stranger: 'queue', bogus: 'auto', team: 'nope' } }), {
    chat: { stranger: 'queue' },
  });
  assert.deepEqual(normalizeChatTrustPolicy('queue'), {});
  // Defaults cover every tier and context.
  for (const context of ['chat', 'invite', 'grouptask']) {
    for (const tier of ['local', 'team', 'trusted', 'contact', 'stranger', 'blocked']) {
      assert.ok(typeof DEFAULT_ACCEPT_BEHAVIOR[context][tier] === 'string', `${context}/${tier}`);
    }
  }
});

test('evaluatePeerPolicy works without a profile (empty allowChatSkills)', async () => {
  const result = await evaluatePeerPolicy({
    peerGlobalMetaId: PEER,
    profile: {},
    context: 'chat',
    systemHomeDir: await mkdtempTempRoot('metabot-policy-'),
  });
  assert.equal(result.tier, 'stranger');
  assert.deepEqual(result.allowedSkills, []);
});
