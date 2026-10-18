import assert from 'node:assert/strict'
import test from 'node:test'

const plugin = await import('../lib/index.js')
const { currentPluginVersion } = await import('../lib/plugin-update.js')

function request(method, url, headers = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {},
  }
}

function capture() {
  const box = { status: 0, body: '', res: null }
  box.res = {
    statusCode: 0,
    writeHead(status) { box.status = status },
    end(body) { box.body = body === undefined ? '' : String(body) },
  }
  return box
}

test('update status route is fenced and reports disabled checks without network', async () => {
  const routes = []
  const ctx = {
    connection: { requestRejection() { return undefined } },
    webServer: {
      register(route) { routes.push(route); return () => {} },
    },
    effect(fn) { fn() },
  }
  const previous = process.env.OAC_DSH_UPDATE_DISABLED
  process.env.OAC_DSH_UPDATE_DISABLED = '1'
  try {
    await plugin.apply(ctx, { skipBootstrap: true })
    assert.equal(routes.length, 1)
    const reply = capture()
    await routes[0].handler(request('GET', '/oac/api/update/status?refresh=1'), reply.res)
    assert.equal(reply.status, 502)
    const body = JSON.parse(reply.body)
    assert.equal(body.ok, false)
    assert.equal(body.code, 'disabled')
    assert.equal(body.data.current, currentPluginVersion())
  } finally {
    if (previous === undefined) delete process.env.OAC_DSH_UPDATE_DISABLED
    else process.env.OAC_DSH_UPDATE_DISABLED = previous
  }
})
