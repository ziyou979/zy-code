import type { TranslationResource } from '../resourceTypes.js'

export const zhWorkflow: TranslationResource = {
  'workflow.error.inputRequired': '必须提供 script、scriptPath 或 name 之一。',
  'workflow.error.inputExclusive': '只能提供 script、scriptPath 或 name 中的一个。',
  'workflow.error.namedNotFound':
    '未找到名为「{name}」的工作流。请将 .js 工作流文件放在 ~/.zy/workflows/ 或 <项目>/workflows/ 目录中。',
  'workflow.error.runtimeNotAvailable':
    '工作流运行时暂不可用。脚本已验证但无法在当前构建中执行。该功能正在开发中。',
  'workflow.launched':
    '工作流「{name}」已启动。完成时你将收到 <task-notification> 通知。使用 /workflows 查看进度。',
  'workflow.completed': '已完成，共 {count} 个子 Agent。',
  'workflow.completedWithResult': '已完成，共 {count} 个子 Agent。结果：{result}',
  'workflow.failed': '工作流失败：{error}',
  'workflow.stopped': '工作流已停止',
  'workflow.error.resumeStillRunning':
    '工作流 {runId} 仍在运行（任务 {taskId}）。请先使用 TaskStop({{taskId: "{taskId}"}}) 停止后再恢复。',
}
