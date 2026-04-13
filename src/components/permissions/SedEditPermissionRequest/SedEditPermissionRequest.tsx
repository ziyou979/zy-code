import { basename, relative } from 'path';
import React, { Suspense, use } from 'react';
import { FileEditToolDiff } from 'src/components/FileEditToolDiff.js';
import { getCwd } from 'src/utils/cwd.js';
import { isENOENT } from 'src/utils/errors.js';
import { detectEncodingForResolvedPath } from 'src/utils/fileRead.js';
import { getFsImplementation } from 'src/utils/fsOperations.js';
import { Text } from '../../../ink.js';
import { BashTool } from '../../../tools/BashTool/BashTool.js';
import { applySedSubstitution, type SedEditInfo } from '../../../tools/BashTool/sedEditParser.js';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
type SedEditPermissionRequestProps = PermissionRequestProps & {
  sedInfo: SedEditInfo;
};
type FileReadResult = {
  oldContent: string;
  fileExists: boolean;
};
export function SedEditPermissionRequest({
  sedInfo,
  ...props
}: SedEditPermissionRequestProps) {
  const {
    filePath
  } = sedInfo;
  const contentPromise = (async () => {
    const encoding = detectEncodingForResolvedPath(filePath);
    const raw = await getFsImplementation().readFile(filePath, {
      encoding
    });
    return {
      oldContent: raw.replaceAll("\r\n", "\n"),
      fileExists: true
    };
  })().catch(e => {
    if (!isENOENT(e)) {
      throw e;
    }
    return {
      oldContent: "",
      fileExists: false
    };
  });
  return <Suspense fallback={null}><SedEditPermissionRequestInner sedInfo={sedInfo} contentPromise={contentPromise} {...props} /></Suspense>;
}
function SedEditPermissionRequestInner({
  sedInfo,
  contentPromise,
  ...props
}: SedEditPermissionRequestProps) {
  const {
    filePath
  } = sedInfo;
  const {
    oldContent,
    fileExists
  } = use(contentPromise);
  const newContent = applySedSubstitution(oldContent, sedInfo);
  let edits;
  if (oldContent === newContent) {
    edits = [];
  } else {
    edits = [{
      old_string: oldContent,
      new_string: newContent,
      replace_all: false
    }];
  }
  let noChangesMessage;
  if (!fileExists) {
    noChangesMessage = "File does not exist";
  } else {
    noChangesMessage = "Pattern did not match any content";
  }
  const parseInput = input => {
    const parsed = BashTool.inputSchema.parse(input);
    return {
      ...parsed,
      _simulatedSedEdit: {
        filePath,
        newContent
      }
    };
  };
  const t9 = relative(getCwd(), filePath);
  const t10 = basename(filePath);
  return <FilePermissionDialog toolUseConfirm={props.toolUseConfirm} toolUseContext={props.toolUseContext} onDone={props.onDone} onReject={props.onReject} title="Edit file" subtitle={t9} question={<Text>Do you want to make this edit to{" "}<Text bold={true}>{t10}</Text>?</Text>} content={edits.length > 0 ? <FileEditToolDiff file_path={filePath} edits={edits} /> : <Text dimColor={true}>{noChangesMessage}</Text>} path={filePath} completionType="str_replace_single" parseInput={parseInput} workerBadge={props.workerBadge} />;
}
