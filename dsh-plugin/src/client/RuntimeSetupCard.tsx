/**
 * First-run runtime setup card (My Bots section): when the host's
 * `runtime/check` reports the OAC runtime missing, stale, or not
 * auto-installable, this card replaces the scattered CLI errors with one
 * actionable surface. The guided install (`npm i -g open-agent-connect@latest`)
 * starts automatically at apply time — while it runs this card is a progress
 * surface (polling `check` until the runtime turns ok); the button remains as
 * the explicit retry after a failure. Permission-class npm failures
 * (EPERM/EACCES) and no-npm environments degrade to a copyable manual command.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconCheckOutline16, IconLoadingOutline16, IconWarningOutline16 } from './icons.ts'
import type { CommonKeyOf } from '@deepseek-ai/dsh-client-ui-slots'
import { CopyIconButton } from './CopyIconButton.tsx'
import type { RuntimeCheckPayload, RuntimeInstallResult } from './api.ts'
import type { BotsLocaleKey } from './locale.ts'

type Translate = (key: BotsLocaleKey | CommonKeyOf, vars?: Record<string, string | number>) => string

const AUTO_INSTALL_POLL_MS = 4_000

export interface RuntimeSetupCardProps {
  runtime: RuntimeCheckPayload
  t: Translate
  install: () => Promise<RuntimeInstallResult>
  /** Notifies the owner (BotPanel) that the runtime became usable; it reloads the Bot list. */
  onInstalled: () => void
  /** Re-probe used to follow the apply-time automatic install's progress. */
  check?: () => Promise<RuntimeCheckPayload>
  /** Feeds a re-probed payload back to the owner so the card re-renders. */
  onProgress?: (fresh: RuntimeCheckPayload) => void
}

interface InstallFailure {
  message: string
  permission: boolean
  command: string
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  let text = template
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

export function RuntimeSetupCard({ runtime, t, install, onInstalled, check, onProgress }: RuntimeSetupCardProps): ReactNode {
  const [installing, setInstalling] = useState(false)
  const [failure, setFailure] = useState<InstallFailure | null>(null)

  const auto = runtime.autoInstall
  const autoRunning = auto?.phase === 'running'
  const busy = installing || autoRunning

  // While the apply-time automatic install runs, poll the probe: a done/ok
  // flip closes the card through onInstalled; a failure re-renders it with
  // the retry button through onProgress.
  useEffect(() => {
    if (!autoRunning || !check) return undefined
    let current = true
    const timer = setInterval(() => {
      void check().then((fresh) => {
        if (!current) return
        const phase = fresh.autoInstall?.phase
        if (fresh.status === 'ok' || phase === 'done') {
          onInstalled()
        } else if (phase !== 'running') {
          onProgress?.(fresh)
        }
      }, () => undefined)
    }, AUTO_INSTALL_POLL_MS)
    return () => { current = false; clearInterval(timer) }
  }, [autoRunning, check, onInstalled, onProgress])

  const runInstall = async (): Promise<void> => {
    if (busy) return
    setInstalling(true)
    setFailure(null)
    try {
      const result = await install()
      if (result.ok) {
        onInstalled()
      } else {
        setFailure({ message: result.message, permission: result.permission, command: result.command })
      }
    } catch (cause) {
      setFailure({
        message: cause instanceof Error ? cause.message : String(cause),
        permission: false,
        command: runtime.installCommand,
      })
    } finally {
      setInstalling(false)
    }
  }

  const manual = runtime.status === 'npm_unavailable'
  const title = manual
    ? t('setupTitleManual')
    : runtime.status === 'stale'
      ? t('setupTitleStale')
      : t('setupTitleMissing')
  const body = manual
    ? t('setupManualBody')
    : runtime.status === 'stale'
      ? interpolate(t('setupStaleBody', { found: runtime.runtimeVersion ?? '?', required: runtime.requiredVersion }), {
        found: runtime.runtimeVersion ?? '?',
        required: runtime.requiredVersion,
      })
      : t('setupMissingBody')
  const shownFailure: InstallFailure | null = failure ?? (auto?.phase === 'failed'
    ? { message: auto.message ?? '', permission: auto.permission, command: auto.command ?? runtime.installCommand }
    : null)
  const manualCommand = shownFailure?.permission === true || manual
  const command = shownFailure?.command ?? runtime.installCommand

  return (
    <div className="oac-setup-card" role="alert">
      <div className="oac-setup-card-head">
        {autoRunning ? <IconLoadingOutline16 className="oac-spin" /> : <IconWarningOutline16 />}
        <strong>{title}</strong>
      </div>
      <p className="oac-setup-card-body">{body}</p>
      {autoRunning ? <p className="oac-hint">{t('setupAutoHint')}</p> : null}
      {runtime.error ? (
        <p className="oac-hint">{interpolate(t('setupDetail', { message: runtime.error }), { message: runtime.error })}</p>
      ) : null}
      {manualCommand ? (
        <div className="oac-setup-card-command">
          {shownFailure?.permission === true ? <p className="oac-hint">{t('setupPermissionHint')}</p> : null}
          <div className="oac-setup-card-command-row">
            <code>{command}</code>
            <CopyIconButton value={command} label={t('copy')} copiedLabel={t('copied')} />
          </div>
        </div>
      ) : null}
      {shownFailure ? (
        <div className="oac-note error" role="alert">
          {shownFailure.permission ? `${t('setupInstallFailed')}: ` : ''}
          {shownFailure.message}
        </div>
      ) : null}
      {manual ? null : (
        <div className="oac-setup-card-actions">
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            icon={busy ? <IconLoadingOutline16 className="oac-spin" /> : undefined}
            onClick={() => { void runInstall() }}
          >
            {busy
              ? t('setupInstalling')
              : runtime.status === 'stale' ? t('setupUpgrade') : t('setupInstall')}
          </Button>
          {shownFailure && !busy ? (
            <Button type="button" variant="outline" onClick={() => { void runInstall() }}>
              {t('retry')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** Transient success line BotPanel shows right after a guided install. */
export function RuntimeInstalledNote({ t }: { t: Translate }): ReactNode {
  return (
    <p className="oac-note success oac-setup-installed">
      <IconCheckOutline16 />
      {t('setupSuccess')}
    </p>
  )
}
