import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { parseJsonFence } = require('../../dist/core/surf/turn.js');

test('parses a plain single json fence (legacy behavior)', () => {
  const reply = 'Some prose\n```json\n{"action":"report","args":{}}\n```\n trailing';
  assert.deepEqual(parseJsonFence(reply), { action: 'report', args: {} });
});

test('parses a json fence whose string payload embeds markdown fences', () => {
  const content = 'intro\n```js\nconst a = 1;\n```\noutro';
  const reply = `\`\`\`json\n${JSON.stringify({ action: 'knowledge_base_add_document', args: { title: 'T', content } })}\n\`\`\``;
  const parsed = parseJsonFence(reply);
  assert.equal(parsed.action, 'knowledge_base_add_document');
  assert.equal(parsed.args.content, content);
});

test('returns null when no fence parses', () => {
  assert.equal(parseJsonFence('no fences here'), null);
  assert.equal(parseJsonFence('```json\n{broken\n```'), null);
});
