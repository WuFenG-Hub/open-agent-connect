import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildSettingsPageDefinition } = require('../../dist/ui/pages/settings/app.js');
const { translate } = require('../../dist/ui/i18n.js');

function waitForMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeElement(tag = 'div') {
  const listeners = new Map();
  const children = new Map();
  return {
    tagName: tag,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    hidden: false,
    className: '',
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    addEventListener: (eventName, handler) => listeners.set(eventName, handler),
    listener: (eventName) => listeners.get(eventName),
    querySelector: (selector) => {
      if (!children.has(selector)) children.set(selector, makeElement());
      return children.get(selector);
    },
    querySelectorAll: () => [],
  };
}

const OWNER_IDENTITY = {
  version: 1,
  name: 'Alice',
  path: "m/44'/10001'/0'/0/0",
  publicKey: 'pk-owner',
  chatPublicKey: 'cpk-owner',
  mvcAddress: 'mvc-owner',
  metaId: 'metaid-owner',
  globalMetaId: 'idq1owner000000000000000000000000000',
  createdAt: '2026-10-16T08:00:00.000Z',
  updatedAt: '2026-10-16T08:00:00.000Z',
};

function createHarness(fetchImpl) {
  const elements = {
    '[data-settings-status]': makeElement(),
    '[data-settings-refresh]': makeElement(),
    '[data-user-live]': makeElement(),
    '[data-owner-live]': makeElement(),
    '[data-onboarding-live]': makeElement(),
    '[data-infra-form]': makeElement('form'),
    '[data-infra-status]': makeElement('p'),
    '[data-infra-save]': makeElement('button'),
  };
  const calls = [];
  const context = {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetchImpl(url, options);
    },
    document: {
      querySelector: (selector) => elements[selector] ?? null,
    },
    window: {
      __oacLocalUiI18n: {
        t: (key, replacements = {}) => translate('en', key, replacements),
      },
      addEventListener: () => {},
    },
  };
  return { elements, calls, context };
}

const jsonResponse = (payload) => ({ json: async () => payload });

function baseFetcher(overrides = {}) {
  return async (url, options = {}) => {
    const key = `${options.method || 'GET'}:${url}`;
    const table = {
      'GET:/api/user/who': { ok: true, data: { identity: null } },
      'GET:/api/owner/who': { ok: true, data: { identity: null } },
      'GET:/api/user/onboarding': { ok: true, data: { onboarding: null, identityPresent: false } },
      'GET:/api/config': { ok: true, data: {} },
      ...overrides,
    };
    if (table[key]) return jsonResponse(table[key]);
    throw new Error(`Unexpected request: ${key}`);
  };
}

test('owner section invites action when no root owner exists, then creates one with a once-shown mnemonic', async () => {
  let owner = null;
  const h = createHarness(baseFetcher({
    'GET:/api/owner/who': { ok: true, data: { identity: owner, deviceBinding: 'unbound' } },
    'POST:/api/owner/create': {
      ok: true,
      data: {
        identity: OWNER_IDENTITY,
        mnemonic: 'one two three four five six seven eight nine ten eleven twelve',
        deviceBinding: 'unbound',
      },
    },
  }));
  // Re-read the owner on every who/create call.
  h.context.fetch = async (url, options) => {
    h.calls.push({ url, options });
    if (url === '/api/owner/who') return jsonResponse({ ok: true, data: { identity: owner, deviceBinding: owner ? 'unbound' : 'unknown' } });
    if (url === '/api/owner/create') {
      owner = OWNER_IDENTITY;
      return jsonResponse({
        ok: true,
        data: { identity: owner, mnemonic: 'one two three four five six seven eight nine ten eleven twelve', deviceBinding: 'unbound' },
      });
    }
    return baseFetcher()(url, options);
  };
  vm.runInNewContext(buildSettingsPageDefinition().script, h.context);
  await waitForMicrotasks();
  await waitForMicrotasks();

  const live = h.elements['[data-owner-live]'];
  assert.match(live.innerHTML, /No root owner identity on this machine yet/);

  live.querySelector('[data-owner-create-name]').value = 'Alice';
  await live.querySelector('[data-owner-create-form]').listener('submit')({ preventDefault() {} });
  await waitForMicrotasks();

  const createCall = h.calls.find((call) => call.url === '/api/owner/create');
  assert.deepEqual(JSON.parse(createCall.options.body), { name: 'Alice' });
  assert.match(live.innerHTML, /idq1owner000000000000000000000000000/);
  assert.match(live.innerHTML, /will not be shown again/);
  assert.match(live.innerHTML, /••• •••/);
  assert.doesNotMatch(live.innerHTML, /one two three/);

  live.querySelector('[data-owner-mnemonic-toggle]').listener('click')();
  assert.match(live.innerHTML, /one two three/);
});

