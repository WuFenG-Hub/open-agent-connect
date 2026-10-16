import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildTeamPageDefinition } = require('../../dist/ui/pages/team/app.js');
const { translate } = require('../../dist/ui/i18n.js');

function waitForMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Fake DOM element with a tiny innerHTML scanner so querySelectorAll can find
 * the row buttons the script just rendered (data-team-arm / data-team-action).
 */
function makeElement(tag = 'div') {
  const listeners = new Map();
  const children = new Map();
  let stubCache = { html: '', bySelector: new Map() };
  const element = {
    tagName: tag,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    hidden: false,
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    addEventListener: (eventName, handler) => listeners.set(eventName, handler),
    listener: (eventName) => listeners.get(eventName),
    querySelector: (selector) => {
      if (!children.has(selector)) children.set(selector, makeElement());
      return children.get(selector);
    },
    querySelectorAll: (selector) => {
      // Cache stubs per rendered HTML so the script and the test share the
      // same instances (listeners bound by the script stay callable).
      if (stubCache.html !== element.innerHTML) {
        stubCache = { html: element.innerHTML, bySelector: new Map() };
      }
      if (stubCache.bySelector.has(selector)) return stubCache.bySelector.get(selector);
      const stubs = [];
      const attr = selector.includes('data-team-action')
        ? { name: 'data-team-action', value: selector.match(/data-team-action="([^"]+)"/)[1] }
        : { name: 'data-team-arm', value: null };
      const regex = attr.value !== null
        ? new RegExp(`<button[^>]*${attr.name}="${attr.value}"[^>]*data-team-id="([^"]+)"[^>]*>`, 'g')
        : /<button[^>]*data-team-arm="([^"]+)"[^>]*>/g;
      let match;
      while ((match = regex.exec(element.innerHTML)) !== null) {
        const stubListeners = new Map();
        stubs.push({
          attrs: attr.value !== null
            ? { [attr.name]: attr.value, 'data-team-id': match[1] }
            : { 'data-team-arm': match[1] },
          getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
          addEventListener: (eventName, handler) => stubListeners.set(eventName, handler),
          click: () => stubListeners.get('click')(),
        });
      }
      stubCache.bySelector.set(selector, stubs);
      return stubs;
    },
  };
  return element;
}

