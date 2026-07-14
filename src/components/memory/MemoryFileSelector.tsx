import { feature } from 'bun:bundle'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import chalk from 'chalk'
import { use, useEffect, useState } from 'react'
import { getOriginalCwd } from '../../bootstrap/runtime/runtimeContext.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { logEvent } from '../../services/analytics/index.js'
import { isAutoDreamEnabled } from '../../services/auto-dream/config.js'
import { readLastConsolidatedAt } from '../../services/auto-dream/consolidationLock.js'
import { projectIsInGitRepo } from '../../services/memory/versions.js'
import { useAppState } from '../../state/AppState.js'
import { getAgentMemoryDir } from '../../tools/AgentTool/agentMemory.js'
import { getMemoryFiles, type MemoryFileInfo } from '../../utils/agentsMd.js'
import { openPath } from '../../utils/browser.js'
import { getZyConfigHomeDir } from '../../utils/envUtils.js'
import { getDisplayPath } from '../../utils/file.js'
import { formatRelativeTimeAgo } from '../../utils/format.js'
import { updateSettingsForSource } from '../../services/settings/settings.js'
import { Select } from '../CustomSelect/index.js'
import { ListItem } from '../design-system/ListItem.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../../memdir/teamMemPaths.js') as typeof import('../../memdir/teamMemPaths.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

interface ExtendedMemoryFileInfo extends MemoryFileInfo {
  isNested?: boolean
  exists: boolean
}

// 记住最后选择的路径
let lastSelectedPath: string | undefined
const OPEN_FOLDER_PREFIX = '__open_folder__'
type Props = {
  onSelect: (path: string) => void
  onCancel: () => void
}
export function MemoryFileSelector({ onSelect, onCancel }: Props) {
  const existingMemoryFiles = use(getMemoryFiles())
  const userMemoryPath = join(getZyConfigHomeDir(), 'AGENTS.md')
  const projectMemoryPath = join(getOriginalCwd(), 'AGENTS.md')
  const hasUserMemory = existingMemoryFiles.some((f) => f.path === userMemoryPath)
  const hasProjectMemory = existingMemoryFiles.some((f_0) => f_0.path === projectMemoryPath)
  const allMemoryFiles = [
    ...existingMemoryFiles
      .filter((f_1) => f_1.type !== 'AutoMem' && f_1.type !== 'TeamMem')
      .map((f_2) => ({
        ...f_2,
        exists: true,
      })),
    ...(hasUserMemory
      ? []
      : [
          {
            path: userMemoryPath,
            type: 'User' as const,
            content: '',
            exists: false,
          },
        ]),
    ...(hasProjectMemory
      ? []
      : [
          {
            path: projectMemoryPath,
            type: 'Project' as const,
            content: '',
            exists: false,
          },
        ]),
  ]
  const depths = new Map()
  const memoryOptions = allMemoryFiles.map((file) => {
    const displayPath = getDisplayPath(file.path)
    const existsLabel = file.exists ? '' : ' (new)'
    const depth = file.parent ? (depths.get(file.parent) ?? 0) + 1 : 0
    depths.set(file.path, depth)
    const indent = depth > 0 ? '  '.repeat(depth - 1) : ''
    let label
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    if (file.type === 'User' && !(file as any).isNested && file.path === userMemoryPath) {
      label = 'User memory'
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      if (file.type === 'Project' && !(file as any).isNested && file.path === projectMemoryPath) {
        label = 'Project memory'
      } else {
        if (depth > 0) {
          label = `${indent}L ${displayPath}${existsLabel}`
        } else {
          label = `${displayPath}`
        }
      }
    }
    let description
    const isGit = projectIsInGitRepo(getOriginalCwd())
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    if (file.type === 'User' && !(file as any).isNested) {
      description = 'Saved in ~/.zy/AGENTS.md'
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      if (file.type === 'Project' && !(file as any).isNested && file.path === projectMemoryPath) {
        description = `${isGit ? 'Checked in at' : 'Saved in'} ./AGENTS.md`
      } else {
        if (file.parent) {
          description = '@-imported'
        } else {
          // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
          if ((file as any).isNested) {
            description = 'dynamically loaded'
          } else {
            description = ''
          }
        }
      }
    }
    return {
      label,
      value: file.path,
      description,
    }
  })
  const folderOptions = []
  const agentDefinitions = useAppState((s) => s.agentDefinitions)
  if (isAutoMemoryEnabled()) {
    folderOptions.push({
      label: 'Open auto-memory folder',
      value: `${OPEN_FOLDER_PREFIX}${getAutoMemPath()}`,
      description: '',
    })
    if (feature('TEAMMEM') && teamMemPaths?.isTeamMemoryEnabled()) {
      folderOptions.push({
        label: 'Open team memory folder',
        value: `${OPEN_FOLDER_PREFIX}${teamMemPaths!.getTeamMemPath()}`,
        description: '',
      })
    }
    for (const agent of agentDefinitions.activeAgents) {
      if (agent.memory) {
        const agentDir = getAgentMemoryDir(agent.agentType, agent.memory)
        folderOptions.push({
          label: `Open ${chalk.bold(agent.agentType)} agent memory`,
          value: `${OPEN_FOLDER_PREFIX}${agentDir}`,
          description: `${agent.memory} scope`,
        })
      }
    }
  }
  memoryOptions.push(...folderOptions)
  const initialPath =
    lastSelectedPath && memoryOptions.some((opt) => opt.value === lastSelectedPath)
      ? lastSelectedPath
      : memoryOptions[0]?.value || ''
  const [autoMemoryOn, setAutoMemoryOn] = useState(isAutoMemoryEnabled)
  const [autoDreamOn, setAutoDreamOn] = useState(isAutoDreamEnabled)
  const [showDreamRow] = useState(isAutoMemoryEnabled)
  const isDreamRunning = useAppState((s_0) =>
    Object.values(s_0.tasks).some(
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      (t: any) => (t as any).type === 'dream' && (t as any).status === 'running',
    ),
  )
  const [lastDreamAt, setLastDreamAt] = useState<number | null>(null)
  useEffect(() => {
    if (!showDreamRow) {
      return
    }
    readLastConsolidatedAt().then(setLastDreamAt)
  }, [showDreamRow])
  const dreamStatus = isDreamRunning
    ? 'running'
    : lastDreamAt === null
      ? ''
      : lastDreamAt === 0
        ? 'never'
        : `last ran ${formatRelativeTimeAgo(new Date(lastDreamAt))}`
  const [focusedToggle, setFocusedToggle] = useState<number | null>(null)
  const toggleFocused = focusedToggle !== null
  const lastToggleIndex = showDreamRow ? 1 : 0
  const handleToggleAutoMemory = function handleToggleAutoMemory() {
    const newValue = !autoMemoryOn
    updateSettingsForSource('userSettings', {
      autoMemoryEnabled: newValue,
    })
    setAutoMemoryOn(newValue)
    logEvent('zy_auto_memory_toggled', {
      enabled: newValue,
    })
  }
  const handleToggleAutoDream = function handleToggleAutoDream() {
    const newValue_0 = !autoDreamOn
    updateSettingsForSource('userSettings', {
      autoDreamEnabled: newValue_0,
    })
    setAutoDreamOn(newValue_0)
    logEvent('zy_auto_dream_toggled', {
      enabled: newValue_0,
    })
  }
  useExitOnCtrlCDWithKeybindings()
  useKeybinding('confirm:no', onCancel, {
    context: 'Confirmation',
  })
  useKeybinding(
    'confirm:yes',
    () => {
      if (focusedToggle === 0) {
        handleToggleAutoMemory()
      } else {
        if (focusedToggle === 1) {
          handleToggleAutoDream()
        }
      }
    },
    {
      context: 'Confirmation',
      isActive: toggleFocused,
    },
  )
  useKeybinding(
    'select:next',
    () => {
      setFocusedToggle((prev) => (prev !== null && prev < lastToggleIndex ? prev + 1 : null))
    },
    {
      context: 'Select',
      isActive: toggleFocused,
    },
  )
  useKeybinding(
    'select:previous',
    () => {
      setFocusedToggle((prev_0) => (prev_0 !== null && prev_0 > 0 ? prev_0 - 1 : prev_0))
    },
    {
      context: 'Select',
      isActive: toggleFocused,
    },
  )
  return (
    <Box flexDirection="column" width="100%">
      {
        <Box flexDirection="column" marginBottom={1}>
          {
            <ListItem isFocused={focusedToggle === 0}>
              {
                <Text>
                  {tSync('memoryFile.autoMemory', { status: autoMemoryOn ? 'on' : 'off' })}
                </Text>
              }
            </ListItem>
          }
          {showDreamRow && (
            <ListItem isFocused={focusedToggle === 1} styled={false}>
              <Text color={focusedToggle === 1 ? 'suggestion' : undefined}>
                Auto-dream: {autoDreamOn ? 'on' : 'off'}
                {dreamStatus && <Text dimColor={true}> · {dreamStatus}</Text>}
                {!isDreamRunning && autoDreamOn && <Text dimColor={true}> · /dream to run</Text>}
              </Text>
            </ListItem>
          )}
        </Box>
      }
      {
        <Select
          defaultFocusValue={initialPath}
          options={memoryOptions}
          isDisabled={toggleFocused}
          onChange={(value: string) => {
            if (value.startsWith(OPEN_FOLDER_PREFIX)) {
              const folderPath = value.slice(OPEN_FOLDER_PREFIX.length)
              mkdir(folderPath, {
                recursive: true,
              })
                .catch(_temp8)
                .then(() => openPath(folderPath))
              return
            }
            lastSelectedPath = value
            onSelect(value)
          }}
          onCancel={onCancel}
          onUpFromFirstItem={() => setFocusedToggle(lastToggleIndex)}
        />
      }
    </Box>
  )
}
function _temp8() {}
