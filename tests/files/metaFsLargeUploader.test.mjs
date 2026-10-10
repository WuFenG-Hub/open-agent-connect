import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const {
  DEFAULT_METAFS_UPLOADER_BASE_URL,
  createMetaFsLargeUploader,
} = require('../../dist/core/files/metaFsLargeUploader.js');
const {
  __clearPendingMvcUtxosForTests,
  resolveSpendableMvcUtxos,
} = require('../../dist/core/chain/mvcPendingUtxos.js');

const ONE_MIB = 1024 * 1024;
const FIRST_TXID = 'a'.repeat(64);
const SECOND_TXID = 'b'.repeat(64);
const DEFAULT_ADDRESS = '1MetaFsLargeUploadFundingAddress';
const DEFAULT_IDENTITY = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  path: "m/44'/10001'/0'/0/0",
  publicKey: 'pub',
  chatPublicKey: 'chat-pub',
  addresses: { mvc: DEFAULT_ADDRESS },
  mvcAddress: DEFAULT_ADDRESS,
  metaId: 'meta-id-alice',
  globalMetaId: 'global-meta-id-alice',
};

async function tempFile(name, content) {
  const tempDir = await mkdtempTempRoot('metabot-metafs-large-');
  const filePath = path.join(tempDir, name);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await writeFile(filePath, buffer);
  return { filePath, buffer };
}

function fakeSigner(identity = DEFAULT_IDENTITY) {
  return {
    getIdentity: async () => identity,
  };
}

