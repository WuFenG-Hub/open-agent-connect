import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';
import { createProfileHome } from '../helpers/profileHome.mjs';

const require = createRequire(import.meta.url);
const {
  hasTwoWayExchange,
  listMarkedContacts,
  markContact,
  stateHasTwoWayExchange,
  unmarkContact,
} = require('../../dist/core/trust/contactEvidence.js');
const { resolveMetabotPaths } = require('../../dist/core/state/paths.js');

const PEER = 'idq1peerchatevidence00000000000000000000';
const OTHER = 'idq1otherpeer00000000000000000000000000';

function message(conversationId, direction, senderGlobalMetaId, timestamp) {
  return {
    conversationId,
    messageId: `msg-${conversationId}-${direction}-${timestamp}`,
    direction,
    senderGlobalMetaId,
    content: 'hello',
    messagePinId: null,
    extensions: null,
    timestamp,
  };
}

function chatState(conversations, messages) {
  return { version: 1, conversations, messages };
}

function conversation(conversationId, peerGlobalMetaId) {
  return {
    conversationId,
    peerGlobalMetaId,
    peerName: null,
    topic: null,
    strategyId: null,
    state: 'active',
    turnCount: 2,
    lastDirection: 'outbound',
    createdAt: 1,
    updatedAt: 2,
    pendingGuidanceText: null,
    pendingGuidanceCreatedAt: null,
  };
}

async function writeChatState(profileHomeDir, state) {
  const paths = resolveMetabotPaths(profileHomeDir);
  await fs.mkdir(path.dirname(paths.privateChatStatePath), { recursive: true });
  await fs.writeFile(paths.privateChatStatePath, `${JSON.stringify(state)}\n`, 'utf8');
}

test('stateHasTwoWayExchange: true only with inbound AND outbound in the peer conversation', () => {
  const state = chatState(
    [conversation('conv-1', PEER), conversation('conv-2', OTHER)],
    [
      message('conv-1', 'inbound', PEER, 1),
      message('conv-1', 'outbound', 'idq1self000000000000000000000000000', 2),
      // Inbound-only traffic in another peer's conversation must not count.
      message('conv-2', 'inbound', OTHER, 3),
      message('conv-2', 'inbound', OTHER, 4),
    ],
  );
  assert.equal(stateHasTwoWayExchange(state, PEER), true);
  assert.equal(stateHasTwoWayExchange(state, OTHER), false, 'one-way exchange is not contact evidence');
  assert.equal(stateHasTwoWayExchange(state, 'idq1nobody00000000000000000000000000'), false);
  assert.equal(stateHasTwoWayExchange(state, 'bogus'), false);
});

test('hasTwoWayExchange reads the on-disk private-chat state', async () => {
  const profileHomeDir = await createProfileHome('metabot-contact-evidence-');

  // Missing file: no evidence, no throw.
  assert.equal(await hasTwoWayExchange(profileHomeDir, PEER), false);

  await writeChatState(profileHomeDir, chatState(
    [conversation('conv-1', PEER.toUpperCase())],
    [message('conv-1', 'inbound', PEER, 1)],
  ));
  assert.equal(await hasTwoWayExchange(profileHomeDir, PEER), false, 'inbound only');

  await writeChatState(profileHomeDir, chatState(
    [conversation('conv-1', PEER)],
    [
      message('conv-1', 'inbound', PEER, 1),
      message('conv-1', 'outbound', 'idq1self000000000000000000000000000', 2),
    ],
  ));
  assert.equal(await hasTwoWayExchange(profileHomeDir, PEER), true, 'two-way exchange');
});

test('markContact/unmarkContact maintain the explicit contacts list', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-contact-mark-');
  assert.deepEqual(await listMarkedContacts(systemHomeDir), []);

  await markContact(systemHomeDir, PEER);
  await markContact(systemHomeDir, PEER);
  await markContact(systemHomeDir, OTHER);
  assert.deepEqual(await listMarkedContacts(systemHomeDir), [PEER, OTHER]);

  await unmarkContact(systemHomeDir, PEER);
  assert.deepEqual(await listMarkedContacts(systemHomeDir), [OTHER]);
});
