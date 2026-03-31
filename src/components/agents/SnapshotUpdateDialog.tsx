import React from 'react'

type Props = {
  agentType: string
  scope: unknown
  snapshotTimestamp: string
  onComplete: (result: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}

export function SnapshotUpdateDialog({ onCancel }: Props): React.ReactElement {
  React.useEffect(() => { onCancel() }, [])
  return React.createElement('div', null)
}
