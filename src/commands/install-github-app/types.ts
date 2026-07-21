// Install GitHub App Types

export type Workflow = 'zy' | 'zy-review'

export interface Warning {
  title: string
  message: string
  instructions: string[]
}

export interface State {
  step: string
  selectedRepoName: string
  currentRepo: string
  useCurrentRepo: boolean
  apiKeyOrOAuthToken: string
  useExistingKey: boolean
  currentWorkflowInstallStep: number
  warnings: Warning[]
  secretExists: boolean
  secretName: string
  useExistingSecret: boolean
  workflowExists: boolean
  selectedWorkflows: Workflow[]
  selectedApiKeyOption: 'existing' | 'new' | 'oauth'
  authType: 'api_key' | 'oauth_token'
  workflowAction?: string
  errorReason?: string
  errorInstructions?: string[]
  currentStep?: number
  isProcessing?: boolean
  error?: string
}
