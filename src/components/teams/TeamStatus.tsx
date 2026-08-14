import { Text } from '../../ink/index.js'
import { useAppState } from '../../state/AppState.js'

type Props = {
  teamsSelected: boolean
  showHint: boolean
}

/**
 * 显示 teammate 数量的 footer 状态指示器。
 * 与 BackgroundTaskStatus 类似，但用于 teammate。
 */
export function TeamStatus({ teamsSelected, showHint }: Props) {
  const teamContext = useAppState((s) => s.teamContext)
  const totalTeammates = teamContext
    ? Object.values(
        (teamContext as unknown as { teammates: Record<string, { name: string }> }).teammates,
      ).filter((t) => t.name !== 'team-lead').length
    : 0
  if (totalTeammates === 0) {
    return null
  }
  const hint =
    showHint && teamsSelected ? (
      <>
        <Text dimColor={true}>· </Text>
        <Text dimColor={true}>Enter to view</Text>
      </>
    ) : null
  const statusText = `${totalTeammates} ${totalTeammates === 1 ? 'teammate' : 'teammates'}`
  return (
    <>
      {
        <Text
          key={teamsSelected ? 'selected' : 'normal'}
          color="background"
          inverse={teamsSelected}
        >
          {statusText}
        </Text>
      }
      {hint ? <Text> {hint}</Text> : null}
    </>
  )
}
