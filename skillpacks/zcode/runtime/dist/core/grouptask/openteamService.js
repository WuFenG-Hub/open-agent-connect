"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteRemoteMember = inviteRemoteMember;
exports.listOpenTeamInvites = listOpenTeamInvites;
exports.listOpenTeamCollabs = listOpenTeamCollabs;
exports.listOpenTeamCollabMessages = listOpenTeamCollabMessages;
exports.executeGuestAccept = executeGuestAccept;
exports.findGuestInviteAcrossProfiles = findGuestInviteAcrossProfiles;
exports.listGuestInvitesAcrossProfiles = listGuestInvitesAcrossProfiles;
exports.approveGuestInvite = approveGuestInvite;
exports.declineGuestInviteById = declineGuestInviteById;
const service_1 = require("./service");
const store_1 = require("./store");
const paths_1 = require("../state/paths");
const openteam_1 = require("./openteam");
const transport_1 = require("./transport");
const backfill_1 = require("./backfill");
const contactEvidence_1 = require("../trust/contactEvidence");
const GOAL_SUMMARY_MAX_CHARS = 200;
function storeForProfile(ctx, profile) {
    if (ctx.storeForProfile)
        return ctx.storeForProfile(profile);
    return (0, store_1.createGroupTaskStore)((0, paths_1.resolveMetabotPaths)(profile.homeDir));
}
async function requireProfile(ctx, slug) {
    const profile = await ctx.getProfile(slug.trim());
    if (!profile) {
        throw new service_1.GroupTaskServiceError('profile_not_found', `MetaBot profile not found: ${slug}`);
    }
    return profile;
}
async function inviteRemoteMember(ctx, chairSlug, taskId, input) {
    if (!ctx.sendPrivateMessage) {
        throw new service_1.GroupTaskServiceError('openteam_unavailable', 'Private-message sending is not wired in this context; OpenTeam invites are unavailable');
    }
    const invitee = input.globalMetaId.trim();
    if (!invitee) {
        throw new service_1.GroupTaskServiceError('invitee_required', 'Invitee GlobalMetaID is required');
    }
    const chair = await requireProfile(ctx, chairSlug);
    const store = storeForProfile(ctx, chair);
    const task = await store.getTaskById(taskId);
    if (!task) {
        throw new service_1.GroupTaskServiceError('task_not_found', `Group task ${taskId} not found`);
    }
    if (task.status === 'done' || task.status === 'cancelled') {
        throw new service_1.GroupTaskServiceError('task_terminal', `Group task ${taskId} is ${task.status}`);
    }
    if (!task.groupId) {
        throw new service_1.GroupTaskServiceError('group_missing', `Group task ${taskId} has no on-chain group id`);
    }
    const chairGmid = (chair.globalMetaId ?? '').trim();
    if (!chairGmid) {
        throw new service_1.GroupTaskServiceError('chair_identity_missing', `Chair ${chair.slug} has no GlobalMetaID`);
    }
    if (invitee.toLowerCase() === chairGmid.toLowerCase()) {
        throw new service_1.GroupTaskServiceError('cannot_invite_self', 'The chair cannot invite itself');
    }
    const members = await store.listMembers(taskId);
    const alreadyMember = members.some((member) => (member.globalMetaId ?? '').trim().toLowerCase() === invitee.toLowerCase());
    if (alreadyMember && input.via !== 'team') {
        throw new service_1.GroupTaskServiceError('already_member', `${invitee} is already a member of task ${taskId}`);
    }
    const openteam = (0, service_1.openteamStoreFor)(ctx, chair);
    const existing = await openteam.listInvites(taskId);
    const duplicate = existing.find((invite) => invite.inviteeGlobalMetaId.toLowerCase() === invitee.toLowerCase()
        && (invite.status === 'pending' || !input.allowReinvite));
    if (duplicate) {
        throw new service_1.GroupTaskServiceError(duplicate.status === 'pending' ? 'invite_pending' : 'already_invited', `${invitee} already has a ${duplicate.status} invite for task ${taskId}`
            + (duplicate.status === 'pending' ? '' : ' (pass allowReinvite to send another)'));
    }
    const inviteId = (0, openteam_1.generateOpenTeamInviteId)();
    const goalSummary = task.goal.trim().slice(0, GOAL_SUMMARY_MAX_CHARS);
    const requiredSkills = (input.requiredSkills ?? []).map((skill) => skill.trim()).filter(Boolean);
    const expiresAt = Math.floor(Date.now() / 1000) + openteam_1.OPENTEAM_INVITE_TTL_SECONDS;
    const plaintext = (0, openteam_1.buildOpenTeamInviteMessage)({
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
async function listOpenTeamInvites(ctx, chairSlug, taskId) {
    const chair = await requireProfile(ctx, chairSlug);
    return (0, service_1.openteamStoreFor)(ctx, chair).listInvites(taskId);
}
/** Guest-side external collaborations across every local profile. */
async function listOpenTeamCollabs(ctx) {
    const profiles = await ctx.listProfiles();
    const view = { memberships: [], guestInvites: [] };
    for (const profile of profiles) {
        const store = (0, service_1.openteamStoreFor)(ctx, profile);
        let memberships;
        let guestInvites;
        try {
            memberships = await store.listMemberships();
            guestInvites = await store.listGuestInvites();
        }
        catch {
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
/**
 * Read-only transcript for a group this profile joined as a guest. Syncs the
 * guest-side cache from the indexer first (best effort); trust set comes from
 * the live indexer member list.
 */
async function listOpenTeamCollabMessages(ctx, slug, groupId, options) {
    const profile = await requireProfile(ctx, slug);
    const openteam = (0, service_1.openteamStoreFor)(ctx, profile);
    const membership = await openteam.getMembership(groupId, profile.slug);
    if (!membership) {
        throw new service_1.GroupTaskServiceError('membership_not_found', `Bot ${slug} has no OpenTeam membership for group ${groupId}`);
    }
    const store = storeForProfile(ctx, profile);
    try {
        const memberIds = await (0, transport_1.fetchGroupMembers)(groupId, ctx.transport);
        await (0, backfill_1.syncGroupMessages)({
            store,
            groupId,
            trustedGlobalMetaIds: new Set((memberIds ?? []).map((id) => id.trim().toLowerCase())),
            transport: ctx.transport,
        });
    }
    catch (error) {
        ctx.log?.(`[OpenTeam] Guest transcript sync failed for group ${groupId}: `
            + `${error instanceof Error ? error.message : String(error)}`);
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
async function executeGuestAccept(input) {
    const { ctx, profile, openteam, invite, via } = input;
    if (!ctx.sendPrivateMessage) {
        throw new service_1.GroupTaskServiceError('openteam_unavailable', 'Private-message sending is not wired in this context; OpenTeam invites are unavailable');
    }
    const signer = await ctx.signerForSlug(profile.slug);
    const { pinId: joinedPinId } = await (0, transport_1.joinGroupOnChain)(signer, invite.groupId);
    const existing = await openteam.getGuestInviteByInviteId(invite.inviteId);
    if (existing) {
        await openteam.updateGuestInvite(invite.inviteId, { status: 'accepted', joinedPinId });
    }
    else {
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
        content: (0, openteam_1.buildOpenTeamAcceptMessage)(invite.inviteId, joinedPinId),
    });
    return { joinedPinId, membership };
}
/** Locate one guest-invite record across every local profile. */
async function findGuestInviteAcrossProfiles(ctx, inviteId) {
    const normalized = inviteId.trim();
    if (!normalized)
        return null;
    for (const profile of await ctx.listProfiles()) {
        const record = await (0, service_1.openteamStoreFor)(ctx, profile).getGuestInviteByInviteId(normalized)
            .catch(() => null);
        if (record)
            return { record, profile };
    }
    return null;
}
/** Guest-side invites across every local profile, for the approval surface. */
async function listGuestInvitesAcrossProfiles(ctx) {
    const profiles = await ctx.listProfiles();
    const rows = [];
    for (const profile of profiles) {
        const invites = await (0, service_1.openteamStoreFor)(ctx, profile).listGuestInvites().catch(() => []);
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
async function approveGuestInvite(ctx, inviteId) {
    const found = await findGuestInviteAcrossProfiles(ctx, inviteId);
    if (!found || found.record.status !== 'pending_approval') {
        throw new service_1.GroupTaskServiceError('invite_not_pending', `No pending guest invite found: ${inviteId.trim() || '<missing>'}`);
    }
    const { record, profile } = found;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (record.expiresAt + openteam_1.OPENTEAM_EXPIRY_SKEW_SECONDS < nowSeconds) {
        await (0, service_1.openteamStoreFor)(ctx, profile).updateGuestInvite(record.inviteId, {
            status: 'expired',
            declineReason: 'invite_expired',
        }).catch(() => undefined);
        throw new service_1.GroupTaskServiceError('invite_expired', `Invite ${record.inviteId} expired at ${new Date(record.expiresAt * 1000).toISOString()} and cannot be approved.`);
    }
    const { joinedPinId } = await executeGuestAccept({
        ctx,
        profile,
        openteam: (0, service_1.openteamStoreFor)(ctx, profile),
        invite: record,
        via: 'openteam',
    });
    const systemHomeDir = (0, paths_1.resolveMetabotPaths)(profile.homeDir).systemHomeDir;
    await (0, contactEvidence_1.markContact)(systemHomeDir, record.inviterGlobalMetaId).catch(() => undefined);
    const updated = await (0, service_1.openteamStoreFor)(ctx, profile).getGuestInviteByInviteId(record.inviteId);
    return { record: updated ?? record, profile, joinedPinId };
}
/** Decline a pending guest invite: record the decision and notify the inviter. */
async function declineGuestInviteById(ctx, inviteId, reason) {
    const found = await findGuestInviteAcrossProfiles(ctx, inviteId);
    if (!found || found.record.status !== 'pending_approval') {
        throw new service_1.GroupTaskServiceError('invite_not_pending', `No pending guest invite found: ${inviteId.trim() || '<missing>'}`);
    }
    const { record, profile } = found;
    const declineReason = reason?.trim() || 'declined_by_owner';
    await (0, service_1.openteamStoreFor)(ctx, profile).updateGuestInvite(record.inviteId, {
        status: 'declined',
        declineReason,
    });
    if (ctx.sendPrivateMessage) {
        try {
            await ctx.sendPrivateMessage({
                fromSlug: profile.slug,
                toGlobalMetaId: record.inviterGlobalMetaId,
                content: (0, openteam_1.buildOpenTeamDeclineMessage)(record.inviteId, declineReason),
            });
        }
        catch (error) {
            ctx.log?.(`[OpenTeam] Decline reply failed for invite ${record.inviteId}: `
                + `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const updated = await (0, service_1.openteamStoreFor)(ctx, profile).getGuestInviteByInviteId(record.inviteId);
    return { record: updated ?? record, profile };
}
