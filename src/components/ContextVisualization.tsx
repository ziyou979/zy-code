import { feature } from 'bun:bundle'
import * as React from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import type { ContextData } from '../services/compact/analyzeContext.js'
import { generateContextSuggestions } from '../services/prompt-suggestion/contextSuggestions.js'
import { getDisplayPath } from '../utils/file.js'
import { formatTokens } from '../utils/format.js'
import { getSourceDisplayName, type SettingSource } from '../services/settings/constants.js'
import { ContextSuggestions } from './ContextSuggestions.js'

const RESERVED_CATEGORY_NAME = 'Autocompact buffer'
const FREE_CATEGORY_NAME = 'Free space'

/** 将类别名称映射到 i18n 翻译 */
function translateCategoryName(name: string): string {
  const normalized = name.replace('[INNER-ONLY] ', '')
  switch (normalized) {
    case 'System prompt':
      return tSync('contextVis.systemPrompt')
    case 'System tools':
      return tSync('contextVis.systemTools')
    case 'System tools (deferred)':
      return tSync('contextVis.systemToolsDeferred')
    case 'MCP tools':
      return tSync('contextVis.mcpToolsCategory')
    case 'MCP tools (deferred)':
      return tSync('contextVis.mcpToolsDeferred')
    case 'Memory files':
      return tSync('contextVis.memoryFilesCategory')
    default:
      return name
  }
}

/** 将来源名称映射到 i18n 翻译 */
function translateSourceName(name: string): string {
  switch (name) {
    case 'User':
      return tSync('contextVis.sourceUser')
    case 'Project':
      return tSync('contextVis.sourceProject')
    case 'Local':
      return tSync('contextVis.sourceLocal')
    case 'Flag':
      return tSync('contextVis.sourceFlag')
    case 'Managed':
      return tSync('contextVis.sourceManaged')
    case 'Plugin':
      return tSync('contextVis.sourcePlugin')
    case 'Built-in':
      return tSync('contextVis.sourceBuiltIn')
    default:
      return name
  }
}

/**
 * One-liner for the legend header showing what context-collapse has done.
 * Returns null when nothing's summarized/staged so we don't add visual
 * noise in the common case. This is the one place a user can see that
 * their context was rewritten — the <collapsed> placeholders are isMeta
 * and don't appear in the conversation view.
 */
function CollapseStatus() {
  if (feature('CONTEXT_COLLAPSE')) {
    const { getStats, isContextCollapseEnabled } =
      require('../services/compact/context-collapse/index.js') as typeof import('../services/compact/context-collapse/index.js')
    if (!isContextCollapseEnabled()) {
      return null
    }
    const s = getStats()
    const { health: h } = s
    const parts = []
    if (s.collapsedSpans > 0) {
      parts.push(
        tSync('contextVis.collapseSummarized', {
          count: s.collapsedSpans,
          spanLabel: tSync(
            s.collapsedSpans === 1 ? 'contextVis.span_one' : 'contextVis.span_other',
          ),
          msgCount: s.collapsedMessages,
        }),
      )
    }
    if (s.stagedSpans > 0) {
      parts.push(tSync('contextVis.collapseStaged', { count: s.stagedSpans }))
    }
    const summary =
      parts.length > 0
        ? parts.join(', ')
        : h.totalSpawns > 0
          ? tSync('contextVis.nothingStaged', {
              count: h.totalSpawns,
              spawnLabel: tSync(
                h.totalSpawns === 1 ? 'contextVis.spawn_one' : 'contextVis.spawn_other',
              ),
            })
          : tSync('contextVis.waitingForTrigger')
    let line2 = null
    if (h.totalErrors > 0) {
      line2 = (
        <Text color="warning">
          {tSync('contextVis.collapseErrors', { errors: h.totalErrors, spawns: h.totalSpawns })}
          {h.lastError ? tSync('contextVis.lastError', { error: h.lastError.slice(0, 60) }) : ''}
        </Text>
      )
    } else {
      if (h.emptySpawnWarningEmitted) {
        line2 = (
          <Text color="warning">
            {tSync('contextVis.collapseIdle', { count: h.totalEmptySpawns })}
          </Text>
        )
      }
    }
    return (
      <>
        <Text dimColor={true}>{tSync('contextVis.contextStrategy', { summary })}</Text>
        {line2}
      </>
    )
  }
  return null
}

// Order for displaying source groups: Project > User > Managed > Plugin > Built-in
const SOURCE_DISPLAY_ORDER = ['Project', 'User', 'Managed', 'Plugin', 'Built-in']

/** Group items by source type for display, sorted by tokens descending within each group */
function groupBySource<
  T extends {
    source: SettingSource | 'plugin' | 'built-in'
    tokens: number
  },
