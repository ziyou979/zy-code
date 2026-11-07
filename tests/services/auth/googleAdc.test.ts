import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Google ADC 登录与认证', () => {
  test('项目选择前独立授权、取消、含空格的 CLI 路径与凭证失效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zy-adc-'))
    const callsPath = join(dir, 'calls.txt')
    const script =
      process.platform === 'win32'
        ? `@echo off\r\necho %* >> "${callsPath}"\r\nif "%1"=="--version" exit /b 0\r\necho {"type":"authorized_user","client_id":"fixture-client","client_secret":"fixture-secret","refresh_token":"fixture-refresh"} > "%CLOUDSDK_CONFIG%\\application_default_credentials.json"\r\necho https://accounts.google.com/o/oauth2/auth?fixture=1\r\n`
        : `#!/bin/sh\nprintf '%s\\n' "$*" >> '${callsPath}'\nif [ "$1" = '--version' ]; then exit 0; fi\nprintf '{"type":"authorized_user","client_id":"fixture-client","client_secret":"fixture-secret","refresh_token":"fixture-refresh"}' > "$CLOUDSDK_CONFIG/application_default_credentials.json"\nprintf 'https://accounts.google.com/o/oauth2/auth?fixture=1\\n'\n`
    try {
      const source = `
        import { writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
        import { join, basename } from 'node:path';
        import { GoogleAuth } from 'google-auth-library';
        const dir = process.env.ZY_CONFIG_DIR;
        const credentialsFile = join(dir, 'adc.json');
        const callsPath = join(dir, 'calls.txt');
        const sdkPath = join(dir, process.platform === 'win32' ? 'fake cloud.cmd' : 'fake cloud.sh');
        writeFileSync(credentialsFile, '{"type":"authorized_user","client_id":"fixture-client","client_secret":"fixture-secret","refresh_token":"fixture-refresh"}');
        writeFileSync(sdkPath, ${JSON.stringify(script)});
        if (process.platform !== 'win32') chmodSync(sdkPath, 0o700);
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ mainLoopModel: 'standard', models: { standard: { provider: 'vertex-fixture', model: 'gemini-4-argon' } } }));
        writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'vertex-fixture': { provider: 'vertex', apiFormat: 'google', credentialType: 'google-adc', vertex: { project: 'fixture-project', location: 'global', credentialsFile } }, ordinary: { provider: 'generic', apiFormat: 'openai-chat', apiKey: 'fixture-key' } }));
        const { setAllowedSettingSources } = await import('./src/bootstrap/runtime/runtimeContext.ts');
        setAllowedSettingSources(['userSettings']);
        const adc = await import('./src/services/auth/googleAdc.ts');
        const auth = await import('./src/services/auth/auth.ts');
        const config = await import('./src/services/auth/authConfig.ts');
        GoogleAuth.prototype.getAccessToken = async () => 'fixture-access';
        GoogleAuth.prototype.getRequestHeaders = async () => new Headers({ Authorization: 'Bearer fixture', 'x-goog-user-project': 'old-quota' });
        const before = { connection: adc.getCurrentGoogleAdcConnection(), source: auth.getAuthTokenSource(), key: auth.getApiKeyWithSource(), ordinary: adc.isGoogleAdcConnection('ordinary') };
        await adc.verifyGoogleAdcCredentials('vertex-fixture');
        const { VertexGoogleProviderAdapter } = await import('./src/services/api/vertexGoogleProviderAdapter.ts');
        let quotaProject;
        await new VertexGoogleProviderAdapter({ fetch: async (_url, init) => {
          quotaProject = new Headers(init.headers).get('x-goog-user-project');
          return Response.json({ candidates: [{ content: { parts: [{ text: 'fixture' }] }, finishReason: 'STOP' }] });
        } }).createMessage({ model: 'standard', maxTokens: 1, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] }, new AbortController().signal);
        const controller = new AbortController(); controller.abort();
        let cancelled = false;
        try { await adc.loginGoogleAdc({ gcloudPath: sdkPath, signal: controller.signal }); } catch { cancelled = true; }
        const authBefore = readFileSync(join(dir, 'auth.json'), 'utf8');
        await adc.verifyGoogleCloudCli(sdkPath, new AbortController().signal);
        let url;
        const file = await adc.loginGoogleAdc({ gcloudPath: sdkPath, signal: new AbortController().signal, onAuthUrl: value => { url = value } });
        const untouched = authBefore === readFileSync(join(dir, 'auth.json'), 'utf8');
        let rejectedCommand = false;
        try { await adc.loginGoogleAdc({ gcloudPath: 'gcloud & echo fixture', signal: new AbortController().signal }); } catch { rejectedCommand = true; }
        GoogleAuth.prototype.getAccessToken = async () => { throw { response: { data: { error: 'invalid_grant' } } }; };
        let revoked = false;
        try { await adc.verifyGoogleAdcCredentials('vertex-fixture'); } catch (error) { revoked = error.status === 401; }
        config.setAuthConfigConnection('vertex-fixture', { vertex: { project: 'fixture-project', credentialsFile: join(dir, 'missing.json') } });
        let missing = false;
        try { await adc.verifyGoogleAdcCredentials('vertex-fixture'); } catch (error) { missing = error.status === 401; }
        console.log(JSON.stringify({ ...before, quotaProject, cancelled, missing, revoked, untouched, rejectedCommand, url, exists: existsSync(file), basename: basename(file), isolated: file.startsWith(join(dir, 'google-adc')), calls: readFileSync(callsPath, 'utf8').trim().split(/\\r?\\n/) }));
      `
      const child = spawnSync(process.execPath, ['--eval', source], {
        cwd: process.cwd(),
        env: { ...process.env, ZY_CONFIG_DIR: dir, NODE_ENV: 'test' },
        encoding: 'utf8',
        timeout: 20000,
      })
      expect(child.stderr).toBe('')
      expect(child.status).toBe(0)
      const result = JSON.parse(child.stdout.trim())
      expect(result.connection).toBe('vertex-fixture')
      expect(result.source).toEqual({ source: 'google-adc', hasToken: true })
      expect(result.key).toEqual({ key: null, source: 'google-adc' })
      for (const key of [
        'cancelled',
        'missing',
        'revoked',
        'untouched',
        'rejectedCommand',
        'exists',
        'isolated',
      ]) {
        expect(result[key]).toBe(true)
      }
      expect(result.url).toBe('https://accounts.google.com/o/oauth2/auth?fixture=1')
      expect(result.basename).toBe('application_default_credentials.json')
      expect(result.calls).toHaveLength(2)
      expect(result.calls[0].trim()).toBe('--version')
      expect(result.quotaProject).toBe('fixture-project')
      expect(result.calls[1]).toContain(
        'application-default login --scopes=https://www.googleapis.com/auth/cloud-platform --disable-quota-project --quiet',
      )
      expect(result.calls.join(' ')).not.toContain('set-quota-project')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 25000)
})
