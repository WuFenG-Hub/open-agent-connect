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
import { type GroupTaskProfileRef, type GroupTaskServiceContext } from './service';
import type { OpenTeamGuestInviteRecord, OpenTeamInviteRecord, OpenTeamMembershipRecord, OpenTeamMemberVia, OpenTeamStore } from './openteamStore';
import type { GroupTaskMessage } from './types';
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
export declare function inviteRemoteMember(ctx: GroupTaskServiceContext, chairSlug: string, taskId: number, input: InviteRemoteMemberInput): Promise<OpenTeamInviteRecord>;
export declare function listOpenTeamInvites(ctx: GroupTaskServiceContext, chairSlug: string, taskId: number): Promise<OpenTeamInviteRecord[]>;
export interface OpenTeamCollabSummary extends OpenTeamMembershipRecord {
    /** Display name of the local profile that joined. */
    botName: string;
}
export interface OpenTeamCollabsView {
    memberships: OpenTeamCollabSummary[];
    guestInvites: Array<OpenTeamGuestInviteRecord & {
        slug: string;
        botName: string;
    }>;
}
/** Guest-side external collaborations across every local profile. */
export declare function listOpenTeamCollabs(ctx: GroupTaskServiceContext): Promise<OpenTeamCollabsView>;
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
export declare function listOpenTeamCollabMessages(ctx: GroupTaskServiceContext, slug: string, groupId: string, options?: {
    limit?: number;
}): Promise<OpenTeamCollabMessagesResult>;
/**
 * The shared guest-side accept path (trust tiers P4b): sign the simplegroupjoin
 * ourselves, record the accepted invite (created when absent — the engine's
 * auto-accept path; updated when present — the pending-approval path), create
 * the membership, and reply ACCEPT to the inviter. Used by the engine's
 * auto-accept AND by the human approval verb so both flows stay identical.
 */
export declare function executeGuestAccept(input: {
    ctx: GroupTaskServiceContext;
    profile: GroupTaskProfileRef;
    openteam: OpenTeamStore;
    invite: OpenTeamGuestInviteRecord;
    via: OpenTeamMemberVia;
}): Promise<{
    joinedPinId: string;
    membership: OpenTeamMembershipRecord;
}>;
export interface GuestInviteWithProfile {
    record: OpenTeamGuestInviteRecord;
    profile: GroupTaskProfileRef;
}
/** Locate one guest-invite record across every local profile. */
export declare function findGuestInviteAcrossProfiles(ctx: GroupTaskServiceContext, inviteId: string): Promise<GuestInviteWithProfile | null>;
/** Guest-side invites across every local profile, for the approval surface. */
export declare function listGuestInvitesAcrossProfiles(ctx: GroupTaskServiceContext): Promise<Array<OpenTeamGuestInviteRecord & {
    slug: string;
    botName: string;
}>>;
/**
 * Approve a pending guest invite (trust tiers P4b): re-validate expiry, run
 * the shared accept path, then record the inviter as a contact — approving a
 * stranger invite is exactly the explicit human approval the contact tier
 * means.
 */
export declare function approveGuestInvite(ctx: GroupTaskServiceContext, inviteId: string): Promise<GuestInviteWithProfile & {
    joinedPinId: string;
}>;
/** Decline a pending guest invite: record the decision and notify the inviter. */
export declare function declineGuestInviteById(ctx: GroupTaskServiceContext, inviteId: string, reason?: string): Promise<GuestInviteWithProfile>;
