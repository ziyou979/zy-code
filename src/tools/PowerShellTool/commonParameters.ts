/**
 * PowerShell Common Parameters（所有 cmdlet 都可通过 [CmdletBinding()] 使用）。
 * 来源：about_CommonParameters（PowerShell 文档）和 Get-Command 输出。
 *
 * 由 pathValidation.ts（合并到各 cmdlet 的已知参数集）和 readOnlyValidation.ts
 *（合并到 safeFlags 检查）共用。拆出此文件以消除两者之间原本会形成的循环导入。
 *
 * 以带前导短横线的小写形式存储；调用方会对输入执行 `.toLowerCase()`。
 */

export const COMMON_SWITCHES = ['-verbose', '-debug']

export const COMMON_VALUE_PARAMS = [
  '-erroraction',
  '-warningaction',
  '-informationaction',
  '-progressaction',
  '-errorvariable',
  '-warningvariable',
  '-informationvariable',
  '-outvariable',
  '-outbuffer',
  '-pipelinevariable',
]

export const COMMON_PARAMETERS: ReadonlySet<string> = new Set([
  ...COMMON_SWITCHES,
  ...COMMON_VALUE_PARAMS,
])
