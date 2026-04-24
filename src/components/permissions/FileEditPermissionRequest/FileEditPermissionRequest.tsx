import { basename, relative } from 'path';
import React from 'react';
import { FileEditToolDiff } from 'src/components/FileEditToolDiff.js';
import { getCwd } from 'src/utils/cwd.js';
import type { z } from 'zod/v4';
import { Text } from '../../../ink.js';
import { tSync } from '../../../i18n/index.js';
import { FileEditTool } from '../../../tools/FileEditTool/FileEditTool.js';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js';
import { createSingleEditDiffConfig, type FileEdit, type IDEDiffSupport } from '../FilePermissionDialog/ideDiffConfig.js';
type FileEditInput = z.infer<typeof FileEditTool.inputSchema>;
const ideDiffSupport: IDEDiffSupport<FileEditInput> = {
  getConfig: (input: FileEditInput) => createSingleEditDiffConfig(input.file_path, input.old_string, input.new_string, input.replace_all),
  applyChanges: (input: FileEditInput, modifiedEdits: FileEdit[]) => {
    const firstEdit = modifiedEdits[0];
    if (firstEdit) {
      return {
        ...input,
        old_string: firstEdit.old_string,
        new_string: firstEdit.new_string,
        replace_all: firstEdit.replace_all
      };
    }
    return input;
  }
};
export function FileEditPermissionRequest(props) {
  const parseInput = (input) => FileEditTool.inputSchema.parse(input);
  let TextComponent;
  let TextComponent2;
  let FilePermissionDialogComponent;

  let basenameResult;
  let relativeResult;


  let toolUseConfirm2;
  let toolUseContext2;
  let onDone2;
  let onReject2;
  let workerBadge2;

  const parsed = parseInput(props.toolUseConfirm.input);
  let file_path: string;
  let old_string: string;
  let new_string: string;
  let replace_all: boolean | undefined;
  ({
    file_path,
    old_string,
    new_string,
    replace_all
  } = parsed);
  FilePermissionDialogComponent = FilePermissionDialog;
  toolUseConfirm2 = props.toolUseConfirm;
  toolUseContext2 = props.toolUseContext;
  onDone2 = props.onDone;
  onReject2 = props.onReject;
  workerBadge2 = props.workerBadge;

  relativeResult = relative(getCwd(), file_path);
  TextComponent2 = Text;


  TextComponent = Text;

  basenameResult = basename(file_path);
  return <FilePermissionDialogComponent toolUseConfirm={toolUseConfirm2} toolUseContext={toolUseContext2} onDone={onDone2} onReject={onReject2} workerBadge={workerBadge2} title={tSync('permission.editFile')} subtitle={relativeResult} question={<TextComponent2>{tSync('permission.doYouWantToMakeThisEdit', { filename: basenameResult })}</TextComponent2>} content={<FileEditToolDiff file_path={file_path} edits={[{
    old_string,
    new_string,
    replace_all: replace_all || false
  }]} />} path={file_path} completionType="str_replace_single" parseInput={parseInput} ideDiffSupport={ideDiffSupport} />;
}