/**
 * OpenTeam service verbs — the user/CLI-facing half of the remote-member
 * handshake (the engine owns the asynchronous half: envelope scan, guest
 * auto-accept, join confirmation, guest replies).
 *
 * - inviteRemoteMember: chair sends the [OPENTEAM_INVITE] simplemsg and
 *   records a pending invite row;
 * - listOpenTeamInvites: inviter-side invite rows for one task;
 * - listOpenTeamCollabs: guest-side view — memberships + received invites
 *   across every local profile (IDBots OpenTeamCollabsSection parity);
 * - listOpenTeamCollabMessages: read-only guest transcript for one group.
 */

import {
  GroupTaskServiceError,
  openteamStoreFor,
  type GroupTaskProfileRef,
  type GroupTaskServiceContext,
} from './service';
import { createGroupTaskStore, type GroupTaskStore } from './store';
import { resolveMetabotPaths } from '../state/paths';
import {
  OPENTEAM_INVITE_TTL_SECONDS,
  OPENTEAM_EXPIRY_SKEW_SECONDS,
  buildOpenTeamInviteMessage,
  generateOpenTeamInviteId,
  buildOpenTeamAcceptMessage,
  buildOpenTeamDeclineMessage,
} from './openteam';
import type {
  OpenTeamGuestInviteRecord,
  OpenTeamInviteRecord,
  OpenTeamMembershipRecord,
  OpenTeamMemberVia,
  OpenTeamStore,
} from './openteamStore';
import { fetchGroupMembers, joinGroupOnChain } from './transport';
import { syncGroupMessages } from './backfill';
import { markContact } from '../trust/contactEvidence';
import type { GroupTaskMessage } from './types';

const GOAL_SUMMARY_MAX_CHARS = 200;

function storeForProfile(ctx: GroupTaskServiceContext, profile: GroupTaskProfileRef): GroupTaskStore {
  if (ctx.storeForProfile) return ctx.storeForProfile(profile);
  return createGroupTaskStore(resolveMetabotPaths(profile.homeDir));
}

