import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  requestMvcGasSubsidy,
} = require('../../dist/core/subsidy/requestMvcGasSubsidy.js');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    async json() {
      return body;
    },
  };
}

function createRequest(responses, calls = []) {
  return requestMvcGasSubsidy({
    mvcAddress: '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA',
    mnemonic: MNEMONIC,
    path: "m/44'/10001'/0'/0/0",
  }, {
    addressInitUrl: 'https://assist.example/address-init',
    addressRewardUrl: 'https://assist.example/address-reward',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return responses.shift();
    },
    wait: async () => {},
  });
}

test('requestMvcGasSubsidy accepts successful business responses', async () => {
  const calls = [];
  const result = await createRequest([
    jsonResponse({ code: 0, message: 'success', data: { txid: 'init-tx' } }),
    jsonResponse({ code: 0, message: 'success', data: { txid: 'reward-tx' } }),
  ], calls);

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.step2, {
    code: 0,
    message: 'success',
    data: { txid: 'reward-tx' },
  });
});

test('requestMvcGasSubsidy permits idempotent duplicate responses', async () => {
  const result = await createRequest([
    jsonResponse({ code: 1, message: 'address already init', data: null }),
    jsonResponse({ code: 1, message: 'address already rewarded', data: null }),
  ]);

  assert.equal(result.success, true);
});

test('requestMvcGasSubsidy rejects an address-init business failure before reward', async () => {
  const calls = [];
  const result = await createRequest([
    jsonResponse({ code: 1, message: 'init funding unavailable', data: null }),
  ], calls);

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    'address-init failed: init funding unavailable (HTTP 200 OK, service code 1). '
    + 'Request https://assist.example/address-init address 1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA gasChain mvc. '
    + 'No mnemonic or signature is included.',
  );
  assert.equal(calls.length, 1);
});

test('requestMvcGasSubsidy rejects an address-reward business failure returned with HTTP 200', async () => {
  const result = await createRequest([
    jsonResponse({ code: 0, message: 'success', data: { txid: 'init-tx' } }),
    jsonResponse({ code: 1, message: 'asset utxo list is empty', data: null }),
  ]);

  assert.equal(result.success, false);
  assert.equal(result.error, 'address-reward failed: asset utxo list is empty (HTTP 200 OK, service code 1)');
  assert.deepEqual(result.step2, {
    code: 1,
    message: 'asset utxo list is empty',
    data: null,
  });
});

test('requestMvcGasSubsidy exposes HTTP status and service code for an address-init invalid connection', async () => {
  const result = await createRequest([
    jsonResponse({ code: 7, message: 'invalid connection', data: null }),
  ]);

  assert.equal(result.success, false);
  assert.match(result.error, /address-init failed: invalid connection/);
  assert.match(result.error, /HTTP 200/);
  assert.match(result.error, /service code 7/);
});

test('requestMvcGasSubsidy retries a slow invalid connection once and then reports the upstream failure', async () => {
  const calls = [];
  const result = await createRequest([
    jsonResponse({ code: 1, message: 'invalid connection', data: null, processingTime: 30018 }),
    jsonResponse({ code: 1, message: 'invalid connection', data: null, processingTime: 30018 }),
  ], calls);

  assert.equal(result.success, false);
  assert.equal(calls.length, 2);
  assert.match(result.error, /processingTime 30018ms/);
  assert.match(result.error, /address 1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA/);
  assert.match(result.error, /upstream connection failure/);
  assert.equal(result.error.includes('abandon'), false);
});

test('requestMvcGasSubsidy completes address-init after one transient invalid connection', async () => {
  const calls = [];
  const result = await createRequest([
    jsonResponse({ code: 1, message: 'invalid connection', data: null, processingTime: 30018 }),
    jsonResponse({ code: 0, message: 'success', data: { txid: 'init-tx' } }),
    jsonResponse({ code: 0, message: 'success', data: { txid: 'reward-tx' } }),
  ], calls);

  assert.equal(result.success, true);
  assert.equal(calls.length, 3);
});

test('requestMvcGasSubsidy preserves service context for HTTP failures', async () => {
  const result = await createRequest([
    jsonResponse(
      { code: 2, message: 'Auth verified signature err', data: null },
      { ok: false, status: 401, statusText: 'Unauthorized' },
    ),
  ]);

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    'address-init failed: Auth verified signature err (HTTP 401 Unauthorized, service code 2). '
    + 'Request https://assist.example/address-init address 1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA gasChain mvc. '
    + 'No mnemonic or signature is included.',
  );
});
