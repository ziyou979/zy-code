// Wizard Component Types

import type { ReactNode } from 'react'

export type WizardStep<_T> = () => ReactNode

export interface WizardContextValue<T> {
  currentStepIndex: number
  totalSteps: number
  wizardData: T
  goNext: () => void
  goBack: () => void
  goToStep: (index: number) => void
  updateWizardData: (data: Partial<T>) => void
  completeWizard: () => void
  cancelWizard: () => void
  title?: string
  showStepCounter: boolean
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
