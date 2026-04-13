import { basename, relative } from 'path';
import React, { useMemo } from 'react';
import type { z } from 'zod/v4';
import { Text } from '../../../ink.js';
import { FileWriteTool } from '../../../tools/FileWriteTool/FileWriteTool.js';
import { getCwd } from '../../../utils/cwd.js';
import { isENOENT } from '../../../utils/errors.js';
import { readFileSync } from '../../../utils/fileRead.js';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js';
import { createSingleEditDiffConfig, type FileEdit, type IDEDiffSupport } from '../FilePermissionDialog/ideDiffConfig.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { FileWriteToolDiff } from './FileWriteToolDiff.js';
type FileWriteToolInput = z.infer<typeof FileWriteTool.inputSchema>;
const ideDiffSupport: IDEDiffSupport<FileWriteToolInput> = {
  getConfig: (input: FileWriteToolInput) => {
    let oldContent: string;
    try {
      oldContent = readFileSync(input.file_path);
    } catch (e) {
      if (!isENOENT(e)) throw e;
      oldContent = '';
    }
    return createSingleEditDiffConfig(input.file_path, oldContent, input.content, false // For file writes, we replace the entire content
    );
  },
  applyChanges: (input: FileWriteToolInput, modifiedEdits: FileEdit[]) => {
    const firstEdit = modifiedEdits[0];
    if (firstEdit) {
      return {
        ...input,
        content: firstEdit.new_string
      };
    }
    return input;
  }
};
export function FileWritePermissionRequest(props) {
  const parseInput = input => FileWriteTool.inputSchema.parse(input);
  const parsed = parseInput(props.toolUseConfirm.input);
  const {
    file_path,
    content
  } = parsed;
  let t1;
  try {
    t1 = {
      fileExists: true,
      oldContent: readFileSync(file_path)
    };
  } catch (e) {
    if (!isENOENT(e)) {
      throw e;
    }
    const t3 = {
      fileExists: false,
      oldContent: ""
    };
    t1 = t3;
  }
  const {
    fileExists,
    oldContent
  } = t1;
  const actionText = fileExists ? "overwrite" : "create";
  const t8 = relative(getCwd(), file_path);
  const t9 = basename(file_path);
  return <FilePermissionDialog toolUseConfirm={props.toolUseConfirm} toolUseContext={props.toolUseContext} onDone={props.onDone} onReject={props.onReject} workerBadge={props.workerBadge} title={fileExists ? "Overwrite file" : "Create file"} subtitle={t8} question={<Text>Do you want to {actionText} {<Text bold={true}>{t9}</Text>}?</Text>} content={<FileWriteToolDiff file_path={file_path} content={content} fileExists={fileExists} oldContent={oldContent} />} path={file_path} completionType="write_file_single" parseInput={parseInput} ideDiffSupport={ideDiffSupport} />;
}
