import * as React from 'react'
import { type StatsResult, StatsInner } from '../Stats.js'

export { createAllTimeStatsPromise } from '../Stats.js'

type Props = {
  allTimeStatsPromise?: Promise<StatsResult>
}

export function StatsTab({ allTimeStatsPromise }: Props) {
  return <StatsInner allTimeStatsPromise={allTimeStatsPromise} />
}
