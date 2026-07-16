import * as React from 'react'
import { useRef } from 'react'
import { useModalOrTerminalSize } from '../../context/ModalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { tSync } from '../../i18n/index.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { Box, Text, useInput } from '../../ink.js'
import { getActiveExternalToolNames } from '../../tools/externalToolLoader.js'
import { getAllBaseTools } from '../../tools/tools.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types.js'

/** 标题 + 退出提示占用行数 */
const CHROME_ROWS = 4
const SCROLL_LINES = 3

function ToolsList({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null)
  const { rows } = useModalOrTerminalSize(useTerminalSize())
  const contentHeight = Math.max(8, rows - CHROME_ROWS)

  useInput((_input, key) => {
    if (key.escape || key.return) {
      onDone()
      return
    }
    if (key.upArrow) {
      scrollRef.current?.scrollBy(-SCROLL_LINES)
    }
    if (key.downArrow) {
      scrollRef.current?.scrollBy(SCROLL_LINES)
    }
  })

  const allTools = getAllBaseTools()
  const externalNames = new Set(getActiveExternalToolNames())

  // 外部工具按名去重：同名工具中内置的那个已被外部覆盖，只展示外部注册的版本
  const seenExternal = new Set<string>()
  const externalTools = allTools.filter((t) => {
    if (!externalNames.has(t.name)) return false
    if (seenExternal.has(t.name)) return false
    seenExternal.add(t.name)
    return true
  })
  const builtinTools = allTools.filter((t) => !externalNames.has(t.name))

  return (
    <Box flexDirection="column" height={rows}>
      {/* 标题栏 */}
      <Box marginBottom={1} flexShrink={0}>
        <Text bold>{tSync('commands.tools.title')}</Text>
        <Text dimColor>
          {' '}
          ({builtinTools.length + externalTools.length} {tSync('commands.tools.total')})
        </Text>
      </Box>

      {/* 可滚动列表 */}
      <ScrollBox ref={scrollRef} flexDirection="column" height={contentHeight} flexShrink={1}>
        {/* 内置工具 */}
        {builtinTools.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Box marginBottom={1} flexShrink={0}>
              <Text bold>
                {tSync('commands.tools.builtin')}
                <Text dimColor> ({builtinTools.length})</Text>
              </Text>
            </Box>
            {builtinTools.map((tool) => {
              const displayName = tool.userFacingName?.(undefined) || tool.name
              return (
                <Box key={tool.name} marginLeft={2} flexShrink={0}>
                  <Text>
                    {' '}
                    <Text bold>{tool.name}</Text>
                    {displayName !== tool.name && <Text dimColor> ({displayName})</Text>}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}

        {/* 外部工具 */}
        {externalTools.length > 0 && (
          <Box flexDirection="column">
            <Box marginBottom={1} flexShrink={0}>
              <Text bold>
                {tSync('commands.tools.external')}
                <Text dimColor> ({externalTools.length})</Text>
              </Text>
            </Box>
            {externalTools.map((tool) => {
              const displayName = tool.userFacingName?.(undefined) || tool.name
              return (
                <Box key={tool.name} marginLeft={2} flexShrink={0}>
                  <Text>
                    {' '}
                    <Text bold>{tool.name}</Text>
                    {displayName !== tool.name && <Text dimColor> ({displayName})</Text>}{' '}
                    <Text color="success">{tSync('commands.tools.externalTag')}</Text>
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}

        {/* 空状态 */}
        {builtinTools.length === 0 && externalTools.length === 0 && (
          <Text dimColor>{tSync('commands.tools.empty')}</Text>
        )}
      </ScrollBox>

      {/* 退出提示 */}
      <Box marginTop={1} flexShrink={0}>
        <Text dimColor>{tSync('commands.tools.exitHint')}</Text>
      </Box>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <ToolsList onDone={onDone} />
}
