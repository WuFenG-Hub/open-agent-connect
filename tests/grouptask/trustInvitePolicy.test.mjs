import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { mkdtempTempRootSync } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const openteam = require('../../dist/core/grouptask/openteam.js');
const { buildOpenTeamInviteMessage, generateOpenTeamInviteId } = openteam;
const { createOpenTeamStore } = require('../../dist/core/grouptask/openteamStore.js');
const { createGroupTaskEngine } = require('../../dist/core/grouptask/engine.js');
const { createGroupTaskStore } = require('../../dist/core/grouptask/store.js');
const { resolveMetabotPaths } = require('../../dist/core/state/paths.js');
const {
  approveGuestInvite,
  declineGuestInviteById,
  listGuestInvitesAcrossProfiles,
} = require('../../dist/core/grouptask/openteamService.js');
const { createGroupTask } = require('../../dist/core/grouptask/service.js');

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

function createHarness(prefix, options = {}) {
  const systemHome = mkdtempTempRootSync(prefix);
  const pins = [];
  const privateSends = [];
  let pinSeq = 0;

  const makeProfile = (slug, gmid) => {
    const homeDir = path.join(systemHome, '.metabot', 'profiles', slug);
    mkdirSync(homeDir, { recursive: true });
    return {
      slug,
      homeDir,
      name: slug.replace(/-/gu, ' '),
      globalMetaId: gmid,
      metaId: `meta-${slug}`,
      botType: 'worker',
      avatar: null,
    };
  };
  const profiles = [makeProfile('worker-1', 'idq1worker100000000000000000000000000')];

  const makeSigner = (label) => ({
    async writePin(request) {
      pinSeq += 1;
      const pinId = `pin-${label}-${pinSeq}`;
      pins.push({ label, pinId, ...request });
      return { pinId, txId: `tx-${pinSeq}` };
    },
  });

  const indexer = {
    groupInfo: new Map(),
    members: new Map(),
    history: new Map(),
  };
  const fetchImpl = async (input) => {
    const url = String(input);
    const parsed = new URL(url);
    const groupId = parsed.searchParams.get('groupId');
    if (url.includes('/group-info')) {
      // Default-found: createGroupTask's waitForGroupIndexed must not burn
      // the 60s index timeout against this fake.
      const info = indexer.groupInfo.get(groupId)
        ?? { createUserGlobalMetaId: 'idq1chair00000000000000000000000000000' };
      return jsonResponse({ code: 0, data: { groupId, ...info } });
    }
    if (url.includes('/group-member-list')) {
      const list = indexer.members.get(groupId) ?? [];
      return jsonResponse({ code: 0, data: { list: list.map((id) => ({ metaId: id, globalMetaId: id })) } });
    }
    if (url.includes('/group-chat-list-by-index')) return jsonResponse({ code: 0, data: { list: [] } });
    throw new Error(`Unexpected fake indexer URL: ${url}`);
  };

  const inbox = new Map();
  let inboxSeq = 0;
  const pushInbound = (slug, senderGmid, content) => {
    inboxSeq += 1;
    const list = inbox.get(slug) ?? [];
    list.push({
      messageId: `pm-${inboxSeq}`,
      senderGlobalMetaId: senderGmid,
      content,
      timestamp: Math.floor(Date.now() / 1000),
    });
    inbox.set(slug, list);
  };

  const ctx = {
    listProfiles: async () => profiles,
    getProfile: async (slug) => profiles.find((profile) => profile.slug === slug) ?? null,
    signerForSlug: async (slug) => makeSigner(slug),
    ownerIdentity: async () => ({
      globalMetaId: 'IDOWNER', metaId: 'meta-owner', name: 'Owner', signer: makeSigner('owner'),
    }),
    storeForProfile: (profile) => createGroupTaskStore(resolveMetabotPaths(profile.homeDir)),
    openteamStoreForProfile: (profile) => createOpenTeamStore(resolveMetabotPaths(profile.homeDir)),
    sendPrivateMessage: async (input) => {
      pinSeq += 1;
      const pinId = `pmsg-${pinSeq}`;
      privateSends.push({ ...input, pinId });
      return { pinId };
    },
    transport: { indexerHosts: ['https://fake-indexer.test'], fetchImpl },
    ...(options.ctx ?? {}),
  };

  const engine = createGroupTaskEngine({
    ctx,
    runLlmTurn: async () => { throw new Error('unscripted LLM turn'); },
    loadPersona: async () => ({}),
    readInboundPrivateMessages: async (profile) => inbox.get(profile.slug) ?? [],
    workerCooldownMs: 0,
    chairCooldownMs: 0,
    ...(options.engine ? options.engine(ctx) : {}),
  });

  const openteamStore = createOpenTeamStore(resolveMetabotPaths(profiles[0].homeDir));

  const pushInvite = (overrides = {}) => {
    const payload = {
      v: 1,
      inviteId: generateOpenTeamInviteId(),
      groupId: 'grp-ot',
      taskTitle: 'Trust sprint',
      goalSummary: 'Verify the invite policy',
      requiredSkills: [],
      inviterGlobalMetaId: 'idq1chair00000000000000000000000000000',
      inviterName: 'chair bot',
      chairGlobalMetaId: 'idq1chair00000000000000000000000000000',
      targetGlobalMetaId: 'idq1worker100000000000000000000000000',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      ...overrides,
    };
    indexer.groupInfo.set(payload.groupId, { createUserGlobalMetaId: payload.inviterGlobalMetaId });
    pushInbound('worker-1', payload.inviterGlobalMetaId, buildOpenTeamInviteMessage(payload));
    return payload;
  };

  return {
    systemHome, ctx, engine, pins, privateSends, indexer,
    openteamStore, pushInvite, profiles,
  };
}

