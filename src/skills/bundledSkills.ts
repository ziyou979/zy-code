import { constants as fsConstants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep as pathSep } from 'node:path'
import type { ToolUseContext } from '../tools/tool.js'
import type { Command } from '../commands/types.js'
import type { ContentBlock } from '../types/llm.js'
import { logForDebugging } from '../services/infra/debug.js'
import { getBundledSkillsRoot } from '../services/permissions/scratchpadStorage.js'
import type { HooksSettings } from '../services/settings/types.js'

/**
 * 随 CLI 分发的内置 skill 定义，在启动时以编程方式注册。
 */
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  /** 命令执行时的进度提示文案（如 "reviewing pull request"）；缺省 'running'。 */
  progressMessage?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  /**
   * 首次调用时需要提取到磁盘的附加参考文件。键为使用正斜杠且不含 `..` 的相对路径，
   * 值为文件内容。设置后会在 skill prompt 前添加“Base directory for this skill:
   * <dir>”一行，使模型可按需 Read/Grep 这些文件，契约与磁盘 skill 相同。
   */
  files?: Record<string, string>
  getPromptForCommand: (args: string, context: ToolUseContext) => Promise<ContentBlock[]>
}

// 内置 skill 的内部 registry
const bundledSkills: Command[] = []

/**
 * 注册模型可用的内置 skill；应在模块初始化或 init 函数中调用。
 *
 * 内置 skill 会编译进 CLI 二进制并对所有用户可用。
 * 内部 feature 沿用 registerPostSamplingHook() 的相同模式。
 */
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const { files } = definition

  let skillRoot: string | undefined
  let getPromptForCommand = definition.getPromptForCommand

  if (files && Object.keys(files).length > 0) {
    skillRoot = getBundledSkillExtractDir(definition.name)
    // 闭包内 memoize：每个进程只提取一次。缓存 promise 而非结果，使并发调用方
    // 等待同一次提取，避免竞态写入不同副本。
    let extractionPromise: Promise<string | null> | undefined
    const inner = definition.getPromptForCommand
    getPromptForCommand = async (args, ctx) => {
      extractionPromise ??= extractBundledSkillFiles(definition.name, files)
      const extractedDir = await extractionPromise
      const blocks = await inner(args, ctx)
      if (extractedDir === null) {
        return blocks
      }
      return prependBaseDir(blocks, extractedDir)
    }
  }

  const command: Command = {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    aliases: definition.aliases,
    hasUserSpecifiedDescription: true,
    allowedTools: definition.allowedTools ?? [],
    argumentHint: definition.argumentHint,
    whenToUse: definition.whenToUse,
    model: definition.model,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    contentLength: 0, // Not applicable for bundled skills
    source: 'bundled',
    loadedFrom: 'bundled',
    hooks: definition.hooks,
    skillRoot,
    context: definition.context,
    agent: definition.agent,
    isEnabled: definition.isEnabled,
    isHidden: !(definition.userInvocable ?? true),
    progressMessage: definition.progressMessage ?? 'running',
    getPromptForCommand,
  }
  bundledSkills.push(command)
}

/**
 * 获取全部已注册的内置 skill；返回副本以防外部修改。
 */
export function getBundledSkills(): Command[] {
  return [...bundledSkills]
}

/**
 * 清空内置 skill registry，供测试使用。
 */
export function clearBundledSkills(): void {
  bundledSkills.length = 0
}

/**
 * 内置 skill 参考文件使用的确定性提取目录。
 */
export function getBundledSkillExtractDir(skillName: string): string {
  return join(getBundledSkillsRoot(), skillName)
}

/**
 * 将内置 skill 的参考文件提取到磁盘，使模型可按需 Read/Grep；首次调用 skill 时延迟执行。
 *
 * 返回写入目录；写入失败时返回 null。skill 仍可工作，只是不添加 base-directory 前缀。
 */
async function extractBundledSkillFiles(
  skillName: string,
  files: Record<string, string>,
): Promise<string | null> {
  const dir = getBundledSkillExtractDir(skillName)
  try {
    await writeSkillFiles(dir, files)
    return dir
  } catch (e) {
    logForDebugging(
      `Failed to extract bundled skill '${skillName}' to ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
}

async function writeSkillFiles(dir: string, files: Record<string, string>): Promise<void> {
  // 按父目录分组，使每个子树只需 mkdir 一次，再写入文件
  const byParent = new Map<string, [string, string][]>()
  for (const [relPath, content] of Object.entries(files)) {
    const target = resolveSkillFilePath(dir, relPath)
    const parent = dirname(target)
    const entry: [string, string] = [target, content]
    const group = byParent.get(parent)
    if (group) {
      group.push(entry)
    } else {
      byParent.set(parent, [entry])
    }
  }
  await Promise.all(
    [...byParent].map(async ([parent, entries]) => {
      await mkdir(parent, { recursive: true, mode: 0o700 })
      await Promise.all(entries.map(([p, c]) => safeWriteFile(p, c)))
    }),
  )
}

// getBundledSkillsRoot() 的每进程 nonce 是防御预创建 symlink/目录的主要措施。
// 显式使用 0o700/0o600，使 nonce 子树即使在 umask=0 时也仅 owner 可访问；攻击者即使
// 通过监听可预测父目录的 inotify 得知 nonce，仍无法写入。O_NOFOLLOW|O_EXCL 是额外
// 保险（O_NOFOLLOW 只保护最后一个组件）；遇到 EEXIST 时有意不执行 unlink 后重试，
// 因为 unlink() 同样会跟随中间 symlink。
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
// Windows 使用字符串 flag；数字 O_EXCL 经 libuv 可能产生 EINVAL。
const SAFE_WRITE_FLAGS =
  process.platform === 'win32'
    ? 'wx'
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW

async function safeWriteFile(p: string, content: string): Promise<void> {
  const fh = await open(p, SAFE_WRITE_FLAGS, 0o600)
  try {
    await fh.writeFile(content, 'utf8')
  } finally {
    await fh.close()
  }
}

/** 归一化并校验 skill 相对路径，检测到遍历时抛错。 */
function resolveSkillFilePath(baseDir: string, relPath: string): string {
  const normalized = normalize(relPath)
  if (
    isAbsolute(normalized) ||
    normalized.split(pathSep).includes('..') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`bundled skill file path escapes skill dir: ${relPath}`)
  }
  return join(baseDir, normalized)
}

function prependBaseDir(blocks: ContentBlock[], baseDir: string): ContentBlock[] {
  const prefix = `Base directory for this skill: ${baseDir}\n\n`
  if (blocks.length > 0 && blocks[0]!.type === 'text') {
    return [{ type: 'text', text: prefix + blocks[0]!.text }, ...blocks.slice(1)]
  }
  return [{ type: 'text', text: prefix }, ...blocks]
}