function jsonResponse(body, options = {}) {
  const status = options.status ?? 200;
  return {
    ok: options.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function parseJsonBody(body) {
  if (body == null) return undefined;
  if (typeof body === 'string') return JSON.parse(body);
  if (body instanceof Uint8Array) return JSON.parse(Buffer.from(body).toString('utf8'));
  return body;
}

function createFetchHarness(options = {}) {
  const calls = [];
  const config = options.config ?? {
    code: 0,
    data: {
      chains: {
        mvc: {
          maxFileSize: 50 * ONE_MIB,
          chunkSize: 4,
          feeRate: 2.9,
        },
      },
    },
  };
  const utxoPages = options.utxoPages ?? [[
    { txid: FIRST_TXID, outIndex: 0, value: 10000, height: 8 },
    { txid: SECOND_TXID, outIndex: 1, value: 599, height: 8 },
  ]];
  const chunkedResponses = [...(options.chunkedResponses ?? [{
    code: 0,
    data: { indexTxId: 'index-tx-1', status: 'success' },
  }])];

  const fetchFn = async (url, init = {}) => {
    const urlString = String(url);
    const parsed = new URL(urlString);
    const routePath = parsed.pathname.replace(/^\/metafile-uploader/u, '');
    const body = parseJsonBody(init.body);
    calls.push({
      url: urlString,
      host: parsed.host,
      path: routePath,
      search: parsed.search,
      method: init.method ?? 'GET',
      body,
    });

    if (routePath === '/api/v1/config') {
      return jsonResponse(config);
    }
    if (routePath === '/api/v1/files/multipart/initiate') {
      return jsonResponse({
        code: 0,
        data: { uploadId: 'upload-1', key: 'storage/key-1' },
      });
    }
    if (routePath === '/api/v1/files/multipart/upload-part') {
      return jsonResponse({
        code: 0,
        data: { etag: `etag-${body.partNumber}`, partNumber: body.partNumber },
      });
    }
    if (routePath === '/api/v1/files/multipart/complete') {
      return jsonResponse({
        code: 0,
        data: { key: 'storage/key-1' },
      });
    }
    if (routePath === '/api/v1/files/estimate-chunked-upload') {
      return jsonResponse({
        code: 0,
        data: { chunkPreTxFee: 1000, indexPreTxFee: 2000 },
      });
    }
    if (parsed.host === 'www.metalet.space' && routePath === '/wallet-api/v4/mvc/address/utxo-list') {
      const page = utxoPages.shift() ?? [];
      if (options.metaletEnvelopeWithCode) {
        return jsonResponse({ code: 0, data: { list: page } });
      }
      return jsonResponse({ data: { list: page } });
    }
    if (routePath === '/api/v1/files/chunked-upload') {
      return jsonResponse(chunkedResponses.shift() ?? {
        code: 0,
        data: { indexTxId: 'index-tx-fallback', status: 'success' },
      });
    }

    throw new Error(`Unexpected fetch URL: ${urlString}`);
  };

  return { calls, fetchFn };
}

function createFundingHarness(options = {}) {
  const calls = [];
  const buildFunding = async (input) => {
    calls.push({
      ...input,
      excludedOutpoints: new Set(input.excludedOutpoints ?? []),
    });
    const attempt = calls.length;
    const spentUtxos = options.spentUtxosByAttempt?.[attempt - 1] ?? [{
      txId: attempt === 1 ? FIRST_TXID : SECOND_TXID,
      outputIndex: 0,
      satoshis: 10000,
      address: DEFAULT_ADDRESS,
      height: 8,
    }];
    const changeUtxo = options.changeUtxo ?? {
      txId: `merge-tx-${attempt}`,
      outputIndex: 2,
      satoshis: 4000,
      address: DEFAULT_ADDRESS,
      height: 0,
    };
    return {
      mergeTxHex: `merge-hex-${attempt}`,
      mergeTxId: `merge-tx-${attempt}`,
      chunkPreTxHex: `chunk-pre-hex-${attempt}`,
      indexPreTxHex: `index-pre-hex-${attempt}`,
      chunkPreTxOutputAmount: input.chunkPreTxFee + Math.ceil((200 + 150) * input.feeRate),
      indexPreTxOutputAmount: input.indexPreTxFee + Math.ceil((200 + 150) * input.feeRate),
      spentUtxos,
      spentOutpoints: spentUtxos.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
      changeUtxo,
    };
  };
  return { buildFunding, calls };
}

test('createMetaFsLargeUploader performs successful chunked MVC upload in request order', async () => {
  __clearPendingMvcUtxosForTests();
  const { filePath, buffer } = await tempFile('archive 1.zip', 'abcdefghi');
  const { calls, fetchFn } = createFetchHarness();
  const { buildFunding, calls: fundingCalls } = createFundingHarness();
  const uploader = createMetaFsLargeUploader({
    baseUrl: 'https://uploader.test///',
    fetchFn,
    buildFunding,
    sleep: async () => {},
  });

  const result = await uploader.upload({
    filePath,
    fileName: 'archive 1.zip',
    contentType: 'application/zip',
    bytes: buffer.length,
    extension: '.zip',
    network: 'mvc',
    signer: fakeSigner(),
  });

  assert.equal(DEFAULT_METAFS_UPLOADER_BASE_URL, 'https://file.metaid.io/metafile-uploader');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/v1/config',
    '/api/v1/files/multipart/initiate',
    '/api/v1/files/multipart/upload-part',
    '/api/v1/files/multipart/upload-part',
    '/api/v1/files/multipart/upload-part',
    '/api/v1/files/multipart/complete',
    '/api/v1/files/estimate-chunked-upload',
    '/wallet-api/v4/mvc/address/utxo-list',
    '/api/v1/files/chunked-upload',
  ]);

  const uploadPartBodies = calls
    .filter((call) => call.path === '/api/v1/files/multipart/upload-part')
    .map((call) => call.body.content);
  assert.deepEqual(uploadPartBodies, [
    Buffer.from('abcd').toString('base64'),
    Buffer.from('efgh').toString('base64'),
    Buffer.from('i').toString('base64'),
  ]);

  for (const chunkBase64 of uploadPartBodies) {
    for (const call of calls.filter((entry) => entry.path !== '/api/v1/files/multipart/upload-part')) {
      assert.equal(JSON.stringify(call.body ?? '').includes(chunkBase64), false);
    }
  }

  const initiate = calls.find((call) => call.path === '/api/v1/files/multipart/initiate');
  assert.deepEqual(initiate.body, {
    fileName: 'archive 1.zip',
    fileSize: buffer.length,
    metaId: DEFAULT_IDENTITY.metaId,
    address: DEFAULT_ADDRESS,
  });

  const estimate = calls.find((call) => call.path === '/api/v1/files/estimate-chunked-upload');
  assert.deepEqual(estimate.body, {
    fileName: 'archive 1.zip',
    path: '/file/archive_1.zip',
    contentType: 'application/zip;binary',
    feeRate: 2,
    storageKey: 'storage/key-1',
  });

  assert.equal(fundingCalls.length, 1);
  assert.equal(fundingCalls[0].feeRate, 2);
  assert.equal(fundingCalls[0].chunkPreTxFee, 1000);
  assert.equal(fundingCalls[0].indexPreTxFee, 2000);
  assert.deepEqual(fundingCalls[0].utxos, [{
    txId: FIRST_TXID,
    outputIndex: 0,
    satoshis: 10000,
    address: DEFAULT_ADDRESS,
    height: 8,
  }]);

  const chunkedUpload = calls.find((call) => call.path === '/api/v1/files/chunked-upload');
  assert.deepEqual(chunkedUpload.body, {
    metaId: DEFAULT_IDENTITY.metaId,
    address: DEFAULT_ADDRESS,
    fileName: 'archive 1.zip',
    path: '/file/archive_1.zip',
    operation: 'create',
    contentType: 'application/zip;binary',
    chunkPreTxHex: 'chunk-pre-hex-1',
    indexPreTxHex: 'index-pre-hex-1',
    mergeTxHex: 'merge-hex-1',
    feeRate: 2,
    isBroadcast: true,
    storageKey: 'storage/key-1',
  });

  assert.equal(result.pinId, 'index-tx-1i0');
  assert.deepEqual(result.txids, ['index-tx-1']);
  assert.equal(result.totalCost, 6000);
  assert.equal(result.network, 'mvc');
  assert.equal(result.fileName, 'archive 1.zip');
  assert.equal(result.contentType, 'application/zip');
  assert.equal(result.bytes, buffer.length);
  assert.equal(result.extension, '.zip');
  assert.equal(result.metafileUri, 'metafile://index-tx-1i0.zip');
  assert.equal(result.metawebUrl, 'https://openagentinternet.org/browser/metafile/index-tx-1i0');
  assert.equal(result.globalMetaId, DEFAULT_IDENTITY.globalMetaId);
  assert.equal(result.uploadMode, 'chunked');

  const spendableAfterUpload = resolveSpendableMvcUtxos({
    address: DEFAULT_ADDRESS,
    utxos: [{
      txId: FIRST_TXID,
      outputIndex: 0,
      satoshis: 10000,
      address: DEFAULT_ADDRESS,
      height: 8,
    }],
  });
  assert.deepEqual(spendableAfterUpload, [{
    txId: 'merge-tx-1',
    outputIndex: 2,
    satoshis: 4000,
    address: DEFAULT_ADDRESS,
    height: 0,
  }]);
  __clearPendingMvcUtxosForTests();
});

