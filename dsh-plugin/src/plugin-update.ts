/**
 * DSH plugin update discovery and one-click application.
 *
 * DSH's plugin manager owns installation and profile mutation; OAC never
 * downloads or replaces package files directly. The check reads the npm
 * `latest` dist-tag (or OAC_DSH_UPDATE_REGISTRY), while apply removes the
 * current bundle and installs the exact target through `ctx.pluginManager`.
 * The installed source is retained as the rollback spec if the install fails.
 */
import { readFileSync } from 'node:fs'

export const PLUGIN_PACKAGE_NAME = 'open-agent-connect-dsh'
export const DEFAULT_UPDATE_REGISTRY = 'https://registry.npmjs.org'
const UPDATE_CACHE_MS = 6 * 60 * 60 * 1000
const UPDATE_TIMEOUT_MS = 8_000

export interface PluginUpdateStatus {
  ok: boolean
  current: string
  latest?: string
  updateAvailable: boolean
  registry: string
  checkedAt: number
  releaseUrl?: string
  code?: string
  message?: string
}

export interface PluginUpdateApplyResult {
  ok: boolean
  current: string
  target: string
  application?: 'applied' | 'restart-required' | 'failed'
  version?: string
  message?: string
  code?: string
}

interface RegistryLatest {
  name?: unknown
  version?: unknown
}

interface PluginBundleInfo {
  name: string
  version?: string
  source?: string
  removable?: boolean
}

interface PluginChangeResult {
  application?: 'applied' | 'restart-required' | 'failed' | 'cancelled' | 'overridden'
  version?: string
  error?: { code?: string; message?: string }
}

export interface DshPluginManagerLike {
  listBundles(): Promise<ReadonlyArray<PluginBundleInfo>>
  removeBundle(name: string): Promise<PluginChangeResult>
  installBundle(spec: string, options?: { enabled?: boolean; saveExact?: boolean }): Promise<PluginChangeResult>
}

interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

let cached: { registry: string; current: string; status: PluginUpdateStatus } | undefined
let applying = false

/** Read the version of this built package without importing package.json as code. */
export function currentPluginVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  return typeof manifest.version === 'string' && manifest.version.trim() !== '' ? manifest.version.trim() : '0.0.0'
}

/** Compare two semantic versions, including prerelease ordering, without a runtime dependency. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; pre: string[] } | undefined => {
    const normalized = value.trim().replace(/^v/, '').split('+', 1)[0] ?? ''
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalized)
    if (match === null) return undefined
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? [] : match[4].split('.'),
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (a === undefined || b === undefined) return left.localeCompare(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1
  }
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.pre[index]
    const rightPart = b.pre[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
      continue
    }
    if (leftNumber !== undefined || rightNumber !== undefined) return leftNumber !== undefined ? -1 : 1
    const difference = leftPart.localeCompare(rightPart)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

/** Validate and normalize the configurable registry root. */
export function updateRegistry(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.OAC_DSH_UPDATE_REGISTRY?.trim()
  const value = configured === undefined || configured === '' ? DEFAULT_UPDATE_REGISTRY : configured.replace(/\/+$/, '')
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined
  } catch {
    return undefined
  }
}

/** Clear the in-memory check cache (tests and a forced refresh). */
export function resetUpdateCacheForTests(): void {
  cached = undefined
}