async function requireProfile(ctx: GroupTaskServiceContext, slug: string): Promise<GroupTaskProfileRef> {
  const profile = await ctx.getProfile(slug.trim());
  if (!profile) {
    throw new GroupTaskServiceError('profile_not_found', `MetaBot profile not found: ${slug}`);
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Invite (chair side)
// ---------------------------------------------------------------------------

export interface InviteRemoteMemberInput {
  globalMetaId: string;
  name?: string | null;
  requiredSkills?: string[];
  /** Allow re-inviting a GlobalMetaID that already has a non-pending invite. */
  allowReinvite?: boolean;
  /**
   * 'team' for remote workers seated from task creation (P4b): the roster row
   * already exists (that IS the seat), so the already-member check is skipped
   * and the invite row is marked via 'team'.
   */
  via?: OpenTeamMemberVia | null;
}

export async function inviteRemoteMember(
  ctx: GroupTaskServiceContext,
  chairSlug: string,
  taskId: number,
  input: InviteRemoteMemberInput,
): Promise<OpenTeamInviteRecord> {
  if (!ctx.sendPrivateMessage) {
    throw new GroupTaskServiceError(
      'openteam_unavailable',
      'Private-message sending is not wired in this context; OpenTeam invites are unavailable',
    );
  }
  const invitee = input.globalMetaId.trim();
  if (!invitee) {
    throw new GroupTaskServiceError('invitee_required', 'Invitee GlobalMetaID is required');
  }

  const chair = await requireProfile(ctx, chairSlug);
  const store = storeForProfile(ctx, chair);
  const task = await store.getTaskById(taskId);
  if (!task) {
    throw new GroupTaskServiceError('task_not_found', `Group task ${taskId} not found`);
  }
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new GroupTaskServiceError('task_terminal', `Group task ${taskId} is ${task.status}`);
  }
  if (!task.groupId) {
    throw new GroupTaskServiceError('group_missing', `Group task ${taskId} has no on-chain group id`);
  }
  const chairGmid = (chair.globalMetaId ?? '').trim();
  if (!chairGmid) {
    throw new GroupTaskServiceError('chair_identity_missing', `Chair ${chair.slug} has no GlobalMetaID`);
  }
  if (invitee.toLowerCase() === chairGmid.toLowerCase()) {
    throw new GroupTaskServiceError('cannot_invite_self', 'The chair cannot invite itself');
  }

  const members = await store.listMembers(taskId);
  const alreadyMember = members.some(
    (member) => (member.globalMetaId ?? '').trim().toLowerCase() === invitee.toLowerCase(),
  );
  if (alreadyMember && input.via !== 'team') {
    throw new GroupTaskServiceError('already_member', `${invitee} is already a member of task ${taskId}`);
  }

  const openteam = openteamStoreFor(ctx, chair);
  const existing = await openteam.listInvites(taskId);
  const duplicate = existing.find(
    (invite) => invite.inviteeGlobalMetaId.toLowerCase() === invitee.toLowerCase()
      && (invite.status === 'pending' || !input.allowReinvite),
  );
  if (duplicate) {
    throw new GroupTaskServiceError(
      duplicate.status === 'pending' ? 'invite_pending' : 'already_invited',
      `${invitee} already has a ${duplicate.status} invite for task ${taskId}`
      + (duplicate.status === 'pending' ? '' : ' (pass allowReinvite to send another)'),
    );
  }

  const inviteId = generateOpenTeamInviteId();
  const goalSummary = task.goal.trim().slice(0, GOAL_SUMMARY_MAX_CHARS);
  const requiredSkills = (input.requiredSkills ?? []).map((skill) => skill.trim()).filter(Boolean);
  const expiresAt = Math.floor(Date.now() / 1000) + OPENTEAM_INVITE_TTL_SECONDS;

  const plaintext = buildOpenTeamInviteMessage({
    v: 1,
    inviteId,
    groupId: task.groupId,
    taskTitle: task.title,
    goalSummary,
    requiredSkills,
    inviterGlobalMetaId: chairGmid,
    inviterName: chair.name.trim() || chair.slug,
    chairGlobalMetaId: chairGmid,
    targetGlobalMetaId: invitee,
    expiresAt,
  });

  const sent = await ctx.sendPrivateMessage({
    fromSlug: chair.slug,
    toGlobalMetaId: invitee,
    content: plaintext,
  });

  return openteam.createInvite({
    taskId,
    groupId: task.groupId,
    inviteId,
    inviteeGlobalMetaId: invitee,
    inviteeName: input.name?.trim() || null,
    requiredSkills,
    sentPinId: sent.pinId,
    expiresAt,
    via: input.via ?? null,
  });
}

export async function listOpenTeamInvites(
  ctx: GroupTaskServiceContext,
  chairSlug: string,
  taskId: number,
): Promise<OpenTeamInviteRecord[]> {
  const chair = await requireProfile(ctx, chairSlug);
  return openteamStoreFor(ctx, chair).listInvites(taskId);
}

// ---------------------------------------------------------------------------
// Guest-side collab view
// ---------------------------------------------------------------------------

export interface OpenTeamCollabSummary extends OpenTeamMembershipRecord {
  /** Display name of the local profile that joined. */
  botName: string;
}

export interface OpenTeamCollabsView {
  memberships: OpenTeamCollabSummary[];
  guestInvites: Array<OpenTeamGuestInviteRecord & { slug: string; botName: string }>;
}

/** Guest-side external collaborations across every local profile. */
export async function listOpenTeamCollabs(ctx: GroupTaskServiceContext): Promise<OpenTeamCollabsView> {
  const profiles = await ctx.listProfiles();
  const view: OpenTeamCollabsView = { memberships: [], guestInvites: [] };
  for (const profile of profiles) {
    const store = openteamStoreFor(ctx, profile);
    let memberships: OpenTeamMembershipRecord[];
    let guestInvites: OpenTeamGuestInviteRecord[];
    try {
      memberships = await store.listMemberships();
      guestInvites = await store.listGuestInvites();
    } catch {
      continue;
    }
    for (const membership of memberships) {
      view.memberships.push({ ...membership, botName: profile.name });
    }
    for (const invite of guestInvites) {
      view.guestInvites.push({ ...invite, slug: profile.slug, botName: profile.name });
    }
  }
  view.memberships.sort((left, right) => (right.activatedAt ?? 0) - (left.activatedAt ?? 0));
  view.guestInvites.sort((left, right) => right.createdAt - left.createdAt);
  return view;
}

// ---------------------------------------------------------------------------
// Guest transcript (read-only)
// ---------------------------------------------------------------------------

export interface OpenTeamCollabMessagesResult {
  membership: OpenTeamMembershipRecord;
  messages: GroupTaskMessage[];
  total: number;
}

/**
 * Read-only transcript for a group this profile joined as a guest. Syncs the
 * guest-side cache from the indexer first (best effort); trust set comes from
 * the live indexer member list.
 */
export async function listOpenTeamCollabMessages(
  ctx: GroupTaskServiceContext,
  slug: string,
  groupId: string,
  options?: { limit?: number },
): Promise<OpenTeamCollabMessagesResult> {
  const profile = await requireProfile(ctx, slug);
  const openteam = openteamStoreFor(ctx, profile);
  const membership = await openteam.getMembership(groupId, profile.slug);
  if (!membership) {
    throw new GroupTaskServiceError(
      'membership_not_found',
      `Bot ${slug} has no OpenTeam membership for group ${groupId}`,
    );
  }

  const store = storeForProfile(ctx, profile);
  try {
    const memberIds = await fetchGroupMembers(groupId, ctx.transport);
    await syncGroupMessages({
      store,
      groupId,
      trustedGlobalMetaIds: new Set((memberIds ?? []).map((id) => id.trim().toLowerCase())),
      transport: ctx.transport,
    });
  } catch (error) {
    ctx.log?.(
      `[OpenTeam] Guest transcript sync failed for group ${groupId}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const page = await store.listMessages(groupId, { limit: options?.limit ?? 100 });
  return { membership, messages: page.messages, total: page.total };
}

// ---------------------------------------------------------------------------
// Guest invite approval surface (trust tiers P4b)
// ---------------------------------------------------------------------------

/**
 * The shared guest-side accept path (trust tiers P4b): sign the simplegroupjoin
 * ourselves, record the accepted invite (created when absent — the engine's
 * auto-accept path; updated when present — the pending-approval path), create
 * the membership, and reply ACCEPT to the inviter. Used by the engine's
 * auto-accept AND by the human approval verb so both flows stay identical.
 */
export async function executeGuestAccept(input: {
  ctx: GroupTaskServiceContext;
  profile: GroupTaskProfileRef;
  openteam: OpenTeamStore;
  invite: OpenTeamGuestInviteRecord;
  via: OpenTeamMemberVia;
}): Promise<{ joinedPinId: string; membership: OpenTeamMembershipRecord }> {
  const { ctx, profile, openteam, invite, via } = input;
  if (!ctx.sendPrivateMessage) {
    throw new GroupTaskServiceError(
      'openteam_unavailable',
      'Private-message sending is not wired in this context; OpenTeam invites are unavailable',
    );
  }
  const signer = await ctx.signerForSlug(profile.slug);
  const { pinId: joinedPinId } = await joinGroupOnChain(signer, invite.groupId);
  const existing = await openteam.getGuestInviteByInviteId(invite.inviteId);
  if (existing) {
    await openteam.updateGuestInvite(invite.inviteId, { status: 'accepted', joinedPinId });
  } else {
    await openteam.createGuestInvite({
      groupId: invite.groupId,
      inviteId: invite.inviteId,
      inviterGlobalMetaId: invite.inviterGlobalMetaId,
      inviterName: invite.inviterName,
      taskTitle: invite.taskTitle,
      goalSummary: invite.goalSummary,
      requiredSkills: invite.requiredSkills,
      targetGlobalMetaId: invite.targetGlobalMetaId,
      expiresAt: invite.expiresAt,
      status: 'accepted',
      joinedPinId,
    });
  }
  const membership = await openteam.createMembership({
    groupId: invite.groupId,
    slug: profile.slug,
    inviterGlobalMetaId: invite.inviterGlobalMetaId,
    inviterName: invite.inviterName,
    taskTitle: invite.taskTitle,
    goalSummary: invite.goalSummary,
    inviteId: invite.inviteId,
    joinedPinId,
    via,
  });
  await ctx.sendPrivateMessage({
    fromSlug: profile.slug,
    toGlobalMetaId: invite.inviterGlobalMetaId,
    content: buildOpenTeamAcceptMessage(invite.inviteId, joinedPinId),
  });
  return { joinedPinId, membership };
}

export interface GuestInviteWithProfile {
  record: OpenTeamGuestInviteRecord;
  profile: GroupTaskProfileRef;
}

/** Locate one guest-invite record across every local profile. */
export async function findGuestInviteAcrossProfiles(
  ctx: GroupTaskServiceContext,
  inviteId: string,
): Promise<GuestInviteWithProfile | null> {
  const normalized = inviteId.trim();
  if (!normalized) return null;
  for (const profile of await ctx.listProfiles()) {
    const record = await openteamStoreFor(ctx, profile).getGuestInviteByInviteId(normalized)
      .catch(() => null);
    if (record) return { record, profile };
  }
  return null;
}

/** Guest-side invites across every local profile, for the approval surface. */
export async function listGuestInvitesAcrossProfiles(
  ctx: GroupTaskServiceContext,
): Promise<Array<OpenTeamGuestInviteRecord & { slug: string; botName: string }>> {
  const profiles = await ctx.listProfiles();
  const rows: Array<OpenTeamGuestInviteRecord & { slug: string; botName: string }> = [];
  for (const profile of profiles) {
    const invites = await openteamStoreFor(ctx, profile).listGuestInvites().catch(() => [] as OpenTeamGuestInviteRecord[]);
    for (const invite of invites) {
      rows.push({ ...invite, slug: profile.slug, botName: profile.name });
    }
  }
  rows.sort((left, right) => right.createdAt - left.createdAt);
  return rows;
}

/**
 * Approve a pending guest invite (trust tiers P4b): re-validate expiry, run
 * the shared accept path, then record the inviter as a contact — approving a
 * stranger invite is exactly the explicit human approval the contact tier
 * means.
 */
export async function approveGuestInvite(
  ctx: GroupTaskServiceContext,
  inviteId: string,
): Promise<GuestInviteWithProfile & { joinedPinId: string }> {
  const found = await findGuestInviteAcrossProfiles(ctx, inviteId);
  if (!found || found.record.status !== 'pending_approval') {
    throw new GroupTaskServiceError(
      'invite_not_pending',
      `No pending guest invite found: ${inviteId.trim() || '<missing>'}`,
    );
  }
  const { record, profile } = found;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (record.expiresAt + OPENTEAM_EXPIRY_SKEW_SECONDS < nowSeconds) {
    await openteamStoreFor(ctx, profile).updateGuestInvite(record.inviteId, {
      status: 'expired',
      declineReason: 'invite_expired',
    }).catch(() => undefined);
    throw new GroupTaskServiceError(
      'invite_expired',
      `Invite ${record.inviteId} expired at ${new Date(record.expiresAt * 1000).toISOString()} and cannot be approved.`,
    );
  }
  const { joinedPinId } = await executeGuestAccept({
    ctx,
    profile,
    openteam: openteamStoreFor(ctx, profile),
    invite: record,
    via: 'openteam',
  });
  const systemHomeDir = resolveMetabotPaths(profile.homeDir).systemHomeDir;
  await markContact(systemHomeDir, record.inviterGlobalMetaId).catch(() => undefined);
  const updated = await openteamStoreFor(ctx, profile).getGuestInviteByInviteId(record.inviteId);
  return { record: updated ?? record, profile, joinedPinId };
}

/** Decline a pending guest invite: record the decision and notify the inviter. */
export async function declineGuestInviteById(
  ctx: GroupTaskServiceContext,
  inviteId: string,
  reason?: string,
): Promise<GuestInviteWithProfile> {
  const found = await findGuestInviteAcrossProfiles(ctx, inviteId);
  if (!found || found.record.status !== 'pending_approval') {
    throw new GroupTaskServiceError(
      'invite_not_pending',
      `No pending guest invite found: ${inviteId.trim() || '<missing>'}`,
    );
  }
  const { record, profile } = found;
  const declineReason = reason?.trim() || 'declined_by_owner';
  await openteamStoreFor(ctx, profile).updateGuestInvite(record.inviteId, {
    status: 'declined',
    declineReason,
  });
  if (ctx.sendPrivateMessage) {
    try {
      await ctx.sendPrivateMessage({
        fromSlug: profile.slug,
        toGlobalMetaId: record.inviterGlobalMetaId,
        content: buildOpenTeamDeclineMessage(record.inviteId, declineReason),
      });
    } catch (error) {
      ctx.log?.(`[OpenTeam] Decline reply failed for invite ${record.inviteId}: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const updated = await openteamStoreFor(ctx, profile).getGuestInviteByInviteId(record.inviteId);
  return { record: updated ?? record, profile };
}
