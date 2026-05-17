import type { LocalCommandCall } from '../../types/command.js'
import { tSync } from '../../i18n/index.js'

/**
 * 功能引导项定义
 */
interface PowerupEntry {
  key: string
  title: string
  description: string
  examples: string[]
}

/**
 * 内置功能引导列表
 */
function getPowerups(): PowerupEntry[] {
  return [
    {
      key: 'grep',
      title: tSync('powerup.grep.title'),
      description: tSync('powerup.grep.description'),
      examples: [
        'Find all usages of UserService and replace deprecated methods',
        'Search for TODO comments across the codebase and fix them',
      ],
    },
    {
      key: 'refactor',
      title: tSync('powerup.refactor.title'),
      description: tSync('powerup.refactor.description'),
      examples: [
        'Extract the validation logic in handleSubmit into a separate function',
        'Convert this class component to a functional component with hooks',
      ],
    },
    {
      key: 'test',
      title: tSync('powerup.test.title'),
      description: tSync('powerup.test.description'),
      examples: [
        'Write unit tests for the PaymentService class',
        'Add edge case tests for the date parsing utility',
      ],
    },
    {
      key: 'debug',
      title: tSync('powerup.debug.title'),
      description: tSync('powerup.debug.description'),
      examples: [
        'This function returns null when it should return an empty array — fix it',
        'The API returns 500 when userId is undefined — find and fix the bug',
      ],
    },
    {
      key: 'docs',
      title: tSync('powerup.docs.title'),
      description: tSync('powerup.docs.description'),
      examples: [
        'Add JSDoc comments to all exported functions in utils/',
        'Generate a README for this project based on the codebase',
      ],
    },
  ]
}

/**
 * 格式化单个功能引导项的详细展示
 */
function formatPowerupDetail(entry: PowerupEntry): string {
  const lines = [
    `### ${entry.title}`,
    '',
    entry.description,
    '',
    `**${tSync('powerup.examplesLabel')}:**`,
    ...entry.examples.map((example) => `- \`${example}\``),
  ]
  return lines.join('\n')
}

/**
 * 格式化功能列表菜单
 */
function formatPowerupMenu(powerups: PowerupEntry[]): string {
  const header = tSync('powerup.menuHeader')
  const items = powerups.map(
    (entry, index) => `  ${index + 1}. **${entry.title}** — ${entry.description}`,
  )
  const footer = tSync('powerup.menuFooter')
  return [header, '', ...items, '', footer].join('\n')
}

export const call: LocalCommandCall = async (args) => {
  const powerups = getPowerups()
  const trimmedArgs = args.trim().toLowerCase()

  if (!trimmedArgs) {
    return { type: 'text', value: formatPowerupMenu(powerups) }
  }

  // 支持按编号或关键词匹配
  const index = parseInt(trimmedArgs, 10)
  const matched = !isNaN(index) && index >= 1 && index <= powerups.length
    ? powerups[index - 1]
    : powerups.find(
        (entry) =>
          entry.key === trimmedArgs ||
          entry.title.toLowerCase().includes(trimmedArgs),
      )

  if (!matched) {
    return {
      type: 'text',
      value: tSync('powerup.notFound', { query: trimmedArgs }),
    }
  }

  return { type: 'text', value: formatPowerupDetail(matched) }
}