function joinPins(h) {
  return h.pins.filter((pin) => pin.path && String(pin.path).includes('group'));
}

test('invite gate: team/trusted/contact tiers auto-accept (join + ACCEPT reply)', async () => {
  for (const tier of ['team', 'trusted', 'contact']) {
    const h = createHarness(`metabot-p4b-auto-${tier}-`, {
      engine: () => ({ evaluatePeerInvitePolicy: async () => ({ tier, acceptBehavior: 'auto' }) }),
    });
    h.pushInvite();
    await h.engine.tick();

    const invite = (await h.openteamStore.listGuestInvites())[0];
    assert.equal(invite.status, 'accepted', `${tier} auto-accepts`);
    assert.ok(invite.joinedPinId);
    assert.ok(joinPins(h).length > 0, 'the join pin was written');
    assert.ok(h.privateSends.some((send) => send.toGlobalMetaId === 'idq1chair00000000000000000000000000000'
      && send.content.includes('[OPENTEAM_ACCEPT')));
    const membership = await h.openteamStore.getMembership('grp-ot', 'worker-1');
    assert.equal(membership.status, 'active');
    assert.equal(membership.via, tier === 'team' ? 'team' : 'openteam', 'team-tier auto-accept marks via');
  }
});

test('invite gate: stranger invite is held as pending_approval — no join, no reply', async () => {
  const h = createHarness('metabot-p4b-pending-', {
    engine: () => ({ evaluatePeerInvitePolicy: async () => ({ tier: 'stranger', acceptBehavior: 'queue' }) }),
  });
  h.pushInvite();
  await h.engine.tick();

  const invite = (await h.openteamStore.listGuestInvites())[0];
  assert.equal(invite.status, 'pending_approval');
  assert.equal(invite.joinedPinId, null);
  assert.equal(invite.respondedAt, null);
  assert.equal(joinPins(h).length, 0, 'no join was signed');
  assert.equal(h.privateSends.length, 0, 'nothing is replied to the inviter');
});

test('invite gate: blocked invite is a silent decline (declined/blocked, no reply)', async () => {
  const h = createHarness('metabot-p4b-blocked-', {
    engine: () => ({ evaluatePeerInvitePolicy: async () => ({ tier: 'blocked', acceptBehavior: 'decline' }) }),
  });
  h.pushInvite();
  await h.engine.tick();

  const invite = (await h.openteamStore.listGuestInvites())[0];
  assert.equal(invite.status, 'declined');
  assert.equal(invite.declineReason, 'blocked');
  assert.equal(joinPins(h).length, 0);
  assert.equal(h.privateSends.length, 0, 'blocked is silent — no decline envelope either');
});

test('invite gate: policy evaluator failure holds the invite (stranger-pending), tick survives', async () => {
  const h = createHarness('metabot-p4b-fail-', {
    engine: () => ({
      evaluatePeerInvitePolicy: async () => { throw new Error('indexer unreachable'); },
    }),
  });
  h.pushInvite();
  await h.engine.tick();
  h.pushInvite({ inviteId: generateOpenTeamInviteId() });
  await h.engine.tick();

  const invites = await h.openteamStore.listGuestInvites();
  assert.equal(invites.length, 2);
  for (const invite of invites) assert.equal(invite.status, 'pending_approval');
});

