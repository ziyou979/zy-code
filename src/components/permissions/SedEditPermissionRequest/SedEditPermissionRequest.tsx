import { basename, relative } from 'node:path'
import { Suspense, use } from 'react'
import { FileEditToolDiff } from 'src/components/FileEditToolDiff.js'
import { getCwd } from 'src/utils/cwd.js'
import { isENOENT } from 'src/utils/errors.js'
import { detectEncodingForResolvedPath } from 'src/utils/fileRead.js'
import { getFsImplementation } from 'src/utils/fsOperations.js'
import { tSync } from '../../../i18n/index.js'
import { Text } from '../../../ink.js'
import { BashTool } from '../../../tools/BashTool/BashTool.js'
import { applySedSubstitution, type SedEditInfo } from '../../../tools/BashTool/sedEditParser.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type SedEditPermissionRequestProps = PermissionRequestProps & {
  sedInfo: SedEditInfo
  contentPromise?: Promise<FileReadResult>
}
type FileReadResult = {
  oldContent: string
  fileExists: boolean
}
export function SedEditPermissionRequest({ sedInfo, ...props }: SedEditPermissionRequestProps) {
  const { filePath } = sedInfo
  const contentPromise = (async () => {
    const encoding = detectEncodingForResolvedPath(filePath)
    const raw = await getFsImplementation().readFile(filePath, {
      encoding,
    })
    return {
      oldContent: raw.replaceAll('\r\n', '\n'),
      fileExists: true,
    }
  })().catch((e) => {
    if (!isENOENT(e)) {
      throw e
    }
    return {
      oldContent: '',
      fileExists: false,
    }
  })
  return (
    <Suspense fallback={null}>
      <SedEditPermissionRequestInner sedInfo={sedInfo} contentPromise={contentPromise} {...props} />
    </Suspense>
  )
}
function SedEditPermissionRequestInner({
  sedInfo,
  contentPromise,
  ...props
}: SedEditPermissionRequestProps) {
  const { filePath } = sedInfo
  // biome-ignore lint/suspicious/noExplicitAny: 权限系统动态类型处理
  const { oldContent, fileExists } = use(contentPromise as any) as FileReadResult
  const newContent = applySedSubstitution(oldContent, sedInfo)
  let edits: Array<{ old_string: string; new_string: string; replace_all: boolean }>
  if (oldContent === newContent) {
    edits = []
  } else {
    edits = [
      {
        old_string: oldContent,
        new_string: newContent,
        replace_all: false,
      },
    ]
  }
  let noChangesMessage
  if (!fileExists) {
    noChangesMessage = tSync('permission.sedFileDoesNotExist')
  } else {
    noChangesMessage = tSync('permission.sedPatternDidNotMatch')
  }
  const parseInput = (input: unknown) => {
    const parsed = BashTool.inputSchema.parse(input)
    return {
      ...parsed,
      _simulatedSedEdit: {
        filePath,
        newContent,
      },
    }
  }
  const relativePath = relative(getCwd(), filePath)
  const baseFileName = basename(filePath)
  return (
    <FilePermissionDialog
      toolUseConfirm={props.toolUseConfirm}
      toolUseContext={props.toolUseContext}
      onDone={props.onDone}
      onReject={props.onReject}
      title={tSync('permission.editFile')}
      subtitle={relativePath}
      question={
        <Text>{tSync('permission.doYouWantToMakeThisEdit', { filename: baseFileName })}</Text>
      }
      content={
        edits.length > 0 ? (
          <FileEditToolDiff file_path={filePath} edits={edits} />
        ) : (
          <Text dimColor={true}>{noChangesMessage}</Text>
        )
      }
      path={filePath}
      completionType="str_replace_single"
      parseInput={parseInput}
      workerBadge={props.workerBadge}
    />
  )
}
