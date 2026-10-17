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
  // DSH >=0.2.1-alpha.3 reads engines.dsh alone; older gates fall back to the
  // peer ranges and still reject 0.3 through every peer requirement.
  if (Object.hasOwn(issue.requirements, 'engines.dsh')) {
    assert.equal(issue.requirements['engines.dsh'], '>=0.1.5-alpha.1 <0.3.0-0')
  }
})
