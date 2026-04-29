import { basename } from 'path';
import React from 'react';
import type { z } from 'zod/v4';
import { Text } from '../../../ink.js';
import { tSync } from '../../../i18n/index.js';
import { NotebookEditTool } from '../../../tools/NotebookEditTool/NotebookEditTool.js';
import { logError } from '../../../utils/log.js';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js';
import { NotebookEditToolDiff } from './NotebookEditToolDiff.js';
type NotebookEditInput = z.infer<typeof NotebookEditTool.inputSchema>;
export function NotebookEditPermissionRequest(props) {
  const parseInput = input => {
    const result = NotebookEditTool.inputSchema.safeParse(input);
    if (!result.success) {
      logError(new Error(`Failed to parse notebook edit input: ${result.error.message}`));
      return {
        notebook_path: "",
        new_source: "",
        cell_id: ""
      } as NotebookEditInput;
    }
    return result.data;
  };
  const T0 = Text;
  const T1 = Text;
  const T2 = FilePermissionDialog;
  const parsed = parseInput(props.toolUseConfirm.input);
  const t1 = basename(parsed.notebook_path);
  const {
    edit_mode
  } = parsed;
  const language = parsed.cell_type === "markdown" ? "markdown" : "python";
  const notebook_path = parsed.notebook_path;
  const editTypeText = edit_mode === "insert" ? tSync('permission.insertCellInto') : edit_mode === "delete" ? tSync('permission.deleteCellFrom') : tSync('permission.makeEditTo');
  return <T2 toolUseConfirm={props.toolUseConfirm} toolUseContext={props.toolUseContext} onDone={props.onDone} onReject={props.onReject} workerBadge={props.workerBadge} title={tSync('permission.editNotebook')} question={<T1>{tSync('permission.doYouWantToNotebookAction', { action: editTypeText, filename: t1 })}</T1>} content={<NotebookEditToolDiff notebook_path={parsed.notebook_path} cell_id={parsed.cell_id} new_source={parsed.new_source} cell_type={parsed.cell_type} edit_mode={parsed.edit_mode} verbose={props.verbose} width={props.verbose ? 120 : 80} />} path={notebook_path} completionType="tool_use_single" languageName={language} parseInput={parseInput} />;
}
