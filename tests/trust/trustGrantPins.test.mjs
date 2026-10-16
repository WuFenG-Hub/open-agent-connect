import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const {
  buildTrustGrantPayload,
  buildTrustRevokePayload,
  parseSimpletrustPin,
  publishTrustGrant,
  publishTrustRevoke,
  SIMPLETRUST_PATH,
  SIMPLETRUST_VERSION,
  TrustGrantError,
} = require('../../dist/core/trust/trustGrantPins.js');
const { createRootOwnerIdentity } = require('../../dist/core/owner/rootOwnerIdentity.js');
const { createOwnerIdentity } = require('../../dist/core/owner/ownerIdentity.js');

const PEER_OWNER = 'idq1peerowner0000000000000000000000000';
const GRANT_PIN_ID = 'ab'.repeat(32) + 'i0';

test('grant payload builds and parses (roundtrip, with and without note)', () => {
  const withNote = buildTrustGrantPayload({ trustedOwner: PEER_OWNER, note: '  audited collaborator  ', ts: 1730000000 });
  const parsed = parseSimpletrustPin(withNote);
  assert.deepEqual(parsed, {
    kind: 'grant',
    trustedOwner: PEER_OWNER,
    note: 'audited collaborator',
    ts: 1730000000,
  });

  const withoutNote = buildTrustGrantPayload({ trustedOwner: PEER_OWNER.toUpperCase(), ts: 1730000001.7 });
  const parsedNoNote = parseSimpletrustPin(withoutNote);
  assert.equal(parsedNoNote.kind, 'grant');
  assert.equal(parsedNoNote.trustedOwner, PEER_OWNER, 'gmids normalize to lowercase');
  assert.equal(parsedNoNote.note, undefined);
  assert.equal(parsedNoNote.ts, 1730000001, 'ts floors to whole seconds');
});

test('revoke payload builds and parses, and round-trips through parse as kind revoke', () => {
  const raw = buildTrustRevokePayload({ revoke: GRANT_PIN_ID, ts: 1730000100 });
  assert.deepEqual(parseSimpletrustPin(raw), { kind: 'revoke', revoke: GRANT_PIN_ID, ts: 1730000100 });
});

test('parser rejects malformed, wrong-version, and grant/revoke hybrids', () => {
  assert.equal(parseSimpletrustPin('not json'), null);
  assert.equal(parseSimpletrustPin(null), null);
  assert.equal(parseSimpletrustPin(JSON.stringify({ version: 2, trustedOwner: PEER_OWNER, ts: 1 })), null);
  assert.equal(parseSimpletrustPin(JSON.stringify({ version: 1, ts: 1 })), null);
  assert.equal(parseSimpletrustPin(JSON.stringify({ version: 1, trustedOwner: PEER_OWNER })), null, 'ts required');
  assert.equal(parseSimpletrustPin(JSON.stringify({ version: 1, trustedOwner: 'bogus', ts: 1 })), null);
  // A pin cannot be both a grant and a revoke: revoke wins and the grant fields are ignored.
  const hybrid = parseSimpletrustPin(JSON.stringify({ version: 1, trustedOwner: PEER_OWNER, revoke: GRANT_PIN_ID, ts: 1 }));
  assert.equal(hybrid.kind, 'revoke');
});

test('builders reject invalid targets', () => {
  assert.throws(
    () => buildTrustGrantPayload({ trustedOwner: 'not-a-gmid', ts: 1 }),
    (error) => error instanceof TrustGrantError && error.code === 'invalid_trusted_owner',
  );
  assert.throws(
    () => buildTrustRevokePayload({ revoke: '  ', ts: 1 }),
    (error) => error instanceof TrustGrantError && error.code === 'invalid_revoke_target',
  );
});

function fakeSigner() {
  const calls = [];
  return {
    calls,
    signer: {
      getIdentity: async () => { throw new Error('not used'); },
      getPrivateChatIdentity: async () => { throw new Error('not used'); },
      writePin: async (request) => {
        calls.push(request);
        return {
          txids: ['cc'.repeat(32)],
          pinId: 'cc'.repeat(32) + 'i0',
          totalCost: 100,
          network: 'mvc',
          operation: 'create',
          path: request.path,
          contentType: request.contentType,
          encoding: request.encoding,
          globalMetaId: 'idq1owner',
          mvcAddress: 'fake-address',
        };
      },
    },
  };
}

test('publishTrustGrant writes a create pin at /protocols/simpletrust', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-grant-');
  const owner = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const { signer, calls } = fakeSigner();
  const subsidyCalls = [];

  const result = await publishTrustGrant({
    owner,
    trustedOwner: PEER_OWNER,
    note: 'collab',
    ts: 1730000000,
    signer,
    requestSubsidy: async (options) => {
      subsidyCalls.push(options);
      return { success: true };
    },
  });

  assert.equal(result.chainWrite.pinId.endsWith('i0'), true);
  assert.equal(result.subsidy.requested, true);
  assert.equal(result.subsidy.success, true);
  assert.equal(subsidyCalls[0].mvcAddress, owner.mvcAddress);

  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.path, SIMPLETRUST_PATH);
  assert.equal(request.path, '/protocols/simpletrust');
  assert.equal(request.operation, 'create');
  assert.equal(request.contentType, 'application/json');
  assert.equal(request.network, 'mvc');
  assert.deepEqual(parseSimpletrustPin(request.payload), {
    kind: 'grant',
    trustedOwner: PEER_OWNER,
    note: 'collab',
    ts: 1730000000,
  });
  assert.equal(SIMPLETRUST_VERSION, 1);
});

test('publishTrustRevoke writes the revoke payload and keeps the funding policy', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-grant-');
  const owner = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const { signer, calls } = fakeSigner();

  const result = await publishTrustRevoke({
    owner,
    revoke: GRANT_PIN_ID,
    ts: 1730000500,
    signer,
    // Subsidy fails but the write succeeds (wallet already funded) — no abort.
    requestSubsidy: async () => ({ success: false, error: 'subsidy service unreachable' }),
  });

  assert.equal(result.subsidy.success, false);
  assert.equal(result.chainWrite.pinId.length > 0, true);
  assert.deepEqual(parseSimpletrustPin(calls[0].payload), { kind: 'revoke', revoke: GRANT_PIN_ID, ts: 1730000500 });
});

test('publishTrustGrant rejects an invalid trustedOwner before any write', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-grant-');
  const owner = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const { signer, calls } = fakeSigner();

  await assert.rejects(
    () => publishTrustGrant({ owner, trustedOwner: 'bogus', signer }),
    (error) => error instanceof TrustGrantError && error.code === 'invalid_trusted_owner',
  );
  assert.equal(calls.length, 0);
});

test('device identity can publish its own pins through the same grant machinery', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-grant-');
  const device = await createOwnerIdentity(systemHomeDir, { name: 'Device' });
  const { signer, calls } = fakeSigner();
  await publishTrustGrant({ owner: device, trustedOwner: PEER_OWNER, signer });
  assert.equal(calls[0].path, '/protocols/simpletrust');
});
