import type { Command } from './types.js'
import { isUltrareviewEnabled } from './review/ultrareviewEnabled.js'

// Legal wants the explicit surface name plus a docs link visible before the
// user triggers, so the description carries "ZY Code on the web" + URL.
const CCR_TERMS_URL = 'https://code.zy.com/docs/en/zy-code-on-the-web'

// /ultrareview is the ONLY entry point to the remote bughunter path —
// /review stays purely local. local-jsx type renders the overage permission
// dialog when free reviews are exhausted.
const ultrareview: Command = {
  type: 'local-jsx',
  name: 'ultrareview',
  description: `~10–20 min · Finds and verifies bugs in your branch. Runs in ZY Code on the web. See ${CCR_TERMS_URL}`,
  isEnabled: () => isUltrareviewEnabled(),
  load: () => import('./review/UltrareviewCommand.js'),
}

export { ultrareview }
