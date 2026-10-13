import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildReplyInfo,
  indexMessagesByPinId,
  isValidQuotePinId,
  QUOTE_CONTENT_MAX_LENGTH,
} = require('../../dist/core/chat/privateConversation.js');

const TARGET_PIN = 'a'.repeat(64) + 'i0';
const OTHER_PIN = 'b'.repeat(64) + 'i0';

function message(overrides = {}) {
  return {
    id: overrides.id || 'row-1',
    pinId: overrides.pinId,
    content: overrides.content ?? 'hello',
    timestamp: overrides.timestamp ?? 1776836184000,
    index: overrides.index ?? 1,
    fromGlobalMetaId: overrides.fromGlobalMetaId || 'idq1sender',
    toGlobalMetaId: overrides.toGlobalMetaId || 'idq1receiver',
    fromUserInfo: overrides.fromUserInfo ?? null,
    toUserInfo: overrides.toUserInfo ?? null,
  };
}

test('isValidQuotePinId accepts a 64-hex pinId with the i0 suffix only', () => {
  assert.equal(isValidQuotePinId(TARGET_PIN), true);
  // Uppercase hex is not the canonical on-chain form.
  assert.equal(isValidQuotePinId('A'.repeat(64) + 'i0'), false);
  // Wrong suffix.
  assert.equal(isValidQuotePinId('a'.repeat(64) + 'i1'), false);
  // Truncated body — the classic hand-copied-pin mistake.
  assert.equal(isValidQuotePinId('a'.repeat(63) + 'i0'), false);
  // Empty / absent.
  assert.equal(isValidQuotePinId(''), false);
  assert.equal(isValidQuotePinId(undefined), false);
});

test('indexMessagesByPinId indexes by pinId and by local id, first occurrence wins', () => {
  const first = message({ id: 'row-1', pinId: TARGET_PIN, content: 'first' });
  const duplicate = message({ id: 'row-2', pinId: TARGET_PIN, content: 'second' });
  const byPinId = indexMessagesByPinId([first, duplicate]);
  assert.equal(byPinId.get(TARGET_PIN).content, 'first');
  // A row with only a local id is still addressable by that id.
  const local = message({ id: 'row-9' });
  assert.equal(indexMessagesByPinId([local]).get('row-9').id, 'row-9');
});

test('buildReplyInfo resolves the quoted body from the same conversation window', () => {
  const target = message({
    id: 'row-1',
    pinId: TARGET_PIN,
    content: 'the original question',
    fromUserInfo: { name: 'Alice' },
  });
  const byPinId = indexMessagesByPinId([target]);
  const info = buildReplyInfo({ replyPin: TARGET_PIN, byPinId });
  assert.equal(info.pinId, TARGET_PIN);
  assert.equal(info.content, 'the original question');
  assert.equal(info.truncated, false);
  assert.equal(info.unresolved, false);
  assert.equal(info.senderLabel, 'Alice');
  assert.equal(info.timestamp, target.timestamp);
});

test('buildReplyInfo flags an out-of-window quote instead of dropping it', () => {
  // A reply whose target fell outside the fetched page must still render as a
  // quote: silently dropping it would make a considered reply look like a
  // non-sequitur.
  const info = buildReplyInfo({ replyPin: OTHER_PIN, byPinId: new Map() });
  assert.equal(info.pinId, OTHER_PIN);
  assert.equal(info.unresolved, true);
  assert.equal(info.content, '');
  assert.equal(info.truncated, false);
});

test('buildReplyInfo returns null when the message carries no quote', () => {
  assert.equal(buildReplyInfo({ replyPin: '', byPinId: new Map() }), null);
});

test('buildReplyInfo truncates a long quote explicitly, never silently', () => {
  const long = 'x'.repeat(QUOTE_CONTENT_MAX_LENGTH + 500);
  const target = message({ pinId: TARGET_PIN, content: long });
  const info = buildReplyInfo({ replyPin: TARGET_PIN, byPinId: indexMessagesByPinId([target]) });
  assert.equal(info.truncated, true);
  assert.equal(info.content.length, QUOTE_CONTENT_MAX_LENGTH + 1);
  assert.equal(info.content.endsWith('…'), true);
});

test('buildReplyInfo keeps a quote of exactly the limit untruncated', () => {
  const exact = 'y'.repeat(QUOTE_CONTENT_MAX_LENGTH);
  const target = message({ pinId: TARGET_PIN, content: exact });
  const info = buildReplyInfo({ replyPin: TARGET_PIN, byPinId: indexMessagesByPinId([target]) });
  assert.equal(info.truncated, false);
  assert.equal(info.content.length, QUOTE_CONTENT_MAX_LENGTH);
});

test('buildReplyInfo falls back to toUserInfo then globalMetaId for the label', () => {
  const toSide = message({ pinId: TARGET_PIN, content: 'x', toUserInfo: { name: 'Bob' } });
  assert.equal(
    buildReplyInfo({ replyPin: TARGET_PIN, byPinId: indexMessagesByPinId([toSide]) }).senderLabel,
    'Bob'
  );
  const bare = message({ pinId: TARGET_PIN, content: 'x', fromGlobalMetaId: 'idq1fallback' });
  assert.equal(
    buildReplyInfo({ replyPin: TARGET_PIN, byPinId: indexMessagesByPinId([bare]) }).senderLabel,
    'idq1fallback'
  );
});
