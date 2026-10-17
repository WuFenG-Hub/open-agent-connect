# DSH 0.2.1 Upgrade Analysis for OAC dsh-plugin

Scope: upstream tags `dsh-v0.2.0-rc.2` and `dsh-v0.2.1-rc.1`/`dsh-v0.2.1-rc.2` in
`/Users/tusm/Documents/MetaID_Projects/deepseek-harness`. This document separates
host/plugin compatibility changes from DSH capabilities OAC can adopt or borrow.

## 1. Compatibility changes that matter to third-party plugins

### 1.1 `webRuntime` is gone; `webStartup` + `connection` replace it

Evidence:
- `docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config/guide.md`
- `packages/bundle/web-app/cordis.patch.yml` at `dsh-v0.2.1-rc.2`
- `packages/client/connection/src/rpc.ts`: `HostConnectionHandle.requestRejection`

The Web profile no longer provides a `webRuntime` service. The `web-startup`
row provides `webStartup`, whose `trustedHosts` feed the `connection` row. A row
that injects `webRuntime` waits forever; an expression reading
`ctx.webRuntime.trustedHosts` fails before the required Connection can start.
Wildcard listener hosts are also rejected.

Consequences for OAC:
- Host `inject` must use `connection`, not `webRuntime`.
- `/oac/api/*` admission should call `ctx.connection.requestRejection(req)` and
  return its 401 (trusted but unauthenticated) or 403 (Host/Origin failure)
  instead of maintaining a local Host/Origin copy.
- OAC 0.9.5's published build uses `webRuntime`; it cannot mount on 0.2.1.
  OAC 0.9.6 uses `connection` and was verified against 0.2.1-rc.2.

### 1.2 Compatibility becomes `engines.dsh` first

Evidence:
- `docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.md`
- `packages/boot/app-boot/src/plugin-compatibility.ts`

From 0.2.1-alpha.3, a manifest's own `engines.dsh` range alone decides
compatibility and `@deepseek-ai/dsh*` peer ranges are ignored. Without
`engines.dsh`, the previous peer-range rule remains. `workspace:` values are
invalid in `engines.dsh`; malformed `engines` refuses the package.

Consequences for OAC:
- Declare one explicit range, e.g. `>=0.1.5-alpha.1 <0.3.0-0`, so future 0.2.x
  kernels are admitted and 0.3 prereleases are rejected.
- Keep peer ranges for existing 0.1.5-0.2.0 users, whose kernels still use the
  peer gate. In particular `@deepseek-ai/dsh-client-connection` must include the
  older supported lines.
- Drop optional peer entries for packages that are never imported (the old
  `dsh-agent-preset-registry` optional peer only creates false refusals).

### 1.3 Plugin install, HMR, and host/client release identity

Evidence:
- `docs/upgrade-guide/v0.2.1-alpha.2/plugin-install-over-installed/guide.md`
- `879ad372ac` `feat(hmr): replace plugins whose package files changed during profile recomposition`
- `7c9e54b3ef` `feat(client-modules): prompt to reload when the host release changes`
- `f52abc04fa` `feat(client-modules): apply no plugin update from another host release`

DSH now refuses `installBundle()` over an already installed package while HMR
is active; upgrading means `removeBundle()` then `installBundle()`. HMR can
replace a plugin whose package files changed during profile recomposition, but
client modules from another host release are not silently applied and can prompt
a reload.

Consequences for OAC:
- A built `lib/` change while DSH is running is not guaranteed to replace an
  already loaded host-half plugin.
- Published-package upgrades should be an uninstall/install or a full DSH
  restart, and the plugin README must say so.
- `prepack: pnpm run build` is a cheap guard against publishing a stale `lib/`.
- A plugin built for DSH 0.2.0 must not be presented as compatible with 0.2.1;
  the manifest and boot graph must be rebuilt against the new host packages.

### 1.4 Client modules and slots are additive in 0.2.1-rc.2

Evidence:
- `7c9e54b3ef`, `f52abc04fa`
- `3f1d5dfcfa` `feat(ui-conversation): add the New Session options slot`
- `919aa5f400` `feat(web): add provider-aware model label slot`
- `fda98dadd2` `feat(web): add DeepSeek Search and Fetch APIs behind a settings switch`

