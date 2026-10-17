# DSH 0.2.1-rc.2 Desktop Runtime Verification

Verified on 2026-10-17 (Asia/Shanghai) against a running macOS DeepSeek Harness
`0.2.1-rc.2` instance. The local `~/.dsh/profiles/desktop` profile links the OAC
checkout at `open-agent-connect/dsh-plugin`. This note records read-only checks
plus one safe host-entry reload; it changes no user data.

## 1. Findings

1. **The DSH 0.2.1-rc.2 `connection` migration works.** With the current source
   build changing host `inject` from `webRuntime` to `connection`, the host
   fiber is `active`, `/oac/api/health` returns 200, and 401/403 semantics come
   from the kernel Connection service.
2. **The client bundle loads on 0.2.1-rc.2.** The `/` boot HTML contains an
   `open-agent-connect-dsh` client entry; its client.js returns 200 and uses the
   DSH `window.__ModuleLoader__.load({...})` factory format.
3. **The plugin UI actually renders.** A Playwright page authenticated with the
   Host cookie shows the **Bots** row in the left rail. Clicking it opens the
   Bots page with **My Bots / Tracking Tasks / MetaApps / Plugin Settings**;
   console and pageerror logs are empty.
4. **npm 0.9.5 is not a usable build for this host.** The published 0.9.5
   tarball still injects `webRuntime` and calls `ctx.webRuntime.trustedHosts`.
   DSH removed that service in 0.2.1-alpha.1, so the host entry stays `pending`
   forever and the UI never appears. The release must be **0.9.6+**, and users
   must fully restart DSH after replacing an already loaded build.

## 2. Host and Client Evidence

### 2.1 Host entry

The `pluginInventory/list` Remote was called with a DSH Connection
`client-request` envelope:

- After reload: entry `include:oac-dsh`, module `open-agent-connect-dsh`,
  `fiberPhase: active`.
- Before reload the same entry was `pending`. That profile process had loaded an
  earlier host module; `pluginManager.setPluginEnabled(id, false)` followed by
  `true` recomposed the current build and made it active. This matches npm
  0.9.5's old `webRuntime` injection surface and confirms the upgrade note:
  a browser refresh is not enough; DSH must reload the host module or restart.

### 2.2 Client boot graph

The authenticated `GET /` contains:

```json
{
  "id": "open-agent-connect-dsh",
  "url": "plugins/??open-agent-connect-dsh/client.js&rev=42ae4255e2ee",
  "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-layout",
             "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-sidebar",
             "@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-client-ui-slots",
             "@deepseek-ai/dsh-client-ui-conversation"],
  "external": ["@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-store"]
}
```

The bundle response is `200 application/javascript` and starts with:

```js
window.__ModuleLoader__.load({
  id: "open-agent-connect-dsh",
  factory: (require) => { ... }
});
```

### 2.3 Connection fence

Requests to `/oac/api/health`:

| Request | Result |
|---|---|
| No browser cookie | `401 Unauthorized`, JSON `{"ok":false,"error":{"code":"unauthorized"}}` |
| Cookie, forged `Host: evil.example` | `403 Forbidden`, JSON `{"ok":false,"error":{"code":"forbidden"}}` |
| Valid cookie + normal Host | `200 OK`; CLI/daemon/skillBind/presets all ok |

This shows the OAC route does not fall back to the old local fence; it uses
`ctx.connection.requestRejection(req)`'s 401/403 decision.

### 2.4 UI

Playwright loaded `http://127.0.0.1:58332/` with an existing `dsh-auth-*`
browser cookie:

- The left rail contains Plugins / **Bots** / Automation Tasks; Bots is the OAC
  plugin row.
- Clicking Bots opens the center overlay with My Bots, Tracking Tasks, MetaApps,
  and Plugin Settings.
- No console or pageerror messages were emitted.
- The screenshot was `/tmp/dsh-bots-page.png` on the verification machine (not
  committed to the repository).

## 3. Root Cause in npm 0.9.5

`npm view open-agent-connect-dsh version` returned `0.9.5`, published at
2026-10-16T04:40:34Z, before the 2026-10-17 connection migration. After
downloading the tarball:

- `lib/index.js` declares
  `inject = ['webServer', 'webRuntime', 'agentPresets', 'llm', 'approval', 'tools', 'systemPrompt']`.
- `lib/index.js` builds the fence as
  `isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)`.
- `package.json` has no `@deepseek-ai/dsh-client-connection` peer.

DSH's upgrade guide
`docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config/guide.md` states
that the 0.2.1 Web profile no longer provides `webRuntime`; any row injecting it
waits for a service that never mounts. Thus npm 0.9.5 cannot recover by itself.

## 4. Upgrade Procedure

- Use **open-agent-connect-dsh 0.9.6 or newer**, never 0.9.5 on DSH 0.2.1.
- After replacing an already-loaded build, fully quit and reopen DSH Desktop
  (or restart `dsh web`). A page refresh does not replace a loaded host module.
- Verify: Bots appears; `/oac/api/health` with a cookie returns 200, without a
  cookie returns 401, and a forged Host returns 403.
