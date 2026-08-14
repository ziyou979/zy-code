import {
  clearBetaHeaderLatches,
  clearSystemPromptSectionState,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
} from 'src/bootstrap/runtime/runtimeContext.js'

type ComputeFn = () => string | null | Promise<string | null>

type SystemPromptSection = {
  name: string
  compute: ComputeFn
  cacheBreak: boolean
}

/**
 * 创建记忆化的 system prompt 区段。
 * 仅计算一次，并缓存至执行 /clear 或 /compact。
 */
export function systemPromptSection(name: string, compute: ComputeFn): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

/**
 * 创建每轮重新计算的易变 system prompt 区段。
 * 值发生变化时一定会使 prompt cache 失效，因此必须说明打破缓存的必要性。
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}

/**
 * 解析全部 system prompt 区段并返回 prompt 字符串。
 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async (s) => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}

/**
 * 清除全部 system prompt 区段状态，由 /clear 和 /compact 调用。
 * 同时重置 beta header 锁存状态，使新会话重新评估 AFK/cache-editing header。
 */
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
}
