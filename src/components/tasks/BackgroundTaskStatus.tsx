import * as React from 'react'
import { useState } from 'react'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { stringWidth } from 'src/ink/stringWidth.js'
import { useAppState, useSetAppState } from 'src/state/AppState.js'
import { enterTeammateView, exitTeammateView } from 'src/state/teammateViewHelpers.js'
import { isPanelAgentTask } from 'src/tasks/local-agent-task/LocalAgentTask.js'
import { getPillLabel, pillNeedsCta } from 'src/tasks/pillLabel.js'
import { isBackgroundTask, type TaskState } from 'src/tasks/types.js'
import { calculateHorizontalScrollWindow } from 'src/services/environment/horizontalScroll.js'
import { ARROW_DOWN, ARROW_LEFT, ARROW_RIGHT } from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
} from '../../tools/AgentTool/agentColorManager.js'
import type { Theme } from '../../services/environment/theme.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { shouldHideTasksFooter } from './TaskStatusUtils.js'

type Props = {
  tasksSelected: boolean
  isViewingTeammate?: boolean
  teammateFooterIndex?: number
  isLeaderIdle?: boolean
  onOpenDialog?: (taskId?: string) => void
}
export function BackgroundTaskStatus({
  tasksSelected,
  isViewingTeammate,
  teammateFooterIndex = 0,
  isLeaderIdle = false,
  onOpenDialog,
}: Props) {
  const setAppState = useSetAppState()
  const { columns } = useTerminalSize()
  const tasks = useAppState((s) => s.tasks)
  const viewingAgentTaskId = useAppState((s_0) => s_0.viewingAgentTaskId)
  const runningTasks = (Object.values(tasks ?? {}) as TaskState[]).filter(
    (t) => isBackgroundTask(t) && !(false && isPanelAgentTask(t)),
  )
  const expandedView = useAppState((s_1) => s_1.expandedView)
  const showSpinnerTree = expandedView === 'teammates'
  const allTeammates =
    !showSpinnerTree &&
    runningTasks.length > 0 &&
    runningTasks.every((t_0) => t_0.type === 'in_process_teammate')
  const teammateEntries = runningTasks
    .filter((t_1) => t_1.type === 'in_process_teammate')
    .sort((a, b) => a.identity.agentName.localeCompare(b.identity.agentName))
  const mainPill = {
    name: 'main',
    color: undefined as keyof Theme | undefined,
    isIdle: isLeaderIdle,
    taskId: undefined as string | undefined,
  }
  const teammatePills = teammateEntries.map((t_2) => ({
    name: t_2.identity.agentName,
    color: getAgentThemeColor(t_2.identity.color),
    isIdle: t_2.isIdle,
    taskId: t_2.id,
  }))
  if (!tasksSelected) {
    teammatePills.sort((a_0, b_0) => {
      if (a_0.isIdle !== b_0.isIdle) {
        return a_0.isIdle ? 1 : -1
      }
      return 0
    })
  }
  const pills = [mainPill, ...teammatePills]
  const allPills = pills.map((pill, i) => ({
    ...pill,
    idx: i,
  }))
  const pillWidths = allPills.map((pill_0, i_0) => {
    const pillText = `@${pill_0.name}`
    return stringWidth(pillText) + (i_0 > 0 ? 1 : 0)
  })
  if (allTeammates || (!showSpinnerTree && isViewingTeammate)) {
    const selectedIdx = tasksSelected ? teammateFooterIndex : -1
    const viewedIdx = viewingAgentTaskId
      ? teammateEntries.findIndex((t_3) => t_3.id === viewingAgentTaskId) + 1
      : 0
    const availableWidth = Math.max(20, columns - 20 - 4)
    const { startIndex, endIndex, showLeftArrow, showRightArrow } = calculateHorizontalScrollWindow(
      pillWidths,
      availableWidth,
      2,
      selectedIdx >= 0 ? selectedIdx : 0,
    )
    const visiblePills = allPills.slice(startIndex, endIndex)
    const pillElements = visiblePills.map((pill, pillIndex) => {
      const needsSeparator = pillIndex > 0
      return (
        <React.Fragment key={pill.name}>
          {needsSeparator && <Text> </Text>}
          <AgentPill
            name={pill.name}
            color={pill.color}
            isSelected={selectedIdx === pill.idx}
            isViewed={viewedIdx === pill.idx}
            isIdle={pill.isIdle}
            onClick={() =>
              pill.taskId
                ? enterTeammateView(pill.taskId, setAppState)
                : exitTeammateView(setAppState)
            }
          />
        </React.Fragment>
      )
    })
    return (
      <>
        {showLeftArrow && <Text dimColor={true}>{ARROW_LEFT} </Text>}
        {pillElements}
        {showRightArrow && <Text dimColor={true}> {ARROW_RIGHT}</Text>}
        {
          <Text dimColor={true}>
            {' \xB7 '}
            <KeyboardShortcutHint shortcut={'shift + \u2193'} action="expand" />
          </Text>
        }
      </>
    )
  }
  if (shouldHideTasksFooter(tasks ?? {}, showSpinnerTree)) {
    return null
  }
  if (runningTasks.length === 0) {
    return null
  }
  const pillLabel = getPillLabel(runningTasks)
  const ctaElement = pillNeedsCta(runningTasks) && (
    <Text dimColor={true}>
      {' '}
      · {ARROW_DOWN} {tSync('backgroundTaskStatus.toView')}
    </Text>
  )
  return (
    <>
      {
        <SummaryPill selected={tasksSelected} onClick={onOpenDialog}>
          {pillLabel}
        </SummaryPill>
      }
      {ctaElement}
    </>
  )
}
type AgentPillProps = {
  name: string
  color?: keyof Theme
  isSelected: boolean
  isViewed: boolean
  isIdle: boolean
  onClick?: () => void
}
function AgentPill({ name, color, isSelected, isViewed, isIdle, onClick }: AgentPillProps) {
  const [hover, setHover] = useState(false)
  const highlighted = isSelected || hover
  let label
  if (highlighted) {
    label = color ? (
      <Text backgroundColor={color} color="inverseText" bold={isViewed}>
        @{name}
      </Text>
    ) : (
      <Text color="background" inverse={true} bold={isViewed}>
        @{name}
      </Text>
    )
  } else {
    if (isIdle) {
      label = (
        <Text dimColor={true} bold={isViewed}>
          @{name}
        </Text>
      )
    } else {
      if (isViewed) {
        label = (
          <Text color={color} bold={true}>
            @{name}
          </Text>
        )
      } else {
        label = (
          <Text color={color} dimColor={!color}>
            @{name}
          </Text>
        )
      }
    }
  }
  if (!onClick) {
    return label
  }
  return (
    <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {label}
    </Box>
  )
}
// biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
function SummaryPill({ selected, onClick, children }: any) {
  const [hover, setHover] = useState(false)
  const label = (
    <Text color="background" inverse={selected || hover}>
      {children}
    </Text>
  )
  if (!onClick) {
    return label
  }
  return (
    <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {label}
    </Box>
  )
}
function getAgentThemeColor(colorName: string | undefined): keyof Theme | undefined {
  if (!colorName) {
    return undefined
  }
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName]
  }
  return undefined
}
