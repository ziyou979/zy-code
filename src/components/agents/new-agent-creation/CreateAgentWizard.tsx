import { tSync } from '../../../i18n/index.js'
import { isAutoMemoryEnabled } from '../../../memdir/paths.js'
import type { Tools } from '../../../tools/Tool.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import { WizardProvider } from '../../wizard/index.js'
import { ColorStep } from './wizard-steps/ColorStep.js'
import { ConfirmStepWrapper } from './wizard-steps/ConfirmStepWrapper.js'
import { DescriptionStep } from './wizard-steps/DescriptionStep.js'
import { GenerateStep } from './wizard-steps/GenerateStep.js'
import { LocationStep } from './wizard-steps/LocationStep.js'
import { MemoryStep } from './wizard-steps/MemoryStep.js'
import { MethodStep } from './wizard-steps/MethodStep.js'
import { ModelStep } from './wizard-steps/ModelStep.js'
import { PromptStep } from './wizard-steps/PromptStep.js'
import { ToolsStep } from './wizard-steps/ToolsStep.js'
import { TypeStep } from './wizard-steps/TypeStep.js'

type Props = {
  tools: Tools
  existingAgents: AgentDefinition[]
  onComplete: (message: string) => void
  onCancel: () => void
}
export function CreateAgentWizard({ tools, existingAgents, onComplete, onCancel }: Props) {
  const memorySteps = isAutoMemoryEnabled() ? [MemoryStep] : []
  const steps = [
    LocationStep,
    MethodStep,
    GenerateStep,
    () => <TypeStep existingAgents={existingAgents} />,
    PromptStep,
    DescriptionStep,
    () => <ToolsStep tools={tools} />,
    ModelStep,
    ColorStep,
    ...memorySteps,
    () => (
      <ConfirmStepWrapper tools={tools} existingAgents={existingAgents} onComplete={onComplete} />
    ),
  ]
  return (
    <WizardProvider
      steps={steps}
      initialData={{}}
      onComplete={_temp}
      onCancel={onCancel}
      title={tSync('wizard.createAgentTitle')}
      showStepCounter={false}
    ></WizardProvider>
  )
}
function _temp() {}
