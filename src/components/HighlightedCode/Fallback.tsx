import { extname } from 'node:path'
import { Suspense, use } from 'react'
import { Ansi, Text } from '../../ink/index.js'
import { getCliHighlightPromise } from '../../services/terminal/cliHighlight.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { convertLeadingTabsToSpaces } from '../../services/infra/file.js'
import { cachedHighlight } from '../../services/terminal/highlightCache.js'

type Props = {
  code: string
  filePath: string
  dim?: boolean
  skipColoring?: boolean
}

export function HighlightedCodeFallback({
  code,
  filePath,
  dim = false,
  skipColoring = false,
}: Props) {
  const codeWithSpaces = convertLeadingTabsToSpaces(code)
  if (skipColoring) {
    return <Text dimColor={dim}>{<Ansi>{codeWithSpaces}</Ansi>}</Text>
  }
  const language = extname(filePath).slice(1)
  return (
    <Text dimColor={dim}>
      {
        <Suspense fallback={<Ansi>{codeWithSpaces}</Ansi>}>
          {<Highlighted codeWithSpaces={codeWithSpaces} language={language} />}
        </Suspense>
      }
    </Text>
  )
}
function Highlighted({ codeWithSpaces, language }: { codeWithSpaces: string; language: string }) {
  const highlightPromise = getCliHighlightPromise()
  const hl = use(highlightPromise)
  let out
  if (!hl) {
    out = codeWithSpaces
  } else {
    let highlightLang = 'markdown'
    if (language) {
      if (hl.supportsLanguage(language)) {
        highlightLang = language
      } else {
        logForDebugging(
          `Language not supported while highlighting code, falling back to markdown: ${language}`,
        )
      }
    }
    try {
      out = cachedHighlight(hl, codeWithSpaces, highlightLang)
    } catch (e) {
      if (e instanceof Error && e.message.includes('Unknown language')) {
        logForDebugging(
          `Language not supported while highlighting code, falling back to markdown: ${e}`,
        )
        const fallbackHighlight = cachedHighlight(hl, codeWithSpaces, 'markdown')
        out = fallbackHighlight
      } else {
        out = codeWithSpaces
      }
    }
  }
  return <Ansi>{out}</Ansi>
}
