import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { cleanupProfileHome, createProfileHome, deriveSystemHome } from '../helpers/profileHome.mjs';

const require = createRequire(import.meta.url);
const { createDefaultMetabotDaemonHandlers } = require('../../dist/daemon/defaultHandlers.js');
const { createRuntimeStateStore } = require('../../dist/core/state/runtimeStateStore.js');
const { resolveMetabotPaths } = require('../../dist/core/state/paths.js');

const LOCAL_ID = 'gm-runtime-bot';
const PEER_ID = 'gm-peer-bot';
const BODY = 'smoke private hello';

test('chat conversations lists a private message stored only in the A2A file', async (t) => {
  const homeDir = await createProfileHome('metabot-private-chat-list-', 'bob');
  t.after(async () => {
    await cleanupProfileHome(homeDir);
  });
  await createRuntimeStateStore(homeDir).writeState({
    identity: {
      metabotId: 1,
      name: 'Bob',
      createdAt: 1776836000000,
      path: "m/44'/10001'/0'/0/0",
      publicKey: 'public-key',
      chatPublicKey: 'chat-public-key',
      addresses: { mvc: 'mvc-runtime-address' },
      mvcAddress: 'mvc-runtime-address',
      metaId: 'metaid-runtime-bot',
      globalMetaId: LOCAL_ID,
    },
    services: [],
    traces: [],
    sellerOrders: [],
  });
  const a2aRoot = resolveMetabotPaths(homeDir).a2aRoot;
  await mkdir(a2aRoot, { recursive: true });
  await writeFile(path.join(a2aRoot, 'chat-gmruntime-gmpeerbot.json'), JSON.stringify({
    version: 1,
    local: {
      profileSlug: 'bob',
      globalMetaId: LOCAL_ID,
      name: 'Bob',
      chatPublicKey: 'chat-public-key',
    },
    peer: {
      globalMetaId: PEER_ID,
      name: null,
      chatPublicKey: 'peer-chat-public-key',
    },
    messages: [{
      messageId: 'pin-private-1',
      sessionId: 'a2a-peer-gmruntime-gmpeerbot',
      direction: 'outgoing',
      kind: 'private_chat',
      content: BODY,
      contentType: 'text/plain',
      pinId: 'pin-private-1',
      txids: ['tx-private-1'],
      timestamp: 1792045211114,
      sender: { globalMetaId: LOCAL_ID, name: 'Bob' },
      recipient: { globalMetaId: PEER_ID },
    }],
    sessions: [{
      sessionId: 'a2a-peer-gmruntime-gmpeerbot',
      type: 'peer',
      state: 'active',
      createdAt: 1792045211114,
      updatedAt: 1792045211114,
      latestMessageId: 'pin-private-1',
    }],
    updatedAt: 1792045211125,
  }), 'utf8');

  const handlers = createDefaultMetabotDaemonHandlers({
    homeDir,
    systemHomeDir: deriveSystemHome(homeDir),
    getDaemonRecord: () => null,
  });
  const listed = await handlers.chat.privateChatConversations({});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const conversation = listed.data.conversations.find((entry) => entry.peerGlobalMetaId === PEER_ID);
  assert.ok(conversation, 'sent private chat must appear in chat conversations');

  const messages = await handlers.chat.privateChatMessages({
    conversationId: conversation.conversationId,
  });
  assert.equal(messages.ok, true, JSON.stringify(messages));
  assert.equal(messages.data.messages.some((message) => message.content === BODY), true);
});
