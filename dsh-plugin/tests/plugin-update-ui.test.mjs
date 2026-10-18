import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
async function read(relative) {
  return readFile(join(root, relative), 'utf8')
}

test('the Bots page mounts the update banner and the banner uses the host routes', async () => {
  const page = await read('src/client/bots-page.tsx')
  assert.match(page, /import \{ PluginUpdateBanner \} from '\.\/PluginUpdateBanner\.tsx'/)
  assert.match(page, /<PluginUpdateBanner t=\{t\} \/>/)
  const banner = await read('src/client/PluginUpdateBanner.tsx')
  assert.match(banner, /pluginUpdateStatus\(\)/)
  assert.match(banner, /pluginUpdateApply\(\)/)
  assert.match(banner, /data-oac-update-banner/)
  assert.match(banner, /result\.application === 'restart-required'/)
})

test('the client API reads status with GET and applies through the host POST route', async () => {
  const api = await read('src/client/api.ts')
  assert.match(api, /fetch\('\/oac\/api\/update\/status'/)
  assert.match(api, /return post<PluginUpdateApplyPayload>\('update\/apply'\)/)
})

test('the host route fences, checks npm latest, and hands install to DSH pluginManager', async () => {
  const host = await read('src/index.ts')
  assert.match(host, /method === 'update\/status'/)
  assert.match(host, /checkPluginUpdate\(\{ force \}\)/)
  assert.match(host, /method === 'update\/apply'/)
  assert.match(host, /applyPluginUpdate\(ctx\)/)
  const update = await read('src/plugin-update.ts')
  assert.match(update, /ctx\.get\?\.\('pluginManager'\)/)
  assert.match(update, /manager\.removeBundle\(PLUGIN_PACKAGE_NAME\)/)
  assert.match(update, /manager\.installBundle\(rollback, \{ enabled: true \}\)/)
  assert.match(update, /saveExact: true/)
})
