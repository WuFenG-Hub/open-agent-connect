import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  metawebPinsBatch,
  renderMetawebPinsBatch,
  buildMetawebBatchReadReceipt,
  MetawebBatchTooLargeError,
  METAWEB_PINS_BATCH_MAX,
  METAWEB_BATCH_RESULT_CHAR_BUDGET,
  METAWEB_BATCH_READ_CALIBER,
} = require('../../dist/core/metaweb/pinBatchRead.js');
const { formatMetawebPinDetail } = require('../../dist/core/metaweb/format.js');

function jsonResponse(body) {
  return { status: 200, ok: true, json: async () => body };
}

function batchPin(overrides = {}) {
  return {
    pinId: 'p1',
    currentPinId: 'p1',
    protocol: 'simplenote',
    path: '/protocols/simplenote',
    chainName: 'mvc',
    operation: 'create',
    creator: { globalMetaId: 'gm-author', metaid: 'meta-1', name: 'Author', address: '' },
    createdAt: 1,
    contentType: 'text/markdown',
    payload: null,
    text: 'short body',
    truncated: false,
    totalLength: 10,
    meta: { title: 'T', summary: 's', tags: [] },
    attachments: [],
    source: 'local',
    version: { latest: 'p1', count: 1 },
    ...overrides,
  };
}

test('metawebPinsBatch posts the pinIds and normalizes per-pin entries (pin / error / missing)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(init?.body) });
    return jsonResponse({
      code: 0,
      data: {
        pins: {
          okpin: batchPin({ pinId: 'okpin', currentPinId: 'okpin', text: 'body of okpin', version: { latest: 'okpin', count: 3 } }),
          badpin: { pinId: 'badpin', error: 'pin not found' },
        },
      },
    });
  };
  const entries = await metawebPinsBatch(['okpin', 'badpin', 'ghostpin'], { baseUrl: 'https://so.test/', fetchImpl, timeoutMs: 2000 });

  assert.equal(calls[0].url, 'https://so.test/api/metaweb/pins:batch');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { pinIds: ['okpin', 'badpin', 'ghostpin'] });

  assert.equal(entries.okpin.text, 'body of okpin');
  assert.equal(entries.okpin.version.latest, 'okpin');
  assert.equal(entries.okpin.version.count, 3, 'version block rides through normalization');
  assert.deepEqual(entries.badpin, { pinId: 'badpin', error: 'pin not found' });
  assert.deepEqual(entries.ghostpin, { pinId: 'ghostpin', error: 'pin missing from batch response' });
});

test('metawebPinsBatch enforces the 50-pin ceiling and non-empty input', async () => {
  const fetchImpl = async () => jsonResponse({ code: 0, data: { pins: {} } });
  await assert.rejects(() => metawebPinsBatch([], { fetchImpl }), /at least one pinId/);
  const many = Array.from({ length: METAWEB_PINS_BATCH_MAX + 1 }, (_, i) => `p${i}`);
  await assert.rejects(
    () => metawebPinsBatch(many, { fetchImpl }),
    (error) => /at most 50 pinIds/.test(error.message),
  );
});

test('renderMetawebPinsBatch water-fills: short bodies whole, long bodies trimmed with labels and receipt', () => {
  const short1 = batchPin({ pinId: 's1', text: 'a'.repeat(500) });
  const short2 = batchPin({ pinId: 's2', text: 'b'.repeat(300) });
  const long = batchPin({ pinId: 'L1', text: 'x'.repeat(16_000) });
  const entries = { s1: short1, s2: short2, L1: long };
  const { text, receipt, deliveredPins } = renderMetawebPinsBatch(['s1', 's2', 'L1'], entries);

  assert.ok(text.length <= METAWEB_BATCH_RESULT_CHAR_BUDGET, `render stays under the budget (${text.length})`);
  assert.match(text, /^3\/3 pin\(s\) readable in this batch; 1 body\(ies\) trimmed or omitted/);
  assert.ok(text.includes('- RECEIPT read_metaweb_pins_batch: '));

  const receiptLine = text.split('\n').find((line) => line.startsWith('- RECEIPT read_metaweb_pins_batch: '));
  const parsed = JSON.parse(receiptLine.slice('- RECEIPT read_metaweb_pins_batch: '.length));
  assert.equal(parsed.requested, 3);
  assert.equal(parsed.readable_upstream, 3);
  assert.equal(parsed.omitted, 0);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.caliber, METAWEB_BATCH_READ_CALIBER);
  assert.ok(parsed.truncation_points.some((point) => point.reason === 'trimmed' && point.pin_id === 'L1'));
  // bytes_written is a fixed point: the receipt reports the byte length of
  // the text that contains it.
  assert.equal(parsed.bytes_written, Buffer.byteLength(text, 'utf8'));

  assert.equal(deliveredPins.length, 3, 'all readable bodies delivered (whole or trimmed)');
  assert.ok(text.includes(`${'a'.repeat(500)}`), 'short body rendered whole');
  const trimNote = text.match(/showing first (\d+) of 16000 chars — trimmed to fit this batch's result budget/);
  assert.ok(trimNote, 'long body carries a per-pin trim label');
  assert.ok(Number(trimNote[1]) > 0);
});

