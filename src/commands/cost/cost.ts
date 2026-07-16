import { formatTotalCost } from '../../services/cost/costTracker.js'
import type { LocalCommandCall } from '../types.js'

export const call: LocalCommandCall = async () => {
  return { type: 'text', value: formatTotalCost() }
}
