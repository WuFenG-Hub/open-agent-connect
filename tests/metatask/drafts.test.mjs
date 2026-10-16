import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildParticipateDraft, suggestParticipateNode } = require('../../dist/core/metatask/drafts.js');

/**
 * Participation drafts (UI reference F13): the IDBots templates ported with
 * `metabot metatask …` verbs, mode-aware, with the suggested-node hint; the
 * UIs only hand the draft out — they never write.
 */

const projectionOf = (over = {}) => ({
  rootPinId: 'task000000000000000000000000000000000000000000000000000001i0',
  title: 'witness extraction',
  policy: { mode: 'tree' },
  nodeStates: {
    r1: { id: 'r1', status: 'open', deps: [], submissions: [] },
    t1: { id: 't1', status: 'open', deps: [], submissions: [] },
  },
  ...over,
});

test('drafts: tree template names the task, root and CLI verbs (en + zh)', () => {
  const draft = buildParticipateDraft(projectionOf(), { lang: 'en' });
  assert.equal(draft.mode, 'tree');
  assert.equal(draft.node, 'r1', 'first open node suggested');
  assert.match(draft.text, /"witness extraction"/);
  assert.match(draft.text, /task000000000000000000000000000000000000000000000000000001i0/);
  assert.match(draft.text, /node r1 is a good candidate/);
  assert.match(draft.text, /metabot metatask claim --root <root> --node <id> --from <bot>/);
  assert.match(draft.text, /metabot metatask submit --request-file <json>/);
  assert.match(draft.text, /#8\/#9 gates/);

  const zh = buildParticipateDraft(projectionOf(), { lang: 'zh' });
  assert.match(zh.text, /「witness extraction」/);
  assert.match(zh.text, /建议从节点 r1 开始评估/);
  assert.match(zh.text, /metabot metatask claim/);
  assert.match(zh.text, /#8\/#9 门禁/);
});

test('drafts: competitive template explains fork racing and parentRefs', () => {
  const competitive = projectionOf({
    policy: { mode: 'competitive' },
    nodeStates: {
      r1: { id: 'r1', status: 'open', deps: ['t1'], submissions: [] },
      t1: { id: 't1', status: 'open', deps: [], submissions: [] },
    },
  });
  const draft = buildParticipateDraft(competitive, { lang: 'en' });
  assert.equal(draft.mode, 'competitive');
  assert.match(draft.text, /COMPETITIVE task/);
  assert.match(draft.text, /intent signal/);
  assert.match(draft.text, /parentRefs \(one submission pinId per dep; entry nodes omit it\)/);
  assert.equal(draft.node, 't1', 'entry node preferred over the join node');

  const zh = buildParticipateDraft(competitive, { lang: 'zh' });
  assert.match(zh.text, /竞赛任务/);
  assert.match(zh.text, /乐观抢跑、自担风险/);
});

test('drafts: node suggestion prefers open entry nodes with the fewest candidates', () => {
  // t2 has fewer competing candidates than t1 → suggested.
  const ranked = suggestParticipateNode(projectionOf({
    nodeStates: {
      t1: { id: 't1', status: 'open', deps: [], submissions: [{}, {}] },
      t2: { id: 't2', status: 'open', deps: [], submissions: [{}] },
    },
  }));
  assert.equal(ranked, 't2');

  // No entry nodes → falls back to dep-carrying open nodes.
  const fallback = suggestParticipateNode(projectionOf({
    nodeStates: {
      r1: { id: 'r1', status: 'open', deps: ['a'], submissions: [] },
      a: { id: 'a', status: 'verified', deps: [], submissions: [] },
    },
  }));
  assert.equal(fallback, 'r1');

  // Everything verified → no hint.
  const settled = suggestParticipateNode(projectionOf({
    nodeStates: { a: { id: 'a', status: 'verified', deps: [], submissions: [] } },
  }));
  assert.equal(settled, null);
});

/**
 * Suggested-node eligibility is MODE-AWARE. In tree mode a `claimed` node is
 * locked by someone else and the claim guard (writer.ts) refuses it, so it must
 * never be suggested. Competitive mode has no node lock, so any non-verified
 * node is a legitimate candidate.
 */
const treeOf = (nodeStates) => ({
  rootPinId: 'task000000000000000000000000000000000000000000000000000002i0',
  title: 'tree task',
  policy: { mode: 'tree' },
  nodeStates,
});
const competitiveOf = (nodeStates) => ({
  rootPinId: 'task000000000000000000000000000000000000000000000000000003i0',
  title: 'competitive task',
  policy: { mode: 'competitive' },
  nodeStates,
});

test('drafts: tree mode never suggests a claimed node (the claim guard would refuse it)', () => {
  const draft = buildParticipateDraft(
    treeOf({ r1: { id: 'r1', status: 'claimed', deps: [], submissions: [] } }),
    { lang: 'en' },
  );
  assert.equal(draft.node, null, 'a claimed node is not claimable in tree mode');
  assert.doesNotMatch(draft.text, /good candidate/, 'no node hint when nothing is open');
});

test('drafts: tree mode prefers an open node over a claimed one with fewer contenders', () => {
  const draft = buildParticipateDraft(
    treeOf({
      r1: { id: 'r1', status: 'claimed', deps: [], submissions: [] },
      r2: { id: 'r2', status: 'open', deps: [], submissions: [{}, {}, {}] },
    }),
    { lang: 'en' },
  );
  assert.equal(draft.node, 'r2', 'eligibility beats the contender ranking');
});

test('drafts: competitive mode still suggests a claimed node (no node lock there)', () => {
  const draft = buildParticipateDraft(
    competitiveOf({ r1: { id: 'r1', status: 'claimed', deps: [], submissions: [] } }),
    { lang: 'en' },
  );
  assert.equal(draft.node, 'r1', 'competitive mode has no lock, so claimed nodes stay eligible');
});

test('drafts: competitive mode does not suggest a verified node', () => {
  const draft = buildParticipateDraft(
    competitiveOf({
      r1: { id: 'r1', status: 'verified', deps: [], submissions: [] },
      r2: { id: 'r2', status: 'claimed', deps: [], submissions: [] },
    }),
    { lang: 'en' },
  );
  assert.equal(draft.node, 'r2');
});

test('drafts: nothing eligible leaves the hint out', () => {
  const tree = buildParticipateDraft(
    treeOf({ r1: { id: 'r1', status: 'verified', deps: [], submissions: [] } }),
    { lang: 'en' },
  );
  assert.equal(tree.node, null);
  const competitive = buildParticipateDraft(
    competitiveOf({ r1: { id: 'r1', status: 'verified', deps: [], submissions: [] } }),
    { lang: 'en' },
  );
  assert.equal(competitive.node, null);
});
