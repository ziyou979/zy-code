import * as React from 'react'
import { Box } from '../../ink/index.js'
import { Divider } from '../design-system/Divider.js'
import type { FeedConfig } from './Feed.js'
import { calculateFeedWidth, Feed } from './Feed.js'

type FeedColumnProps = {
  feeds: FeedConfig[]
  maxWidth: number
}
export function FeedColumn({ feeds, maxWidth }: FeedColumnProps) {
  const feedWidths = feeds.map((feed) => calculateFeedWidth(feed))
  const maxOfAllFeeds = Math.max(...feedWidths)
  const actualWidth = Math.min(maxOfAllFeeds, maxWidth)
  const feedElements = feeds.map((feed_0, index) => (
    <React.Fragment key={index}>
      <Feed config={feed_0} actualWidth={actualWidth} />
      {index < feeds.length - 1 && <Divider color="zy" width={actualWidth} />}
    </React.Fragment>
  ))
  return <Box flexDirection="column">{feedElements}</Box>
}