test('renderMetawebPinsBatch omits bodies below the floor and labels them', () => {
  // 24 × 8000-char bodies: each pin's equal share of the leftover budget
  // falls below the 240-char floor, so the water-fill drops whole bodies to
  // labeled pointers instead of token slivers.
  const entries = {};
  const ids = [];
  for (let i = 0; i < 24; i += 1) {
    const id = `om${i}`;
    ids.push(id);
    entries[id] = batchPin({ pinId: id, text: 'z'.repeat(8_000) });
  }
  const { text, receipt, deliveredPins } = renderMetawebPinsBatch(ids, entries);

  assert.ok(text.length <= METAWEB_BATCH_RESULT_CHAR_BUDGET, `render stays under the budget (${text.length})`);
  const receiptLine = text.split('\n').find((line) => line.startsWith('- RECEIPT read_metaweb_pins_batch: '));
  const parsed = JSON.parse(receiptLine.slice('- RECEIPT read_metaweb_pins_batch: '.length));

  assert.ok(parsed.omitted > 0, 'at least one body dropped for budget');
  assert.equal(parsed.readable_upstream, 24);
  assert.equal(parsed.omitted + parsed.returned, 24, 'omitted + returned accounts for every readable body');
  assert.equal(parsed.omitted_ids.length, Math.min(parsed.omitted, 12), 'omitted_ids capped at 12 while omitted stays exact');
  for (const id of parsed.omitted_ids.slice(0, 3)) {
    assert.match(
      text,
      new RegExp(`- content omitted to fit this batch's result budget \\(8000 chars\\) — read_metaweb_pin ${id} for the full body`),
    );
  }
  assert.equal(deliveredPins.length, parsed.returned);
  assert.equal(parsed.bytes_written, Buffer.byteLength(text, 'utf8'));
});

test('renderMetawebPinsBatch isolates per-pin errors and encrypted bodies without failing the batch', () => {
  const ok = batchPin({ pinId: 'ok', text: 'fine' });
  const enc = batchPin({ pinId: 'enc', text: null, truncated: null, totalLength: null });
  const entries = { ok, enc, bad: { pinId: 'bad', error: 'pin not found' } };
  const { text, receipt } = renderMetawebPinsBatch(['ok', 'enc', 'bad'], entries);

  assert.match(text, /^1\/3 pin\(s\) readable in this batch:/);
  assert.match(text, /## enc\n- \(simplenote\) has no readable text content \(encrypted, binary, or empty\)/);
  assert.match(text, /## bad\n- error: pin not found/);
  assert.equal(receipt.readable_upstream, 1);
  assert.equal(receipt.unreadable, 2);
  assert.deepEqual(receipt.unreadable_ids, ['enc', 'bad']);
  assert.equal(receipt.returned, 1);
});

test('renderMetawebPinsBatch: all-unreadable batch still returns a zero-delivery receipt', () => {
  const entries = { bad: { pinId: 'bad', error: 'gone' } };
  const { text, receipt } = renderMetawebPinsBatch(['bad', 'ghost'], entries);
  assert.match(text, /^0\/2 pin\(s\) readable in this batch:/);
  assert.equal(receipt.readable_upstream, 0);
  assert.equal(receipt.returned, 0);
  assert.equal(receipt.unreadable, 2);
});

test('renderMetawebPinsBatch records the upstream 8000-rune cap as a server_cap cut', () => {
  const capped = batchPin({ pinId: 'cap', text: 'c'.repeat(8_000), truncated: true, totalLength: 9_500 });
  const { receipt } = renderMetawebPinsBatch(['cap'], { cap: capped });
  const serverCap = receipt.truncation_points.find((point) => point.reason === 'server_cap');
  assert.ok(serverCap, 'server_cap point recorded');
  assert.equal(serverCap.pin_id, 'cap');
  assert.equal(serverCap.kept_chars, 8_000);
  assert.equal(serverCap.total_chars, 9_500);
  assert.equal(serverCap.unit, 'rune');
});

test('renderMetawebPinsBatch fails loudly when even skeletons bust the budget', () => {
  const pins = {};
  const ids = [];
  for (let i = 0; i < 120; i += 1) {
    const id = `big${i}`;
    ids.push(id);
    pins[id] = batchPin({ pinId: id, text: 't'.repeat(50) });
  }
  assert.throws(
    () => renderMetawebPinsBatch(ids, pins),
    (error) => error instanceof MetawebBatchTooLargeError && /cannot render within the result budget/.test(error.message),
  );
});

test('buildMetawebBatchReadReceipt solves bytes_written to a fixed point', () => {
  const text = buildMetawebBatchReadReceipt({
    header: 'h',
    sections: ['a', 'b'],
    receipt: {
      requested: 1,
      readable_upstream: 1,
      returned: 1,
      truncated: false,
      omitted: 0,
      omitted_ids: [],
      unreadable: 0,
      unreadable_ids: [],
      truncation_point_count: 0,
      truncation_points: [],
      caliber: METAWEB_BATCH_READ_CALIBER,
    },
  });
  const markerLine = text.split('\n').find((line) => line.startsWith('- RECEIPT read_metaweb_pins_batch: '));
  const parsed = JSON.parse(markerLine.slice('- RECEIPT read_metaweb_pins_batch: '.length));
  assert.equal(parsed.bytes_written, Buffer.byteLength(text, 'utf8'));
});

test('formatMetawebPinDetail supports bodyCharCap and omitBody budget rendering', () => {
  const pin = batchPin({ pinId: 'bp', text: 'd'.repeat(1_000) });
  const capped = formatMetawebPinDetail(pin, { bodyCharCap: 40 });
  assert.match(capped, /showing first 40 of 1000 chars — trimmed to fit this batch's result budget; full body via read_metaweb_pin/);
  assert.ok(!capped.includes('d'.repeat(41)), 'body actually capped');

  const omitted = formatMetawebPinDetail(pin, { omitBody: true });
  assert.match(omitted, /- content omitted to fit this batch's result budget \(1000 chars\) — read_metaweb_pin bp for the full body/);
  assert.ok(!omitted.includes('<metaweb_pin_content>'));

  // Default call shape is unchanged (no opts).
  const plain = formatMetawebPinDetail(pin);
  assert.ok(plain.includes('d'.repeat(1_000)));
});