test('createMetaFsLargeUploader appends a content type extension when upload input has no extension', async () => {
  __clearPendingMvcUtxosForTests();
  const { filePath, buffer } = await tempFile('homepage', '<!doctype html>');
  const { fetchFn } = createFetchHarness();
  const { buildFunding } = createFundingHarness();
  const uploader = createMetaFsLargeUploader({
    fetchFn,
    buildFunding,
    sleep: async () => {},
  });

  const result = await uploader.upload({
    filePath,
    fileName: 'homepage',
    contentType: 'text/html',
    bytes: buffer.length,
    extension: '',
    network: 'mvc',
    signer: fakeSigner(),
  });

  assert.equal(result.extension, '.html');
  assert.equal(result.metafileUri, 'metafile://index-tx-1i0.html');
  assert.equal(result.metawebUrl, 'https://openagentinternet.org/browser/metafile/index-tx-1i0');
  __clearPendingMvcUtxosForTests();
});

test('createMetaFsLargeUploader uses the smaller local or server size cap', async () => {
  const { filePath, buffer } = await tempFile('too-large.bin', '123456');

  for (const scenario of [
    { maxBytes: 10, serverMaxFileSize: 5 },
    { maxBytes: 5, serverMaxFileSize: 10 },
  ]) {
    const { calls, fetchFn } = createFetchHarness({
      config: {
        code: 0,
        data: { chains: { mvc: { maxFileSize: scenario.serverMaxFileSize, chunkSize: 4, feeRate: 1 } } },
      },
    });
    const { buildFunding } = createFundingHarness();
    const uploader = createMetaFsLargeUploader({
      fetchFn,
      buildFunding,
      maxBytes: scenario.maxBytes,
    });

    await assert.rejects(
      () => uploader.upload({
        filePath,
        fileName: 'too-large.bin',
        contentType: 'application/octet-stream',
        bytes: buffer.length,
        extension: '.bin',
        network: 'mvc',
        signer: fakeSigner(),
      }),
      (error) => {
        assert.equal(error.code, 'large_file_upload_too_large');
        return true;
      },
    );
    assert.deepEqual(calls.map((call) => call.path), ['/api/v1/config']);
  }
});

