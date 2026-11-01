import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isValidVertexProjectId,
  VertexSetupClient,
} from '../../../src/services/auth/vertexSetup.js'

function client(respond: (url: URL, init?: RequestInit) => Response) {
  const requests: { url: URL; init?: RequestInit }[] = []
  return {
    requests,
    api: new VertexSetupClient({
      getHeaders: async () =>
        new Headers({ Authorization: 'Bearer fixture', 'x-goog-user-project': 'old-project' }),
      fetch: (async (input, init) => {
        const url = new URL(String(input))
        requests.push({ url, init })
        return respond(url, init)
      }) as typeof fetch,
    }),
  }
}

describe('VertexSetupClient', () => {
  test('项目发现使用 ADC，分页并保留真实项目 ID，不要求 gcloud CLI 账户登录', async () => {
    const { api, requests } = client((url) =>
      Response.json(
        url.searchParams.has('pageToken')
          ? { projects: [{ projectId: 'project-two', name: 'Two', lifecycleState: 'ACTIVE' }] }
          : {
              projects: [
                {
                  projectId: 'project-one',
                  name: 'One',
                  projectNumber: '123',
                  lifecycleState: 'ACTIVE',
                },
              ],
              nextPageToken: 'page 2',
            },
      ),
    )
    expect(await api.listProjects(new AbortController().signal)).toEqual([
      { id: 'project-one', name: 'One', number: '123' },
      { id: 'project-two', name: 'Two', number: undefined },
    ])
    expect(requests).toHaveLength(2)
    expect(requests[1]?.url.searchParams.get('pageToken')).toBe('page 2')
    expect(new Headers(requests[0]?.init?.headers).has('x-goog-user-project')).toBe(false)
    expect(requests.every(({ init }) => init?.method === 'GET')).toBe(true)
  })

  test('账单、API 和调用/配额权限各自检查，不进行模型生成或自动启用服务', async () => {
    const { api, requests } = client((url) => {
      if (url.pathname.endsWith(':testIamPermissions')) {
        return Response.json({
          permissions: ['aiplatform.endpoints.predict', 'serviceusage.services.use'],
        })
      }
      if (url.pathname.endsWith('/billingInfo')) {
        return Response.json({ billingEnabled: true })
      }
      if (url.hostname === 'serviceusage.googleapis.com') {
        return Response.json({ state: 'ENABLED' })
      }
      return Response.json({ projectNumber: '123456', lifecycleState: 'ACTIVE' })
    })
    expect(await api.inspectProject('project-one', new AbortController().signal)).toEqual({
      project: 'ok',
      billing: 'ok',
      api: 'ok',
      predict: 'ok',
      quota: 'ok',
    })
    expect(requests).toHaveLength(4)
    expect(
      requests.find(({ url }) => url.hostname === 'serviceusage.googleapis.com')?.url.pathname,
    ).toContain('/projects/123456/')
    expect(
      requests.every(({ url }) => !/generateContent|:enable|setIamPolicy/.test(url.toString())),
    ).toBe(true)
  })

  test('明确缺少调用权限或账单停用不能标为通过', async () => {
    const { api } = client((url) => {
      if (url.pathname.endsWith(':testIamPermissions')) {
        return Response.json({ permissions: [] })
      }
      if (url.pathname.endsWith('/billingInfo')) {
        return Response.json({ billingEnabled: false })
      }
      if (url.hostname === 'serviceusage.googleapis.com') {
        return Response.json({ state: 'DISABLED' })
      }
      return Response.json({ projectNumber: '123', lifecycleState: 'ACTIVE' })
    })
    expect(await api.inspectProject('project-one', new AbortController().signal)).toEqual({
      project: 'ok',
      billing: 'blocked',
      api: 'blocked',
      predict: 'blocked',
      quota: 'blocked',
    })
  })

  test('无查看权限保留未验证状态，401 要求重新授权，取消不继续请求', async () => {
    const unknown = client(() => new Response('', { status: 403 }))
    expect(await unknown.api.inspectProject('project-one', new AbortController().signal)).toEqual({
      project: 'unknown',
      billing: 'unknown',
      api: 'unknown',
      predict: 'unknown',
      quota: 'unknown',
    })
    await expect(unknown.api.listProjects(new AbortController().signal)).rejects.toMatchObject({
      status: 403,
    })
    const denied = client(() => new Response('', { status: 401 }))
    await expect(
      denied.api.inspectProject('project-one', new AbortController().signal),
    ).rejects.toMatchObject({ status: 401 })
    const controller = new AbortController()
    controller.abort()
    await expect(denied.api.listProjects(controller.signal)).rejects.toThrow()
    expect(denied.requests).toHaveLength(3)
  })

  test('重复分页令牌不能形成请求循环，项目 ID 不接受显示名称或编号', async () => {
    const { api, requests } = client(() => Response.json({ nextPageToken: 'repeat' }))
    await expect(api.listProjects(new AbortController().signal)).rejects.toThrow()
    expect(requests).toHaveLength(2)
    expect(isValidVertexProjectId('project-one')).toBe(true)
    for (const value of ['123456', 'My Project', '../project', 'a', 'a-']) {
      expect(isValidVertexProjectId(value)).toBe(false)
    }
  })

  test('保存只在确认时发生，不覆盖其他连接，不保留旧项目 URL 或复制凭证内容', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zy-vertex-setup-'))
    try {
      const source = `
        import { writeFileSync, readFileSync } from 'node:fs'; import { join } from 'node:path';
        const dir = process.env.ZY_CONFIG_DIR;
        writeFileSync(join(dir, 'auth.json'), JSON.stringify({ vertex: { provider: 'vertex', apiFormat: 'google', credentialType: 'google-adc', baseUrl: 'https://aiplatform.googleapis.com/v1beta1/projects/old-project/locations/global/publishers/google', vertex: { project: 'old-project' } }, ordinary: { apiKey: 'keep-fixture' } }));
        const { createVertexSetupDraft, saveVertexSetup } = await import('./src/services/auth/vertexSetup.ts');
        const before = readFileSync(join(dir, 'auth.json'), 'utf8');
        const fresh = createVertexSetupDraft(); const existing = createVertexSetupDraft('vertex');
        const untouched = before === readFileSync(join(dir, 'auth.json'), 'utf8');
        let collision = false; try { saveVertexSetup({ ...fresh, connectionId: 'ordinary', project: 'new-project' }); } catch { collision = true; }
        saveVertexSetup({ ...existing, project: 'new-project', location: 'eu', credentialsFile: '/fixture/adc.json' });
        const result = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
        console.log(JSON.stringify({ fresh: fresh.connectionId, untouched, collision, result }));
      `
      const child = spawnSync(process.execPath, ['--eval', source], {
        cwd: process.cwd(),
        env: { ...process.env, ZY_CONFIG_DIR: dir, NODE_ENV: 'test' },
        encoding: 'utf8',
        timeout: 20000,
      })
      expect(child.status).toBe(0)
      const result = JSON.parse(child.stdout.trim())
      expect(result).toMatchObject({ fresh: 'vertex-2', untouched: true, collision: true })
      expect(result.result.ordinary).toEqual({ apiKey: 'keep-fixture' })
      expect(result.result.vertex).toMatchObject({
        baseUrl: 'https://aiplatform.googleapis.com/v1beta1',
        modelsUrl:
          'https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100',
        vertex: { project: 'new-project', location: 'eu', credentialsFile: '/fixture/adc.json' },
      })
      expect(result.result.vertex).not.toHaveProperty('apiKey')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 25000)
})
