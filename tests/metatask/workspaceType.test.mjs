// `spec.workspace.type` is a declaration the engine never reads: only
// `type === "git"` has any enforcement (the submit guard's git-bundle rule), and
// nothing else in the repo consumes it. A type outside the declared set therefore
// publishes as a contract that nothing enforces — silently. The writer-side check
// exists precisely to refuse that before any spend, so it has to check the value,
// not merely that one is present.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { specWorkspaceRefusal } = require('../../dist/core/metatask/writer.js');

const FOUR = ['git', 'metafile', 'inline', 'pin'];

test('workspace: each declared type is accepted', () => {
  for (const type of FOUR) {
    assert.equal(specWorkspaceRefusal({ type }), null, `${type} must be accepted`);
  }
});

test('workspace: a type outside the declared set is refused, naming it', () => {
  const refusal = specWorkspaceRefusal({ type: 'banana' });
  assert.notEqual(refusal, null, 'an undeclarable type must be refused, not silently published');
  assert.match(refusal, /banana/, 'the refusal must name the offending value');
  assert.match(refusal, /git/, 'the refusal must name the declared set so the fix is obvious');
});

test('workspace: an absent or empty type is still refused as missing', () => {
  assert.match(specWorkspaceRefusal({}), /type is required/);
  assert.match(specWorkspaceRefusal({ type: '   ' }), /type is required/);
});

test('workspace: an undeclared workspace stays a no-op', () => {
  assert.equal(specWorkspaceRefusal(undefined), null);
  assert.equal(specWorkspaceRefusal(null), null);
});
