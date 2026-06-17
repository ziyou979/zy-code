import { useEffect } from 'react'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { Select } from '../CustomSelect/select.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'

export function shouldShowFullscreenUpsell(): boolean {
  // 已在全屏模式中的用户不需要 upsell
  if (isFullscreenEnvEnabled()) {
    return false
  }
  const config = getGlobalConfig()
  if (config.fullscreenUpsellDismissed) {
    return false
  }
  if ((config.fullscreenUpsellSeenCount ?? 0) >= 3) {
    return false
  }
  return true
}

type Props = {
  onDone: () => void
}

export function FullscreenUpsellDialog({ onDone }: Props) {
  useEffect(() => {
    const newCount = (getGlobalConfig().fullscreenUpsellSeenCount ?? 0) + 1
    saveGlobalConfig((prev) => {
      if ((prev.fullscreenUpsellSeenCount ?? 0) >= newCount) {
        return prev
      }
      return {
        ...prev,
        fullscreenUpsellSeenCount: newCount,
      }
    })
    logEvent('zy_fullscreen_upsell_shown', {
      seen_count: newCount,
    })
  }, [])

  const handleSelect = (value: string) => {
    switch (value) {
      case 'try': {
        saveGlobalConfig((prev) => ({
          ...prev,
          tui: 'fullscreen' as const,
        }))
        logEvent('zy_fullscreen_upsell_accepted', {})
        onDone()
        return
      }
      case 'never': {
        saveGlobalConfig((prev) => ({
          ...prev,
          fullscreenUpsellDismissed: true,
        }))
        logEvent('zy_fullscreen_upsell_dismissed', {})
        onDone()
        return
      }
      case 'not-now': {
        onDone()
        return
      }
    }
  }

  const options = [
    {
      label: tSync('fullscreen.upsell.try'),
      value: 'try' as const,
    },
    {
      label: tSync('fullscreen.upsell.notNow'),
      value: 'not-now' as const,
    },
    {
      label: tSync('fullscreen.upsell.never'),
      value: 'never' as const,
    },
  ]

  return (
    <PermissionDialog title={tSync('fullscreen.upsell.title')}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text>{tSync('fullscreen.upsell.desc1')}</Text>
          <Text>{tSync('fullscreen.upsell.desc2')}</Text>
          <Text>{tSync('fullscreen.upsell.desc3')}</Text>
        </Box>
        <Select
          options={options}
          onChange={handleSelect}
          onCancel={() => handleSelect('not-now')}
        />
      </Box>
    </PermissionDialog>
  )
}
