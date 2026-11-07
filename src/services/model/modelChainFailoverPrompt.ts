// confirm 模式询问用户：仅显式选 switch 为同意；子 agent/无 UI/中止/取消/异常均拒绝
import { tSync } from '../../i18n/index.js'
import type { ToolUseContext } from '../../tools/tool.js'
import { renderModelName, type ResolvedModelReference as Ref } from './model.js'
import type { ModelChainFailoverReason } from './modelChainState.js'

type Ctx = Pick<ToolUseContext, 'agentId' | 'abortController' | 'requestModelFailoverPrompt'> & {
  options: Pick<ToolUseContext['options'], 'isNonInteractiveSession'>
}

const label = (r: Ref) => {
  const connection = r.authProfile ?? r.provider
  return connection ? `${renderModelName(r.model)} (${connection})` : renderModelName(r.model)
}

export async function confirmAuthFailover(
  ctx: Ctx,
  p: { from: Ref; next: Ref; reason: ModelChainFailoverReason },
): Promise<boolean> {
  const ask = ctx.requestModelFailoverPrompt
  const signal = ctx.abortController.signal
  if (ctx.agentId || ctx.options.isNonInteractiveSession || !ask || signal.aborted) {
    return false
  }
  const message = tSync('modelFailover.confirm', {
    from: label(p.from),
    to: renderModelName(p.next.model),
    provider: p.next.authProfile ?? p.next.provider ?? '',
    reason: tSync(`modelFailover.reason.${p.reason}`),
  })
  const options = [
    { key: 'switch', label: tSync('modelFailover.confirmSwitch') },
    { key: 'stay', label: tSync('modelFailover.confirmStay') },
  ]
  let onAbort = () => {}
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  // 同步抛错/reject 均为 false；中止先到也不留未处理 rejection
  const answer = Promise.resolve()
    .then(() =>
      signal.aborted
        ? undefined
        : ask(tSync('modelFailover.confirmTitle'))({ prompt: 'failover', message, options }),
    )
    .then(
      (r) => !signal.aborted && r?.selected === 'switch',
      () => false,
    )
  try {
    return await Promise.race([answer, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
