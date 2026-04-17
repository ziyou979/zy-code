// Agent Wizard Types

import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { CustomAgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { AgentMemoryScope } from 'src/tools/AgentTool/agentMemory.js'
import type { SettingSource } from 'src/utils/settings/constants.js'

export interface AgentWizardData {
  [key: string]: unknown
  name?: string
  description?: string
  color?: AgentColorName
  model?: string
  tools?: string[]
  location?: SettingSource
  memoryEnabled?: boolean
  finalAgent?: CustomAgentDefinition
  systemPrompt?: string
  generationPrompt?: string
  selectedMemory?: AgentMemoryScope
  wasGenerated?: boolean
}
