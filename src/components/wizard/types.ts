// Wizard Component Types

import type { ReactNode } from 'react'

export type WizardStep<_T> = () => ReactNode

export interface WizardContextValue<T> {
  currentStepIndex: number
  wizardData: T
  goNext: () => void
  goBack: () => void
  updateWizardData: (data: Partial<T>) => void
  completeWizard: () => void
  cancelWizard: () => void
  steps: Array<WizardStep<T>>
}

export interface WizardProviderProps<T> {
  steps: Array<WizardStep<T>>
  initialData: T
  onComplete: (data: T) => void
  onCancel?: () => void
  children?: ReactNode
  title?: string
  showStepCounter?: boolean
}
