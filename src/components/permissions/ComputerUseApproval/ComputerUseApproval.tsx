import { getSentinelCategory } from '@ant/computer-use-mcp/sentinelApps'
import type { CuPermissionRequest, CuPermissionResponse } from '@ant/computer-use-mcp/types'
import { DEFAULT_GRANT_FLAGS } from '@ant/computer-use-mcp/types'
import { useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import { CIRCLE, CIRCLE_FILLED, CROSS, TICK, WARNING } from '../../../constants/figures.js'
import { Box, Text } from '../../../ink/index.js'
import { execFileNoThrow } from '../../../services/shell/execFileNoThrow.js'
import { plural } from '../../../utils/stringUtils.js'
import { Select } from '../../CustomSelect/select.js'
import { Dialog } from '../../design-system/Dialog.js'

type ComputerUseApprovalProps = {
  request: CuPermissionRequest
  onDone: (response: CuPermissionResponse) => void
}
const DENY_ALL_RESPONSE: CuPermissionResponse = {
  granted: [],
  denied: [],
  flags: DEFAULT_GRANT_FLAGS,
}

/**
 * Two-panel dispatcher. When `request.tccState` is present, macOS permissions
 * (Accessibility / Screen Recording) are missing and the app list is
 * irrelevant — show a TCC panel that opens System Settings. Otherwise show the
 * app allowlist + grant-flags panel.
 */
export function ComputerUseApproval({ request, onDone }: ComputerUseApprovalProps) {
  const tccState = (
    request as unknown as { tccState?: { accessibility: boolean; screenRecording: boolean } }
  ).tccState
  return tccState ? (
    <ComputerUseTccPanel tccState={tccState} onDone={() => onDone(DENY_ALL_RESPONSE)} />
  ) : (
    <ComputerUseAppListPanel request={request} onDone={onDone} />
  )
}

// ── TCC panel ─────────────────────────────────────────────────────────────

type TccOption = 'open_accessibility' | 'open_screen_recording' | 'retry'
function ComputerUseTccPanel({
  tccState,
  onDone,
}: {
  tccState: { accessibility: boolean; screenRecording: boolean }
  onDone: () => void
}) {
  const opts = []
  if (!tccState.accessibility) {
    opts.push({
      label: tSync('computerUse.openSystemSettingsAccessibility'),
      value: 'open_accessibility',
    })
  }
  if (!tccState.screenRecording) {
    opts.push({
      label: tSync('computerUse.openSystemSettingsScreenRecording'),
      value: 'open_screen_recording',
    })
  }
  opts.push({
    label: tSync('computerUse.tryAgain'),
    value: 'retry',
  })
  const options = opts
  const onChange = function onChange(value: string) {
    switch (value) {
      case 'open_accessibility': {
        execFileNoThrow(
          'open',
          ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'],
          {
            useCwd: false,
          },
        )
        return
      }
      case 'open_screen_recording': {
        execFileNoThrow(
          'open',
          ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'],
          {
            useCwd: false,
          },
        )
        return
      }
      case 'retry': {
        onDone()
        return
      }
    }
  }
  return (
    <Dialog title={tSync('computerUse.needsMacOSPermissions')} onCancel={onDone}>
      {
        <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          {
            <Box flexDirection="column">
              {
                <Text>
                  {tSync('computerUse.accessibilityLabel')}{' '}
                  {tccState.accessibility
                    ? `${TICK} ${tSync('computerUse.granted')}`
                    : `${CROSS} ${tSync('computerUse.notGranted')}`}
                </Text>
              }
              {
                <Text>
                  {tSync('computerUse.screenRecordingLabel')}{' '}
                  {tccState.screenRecording
                    ? `${TICK} ${tSync('computerUse.granted')}`
                    : `${CROSS} ${tSync('computerUse.notGranted')}`}
                </Text>
              }
            </Box>
          }
          {<Text dimColor={true}>{tSync('computerUse.grantMissingPermissions')}</Text>}
          {<Select options={options} onChange={onChange} onCancel={onDone} />}
        </Box>
      }
    </Dialog>
  )
}

// ── App allowlist panel ───────────────────────────────────────────────────

type AppListOption = 'allow_all' | 'deny'
// getter：惰性求值，避免模块顶层冻结翻译；语言切换后即时反应。
const getSentinelWarning = (): Record<
  NonNullable<ReturnType<typeof getSentinelCategory>>,
  string
> => ({
  shell: tSync('computerUse.equivalentToShellAccess'),
  filesystem: tSync('computerUse.canReadWriteAnyFile'),
  system_settings: tSync('computerUse.canChangeSystemSettings'),
})
// 本地接口描述 ComputerUseAppListPanel 预期从 request 中读取的结构
interface AppEntry {
  requestedName: string
  resolved?: {
    bundleId: string
    displayName: string
  }
  alreadyGranted?: boolean
}
interface AppListRequest {
  apps: AppEntry[]
  reason?: string
  requestedFlags: Record<string, boolean>
  willHide?: string[]
}
function ComputerUseAppListPanel({
  request,
  onDone,
}: {
  request: CuPermissionRequest
  onDone: (response: CuPermissionResponse) => void
}) {
  const req = request as unknown as AppListRequest
  const [checked] = useState(
    () =>
      new Set(
        req.apps.flatMap((a) => (a.resolved && !a.alreadyGranted ? [a.resolved.bundleId] : [])),
      ),
  )
  const ALL_FLAG_KEYS = ['clipboardRead', 'clipboardWrite', 'systemKeyCombos']
  const requestedFlagKeys = ALL_FLAG_KEYS.filter((k) => req.requestedFlags[k])
  const checkedAppCount = checked.size
  const appLabel = plural(checkedAppCount, 'app')
  const options = [
    {
      label: tSync('computerUse.allowForThisSession', { count: checkedAppCount, app: appLabel }),
      value: 'allow_all',
    },
    {
      label: (
        <Text>
          {tSync('computerUse.denyAndTellZy')} <Text bold={true}>(esc)</Text>
        </Text>
      ),
      value: 'deny',
    },
  ]
  const respond = function respond(allow: boolean) {
    if (!allow) {
      onDone(DENY_ALL_RESPONSE)
      return
    }
    const now = Date.now()
    const granted = req.apps.flatMap((a_0) =>
      a_0.resolved && checked.has(a_0.resolved.bundleId)
        ? [
            {
              bundleId: a_0.resolved.bundleId,
              displayName: a_0.resolved.displayName,
              grantedAt: now,
            },
          ]
        : [],
    )
    const denied = req.apps
      .filter((a_1) => !a_1.resolved || !checked.has(a_1.resolved.bundleId))
      .map((a_2) => ({
        bundleId: a_2.resolved?.bundleId ?? a_2.requestedName,
        reason: a_2.resolved ? ('user_denied' as const) : ('not_installed' as const),
      }))
    const flags = {
      ...DEFAULT_GRANT_FLAGS,
      ...Object.fromEntries(requestedFlagKeys.map((k_0) => [k_0, true] as const)),
    }
    onDone({
      granted,
      denied,
      flags,
    })
  }
  const appListElements = req.apps.map((a_3) => {
    const resolved = a_3.resolved
    if (!resolved) {
      return (
        <Text key={a_3.requestedName} dimColor={true}>
          {'  '}
          {CIRCLE} {a_3.requestedName}{' '}
          <Text dimColor={true}>({tSync('computerUse.notInstalled')})</Text>
        </Text>
      )
    }
    if (a_3.alreadyGranted) {
      return (
        <Text key={resolved.bundleId} dimColor={true}>
          {'  '}
          {TICK} {resolved.displayName}{' '}
          <Text dimColor={true}>({tSync('computerUse.alreadyGranted')})</Text>
        </Text>
      )
    }
    const sentinel = getSentinelCategory(resolved.bundleId)
    const isChecked = checked.has(resolved.bundleId)
    return (
      <Box key={resolved.bundleId} flexDirection="column">
        <Text>
          {'  '}
          {isChecked ? CIRCLE_FILLED : CIRCLE} {resolved.displayName}
        </Text>
        {sentinel ? (
          <Text bold={true}>
            {'    '}
            {WARNING} {getSentinelWarning()[sentinel]}
          </Text>
        ) : null}
      </Box>
    )
  })
  return (
    <Dialog title={tSync('computerUse.wantsToControlApps')} onCancel={() => respond(false)}>
      {
        <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          {req.reason ? <Text dimColor={true}>{req.reason}</Text> : null}
          {<Box flexDirection="column">{appListElements}</Box>}
          {requestedFlagKeys.length > 0 ? (
            <Box flexDirection="column">
              <Text dimColor={true}>{tSync('computerUse.alsoRequested')}</Text>
              {requestedFlagKeys.map((flag) => (
                <Text key={flag} dimColor={true}>
                  {'  '}· {flag}
                </Text>
              ))}
            </Box>
          ) : null}
          {req.willHide && req.willHide.length > 0 ? (
            <Text dimColor={true}>
              {tSync('computerUse.otherAppsHidden', {
                count: req.willHide.length,
                app: plural(req.willHide.length, 'app'),
              })}
            </Text>
          ) : null}
          {
            <Select
              options={options}
              onChange={(v: string) => respond(v === 'allow_all')}
              onCancel={() => respond(false)}
            />
          }
        </Box>
      }
    </Dialog>
  )
}