test('owner section shows binding state and binds behind a two-step confirm', async () => {
  let binding = 'unbound';
  const h = createHarness(async (url, options = {}) => {
    if (url === '/api/owner/who') return jsonResponse({ ok: true, data: { identity: OWNER_IDENTITY, deviceBinding: binding } });
    if (url === '/api/owner/bind-device') {
      binding = 'bound';
      return jsonResponse({ ok: true, data: { ownerBinding: { pinId: 'bind-pin-1' }, chainWrites: [] } });
    }
    return baseFetcher()(url, options);
  });
  vm.runInNewContext(buildSettingsPageDefinition().script, h.context);
  await waitForMicrotasks();
  await waitForMicrotasks();

  const live = h.elements['[data-owner-live]'];
  assert.match(live.innerHTML, /NOT bound to your owner yet/);

  // First click only arms the confirm and explains the on-chain pin.
  live.querySelector('[data-owner-bind]').listener('click')();
  assert.match(live.innerHTML, /Publishes an on-chain \/info\/owner pin/);
  assert.ok(!h.calls.some((call) => call.url === '/api/owner/bind-device'), 'no publish before the confirm');

  live.querySelector('[data-owner-bind-confirm]').listener('click')();
  await waitForMicrotasks();
  await waitForMicrotasks();

  assert.ok(h.calls.some((call) => call.url === '/api/owner/bind-device'));
  assert.match(live.innerHTML, /Device bound to your owner on-chain/);
  assert.match(live.innerHTML, /is bound to your owner/);
});

test('owner reveal is guarded and lands masked like the device reveal', async () => {
  const h = createHarness(async (url, options = {}) => {
    if (url === '/api/owner/who') return jsonResponse({ ok: true, data: { identity: OWNER_IDENTITY, deviceBinding: 'bound' } });
    if (url === '/api/owner/reveal') {
      return jsonResponse({ ok: true, data: { mnemonic: 'one two three four five six seven eight nine ten eleven twelve' } });
    }
    return baseFetcher()(url, options);
  });
  vm.runInNewContext(buildSettingsPageDefinition().script, h.context);
  await waitForMicrotasks();
  await waitForMicrotasks();

  const live = h.elements['[data-owner-live]'];
  // Bound state shows no bind button.
  assert.doesNotMatch(live.innerHTML, /data-owner-bind"/);

  live.querySelector('[data-owner-reveal]').listener('click')();
  assert.match(live.innerHTML, /Click again to view/);
  assert.ok(!h.calls.some((call) => call.url === '/api/owner/reveal'));

  live.querySelector('[data-owner-reveal-confirm]').listener('click')();
  await waitForMicrotasks();
  assert.match(live.innerHTML, /••• •••/);
  live.querySelector('[data-owner-revealed-toggle]').listener('click')();
  assert.match(live.innerHTML, /one two three/);
});

test('owner section surfaces server errors with a fix hint', async () => {
  const h = createHarness(async (url, options = {}) => {
    if (url === '/api/owner/who') return jsonResponse({ ok: true, data: { identity: null } });
    if (url === '/api/owner/create') {
      return jsonResponse({
        ok: false,
        code: 'root_owner_exists',
        message: 'A root owner identity already exists on this machine.',
      });
    }
    return baseFetcher()(url, options);
  });
  vm.runInNewContext(buildSettingsPageDefinition().script, h.context);
  await waitForMicrotasks();
  await waitForMicrotasks();

  const live = h.elements['[data-owner-live]'];
  await live.querySelector('[data-owner-create-form]').listener('submit')({ preventDefault() {} });
  await waitForMicrotasks();
  assert.match(live.innerHTML, /A root owner identity already exists on this machine\..*delete it first/);
});
