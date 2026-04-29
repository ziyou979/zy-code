import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { Box, Text } from '../ink.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { getPlansDirectory } from '../utils/plans.js';
import { setCwd } from '../utils/Shell.js';
import { cleanupWorktree, getCurrentWorktreeSession, keepWorktree, killTmuxSession } from '../utils/worktree.js';
import { Select } from './CustomSelect/select.js';
import { Dialog } from './design-system/Dialog.js';
import { Spinner } from './Spinner.js';
import { tSync } from 'src/i18n/index.js';

// 内联 require 打破此文件会形成的循环：
// sessionStorage → commands → exit → ExitFlow → 此处。所有调用点
// 都在回调内，所以延迟 require 永远不会看到未定义的导入。
function recordWorktreeExit(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  ;
  (require('../utils/sessionStorage.js') as typeof import('../utils/sessionStorage.js')).saveWorktreeState(null);
  /* eslint-enable @typescript-eslint/no-require-imports */
}
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onCancel?: () => void;
};
export function WorktreeExitDialog({
  onDone,
  onCancel
}: Props): React.ReactNode {
  const [status, setStatus] = useState<'loading' | 'asking' | 'keeping' | 'removing' | 'done'>('loading');
  const [changes, setChanges] = useState<string[]>([]);
  const [commitCount, setCommitCount] = useState<number>(0);
  const [resultMessage, setResultMessage] = useState<string | undefined>();
  const worktreeSession = getCurrentWorktreeSession();
  useEffect(() => {
    async function loadChanges() {
      let changeLines: string[] = [];
      const gitStatus = await execFileNoThrow('git', ['status', '--porcelain']);
      if (gitStatus.stdout) {
        changeLines = gitStatus.stdout.split('\n').filter(_ => _.trim() !== '');
        setChanges(changeLines);
      }

      // 检查是否有提交需要弹出
      if (worktreeSession) {
        // 获取 worktree 中不在原始分支中的提交
        const {
          stdout: commitsStr
        } = await execFileNoThrow('git', ['rev-list', '--count', `${worktreeSession.originalHeadCommit}..HEAD`]);
        const count = parseInt(commitsStr.trim()) || 0;
        setCommitCount(count);

        // 如果没有更改也没有提交，静默清理
        if (changeLines.length === 0 && count === 0) {
          setStatus('removing');
          void cleanupWorktree().then(() => {
            process.chdir(worktreeSession.originalCwd);
            setCwd(worktreeSession.originalCwd);
            recordWorktreeExit();
            getPlansDirectory.cache.clear?.();
            setResultMessage(tSync('worktree.removedNoChanges'));
          }).catch(error => {
            logForDebugging(`Failed to clean up worktree: ${error}`, {
              level: 'error'
            });
            setResultMessage(tSync('worktree.cleanupFailed'));
          }).then(() => {
            setStatus('done');
          });
          return;
        } else {
          setStatus('asking');
        }
      }
    }
    void loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, [worktreeSession]);
  useEffect(() => {
    if (status === 'done') {
      onDone(resultMessage);
    }
  }, [status, onDone, resultMessage]);
  if (!worktreeSession) {
    onDone(tSync('worktree.noActiveSession'), {
      display: 'system'
    });
    return null;
  }
  if (status === 'loading' || status === 'done') {
    return null;
  }
  async function handleSelect(value: string) {
    if (!worktreeSession) return;
    const hasTmux = Boolean(worktreeSession.tmuxSessionName);
    if (value === 'keep' || value === 'keep-with-tmux') {
      setStatus('keeping');
      logEvent('zy_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length
      });
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      if (hasTmux) {
        setResultMessage(tSync('worktree.keptWithPathAndTmux', {
          path: worktreeSession.worktreePath,
          branch: worktreeSession.worktreeBranch,
          tmux: worktreeSession.tmuxSessionName
        }));
      } else {
        setResultMessage(tSync('worktree.keptWithPath', {
          path: worktreeSession.worktreePath,
          branch: worktreeSession.worktreeBranch
        }));
      }
      setStatus('done');
    } else if (value === 'keep-kill-tmux') {
      setStatus('keeping');
      logEvent('zy_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      setResultMessage(tSync('worktree.keptWithPathTmuxKilled', {
        path: worktreeSession.worktreePath,
        branch: worktreeSession.worktreeBranch
      }));
      setStatus('done');
    } else if (value === 'remove' || value === 'remove-with-tmux') {
      setStatus('removing');
      logEvent('zy_worktree_removed', {
        commits: commitCount,
        changed_files: changes.length
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      try {
        await cleanupWorktree();
        process.chdir(worktreeSession.originalCwd);
        setCwd(worktreeSession.originalCwd);
        recordWorktreeExit();
        getPlansDirectory.cache.clear?.();
      } catch (error) {
        logForDebugging(`Failed to clean up worktree: ${error}`, {
          level: 'error'
        });
        setResultMessage(tSync('worktree.cleanupFailed'));
        setStatus('done');
        return;
      }
      const tmuxNote = hasTmux ? tSync('worktree.tmuxTerminated') : '';
      if (commitCount > 0 && changes.length > 0) {
        setResultMessage(tSync('worktree.removedWithCommitsAndChanges', {
          commitCount,
          commitLabel: tSync(commitCount === 1 ? 'worktree.commit_one' : 'worktree.commit_other'),
          tmuxNote
        }));
      } else if (commitCount > 0) {
        setResultMessage(tSync('worktree.removedWithCommits', {
          commitCount,
          commitLabel: tSync(commitCount === 1 ? 'worktree.commit_one' : 'worktree.commit_other'),
          branch: worktreeSession.worktreeBranch,
          wasWere: tSync(commitCount === 1 ? 'worktree.was' : 'worktree.were'),
          tmuxNote
        }));
      } else if (changes.length > 0) {
        setResultMessage(tSync('worktree.removedWithChanges', {
          tmuxNote
        }));
      } else {
        setResultMessage(tSync('worktree.removed', {
          tmuxNote
        }));
      }
      setStatus('done');
    }
  }
  if (status === 'keeping') {
    return <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>{tSync('worktree.keepingWorktree')}</Text>
      </Box>;
  }
  if (status === 'removing') {
    return <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>{tSync('worktree.removingWorktree')}</Text>
      </Box>;
  }
  const branchName = worktreeSession.worktreeBranch;
  const hasUncommitted = changes.length > 0;
  const hasCommits = commitCount > 0;
  let subtitle = '';
  if (hasUncommitted && hasCommits) {
    subtitle = tSync('worktree.subtitleBoth', {
      fileCount: changes.length,
      fileLabel: tSync(changes.length === 1 ? 'worktree.file_one' : 'worktree.file_other'),
      commitCount,
      commitLabel: tSync(commitCount === 1 ? 'worktree.commit_one' : 'worktree.commit_other'),
      branch: branchName
    });
  } else if (hasUncommitted) {
    subtitle = tSync('worktree.subtitleFiles', {
      fileCount: changes.length,
      fileLabel: tSync(changes.length === 1 ? 'worktree.file_one' : 'worktree.file_other')
    });
  } else if (hasCommits) {
    subtitle = tSync('worktree.subtitleCommits', {
      commitCount,
      commitLabel: tSync(commitCount === 1 ? 'worktree.commit_one' : 'worktree.commit_other'),
      branch: branchName
    });
  } else {
    subtitle = tSync('worktree.subtitleNone');
  }
  function handleCancel() {
    if (onCancel) {
      // 中止退出并返回会话
      onCancel();
      return;
    }
    // 后备：如果没有提供 onCancel，将 Escape 视为"保留"
    void handleSelect('keep');
  }
  const removeDescription = hasUncommitted || hasCommits ? tSync('worktree.removeDescription') : tSync('worktree.removeDescriptionClean');
  const hasTmuxSession = Boolean(worktreeSession.tmuxSessionName);
  const options = hasTmuxSession ? [{
    label: tSync('worktree.keepWorktreeAndTmux'),
    value: 'keep-with-tmux',
    description: tSync('worktree.keepWorktreeAndTmuxDesc', {
      path: worktreeSession.worktreePath,
      tmux: worktreeSession.tmuxSessionName
    })
  }, {
    label: tSync('worktree.keepWorktreeKillTmux'),
    value: 'keep-kill-tmux',
    description: tSync('worktree.keepWorktreeKillTmuxDesc', {
      path: worktreeSession.worktreePath
    })
  }, {
    label: tSync('worktree.removeWorktreeAndTmux'),
    value: 'remove-with-tmux',
    description: removeDescription
  }] : [{
    label: tSync('worktree.keepWorktree'),
    value: 'keep',
    description: tSync('worktree.keepWorktreeDesc', {
      path: worktreeSession.worktreePath
    })
  }, {
    label: tSync('worktree.removeWorktree'),
    value: 'remove',
    description: removeDescription
  }];
  const defaultValue = hasTmuxSession ? 'keep-with-tmux' : 'keep';
  return <Dialog title={tSync('worktree.exitingSession')} subtitle={subtitle} onCancel={handleCancel}>
      <Select defaultFocusValue={defaultValue} options={options} onChange={handleSelect} />
    </Dialog>;
}
