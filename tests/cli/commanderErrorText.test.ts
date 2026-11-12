/**
 * commander 参数解析报错本地化：中文界面下翻译固定句式，保留选项名与取值；英文界面原样。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { warmI18n } from '../../src/i18n/index.js'
import { getLanguage, setLanguage } from '../../src/i18n/languageStore.js'
import { localizeCommanderError } from '../../src/cli/commanderErrorText.js'

const originalLanguage = getLanguage() === 'en' ? undefined : getLanguage()

afterEach(async () => {
  setLanguage(originalLanguage)
  await warmI18n()
})

async function zh() {
  setLanguage('zh-CN')
  await warmI18n()
}

describe('localizeCommanderError', () => {
  test('英文界面原样输出', () => {
    setLanguage(undefined)
    const s = "error: unknown option '--modle'\n(Did you mean --model?)\n"
    expect(localizeCommanderError(s)).toBe(s)
  })

  test('中文界面：未知选项 + 建议，保留结尾换行', async () => {
    await zh()
    expect(
      localizeCommanderError("error: unknown option '--modle'\n(Did you mean --model?)\n"),
    ).toBe("错误：未知选项 '--modle'\n（你是不是想用 --model？）\n")
  })

  test('中文界面：缺参数值、非法枚举值、自定义校验信息', async () => {
    await zh()
    expect(localizeCommanderError("error: option '--model <model>' argument missing\n")).toBe(
      "错误：选项 '--model <model>' 缺少参数值\n",
    )
    expect(
      localizeCommanderError(
        "error: option '--output-format <format>' argument 'nope' is invalid. Allowed choices are text, json, stream-json.\n",
      ),
    ).toBe(
      "错误：选项 '--output-format <format>' 的值 'nope' 无效。可选值：text, json, stream-json。\n",
    )
    expect(
      localizeCommanderError(
        "error: option '--max-turns <n>' argument 'x' is invalid. Not a number\n",
      ),
    ).toBe("错误：选项 '--max-turns <n>' 的值 'x' 无效。Not a number\n")
  })

  test('中文界面：认不出的句式原样输出', async () => {
    await zh()
    expect(localizeCommanderError('something else entirely\n')).toBe('something else entirely\n')
  })
})
