import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  allowedClassesFor,
  CAPABILITY_CLASSES,
  isCapabilityClass,
  isPeerTrustTier,
  PEER_TRUST_TIERS,
  TIER_ALLOWED_CLASSES,
} = require('../../dist/core/trust/capabilityClasses.js');

test('TIER_ALLOWED_CLASSES implements the spec permission matrix exactly', () => {
  // From the design spec (2026-10-16) Permission Matrix; C4 is human-only and
  // never present in any tier's remote-reachable classes.
  assert.deepEqual(TIER_ALLOWED_CLASSES, {
    local: ['C0', 'C1', 'C2', 'C3'],
    team: ['C0', 'C1', 'C2', 'C3'],
    trusted: ['C0', 'C1', 'C2'],
    contact: ['C0'],
    stranger: ['C0'],
    blocked: [],
  });
  for (const classes of Object.values(TIER_ALLOWED_CLASSES)) {
    assert.ok(!classes.includes('C4'), 'C4 must never be remote-reachable');
  }
  assert.deepEqual(CAPABILITY_CLASSES, ['C0', 'C1', 'C2', 'C3', 'C4']);
  assert.equal(isCapabilityClass('C2'), true);
  assert.equal(isCapabilityClass('C5'), false);
  assert.equal(PEER_TRUST_TIERS.length, 6);
  assert.equal(isPeerTrustTier('blocked'), true);
  assert.equal(isPeerTrustTier('enemy'), false);
});

test('allowedClassesFor unlocks C2 for contacts only in grouptask context', () => {
  assert.deepEqual(allowedClassesFor('contact', 'grouptask'), ['C0', 'C2']);
  assert.deepEqual(allowedClassesFor('contact', 'chat'), ['C0']);
  assert.deepEqual(allowedClassesFor('contact', 'invite'), ['C0']);
  // Every other tier is context-independent.
  for (const tier of ['local', 'team', 'trusted', 'stranger', 'blocked']) {
    for (const context of ['chat', 'grouptask', 'invite']) {
      assert.deepEqual(allowedClassesFor(tier, context), TIER_ALLOWED_CLASSES[tier], `${tier}/${context}`);
    }
  }
});
