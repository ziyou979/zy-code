import type { UUID } from 'node:crypto'
import * as React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { recursivelySanitizeUnicode } from '../../utils/sanitization.js'
import { getCurrentSessionTag, getTranscriptPath, saveTag } from '../../utils/sessionStorage.js'

function ConfirmRemoveTag({ tagName, onConfirm, onCancel }) {
  return (
    <Dialog
      title={tSync('tag.removeTitle')}
      subtitle={tSync('tag.currentTag', { tagName })}
      onCancel={onCancel}
      color="warning"
    >
      {
        <Box flexDirection="column" gap={1}>
          {<Text>{tSync('tag.removeDesc')}</Text>}
          <Select
            onChange={(value) => (value === 'yes' ? onConfirm() : onCancel())}
            options={[
              {
                label: tSync('tag.yesRemove'),
                value: 'yes',
              },
              {
                label: tSync('tag.noKeep'),
                value: 'no',
              },
            ]}
          />
        </Box>
      }
    </Dialog>
  )
}
function ToggleTagAndClose({ tagName, onDone }) {
  const [showConfirm, setShowConfirm] = React.useState(false)
  const [sessionId, setSessionId] = React.useState(null)
  const normalizedTag = recursivelySanitizeUnicode(tagName).trim()
  React.useEffect(() => {
    const id = getSessionId() as UUID
    if (!id) {
      onDone(tSync('tag.noActiveSession'), {
        display: 'system',
      })
      return
    }
    if (!normalizedTag) {
      onDone(tSync('tag.emptyName'), {
        display: 'system',
      })
      return
    }
    setSessionId(id)
    const currentTag = getCurrentSessionTag(id)
    if (currentTag === normalizedTag) {
      logEvent('zy_tag_command_remove_prompt', {})
      setShowConfirm(true)
    } else {
      const isReplacing = !!currentTag
      logEvent('zy_tag_command_add', {
        is_replacing: isReplacing,
      })
      ;(async () => {
        const fullPath = getTranscriptPath()
        await saveTag(id, normalizedTag, fullPath)
        onDone(tSync('tag.sessionTagged', { tagName: normalizedTag }), {
          display: 'system',
        })
      })()
    }
  }, [normalizedTag, onDone])
  if (showConfirm && sessionId) {
    return (
      <ConfirmRemoveTag
        tagName={normalizedTag}
        onConfirm={async () => {
          logEvent('zy_tag_command_remove_confirmed', {})
          const transcriptPath = getTranscriptPath()
          await saveTag(sessionId, '', transcriptPath)
          onDone(tSync('tag.tagRemoved', { tagName: normalizedTag }), {
            display: 'system',
          })
        }}
        onCancel={() => {
          logEvent('zy_tag_command_remove_cancelled', {})
          onDone(tSync('tag.tagKept', { tagName: normalizedTag }), {
            display: 'system',
          })
        }}
      />
    )
  }
  return null
}
function ShowHelp({ onDone }) {
  React.useEffect(() => {
    onDone(tSync('tag.usage'), {
      display: 'system',
    })
  }, [onDone])
  return null
}
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  args = args?.trim() || ''
  if (COMMON_INFO_ARGS.includes(args) || COMMON_HELP_ARGS.includes(args)) {
    return <ShowHelp onDone={onDone} />
  }
  if (!args) {
    return <ShowHelp onDone={onDone} />
  }
  return <ToggleTagAndClose tagName={args} onDone={onDone} />
}
