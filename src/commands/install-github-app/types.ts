// Install GitHub App Types

export interface State {
  currentStep: number
  isProcessing: boolean
  error?: string
}

export interface Warning {
  message: string
  details?: string
}

export interface Workflow {
  name: string
  path: string
  exists: boolean
}
