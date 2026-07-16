import { formatTotalCost } from '../../services/cost/cost-tracker.js'
import type { LocalCommandCall } from '../types.js'

export const call: LocalCommandCall = async () => {
  return { type: 'text', value: formatTotalCost() }
}
