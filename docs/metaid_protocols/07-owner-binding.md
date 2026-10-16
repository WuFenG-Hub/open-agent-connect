# 07. MetaBot Owner Binding (`/info/owner`)

> Status: draft (IDBots `feat/human-identity-metabot-binding`). To be merged into `open-agent-connect/docs/metaid_protocols`.
>
> **Amendment 2026-10-16 (generalized semantics):** the `/info/owner` pin is
> no longer Bot-specific. *The `/info/owner` of X is the identity directly
> accountable for X*: for a Bot that is its Device; for a Device it is its
> Owner. The wire format, signed message, payload, and offline verification
> below are unchanged and fully generic in the subject — any MetaID (Bot,
> Device, or future identity kinds) publishes the same pin shape, and
> verifiers substitute the publisher's GlobalMetaID for `<botGlobalMetaId>`.
> See "Generalized semantics" at the end of this document. Owner→owner trust
> grants layered on top of these chains live in `09-simpletrust.md`.

A MetaBot declares its human owner by publishing an `/info/owner` pin whose
payload embeds the owner's cryptographic consent. The binding is two-party by
construction:

- **MetaBot side** — the pin itself is created and signed on-chain by the
  MetaBot's own key (pin metadata carries the creator's address/globalMetaId).
- **Owner side** — the payload embeds the human owner's signature over the
  binding statement, made with the owner's MetaID identity key.

Bot Info semantics apply: the **latest** pin at `/info/owner` for a MetaBot is
the current binding. An empty payload means *unbound*.

## Path

`/info/owner` — `application/json` (SDD 7-tuple, `operation: create`,
`encryption: 0`, `version: 1.0`).

## Signed message

```
metabot-owner-binding:<botGlobalMetaId>
```

- Lowercase; the prefix domain-separates the statement so the signature cannot
  be replayed into other protocols.
- The signed message MUST contain the GlobalMetaID of the MetaBot that
  publishes the pin (verifiers check this — see below), which prevents
  re-attaching a signature collected for a different bot.

## Payload

```json
{
  "version": 1,
  "owner": "idq1<ownerGlobalMetaId>",
  "ownerPublicKey": "02<33-byte compressed secp256k1 pubkey hex>",
  "signedMessage": "metabot-owner-binding:idq1<botGlobalMetaId>",
  "signature": "<base64, 65-byte compact recoverable signature>",
  "algorithm": "ecdsa-secp256k1-bitcoin-message"
}
```

| field | meaning |
|---|---|
| `version` | payload version, currently `1` |
| `owner` | owner's GlobalMetaID (P2PKH flavor, `idq1...`) |
| `ownerPublicKey` | owner's compressed secp256k1 public key, hex |
| `signedMessage` | the exact byte string that was signed |
| `signature` | Bitcoin Signed Message signature (base64, 65 bytes: header ‖ r ‖ s) |
| `algorithm` | `ecdsa-secp256k1-bitcoin-message` |

Unbind: publish an `/info/owner` pin with an **empty payload**.

## Verification (offline, self-contained)

Given the MetaBot's GlobalMetaID and its latest `/info/owner` pin payload:

1. Parse the payload; require `version == 1` and
   `algorithm == "ecdsa-secp256k1-bitcoin-message"`.
2. Require `signedMessage == "metabot-owner-binding:<botGlobalMetaId>"` for
   **this** MetaBot.
3. Decode `owner` (GlobalMetaID, id-address format) to its 20-byte P2PKH
   payload. Require `hash160(ownerPublicKey) == payload`. This proves the
   public key belongs to the declared owner GlobalMetaID.
4. Verify `signature` as a Bitcoin Signed Message over `signedMessage` with
   `ownerPublicKey` (magic prefix `"Bitcoin Signed Message:\n"`, double
   SHA-256, secp256k1 ECDSA).

No chain queries are needed: GlobalMetaID embeds the owner's pubkey hash, and
the payload carries everything else.

## Notes for implementers

- The owner's identity key is the MVC/identity secp256k1 key derived from the
  owner's mnemonic (default path `m/44'/10001'/0'/0/0`); this is the same key
  whose hash is encoded in the owner GlobalMetaID.
- Reference implementation (sign & verify): IDBots
  `src/main/services/ownerBindingService.ts`; OAC
  `src/core/owner/ownerBinding.ts` (`signOwnerBinding` / `verifyOwnerBinding`).
- Changing the owner publishes a new `/info/owner` pin that supersedes the
  previous one; historical pins remain on-chain for audit.

## Generalized semantics (amendment 2026-10-16)

The `/info/owner` path answers one question: *who is directly accountable
for this identity?* The pin format above already answers it for any subject;
this amendment makes the layered reading explicit (trust tiers design,
`docs/superpowers/specs/2026-10-16-trust-tiers-permission-matrix-design.md`):

- **Bot → Device**: a Bot publishes an `/info/owner` pin whose `owner` (and
  embedded signature) is its Device Identity — the machine-wide MetaID
  identity OAC auto-creates per install (`~/.metabot/owner/identity.json`;
  formerly called the "owner identity", semantically renamed Device
  Identity, no data migration). This is the exact behavior described in the
  sections above.
- **Device → Owner**: the Device Identity — itself a MetaID — publishes the
  same `/info/owner` pin shape with the **Owner Identity** (the human's
  portable, machine-wide identity at `~/.metabot/owner/root-owner-identity.json`)
  as `owner`, signing `metabot-owner-binding:<deviceGlobalMetaId>` with the
  owner key. Two-party by construction, exactly like the Bot binding: the
  pin is signed on-chain by the device key, the payload signature proves the
  owner's consent. Unbind is the same empty payload.
- **Root owner**: walking `/info/owner` upward from any Bot — at most
  Bot → Device → Owner, verifying every hop offline as described above —
  yields the root owner. Devices never bound to an owner terminate the walk
  at the device itself, so legacy installs keep today's behavior.

Because verification is offline and self-contained, any third party can
confirm both hops without trusting the publisher: each hop's payload binds
the next identity's pubkey hash (GlobalMetaID) and carries its signature
over the subject's GlobalMetaID.
