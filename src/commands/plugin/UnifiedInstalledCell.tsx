import figures from 'figures'
import * as React from 'react'
import { Box, color, Text, useTheme } from '../../ink.js'
import { plural } from '../../utils/stringUtils.js'
// @ts-ignore
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
      statusIcon = color('suggestion', theme)(figures.arrowRight)
      statusText = item.pendingToggle === 'will-enable' ? 'will enable' : 'will disable'
    } else {
      if (item.errorCount > 0) {
        statusIcon = color('error', theme)(figures.cross)
        const t3 = plural(item.errorCount, 'error')
        statusText = `${item.errorCount} ${t3}`
      } else {
        if (!item.isEnabled) {
          statusIcon = color('inactive', theme)(figures.radioOff)
          statusText = 'disabled'
        } else {
          statusIcon = color('success', theme)(figures.tick)
          statusText = 'enabled'
        }
      }
    }
    return (
      <Box>
        {
          <Text color={isSelected ? 'suggestion' : undefined}>
            {isSelected ? `${figures.pointer} ` : '  '}
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
    const statusIcon_0 = color('warning', theme)(figures.warning)
    return (
      <Box>
        {
          <Text color={isSelected ? 'suggestion' : undefined}>
            {isSelected ? `${figures.pointer} ` : '  '}
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
    const statusIcon_1 = color('error', theme)(figures.cross)
    const t3 = plural(item.errorCount, 'error')
    const statusText_0 = `failed to load · ${item.errorCount} ${t3}`
    return (
      <Box>
        {
          <Text color={isSelected ? 'suggestion' : undefined}>
            {isSelected ? `${figures.pointer} ` : '  '}
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
    statusIcon_2 = color('success', theme)(figures.tick)
    statusText_1 = 'connected'
  } else {
    if (item.status === 'disabled') {
      statusIcon_2 = color('inactive', theme)(figures.radioOff)
      statusText_1 = 'disabled'
    } else {
      if (item.status === 'pending') {
        statusIcon_2 = color('inactive', theme)(figures.radioOff)
        statusText_1 = 'connecting\u2026'
      } else {
        if (item.status === 'needs-auth') {
          statusIcon_2 = color('warning', theme)(figures.triangleUpOutline)
          statusText_1 = 'Enter to auth'
        } else {
          statusIcon_2 = color('error', theme)(figures.cross)
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
            {isSelected ? `${figures.pointer} ` : '  '}
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
          {isSelected ? `${figures.pointer} ` : '  '}
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
