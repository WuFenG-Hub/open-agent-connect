import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the manifest passes the DSH compatibility gate on the installed kernel', () => {
  const runtime = getDshRuntimeVersion()
  const issue = evaluatePluginCompatibility(manifest, {}, runtime)
  assert.equal(issue, undefined, issue === undefined ? '' : JSON.stringify(issue.requirements))
})

test('the manifest rejects an unsupported DSH 0.3 kernel', () => {
  const issue = evaluatePluginCompatibility(manifest, {}, '0.3.0-alpha.1')
  assert.notEqual(issue, undefined)
  // The gate's return shape moved: DSH >=0.2.1-alpha.3 reports guidance through
  // `requirements` (engines.dsh first), while older kernels report the
  // incompatible peers themselves and carry no `requirements` key at all.
  // Assert per shape instead of assuming the newer one, and keep the older
  // branch as sharp: with 0.3 unsupported, EVERY declared dsh peer must come
  // back incompatible (a range that admits 0.3 would silently drop out).
  if (issue.requirements) {
    assert.equal(issue.requirements['engines.dsh'], '>=0.1.5-alpha.1 <0.3.0-0')
  } else {
    const declaredDshPeers = Object.keys(manifest.peerDependencies ?? {})
      .filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    assert.ok(declaredDshPeers.length > 0, 'the manifest declares dsh peers')
    assert.deepEqual(Object.keys(issue.peers).sort(), declaredDshPeers.sort())
  }
})
