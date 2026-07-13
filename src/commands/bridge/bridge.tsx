import { feature } from 'bun:bundle'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { getWireAccessToken } from '../../bridge/bridgeConfig.js'
import {
  checkWireMinVersion,
  getWireDisabledReason,
  isEnvLessWireEnabled,
} from '../../bridge/bridgeEnabled.js'
import { checkEnvLessWireMinVersion } from '../../bridge/envLessBridgeConfig.js'
import { BRIDGE_LOGIN_INSTRUCTION, REMOTE_CONTROL_DISCONNECTED_MSG } from '../../bridge/types.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { ListItem } from '../../components/design-system/ListItem.js'
import { QRCodeDisplay } from '../../components/QRCodeDisplay.js'
import { shouldShowRemoteCallout } from '../../components/RemoteCallout.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { logForDebugging } from '../../utils/debug.js'

type Props = {
  onDone: LocalJSXCommandOnDone
  name?: string
}

/**
 * /remote-control 命令 — 管理双向桥接连接
 *
 * 启用时，在 AppState 中设置 replBridgeEnabled，触发
 * REPL.tsx 中的 useReplBridge 初始化桥接连接。
 * 桥接会注册环境、创建与当前对话的会话、轮询任务，
 * 并连接入站 WebSocket，实现 CLI 与 zy.ai 之间的双向通信。
 *
 * 在已连接状态下再次运行 /remote-control 时，会显示一个对话框，
 * 展示会话 URL 并提供断开或继续的选项。
 */
