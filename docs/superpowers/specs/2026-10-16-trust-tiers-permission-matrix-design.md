# Trust Tiers & Permission Matrix Design (Bot → Device → Owner)

**Date:** 2026-10-16
**Status:** Draft — in implementation on branch `feat-trust-tiers`
**(updated 2026-10-16): P1 landed** — Owner Identity CRUD
(`src/core/owner/rootOwnerIdentity.ts`), device→owner binding publish
(`src/core/owner/deviceOwnerBinding.ts`), root-owner resolver + trust cache
(`src/core/trust/`), `metabot owner` CLI + `/api/owner/*` daemon routes,
`07-owner-binding.md` generalized semantics, and this storage amendment.
**(updated 2026-10-16): P2 landed** — on-chain trust grants
(`/protocols/simpletrust` build/parse/publish/resolve + cache in
`src/core/trust/`, protocol doc `09-simpletrust.md`), local block/contact
store (`trust-local.json`), contact evidence from private-chat state,
`metabot trust` + `metabot block` CLIs with `/api/trust/*` + `/api/block/*`
daemon routes, and a generalized non-profile identity pin publisher
(`identityChainPublisher.ts`).
**(updated 2026-10-16): P3 landed** — pure decision layer: peer tier
resolver (`peerTrustResolver.ts`, spec precedence + short-TTL tier cache,
block/contacts fresh-read, invalidation wired into the trust/block daemon
handlers), capability classes + exact permission matrix
(`capabilityClasses.ts`), built-in skill→class registry
(`src/core/services/skillCapabilityClasses.ts`, unknown → C3), and the
policy engine (`trustPolicy.ts`: `evaluatePeerPolicy` with per-context
accept defaults + `trust.skillClassOverrides` / `trust.chatTrustPolicy`
per-profile config plumbed through `metabot config get/set`).
Not yet landed: P4 enforcement (chat ingress, invite acceptance,
group-task seating), P5 final CLI naming.
**(updated 2026-10-16): P4a landed** — private-chat ingress enforcement:
`handleInboundMessage` consults `evaluatePeerPolicy` (context `chat`) before
the auto-reply turn for `private_chat` messages; `auto` replies with the
tier-filtered skill set threaded through the existing allowed-skills resolver
(no runner-safeguard bypass); `queue` pauses the conversation and surfaces the
message via the existing pending-guidance mechanism (a human-guided turn
consumes it — no new queue UI); `ignore`/`decline` persist record-only with
no turn and no wake; wake turns and backfill retries re-drive PEER messages
and consult the same policy (non-auto drops the re-drive); evaluator failures
fail safe as stranger-with-no-skills (`trust_policy_failed` log event).
**Grok relay decision:** the Grok-webhook relay path
(`recordExternallyRelayedInbound`) is unchanged — relayed profiles delegate
judgment to the bound assistant (its own model decides), and the tier policy
gates the local auto-reply path only.
Not yet landed: P4b (OpenTeam invite acceptance), P4c (group-task team
seating), P5 final CLI naming.

## Goal

Let a user who installs OAC on several agent platforms (Codex on one machine,
Claude Code on another, Grok Bot in the cloud) schedule all of their Bots as
one team from any client: dispatch work across devices, and convene Bots from
different devices into one group task — while strangers stay safely restricted.

This is fundamentally a permission problem. Permissionless on-chain messaging
already works; what is missing is a trust/authorization layer that decides what
a remote Bot may make a local Bot do. This document defines:

1. A three-layer identity model: **Bot → Device Identity → Owner Identity**.
2. **Trust tiers** derived from that model plus explicit trust grants.
3. **Capability classes** for everything a Bot can do, and the **permission
   matrix** mapping tiers to classes.
4. The **enforcement points** where the matrix is applied.

## Non-Goals (M1)

- Bot identity import/restore; running one Bot identity on two devices. Bots
  are never shared across devices — each device has its own Bot identities.
- On-chain `simpleblock` implementation (M1 uses a local blocklist).
- Owner↔owner mutual "friend" handshake, encrypted trust entries, bot-level
  friendships.
- Service-order caller authorization and provider order approval queues (M2;
  M1 documents the hook but changes nothing in the order path).
- Remote device pairing (binding a device without the owner mnemonic present).
- Physical rename of `~/.metabot/owner/` (semantic rename only; see Storage).

## Existing Foundations (verified at branch point)

- **Device identity** (today called "owner identity"): one machine-wide MetaID
  keypair at `~/.metabot/owner/identity.json`, auto-provisioned on onboarding,
  importable by mnemonic (`src/core/owner/ownerIdentity.ts`).
