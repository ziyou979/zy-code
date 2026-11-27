import type { LocalCommandResult } from '../types.js'
import { tSync } from '../../i18n/index.js'
import { openBrowser } from '../../services/browser/browser.js'

export async function call(): Promise<LocalCommandResult> {
  const url = 'https://www.stickermule.com/zycode'
  const success = await openBrowser(url)

  if (success) {
    return { type: 'text', value: tSync('commands.out.stickers.opening') }
  } else {
    return {
      type: 'text',
      value: tSync('commands.out.browserFailedVisitAlt', { url }),
    }
  }
}