test('createMetaFsLargeUploader parses Metalet code/data UTXO envelopes', async () => {
  const { filePath, buffer } = await tempFile('coded-utxo.zip', 'coded-utxo-data');
  const { fetchFn } = createFetchHarness({
    metaletEnvelopeWithCode: true,
    utxoPages: [[
      { txid: FIRST_TXID, outIndex: 0, value: 10000, height: 8 },
    ]],
  });
  const { buildFunding, calls: fundingCalls } = createFundingHarness();
  const uploader = createMetaFsLargeUploader({ fetchFn, buildFunding });

  await uploader.upload({
    filePath,
    fileName: 'coded-utxo.zip',
    contentType: 'application/zip',
    bytes: buffer.length,
    extension: '.zip',
    network: 'mvc',
    signer: fakeSigner(),
  });

  assert.deepEqual(fundingCalls[0].utxos, [{
    txId: FIRST_TXID,
    outputIndex: 0,
    satoshis: 10000,
    address: DEFAULT_ADDRESS,
    height: 8,
  }]);
});

test('createMetaFsLargeUploader defaults chunk size to one MiB', async () => {
  const { filePath, buffer } = await tempFile('default-chunk.bin', Buffer.alloc(ONE_MIB + 1, 0x7a));
  const { calls, fetchFn } = createFetchHarness({
    config: {
      code: 0,
      data: { chains: { mvc: { maxFileSize: 50 * ONE_MIB, feeRate: 1 } } },
    },
  });
  const { buildFunding } = createFundingHarness();
  const uploader = createMetaFsLargeUploader({ fetchFn, buildFunding });

  await uploader.upload({
    filePath,
    fileName: 'default-chunk.bin',
    contentType: 'application/octet-stream',
    bytes: buffer.length,
    extension: '.bin',
    network: 'mvc',
    signer: fakeSigner(),
  });

  const uploadPartBodies = calls
    .filter((call) => call.path === '/api/v1/files/multipart/upload-part')
    .map((call) => call.body.content);
  assert.equal(uploadPartBodies.length, 2);
  assert.equal(Buffer.from(uploadPartBodies[0], 'base64').byteLength, ONE_MIB);
  assert.equal(Buffer.from(uploadPartBodies[1], 'base64').byteLength, 1);
});

