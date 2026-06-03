/**
 * Hook 输出超阈值落盘。
 *
 * 一个写错的 hook（例如 `cat 大日志`）会把巨量 stdout/additionalContext 直接灌进
 * 模型上下文，瞬间触发 reactive compaction 甚至 OOM。超过阈值时改为写盘并在上下文里
 * 只留「大小 + 路径 + 前缀预览」三段式提示。对齐 Claude Code 2.1.89/2.1.97。
 *
 * 注入回上下文的内容是 model-facing 的，故用英文（与周边 hook 代码一致，不走 i18n）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import { createDebugLog } from '../debug.js'
import { getZyConfigHomeDir } from '../envUtils.js'

const hookLog = createDebugLog('hooks')

const DEFAULT_INLINE_LIMIT = 50_000
const PREVIEW_CHARS = 2_000

/** inline 阈值（字符数）。ZY_CODE_HOOK_OUTPUT_INLINE_LIMIT 覆盖，默认 50000；<=0 视为默认。 */
export function getHookOutputInlineLimit(): number {
  const parsed = parseInt(process.env.ZY_CODE_HOOK_OUTPUT_INLINE_LIMIT || '', 10)
  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_INLINE_LIMIT : parsed
}

/** 把 hook 名清成安全文件名片段（hookName 形如 "PreToolUse:Bash"）。 */
function sanitizeForFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'hook'
}

/**
 * 输出超过 inline 阈值时落盘，返回三段式提示；否则原样 inline 返回。
 * 落盘失败（权限/磁盘）不抛错——退化为截断预览，hook 不应因落盘失败而中断。
 */
export function maybeSpillHookOutput(
  hookName: string,
  output: string,
): { inline: string; spillPath?: string } {
  const limit = getHookOutputInlineLimit()
  if (output.length <= limit) {
    return { inline: output }
  }

  const preview = output.slice(0, PREVIEW_CHARS)
  try {
    const dir = join(getZyConfigHomeDir(), 'hook-outputs', getSessionId())
    mkdirSync(dir, { recursive: true })
    const spillPath = join(dir, `${sanitizeForFilename(hookName)}-${Date.now()}.txt`)
    writeFileSync(spillPath, output, 'utf8')
    return {
      inline:
        `Output too large (${output.length} chars). Full output saved to: ${spillPath}\n\n` +
        `Preview (first ${preview.length} chars):\n${preview}`,
      spillPath,
    }
  } catch (err) {
    hookLog(`Hooks: failed to spill oversized output to disk: ${err}`)
    return {
      inline:
        `Output too large (${output.length} chars) and could not be saved to disk.\n\n` +
        `Preview (first ${preview.length} chars):\n${preview}`,
    }
  }
}