The rc.2 diff for client packages is limited to additive UI features: the
temporary 1017 model label package, provider-aware model-label slot, web search
settings/API provider, and earlier 0.2.1 client additions. No OAC-consumed
export, hook, slot, or package entry was renamed or removed in rc.2. The plugin's
`platform: "web"` `dsh.client` manifest continues to work; it still serves the
usual `window.__ModuleLoader__.load(...)` factory and the declared
`dsh-client-*` externals.

### 1.5 Remote access/RBAC and operator principals are additive but important

Evidence:
- `d7bd68ee7a` `feat(remote-access): add rbac policies and gate non-owner calls and events`
- `f6316536ea` `feat(client-connection): carry caller principals on explicit peers`
- `0f7ac58213` `feat(connection): isolate API operators without changing browser identity`

Connection now carries Peer principals and the Gateway consults resource-aware
remote-access policies for non-owner calls. OAC does not currently consume this
surface; its custom `/oac/api` routes still assume the owner/browser use case.
This is not a 0.2.1 break for OAC, but it is the prerequisite for any future
multi-user or non-owner OAC API.

### 1.6 Other upgrade guides checked and not applicable to OAC

These DSH 0.2.1 guides describe changes outside OAC's used surface:
- job ids, JSONL persistence plugin imports, mock SSE event names;
- subagent preset composition/activation;
- tool presentation mode, terminal labels, working-directory migration;
- stored credential precedence, DeepSeek account model discovery;
- desktop test-auth popups, `--from-default-profile`, `--profile` placement.

No OAC source change was required for these.

## 2. OAC dsh-plugin adaptation map

| Area | 0.2.1 change | OAC action / status |
|---|---|---|
| Host inject | `webRuntime` removed | `inject` uses `connection`; fixed in 0.9.6 |
| `/oac/api` trust | kernel owns Host/Origin + browser auth | calls `ctx.connection.requestRejection`; fixed in 0.9.6 |
| Compatibility | `engines.dsh` is authoritative on >=0.2.1-alpha.3 | declared `engines.dsh`; peer ranges retained for old kernels |
| Client bundle | shared bundles, host-release identity checks | boot graph and `platform: "web"` verified on 0.2.1-rc.2 |
| Agent presets | declarative registry and optional bundle composition | OAC's one-Bot-one-preset re-reads the shipped standard patch; no 0.2.1 break |
| Session reads | live `session/event` remains the supported path | already used; no change |
| Tool registration | host `tools`/`systemPrompt`/`approval` remain | no change; verified host active |
| UI slots | additive options/model-label slots | existing slot registration still renders; optional future adoption |
| Scheduler | DSH "Automation tasks" remains optional and Session-bound | OAC per-Bot tasks keep their own scheduler/semantics |
| Desktop | Electron + bundled runtime/pnpm, profile `desktop` | same web bundle works; 0.9.6 verified |
| Plugin card | icon/locale metadata and market/discovery | icon/locale already shipped; add repository/source for discovery |

## 3. DSH capabilities OAC can adopt, borrow, or keep

### 3.1 Directly adopt or already adopted

1. **Connection as the only trust/auth seam.** Adopt
   `ctx.connection.requestRejection`, `admit`, `browserPeer`, `fetch`, and
   `rpc`. This removes a security-sensitive forked Host/Origin fence and keeps
   401/403 behavior identical to DSH. OAC 0.9.6 already does the first step.
2. **`engines.dsh` compatibility range.** One maintained range replaces the
   repeated `@deepseek-ai/dsh-*` version lists on 0.2.1+, while peer ranges
   remain for older hosts. OAC 0.9.6 already declares it.
3. **Plugin card metadata and market discovery.** `icon` and
   `locale/{en,zh}.json` are shipped. DSH's plugin manager now displays source
   repository and supports Custom plugin markets (`3de3a977e0`,
   `ab3bb74550`). OAC should add `repository` metadata and consider publishing a
   market index so DSH users can install OAC through Discover instead of a
   README command.
4. **Client module release isolation.** Trust DSH's cross-host-release check
   instead of trying to reuse a stale client cache. OAC should continue to ship
   a loader-format `client.js` and document full-restart upgrades.
5. **Plugin inventory for diagnostics.** `pluginInventory/list` gives entry id,
   module, enabled flag, and live fiber phase without reading DSH internals.
   OAC can add a read-only "plugin health" row in its Bots/Plugin Settings page
   instead of inventing another lifecycle probe.

### 3.2 Borrow/phase in when the benefit justifies the migration

