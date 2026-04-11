// Wizard Types

export interface WizardStep {
  id: string
  title: string
  render: () => string
}

export interface WizardConfig {
  steps: WizardStep[]
  onComplete: () => void
}
