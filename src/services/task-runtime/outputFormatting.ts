import { validateBoundedIntEnvVar } from '../environment/envValidation.js'
import { getTaskOutputPath } from './diskOutput.js'

export const TASK_MAX_OUTPUT_UPPER_LIMIT = 160_000
export const TASK_MAX_OUTPUT_DEFAULT = 32_000

export function getMaxTaskOutputLength(): number {
  const result = validateBoundedIntEnvVar(
    'TASK_MAX_OUTPUT_LENGTH',
    process.env.TASK_MAX_OUTPUT_LENGTH,
    TASK_MAX_OUTPUT_DEFAULT,
    TASK_MAX_OUTPUT_UPPER_LIMIT,
  )
  return result.effective
}

/**
 * 格式化任务输出供 API 使用，并在过大时截断。
 * 截断后包含带文件路径的标头，并返回限制范围内容得下的末尾 N 个字符。
 */
export function formatTaskOutput(
  output: string,
  taskId: string,
): { content: string; wasTruncated: boolean } {
  const maxLen = getMaxTaskOutputLength()

  if (output.length <= maxLen) {
    return { content: output, wasTruncated: false }
  }

  const filePath = getTaskOutputPath(taskId)
  const header = `[Truncated. Full output: ${filePath}]\n\n`
  const availableSpace = maxLen - header.length
  const truncated = output.slice(-availableSpace)

  return { content: header + truncated, wasTruncated: true }
}