/** Check the configured registry's `latest` dist-tag for this package. */
export async function checkPluginUpdate(options: {
  force?: boolean
  fetchImpl?: FetchLike
  registry?: string
  currentVersion?: string
  now?: () => number
  timeoutMs?: number
} = {}): Promise<PluginUpdateStatus> {
  const current = options.currentVersion ?? currentPluginVersion()
  const registry = options.registry ?? updateRegistry()
  const checkedAt = (options.now ?? Date.now)()
  if (registry === undefined) {
    return { ok: false, current, updateAvailable: false, registry: DEFAULT_UPDATE_REGISTRY, checkedAt, code: 'invalid_registry', message: 'invalid OAC_DSH_UPDATE_REGISTRY' }
  }
  if (options.force !== true) {
    const hit = cached
    if (hit !== undefined && hit.registry === registry && hit.current === current && options.now === undefined && Date.now() - hit.status.checkedAt < UPDATE_CACHE_MS) return hit.status
  }
  if (process.env.OAC_DSH_UPDATE_DISABLED === '1') {
    return { ok: false, current, updateAvailable: false, registry, checkedAt, code: 'disabled', message: 'update checks are disabled' }
  }
  const doFetch: FetchLike = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? UPDATE_TIMEOUT_MS)
  try {
    const response = await doFetch(registry + '/' + PLUGIN_PACKAGE_NAME + '/latest', {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.ok === false) {
      const message = 'registry returned HTTP ' + String(response.status)
      return { ok: false, current, updateAvailable: false, registry, checkedAt, code: 'registry_http', message }
    }
    const latest = await response.json() as RegistryLatest
    if (latest.name === PLUGIN_PACKAGE_NAME && typeof latest.version === 'string' && latest.version.trim().length > 0) {
      const target = latest.version.trim()
      const status: PluginUpdateStatus = {
        ok: true,
        current,
        latest: target,
        updateAvailable: compareVersions(target, current) > 0,
        registry,
        checkedAt,
        releaseUrl: 'https://www.npmjs.com/package/' + PLUGIN_PACKAGE_NAME + '/v/' + target,
      }
      cached = { registry, current, status }
      return status
    }
    return { ok: false, current, updateAvailable: false, registry, checkedAt, code: 'invalid_response', message: 'registry response did not identify a valid package version' }
  } catch (error) {
    return {
      ok: false,
      current,
      updateAvailable: false,
      registry,
      checkedAt,
      code: 'fetch_failed',
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

function managerOf(ctx: { get?(key: string): unknown }): DshPluginManagerLike | undefined {
  return ctx.get?.('pluginManager') as DshPluginManagerLike | undefined
}

function failure(current: string, target: string, code: string, message: string): PluginUpdateApplyResult {
  return { ok: false, current, target, application: 'failed', code, message }
}

/**
 * Install the current npm latest through DSH pluginManager.
 * The prior installed spec is retained as a rollback target. DSH performs the
 * compatibility gate and package-manager security checks for the new spec.
 */
export async function applyPluginUpdate(
  ctx: { get?(key: string): unknown; logger?: { warn?(message: string): void } },
  options: { check?: () => Promise<PluginUpdateStatus> } = {},
): Promise<PluginUpdateApplyResult> {
  const current = currentPluginVersion()
  if (applying) return failure(current, '', 'in_progress', 'an update is already being applied')
  const manager = managerOf(ctx)
  if (manager === undefined) return failure(current, '', 'plugin_manager_unavailable', 'DSH pluginManager is unavailable in this profile')
  applying = true
  let target = ''
  try {
    const status = await (options.check ?? (() => checkPluginUpdate({ force: true })))()
    if (status.ok === false) return failure(current, status.latest ?? '', status.code ?? 'check_failed', status.message ?? 'update check failed')
    target = status.latest ?? ''
    if (status.updateAvailable === false || target === '' || compareVersions(target, current) <= 0) return failure(current, target, 'not_available', 'no newer plugin version is available')
    const before = await manager.listBundles()
    const installed = before.find((bundle) => bundle.name === PLUGIN_PACKAGE_NAME)
    if (installed === undefined) return failure(current, target, 'not_installed', 'this plugin is not installed as a profile bundle')
    if (installed.removable === false) return failure(current, target, 'not_removable', 'the installed plugin cannot be removed by the plugin manager')
    const rollback = installed.source ?? PLUGIN_PACKAGE_NAME + '@' + (installed.version ?? current)
    const removed = await manager.removeBundle(PLUGIN_PACKAGE_NAME)
    if (removed.application === 'failed') {
      return failure(current, target, removed.error?.code ?? 'remove_failed', removed.error?.message ?? 'could not remove the current plugin')
    }
    let installedResult: PluginChangeResult
    try {
      installedResult = await manager.installBundle(PLUGIN_PACKAGE_NAME + '@' + target, { enabled: true, saveExact: true })
    } catch (error) {
      installedResult = { application: 'failed', error: { message: error instanceof Error ? error.message : String(error) } }
    }
    if (installedResult.application === 'failed' || installedResult.application === 'cancelled') {
      // Removal already happened. Restore the previous source/version so a
      // failed update cannot silently leave the profile without OAC.
      try {
        await manager.installBundle(rollback, { enabled: true })
      } catch (rollbackError) {
        ctx.logger?.warn?.('[oac-dsh] update rollback failed: ' + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)))
      }
      return failure(current, target, installedResult.error?.code ?? 'install_failed', installedResult.error?.message ?? 'plugin installation failed')
    }
    const actual = installedResult.version
    if (actual !== undefined && compareVersions(actual, target) !== 0) {
      try {
        await manager.installBundle(rollback, { enabled: true })
      } catch (rollbackError) {
        ctx.logger?.warn?.('[oac-dsh] version-mismatch rollback failed: ' + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)))
      }
      return failure(current, target, 'version_mismatch', 'installed ' + actual + ' instead of ' + target + '; pnpm minimumReleaseAge may have held the target back')
    }
    const installedVersion = actual ?? target
    return {
      ok: true,
      current: installedVersion,
      target,
      application: installedResult.application === 'restart-required' ? 'restart-required' : 'applied',
      version: installedVersion,
    }
  } catch (error) {
    return failure(current, target, 'update_failed', error instanceof Error ? error.message : String(error))
  } finally {
    applying = false
  }
}