test('invite gate: policy seam absent keeps legacy auto-accept', async () => {
  const h = createHarness('metabot-p4b-legacy-');
  h.pushInvite();
  await h.engine.tick();
  const invite = (await h.openteamStore.listGuestInvites())[0];
  assert.equal(invite.status, 'accepted');
});

test('approve: pending invite joins, replies ACCEPT, and marks the inviter as contact', async () => {
  const h = createHarness('metabot-p4b-approve-', {
    engine: () => ({ evaluatePeerInvitePolicy: async () => ({ tier: 'stranger', acceptBehavior: 'queue' }) }),
  });
  const payload = h.pushInvite();
  await h.engine.tick();

  const approved = await approveGuestInvite(h.ctx, payload.inviteId);
  assert.equal(approved.record.status, 'accepted');
  assert.ok(approved.joinedPinId);
  assert.ok(joinPins(h).length > 0);
  assert.ok(h.privateSends.some((send) => send.content.includes('[OPENTEAM_ACCEPT')));
  const membership = await h.openteamStore.getMembership('grp-ot', 'worker-1');
  assert.equal(membership.status, 'active');
  assert.equal(membership.via, 'openteam', 'human-approved stranger stays an openteam guest');

  const { createTrustLocalStore } = require('../../dist/core/trust/trustLocalStore.js');
  const state = await createTrustLocalStore(h.systemHome).read();
  assert.ok(state.contacts.includes('idq1chair00000000000000000000000000000'), 'approving records the inviter as a contact');
});

test('decline: pending invite is declined and the inviter is notified', async () => {
  const h = createHarness('metabot-p4b-decline-', {
    engine: () => ({ evaluatePeerInvitePolicy: async () => ({ tier: 'stranger', acceptBehavior: 'queue' }) }),
  });
  const payload = h.pushInvite();
  await h.engine.tick();

  const declined = await declineGuestInviteById(h.ctx, payload.inviteId, 'not_needed');
  assert.equal(declined.record.status, 'declined');
  assert.equal(declined.record.declineReason, 'not_needed');
  assert.ok(h.privateSends.some((send) => send.toGlobalMetaId === 'idq1chair00000000000000000000000000000'
    && send.content.includes('[OPENTEAM_DECLINE')));
  assert.equal(joinPins(h).length, 0);
});

test('approve: an expired invite fails with a clear error', async () => {
  const h = createHarness('metabot-p4b-expired-', {
    engine: () => ({ evaluatePeerInvitePolicy: async () => ({ tier: 'stranger', acceptBehavior: 'queue' }) }),
  });
  const payload = h.pushInvite({ expiresAt: Math.floor(Date.now() / 1000) - 3600 });
  // The engine marks it expired before the gate; seed the pending row directly.
  await h.openteamStore.createGuestInvite({
    groupId: payload.groupId,
    inviteId: payload.inviteId,
    inviterGlobalMetaId: payload.inviterGlobalMetaId,
    inviterName: payload.inviterName,
    taskTitle: payload.taskTitle,
    goalSummary: payload.goalSummary,
    requiredSkills: payload.requiredSkills,
    targetGlobalMetaId: payload.targetGlobalMetaId,
    expiresAt: payload.expiresAt,
    status: 'pending_approval',
  });

  await assert.rejects(
    () => approveGuestInvite(h.ctx, payload.inviteId),
    (error) => error.code === 'invite_expired' && /expired/i.test(error.message),
  );
  const invite = await h.openteamStore.getGuestInviteByInviteId(payload.inviteId);
  assert.equal(invite.status, 'expired');
  assert.equal(joinPins(h).length, 0, 'no join happens for an expired invite');
});

test('approve/decline: unknown or non-pending invite ids fail clearly', async () => {
  const h = createHarness('metabot-p4b-none-');
  await assert.rejects(() => approveGuestInvite(h.ctx, 'nope'), (error) => error.code === 'invite_not_pending');
  await assert.rejects(() => declineGuestInviteById(h.ctx, 'nope'), (error) => error.code === 'invite_not_pending');
});