1. **Move private HTTP plumbing to Connection transports.** Connection now
   provides generic unary RPC, exact Fetch routes with buffered/streaming bodies,
   attachments, and Peer-scoped admission. OAC has many hand-written
   `/oac/api/*` routes and a custom JSON envelope. Incrementally:
   - unary/CRUD routes can use `ctx.connection.rpc` or a Typert Remote service;
   - SSE and uploads can use `ctx.connection.fetch.register` (streaming mode);
   - access/resource checks can use `dsh-api-remote-access` when OAC grows
     non-owner callers.
   The custom route layer should stay until the migration is complete; it is not
   required for 0.2.1 compatibility.
2. **Use DSH's plugin manager for plugin lifecycle, not OAC's runtime manager.**
   DSH already handles install/remove/update, HMR, compatibility exemptions, and
   cards (`@deepseek-ai/dsh-plugin-manager`). OAC should keep only its OAC
   runtime (`metabot`/daemon) bootstrap, and rely on DSH for
   `open-agent-connect-dsh` upgrades. This removes duplicate update UX.
3. **Adopt the right slots instead of DOM/slot shadowing where possible.**
   `conversation.hero.options` (`3f1d5dfcfa`) is the stable place for compact
   New-Session options. The provider-aware model-label slot (`919aa5f400`) is
   the stable place for model labels. OAC currently uses
   `conversation.hero.agentPreset` plus a lower-priority header list cell for the
   Bot label; those faces still work. The 100px hero Bot avatar/name has no
   equivalent slot in 0.2.1, so its DOM mount must stay for now.
4. **Reuse DSH web search/fetch for generic web work.** 0.2.1 adds
   `@deepseek-ai/dsh-web-deepseek-api` behind the Web Search API switch
   (`fda98dadd2`), exposing model-facing `web_search`/`web_fetch`. OAC should use
   those for general internet search/fetch and keep its own MetaWeb, on-chain
   Q&A, MetaApp, and Bot Browser capabilities, which are domain-specific.
5. **Consider DSH schedule for simple reminders only.** `@deepseek-ai/dsh-schedule`
   is durable and well specified, but delivery targets the originating Session.
   OAC per-Bot scheduled tasks intentionally start new DSH conversations across
   Bots, so they need the existing scheduler. A future OAC "remind this chat"
   feature could delegate to DSH schedule.
6. **Borrow desktop runtime facts.** DSH Desktop exposes
   `DSH_DESKTOP_NODE_EXECUTABLE`, a bundled primary runtime, and a bundled pnpm
   path. OAC already supports Electron `ELECTRON_RUN_AS_NODE`; it can further use
   these env/runtime facts to reduce nvm/global-npm probing, but the OAC runtime
   installation itself remains OAC-owned.
7. **Borrow the account-notification stack UX.** DSH 0.2.1 supports server-
   ordered, stacked, acknowledged notices (`2dcd031a8e`). The data model is
   DSH-account specific, so use the interaction/layout lesson rather than the
   service for OAC traffic notices.

### 3.3 Keep self-built

- OAC daemon/CLI capability core, identity/owner binding, traffic/billing,
  A2A/on-chain messages, MetaWeb, MetaApps, group tasks, MetaTask, skills and
  per-Bot LLM pairing. DSH has no equivalent for these products.
- The Bots page and one-Bot-one-agent-preset model. DSH's generic preset roster
  is infrastructure, not the OAC product surface.
- The Bot Browser bridge and Agent Browser Core integration. DSH's generic
  sidebar browser does not provide OAC's MetaApp/Agent-Internet semantics.
- OAC runtime bootstrap/install/health. DSH plugin manager manages DSH plugin
  packages, not the standalone `metabot` runtime.
- The per-Bot scheduler and OAC task execution semantics (new conversations,
  cross-Bot handoff). DSH "Automation tasks" is a different Session-bound
  reminder model.
- OAC's local trust-fence implementation: delete it permanently; DSH Connection
  owns this now.

## 4. Practical priority

1. Publish `open-agent-connect-dsh@0.9.6` with the `connection` build and
   `engines.dsh` (already implemented here).
2. Add repository metadata and, if desired, a small DSH plugin-market index.
3. In a later, separately tested change, migrate unary `/oac/api` routes to
   Connection RPC/Fetch and add resource-aware access for non-owner callers.
4. Do not port the Bots page, daemon, scheduler, or MetaWeb features onto DSH
   infrastructure: the semantics differ and the existing OAC layer is the source
   of truth.
