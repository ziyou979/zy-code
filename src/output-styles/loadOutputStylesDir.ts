import { basename } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import type { OutputStyleConfig } from '../constants/outputStyles.js'
import { logForDebugging } from '../services/infra/debug.js'
import { coerceDescriptionToString } from '../services/markdown/frontmatterParser.js'
import { logError } from '../services/infra/log.js'
import {
  extractDescriptionFromMarkdown,
  loadMarkdownFilesForSubdir,
} from '../services/markdown/markdownConfigLoader.js'
import { clearPluginOutputStyleCache } from '../services/plugins/loadPluginOutputStyles.js'

/**
 * 从项目各级 .zy/output-styles 目录及 ~/.zy/output-styles 目录加载 Markdown 文件，
 * 并将其转换为输出样式。
 *
 * 文件名作为样式名称，文件内容作为样式 prompt，frontmatter 提供名称和说明。
 *
 * 目录结构：
 * - 项目 .zy/output-styles/*.md -> 项目样式
 * - 用户 ~/.zy/output-styles/*.md -> 用户样式（同名时由项目样式覆盖）
 *
 * @param cwd 遍历项目目录时使用的当前工作目录
 */
export const getOutputStyleDirStyles = memoize(
  async (cwd: string): Promise<OutputStyleConfig[]> => {
    try {
      const markdownFiles = await loadMarkdownFilesForSubdir('output-styles', cwd)

      const styles = markdownFiles
        .map(({ filePath, frontmatter, content, source }) => {
          try {
            const fileName = basename(filePath)
            const styleName = fileName.replace(/\.md$/, '')

            // Get style configuration from frontmatter
            const name = (frontmatter.name || styleName) as string
            const description =
              coerceDescriptionToString(frontmatter.description, styleName) ??
              extractDescriptionFromMarkdown(content, `Custom ${styleName} output style`)

            // Parse keep-coding-instructions flag (supports both boolean and string values)
            const keepCodingInstructionsRaw = frontmatter['keep-coding-instructions']
            const keepCodingInstructions =
              keepCodingInstructionsRaw === true || keepCodingInstructionsRaw === 'true'
                ? true
                : keepCodingInstructionsRaw === false || keepCodingInstructionsRaw === 'false'
                  ? false
                  : undefined

            // Warn if force-for-plugin is set on non-plugin output style
            if (frontmatter['force-for-plugin'] !== undefined) {
              logForDebugging(
                `Output style "${name}" has force-for-plugin set, but this option only applies to plugin output styles. Ignoring.`,
                { level: 'warn' },
              )
            }

            return {
              name,
              description,
              prompt: content.trim(),
              source,
              keepCodingInstructions,
            }
          } catch (error) {
            logError(error)
            return null
          }
        })
        .filter((style) => style !== null)

      return styles
    } catch (error) {
      logError(error)
      return []
    }
  },
)

export function clearOutputStyleCaches(): void {
  getOutputStyleDirStyles.cache?.clear?.()
  loadMarkdownFilesForSubdir.cache?.clear?.()
  clearPluginOutputStyleCache()
}