- **Bot→device binding**: every Bot publishes a two-party signed `/info/owner`
  pin; offline verification already implemented
  (`src/core/owner/ownerBinding.ts`, `verifyOwnerBinding`; protocol doc
  `docs/metaid_protocols/07-owner-binding.md`). Bot create binds the machine
  identity and publishes the pin automatically.
- **Private chat**: any MetaID can message any Bot; inbound is authenticated
  but not authorized (`acceptPolicy: 'accept_all'` only); the default handling
  is LLM auto-reply with per-Bot capability scoping (`allowChatSkills`,
  `/info/chatSkills` pin) and rate limits.
- **Group tasks**: local workers seated by slug (same machine only); remote
  members join as OpenTeam guests whose invites are **auto-accepted** after
  validating inviter == on-chain group creator
  (`src/core/grouptask/engine.ts` `handleGuestInvite`). Trusted-sender set =
  members + owner; others are marked `senderSuspect` and ignored.
- **Nothing consults the owner binding for any authorization decision today.**

## Identity Model: Bot → Device → Owner

### Semantic demotion (no data migration)

The identity OAC auto-creates per install — currently called the "owner
identity" — is renamed **Device Identity**. This is a semantic and
documentation/UI rename only:

- Physical paths are unchanged (`~/.metabot/owner/identity.json` etc.).
- Every existing Bot `/info/owner` pin remains valid; its meaning becomes
  "this Bot is accountable to this Device". No re-publishing, no migration.
- Fresh installs keep the zero-touch flow: auto-create Device Identity, Bots
  bind to it automatically.

### Owner Identity (new top layer)

The **Owner Identity** is the human's portable identity. It is created or
imported (mnemonic) explicitly, and a device is bound to it as an additive,
optional step — no existing identity is abandoned or merged.

- Stored at `~/.metabot/owner/root-owner-identity.json` (0600), same record
  shape as the device identity. At most one per machine.
- **Device→Owner binding**: the Device Identity (itself a MetaID) publishes an
  `/info/owner` pin whose payload embeds the Owner's signature over
  `metabot-owner-binding:<deviceGlobalMetaId>` — the exact wire format and
  verification of `07-owner-binding`, with the Device as subject. Two-party by
  construction: pin signed by the device key, payload signature by the owner
  key. Unbind = empty payload. (`07-owner-binding.md` will be amended to state
  the generalized semantics: *the `/info/owner` of X is the identity directly
  accountable for X — for a Bot, its Device; for a Device, its Owner*.)

### Root-owner resolution

```
resolveRootOwner(botGlobalMetaId) → rootOwnerGlobalMetaId
```

Walk the `/info/owner` chain upward from the Bot, at most 2 hops
(Bot → Device → Owner), verifying each pin offline with `verifyOwnerBinding`.
The terminal verified gmid is the **root owner**. Legacy installs where the
device was never bound to an owner terminate at the device itself, which
reproduces today's behavior exactly. Results are cached in
`~/.metabot/owner/trust-cache.json` keyed by subject gmid + pinId, so chain
reads happen once per binding change.

> Implementation note: device/owner identities currently hold no chain funds.
> Publishing binding/trust pins needs micro-fees — reuse the subsidy flow or
> an explicit top-up; decided in P1/P2 implementation.

## Trust Tiers

```
resolvePeerTrustTier(peerGlobalMetaId) →
    'local' | 'team' | 'trusted' | 'contact' | 'stranger' | 'blocked'
```

| tier | definition |
|---|---|
| `local` | Peer is a profile on this device (today's implicit full trust, unchanged). |
| `team` | Peer's root owner == my root owner. Cryptographically provable both directions (peer Bot's `/info/owner` chain; my own binding). |
| `trusted` | Peer's root owner ∈ my Owner's on-chain trust grants (see below). |
| `contact` | Peer has a completed two-way private-chat exchange on record, or was explicitly approved once (e.g. an approved stranger invite), and is not blocked. |
| `stranger` | None of the above. |
| `blocked` | On the local blocklist (device-level, applies to all local Bots). |

`blocked` wins over every other tier. Tier checks are cached with the same
trust-cache; caches are invalidated by new binding/trust pinIds.

### On-chain trust grants (owner → owner)

Trust grants follow the owner across devices, so they live on-chain, and they
are **append-only** — no mutable list is ever rewritten:

- **Grant**: the Owner MetaID publishes a pin at `/protocols/simpletrust`
  (operation `create`, `application/json`): `{ "version": 1, "trustedOwner": "idq1…", "note": "…", "ts": 1730000000 }`.
- **Revoke**: another pin at the same path carrying `"revoke": "<grantPinId>"`.
- Effective trust set = latest grant state per target gmid (grants minus
  revokes). Pin signature by the owner key makes grants self-authenticating;
  no consent from the grantee is required (trust is a unilateral decision of
  the receiving side). Mutual "friend" pins and encrypted entries are future
  work. Protocol details land in `docs/metaid_protocols/09-simpletrust.md`
  (P2); the mechanics mirror `simpleblock` where applicable.

