// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Text } from '../ink.js'
import * as React from 'react'
import { getLargeMemoryFiles, MAX_MEMORY_CHARACTER_COUNT, type MemoryFileInfo } from './agentsMd.js'
import figures from 'figures'
import { getCwd } from './cwd.js'
import { relative } from 'node:path'
import { formatNumber } from './format.js'
import type { getGlobalConfig } from './config.js'
import {
  getApiKeyWithSource,
  getApiKeyFromConfigOrMacOSKeychain,
  getAuthTokenSource,
} from './auth.js'
import {
  getAPIProvider,
  isAnthropicProvider,
  isOpenAIProvider,
} from 'src/services/model/providers.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import {
  getAgentDescriptionsTotalTokens,
  AGENT_DESCRIPTIONS_THRESHOLD,
} from './statusNoticeHelpers.js'
import { toIDEDisplayName, getTerminalIdeType } from './ide.js'

// Types
export type StatusNoticeType = 'warning' | 'info'
export type StatusNoticeContext = {
  config: ReturnType<typeof getGlobalConfig>
  agentDefinitions?: AgentDefinitionsResult
  memoryFiles: MemoryFileInfo[]
}
export type StatusNoticeDefinition = {
  id: string
  type: StatusNoticeType
  isActive: (context: StatusNoticeContext) => boolean
  render: (context: StatusNoticeContext) => React.ReactNode
}

