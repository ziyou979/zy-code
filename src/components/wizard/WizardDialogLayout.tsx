import { type ReactNode } from 'react'
import type { Theme } from '../../services/environment/theme.js'
import { Dialog } from '../design-system/Dialog.js'
import { useWizard } from './useWizard.js'
import { WizardNavigationFooter } from './WizardNavigationFooter.js'

type Props = {
  title?: string
  color?: keyof Theme
  children: ReactNode
  subtitle?: string
  footerText?: ReactNode
}
export function WizardDialogLayout({
  title: titleOverride,
  color = 'suggestion',
  children,
  subtitle,
  footerText,
}: Props) {
  const {
    currentStepIndex,
    totalSteps,
    title: providerTitle,
    showStepCounter,
    goBack,
  } = useWizard<Record<string, unknown>>()
  const title = titleOverride || providerTitle || 'Wizard'
  const stepSuffix = showStepCounter !== false ? ` (${currentStepIndex + 1}/${totalSteps})` : ''
  return (
    <>
      {
        <Dialog
          title={`${title}${stepSuffix}`}
          subtitle={subtitle}
          onCancel={goBack}
          color={color}
          hideInputGuide={true}
          isCancelActive={false}
        >
          {children}
        </Dialog>
      }
      {<WizardNavigationFooter instructions={footerText} />}
    </>
  )
}
