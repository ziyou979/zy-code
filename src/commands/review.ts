import type { Command } from './types.js'
import { isUltrareviewEnabled } from './review/ultrareviewEnabled.js'

// Legal wants the explicit surface name plus a docs link visible before the
// user triggers, so the description carries "ZY Code on the web" + URL.
const CCR_TERMS_URL = 'https://code.zy.com/docs/en/zy-code-on-the-web'

// /ultrareview is the ONLY entry point to the remote bughunter path —
// /review stays purely local. local-jsx type renders the overage permission
// dialog when free reviews are exhausted.
// 描述句式对齐 CC 的 ultrareview（价格位保留 ZY 的预计耗时）。
const ultrareview: Command = {
  type: 'local-jsx',
  name: 'ultrareview',
  description: `Start a cloud agent that finds and verifies bugs in your branch (~10–20 min) · Runs in ZY Code on the web. See ${CCR_TERMS_URL}`,
  isEnabled: () => isUltrareviewEnabled(),
  load: () => import('./review/UltrareviewCommand.js'),
}

export { ultrareview }
