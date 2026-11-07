import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

test('模块 spy 结束后模型、权限和翻译的跨文件组合回归保持有效', async () => {
  // 单独跑绿无法证明没有污染；在同一个子进程中执行污染源及其受影响用例。
  const files = [
    'commands/model/performModelChange.test.ts',
    'utils/modelCost.test.ts',
    'utils/hooks',
    'utils/messages',
    'services/api/countTokens.test.ts',
    'services/api/messagesToOpenAI.test.ts',
    'services/auth/isUsingOAuth.test.ts',
    'services/permissions/bypassPermissionPolicy.test.ts',
    'utils/promptShellExecution.test.ts',
    'utils/fullscreen.test.ts',
    'services/tools/permissionsDenyOverride.test.ts',
    'services/settings/modelTierSettings.test.ts',
    'services/model/resolveModelCapabilities.test.ts',
    'services/feature-flags/betas.test.ts',
    'services/permissions/autoModeEvaluationTask.test.ts',
    'services/permissions/autoModeQualification.test.ts',
    'utils/permissions/getNextPermissionMode.test.ts',
    'services/model/antLingProvider.test.ts',
    'tools/AgentTool/briefPreviewTree.test.tsx',
  ]
  const child = Bun.spawn([process.execPath, 'test', ...files.map((file) => `./tests/${file}`)], {
    cwd: resolve(import.meta.dirname, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exitCode, stdout + stderr).toBe(0)
  expect(stderr).toContain('0 fail')
}, 60000)
