import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const { createOwnerIdentity } = require('../../dist/core/owner/ownerIdentity.js');
const {
  createRootOwnerIdentity,
  importRootOwnerIdentity,
  revealRootOwnerMnemonic,
} = require('../../dist/core/owner/rootOwnerIdentity.js');
const { signOwnerBinding } = require('../../dist/core/owner/ownerBinding.js');
const { createRootOwnerResolver } = require('../../dist/core/trust/rootOwnerResolver.js');
const { createPeerTrustResolver } = require('../../dist/core/trust/peerTrustResolver.js');
const { evaluatePeerPolicy } = require('../../dist/core/trust/trustPolicy.js');
const { createGroupTask } = require('../../dist/core/grouptask/service.js');
const { createGroupTaskEngine } = require('../../dist/core/grouptask/engine.js');
const { createGroupTaskStore } = require('../../dist/core/grouptask/store.js');
const { createOpenTeamStore } = require('../../dist/core/grouptask/openteamStore.js');
const { resolveMetabotPaths } = require('../../dist/core/state/paths.js');
const { buildOpenTeamInviteMessage } = require('../../dist/core/grouptask/openteam.js');

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

test('two devices bound to one root owner: team seating by gmid auto-accepts via team', async () => {
  // One human owner, two machines. Both devices import the SAME root owner
  // mnemonic (P1); every /info/owner pin is a REAL signed payload served by a
  // fake pin reader (the same seam the P1 resolver tests use).
  const rootHome = await mkdtempTempRoot('metabot-p4b-root-');
  await createRootOwnerIdentity(rootHome, { name: 'Shared Owner' });
  const ownerMnemonic = await revealRootOwnerMnemonic(rootHome);

  const homeA = await mkdtempTempRoot('metabot-p4b-homeA-');
  const homeB = await mkdtempTempRoot('metabot-p4b-homeB-');
  const ownerA = await importRootOwnerIdentity(homeA, { name: 'Shared Owner', mnemonic: ownerMnemonic });
  const ownerB = await importRootOwnerIdentity(homeB, { name: 'Shared Owner', mnemonic: ownerMnemonic });
  assert.equal(ownerA.globalMetaId, ownerB.globalMetaId, 'same mnemonic → same root owner');
  const rootOwnerGmid = ownerA.globalMetaId;

  const deviceA = await createOwnerIdentity(homeA, { name: 'Device A' });
  const deviceB = await createOwnerIdentity(homeB, { name: 'Device B' });
  // Bots are profile identities, not device identities — derive them
  // directly (createOwnerIdentity is one-per-machine by design).
  const { deriveIdentity } = require('../../dist/core/identity/deriveIdentity.js');
  const botA = await deriveIdentity({});
  const botB = await deriveIdentity({});

  // Real signed binding payloads, faked pin READS.
  const pins = new Map();
  const putBinding = async (ownerRecord, subjectGmid, key) => {
    const { payload } = await signOwnerBinding(ownerRecord, subjectGmid);
    pins.set(key, { pinId: `pin-${key.slice(0, 8)}`, payload });
  };
  await putBinding(deviceA, botA.globalMetaId, `${botA.globalMetaId}`);   // botA → deviceA
  await putBinding(ownerA, deviceA.globalMetaId, `${deviceA.globalMetaId}`); // deviceA → owner
  await putBinding(deviceB, botB.globalMetaId, `${botB.globalMetaId}`);   // botB → deviceB
  await putBinding(ownerB, deviceB.globalMetaId, `${deviceB.globalMetaId}`); // deviceB → owner
  const pinReader = async (gmid) => pins.get(gmid) ?? null;

  const emptyGrants = {
    resolveTrustedOwners: async () => ({ trustedOwners: [], fromCache: false }),
    invalidate: async () => {},
  };
  const resolverA = createPeerTrustResolver({
    systemHomeDir: homeA,
    rootOwnerResolver: createRootOwnerResolver({ systemHomeDir: homeA, pinReader }),
    trustedOwnerResolver: emptyGrants,
    listLocalProfileGmids: async () => [botA.globalMetaId],
  });
  const resolverB = createPeerTrustResolver({
    systemHomeDir: homeB,
    rootOwnerResolver: createRootOwnerResolver({ systemHomeDir: homeB, pinReader }),
    trustedOwnerResolver: emptyGrants,
    listLocalProfileGmids: async () => [botB.globalMetaId],
  });

  // Sanity: both directions resolve to the shared root owner → team.
  assert.equal(await resolverA.resolvePeerTrustTier({ peerGlobalMetaId: botB.globalMetaId }), 'team');
  assert.equal(await resolverB.resolvePeerTrustTier({ peerGlobalMetaId: botA.globalMetaId }), 'team');

  // ---- Home A: chair creates a group task seating B by gmid ----
  const chairHome = path.join(homeA, '.metabot', 'profiles', 'chair-bot');
  mkdirSync(chairHome, { recursive: true });
  const chairProfile = {
    slug: 'chair-bot',
    homeDir: chairHome,
    name: 'Chair Bot',
    globalMetaId: botA.globalMetaId,
    metaId: botA.metaId,
    botType: 'twin',
    avatar: null,
  };
  const pinsA = [];
  let pinSeq = 0;
  const makeSigner = (label) => ({
    async writePin(request) {
      pinSeq += 1;
      const pinId = `pin-${label}-${pinSeq}`;
      pinsA.push({ label, pinId, ...request });
      return { pinId, txId: `tx-${pinSeq}` };
    },
  });
  const indexer = { groupInfo: new Map(), members: new Map(), history: new Map() };
  const fetchImpl = async (input) => {
    const url = String(input);
    const parsed = new URL(url);
    const groupId = parsed.searchParams.get('groupId');
    if (url.includes('/group-info')) {
      // Default-found so createGroupTask's waitForGroupIndexed never burns
      // the 60s index timeout against this fake.
      const info = indexer.groupInfo.get(groupId) ?? { createUserGlobalMetaId: botA.globalMetaId };
      return jsonResponse({ code: 0, data: { groupId, ...info } });
    }
    if (url.includes('/group-member-list')) {
      const list = indexer.members.get(groupId) ?? [];
      return jsonResponse({ code: 0, data: { list: list.map((id) => ({ metaId: id, globalMetaId: id })) } });
    }
    if (url.includes('/group-chat-list-by-index')) return jsonResponse({ code: 0, data: { list: [] } });
    throw new Error(`Unexpected fake indexer URL: ${url}`);
  };
  const privateSends = [];
  const ctxA = {
    listProfiles: async () => [chairProfile],
    getProfile: async (slug) => (slug === 'chair-bot' ? chairProfile : null),
    signerForSlug: async (slug) => makeSigner(slug),
    ownerIdentity: async () => ({
      globalMetaId: deviceA.globalMetaId,
      metaId: deviceA.metaId,
      name: 'Device A',
      signer: makeSigner('owner'),
    }),
    storeForProfile: (profile) => createGroupTaskStore(resolveMetabotPaths(profile.homeDir)),
    openteamStoreForProfile: (profile) => createOpenTeamStore(resolveMetabotPaths(profile.homeDir)),
    sendPrivateMessage: async (input) => {
      privateSends.push(input);
      return { pinId: `pmsg-${privateSends.length}` };
    },
    transport: { indexerHosts: ['https://fake-indexer.test'], fetchImpl },
    resolvePeerTrustTier: (gmid) => resolverA.resolvePeerTrustTier({ peerGlobalMetaId: gmid }),
  };

  const created = await createGroupTask(ctxA, {
    title: 'Cross-device build',
    goal: 'Ship the trust tiers with a team worker on another device',
    chairSlug: 'chair-bot',
    workerSlugs: [botB.globalMetaId],
    seatRoles: null,
  });

  const chairStore = ctxA.storeForProfile(chairProfile);
  const members = await chairStore.listMembers(created.task.id);
  const teamSeat = members.find((member) => member.globalMetaId === botB.globalMetaId);
  assert.ok(teamSeat, 'the remote seat is on the roster');
  assert.equal(teamSeat.via, 'team');
  const inviteSend = privateSends.find((send) => send.toGlobalMetaId === botB.globalMetaId
    && send.content.includes('[OPENTEAM_INVITE]'));
  assert.ok(inviteSend, 'the OpenTeam invite reached device B over the existing transport');

  const groupId = created.task.groupId;
  indexer.groupInfo.set(groupId, { createUserGlobalMetaId: botA.globalMetaId });
  indexer.members.set(groupId, [botA.globalMetaId]);

  // ---- Home B: the worker bot's engine auto-accepts at team tier ----
  const workerHome = path.join(homeB, '.metabot', 'profiles', 'worker-bot');
  mkdirSync(workerHome, { recursive: true });
  const workerProfile = {
    slug: 'worker-bot',
    homeDir: workerHome,
    name: 'Worker Bot',
    globalMetaId: botB.globalMetaId,
    metaId: botB.metaId,
    botType: 'worker',
    avatar: null,
  };
  const pinsB = [];
  const ctxB = {
    listProfiles: async () => [workerProfile],
    getProfile: async (slug) => (slug === 'worker-bot' ? workerProfile : null),
    signerForSlug: async () => makeSigner('worker'),
    ownerIdentity: async () => ({
      globalMetaId: deviceB.globalMetaId,
      metaId: deviceB.metaId,
      name: 'Device B',
      signer: makeSigner('owner'),
    }),
    storeForProfile: (profile) => createGroupTaskStore(resolveMetabotPaths(profile.homeDir)),
    openteamStoreForProfile: (profile) => createOpenTeamStore(resolveMetabotPaths(profile.homeDir)),
    sendPrivateMessage: async (input) => {
      pinsB.push(input);
      return { pinId: `pmsg-${pinsB.length}` };
    },
    transport: { indexerHosts: ['https://fake-indexer.test'], fetchImpl },
  };

  const engineB = createGroupTaskEngine({
    ctx: ctxB,
    runLlmTurn: async () => { throw new Error('unscripted LLM turn'); },
    loadPersona: async () => ({}),
    readInboundPrivateMessages: async (profile) => (profile.slug === 'worker-bot' ? [{
      messageId: 'pm-1',
      senderGlobalMetaId: botA.globalMetaId,
      content: inviteSend.content,
      timestamp: Math.floor(Date.now() / 1000),
    }] : []),
    workerCooldownMs: 0,
    chairCooldownMs: 0,
    evaluatePeerInvitePolicy: async (inviterGmid) => {
      const evaluation = await evaluatePeerPolicy({
        peerGlobalMetaId: inviterGmid,
        profile: {},
        context: 'invite',
        systemHomeDir: homeB,
        tierResolver: resolverB,
      });
      return { tier: evaluation.tier, acceptBehavior: evaluation.acceptBehavior };
    },
  });

  await engineB.tick();

  const openteamB = ctxB.openteamStoreForProfile(workerProfile);
  const guestInvites = await openteamB.listGuestInvites();
  assert.equal(guestInvites.length, 1);
  assert.equal(guestInvites[0].status, 'accepted', 'team-tier invite auto-accepts');
  assert.ok(guestInvites[0].joinedPinId);
  const membership = await openteamB.getMembership(groupId, 'worker-bot');
  assert.equal(membership.status, 'active');
  assert.equal(membership.via, 'team', 'guest membership records via team');
  assert.ok(pinsB.some((send) => send.content.includes('[OPENTEAM_ACCEPT')), 'ACCEPT was relayed to the chair');
});