>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = getSourceDisplayName(item.source)
    const existing = groups.get(key) || []
    existing.push(item)
    groups.set(key, existing)
  }
  // Sort each group by tokens descending
  for (const [key, group] of groups.entries()) {
    groups.set(
      key,
      group.sort((a, b) => b.tokens - a.tokens),
    )
  }
  // Return groups in consistent order
  const orderedGroups = new Map<string, T[]>()
  for (const source of SOURCE_DISPLAY_ORDER) {
    const group = groups.get(source)
    if (group) {
      orderedGroups.set(source, group)
    }
  }
  return orderedGroups
}
interface Props {
  data: ContextData
}
export function ContextVisualization({ data }: Props) {
  const {
    categories,
    totalTokens,
    rawMaxTokens,
    percentage,
    gridRows,
    model,
    memoryFiles,
    mcpTools,
    deferredBuiltinTools,
    systemTools,
    systemPromptSections,
    agents,
    skills,
    messageBreakdown,
  } = data
  const visibleCategories = categories.filter(
    (cat) =>
      cat.tokens > 0 &&
      cat.name !== FREE_CATEGORY_NAME &&
      cat.name !== RESERVED_CATEGORY_NAME &&
      !cat.isDeferred,
  )
  const hasDeferredMcpTools = categories.some((cat) => cat.isDeferred && cat.name.includes('MCP'))
  const hasDeferredBuiltinTools = (deferredBuiltinTools ?? []).length > 0
  const autocompactCategory = categories.find((cat) => cat.name === RESERVED_CATEGORY_NAME)
  const gridRowElements = gridRows.map((row, rowIndex) => (
    <Box key={rowIndex} flexDirection="row" marginLeft={-1}>
      {row.map((square, colIndex) => {
        if (square.categoryName === FREE_CATEGORY_NAME) {
          return (
            <Text key={colIndex} dimColor={true}>
              {'\u26F6 '}
            </Text>
          )
        }
        if (square.categoryName === RESERVED_CATEGORY_NAME) {
          return (
            <Text key={colIndex} color={square.color}>
              {'\u26DD '}
            </Text>
          )
        }
        return (
          <Text key={colIndex} color={square.color}>
            {square.squareFullness >= 0.7 ? '\u26C1 ' : '\u26C0 '}
          </Text>
        )
      })}
    </Box>
  ))
  const _gridBox = (
    <Box flexDirection="column" flexShrink={0}>
      {gridRowElements}
    </Box>
  )
  const totalTokensFormatted = formatTokens(totalTokens)
  const maxTokensFormatted = formatTokens(rawMaxTokens)
  const modelInfoText = (
    <Text dimColor={true}>
      {model} · {totalTokensFormatted}/{maxTokensFormatted} tokens ({percentage}%)
    </Text>
  )
  const collapseStatus = <CollapseStatus />
  const spacer = <Text> </Text>
  const categoryItems = visibleCategories.map((cat, index) => {
    const tokenDisplay = formatTokens(cat.tokens)
    const percentDisplay = cat.isDeferred
      ? 'N/A'
      : `${((cat.tokens / rawMaxTokens) * 100).toFixed(1)}%`
    const isReserved = cat.name === RESERVED_CATEGORY_NAME
    const displayName = translateCategoryName(cat.name)
    const symbol = cat.isDeferred ? ' ' : isReserved ? '\u26DD' : '\u26C1'
    return (
      <Box key={index}>
        <Text color={cat.color}>{symbol}</Text>
        <Text> {displayName}: </Text>
        <Text dimColor={true}>
          {tokenDisplay} tokens ({percentDisplay})
        </Text>
      </Box>
    )
  })
  const freeSpaceItem = (categories.find((cat) => cat.name === FREE_CATEGORY_NAME)?.tokens ?? 0) >
    0 && (
    <Box>
      <Text dimColor={true}>⛶</Text>
      <Text> {tSync('contextVis.freeSpace')}: </Text>
      <Text dimColor={true}>
        {formatTokens(categories.find((cat) => cat.name === FREE_CATEGORY_NAME)?.tokens || 0)} (
        {(
          ((categories.find((cat) => cat.name === FREE_CATEGORY_NAME)?.tokens || 0) /
            rawMaxTokens) *
          100
        ).toFixed(1)}
        %)
      </Text>
    </Box>
  )
  const memoryFilesSection = memoryFiles.length > 0 && (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold={true}>{tSync('contextVis.memoryFiles')}</Text>
        <Text dimColor={true}> · /memory</Text>
      </Box>
      {memoryFiles.map((file, index) => (
        <Box key={index}>
          <Text>└ {getDisplayPath(file.path)}: </Text>
          <Text dimColor={true}>{formatTokens(file.tokens)} tokens</Text>
        </Box>
      ))}
    </Box>
  )
  const toolsSection = (
    <Box flexDirection={'column'} marginLeft={-1}>
      {mcpTools.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold={true}>{tSync('contextVis.mcpTools')}</Text>
            <Text dimColor={true}>
              {' '}
              · /mcp{hasDeferredMcpTools ? tSync('contextVis.mcpLoadedOnDemand') : ''}
            </Text>
          </Box>
          {mcpTools.some((tool) => tool.isLoaded) && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor={true}>{tSync('contextVis.loaded')}</Text>
              {mcpTools
                .filter((tool) => tool.isLoaded)
                .map((tool, index) => (
                  <Box key={index}>
                    <Text>└ {tool.name}: </Text>
                    <Text dimColor={true}>{formatTokens(tool.tokens)} tokens</Text>
                  </Box>
                ))}
            </Box>
          )}
          {hasDeferredMcpTools && mcpTools.some((tool) => !tool.isLoaded) && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor={true}>{tSync('contextVis.available')}</Text>
              {mcpTools
                .filter((tool) => !tool.isLoaded)
                .map((tool, index) => (
                  <Box key={index}>
                    <Text dimColor={true}>└ {tool.name}</Text>
                  </Box>
                ))}
            </Box>
          )}
          {!hasDeferredMcpTools &&
            mcpTools.map((tool, index) => (
              <Box key={index}>
                <Text>└ {tool.name}: </Text>
                <Text dimColor={true}>{formatTokens(tool.tokens)} tokens</Text>
              </Box>
            ))}
        </Box>
      )}
      {((systemTools && systemTools.length > 0) || hasDeferredBuiltinTools) && false && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold={true}>[INNER-ONLY] System tools</Text>
            {hasDeferredBuiltinTools && <Text dimColor={true}> (some loaded on-demand)</Text>}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor={true}>Loaded</Text>
            {systemTools?.map((tool, index) => (
              <Box key={`sys-${index}`}>
                <Text>└ {tool.name}: </Text>
                <Text dimColor={true}>{formatTokens(tool.tokens)} tokens</Text>
              </Box>
            ))}
            {deferredBuiltinTools!
              .filter((tool) => tool.isLoaded)
              .map((tool, index) => (
                <Box key={`def-${index}`}>
                  <Text>└ {tool.name}: </Text>
                  <Text dimColor={true}>{formatTokens(tool.tokens)} tokens</Text>
                </Box>
              ))}
          </Box>
          {hasDeferredBuiltinTools && deferredBuiltinTools!.some((tool) => !tool.isLoaded) && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor={true}>Available</Text>
              {deferredBuiltinTools!
                .filter((tool) => !tool.isLoaded)
                .map((tool, index) => (
                  <Box key={index}>
                    <Text dimColor={true}>└ {tool.name}</Text>
                  </Box>
                ))}
            </Box>
          )}
        </Box>
      )}
      {systemPromptSections && systemPromptSections.length > 0 && false && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold={true}>[INNER-ONLY] System prompt sections</Text>
          {systemPromptSections!.map((section, index) => (
            <Box key={index}>
              <Text>└ {section.name}: </Text>
              <Text dimColor={true}>{formatTokens(section.tokens)} tokens</Text>
            </Box>
          ))}
        </Box>
      )}
      {agents.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold={true}>{tSync('contextVis.customAgents')}</Text>
            <Text dimColor={true}> · /agents</Text>
          </Box>
          {Array.from(groupBySource(agents).entries()).map((groupEntry) => {
            const [sourceDisplay, sourceAgents] = groupEntry
            return (
              <Box key={sourceDisplay} flexDirection="column" marginTop={1}>
                <Text dimColor={true}>{translateSourceName(sourceDisplay)}</Text>
                {sourceAgents.map((agent, index) => (
                  <Box key={index}>
                    <Text>└ {agent.agentType}: </Text>
                    <Text dimColor={true}>{formatTokens(agent.tokens)} tokens</Text>
                  </Box>
                ))}
              </Box>
            )
          })}
        </Box>
      )}
      {memoryFilesSection}
      {skills && skills.tokens > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold={true}>{tSync('contextVis.skills')}</Text>
            <Text dimColor={true}> · /skills</Text>
          </Box>
          {Array.from(groupBySource(skills.skillFrontmatter).entries()).map((groupEntry) => {
            const [sourceDisplay, sourceSkills] = groupEntry
            return (
              <Box key={sourceDisplay} flexDirection="column" marginTop={1}>
                <Text dimColor={true}>{translateSourceName(sourceDisplay)}</Text>
                {sourceSkills.map((skill, index) => (
                  <Box key={index}>
                    <Text>└ {skill.name}: </Text>
                    <Text dimColor={true}>{formatTokens(skill.tokens)} tokens</Text>
                  </Box>
                ))}
              </Box>
            )
          })}
        </Box>
      )}
      {messageBreakdown && false && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold={true}>[INNER-ONLY] Message breakdown</Text>
          <Box flexDirection="column" marginLeft={1}>
            <Box>
              <Text>{tSync('ctxVis.toolCalls')} </Text>
              <Text dimColor={true}>{formatTokens(messageBreakdown!.toolCallTokens)} tokens</Text>
            </Box>
            <Box>
              <Text>{tSync('ctxVis.toolResults')} </Text>
              <Text dimColor={true}>{formatTokens(messageBreakdown!.toolResultTokens)} tokens</Text>
            </Box>
            <Box>
              <Text>{tSync('ctxVis.attachments')} </Text>
              <Text dimColor={true}>{formatTokens(messageBreakdown!.attachmentTokens)} tokens</Text>
            </Box>
            <Box>
              <Text>{tSync('ctxVis.assistantMessages')} </Text>
              <Text dimColor={true}>
                {formatTokens(messageBreakdown!.assistantMessageTokens)} tokens
              </Text>
            </Box>
            <Box>
              <Text>{tSync('ctxVis.userMessages')} </Text>
              <Text dimColor={true}>
                {formatTokens(messageBreakdown!.userMessageTokens)} tokens
              </Text>
            </Box>
          </Box>
          {messageBreakdown!.toolCallsByType.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold={true}>[INNER-ONLY] Top tools</Text>
              {messageBreakdown!.toolCallsByType.slice(0, 5).map((tool, index) => (
                <Box key={index} marginLeft={1}>
                  <Text>└ {tool.name}: </Text>
                  <Text dimColor={true}>
                    calls {formatTokens(tool.callTokens)}, results {formatTokens(tool.resultTokens)}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
          {messageBreakdown!.attachmentsByType.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold={true}>[INNER-ONLY] Top attachments</Text>
              {messageBreakdown!.attachmentsByType.slice(0, 5).map((attachment, index) => (
                <Box key={index} marginLeft={1}>
                  <Text>└ {attachment.name}: </Text>
                  <Text dimColor={true}>{formatTokens(attachment.tokens)} tokens</Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
  const contextSuggestions = generateContextSuggestions(data)
  const contextSuggestionsElement = <ContextSuggestions suggestions={contextSuggestions} />

  // 逐行拼接网格（左）和信息（右），避免 Ink flex row 对齐产生空行
  const infoRows: React.ReactNode[] = []
  infoRows.push(modelInfoText)
  if (collapseStatus) {
    infoRows.push(collapseStatus)
  }
  infoRows.push(spacer)
  infoRows.push(
    <Text key="estimatedUsage" dimColor={true} italic={true}>
      {tSync('contextVis.estimatedUsage')}
    </Text>,
  )
  for (const item of categoryItems) {
    infoRows.push(item)
  }
  if (freeSpaceItem) {
    infoRows.push(freeSpaceItem)
  }
  if (autocompactCategory && autocompactCategory.tokens > 0) {
    infoRows.push(
      <Box key="autocompact">
        <Text color={autocompactCategory.color}>⛝</Text>
        <Text dimColor={true}> {tSync('contextVis.autocompactBuffer')}: </Text>
        <Text dimColor={true}>
          {formatTokens(autocompactCategory.tokens)} tokens (
          {((autocompactCategory.tokens / rawMaxTokens) * 100).toFixed(1)}%)
        </Text>
      </Box>,
    )
  }

  const maxRows = Math.max(gridRowElements.length, infoRows.length)
  const alignedRows: React.ReactNode[] = []
  for (let i = 0; i < maxRows; i++) {
    alignedRows.push(
      <Box key={i} flexDirection="row" gap={2}>
        {i < gridRowElements.length ? (
          gridRowElements[i]
        ) : (
          <Text>{' '.repeat(gridRowElements[0] ? 20 : 0)}</Text>
        )}
        {i < infoRows.length ? infoRows[i] : null}
      </Box>,
    )
  }

  return (
    <Box flexDirection={'column'} paddingLeft={1}>
      {<Text bold={true}>{tSync('contextVis.title')}</Text>}
      {alignedRows}
      {toolsSection}
      {contextSuggestionsElement}
    </Box>
  )
}
