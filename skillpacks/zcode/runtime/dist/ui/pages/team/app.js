"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTeamPageDefinition = buildTeamPageDefinition;
const i18n_1 = require("../../i18n");
function buildTeamPageDefinition(i18n = (0, i18n_1.createI18nContext)()) {
    return {
        page: 'team',
        title: i18n.t('team.title'),
        titleKey: 'team.title',
        eyebrow: i18n.t('team.eyebrow'),
        heading: i18n.t('team.heading'),
        description: i18n.t('team.description'),
        panels: [],
        contentHtml: `
      <section class="team-shell">
        <header class="team-toolbar">
          <div class="team-heading-block">
            <span class="team-kicker" data-i18n-key="team.eyebrow">${i18n.t('team.eyebrow')}</span>
            <h1 data-i18n-key="team.heading">${i18n.t('team.heading')}</h1>
            <p class="team-heading-copy" data-i18n-key="team.description">${i18n.t('team.description')}</p>
            <p class="team-status-line" data-team-status data-i18n-key="team.status.loading">${i18n.t('team.status.loading')}</p>
          </div>
          <button class="btn" type="button" data-team-refresh data-i18n-key="team.refresh">${i18n.t('team.refresh')}</button>
        </header>
        <div class="team-grid">
          <article class="team-section" data-team-section="members">
            <header>
              <h2 data-i18n-key="team.members.title">${i18n.t('team.members.title')}</h2>
              <p class="team-section-body" data-i18n-key="team.members.body">${i18n.t('team.members.body')}</p>
            </header>
            <div data-team-live="members"></div>
          </article>
          <article class="team-section" data-team-section="invites">
            <header>
              <h2 data-i18n-key="team.invites.title">${i18n.t('team.invites.title')}</h2>
              <p class="team-section-body" data-i18n-key="team.invites.body">${i18n.t('team.invites.body')}</p>
            </header>
            <div data-team-live="invites"></div>
          </article>
          <article class="team-section" data-team-section="trust">
            <header>
              <h2 data-i18n-key="team.trust.title">${i18n.t('team.trust.title')}</h2>
              <p class="team-section-body" data-i18n-key="team.trust.body">${i18n.t('team.trust.body')}</p>
            </header>
            <div data-team-live="trust"></div>
          </article>
          <article class="team-section" data-team-section="block">
            <header>
              <h2 data-i18n-key="team.block.title">${i18n.t('team.block.title')}</h2>
              <p class="team-section-body" data-i18n-key="team.block.body">${i18n.t('team.block.body')}</p>
            </header>
            <div data-team-live="block"></div>
          </article>
        </div>
      </section>
    `,
        script: `(() => {
  const status = document.querySelector('[data-team-status]');
  const refreshButton = document.querySelector('[data-team-refresh]');
  const lives = {
    members: document.querySelector('[data-team-live="members"]'),
    invites: document.querySelector('[data-team-live="invites"]'),
    trust: document.querySelector('[data-team-live="trust"]'),
    block: document.querySelector('[data-team-live="block"]'),
  };

  const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const formatText = (template, replacements) => Object.keys(replacements || {}).reduce(
    (text, name) => text.split('{' + name + '}').join(String(replacements[name])),
    String(template == null ? '' : template)
  );
  const uiText = (key, fallback, replacements) => {
    try {
      if (typeof window !== 'undefined' && window.__oacLocalUiI18n && typeof window.__oacLocalUiI18n.t === 'function') {
        const translated = window.__oacLocalUiI18n.t(key, replacements || {});
        if (translated && translated !== key) return translated;
      }
    } catch {}
    return formatText(fallback, replacements || {});
  };
  const formatDateTime = (seconds) => {
    const ms = Number(seconds) * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return '';
    try { return new Date(ms).toLocaleString(); } catch { return ''; }
  };

  const state = {
    loading: true,
    message: { kind: '', text: '' },
    members: { profiles: [], registry: [] },
    invites: [],
    trust: { owner: '', trustedOwners: [] },
    block: { blocked: [], contacts: [] },
    busy: false,
    // Two-step guard, settings reveal/delete parity: one armed action at a time.
    armed: '',
  };

  const setStatus = (text) => { if (status) status.textContent = text; };

  const teamPost = async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json();
    if (!payload || payload.ok !== true) {
      const error = new Error((payload && payload.message) || uiText('team.actionFailed', 'Request failed.'));
      error.code = payload && payload.code ? String(payload.code) : '';
      throw error;
    }
    return payload.data || {};
  };
  const teamGet = async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    const payload = await response.json();
    if (!payload || payload.ok !== true) {
      throw new Error((payload && payload.message) || uiText('team.actionFailed', 'Request failed.'));
    }
    return payload.data || {};
  };

  const errorText = (error) => (error && error.message)
    ? String(error.message)
    : uiText('team.actionFailed', 'Request failed.');

  const pill = (key, fallback, tone) => '<span class="team-pill"' + (tone ? ' data-tone="' + tone + '"' : '') + '>'
    + escapeHtml(uiText(key, fallback)) + '</span>';

  const actionButton = (kind, id, labelKey, labelFallback, confirmKey, confirmFallback, danger) => {
    const armedKey = kind + ':' + id;
    if (state.armed === armedKey) {
      return '<button class="btn ' + (danger ? 'btn-danger ' : '') + 'btn-sm" type="button" data-team-action="' + kind + '" data-team-id="' + escapeHtml(id) + '">'
        + escapeHtml(uiText(confirmKey, confirmFallback)) + '</button>';
    }
    return '<button class="btn btn-sm" type="button" data-team-arm="' + armedKey + '">' + escapeHtml(uiText(labelKey, labelFallback)) + '</button>';
  };

  // ---- Team members ----

  const renderMembers = () => {
    const live = lives.members;
    if (!live) return;
    const profiles = Array.isArray(state.members.profiles) ? state.members.profiles : [];
    const registry = Array.isArray(state.members.registry) ? state.members.registry : [];
    const sourceLabel = (source) => {
      if (source === 'local') return uiText('team.members.source.local', 'This device');
      if (source === 'auto') return uiText('team.members.source.auto', 'Auto-recorded');
      return uiText('team.members.source.manual', 'Added by you');
    };
    const rows = [];
    profiles.forEach((profile) => {
      rows.push('<tr><td><div>' + escapeHtml(profile.name || profile.slug || '') + '</div><div class="mono">'
        + escapeHtml(profile.globalMetaId || '') + '</div></td>'
        + '<td>' + pill('team.members.source.local', 'This device') + '</td><td></td><td></td></tr>');
    });
    registry.forEach((entry) => {
      rows.push('<tr><td class="mono">' + escapeHtml(entry.globalMetaId) + '</td>'
        + '<td>' + pill(entry.source === 'auto' ? 'team.members.source.auto' : 'team.members.source.manual', entry.source === 'auto' ? 'Auto-recorded' : 'Added by you') + '</td>'
        + '<td class="mono">' + escapeHtml(formatDateTime(entry.addedAt ? Date.parse(entry.addedAt) / 1000 : 0)) + '</td>'
        + '<td class="team-row-actions">' + actionButton('member-remove', entry.globalMetaId, 'team.members.remove', 'Remove', 'team.members.removeConfirm', 'Remove this team Bot? Click again to confirm.', true) + '</td></tr>');
    });
    const table = rows.length
      ? '<table class="team-table"><thead><tr><th>' + escapeHtml(uiText('team.members.columnBot', 'Bot')) + '</th><th>'
        + escapeHtml(uiText('team.members.columnSource', 'Source')) + '</th><th>'
        + escapeHtml(uiText('team.members.columnAdded', 'Added')) + '</th><th></th></tr></thead><tbody>'
        + rows.join('') + '</tbody></table>'
      : '<p class="team-empty">' + escapeHtml(uiText('team.members.empty', 'No remote team Bots recorded yet. Add one by GlobalMetaID, or interact with a verified team peer and it is recorded automatically.')) + '</p>';
    live.innerHTML = table + membersForm();
    const form = live.querySelector('[data-team-add-member-form]');
    if (form) form.addEventListener('submit', addMember);
    bindRowActions(live, 'member-remove', removeMember);
  };

  const membersForm = () => '<form class="team-form" data-team-add-member-form>'
    + '<label class="field"><span>' + escapeHtml(uiText('team.members.addLabel', 'Add a remote team Bot by GlobalMetaID')) + '</span>'
    + '<input type="text" data-team-add-member-input placeholder="' + escapeHtml(uiText('team.members.addPlaceholder', 'idq1...')) + '"' + (state.busy ? ' disabled' : '') + ' /></label>'
    + '<button class="btn btn-primary btn-sm" type="submit"' + (state.busy ? ' disabled' : '') + '>' + escapeHtml(uiText('team.members.addSubmit', 'Verify & add')) + '</button>'
    + '</form>';

  // ---- Pending invites ----

  const inviteStatus = (invite) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (invite.status === 'pending_approval' && Number(invite.expiresAt) + 60 < nowSeconds) {
      return { key: 'team.invites.status.expired', fallback: 'Expired', tone: '' };
    }
    if (invite.status === 'pending_approval') {
      return { key: 'team.invites.status.pending_approval', fallback: 'Pending your approval', tone: 'pending' };
    }
    if (invite.status === 'accepted') return { key: 'team.invites.status.accepted', fallback: 'Accepted', tone: '' };
    if (invite.status === 'declined') return { key: 'team.invites.status.declined', fallback: 'Declined', tone: '' };
    return { key: 'team.invites.status.expired', fallback: 'Expired', tone: '' };
  };

  const renderInvites = () => {
    const live = lives.invites;
    if (!live) return;
    const invites = Array.isArray(state.invites) ? state.invites : [];
    const rows = invites.map((invite) => {
      const statusInfo = inviteStatus(invite);
      const expired = statusInfo.key === 'team.invites.status.expired';
      const actions = invite.status === 'pending_approval' && !expired
        ? actionButton('invite-approve', invite.inviteId, 'team.invites.approve', 'Approve', 'team.invites.approveConfirm', 'Approves the invite: this Bot signs a group join on-chain and replies ACCEPT. Click again to confirm.', false)
          + ' ' + actionButton('invite-decline', invite.inviteId, 'team.invites.decline', 'Decline', 'team.invites.decline', 'Decline', true)
        : '';
      return '<tr><td>' + escapeHtml(invite.taskTitle || '') + '</td>'
        + '<td><div>' + escapeHtml(invite.inviterName || '') + '</div><div class="mono">' + escapeHtml(invite.inviterGlobalMetaId || '') + '</div></td>'
        + '<td>' + escapeHtml(invite.botName || invite.slug || '') + '</td>'
        + '<td>' + pill(statusInfo.key, statusInfo.fallback, statusInfo.tone) + '</td>'
        + '<td class="mono">' + escapeHtml(formatDateTime(invite.expiresAt)) + '</td>'
        + '<td class="team-row-actions">' + actions + '</td></tr>';
    });
    const table = rows.length
      ? '<table class="team-table"><thead><tr><th>' + escapeHtml(uiText('team.invites.columnTask', 'Task')) + '</th><th>'
        + escapeHtml(uiText('team.invites.columnInviter', 'Inviter')) + '</th><th>'
        + escapeHtml(uiText('team.invites.columnBot', 'Local Bot')) + '</th><th>'
        + escapeHtml(uiText('team.invites.columnStatus', 'Status')) + '</th><th>'
        + escapeHtml(uiText('team.invites.columnExpires', 'Expires')) + '</th><th></th></tr></thead><tbody>'
        + rows.join('') + '</tbody></table>'
      : '<p class="team-empty">' + escapeHtml(uiText('team.invites.empty', 'No pending invites. Invites from team, trusted, or contact peers are auto-accepted; blocked inviters are declined silently.')) + '</p>';
    live.innerHTML = table;
    bindRowActions(live, 'invite-approve', approveInvite);
    bindRowActions(live, 'invite-decline', declineInvite);
  };

  // ---- Trusted owners ----

  const renderTrust = () => {
    const live = lives.trust;
    if (!live) return;
    const grants = Array.isArray(state.trust.trustedOwners) ? state.trust.trustedOwners : [];
    const rows = grants.map((grant) => '<tr><td class="mono">' + escapeHtml(grant.trustedOwner || '') + '</td>'
      + '<td>' + escapeHtml(grant.note || '') + '</td>'
      + '<td class="mono">' + escapeHtml(formatDateTime(grant.ts)) + '</td>'
      + '<td class="team-row-actions">' + actionButton('trust-revoke', grant.trustedOwner, 'team.trust.revoke', 'Revoke', 'team.trust.revokeConfirm', 'Publishes an on-chain revoke pin. Click again to confirm.', true) + '</td></tr>');
    const table = rows.length
      ? '<table class="team-table"><thead><tr><th>' + escapeHtml(uiText('team.trust.columnOwner', 'Owner')) + '</th><th>'
        + escapeHtml(uiText('team.trust.columnNote', 'Note')) + '</th><th>'
        + escapeHtml(uiText('team.trust.columnSince', 'Granted')) + '</th><th></th></tr></thead><tbody>'
        + rows.join('') + '</tbody></table>'
      : '<p class="team-empty">' + escapeHtml(uiText('team.trust.empty', 'No effective trust grants. Granting publishes an append-only on-chain pin signed by your owner key.')) + '</p>';
    live.innerHTML = table + '<form class="team-form" data-team-grant-form>'
      + '<label class="field"><span>' + escapeHtml(uiText('team.trust.grantLabel', 'Grant trust to an owner')) + '</span>'
      + '<input type="text" data-team-grant-input placeholder="' + escapeHtml(uiText('team.trust.grantPlaceholder', 'idq1...')) + '"' + (state.busy ? ' disabled' : '') + ' /></label>'
      + '<label class="field"><span>' + escapeHtml(uiText('team.trust.notePlaceholder', 'Optional note')) + '</span>'
      + '<input type="text" data-team-grant-note' + (state.busy ? ' disabled' : '') + ' /></label>'
      + '<button class="btn btn-primary btn-sm" type="submit"' + (state.busy ? ' disabled' : '') + '>' + escapeHtml(uiText('team.trust.grantSubmit', 'Grant')) + '</button>'
      + '</form>';
    live.querySelector('[data-team-grant-form]').addEventListener('submit', grantTrust);
    bindRowActions(live, 'trust-revoke', revokeTrust);
  };

  // ---- Blocked bots ----

  const renderBlock = () => {
    const live = lives.block;
    if (!live) return;
    const blocked = Array.isArray(state.block.blocked) ? state.block.blocked : [];
    const rows = blocked.map((gmid) => '<tr><td class="mono">' + escapeHtml(gmid) + '</td>'
      + '<td class="team-row-actions">' + actionButton('block-remove', gmid, 'team.block.remove', 'Unblock', 'team.block.removeConfirm', 'Unblock this bot? Click again to confirm.', true) + '</td></tr>');
    const table = rows.length
      ? '<table class="team-table"><thead><tr><th>' + escapeHtml(uiText('team.block.columnBlocked', 'Blocked GlobalMetaID')) + '</th><th></th></tr></thead><tbody>'
        + rows.join('') + '</tbody></table>'
      : '<p class="team-empty">' + escapeHtml(uiText('team.block.empty', 'No blocked bots.')) + '</p>';
    live.innerHTML = table + '<form class="team-form" data-team-block-form>'
      + '<label class="field"><span>' + escapeHtml(uiText('team.block.addLabel', 'Block a GlobalMetaID')) + '</span>'
      + '<input type="text" data-team-block-input placeholder="' + escapeHtml(uiText('team.block.addPlaceholder', 'idq1...')) + '"' + (state.busy ? ' disabled' : '') + ' /></label>'
      + '<button class="btn btn-danger btn-sm" type="submit"' + (state.busy ? ' disabled' : '') + '>' + escapeHtml(uiText('team.block.addSubmit', 'Block')) + '</button>'
      + '</form>';
    live.querySelector('[data-team-block-form]').addEventListener('submit', addBlock);
    bindRowActions(live, 'block-remove', removeBlock);
  };

  const renderAll = () => {
    renderMembers();
    renderInvites();
    renderTrust();
    renderBlock();
  };

  function bindRowActions(live, kind, handler) {
    live.querySelectorAll('[data-team-arm]').forEach((button) => {
      button.addEventListener('click', () => { state.armed = button.getAttribute('data-team-arm'); renderAll(); });
    });
    live.querySelectorAll('[data-team-action="' + kind + '"]').forEach((button) => {
      button.addEventListener('click', () => { handler(button.getAttribute('data-team-id')); });
    });
  }

  const load = async () => {
    state.loading = true;
    setStatus(uiText('team.status.loading', 'Loading team & trust state...'));
    try {
      const [members, invites, trust, block] = await Promise.all([
        teamGet('/api/team/list'),
        teamPost('/api/grouptask/invites/pending', {}),
        teamGet('/api/trust/list'),
        teamGet('/api/block/list'),
      ]);
      state.members = members || {};
      state.invites = Array.isArray(invites && invites.invites) ? invites.invites : [];
      state.trust = trust || { owner: '', trustedOwners: [] };
      state.block = block || { blocked: [], contacts: [] };
      state.loading = false;
      state.message = { kind: '', text: '' };
      setStatus('');
      renderAll();
    } catch (error) {
      state.loading = false;
      state.message = { kind: 'error', text: errorText(error) };
      setStatus(uiText('team.status.failed', 'Could not load team & trust state: {message}', { message: errorText(error) }));
      renderAll();
    }
  };

  const runAction = async (work) => {
    if (state.busy) return;
    state.busy = true;
    state.armed = '';
    state.message = { kind: '', text: '' };
    renderAll();
    try {
      await work();
      state.message = { kind: 'success', text: '' };
      setStatus('');
    } catch (error) {
      state.message = { kind: 'error', text: errorText(error) };
      setStatus(errorText(error));
    }
    state.busy = false;
    renderAll();
  };

  const addMember = (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const input = lives.members.querySelector('[data-team-add-member-input]');
    const globalMetaId = input ? String(input.value || '').trim() : '';
    if (!globalMetaId) return;
    runAction(async () => {
      await teamPost('/api/team/add', { globalMetaId });
      state.members = await teamGet('/api/team/list');
    });
  };
  const removeMember = (globalMetaId) => runAction(async () => {
    await teamPost('/api/team/remove', { globalMetaId });
    state.members = await teamGet('/api/team/list');
  });

  const approveInvite = (inviteId) => runAction(async () => {
    await teamPost('/api/grouptask/invites/approve', { inviteId });
    const invites = await teamPost('/api/grouptask/invites/pending', {});
    state.invites = Array.isArray(invites && invites.invites) ? invites.invites : [];
  });
  const declineInvite = (inviteId) => runAction(async () => {
    await teamPost('/api/grouptask/invites/decline', { inviteId });
    const invites = await teamPost('/api/grouptask/invites/pending', {});
    state.invites = Array.isArray(invites && invites.invites) ? invites.invites : [];
  });

  const grantTrust = (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const input = lives.trust.querySelector('[data-team-grant-input]');
    const noteInput = lives.trust.querySelector('[data-team-grant-note]');
    const trustedOwner = input ? String(input.value || '').trim() : '';
    if (!trustedOwner) return;
    const note = noteInput ? String(noteInput.value || '').trim() : '';
    runAction(async () => {
      await teamPost('/api/trust/grant', note ? { trustedOwner, note } : { trustedOwner });
      state.trust = await teamGet('/api/trust/list');
    });
  };
  const revokeTrust = (target) => runAction(async () => {
    await teamPost('/api/trust/revoke', { target });
    state.trust = await teamGet('/api/trust/list');
  });

  const addBlock = (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const input = lives.block.querySelector('[data-team-block-input]');
    const globalMetaId = input ? String(input.value || '').trim() : '';
    if (!globalMetaId) return;
    runAction(async () => {
      await teamPost('/api/block/add', { globalMetaId });
      state.block = await teamGet('/api/block/list');
    });
  };
  const removeBlock = (globalMetaId) => runAction(async () => {
    await teamPost('/api/block/remove', { globalMetaId });
    state.block = await teamGet('/api/block/list');
  });

  if (refreshButton) refreshButton.addEventListener('click', load);
  window.addEventListener('oac:i18n-changed', renderAll);
  load();
})();`,
    };
}
