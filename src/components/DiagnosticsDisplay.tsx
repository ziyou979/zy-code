import { relative } from 'path'
import React from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import { DiagnosticTrackingService } from '../services/diagnosticTracking.js'
import type { Attachment } from '../utils/attachments.js'
import { getCwd } from '../utils/cwd.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import { MessageResponse } from './MessageResponse.js'
type DiagnosticsAttachment = Extract<
  Attachment,
  {
    type: 'diagnostics'
  }
>
type DiagnosticsDisplayProps = {
  attachment: DiagnosticsAttachment
  verbose: boolean
}
export function DiagnosticsDisplay({ attachment, verbose }: DiagnosticsDisplayProps) {
  if (attachment.files.length === 0) {
    return null
  }
  const totalIssues = attachment.files.reduce((sum, file) => sum + file.diagnostics.length, 0)
  const fileCount = attachment.files.length
  if (verbose) {
    const diagnosticFileElements = attachment.files.map((file_0, fileIndex) => (
      <React.Fragment key={fileIndex}>
        <MessageResponse>
          <Text dimColor={true} wrap="wrap">
            <Text bold={true}>
              {relative(getCwd(), file_0.uri.replace('file://', '').replace('_Zy_fs_right:', ''))}
            </Text>{' '}
            <Text dimColor={true}>
              {file_0.uri.startsWith('file://')
                ? '(file://)'
                : file_0.uri.startsWith('_Zy_fs_right:')
                  ? '(zy_fs_right)'
                  : `(${file_0.uri.split(':')[0]})`}
            </Text>
            :
          </Text>
        </MessageResponse>
        {file_0.diagnostics.map((diagnostic, diagIndex) => (
          <MessageResponse key={diagIndex}>
            <Text dimColor={true} wrap="wrap">
              {'  '}
              {DiagnosticTrackingService.getSeveritySymbol(diagnostic.severity)}
              {' ['}
              {tSync('diagnostics.line')} {diagnostic.range.start.line + 1}:
              {diagnostic.range.start.character + 1}
              {'] '}
              {diagnostic.message}
              {diagnostic.code ? ` [${diagnostic.code}]` : ''}
              {diagnostic.source ? ` (${diagnostic.source})` : ''}
            </Text>
          </MessageResponse>
        ))}
      </React.Fragment>
    ))
    return <Box flexDirection="column">{diagnosticFileElements}</Box>
  } else {
    return (
      <MessageResponse>
        <Text dimColor={true} wrap="wrap">
          {tSync('diagnostics.foundIssues', {
            count: totalIssues,
            issueLabel: tSync(
              totalIssues === 1 ? 'diagnostics.issue_one' : 'diagnostics.issue_other',
            ),
            fileCount,
            fileLabel: tSync(fileCount === 1 ? 'diagnostics.file_one' : 'diagnostics.file_other'),
          })}{' '}
          {<CtrlOToExpand />}
        </Text>
      </MessageResponse>
    )
  }
}
