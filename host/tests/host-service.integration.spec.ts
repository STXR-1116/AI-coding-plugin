import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord, CredentialKey } from '@deepseek-ai/dsh-credentials'
import { createTeamSkillService } from '../../../../apps/team-skill-service/src/server.ts'
import { TeamSkillHost } from '../src/host.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
const roots: string[] = []

function accountGrantPayload(record: CredentialRecord | undefined): { readonly accessToken: string; readonly record: object } {
  if (record === undefined || record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null || !('accessToken' in record.payload) || typeof record.payload.accessToken !== 'string') {
    throw new Error('Expected Host account grant payload.')
  }
  return { accessToken: record.payload.accessToken, record: record.payload }
}

afterEach(async () => {
  for (const service of services.splice(0)) service.server.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Team Skill service and Host integration', () => {
  it('keeps account tokens in Host credentials and exposes only browser-safe state', async () => {
    const service = createTeamSkillService({ port: 4325 })
    services.push(service)
    await service.listen()
    const records = new Map<CredentialKey, CredentialRecord>()
    const credentials = {
      readRecord: async (key: CredentialKey) => records.get(key),
      modifyRecord: async (key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      deleteRecord: async (key: CredentialKey) => { records.delete(key) },
    } as unknown as CredentialProvider
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-account-e2e-')); roots.push(root)
    const host = new TeamSkillHost({
      apiBaseUrl: 'http://127.0.0.1:4325/v1',
      credentials,
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
    })

    const loggedIn = await host.login({ username: 'manager@example.com', password: 'manager-pass' })
    expect(loggedIn).toMatchObject({ status: 'authenticated', user: { userId: 'manager-1' }, mustChangePassword: false })
    expect(JSON.stringify(loggedIn)).not.toContain('access-')
    expect(await credentials.readRecord(credentialKey('dsh-ai-coding-platform', 'account'))).toMatchObject({ kind: 'grant' })
    expect(await host.account()).toMatchObject({ status: 'authenticated', user: { displayName: '组织经理' } })
    expect(await host.accessSummary()).toMatchObject({
      organizations: expect.arrayContaining([expect.objectContaining({ organizationId: 'org-alpha' })]),
      projects: expect.arrayContaining([expect.objectContaining({ projectId: 'project-alpha' })]),
      assets: expect.arrayContaining([expect.objectContaining({ assetId: 'project-alpha', assetType: 'project' })]),
    })
    expect(await host.catalog('project-alpha')).toMatchObject({ status: 'ready', catalog: { items: [{ skillId: 'code-review' }] } })
    expect(await host.refreshAccount()).toMatchObject({ status: 'authenticated' })
    expect(await host.logout()).toEqual({ status: 'signed-out' })
    expect(await credentials.readRecord(credentialKey('dsh-ai-coding-platform', 'account'))).toBeUndefined()
  })

  it('refreshes an expired Host credential before reading a project catalog', async () => {
    const service = createTeamSkillService({ port: 4327 })
    services.push(service)
    await service.listen()
    const records = new Map<CredentialKey, CredentialRecord>()
    const credentials = {
      readRecord: async (key: CredentialKey) => records.get(key),
      modifyRecord: async (key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      deleteRecord: async (key: CredentialKey) => { records.delete(key) },
    } as unknown as CredentialProvider
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-expired-')); roots.push(root)
    let expiredAccessToken: string | undefined
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (expiredAccessToken !== undefined && authorization === `Bearer ${expiredAccessToken}` && String(input).includes('/team-skills?')) {
        return new Response(JSON.stringify({ code: 'TOKEN_EXPIRED', message: '会话已过期' }), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      return globalThis.fetch(input, init)
    }
    const host = new TeamSkillHost({ apiBaseUrl: 'http://127.0.0.1:4327/v1', credentials, fetch, stateDirectory: join(root, 'state'), globalSkillRoot: join(root, 'global-skills') })
    expect((await host.login({ username: 'manager@example.com', password: 'manager-pass' })).status).toBe('authenticated')
    const key = credentialKey('dsh-ai-coding-platform', 'account')
    const current = await credentials.readRecord(key)
    if (current === undefined || current.kind !== 'grant') throw new Error('Expected Host grant credential.')
    const currentPayload = accountGrantPayload(current)
    expiredAccessToken = currentPayload.accessToken
    records.set(key, { ...current, payload: { ...currentPayload.record, expiresAt: 0 } })

    const catalog = await host.catalog('project-alpha')
    expect(catalog).toMatchObject({ status: 'ready', catalog: { items: [{ skillId: 'code-review' }] } })
    const refreshed = await credentials.readRecord(key)
    if (refreshed === undefined || refreshed.kind !== 'grant') throw new Error('Expected refreshed Host grant credential.')
    expect(accountGrantPayload(refreshed).accessToken).not.toBe(expiredAccessToken)
  })

  it('clears a Host session rejected after the in-memory service restarts', async () => {
    const firstService = createTeamSkillService({ port: 4328 })
    await firstService.listen()
    const records = new Map<CredentialKey, CredentialRecord>()
    const credentials = {
      readRecord: async (key: CredentialKey) => records.get(key),
      modifyRecord: async (key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      deleteRecord: async (key: CredentialKey) => { records.delete(key) },
    } as unknown as CredentialProvider
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-restarted-')); roots.push(root)
    const host = new TeamSkillHost({
      apiBaseUrl: 'http://127.0.0.1:4328/v1',
      credentials,
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
    })

    expect((await host.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
    const key = credentialKey('dsh-ai-coding-platform', 'account')
    expect(await credentials.readRecord(key)).toMatchObject({ kind: 'grant' })
    await new Promise<void>((resolve, reject) => {
      firstService.server.close(error => { if (error === undefined) resolve(); else reject(error) })
    })
    const restartedService = createTeamSkillService({ port: 4328 })
    services.push(restartedService)
    await restartedService.listen()

    expect(await host.account()).toEqual({ status: 'signed-out' })
    expect(await credentials.readRecord(key)).toBeUndefined()
  })

  it('installs a published service artifact into the DSH project root and records the result', async () => {
    const service = createTeamSkillService({ port: 4322 })
    services.push(service)
    await service.listen()
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-e2e-')); roots.push(root)
    const project = join(root, 'project')
    const host = new TeamSkillHost({
      apiBaseUrl: 'http://127.0.0.1:4322/v1',
      accessToken: 'demo-token',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      resolveWorkspace: workspaceId => workspaceId === 'workspace-1' ? project : undefined,
      refreshSkillCatalog: async (_scope, workspacePath, runtimeName) => {
        return await readFile(join(workspacePath ?? root, '.dsh', 'skills', runtimeName, 'SKILL.md'), 'utf8').then(() => true, () => false)
      },
    })

    const catalog = await host.catalog('project-alpha')
    expect(catalog.status).toBe('ready')
    if (catalog.status !== 'ready') return
    const item = catalog.catalog.items[0]!
    const result = await host.install({
      skillId: item.skillId,
      version: item.version,
      projectId: 'project-alpha',
      scope: 'project',
      workspaceId: 'workspace-1',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })

    expect(result.status).toBe('succeeded')
    expect(await readFile(join(project, '.dsh', 'skills', item.runtimeName, 'SKILL.md'), 'utf8')).toContain('代码评审')
    expect(service.audits).toHaveLength(1)
    expect(service.audits[0]).toMatchObject({ skillName: 'code-review', version: '1.0.0', scope: 'project', result: 'succeeded' })
    expect(JSON.stringify(service.audits)).not.toContain(project)
  })

  it('runs author governance, Host installation, withdrawal and quarantine over real HTTP', async () => {
    const service = createTeamSkillService({ port: 4326, seed: false })
    services.push(service)
    await service.listen()
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-full-flow-')); roots.push(root)
    const baseUrl = 'http://127.0.0.1:4326/v1'
    const authorHeaders = { authorization: 'Bearer manager-demo', 'content-type': 'application/json' }
    const adminHeaders = { authorization: 'Bearer admin-demo', 'content-type': 'application/json' }

    const createdResponse = await fetch(`${baseUrl}/admin/team-skills`, {
      method: 'POST', headers: { ...authorHeaders, 'idempotency-key': 'flow-draft' },
      body: JSON.stringify({ display_name: 'E2E Team Skill', summary: '端到端联调 Skill', visibility: 'organization' }),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { skillId: string; revision: number; runtimeName: string }
    const detailResponse = await fetch(`${baseUrl}/admin/team-skills/${created.skillId}`, { headers: authorHeaders })
    const detail = await detailResponse.json() as { skill: { revision: number }; versions: Array<{ version: string; revision: number }> }
    const draftVersion = detail.versions[0]!
    const artifact = zipSync({
      'SKILL.md': strToU8(`---\nname: ${created.runtimeName}\ndescription: 端到端联调 Skill\n---\n\n# E2E Team Skill\n`),
    })
    const uploadedResponse = await fetch(`${baseUrl}/admin/team-skills/${created.skillId}/versions/${draftVersion.version}/artifact`, {
      method: 'PUT', headers: { ...authorHeaders, 'content-type': 'application/zip', 'if-match': String(draftVersion.revision), 'idempotency-key': 'flow-artifact' }, body: artifact,
    })
    expect(uploadedResponse.status).toBe(200)
    const uploaded = await uploadedResponse.json() as { skill: { revision: number }; version: { version: string; revision: number; validation: Array<{ status: string }> } }
    expect(uploaded.version.validation.every(item => item.status === 'passed')).toBe(true)

    const submittedResponse = await fetch(`${baseUrl}/admin/team-skills/${created.skillId}/versions/${uploaded.version.version}/submit-review`, {
      method: 'POST', headers: { ...authorHeaders, 'if-match': String(uploaded.version.revision), 'x-skill-revision': String(uploaded.skill.revision), 'idempotency-key': 'flow-submit' }, body: '{}',
    })
    expect(submittedResponse.status).toBe(200)
    const reviewResponse = await fetch(`${baseUrl}/admin/team-skill-reviews`, { headers: adminHeaders })
    const review = (await reviewResponse.json() as Array<{ skill: { revision: number }; version: { version: string; revision: number } }>)[0]!
    const approvedResponse = await fetch(`${baseUrl}/admin/team-skills/${created.skillId}/versions/${review.version.version}/approve`, {
      method: 'POST', headers: { ...adminHeaders, 'if-match': String(review.version.revision), 'x-skill-revision': String(review.skill.revision), 'idempotency-key': 'flow-approve' }, body: JSON.stringify({ checks: { 'check-1': 'pass', 'check-2': 'pass', 'check-3': 'pass' } }),
    })
    expect(approvedResponse.status).toBe(200)
    const approved = await approvedResponse.json() as { skill: { revision: number }; version: { version: string; revision: number } }
    const publishedResponse = await fetch(`${baseUrl}/admin/team-skills/${created.skillId}/versions/${approved.version.version}/publish`, {
      method: 'POST', headers: { ...adminHeaders, 'if-match': String(approved.version.revision), 'x-skill-revision': String(approved.skill.revision), 'idempotency-key': 'flow-publish' }, body: '{}',
    })
    expect(publishedResponse.status).toBe(200)
    const published = await publishedResponse.json() as { skill: { revision: number }; version: { version: string; revision: number } }

    const host = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: 'demo-token',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      refreshSkillCatalog: async (_scope, _workspacePath, runtimeName, expectedPresent = true) => access(join(root, 'global-skills', runtimeName, 'SKILL.md')).then(() => expectedPresent, () => !expectedPresent),
    })
    const catalog = await host.catalog('project-alpha')
    expect(catalog.status).toBe('ready')
    if (catalog.status !== 'ready') return
    const item = catalog.catalog.items.find(value => value.skillId === created.skillId)
    expect(item).toBeDefined()
    if (item === undefined) return
    const installed = await host.install({
      skillId: item.skillId,
      version: item.version,
      projectId: 'project-alpha',
      scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(installed.status).toBe('succeeded')
    expect(await readFile(join(root, 'global-skills', item.runtimeName, 'SKILL.md'), 'utf8')).toContain('E2E Team Skill')

    const withdrawnResponse = await fetch(`${baseUrl}/admin/team-skills/${created.skillId}/versions/${published.version.version}/withdraw`, {
      method: 'POST', headers: { ...adminHeaders, 'if-match': String(published.version.revision), 'x-skill-revision': String(published.skill.revision), 'idempotency-key': 'flow-withdraw' }, body: JSON.stringify({ reason: '端到端回归下线' }),
    })
    expect(withdrawnResponse.status).toBe(200)
    const synced = await host.syncReleaseStatus('project-alpha')
    expect(synced).toMatchObject([{ skillId: created.skillId, state: 'withdrawn', version: published.version.version }])
    await expect(access(join(root, 'global-skills', item.runtimeName))).rejects.toThrow()
    if (!Array.isArray(synced)) return
    const withdrawn = synced.find(value => value.skillId === created.skillId)
    expect(withdrawn).toBeDefined()
    if (withdrawn === undefined) return
    expect(await readFile(join(root, 'state', 'quarantine', withdrawn.localInstallationId, item.runtimeName, 'SKILL.md'), 'utf8')).toContain('E2E Team Skill')
  })
})