Grant/revoke are published from any device holding the owner key; all devices
resolve them from chain, so trust configuration is consistent across the
user's machines.

### Contacts and blocklist (local, M1)

- **Contact evidence** is derived from the per-profile private-chat state
  (a peer with messages in both directions), plus explicit marks recorded when
  the human approves a stranger invite.
- **Blocklist** is device-local (`~/.metabot/owner/trust-local.json`,
  `{ "blocked": [gmid…], "contacts": [gmid…] }`). On-chain `simpleblock`
  (already documented, unimplemented) replaces/merges this in M2.

## Capability Classes

Everything a Bot can do is grouped into five classes:

| class | meaning | examples |
|---|---|---|
| **C0 chat** | Plain conversational reply (the reply itself is an on-chain message) | small talk, Q&A, knowledge transfer |
| **C1 read-local** | Read-only access to local, non-chain state | bot status, rosters, local logs/KB/memory queries, schedules |
| **C2 collab** | Write inside the Bot's own sandbox (`<profile>/.runtime/` work dirs) + publish on-chain + participate in group tasks | produce artifacts in the work dir, post buzz/notes, join and work in a group task |
| **C3 write-local** | Write outside the sandbox / execute local commands / delegate to local workers | edit the user's project files, run shell, twin delegation |
| **C4 admin** | Funds and identity operations | wallet transfers, identity create/bind/unbind, trust grant/revoke |

Skill classification: a built-in registry maps known `SKILLs/*` to default
classes; per-Bot overrides live in profile config (`skillClassOverrides`).
Unknown skills default to **C3** (conservative).

## Permission Matrix