test('createMetaFsLargeUploader retries stale-input chunked upload with excluded outpoint', async () => {
  const { filePath, buffer } = await tempFile('retry.zip', 'retry-data');
  const { calls, fetchFn } = createFetchHarness({
    utxoPages: [
      [{ txid: FIRST_TXID, outIndex: 0, value: 10000, height: 8 }],
      [{ txid: SECOND_TXID, outIndex: 0, value: 12000, height: 9 }],
    ],
    chunkedResponses: [
      {
        code: 1,
        message: 'failed to broadcast merge transaction: txn-mempool-conflict missing inputs',
      },
      {
        code: 0,
        data: { txId: 'index-tx-retry', status: 'success' },
      },
    ],
  });
  const { buildFunding, calls: fundingCalls } = createFundingHarness({
    spentUtxosByAttempt: [
      [{ txId: FIRST_TXID, outputIndex: 0, satoshis: 10000, address: DEFAULT_ADDRESS, height: 8 }],
      [{ txId: SECOND_TXID, outputIndex: 0, satoshis: 12000, address: DEFAULT_ADDRESS, height: 9 }],
    ],
  });
  const sleeps = [];
  const uploader = createMetaFsLargeUploader({
    fetchFn,
    buildFunding,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const result = await uploader.upload({
    filePath,
    fileName: 'retry.zip',
    contentType: 'application/zip',
    bytes: buffer.length,
    extension: '.zip',
    network: 'mvc',
    signer: fakeSigner(),
  });

  assert.equal(result.pinId, 'index-tx-retryi0');
  assert.equal(fundingCalls.length, 2);
  assert.deepEqual([...fundingCalls[0].excludedOutpoints], []);
  assert.deepEqual([...fundingCalls[1].excludedOutpoints], [`${FIRST_TXID}:0`]);
  assert.equal(calls.filter((call) => call.path === '/wallet-api/v4/mvc/address/utxo-list').length, 2);
  assert.equal(calls.filter((call) => call.path === '/api/v1/files/chunked-upload').length, 2);
  assert.equal(sleeps.length, 1);
});

test('createMetaFsLargeUploader throws metafs code for non-retryable chunked upload failure', async () => {
  const { filePath, buffer } = await tempFile('permanent.zip', 'permanent-data');
  const { fetchFn } = createFetchHarness({
    chunkedResponses: [{
      code: 1,
      message: 'permanent uploader failure',
    }],
  });
  const { buildFunding, calls: fundingCalls } = createFundingHarness();
  const uploader = createMetaFsLargeUploader({ fetchFn, buildFunding });

  await assert.rejects(
    () => uploader.upload({
      filePath,
      fileName: 'permanent.zip',
      contentType: 'application/zip',
      bytes: buffer.length,
      extension: '.zip',
      network: 'mvc',
      signer: fakeSigner(),
    }),
    (error) => {
      assert.equal(error.code, 'large_file_upload_metafs_failed');
      assert.match(error.message, /permanent uploader failure/i);
      return true;
    },
  );
  assert.equal(fundingCalls.length, 1);
});

test('createMetaFsLargeUploader rejects unsupported chains before network calls', async () => {
  const { filePath, buffer } = await tempFile('btc.zip', 'btc-data');
  const calls = [];
  const uploader = createMetaFsLargeUploader({
    fetchFn: async (...args) => {
      calls.push(args);
      throw new Error('fetch should not be called');
    },
    buildFunding: async () => {
      throw new Error('funding should not be called');
    },
  });

  await assert.rejects(
    () => uploader.upload({
      filePath,
      fileName: 'btc.zip',
      contentType: 'application/zip',
      bytes: buffer.length,
      extension: '.zip',
      network: 'btc',
      signer: fakeSigner(),
    }),
    (error) => {
      assert.equal(error.code, 'large_file_upload_chain_unsupported');
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Sponsored (traffic/quota) chunked-upload funding
// ---------------------------------------------------------------------------

const { mvc } = require('meta-contract');
const SPONSOR_ADDRESS = '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB';
const SPONSOR_COMMIT_TXID = 'd'.repeat(64);
const SPONSOR_IDENTITY = {
  ...DEFAULT_IDENTITY,
  addresses: { mvc: SPONSOR_ADDRESS },
  mvcAddress: SPONSOR_ADDRESS,
};
// Raw Metalet UTXO shape (txid/outIndex/value); fetchMvcFundingUtxos
// normalizes it before it reaches the sponsor funding helper.
const SPONSOR_ANCHOR_UTXO = {
  txid: FIRST_TXID,
  outIndex: 0,
  value: 100_000,
  height: 8,
};
const SPONSOR_ANCHOR_CHAIN_UTXO = {
  txId: FIRST_TXID,
  outputIndex: 0,
  satoshis: 100_000,
  address: SPONSOR_ADDRESS,
  height: 8,
};
// estimate gives chunkPreTxFee 1000 / indexPreTxFee 2000; the harness config
// feeRate 2.9 floors to 2, so outputs are fee + ceil(350 * 2) = +700 each.
const SPONSOR_CHUNK_OUTPUT = 1700;
const SPONSOR_INDEX_OUTPUT = 2700;

function sponsorError(message, { code, stage, reason }) {
  return Object.assign(new Error(message), { code, stage, reason });
}

function createSponsorFundingClient(overrides = {}) {
  const calls = [];
  const spends = [];
  const client = {
    calls,
    spends,
    traffic: {
      resolveTrafficAccount: overrides.resolveTrafficAccount ?? (async () => ({
        accountId: 'traffic-account-1',
        authSignature: 'traffic-auth-sig',
        timestamp: 1,
      })),
      recordSpend: async (entry) => {
        spends.push(entry);
      },
    },
    async getAddressInfo(payload) {
      calls.push(['getAddressInfo', payload]);
      return overrides.addressInfo ?? {
        exists: true,
        balance: 0,
        grantedAmount: 5_000_000,
        reservedAmount: 0,
        spentAmount: 0,
        availableAmount: 5_000_000,
        status: 'active',
        raw: {},
      };
    },
    async getChallenge() {
      calls.push(['getChallenge']);
      return { challengeId: 'challenge-1', message: 'sponsor challenge', raw: {} };
    },
    async preSponsor(payload) {
      calls.push(['preSponsor', payload]);
      if (overrides.preSponsor) {
        return overrides.preSponsor(payload);
      }
      return {
        preparedTxHex: payload.txHex,
        orderId: 'order-1',
        minerFee: 900,
        userInputIndexes: [0],
        raw: {},
      };
    },
    async commitSponsor(payload) {
      calls.push(['commitSponsor', payload]);
      return overrides.commitResult ?? {
        txId: SPONSOR_COMMIT_TXID,
        minerFee: 750,
        raw: {},
      };
    },
    ...(overrides.methods ?? {}),
  };
  return client;
}

function outputAddress(output) {
  try {
    const resolved = output.script?.toAddress?.('livenet');
    return resolved == null ? '' : String(resolved);
  } catch {
    return '';
  }
}

test('createMetaFsLargeUploader funds the chunked merge transaction through the sponsor first', async () => {
  __clearPendingMvcUtxosForTests();
  const { filePath, buffer } = await tempFile('sponsored-large.mp4', 'sponsored chunked data');
  const { calls, fetchFn } = createFetchHarness({
    utxoPages: [[SPONSOR_ANCHOR_UTXO]],
  });
  const { buildFunding, calls: fundingCalls } = createFundingHarness();
  const sponsorClient = createSponsorFundingClient();
  const uploader = createMetaFsLargeUploader({
    fetchFn,
    buildFunding,
    sleep: async () => {},
  });

  const result = await uploader.upload({
    filePath,
    fileName: 'sponsored-large.mp4',
    contentType: 'video/mp4',
    bytes: buffer.length,
    extension: '.mp4',
    network: 'mvc',
    signer: fakeSigner(SPONSOR_IDENTITY),
    mvcSponsorClient: sponsorClient,
  });

  // Sponsor ran before any wallet funding; the wallet path never executed.
  assert.deepEqual(sponsorClient.calls.map(([name]) => name), [
    'getAddressInfo',
    'getChallenge',
    'preSponsor',
    'commitSponsor',
    'getAddressInfo',
  ]);
  assert.equal(fundingCalls.length, 0);

  // The merge draft anchors one wallet UTXO, returns it fully as change, and
  // asks the sponsor to fund both pre-funding outputs.
  const prePayload = sponsorClient.calls.find(([name]) => name === 'preSponsor')[1];
  const draftTx = new mvc.Transaction(prePayload.txHex);
  assert.equal(draftTx.inputs.length, 1);
  assert.deepEqual(
    draftTx.outputs.map((output) => Number(output.satoshis)),
    [SPONSOR_CHUNK_OUTPUT, SPONSOR_INDEX_OUTPUT, SPONSOR_ANCHOR_CHAIN_UTXO.satoshis],
  );
  assert.ok(draftTx.outputs.every((output) => outputAddress(output) === SPONSOR_ADDRESS));

  // The submitted merge transaction is the sponsor-committed one, and the
  // pre-transactions spend its located funding outputs.
  const chunkedUpload = calls.find((call) => call.path === '/api/v1/files/chunked-upload');
  const mergeTx = new mvc.Transaction(chunkedUpload.body.mergeTxHex);
  assert.deepEqual(
    mergeTx.outputs.map((output) => Number(output.satoshis)),
    [SPONSOR_CHUNK_OUTPUT, SPONSOR_INDEX_OUTPUT, SPONSOR_ANCHOR_CHAIN_UTXO.satoshis],
  );
  const chunkPreTx = new mvc.Transaction(chunkedUpload.body.chunkPreTxHex);
  const indexPreTx = new mvc.Transaction(chunkedUpload.body.indexPreTxHex);
  assert.equal(chunkPreTx.toObject().inputs[0].prevTxId, SPONSOR_COMMIT_TXID);
  assert.equal(chunkPreTx.toObject().inputs[0].outputIndex, 0);
  assert.equal(indexPreTx.toObject().inputs[0].prevTxId, SPONSOR_COMMIT_TXID);
  assert.equal(indexPreTx.toObject().inputs[0].outputIndex, 1);

  assert.equal(result.pinId, 'index-tx-1i0');
  assert.equal(result.uploadMode, 'chunked');
  assert.equal(result.totalCost, 1000 + 2000 + 750);
  assert.equal(result.feeAssist.attempted, true);
  assert.equal(result.feeAssist.used, true);
  assert.equal(result.feeAssist.mode, 'mvc_sponsor_v2');
  assert.equal(result.feeAssist.stage, 'done');
  assert.equal(result.feeAssist.orderId, 'order-1');
  assert.equal(result.feeAssist.billedBy, 'traffic');
  assert.equal(result.feeAssist.quotaBefore.availableAmount, 5_000_000);

  // Traffic journal recorded the sponsored merge spend.
  assert.equal(sponsorClient.spends.length, 1);
  assert.equal(sponsorClient.spends[0].kind, '/file');
  assert.equal(sponsorClient.spends[0].billedBy, 'traffic');
  assert.equal(sponsorClient.spends[0].txId, SPONSOR_COMMIT_TXID);

  // Anchor UTXO is tracked as spent and the merge outputs as created.
  const spendable = resolveSpendableMvcUtxos({
    address: SPONSOR_ADDRESS,
    utxos: [SPONSOR_ANCHOR_CHAIN_UTXO],
  });
  assert.equal(spendable.some((utxo) => utxo.txId === SPONSOR_ANCHOR_CHAIN_UTXO.txId), false);
  assert.equal(
    spendable.some((utxo) => utxo.txId === SPONSOR_COMMIT_TXID && utxo.outputIndex === 0 && utxo.satoshis === SPONSOR_CHUNK_OUTPUT),
    true,
  );
  __clearPendingMvcUtxosForTests();
});

test('createMetaFsLargeUploader falls back to wallet funding when traffic is insufficient', async () => {
  __clearPendingMvcUtxosForTests();
  const { filePath, buffer } = await tempFile('traffic-short.mp4', 'traffic insufficient');
  const { calls, fetchFn } = createFetchHarness({
    utxoPages: [
      [SPONSOR_ANCHOR_UTXO],
      [{ txid: SECOND_TXID, outIndex: 0, value: 10000, height: 9 }],
    ],
  });
  const { buildFunding, calls: fundingCalls } = createFundingHarness();
  const sponsorClient = createSponsorFundingClient({
    methods: {
      async preSponsor(payload) {
        sponsorClient.calls.push(['preSponsor', payload]);
        throw sponsorError('traffic account balance insufficient', {
          code: 'mvc_fee_assist_pre_failed',
          stage: 'pre',
          reason: 'insufficient_traffic',
        });
      },
    },
  });
  const uploader = createMetaFsLargeUploader({
    fetchFn,
    buildFunding,
    sleep: async () => {},
  });

  const result = await uploader.upload({
    filePath,
    fileName: 'traffic-short.mp4',
    contentType: 'video/mp4',
    bytes: buffer.length,
    extension: '.mp4',
    network: 'mvc',
    signer: fakeSigner(SPONSOR_IDENTITY),
    mvcSponsorClient: sponsorClient,
  });

  assert.deepEqual(sponsorClient.calls.map(([name]) => name), [
    'getAddressInfo',
    'getChallenge',
    'preSponsor',
  ]);
  assert.equal(sponsorClient.spends.length, 0);

  // The wallet-funded path produced the submitted transactions.
  assert.equal(fundingCalls.length, 1);
  const chunkedUpload = calls.find((call) => call.path === '/api/v1/files/chunked-upload');
  assert.equal(chunkedUpload.body.mergeTxHex, 'merge-hex-1');
  assert.equal(chunkedUpload.body.chunkPreTxHex, 'chunk-pre-hex-1');
  assert.equal(chunkedUpload.body.indexPreTxHex, 'index-pre-hex-1');

  assert.equal(result.pinId, 'index-tx-1i0');
  assert.equal(result.uploadMode, 'chunked');
  assert.equal(result.feeAssist.attempted, true);
  assert.equal(result.feeAssist.used, false);
  assert.equal(result.feeAssist.mode, 'self_paid');
  assert.equal(result.feeAssist.reason, 'insufficient_traffic');
  assert.equal(result.feeAssist.stage, 'pre');
  __clearPendingMvcUtxosForTests();
});

test('createMetaFsLargeUploader falls back to wallet funding when sponsor quota cannot cover the outputs', async () => {
  __clearPendingMvcUtxosForTests();
  const { filePath, buffer } = await tempFile('quota-short.mp4', 'quota insufficient');
  const { fetchFn } = createFetchHarness({
    utxoPages: [
      [SPONSOR_ANCHOR_UTXO],
      [{ txid: SECOND_TXID, outIndex: 0, value: 10000, height: 9 }],
    ],
  });
  const { buildFunding, calls: fundingCalls } = createFundingHarness();
  const sponsorClient = createSponsorFundingClient({
    addressInfo: {
      exists: true,
      balance: 0,
      grantedAmount: 10,
      reservedAmount: 0,
      spentAmount: 0,
      availableAmount: 10,
      status: 'active',
      raw: {},
    },
  });
  const uploader = createMetaFsLargeUploader({
    fetchFn,
    buildFunding,
    sleep: async () => {},
  });

  const result = await uploader.upload({
    filePath,
    fileName: 'quota-short.mp4',
    contentType: 'video/mp4',
    bytes: buffer.length,
    extension: '.mp4',
    network: 'mvc',
    signer: fakeSigner(SPONSOR_IDENTITY),
    mvcSponsorClient: sponsorClient,
  });

  // Advisory quota check stops the sponsor flow before the challenge.
  assert.deepEqual(sponsorClient.calls.map(([name]) => name), ['getAddressInfo']);
  assert.equal(fundingCalls.length, 1);
  assert.equal(result.pinId, 'index-tx-1i0');
  assert.equal(result.feeAssist.used, false);
  assert.equal(result.feeAssist.mode, 'self_paid');
  assert.equal(result.feeAssist.reason, 'insufficient_quota');
  assert.equal(result.feeAssist.stage, 'address_info');
  __clearPendingMvcUtxosForTests();
});

test('createMetaFsLargeUploader does not fall back to the wallet after the sponsor commits the merge transaction', async () => {
  __clearPendingMvcUtxosForTests();
  const { filePath, buffer } = await tempFile('post-commit.mp4', 'post commit failure');
  const { fetchFn } = createFetchHarness({
    utxoPages: [[SPONSOR_ANCHOR_UTXO]],
    chunkedResponses: [{
      code: 1,
      message: 'chunked upload rejected after merge commit',
    }],
  });
  const { buildFunding, calls: fundingCalls } = createFundingHarness();
  const sponsorClient = createSponsorFundingClient();
  const uploader = createMetaFsLargeUploader({
    fetchFn,
    buildFunding,
    sleep: async () => {},
  });

  await assert.rejects(
    () => uploader.upload({
      filePath,
      fileName: 'post-commit.mp4',
      contentType: 'video/mp4',
      bytes: buffer.length,
      extension: '.mp4',
      network: 'mvc',
      signer: fakeSigner(SPONSOR_IDENTITY),
      mvcSponsorClient: sponsorClient,
    }),
    (error) => {
      assert.equal(error.code, 'large_file_upload_metafs_failed');
      assert.match(error.message, /chunked upload rejected after merge commit/i);
      return true;
    },
  );

  // The merge transaction is already broadcast, so the wallet path must not run.
  assert.equal(fundingCalls.length, 0);
  __clearPendingMvcUtxosForTests();
});