function WireToggle({ onDone, name }: Props) {
  const setAppState = useSetAppState()
  const replWireConnected = useAppState((state) => state.replWireConnected)
  const replBridgeEnabled = useAppState((state) => state.replBridgeEnabled)
  const replBridgeOutboundOnly = useAppState((state) => state.replBridgeOutboundOnly)
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false)
  useEffect(() => {
    if ((replWireConnected || replBridgeEnabled) && !replBridgeOutboundOnly) {
      setShowDisconnectDialog(true)
      return
    }
    let cancelled = false
    ;(async () => {
      const error = await checkWirePrerequisites()
      if (cancelled) {
        return
      }
      if (error) {
        logEvent('zy_bridge_command', {
          action: 'preflight_failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        onDone(error, {
          display: 'system',
        })
        return
      }
      if (shouldShowRemoteCallout()) {
        setAppState((prev) => {
          if (prev.showRemoteCallout) {
            return prev
          }
          return {
            ...prev,
            showRemoteCallout: true,
            replWireInitialName: name,
          }
        })
        onDone('', {
          display: 'system',
        })
        return
      }
      logEvent('zy_bridge_command', {
        action: 'connect' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      setAppState((prev) => {
        if (prev.replBridgeEnabled && !prev.replBridgeOutboundOnly) {
          return prev
        }
        return {
          ...prev,
          replBridgeEnabled: true,
          replWireExplicit: true,
          replBridgeOutboundOnly: false,
          replWireInitialName: name,
        }
      })
      onDone('Remote Control connecting\u2026', {
        display: 'system',
      })
    })()
    return () => {
      cancelled = true
    }
  }, [replBridgeOutboundOnly, onDone, setAppState, replBridgeEnabled, replWireConnected, name])
  if (showDisconnectDialog) {
    return <WireDisconnectDialog onDone={onDone} />
  }
  return null
}

/**
 * 在桥接已连接时使用 /remote-control 显示的对话框。
 * 展示会话 URL，并允许用户断开连接或继续。
 */

function WireDisconnectDialog({ onDone }: Props) {
  useRegisterOverlay('bridge-disconnect-dialog')
  const setAppState = useSetAppState()
  const sessionUrl = useAppState((s) => s.replWireSessionUrl)
  const connectUrl = useAppState((state) => state.replWireConnectUrl)
  const sessionActive = useAppState((state) => state.replWireSessionActive)
  const [focusIndex, setFocusIndex] = useState(2)
  const [showQR, setShowQR] = useState(false)
  const displayUrl = sessionActive ? sessionUrl : connectUrl
  const handleDisconnect = function handleDisconnect() {
    setAppState((prev) => {
      if (!prev.replBridgeEnabled) {
        return prev
      }
      return {
        ...prev,
        replBridgeEnabled: false,
        replWireExplicit: false,
        replBridgeOutboundOnly: false,
      }
    })
    logEvent('zy_bridge_command', {
      action: 'disconnect' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    onDone(REMOTE_CONTROL_DISCONNECTED_MSG, {
      display: 'system',
    })
  }
  const handleShowQR = function handleShowQR() {
    setShowQR((prev) => !prev)
  }
  const handleContinue = function handleContinue() {
    onDone(undefined, {
      display: 'skip',
    })
  }
  useKeybindings(
    {
      'select:next': () => setFocusIndex((nextIndex) => (nextIndex + 1) % 3),
      'select:previous': () => setFocusIndex((nextIndex) => (nextIndex - 1 + 3) % 3),
      'select:accept': () => {
        if (focusIndex === 0) {
          handleDisconnect()
        } else {
          if (focusIndex === 1) {
            handleShowQR()
          } else {
            handleContinue()
          }
        }
      },
    },
    {
      context: 'Select',
    },
  )
  const displayUrlText = displayUrl ? ` at ${displayUrl}` : ''
  const DialogComponent = Dialog
  const ContainerBox = Box
  const isFirstOptionFocused = focusIndex === 0
  return (
    <DialogComponent title={'Remote Control'} onCancel={handleContinue} hideInputGuide={true}>
      {
        <ContainerBox flexDirection={'column'} gap={1}>
          {<Text>This session is available via Remote Control{displayUrlText}.</Text>}
          <QRCodeDisplay displayUrl={displayUrl} showQR={showQR} />
          {
            <Box flexDirection="column">
              {
                <ListItem isFocused={isFirstOptionFocused}>
                  {<Text>Disconnect this session</Text>}
                </ListItem>
              }
              {
                <ListItem isFocused={focusIndex === 1}>
                  {<Text>{showQR ? 'Hide QR code' : 'Show QR code'}</Text>}
                </ListItem>
              }
              {<ListItem isFocused={focusIndex === 2}>{<Text>Continue</Text>}</ListItem>}
            </Box>
          }
          {<Text dimColor={true}>Enter to select · Esc to continue</Text>}
        </ContainerBox>
      }
    </DialogComponent>
  )
}

/**
 * 检查桥接前置条件。如果前置条件失败则返回错误信息，
 * 全部通过则返回 null。如果磁盘缓存已过期，会等待 GrowthBook 初始化，
 * 确保刚获得权限的用户（例如升级到 Max，或功能标志刚发布）
 * 在第一次尝试时就能获得准确的结果。
 */

async function checkWirePrerequisites(): Promise<string | null> {
  // 检查组织策略 — 远程控制可能被禁用
  const { waitForPolicyLimitsToLoad, isPolicyAllowed } = await import(
    '../../services/policy-limits/index.js'
  )
  await waitForPolicyLimitsToLoad()
  if (!isPolicyAllowed('allow_remote_control')) {
    return "Remote Control is disabled by your organization's policy."
  }
  const disabledReason = await getWireDisabledReason()
  if (disabledReason) {
    return disabledReason
  }

  // 镜像 initReplBridge 中的 v1/v2 分支逻辑：仅当功能标志开启且会话非永久时，
  // 才使用无环境变量的 v2 版本。在助手模式（KAIROS）下，useReplBridge 设置 perpetual=true，
  // 强制 initReplBridge 走 v1 路径 — 因此前置条件检查必须保持一致。
  let useV2 = isEnvLessWireEnabled()
  if (feature('KAIROS') && useV2) {
    const assistantModule = await import('../../assistant/index.js')
    if (assistantModule.isAssistantMode?.()) {
      useV2 = false
    }
  }
  const versionError = useV2 ? await checkEnvLessWireMinVersion() : checkWireMinVersion()
  if (versionError) {
    return versionError
  }
  if (!getWireAccessToken()) {
    return BRIDGE_LOGIN_INSTRUCTION
  }
  logForDebugging('[bridge] Prerequisites passed, enabling bridge')
  return null
}
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const name = args.trim() || undefined
  return <WireToggle onDone={onDone} name={name} />
}
