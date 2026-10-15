import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  requestMvcGasSubsidy,
} = require('../../dist/core/subsidy/requestMvcGasSubsidy.js');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDRESS = '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA';

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function challengeResponse() {
  return jsonResponse({
    code: 0,
    message: 'success',
    data: {
      challengeId: 'ch-1',
      message: 'assist-mvc-reward:ch-1:1',
      expiresAt: 1,
    },
  });
}

function createRequest(responses, calls = [], options = {}) {
  return requestMvcGasSubsidy({
    mvcAddress: ADDRESS,
    mnemonic: options.mnemonic === undefined ? MNEMONIC : options.mnemonic,
    path: "m/44'/10001'/0'/0/0",
  }, {
    addressInitUrl: 'https://assist.example/address-init',
    addressRewardUrl: 'https://assist.example/address-reward',
    rewardChallengeUrl: 'https://assist.example/reward-challenge',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const response = responses.shift();
      if (!response) {
        throw new Error(`unexpected request ${url}`);
      }
      return response;
    },
    wait: options.wait ?? (async () => {}),
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
  });
}

function readBody(call) {
  return JSON.parse(call.init.body);
}

test('requestMvcGasSubsidy claims gas with a reward challenge and does not call address-init', async () => {
  const calls = [];
  const waits = [];
  const result = await createRequest([
    challengeResponse(),
    jsonResponse({ code: 0, message: 'success', data: { txId: 'reward-tx', amount: 500000 } }),
  ], calls, {
    wait: async (ms) => { waits.push(ms); },
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://assist.example/reward-challenge');
  assert.equal(calls[1].url, 'https://assist.example/address-reward');
  assert.deepEqual(readBody(calls[0]), { address: ADDRESS, gasChain: 'mvc' });
  const rewardBody = readBody(calls[1]);
  assert.equal(rewardBody.address, ADDRESS);
  assert.equal(rewardBody.gasChain, 'mvc');
  assert.equal(rewardBody.challengeId, 'ch-1');
  assert.equal(typeof rewardBody.publicKey, 'string');
  assert.equal(rewardBody.publicKey.length > 0, true);
  assert.equal(typeof rewardBody.signature, 'string');
  assert.equal(rewardBody.signature.length > 0, true);
  assert.equal(JSON.stringify(rewardBody).includes('abandon'), false);
  assert.equal(calls[1].init.headers['X-Public-Key'], rewardBody.publicKey);
  assert.equal(typeof calls[1].init.headers['X-Signature'], 'string');
  assert.equal(calls[1].init.headers['X-Signature'].length > 0, true);
  assert.deepEqual(waits, [5000]);
  assert.deepEqual(result.step2, {
    code: 0,
    message: 'success',
    data: { txId: 'reward-tx', amount: 500000 },
  });
});

test('requestMvcGasSubsidy treats an already-rewarded challenge as subsidy success', async () => {
  const calls = [];
  const result = await createRequest([
    jsonResponse({ code: 1, message: 'address already rewarded', data: null }),
  ], calls);

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://assist.example/reward-challenge');
});

test('requestMvcGasSubsidy rejects a reward-challenge business failure before address-init', async () => {
  const calls = [];
  const result = await createRequest([
    jsonResponse({ code: 1, message: 'reward funding unavailable', data: null }),
  ], calls);

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    'reward-challenge failed: reward funding unavailable (HTTP 200 OK, service code 1)',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://assist.example/reward-challenge');
});

test('requestMvcGasSubsidy rejects an address-reward business failure returned with HTTP 200', async () => {
  const result = await createRequest([
    challengeResponse(),
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

test('requestMvcGasSubsidy falls back to one address-init attempt when reward-challenge is missing', async () => {
  const calls = [];
  const result = await createRequest([
    jsonResponse({ message: '404 page not found' }, { ok: false, status: 404, statusText: 'Not Found' }),
    jsonResponse({ code: 7, message: 'invalid connection', data: null }),
  ], calls);

  assert.equal(result.success, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://assist.example/address-init');
  assert.match(result.error, /address-init failed: invalid connection/);
  assert.match(result.error, /HTTP 200/);
  assert.match(result.error, /service code 7/);
});

test('requestMvcGasSubsidy does not repeat a slow address-init invalid connection', async () => {
  const calls = [];
  const result = await createRequest([
    jsonResponse({ message: '404 page not found' }, { ok: false, status: 404, statusText: 'Not Found' }),
    jsonResponse({ code: 1, message: 'invalid connection', data: null, processingTime: 30018 }),
  ], calls);

  assert.equal(result.success, false);
  assert.equal(calls.length, 2);
  assert.match(result.error, /processingTime 30018ms/);
  assert.match(result.error, /address 1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA/);
  assert.match(result.error, /upstream connection failure/);
  assert.equal(result.error.includes('abandon'), false);
});

test('requestMvcGasSubsidy keeps the legacy init plus reward flow when reward-challenge is missing', async () => {
  const calls = [];
  const result = await createRequest([
    jsonResponse({ message: '404 page not found' }, { ok: false, status: 404, statusText: 'Not Found' }),
    jsonResponse({ code: 1, message: 'address already init', data: null }),
    jsonResponse({ code: 1, message: 'address already rewarded', data: null }),
  ], calls);

  assert.equal(result.success, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(readBody(calls[2]), { address: ADDRESS, gasChain: 'mvc' });
  assert.equal(calls[2].init.body.includes('challengeId'), false);
});

test('requestMvcGasSubsidy preserves service context for HTTP failures on the legacy init path', async () => {
  const result = await createRequest([
    jsonResponse({ message: '404 page not found' }, { ok: false, status: 404, statusText: 'Not Found' }),
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
