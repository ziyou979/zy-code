import * as React from 'react'
import { use } from 'react'
import { Box } from '../ink.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { getGlobalConfig } from '../utils/config.js'
import { getActiveNotices } from '../utils/statusNoticeDefinitions.js'
import { getMemoryFiles } from '../utils/agentsMd.js'

type Props = {
  agentDefinitions?: AgentDefinitionsResult
}

/**
 * StatusNotices 包含启动时向用户展示的信息。中性和正面状态已移至
 * src/components/Status.tsx，用户可通过 /status 访问。
 */
export function StatusNotices(props: Props) {
  const { agentDefinitions } = props === undefined ? {} : props
  const globalConfig = getGlobalConfig()
  const memoryFilesPromise = getMemoryFiles()
  const context = {
    config: globalConfig,
    agentDefinitions,
    memoryFiles: use(memoryFilesPromise),
  }
  const activeNotices = getActiveNotices(context)
  if (activeNotices.length === 0) {
    return null
  }
  const noticeElements = activeNotices.map((notice) => (
    <React.Fragment key={notice.id}>{notice.render(context)}</React.Fragment>
  ))
  return (
    <Box flexDirection={'column'} paddingLeft={1}>
      {noticeElements}
    </Box>
  )
}
