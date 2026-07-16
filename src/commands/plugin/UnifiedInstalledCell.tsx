import {
  ARROW_RIGHT,
  CROSS,
  POINTER,
  RADIO_OFF,
  TICK,
  TRIANGLE_UP_OUTLINE,
  WARNING,
} from '../../constants/figures.js'
import { Box, color, Text, useTheme } from '../../ink/index.js'
import { plural } from '../../utils/stringUtils.js'
// @ts-expect-error
import type { UnifiedInstalledItem } from './unifiedTypes.js'

type Props = {
  item: UnifiedInstalledItem
  isSelected: boolean
}
export function UnifiedInstalledCell({ item, isSelected }: Props) {
  const [theme] = useTheme()
  if (item.type === 'plugin') {
    let statusIcon
    let statusText
    if (item.pendingToggle) {
      statusIcon = color('suggestion', theme)(ARROW_RIGHT)
      statusText = item.pendingToggle === 'will-enable' ? 'will enable' : 'will disable'
    } else {
      if (item.errorCount > 0) {
        statusIcon = color('error', theme)(CROSS)
        const errorLabel = plural(item.errorCount, 'error')
        statusText = `${item.errorCount} ${errorLabel}`
      } else {
        if (!item.isEnabled) {
          statusIcon = color('inactive', theme)(RADIO_OFF)
          statusText = 'disabled'
        } else {
          statusIcon = color('success', theme)(TICK)
          statusText = 'enabled'
        }
      }
    }
    return (
      <Box>
        {
          <Text color={isSelected ? 'suggestion' : undefined}>
            {isSelected ? `${POINTER} ` : '  '}
          </Text>
        }
        {<Text color={isSelected ? 'suggestion' : undefined}>{item.name}</Text>}
        {
          <Text dimColor={!isSelected}>
            {' '}
            {<Text backgroundColor="userMessageBackground">Plugin</Text>}
          </Text>
        }
        {<Text dimColor={true}> · {item.marketplace}</Text>}
        {<Text dimColor={!isSelected}> · {statusIcon} </Text>}
        {<Text dimColor={!isSelected}>{statusText}</Text>}
      </Box>
    )
  }
  if (item.type === 'flagged-plugin') {
    const statusIcon_0 = color('warning', theme)(WARNING)
    return (
      <Box>
        {
          <Text color={isSelected ? 'suggestion' : undefined}>
            {isSelected ? `${POINTER} ` : '  '}
          </Text>
        }
        {<Text color={isSelected ? 'suggestion' : undefined}>{item.name}</Text>}
        {
          <Text dimColor={!isSelected}>
            {' '}
            {<Text backgroundColor="userMessageBackground">Plugin</Text>}
          </Text>
        }
        {<Text dimColor={true}> · {item.marketplace}</Text>}
        {<Text dimColor={!isSelected}> · {statusIcon_0} </Text>}
        {<Text dimColor={!isSelected}>removed</Text>}
      </Box>
    )
  }
  if (item.type === 'failed-plugin') {
    const statusIcon_1 = color('error', theme)(CROSS)
    const errorLabel = plural(item.errorCount, 'error')
    const statusText_0 = `failed to load · ${item.errorCount} ${errorLabel}`
    return (
      <Box>
        {
          <Text color={isSelected ? 'suggestion' : undefined}>
            {isSelected ? `${POINTER} ` : '  '}
          </Text>
        }
        {<Text color={isSelected ? 'suggestion' : undefined}>{item.name}</Text>}
        {
          <Text dimColor={!isSelected}>
            {' '}
            {<Text backgroundColor="userMessageBackground">Plugin</Text>}
          </Text>
        }
        {<Text dimColor={true}> · {item.marketplace}</Text>}
        {<Text dimColor={!isSelected}> · {statusIcon_1} </Text>}
        {<Text dimColor={!isSelected}>{statusText_0}</Text>}
      </Box>
    )
  }
  let statusIcon_2
  let statusText_1
  if (item.status === 'connected') {
    statusIcon_2 = color('success', theme)(TICK)
    statusText_1 = 'connected'
  } else {
    if (item.status === 'disabled') {
      statusIcon_2 = color('inactive', theme)(RADIO_OFF)
      statusText_1 = 'disabled'
    } else {
      if (item.status === 'pending') {
        statusIcon_2 = color('inactive', theme)(RADIO_OFF)
        statusText_1 = 'connecting\u2026'
      } else {
        if (item.status === 'needs-auth') {
          statusIcon_2 = color('warning', theme)(TRIANGLE_UP_OUTLINE)
          statusText_1 = 'Enter to auth'
        } else {
          statusIcon_2 = color('error', theme)(CROSS)
          statusText_1 = 'failed'
        }
      }
    }
  }
  if (item.indented) {
    return (
      <Box>
        {
          <Text color={isSelected ? 'suggestion' : undefined}>
            {isSelected ? `${POINTER} ` : '  '}
          </Text>
        }
        {<Text dimColor={!isSelected}>└ </Text>}
        {<Text color={isSelected ? 'suggestion' : undefined}>{item.name}</Text>}
        {
          <Text dimColor={!isSelected}>
            {' '}
            {<Text backgroundColor="userMessageBackground">MCP</Text>}
          </Text>
        }
        {<Text dimColor={!isSelected}> · {statusIcon_2} </Text>}
        {<Text dimColor={!isSelected}>{statusText_1}</Text>}
      </Box>
    )
  }
  return (
    <Box>
      {
        <Text color={isSelected ? 'suggestion' : undefined}>
          {isSelected ? `${POINTER} ` : '  '}
        </Text>
      }
      {<Text color={isSelected ? 'suggestion' : undefined}>{item.name}</Text>}
      {
        <Text dimColor={!isSelected}>
          {' '}
          {<Text backgroundColor="userMessageBackground">MCP</Text>}
        </Text>
      }
      {<Text dimColor={!isSelected}> · {statusIcon_2} </Text>}
      {<Text dimColor={!isSelected}>{statusText_1}</Text>}
    </Box>
  )
}
