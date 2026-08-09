import { describe, expect, test } from 'bun:test'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../../src/shell-eval/powershell/parser.js'
import type { ToolPermissionContext } from '../../../src/tools/tool.js'
import { checkPathConstraints } from '../../../src/tools/PowerShellTool/pathValidation.js'

function createContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
}

function command(name: string, path: string): ParsedCommandElement {
  return {
    name,
    nameType: 'cmdlet',
    elementType: 'CommandAst',
    args: [path],
    text: `${name} ${path}`,
    elementTypes: ['StringConstant', 'StringConstant'],
  }
}

function parsed(commandElement: ParsedCommandElement): ParsedPowerShellCommand {
  return {
    valid: true,
    errors: [],
    variables: [],
    hasStopParsing: false,
    originalCommand: commandElement.text,
    statements: [
      {
        statementType: 'PipelineAst',
        commands: [commandElement],
        redirections: [],
        text: commandElement.text,
      },
    ],
  }
}

describe('PowerShellTool compound cd path validation', () => {
  test('读操作在复合命令包含 cd 时要求人工审批', () => {
    const input = { command: 'Set-Location .; Get-Content package.json' }
    const result = checkPathConstraints(
      input,
      parsed(command('Get-Content', 'package.json')),
      createContext(),
      true,
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('other')
    if (result.decisionReason?.type === 'other') {
      expect(result.decisionReason.reason).toMatch(/powershellCdPathReason|path operation|路径操作/)
    }
  })

  test('写操作在复合命令包含 cd 时要求人工审批', () => {
    const input = { command: 'Set-Location .; Set-Content alignment.tmp value' }
    const result = checkPathConstraints(
      input,
      parsed(command('Set-Content', 'alignment.tmp')),
      createContext(),
      true,
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('other')
    if (result.decisionReason?.type === 'other') {
      expect(result.decisionReason.reason).toMatch(/powershellCdPathReason|path operation|路径操作/)
    }
  })

  test('输出重定向在复合命令包含 cd 时要求人工审批', () => {
    const commandElement = command('Write-Output', 'value')
    const parsedCommand = parsed(commandElement)
    parsedCommand.statements[0]!.redirections = [
      {
        operator: '>',
        target: 'alignment.tmp',
        isMerging: false,
      },
    ]
    const result = checkPathConstraints(
      { command: 'Set-Location .; Write-Output value > alignment.tmp' },
      parsedCommand,
      createContext(),
      true,
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('other')
    if (result.decisionReason?.type === 'other') {
      expect(result.decisionReason.reason).toMatch(
        /powershellCdRedirectReason|output redirection|输出重定向/,
      )
    }
  })
})
