import { basename, relative } from 'path';
import React from 'react';
import { FileEditToolDiff } from 'src/components/FileEditToolDiff.js';
import { getCwd } from 'src/utils/cwd.js';
import type { z } from 'zod/v4';
import { Text } from '../../../ink.js';
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
  const parseInput = input => FileEditTool.inputSchema.parse(input);
  let T0;
  let T1;
  let T2;
  let t0;
  let t1;
  let t10;
  let t2;
  let t3;
  let t4;
  let t5;
  let t6;
  let t7;
  let t8;
  let t9;
  const parsed = parseInput(props.toolUseConfirm.input);
  ({
    file_path,
    old_string,
    new_string,
    replace_all
  } = parsed);
  T2 = FilePermissionDialog;
  t4 = props.toolUseConfirm;
  t5 = props.toolUseContext;
  t6 = props.onDone;
  t7 = props.onReject;
  t8 = props.workerBadge;
  t9 = "Edit file";
  t10 = relative(getCwd(), file_path);
  T1 = Text;
  t2 = "Do you want to make this edit to";
  t3 = " ";
  T0 = Text;
  t0 = true;
  t1 = basename(file_path);
  return <T2 toolUseConfirm={t4} toolUseContext={t5} onDone={t6} onReject={t7} workerBadge={t8} title={t9} subtitle={t10} question={<T1>{t2}{t3}{<T0 bold={t0}>{t1}</T0>}?</T1>} content={<FileEditToolDiff file_path={file_path} edits={[{
    old_string,
    new_string,
    replace_all: replace_all || false
  }]} />} path={file_path} completionType="str_replace_single" parseInput={parseInput} ideDiffSupport={ideDiffSupport} />;
}
