import {
  expandPastedTextRefs,
  formatPastedTextRef,
  getPastedTextRefNumLines,
} from '../services/session-storage/history.js'
import instances from '../ink/instances.js'
import type { PastedContent } from '../services/config/config.js'
import { classifyGuiEditor, getExternalEditor } from './editor.js'
import { execSync_DEPRECATED } from '../services/shell/execSyncWrapper.js'
import { getFsImplementation } from '../services/infra/fsOperations.js'
import { toIDEDisplayName } from '../services/ide/ideCatalog.js'
import { writeFileSync_DEPRECATED } from '../services/infra/slowOperations.js'
import { generateTempFilePath } from '../services/file-persistence/tempfile.js'

// editor 命令覆盖表（例如补充等待参数）
const EDITOR_OVERRIDES: Record<string, string> = {
  code: 'code -w', // VS Code: wait for file to be closed
  subl: 'subl --wait', // Sublime Text: wait for file to be closed
}

function isGuiEditor(editor: string): boolean {
  return classifyGuiEditor(editor) !== undefined
}

export type EditorResult = {
  content: string | null
  error?: string
}

// 同步 IO：由同步 context（React 组件、同步命令 handler）调用
export function editFileInEditor(filePath: string): EditorResult {
  const fs = getFsImplementation()
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) {
    throw new Error('Ink instance not found - cannot pause rendering')
  }

  const editor = getExternalEditor()
  if (!editor) {
    return { content: null }
  }

  try {
    fs.statSync(filePath)
  } catch {
    return { content: null }
  }

  // `start` 是 Windows cmd.exe 内建命令（start /wait notepad），
  // 它启动 GUI 编辑器而非占用终端。classifyGuiEditor 已在 GUI_EDITORS
  // 中匹配 'start'，此处防御性检查确保不会误入 alt-screen 路径。
  const useAlternateScreen = !isGuiEditor(editor) && !editor.startsWith('start')

  if (useAlternateScreen) {
    // 终端 editor（vi、nano 等）会接管终端。交给 Ink 感知 alt-screen 的交接逻辑，
    // 避免全屏模式（<AlternateScreen> 已进入 alt screen）被硬编码的 ?1049l 打回主缓冲区。
    // enterAlternateScreen() 内部调用 pause() 和 suspendStdin()；exitAlternateScreen()
    // 会撤销两者并重置帧状态，使下次渲染从头写入。
    inkInstance.enterAlternateScreen()
  } else {
    // GUI editor（code、subl 等）在独立窗口打开，运行期间只需暂停 Ink 并释放 stdin。
    inkInstance.pause()
    inkInstance.suspendStdin()
  }

  try {
    // 有覆盖命令时优先使用，否则原样使用 editor
    const editorCommand = EDITOR_OVERRIDES[editor] ?? editor
    execSync_DEPRECATED(`${editorCommand} "${filePath}"`, {
      stdio: 'inherit',
    })

    // 读取编辑后的内容
    const editedContent = fs.readFileSync(filePath, { encoding: 'utf-8' })
    return { content: editedContent }
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
    ) {
      const status = (err as { status: number }).status
      if (status !== 0) {
        const editorName = toIDEDisplayName(editor)
        return {
          content: null,
          error: `${editorName} exited with code ${status}`,
        }
      }
    }
    return { content: null }
  } finally {
    if (useAlternateScreen) {
      inkInstance.exitAlternateScreen()
    } else {
      inkInstance.resumeStdin()
      inkInstance.resume()
    }
  }
}

/**
 * 查找与 pastedContents 匹配的内容并替换为引用，重新折叠已经展开的粘贴文本。
 */
function recollapsePastedContent(
  editedPrompt: string,
  _originalPrompt: string,
  pastedContents: Record<number, PastedContent>,
): string {
  let collapsed = editedPrompt

  // 在编辑后的文本中查找粘贴内容并重新折叠
  for (const [id, content] of Object.entries(pastedContents)) {
    if (content.type === 'text') {
      const pasteId = parseInt(id, 10)
      const contentStr = content.content

      // 检查编辑后的 prompt 是否仍包含完全相同的内容
      const contentIndex = collapsed.indexOf(contentStr)
      if (contentIndex !== -1) {
        // 替换为引用
        const numLines = getPastedTextRefNumLines(contentStr)
        const ref = formatPastedTextRef(pasteId, numLines)
        collapsed =
          collapsed.slice(0, contentIndex) + ref + collapsed.slice(contentIndex + contentStr.length)
      }
    }
  }

  return collapsed
}

// 同步 IO：由同步 context（React 组件、同步命令 handler）调用
export function editPromptInEditor(
  currentPrompt: string,
  pastedContents?: Record<number, PastedContent>,
): EditorResult {
  const fs = getFsImplementation()
  const tempFile = generateTempFilePath()

  try {
    // 编辑前展开所有粘贴文本引用
    const expandedPrompt = pastedContents
      ? expandPastedTextRefs(currentPrompt, pastedContents)
      : currentPrompt

    // 将展开后的 prompt 写入临时文件
    writeFileSync_DEPRECATED(tempFile, expandedPrompt, {
      encoding: 'utf-8',
      flush: true,
    })

    // 交给 editFileInEditor 处理
    const result = editFileInEditor(tempFile)

    if (result.content === null) {
      return result
    }

    // 若末尾只有一个换行则移除，这是 editor 的常见行为
    let finalContent = result.content
    if (finalContent.endsWith('\n') && !finalContent.endsWith('\n\n')) {
      finalContent = finalContent.slice(0, -1)
    }

    // 粘贴内容未被修改时重新折叠
    if (pastedContents) {
      finalContent = recollapsePastedContent(finalContent, currentPrompt, pastedContents)
    }

    return { content: finalContent }
  } finally {
    // 清理临时文件
    try {
      fs.unlinkSync(tempFile)
    } catch {
      // 忽略清理错误
    }
  }
}
