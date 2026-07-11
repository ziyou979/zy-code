import { SQUARE_SMALL_FILLED } from '../constants/figures.js'
import * as React from 'react'
import { Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'

type Props = {
  selected: boolean
}

/**
 * Footer 状态药丸：显示当前活跃的 Tmux 会话。
 * 仅在 isInternalBuild() 且 tungstenActiveSession 存在时由父组件渲染。
 */
export function TungstenPill({ selected }: Props): React.ReactNode {
  const session = useAppState((s) => s.tungstenActiveSession)

  if (!session) {
    return null
  }

  const label = `${SQUARE_SMALL_FILLED} tmux`

  return (
    <Text key={selected ? 'selected' : 'normal'} color="background" inverse={selected}>
      {label}
    </Text>
  )
}
