import * as React from 'react'
import { StatsInner, type StatsResult } from '../Stats.js'

export { createAllTimeStatsPromise } from '../Stats.js'

type Props = {
  allTimeStatsPromise?: Promise<StatsResult>
}

export function StatsTab({ allTimeStatsPromise }: Props) {
  return <StatsInner allTimeStatsPromise={allTimeStatsPromise} />
}