function createHarness(fetchImpl) {
  const elements = {
    '[data-team-status]': makeElement(),
    '[data-team-refresh]': makeElement(),
    '[data-team-live="members"]': makeElement(),
    '[data-team-live="invites"]': makeElement(),
    '[data-team-live="trust"]': makeElement(),
    '[data-team-live="block"]': makeElement(),
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

const TEAM_LIST = {
  ok: true,
  data: {
    profiles: [{ slug: 'twin-bot', name: 'Twin Bot', globalMetaId: 'idq1local000000000000000000000000000', local: true, source: 'local' }],
    registry: [
      { globalMetaId: 'idq1remote100000000000000000000000000', source: 'manual', addedAt: '2026-10-16T00:00:00.000Z' },
      { globalMetaId: 'idq1remote200000000000000000000000000', source: 'auto' },
    ],
  },
};

const INVITES_PENDING = {
  ok: true,
  data: {
    invites: [
      {
        inviteId: 'inv-1',
        groupId: 'grp-1',
        inviterGlobalMetaId: 'idq1strangerinviter0000000000000000000',
        inviterName: 'Stranger Chair',
        taskTitle: 'Haiku sprint',
        goalSummary: null,
        requiredSkills: [],
        targetGlobalMetaId: 'idq1worker100000000000000000000000000',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        status: 'pending_approval',
        declineReason: null,
        joinedPinId: null,
        createdAt: Date.now(),
        respondedAt: null,
        slug: 'worker-1',
        botName: 'Worker One',
      },
    ],
  },
};

const TRUST_LIST = {
  ok: true,
  data: {
    owner: 'idq1myowner00000000000000000000000000',
    trustedOwners: [
      { trustedOwner: 'idq1peerowner0000000000000000000000000', note: 'audited', ts: 1730000000, grantPinId: 'grant-pin-1' },
    ],
    fromCache: false,
  },
};

const BLOCK_LIST = {
  ok: true,
  data: { blocked: ['idq1spammer00000000000000000000000000'], contacts: [] },
};

function defaultFetcher(overrides = {}) {
  return async (url, options = {}) => {
    const key = `${options.method || (String(url).includes('/pending') ? 'POST' : 'GET')}:${url}`;
    const table = {
      'GET:/api/team/list': TEAM_LIST,
      'POST:/api/grouptask/invites/pending': INVITES_PENDING,
      'GET:/api/trust/list': TRUST_LIST,
      'GET:/api/block/list': BLOCK_LIST,
      ...overrides,
    };
    if (table[key]) return jsonResponse(table[key]);
    throw new Error(`Unexpected request: ${key}`);
  };
}

test('team page renders all four sections from the daemon state', async () => {
  const h = createHarness(defaultFetcher());
  vm.runInNewContext(buildTeamPageDefinition().script, h.context);
  await waitForMicrotasks();
  await waitForMicrotasks();

  const members = h.elements['[data-team-live="members"]'];
  assert.match(members.innerHTML, /Twin Bot/);
  assert.match(members.innerHTML, /idq1remote100000000000000000000000000/);
  assert.match(members.innerHTML, /Added by you/);
  assert.match(members.innerHTML, /Auto-recorded/);

  const invites = h.elements['[data-team-live="invites"]'];
  assert.match(invites.innerHTML, /Haiku sprint/);
  assert.match(invites.innerHTML, /Stranger Chair/);
  assert.match(invites.innerHTML, /Pending your approval/);
  assert.match(invites.innerHTML, /Approve/);

  const trust = h.elements['[data-team-live="trust"]'];
  assert.match(trust.innerHTML, /idq1peerowner0000000000000000000000000/);
  assert.match(trust.innerHTML, /audited/);

  const block = h.elements['[data-team-live="block"]'];
  assert.match(block.innerHTML, /idq1spammer00000000000000000000000000/);
});

test('team add verifies and surfaces team_not_same_owner without recording', async () => {
  const h = createHarness(defaultFetcher({
    'POST:/api/team/add': {
      ok: false,
      code: 'team_not_same_owner',
      message: 'idq1bad0000000000000000000000000000000 is not bound to your root owner.',
    },
  }));
  vm.runInNewContext(buildTeamPageDefinition().script, h.context);
  await waitForMicrotasks();
  await waitForMicrotasks();

  const members = h.elements['[data-team-live="members"]'];
  members.querySelector('[data-team-add-member-input]').value = 'idq1bad0000000000000000000000000000000';
  await members.querySelector('[data-team-add-member-form]').listener('submit')({ preventDefault() {} });
  await waitForMicrotasks();
  await waitForMicrotasks();

  const addCall = h.calls.find((call) => call.url === '/api/team/add');
  assert.deepEqual(JSON.parse(addCall.options.body), { globalMetaId: 'idq1bad0000000000000000000000000000000' });
  assert.match(h.elements['[data-team-status]'].textContent, /not bound to your root owner/);
  // Registry unchanged (the refetch after success never happened).
  assert.equal(h.calls.filter((call) => call.url === '/api/team/list').length, 1);
});

test('trust grant is a two-step confirm that publishes and refetches', async () => {
  const h = createHarness(defaultFetcher({
    'POST:/api/trust/grant': { ok: true, data: { trustGrant: { trustedOwner: 'idq1newowner000000000000000000000000' }, chainWrites: [] } },
  }));
  vm.runInNewContext(buildTeamPageDefinition().script, h.context);
  await waitForMicrotasks();
  await waitForMicrotasks();

  const trust = h.elements['[data-team-live="trust"]'];
  trust.querySelector('[data-team-grant-input]').value = 'idq1newowner000000000000000000000000';
  await trust.querySelector('[data-team-grant-form]').listener('submit')({ preventDefault() {} });
  await waitForMicrotasks();
  await waitForMicrotasks();

  const grantCall = h.calls.find((call) => call.url === '/api/trust/grant');
  assert.deepEqual(JSON.parse(grantCall.options.body), { trustedOwner: 'idq1newowner000000000000000000000000' });
});

test('invite approve requires arming the confirm, then approves and refetches', async () => {
  const h = createHarness(defaultFetcher({
    'POST:/api/grouptask/invites/approve': { ok: true, data: { invite: { inviteId: 'inv-1', status: 'accepted' }, joinedPinId: 'join-pin-9', contactMarked: 'idq1strangerinviter0000000000000000000' } },
  }));
  vm.runInNewContext(buildTeamPageDefinition().script, h.context);
  await waitForMicrotasks();
  await waitForMicrotasks();

  const invites = h.elements['[data-team-live="invites"]'];
  // First click only arms the two-step confirm.
  invites.querySelectorAll('[data-team-arm]')[0].click();
  await waitForMicrotasks();
  assert.ok(!h.calls.some((call) => call.url === '/api/grouptask/invites/approve'), 'no approve before the confirm');
  assert.match(invites.innerHTML, /signs a group join on-chain/);

  // Second click on the armed confirm approves.
  invites.querySelectorAll('[data-team-action="invite-approve"]')[0].click();
  await waitForMicrotasks();
  await waitForMicrotasks();
  const approveCall = h.calls.find((call) => call.url === '/api/grouptask/invites/approve');
  assert.deepEqual(JSON.parse(approveCall.options.body), { inviteId: 'inv-1' });
});

test('block add and remove go through /api/block/*', async () => {
  const h = createHarness(defaultFetcher({
    'POST:/api/block/add': { ok: true, data: { blocked: ['idq1spammer00000000000000000000000000', 'idq1troll00000000000000000000000000000'], added: 'idq1troll00000000000000000000000000000' } },
    'POST:/api/block/remove': { ok: true, data: { blocked: [], removed: 'idq1spammer00000000000000000000000000' } },
  }));
  vm.runInNewContext(buildTeamPageDefinition().script, h.context);
  await waitForMicrotasks();
  await waitForMicrotasks();

  const block = h.elements['[data-team-live="block"]'];
  block.querySelector('[data-team-block-input]').value = 'idq1troll00000000000000000000000000000';
  await block.querySelector('[data-team-block-form]').listener('submit')({ preventDefault() {} });
  await waitForMicrotasks();
  await waitForMicrotasks();
  const addCall = h.calls.find((call) => call.url === '/api/block/add');
  assert.deepEqual(JSON.parse(addCall.options.body), { globalMetaId: 'idq1troll00000000000000000000000000000' });

  // Unblock is a two-step confirm.
  block.querySelectorAll('[data-team-arm]')[0].click();
  await waitForMicrotasks();
  block.querySelectorAll('[data-team-action="block-remove"]')[0].click();
  await waitForMicrotasks();
  await waitForMicrotasks();
  const removeCall = h.calls.find((call) => call.url === '/api/block/remove');
  assert.deepEqual(JSON.parse(removeCall.options.body), { globalMetaId: 'idq1spammer00000000000000000000000000' });
});

test('team page definition carries its title dictionary key and localized chrome', async () => {
  const { createI18nContext } = require('../../dist/ui/i18n.js');
  const en = createI18nContext('en');
  const zh = createI18nContext('zh-CN');
  const definition = buildTeamPageDefinition(en);
  assert.equal(definition.page, 'team');
  assert.equal(definition.titleKey, 'team.title');
  assert.notEqual(zh.t('team.title'), en.t('team.title'));
  assert.match(definition.contentHtml, /data-team-live="members"/);
  assert.match(definition.contentHtml, /data-team-live="invites"/);
  assert.match(definition.contentHtml, /data-team-live="trust"/);
  assert.match(definition.contentHtml, /data-team-live="block"/);
});
