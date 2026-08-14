import { type SpawnOptions, type SpawnSyncOptions, spawn, spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import instances from '../ink/instances.js'
import { logForDebugging } from '../services/infra/debug.js'
import { whichSync } from '../services/shell/which.js'

function isCommandAvailable(command: string): boolean {
  return !!whichSync(command)
}

// 在独立窗口打开、可分离启动且不会与 TUI 争用 stdin 的 GUI 编辑器。
// VS Code 分支（cursor、windsurf、codium）名称中不含 'code'，因此显式列出。
const GUI_EDITORS = [
  'code',
  'cursor',
  'windsurf',
  'codium',
  'subl',
  'atom',
  'gedit',
  'notepad++',
  'notepad',
  // Windows `start /wait notepad` — `start` 是 cmd.exe 内建命令，
  // 用于启动 GUI 程序并等待其退出。basename('start') = 'start'，
  // GUI_EDITORS 中有 'start' 即可匹配。
  'start',
]

// 支持以 +N 作为跳转行参数的编辑器。Windows 默认命令（'start /wait notepad'）
// 不支持，notepad 会把 +42 当成文件名。
const PLUS_N_EDITORS = /\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/

// VS Code 及其分支使用 -g file:line，subl 直接使用 file:line（不带 -g）。
const VSCODE_FAMILY = new Set(['code', 'cursor', 'windsurf', 'codium'])

/**
 * 判断编辑器是否为 GUI。返回匹配的 GUI 家族名称，以便选择跳转行 argv；
 * 终端编辑器返回 undefined。注意：这里只做分类，启动时仍使用用户实际指定的二进制，
 * 而不是此返回值，以保留 `code-insiders` 和绝对路径。
 *
 * 使用 basename，避免 /home/alice/code/bin/nvim 因目录部分而误匹配 'code'。
 * code-insiders 仍匹配 'code'，/usr/bin/code 的 basename 为 'code'，也能匹配。
 */
export function classifyGuiEditor(editor: string): string | undefined {
  const base = basename(editor.split(' ')[0] ?? '')
  return GUI_EDITORS.find((g) => base.includes(g))
}

/**
 * 构建 GUI 编辑器的跳转行 argv。VS Code 家族使用 -g file:line，subl 直接使用
 * file:line，其他编辑器不支持跳转行。
 */
function guiGotoArgv(guiFamily: string, filePath: string, line: number | undefined): string[] {
  if (!line) {
    return [filePath]
  }
  if (VSCODE_FAMILY.has(guiFamily)) {
    return ['-g', `${filePath}:${line}`]
  }
  if (guiFamily === 'subl') {
    return [`${filePath}:${line}`]
  }
  return [filePath]
}

/**
 * 在用户的外部编辑器中打开文件。
 *
 * GUI 编辑器（code、subl 等）采用分离启动：编辑器在独立窗口打开，ZY Code 保持交互。
 *
 * 终端编辑器（vim、nvim、nano 等）通过 Ink alt-screen 交接阻塞，直到编辑器退出。
 * 流程与 promptEditor.ts 的 editFileInEditor() 相同，只是不读回文件内容。
 *
 * 成功启动编辑器时返回 true，没有可用编辑器时返回 false。
 */
export function openFileInExternalEditor(filePath: string, line?: number): boolean {
  const editor = getExternalEditor()
  if (!editor) {
    return false
  }

  // 启动用户实际指定的二进制，以保留 code-insiders、绝对路径等。
  // 拆分为二进制和附加参数，使 'start /wait notepad'、'code --wait' 等多词值的
  // 所有 token 都能传给 spawn。
  const parts = editor.split(' ')
  const base = parts[0] ?? editor
  const editorArgs = parts.slice(1)
  const guiFamily = classifyGuiEditor(editor)

  if (guiFamily) {
    const gotoArgv = guiGotoArgv(guiFamily, filePath, line)
    const detachedOpts: SpawnOptions = { detached: true, stdio: 'ignore' }
    let child
    if (process.platform === 'win32') {
      // Windows 使用 shell: true，以便解析 code.cmd / cursor.cmd / windsurf.cmd；
      // CreateProcess 无法直接执行 .cmd/.bat。组装带引号的命令字符串，cmd.exe 不会在
      // 双引号内展开 $() 或反引号。每个参数都加引号，确保含空格路径经过 shell 拼接后不变。
      const gotoStr = gotoArgv.map((a) => `"${a}"`).join(' ')
      child = spawn(`${editor} ${gotoStr}`, { ...detachedOpts, shell: true })
    } else {
      // POSIX 直接使用 argv 数组而不经过 shell，可防止注入。shell: true 会在双引号内
      // 展开 $() 和反引号，而 filePath 来自文件系统，恶意仓库文件名可能造成 RCE。
      child = spawn(base, [...editorArgs, ...gotoArgv], detachedOpts)
    }
    // spawn() 会异步发出 ENOENT。$VISUAL/$EDITOR 的 ENOENT 属于用户配置错误，
    // 不是内部缺陷，不应污染错误 telemetry。
    child.on('error', (e) => logForDebugging(`editor spawn failed: ${e}`, { level: 'error' }))
    child.unref()
    return true
  }

  // 终端编辑器会接管终端，因此需要交接 alt-screen，并阻塞到编辑器退出。
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) {
    return false
  }
  // 只为明确支持的编辑器添加 +N；notepad 会把 +42 当成文件名。
  // 对 basename 做匹配，避免 /home/vim/bin/kak 因目录部分而误匹配 'vim'。
  const useGotoLine = line && PLUS_N_EDITORS.test(basename(base))
  inkInstance.enterAlternateScreen()
  try {
    const syncOpts: SpawnSyncOptions = { stdio: 'inherit' }
    let result
    if (process.platform === 'win32') {
      // Windows 使用 shell: true，以解析 `start` 等 cmd.exe 内建命令。
      // shell: true 会无引号拼接参数，因此自行组装并显式加引号，与 promptEditor.ts:74
      // 保持一致。spawnSync 通过 .error 返回错误，而不是抛出异常。
      const lineArg = useGotoLine ? `+${line} ` : ''
      result = spawnSync(`${editor} ${lineArg}"${filePath}"`, {
        ...syncOpts,
        shell: true,
      })
    } else {
      // POSIX 直接启动而不经过 shell，argv 数组无需额外转义。
      const args = [...editorArgs, ...(useGotoLine ? [`+${line}`, filePath] : [filePath])]
      result = spawnSync(base, args, syncOpts)
    }
    if (result.error) {
      logForDebugging(`editor spawn failed: ${result.error}`, {
        level: 'error',
      })
      return false
    }
    return true
  } finally {
    inkInstance.exitAlternateScreen()
  }
}

export const getExternalEditor = memoize((): string | undefined => {
  // 优先使用环境变量。
  if (process.env.VISUAL?.trim()) {
    return process.env.VISUAL.trim()
  }

  if (process.env.EDITOR?.trim()) {
    return process.env.EDITOR.trim()
  }

  // `isCommandAvailable` 会破坏 Windows 下 zy 进程的 stdin，因此暂时跳过检查。
  if (process.platform === 'win32') {
    return 'start /wait notepad'
  }

  // 按优先顺序查找可用编辑器。
  const editors = ['code', 'vi', 'nano']
  return editors.find((command) => isCommandAvailable(command))
})
