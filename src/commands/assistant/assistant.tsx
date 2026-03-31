import React from 'react'

type Props = {
  defaultDir: string
  onInstalled: (dir: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

export function NewInstallWizard({ onCancel }: Props): React.ReactElement {
  React.useEffect(() => { onCancel() }, [])
  return React.createElement('div', null)
}

export async function computeDefaultInstallDir(): Promise<string> {
  return '/usr/local/bin'
}