// Individual notice definitions
const largeMemoryFilesNotice: StatusNoticeDefinition = {
  id: 'large-memory-files',
  type: 'warning',
  isActive: (ctx) => getLargeMemoryFiles(ctx.memoryFiles).length > 0,
  render: (ctx) => {
    const largeMemoryFiles = getLargeMemoryFiles(ctx.memoryFiles)
    return (
      <>
        {largeMemoryFiles.map((file) => {
          const displayPath = file.path.startsWith(getCwd())
            ? relative(getCwd(), file.path)
            : file.path
          return (
            <Box key={file.path} flexDirection="row">
              <Text color="warning">{figures.warning}</Text>
              <Text color="warning">
                Large <Text bold>{displayPath}</Text> will impact performance (
                {formatNumber(file.content.length)} chars &gt;{' '}
                {formatNumber(MAX_MEMORY_CHARACTER_COUNT)})<Text dimColor> · /memory to edit</Text>
              </Text>
            </Box>
          )
        })}
      </>
    )
  },
}
const zyAiSubscriberExternalTokenNotice: StatusNoticeDefinition = {
  id: 'zy-ai-external-token',
  type: 'warning',
  isActive: () => {
    // No subscription context, so this notice is never active
    return false
  },
  render: () => {
    const authTokenInfo = getAuthTokenSource()
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          Auth conflict: Using {authTokenInfo.source} instead of Zy account subscription token.
          Either unset {authTokenInfo.source}, or run `zy /logout`.
        </Text>
      </Box>
    )
  },
}
const apiKeyConflictNotice: StatusNoticeDefinition = {
  id: 'api-key-conflict',
  type: 'warning',
  isActive: () => {
    // Anthropic 直连平台才涉及 Anthropic Console key 冲突；OpenAI / Google 等平台忽略
    if (!isAnthropicProvider(getAPIProvider())) {
      return false
    }

    const { source: apiKeySource } = getApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    return (
      !!getApiKeyFromConfigOrMacOSKeychain() &&
      (apiKeySource === 'settingsApiKey' || apiKeySource === 'apiKeyHelper')
    )
  },
  render: () => {
    const { source: apiKeySource } = getApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          Auth conflict: Using {apiKeySource} instead of Anthropic Console key. Either unset{' '}
          {apiKeySource}, or run `zy /logout`.
        </Text>
      </Box>
    )
  },
}
const bothAuthMethodsNotice: StatusNoticeDefinition = {
  id: 'both-auth-methods',
  type: 'warning',
  isActive: () => {
    // Anthropic 直连平台才涉及 OAuth / API key 双认证冲突；OpenAI / Google 等平台忽略
    if (!isAnthropicProvider(getAPIProvider())) {
      return false
    }

    const { source: apiKeySource } = getApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    const authTokenInfo = getAuthTokenSource()
    // 当两个函数都识别到同一个 settingsApiKey 时，不视为冲突
    return (
      apiKeySource !== 'none' &&
      authTokenInfo.source !== 'none' &&
      !(apiKeySource === 'apiKeyHelper' && authTokenInfo.source === 'apiKeyHelper') &&
      !(apiKeySource === 'settingsApiKey' && authTokenInfo.source === 'settingsApiKey')
    )
  },
  render: () => {
    const { source: apiKeySource } = getApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    const authTokenInfo = getAuthTokenSource()
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color="warning">{figures.warning}</Text>
          <Text color="warning">
            Auth conflict: Both a token ({authTokenInfo.source}) and an API key ({apiKeySource}) are
            set. This may lead to unexpected behavior.
          </Text>
        </Box>
        <Box flexDirection="column" marginLeft={3}>
          <Text color="warning">
            · Trying to use {authTokenInfo.source === 'zy.ai' ? 'zy.ai' : authTokenInfo.source}?{' '}
            {apiKeySource === 'settingsApiKey'
              ? 'Unset the ZY_API_KEY environment variable, or zy /logout then say "No" to the API key approval before login.'
              : apiKeySource === 'apiKeyHelper'
                ? 'Unset the apiKeyHelper setting.'
                : 'zy /logout'}
          </Text>
          <Text color="warning">
            · Trying to use {apiKeySource}?{' '}
            {authTokenInfo.source === 'zy.ai'
              ? 'zy /logout to sign out of zy.ai.'
              : `Unset the ${authTokenInfo.source} environment variable.`}
          </Text>
        </Box>
      </Box>
    )
  },
}
const largeAgentDescriptionsNotice: StatusNoticeDefinition = {
  id: 'large-agent-descriptions',
  type: 'warning',
  isActive: (context) => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions)
    return totalTokens > AGENT_DESCRIPTIONS_THRESHOLD
  },
  render: (context) => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions)
    return (
      <Box flexDirection="row">
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          Large cumulative agent descriptions will impact performance (~
          {formatNumber(totalTokens)} tokens &gt; {formatNumber(AGENT_DESCRIPTIONS_THRESHOLD)})
          <Text dimColor> · /agents to manage</Text>
        </Text>
      </Box>
    )
  },
}
// 插件安装提示
const jetbrainsPluginNotice: StatusNoticeDefinition = {
  id: 'jetbrains-plugin-install',
  type: 'info',
  isActive: (_context) => {
    // todo 暂时未实现插件，临时屏蔽
    return false
  },
  render: () => {
    const ideType = getTerminalIdeType()
    const ideName = toIDEDisplayName(ideType)
    return (
      <Box flexDirection="row" gap={1} marginLeft={1}>
        <Text color="ide">{figures.arrowUp}</Text>
        <Text>
          Install the <Text color="ide">{ideName}</Text> plugin from the JetBrains Marketplace:{' '}
          <Text bold>https://docs.zy.com/s/zy-code-jetbrains</Text>
        </Text>
      </Box>
    )
  },
}

// All notice definitions
export const statusNoticeDefinitions: StatusNoticeDefinition[] = [
  largeMemoryFilesNotice,
  largeAgentDescriptionsNotice,
  zyAiSubscriberExternalTokenNotice,
  apiKeyConflictNotice,
  bothAuthMethodsNotice,
  jetbrainsPluginNotice,
]

// Helper functions for external use
export function getActiveNotices(context: StatusNoticeContext): StatusNoticeDefinition[] {
  return statusNoticeDefinitions.filter((notice) => notice.isActive(context))
}
