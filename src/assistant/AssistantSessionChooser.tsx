import React from 'react'

type AssistantSession = { id: string; name: string }

type Props = {
  sessions: AssistantSession[]
  onSelect: (id: string) => void
  onCancel: () => void
}

export function AssistantSessionChooser({ onCancel }: Props): React.ReactElement {
  React.useEffect(() => { onCancel() }, [])
  return React.createElement('div', null)
}
