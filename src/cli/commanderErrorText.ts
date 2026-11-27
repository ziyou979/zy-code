/**
 * commander 参数解析报错的本地化。
 *
 * commander 在 parseAsync 里、preAction（settings 加载、语言推送）之前就报错并退出，
 * 所以此时 i18n 还是默认英文。这里在输出报错的那一刻按需读取一次 settings 里的
 * language，再把 commander 的固定英文句式映射成当前语言；选项名、取值、可选列表等
 * 原样保留。认不出的句式原样输出（宁可英文也不误译）。
 */
import { tSync } from '../i18n/index.js'
import { getLanguage } from '../i18n/languageStore.js'
import { getSettingsWithErrors } from '../services/settings/settings.js'

type Rule = { re: RegExp; key: string; vars: string[] }

// 与 commander 13 lib/command.js 的报错模板逐一对应（只匹配首行，"Did you mean" 另行处理）。
const RULES: Rule[] = [
  { re: /^error: unknown option '(.+)'$/, key: 'cli.commander.unknownOption', vars: ['flag'] },
  { re: /^error: unknown command '(.+)'$/, key: 'cli.commander.unknownCommand', vars: ['name'] },
  {
    re: /^error: option '(.+)' argument missing$/,
    key: 'cli.commander.optionMissingArgument',
    vars: ['flags'],
  },
  {
    re: /^error: option '(.+?)' argument '(.*)' is invalid\. Allowed choices are (.+)\.$/,
    key: 'cli.commander.invalidChoice',
    vars: ['flags', 'value', 'choices'],
  },
  {
    re: /^error: option '(.+?)' argument '(.*)' is invalid\.(?: (.*))?$/,
    key: 'cli.commander.invalidArgument',
    vars: ['flags', 'value', 'detail'],
  },
  {
    re: /^error: missing required argument '(.+)'$/,
    key: 'cli.commander.missingArgument',
    vars: ['name'],
  },
  {
    re: /^error: required option '(.+)' not specified$/,
    key: 'cli.commander.missingMandatoryOption',
    vars: ['flags'],
  },
  {
    re: /^error: too many arguments(?: for '(.+)')?\. Expected (\d+) arguments? but got (\d+)\.$/,
    key: 'cli.commander.tooManyArguments',
    vars: ['command', 'expected', 'received'],
  },
  {
    re: /^error: (.+) cannot be used with (.+)$/,
    key: 'cli.commander.conflictingOption',
    vars: ['option', 'conflicting'],
  },
]

const DID_YOU_MEAN = /^\(Did you mean (.+)\?\)$/

let languageLoaded = false

/** 参数解析阶段 settings 还没加载：按需读一次，把 language 推进 i18n。失败就保持英文。 */
function ensureLanguageFromSettings(): void {
  // 已经是非默认语言说明 settings 已推送过（或被显式设置），不再读盘覆盖
  if (languageLoaded || getLanguage() !== 'en') {
    return
  }
  languageLoaded = true
  try {
    getSettingsWithErrors()
  } catch {
    // settings 读不了时不影响报错本身
  }
}

/** 把 commander 的一段报错输出（可能多行、带结尾换行）翻译为当前界面语言。 */
export function localizeCommanderError(text: string): string {
  ensureLanguageFromSettings()
  if (getLanguage() === 'en') {
    return text
  }
  return text
    .split('\n')
    .map((line) => {
      for (const rule of RULES) {
        const m = rule.re.exec(line)
        if (m) {
          const vars: Record<string, string> = {}
          rule.vars.forEach((name, i) => {
            vars[name] = m[i + 1] ?? ''
          })
          const key =
            rule.key === 'cli.commander.tooManyArguments' && vars.command
              ? `${rule.key}For`
              : rule.key
          return tSync(key, vars)
        }
      }
      const dym = DID_YOU_MEAN.exec(line)
      if (dym) {
        return tSync('cli.commander.didYouMean', { suggestion: dym[1]! })
      }
      return line
    })
    .join('\n')
}