| tier | C0 chat | C1 read-local | C2 collab | C3 write-local | C4 admin |
|---|---|---|---|---|---|
| `local` (same device, human's own session) | ✓ | ✓ | ✓ | ✓ | human only |
| `team` | ✓ | ✓ | ✓ | ✓ | ✗ |
| `trusted` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `contact` | ✓ | ✗ | group-task context only | ✗ | ✗ |
| `stranger` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `blocked` | ✗ | ✗ | ✗ | ✗ | ✗ |

C4 is **never** reachable through a remote message, at any tier — it requires
the local human (CLI/UI on the device).

Design rationale (matches the product intent): team ≈ "same machine" (full
trust); trusted ≈ lightweight collaboration (read local + write chain, no
local writes); contact ≈ known peer (chat + scoped task collaboration);
stranger ≈ friendly chat only; blocked = silence.

## Enforcement Points

1. **Private chat ingress** (`privateChatAutoReply.handleInboundMessage` +
   `chatSkillPolicy`): resolve the sender's tier → allowed classes → intersect
   with the Bot's `allowChatSkills` → inject only those skills into the reply
   runner. Per-tier accept behavior (`auto` / `queue` / `ignore`) is
   configurable per profile; defaults follow the matrix.
   **Behavior change: strangers no longer get `allowChatSkills` execution by
   default (today they do).**
   **Status: implemented (P4a, 2026-10-16).** The gate runs before the
   auto-reply turn; the filtered skill set is threaded through the existing
   allowed-skills resolver (runner safeguards untouched); `queue` reuses the
   pending-guidance mechanism on a paused conversation; wake turns and
   backfill retries re-drive peer messages under the same policy; evaluator
   failures fail safe as stranger-with-no-skills. The Grok-webhook relay path
   is deliberately excluded (delegates judgment to the bound assistant).
2. **OpenTeam invite acceptance** (`grouptask/engine.handleGuestInvite`):
   after the existing validation, gate on tier — `team`/`trusted`/`contact`
   auto-accept; `stranger` is recorded as a **pending invite** (no join) and
   surfaced through `metabot grouptask invites list|approve|decline` (+ daemon
   route); `blocked` is silently declined. Approving a stranger invite
   records the inviter as a contact.
   **Behavior change: strangers are no longer silently auto-accepted.**
3. **Group-task team seating** (`grouptask/service.createGroupTask`): workers
   may be remote team Bots referenced by gmid (verified same root owner). They
   join through the existing OpenTeam transport but are recorded with
   `via: 'team'` and treated as first-class members in
   `buildTrustedGmidSet`/UI. The staffing slate may propose team Bots from the
   team registry.
4. **Service orders**: unchanged in M1. The tier resolver is the documented
   hook for M2 caller authorization (paid strangers, free calls for team, etc.).

## Discovery

Trust never depends on a roster — it is resolved from the `/info/owner` pin
chain on demand. Discovery (learning the gmids of my Bots on other devices)
is a separate, best-effort concern:

- **M1**: `metabot team list` shows local profiles plus remote team Bots that
  were (a) added manually with `metabot team add <gmid>` (verifies root owner
  on-chain before recording) or (b) auto-recorded after interacting with this
  device (chat/invite from a verified team peer).
- **M2** (optional): hierarchical, self-maintained lists — the Owner publishes
  `/info/devices` (rarely changes) and each Device publishes `/info/bots`
  (local changes only). Every identity maintains only its own list; no
  cross-device merge, no shared mutable roster.

## Storage & Config Changes

| item | path | note |
|---|---|---|
| Device identity | `~/.metabot/owner/identity.json` | existing, unchanged; semantics renamed |
| Owner identity | `~/.metabot/owner/root-owner-identity.json` (0600) | new; one per machine |
| Trust cache | `~/.metabot/owner/trust-cache.json` | resolved bindings/tiers, keyed by gmid+pinId |
| Block/contacts | `~/.metabot/owner/trust-local.json` | device-level blocklist + explicit contacts |
| Team registry | `~/.metabot/owner/team-registry.json` | remote team gmids (manual/auto-recorded) |
| Chat trust policy | per-profile config `chatTrustPolicy` | optional per-tier overrides; defaults = matrix |

The storage-layout v2 spec
(`docs/superpowers/specs/2026-04-23-metabot-storage-layout-v2-design.md`) gets
an amendment section covering the semantic rename and the new files.

## Migration & Compatibility

- No data migration. Existing `/info/owner` pins, owner identities, bot
  bindings, and configs remain valid under the new reading.
- Unbound devices (never bound to an owner) behave exactly as today: their
  root owner is themselves, so all their local Bots form a one-device team.
- Default tightening (strangers: no skills, invites pending) ships with
  per-profile config escape hatches restoring the old behavior.

## Phased Rollout (this branch)

- **P0** — this document.
- **P1** — Owner identity + device→owner binding (pin publish/verify),
  root-owner resolver + trust cache; `07-owner-binding.md` amendment.
- **P2** — On-chain trust grants (`/protocols/simpletrust` publish/resolve),
  local block/contacts store; `docs/metaid_protocols/09-simpletrust.md`.
- **P3** — Tier resolver + policy engine; skill capability registry and
  executor-level class filtering.
- **P4** — Enforcement: private-chat ingress policy, OpenTeam invite policy +
  pending-invite approval surface, group-task team seating by gmid.
- **P5** — CLI (`metabot owner`, `metabot team`, `metabot trust`,
  `metabot block`, `grouptask invites`), SKILL updates, i18n (en+zh), tests.

Test plan: unit tests for binding sign/verify, root-owner resolution (mocked
pin reads), tier matrix, invite policy matrix, chat policy defaults, skill
class registry; integration test with two temp homes bound to one owner
( Bot on home B auto-accepts home A's invite as `team`; stranger invite lands
pending ). Slow files are added to `INTEGRATION_FILES` in
`scripts/run-test-suite.mjs`.

## Open Questions

1. Fee source for device/owner pin publishing (subsidy reuse vs explicit
   micro top-up) — **P1 decision (subsidy-first with actionable fallback)**:
   `bind-device` requests the idempotent MVC gas subsidy for the device
   address before publishing (`requestMvcGasSubsidy`, the same service
   onboarding uses); a subsidy failure does not abort (the wallet may
   already be funded), but when the subsequent write then fails, the error
   tells the user exactly that the device wallet needs a manual top-up.
   Pin writes also bill the traffic sponsor hook first whenever the daemon
   has one, same as owner `/info/name` pins.
2. CLI naming: keep `metabot user *` operating on the device identity and add
   `metabot owner *` for the root owner? Final naming in P5. (P1 ships the
   minimal `metabot owner create|import|who|rename|reveal|exists|path|bind-device`
   surface; naming revision stays open.)
3. Whether `contact` C2 scope (group-task context only) needs an explicit
   sandbox-path allow-list in the executor, or the existing work-dir
   convention is sufficient — **P3 decision (convention, documented)**: the
   C2 sandbox boundary is enforced by the existing work-dir convention
   (skills operate inside `<profile>/.runtime/` work dirs; C2 is defined as
   sandbox writes + on-chain publishes), NOT by executor path-jailing. The
   policy engine exposes `context: 'grouptask'` vs `'chat'` precisely so
   `contact` receives C2 skills only in group-task context; a path-jailing
   executor is deferred until a real escape is observed — the skill
   capability registry gives a single place to tighten classes if one is.
4. Trust-cache staleness policy (P1): a cache hit inside a 5-minute TTL is
   served without any chain read; misses/expires re-walk and store the new
   pinIds; `invalidate(subject)` drops entries event-driven. Whether P4
   enforcement needs sub-TTL invalidation on binding-change events is
   decided when the enforcement points land.
