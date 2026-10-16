# 09. SimpleTrust (`/protocols/simpletrust`)

> Status: draft (Open Agent Connect trust tiers P2, branch `feat-trust-tiers`).
> Companion protocols: owner binding (`07-owner-binding.md`, the
> Bot → Device → Owner chain these grants sit on top of), blocklist
> (`04-chat-messaging.md` §3).

An Owner declares which **other owners** it trusts by publishing append-only
`/protocols/simpletrust` pins. Trust grants follow the owner across devices
(they are read from chain), are append-only (no mutable list is ever
rewritten), and are self-authenticating: the pin's on-chain signature by the
owner key IS the consent. No grantee signature is required — trust is a
unilateral decision of the granting side.

## Path

`/protocols/simpletrust` — `application/json` (SDD 7-tuple, `operation: create`,
`encryption: 0`, `version: 1.0`).

## Grant payload

```json
{
  "version": 1,
  "trustedOwner": "idq1<trustedOwnerGlobalMetaId>",
  "note": "optional human-readable reason",
  "ts": 1730000000
}
```

| field | meaning |
|---|---|
| `version` | payload version, currently `1` |
| `trustedOwner` | the trusted owner's GlobalMetaID (P2PKH flavor, `idq1...`) |
| `note` | optional, ≤280 chars, human-readable reason for the grant |
| `ts` | unix seconds when the grant was published |

## Revoke payload

```json
{
  "version": 1,
  "revoke": "<grantPinId>",
  "ts": 1730000000
}
```

A revoke pin **names the exact grant pinId it cancels**. This mirrors the
established in-repo revoke conventions: like `simpleblock` the history is
append-only and the current state is derived by folding the whole pin set,
and like metatask/metaapp amendments a revocation references its target
precisely — here the grant pinId, so a revoke only ever cancels the grant it
names and can never reach across to another grant.

Rules:

- A revoke naming an **unknown or already-revoked grant pinId is a no-op**:
  it cancels nothing but is still published — the append-only audit trail
  records that the owner tried.
- There is no mutable grant list anywhere; changing the owner re-binds by
  publishing a new grant pin, exactly like `/info/owner`.

## Resolution (grants minus revokes)

Given all pins an owner published at `/protocols/simpletrust`:

1. Parse every payload; skip malformed pins (treat as absent).
2. Collect the set of revoked grant pinIds from all `revoke` pins.
3. Effective grants = every grant pin whose pinId is NOT in the revoked set.
4. **Dedupe per `trustedOwner`**: one entry per trusted owner, the NEWEST
   grant's `note`/`ts`/`grantPinId` winning.
5. The effective trust set is the sorted list of those entries.

Because grants are append-only and revokes are pinId-precise, re-granting
after a revoke is simply publishing a new grant pin: the old (revoked) grant
stays cancelled, the new grant stands.

## Verification (offline, self-contained)

A resolved grant entry is trustworthy without any chain query beyond reading
the pins themselves:

1. The pin was published at `/protocols/simpletrust` by the granting owner's
   address (pin metadata carries the creator's address/globalMetaId) — the
   on-chain pin signature proves owner consent.
2. `trustedOwner` decodes as a valid GlobalMetaID.
3. The grant pinId is not named by any (later or earlier) revoke pin from
   the same owner.

Callers that need "is owner X in owner Y's trust set?" therefore only read
Y's pins and fold them; no server-side trust is involved.

## Notes for implementers

- Reference implementation: OAC `src/core/trust/trustGrantPins.ts`
  (build/parse/publish) and `src/core/trust/trustedOwnerResolver.ts`
  (resolution + caching).
- The grant key is the same identity key as `/info/owner` bindings
  (MVC/identity secp256k1, default path `m/44'/10001'/0'/0/0`).
- Pin writes cost micro-fees; publishers should attempt the idempotent MVC
  gas subsidy for the owner address first and surface an actionable top-up
  error when a write fails (same policy as `/info/owner` pins).
- Consumers should cache the folded set per owner gmid, keyed by the newest
  pinId, and refold when it changes (see the trust-cache in OAC
  `src/core/trust/`).
- Mutual ("friend") pins and encrypted grant entries are explicit future
  work; this protocol is intentionally one-directional and plaintext.