test('invites list: pending and decided invites across profiles', async () => {
  const h = createHarness('metabot-p4b-list-', {
    engine: () => ({ evaluatePeerInvitePolicy: async () => ({ tier: 'stranger', acceptBehavior: 'queue' }) }),
  });
  const payload = h.pushInvite();
  await h.engine.tick();
  const rows = await listGuestInvitesAcrossProfiles(h.ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inviteId, payload.inviteId);
  assert.equal(rows[0].slug, 'worker-1');
  assert.equal(rows[0].status, 'pending_approval');
});

// ---------------------------------------------------------------------------
// Team seating by gmid in createGroupTask
// ---------------------------------------------------------------------------

function seatingHarness(options = {}) {
  const h = createHarness('metabot-p4b-seat-', options);
  const chairProfile = {
    slug: 'chair-bot',
    homeDir: path.join(h.systemHome, '.metabot', 'profiles', 'chair-bot'),
    name: 'chair bot',
    globalMetaId: 'idq1chair00000000000000000000000000000',
    metaId: 'meta-chair-bot',
    botType: 'twin',
    avatar: null,
  };
  mkdirSync(chairProfile.homeDir, { recursive: true });
  h.profiles.push(chairProfile);
  return h;
}

test('seating: a team-tier gmid reference is seated via team and invited', async () => {
  const h = seatingHarness();
  h.ctx.resolvePeerTrustTier = async () => 'team';
  const created = await createGroupTask(h.ctx, {
    title: 'Cross-device sprint',
    goal: 'Seat a remote team worker',
    chairSlug: 'chair-bot',
    workerSlugs: ['idq1remote100000000000000000000000000'],
    seatRoles: null,
  });

  const members = await h.ctx.storeForProfile(h.profiles[1]).listMembers(created.task.id);
  const remote = members.find((member) => member.globalMetaId === 'idq1remote100000000000000000000000000');
  assert.ok(remote, 'the remote seat is on the roster');
  assert.equal(remote.slug, null);
  assert.equal(remote.via, 'team');
  assert.equal(remote.role, 'worker');

  const inviteSend = h.privateSends.find((send) => send.toGlobalMetaId === 'idq1remote100000000000000000000000000'
    && send.content.includes('[OPENTEAM_INVITE]'));
  assert.ok(inviteSend, 'the OpenTeam invite went out over the existing transport');
  const openteamStore = h.ctx.openteamStoreForProfile(h.profiles[1]);
  const inviteRow = (await openteamStore.listInvites(created.task.id))
    .find((invite) => invite.inviteeGlobalMetaId === 'idq1remote100000000000000000000000000');
  assert.equal(inviteRow.via, 'team');
});

test('seating: a non-team gmid fails creation with a clear error before any chain work', async () => {
  const h = seatingHarness();
  h.ctx.resolvePeerTrustTier = async () => 'stranger';
  await assert.rejects(
    () => createGroupTask(h.ctx, {
      title: 'Cross-device sprint',
      goal: 'Seat a remote team worker',
      chairSlug: 'chair-bot',
      workerSlugs: ['idq1remote100000000000000000000000000'],
    }),
    (error) => error.code === 'worker_not_team' && /trust tier: stranger/.test(error.message),
  );
  assert.equal(h.pins.length, 0, 'no on-chain group was created');
});

test('seating: missing tier resolver fails closed', async () => {
  const h = seatingHarness();
  await assert.rejects(
    () => createGroupTask(h.ctx, {
      title: 'Cross-device sprint',
      goal: 'Seat a remote team worker',
      chairSlug: 'chair-bot',
      workerSlugs: ['idq1remote100000000000000000000000000'],
    }),
    (error) => error.code === 'team_seating_unavailable',
  );
});

test('seating: the team member gmid joins the trusted sender set', async () => {
  const h = seatingHarness();
  h.ctx.resolvePeerTrustTier = async () => 'team';
  const created = await createGroupTask(h.ctx, {
    title: 'Cross-device sprint',
    goal: 'Seat a remote team worker',
    chairSlug: 'chair-bot',
    workerSlugs: ['idq1remote100000000000000000000000000'],
    seatRoles: null,
  });
  const { buildTrustedGmidSet } = require('../../dist/core/grouptask/service.js');
  const store = h.ctx.storeForProfile(h.profiles[1]);
  const trusted = await buildTrustedGmidSet(h.ctx, await store.listMembers(created.task.id));
  assert.ok(trusted.has('idq1remote100000000000000000000000000'), 'the via:team member is first-class in the trusted set');
  assert.ok(trusted.has('idq1chair00000000000000000000000000000'));
});
