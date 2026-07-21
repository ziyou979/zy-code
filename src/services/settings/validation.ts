import type { ConfigScope } from 'src/services/mcp/types.js'
import type { ZodError, ZodIssue } from 'zod/v4'
import { jsonParse } from '../../services/infra/slowOperations.js'
import { plural } from '../../utils/stringUtils.js'
import { validatePermissionRule } from './permissionValidation.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'
import type { SettingsJson } from './types.js'
import { SettingsSchema } from './types.js'
import { getValidationTip } from './validationTips.js'

/**
 * 针对特定 Zod v4 issue 类型的辅助类型守卫
 * 在 v4 中，issue 类型的结构与 v3 不同
 */
function isInvalidTypeIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'invalid_type'
  expected: string
  input: unknown
} {
  return issue.code === 'invalid_type'
}

function isInvalidValueIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'invalid_value'
  values: unknown[]
  input: unknown
} {
  return issue.code === 'invalid_value'
}

function isUnrecognizedKeysIssue(
  issue: ZodIssue,
): issue is ZodIssue & { code: 'unrecognized_keys'; keys: string[] } {
  return issue.code === 'unrecognized_keys'
}

function isTooSmallIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'too_small'
  minimum: number | bigint
  origin: string
} {
  return issue.code === 'too_small'
}

/** 点号分隔的字段路径（如 "permissions.defaultMode"、"env.DEBUG"） */
export type FieldPath = string

export type ValidationError = {
  /** 相对文件路径 */
  file?: string
  /** 点号分隔的字段路径 */
  path: FieldPath
  /** 人类可读的错误消息 */
  message: string
  /** 期望的值或类型 */
  expected?: string
  /** 实际提供的无效值 */
  invalidValue?: unknown
  /** 修复错误的建议 */
  suggestion?: string
  /** 相关文档的链接 */
  docLink?: string
  /** MCP 特定的元数据 - 仅在 MCP 配置错误时存在 */
  mcpErrorMetadata?: {
    /** 此错误来自哪个配置范围 */
    scope: ConfigScope
    /** 如果错误针对特定服务器，则为服务器名称 */
    serverName?: string
    /** 错误的严重程度 */
    severity?: 'fatal' | 'warning'
  }
}

export type SettingsWithErrors = {
  settings: SettingsJson
  errors: ValidationError[]
}

/**
 * 将 Zod 验证错误格式化为人类可读的验证错误
 */
/**
 * 获取未知值的类型字符串（用于错误消息）
 */
function getReceivedType(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (value === undefined) {
    return 'undefined'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  return typeof value
}

function extractReceivedFromMessage(msg: string): string | undefined {
  const match = msg.match(/received (\w+)/)
  return match ? match[1] : undefined
}

export function formatZodError(error: ZodError, filePath: string): ValidationError[] {
  return error.issues.map((issue): ValidationError => {
    const path = issue.path.map(String).join('.')
    let message = issue.message
    let expected: string | undefined

    let enumValues: string[] | undefined
    let expectedValue: string | undefined
    let receivedValue: unknown
    let invalidValue: unknown

    if (isInvalidValueIssue(issue)) {
      enumValues = issue.values.map((v) => String(v))
      expectedValue = enumValues.join(' | ')
      receivedValue = undefined
      invalidValue = undefined
    } else if (isInvalidTypeIssue(issue)) {
      expectedValue = issue.expected
      const receivedType = extractReceivedFromMessage(issue.message)
      receivedValue = receivedType ?? getReceivedType(issue.input)
      invalidValue = receivedType ?? getReceivedType(issue.input)
    } else if (isTooSmallIssue(issue)) {
      expectedValue = String(issue.minimum)
    } else if (issue.code === 'custom' && 'params' in issue) {
      const params = issue.params as { received?: unknown }
      receivedValue = params.received
      invalidValue = receivedValue
    }

    const tip = getValidationTip({
      path,
      code: issue.code,
      expected: expectedValue,
      received: receivedValue,
      enumValues,
      message: issue.message,
      value: receivedValue,
    })

    if (isInvalidValueIssue(issue)) {
      expected = enumValues?.map((v) => `"${v}"`).join(', ')
      message = `Invalid value. Expected one of: ${expected}`
    } else if (isInvalidTypeIssue(issue)) {
      const receivedType = extractReceivedFromMessage(issue.message) ?? getReceivedType(issue.input)
      if (issue.expected === 'object' && receivedType === 'null' && path === '') {
        message = 'Invalid or malformed JSON'
      } else {
        message = `Expected ${issue.expected}, but received ${receivedType}`
      }
    } else if (isUnrecognizedKeysIssue(issue)) {
      const keys = issue.keys.join(', ')
      message = `Unrecognized ${plural(issue.keys.length, 'field')}: ${keys}`
    } else if (isTooSmallIssue(issue)) {
      message = `Number must be greater than or equal to ${issue.minimum}`
      expected = String(issue.minimum)
    }

    return {
      file: filePath,
      path,
      message,
      expected,
      invalidValue,
      suggestion: tip?.suggestion,
      docLink: tip?.docLink,
    }
  })
}

/**
 * 验证配置文件内容是否符合 SettingsSchema。
 * 在文件编辑期间使用，以确保生成的文件有效。
 */
export function validateSettingsFileContent(content: string):
  | {
      isValid: true
    }
  | {
      isValid: false
      error: string
      fullSchema: string
    } {
  try {
    // 首先解析 JSON
    const jsonData = jsonParse(content)

    // 在严格模式下针对 SettingsSchema 进行验证
    const result = SettingsSchema().strict().safeParse(jsonData)

    if (result.success) {
      return { isValid: true }
    }

    // 以有用的方式格式化验证错误
    const errors = formatZodError(result.error, 'settings')
    const errorMessage =
      'Settings validation failed:\n' +
      errors.map((err) => `- ${err.path}: ${err.message}`).join('\n')

    return {
      isValid: false,
      error: errorMessage,
      fullSchema: generateSettingsJSONSchema(),
    }
  } catch (parseError) {
    return {
      isValid: false,
      error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : 'Unknown parsing error'}`,
      fullSchema: generateSettingsJSONSchema(),
    }
  }
}

/**
 * 在 schema 验证之前从原始解析的 JSON 数据中过滤无效的权限规则。
 * 这可以防止一条错误规则导致整个配置文件被拒绝。
 * 为每条被过滤的规则返回警告。
 */
export function filterInvalidPermissionRules(data: unknown, filePath: string): ValidationError[] {
  if (!data || typeof data !== 'object') {
    return []
  }
  const obj = data as Record<string, unknown>
  if (!obj.permissions || typeof obj.permissions !== 'object') {
    return []
  }
  const perms = obj.permissions as Record<string, unknown>

  const warnings: ValidationError[] = []
  for (const key of ['allow', 'deny', 'ask']) {
    const rules = perms[key]
    if (!Array.isArray(rules)) {
      continue
    }

    perms[key] = rules.filter((rule) => {
      if (typeof rule !== 'string') {
        warnings.push({
          file: filePath,
          path: `permissions.${key}`,
          message: `Non-string value in ${key} array was removed`,
          invalidValue: rule,
        })
        return false
      }
      const result = validatePermissionRule(rule)
      if (!result.valid) {
        let message = `Invalid permission rule "${rule}" was skipped`
        if (result.error) {
          message += `: ${result.error}`
        }
        if (result.suggestion) {
          message += `. ${result.suggestion}`
        }
        warnings.push({
          file: filePath,
          path: `permissions.${key}`,
          message,
          invalidValue: rule,
        })
        return false
      }
      return true
    })
  }
  return warnings
}
