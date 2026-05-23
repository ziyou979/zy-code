import type { Option } from '@commander-js/extra-typings'

/**
 * Commander 帮助文本配置：按长选项名排序选项 / 子命令。
 *
 * Commander 支持运行时 compareOptions，但 @commander-js/extra-typings
 * 的类型定义中不包含它，所以用 Object.assign 添加。
 */
export function createSortedHelpConfig(): {
  sortSubcommands: true
  sortOptions: true
} {
  const getOptionSortKey = (opt: Option): string =>
    opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? ''
  return Object.assign(
    {
      sortSubcommands: true,
      sortOptions: true,
    } as const,
    {
      compareOptions: (a: Option, b: Option) =>
        getOptionSortKey(a).localeCompare(getOptionSortKey(b)),
    },
  )
}
