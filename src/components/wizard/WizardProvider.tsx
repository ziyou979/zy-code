import { createContext, useEffect, useState } from 'react'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import type { WizardContextValue, WizardProviderProps } from './types.js'

// biome-ignore lint/suspicious/noExplicitAny: Ink 渲染层类型兼容
export const WizardContext = createContext<WizardContextValue<any> | null>(null)
export function WizardProvider({
  steps,
  // biome-ignore lint/suspicious/noExplicitAny: Ink 渲染层类型兼容
  initialData = {} as any,
  onComplete,
  onCancel,
  children,
  title,
  showStepCounter = true,
  // biome-ignore lint/suspicious/noExplicitAny: Ink 渲染层类型兼容
}: WizardProviderProps<any>) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [wizardData, setWizardData] = useState(initialData)
  const [isCompleted, setIsCompleted] = useState(false)
  const [navigationHistory, setNavigationHistory] = useState<number[]>([])
  useExitOnCtrlCDWithKeybindings()
  useEffect(() => {
    if (isCompleted) {
      setNavigationHistory([])
      onComplete(wizardData)
    }
  }, [isCompleted, wizardData, onComplete])
  const goNext = () => {
    if (currentStepIndex < steps.length - 1) {
      if (navigationHistory.length > 0) {
        setNavigationHistory((prev) => [...prev, currentStepIndex])
      }
      setCurrentStepIndex((prevIndex) => prevIndex + 1)
    } else {
      setIsCompleted(true)
    }
  }
  const goBack = () => {
    if (navigationHistory.length > 0) {
      const previousStep = navigationHistory[navigationHistory.length - 1]
      if (previousStep !== undefined) {
        setNavigationHistory((prevHistory) => prevHistory.slice(0, -1))
        setCurrentStepIndex(previousStep)
      }
    } else {
      if (currentStepIndex > 0) {
        setCurrentStepIndex((prevIndex) => prevIndex - 1)
      } else {
        if (onCancel) {
          onCancel()
        }
      }
    }
  }
  const goToStep = (index: number) => {
    if (index >= 0 && index < steps.length) {
      setNavigationHistory((prev_3) => [...prev_3, currentStepIndex])
      setCurrentStepIndex(index)
    }
  }
  const cancel = () => {
    setNavigationHistory([])
    if (onCancel) {
      onCancel()
    }
  }
  const updateWizardData = (updates: Record<string, unknown>) => {
    setWizardData((prev_4: Record<string, unknown>) => ({
      ...prev_4,
      ...updates,
    }))
  }
  const contextValue = {
    currentStepIndex,
    totalSteps: steps.length,
    wizardData,
    setWizardData,
    updateWizardData,
    goNext,
    goBack,
    goToStep,
    cancel,
    title,
    showStepCounter,
    completeWizard: () => setIsCompleted(true),
    cancelWizard: cancel,
    steps,
  }
  const CurrentStepComponent = steps[currentStepIndex]
  if (!CurrentStepComponent || isCompleted) {
    return null
  }
  return (
    <WizardContext.Provider value={contextValue}>
      {children || <CurrentStepComponent />}
    </WizardContext.Provider>
  )
}
