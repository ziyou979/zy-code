// Agent Wizard Types

import type { AgentColorName } from '../../../../tools/AgentTool/agentColorManager.js'

export interface AgentWizardData {
  name?: string
  description?: string
  color?: AgentColorName
  model?: string
  tools?: string[]
  location?: string
  memoryEnabled?: boolean
}
