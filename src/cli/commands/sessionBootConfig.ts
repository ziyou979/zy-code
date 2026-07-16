import { feature } from 'bun:bundle'
import uniqBy from 'lodash-es/uniqBy.js'
import {
  getIsNonInteractiveSession,
  getUserMsgOptIn,
  setUserMsgOptIn,
} from '../../bootstrap/runtime/runtimeContext.js'
import { prefetchAllMcpResources } from '../../services/mcp/client.js'
import { getInitialSettings } from '../../services/settings/settings.js'
import type { McpSdkServerConfig, ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { shouldEnableThinkingByDefault, type ThinkingConfig } from '../../utils/thinking.js'

type PrefetchedMcpResources = Awaited<ReturnType<typeof prefetchAllMcpResources>>

type ThinkingModeOption = 'adaptive' | 'enabled' | 'disabled' | undefined

function getBriefToolModule() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return require('../../tools/BriefTool/BriefTool.js') as typeof import('../../tools/BriefTool/BriefTool.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
}

function getBriefVisibilityMessage() {
  if (feature('KAIROS')) {
    return getBriefToolModule().isBriefEnabled()
      ? 'Call SendUserMessage at checkpoints to mark where things stand.'
      : 'The user will see any text you output.'
  }

  if (feature('KAIROS_BRIEF')) {
    return getBriefToolModule().isBriefEnabled()
      ? 'Call SendUserMessage at checkpoints to mark where things stand.'
      : 'The user will see any text you output.'
  }

  return 'The user will see any text you output.'
}

export function maybeEnableBriefOptInFromDefaultView() {
  if (
    getIsNonInteractiveSession() ||
    getUserMsgOptIn() ||
    getInitialSettings().defaultView !== 'chat'
  ) {
    return
  }

  if (getBriefToolModule().isBriefEntitled()) {
    setUserMsgOptIn(true)
  }
}

export function appendProactiveModePrompt(
  appendSystemPrompt: string | undefined,
  proactiveRequested: boolean,
  isCoordinatorMode: boolean,
) {
  if (!proactiveRequested || isCoordinatorMode) {
    return appendSystemPrompt
  }

  const briefVisibility = getBriefVisibilityMessage()
  const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. ${briefVisibility}`

  return appendSystemPrompt ? `${appendSystemPrompt}\n\n${proactivePrompt}` : proactivePrompt
}

export function splitMcpConfigs(
  allMcpConfigs: Record<string, ScopedMcpServerConfig | McpSdkServerConfig>,
): {
  sdkMcpConfigs: Record<string, McpSdkServerConfig>
  regularMcpConfigs: Record<string, ScopedMcpServerConfig>
} {
  const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {}
  const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {}

  for (const [name, config] of Object.entries(allMcpConfigs)) {
    if (config.type === 'sdk') {
      sdkMcpConfigs[name] = config
    } else {
      regularMcpConfigs[name] = config
    }
  }

  return { sdkMcpConfigs, regularMcpConfigs }
}

export function createMcpPrefetchPromises(
  isNonInteractiveSession: boolean,
  regularMcpConfigs: Record<string, ScopedMcpServerConfig>,
  zyaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>>,
): {
  localMcpPromise: Promise<PrefetchedMcpResources>
  zyaiMcpPromise: Promise<PrefetchedMcpResources>
  mcpPromise: Promise<PrefetchedMcpResources>
} {
  const emptyResources = {
    clients: [],
    tools: [],
    commands: [],
  } satisfies PrefetchedMcpResources

  const localMcpPromise = isNonInteractiveSession
    ? Promise.resolve(emptyResources)
    : prefetchAllMcpResources(regularMcpConfigs)

  const zyaiMcpPromise = isNonInteractiveSession
    ? Promise.resolve(emptyResources)
    : zyaiConfigPromise.then((configs) =>
        Object.keys(configs).length > 0 ? prefetchAllMcpResources(configs) : emptyResources,
      )

  // 按名称去重合并：每个 prefetchAllMcpResources 调用独立添加帮助工具，
  // 这里先做一次汇总去重，避免启动期状态里出现重复项。
  const mcpPromise = Promise.all([localMcpPromise, zyaiMcpPromise]).then(([local, zyai]) => ({
    clients: [...local.clients, ...zyai.clients],
    tools: uniqBy([...local.tools, ...zyai.tools], 'name'),
    commands: uniqBy([...local.commands, ...zyai.commands], 'name'),
  }))

  return {
    localMcpPromise,
    zyaiMcpPromise,
    mcpPromise,
  }
}

export function resolveThinkingState(
  effectiveModel: string | undefined,
  thinkingMode: ThinkingModeOption,
  maxThinkingTokensOption: number | undefined,
): {
  thinkingEnabled: boolean
  thinkingConfig: ThinkingConfig
} {
  let thinkingEnabled = shouldEnableThinkingByDefault(effectiveModel)
  let thinkingConfig: ThinkingConfig = thinkingEnabled
    ? {
        type: 'adaptive',
      }
    : {
        type: 'disabled',
      }

  if (thinkingMode === 'adaptive' || thinkingMode === 'enabled') {
    return {
      thinkingEnabled: true,
      thinkingConfig: {
        type: 'adaptive',
      },
    }
  }

  if (thinkingMode === 'disabled') {
    return {
      thinkingEnabled: false,
      thinkingConfig: {
        type: 'disabled',
      },
    }
  }

  const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
    ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
    : maxThinkingTokensOption

  if (maxThinkingTokens !== undefined) {
    if (maxThinkingTokens > 0) {
      thinkingEnabled = true
      thinkingConfig = {
        type: 'enabled',
        budgetTokens: maxThinkingTokens,
      }
    } else if (maxThinkingTokens === 0) {
      thinkingEnabled = false
      thinkingConfig = {
        type: 'disabled',
      }
    }
  }

  return {
    thinkingEnabled,
    thinkingConfig,
  }
}
