import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const { createOwnerIdentity } = require('../../dist/core/owner/ownerIdentity.js');
const { createRootOwnerIdentity } = require('../../dist/core/owner/rootOwnerIdentity.js');
const {
  signOwnerBinding,
  verifyOwnerBinding,
  OWNER_BINDING_PATH,
} = require('../../dist/core/owner/ownerBinding.js');
const {
  publishDeviceOwnerBinding,
  DeviceOwnerBindingError,
} = require('../../dist/core/owner/deviceOwnerBinding.js');

function fakeSigner(overrides = {}) {
  const calls = [];
  return {
    calls,
    signer: {
      getIdentity: async () => { throw new Error('not used by this test'); },
      getPrivateChatIdentity: async () => { throw new Error('not used by this test'); },
      writePin: async (request) => {
        calls.push(request);
        if (overrides.throwError) throw overrides.throwError;
        return {
          txids: ['faketxid00000000000000000000000000000000000000000000000000000000'],
          pinId: 'faketxid00000000000000000000000000000000000000000000000000000000i0',
          totalCost: 100,
          network: 'mvc',
          operation: 'create',
          path: request.path,
          contentType: request.contentType,
          encoding: request.encoding,
          globalMetaId: overrides.deviceGlobalMetaId ?? '',
          mvcAddress: 'fake-address',
        };
      },
    },
  };
}

test('device→owner binding signs with the root owner key over the device gmid', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-device-binding-');
  const device = await createOwnerIdentity(systemHomeDir, { name: 'Device' });
  const rootOwner = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });

  const { payload, signedMessage } = await signOwnerBinding(rootOwner, device.globalMetaId);
  assert.equal(signedMessage, `metabot-owner-binding:${device.globalMetaId}`);

  // Verifies offline against the device as the subject — the exact wire
  // format of the Bot→Device binding, generalized to any subject.
  assert.equal(verifyOwnerBinding(payload, device.globalMetaId), true);
  assert.equal(verifyOwnerBinding(payload, 'idq1someotherdevice000000000000000'), false);

  // Tampered payload: a different owner signature must not verify.
  const tampered = JSON.parse(payload);
  tampered.owner = device.globalMetaId;
  assert.equal(verifyOwnerBinding(JSON.stringify(tampered), device.globalMetaId), false);
});

test('publishDeviceOwnerBinding writes the /info/owner pin from the device signer', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-device-binding-');
  const device = await createOwnerIdentity(systemHomeDir, { name: 'Device' });
  const rootOwner = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const { signer, calls } = fakeSigner({ deviceGlobalMetaId: device.globalMetaId });

  const subsidyCalls = [];
  const result = await publishDeviceOwnerBinding({
    device,
    rootOwner,
    signer,
    requestSubsidy: async (options) => {
      subsidyCalls.push(options);
      return { success: true };
    },
  });

  assert.equal(result.chainWrite.pinId.endsWith('i0'), true);
  assert.equal(result.subsidy.requested, true);
  assert.equal(result.subsidy.success, true);
  assert.equal(subsidyCalls.length, 1);
  assert.equal(subsidyCalls[0].mvcAddress, device.mvcAddress);
  assert.equal(subsidyCalls[0].mnemonic, device.mnemonic);

  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.path, OWNER_BINDING_PATH);
  assert.equal(request.path, '/info/owner');
  assert.equal(request.operation, 'create');
  assert.equal(request.contentType, 'application/json');
  assert.equal(request.network, 'mvc');
  // The pin payload is the owner-signed binding over the device gmid.
  assert.equal(verifyOwnerBinding(request.payload, device.globalMetaId), true);
  assert.equal(request.payload, result.payload);
});

test('publishDeviceOwnerBinding skips the subsidy step when no requestSubsidy is injected', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-device-binding-');
  const device = await createOwnerIdentity(systemHomeDir, { name: 'Device' });
  const rootOwner = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const { signer } = fakeSigner({ deviceGlobalMetaId: device.globalMetaId });

  const result = await publishDeviceOwnerBinding({ device, rootOwner, signer });
  assert.equal(result.subsidy.requested, false);
  assert.equal(result.chainWrite.pinId.length > 0, true);
});

test('a failed subsidy does not abort the publish (device wallet may already be funded)', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-device-binding-');
  const device = await createOwnerIdentity(systemHomeDir, { name: 'Device' });
  const rootOwner = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const { signer } = fakeSigner({ deviceGlobalMetaId: device.globalMetaId });

  const result = await publishDeviceOwnerBinding({
    device,
    rootOwner,
    signer,
    requestSubsidy: async () => ({ success: false, error: 'subsidy service unreachable' }),
  });
  assert.equal(result.subsidy.requested, true);
  assert.equal(result.subsidy.success, false);
  assert.equal(result.subsidy.error, 'subsidy service unreachable');
  assert.equal(result.chainWrite.pinId.length > 0, true);
});

test('failed subsidy + failed write surfaces an actionable funding error', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-device-binding-');
  const device = await createOwnerIdentity(systemHomeDir, { name: 'Device' });
  const rootOwner = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const { signer } = fakeSigner({ throwError: new Error('insufficient funds for pin fee') });

  await assert.rejects(
    () => publishDeviceOwnerBinding({
      device,
      rootOwner,
      signer,
      requestSubsidy: async () => ({ success: false, error: 'address-init failed: HTTP 503' }),
    }),
    (error) => {
      assert.ok(error instanceof DeviceOwnerBindingError);
      assert.equal(error.code, 'chain_write_failed');
      assert.match(error.message, /insufficient funds for pin fee/);
      assert.match(error.message, /MVC gas subsidy could not fund/);
      assert.match(error.message, /Top up the device MVC wallet/);
      assert.match(error.message, new RegExp(device.mvcAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});

test('publishDeviceOwnerBinding rejects a device identity without a globalMetaId', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-device-binding-');
  const rootOwner = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const { signer } = fakeSigner();

  await assert.rejects(
    () => publishDeviceOwnerBinding({
      device: { globalMetaId: '', mvcAddress: 'x', mnemonic: 'y', path: "m/44'/10001'/0'/0/0" },
      rootOwner,
      signer,
    }),
    (error) => error instanceof DeviceOwnerBindingError && error.code === 'invalid_subject',
  );
});
