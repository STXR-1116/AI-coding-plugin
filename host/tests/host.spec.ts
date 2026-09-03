import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
/* oxlint-disable typescript/no-base-to-string -- Fetch spy assertions inspect RequestInfo and BodyInit wire values. */
/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { zipSync, strToU8 } from 'fflate'
import { TeamSkillHost } from '../src/host.ts'

const RUNTIME_NAME = 'aicp-code-review'
const VERSION = '1.2.0'

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function artifact(): Uint8Array {
  return zipSync({
    'SKILL.md': strToU8(`---\nname: ${RUNTIME_NAME}\ndescription: 团队代码评审流程\n---\n`),
  })
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('TeamSkillHost', () => {
  it('reports not-ready without a configured service endpoint and token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const host = new TeamSkillHost({ stateDirectory: root })

    expect(await host.catalog('project-alpha')).toEqual({
      status: 'not-ready',
      missing: ['apiBaseUrl', 'accessToken'],
    })
  })

  it('installs an authorized platform artifact and reports progress without a local path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const projectRoot = join(root, 'project')
    const archive = artifact()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          operation_id: 'operation-1',
          status: 'authorized',
          skill_id: 'skill-1',
          runtime_name: RUNTIME_NAME,
          version: VERSION,
          artifact: {
            download_url: 'https://service.example.test/downloads/operation-1',
            expires_at: '2026-08-29T12:00:00Z',
            sha256: sha256(archive),
            size_bytes: archive.byteLength,
            files: [{ path: 'SKILL.md', sha256: sha256(strToU8(`---\nname: ${RUNTIME_NAME}\ndescription: 团队代码评审流程\n---\n`)) }],
          },
        }),
      )
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(new Response(new Uint8Array(archive).buffer))
      .mockImplementation(async input =>
        String(input).includes('/team-skills/release-status')
          ? response({ items: [{ skill_id: 'skill-1', project_id: 'project-alpha', version: VERSION, status: 'published' }] })
          : response({ accepted: true }),
      )
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      accessToken: 'token-1',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      fetch,
      resolveWorkspace: id => (id === 'workspace-1' ? projectRoot : undefined),
      refreshSkillCatalog: async () => true,
    })

    const result = await host.install({
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-alpha',
      scope: 'project',
      workspaceId: 'workspace-1',
      environment: {
        dshVersion: '0.1.1',
        availableTools: [],
        availableMcpServers: [],
        presentEnvironmentVariableNames: [],
      },
    })

    expect(result.status).toBe('succeeded')
    expect(result).not.toHaveProperty('installation.installed.directory')
    const installations = await host.installations('project-alpha')
    expect(installations).toHaveLength(1)
    expect(installations).toMatchObject([{ projectId: 'project-alpha' }])
    expect(installations).not.toHaveProperty('0.installed.directory')
    expect(await host.installations('project-beta')).toEqual([])
    expect(await readFile(join(projectRoot, '.dsh', 'skills', RUNTIME_NAME, 'SKILL.md'), 'utf8')).toContain('团队代码评审流程')
    expect(fetch.mock.calls[0]).toMatchObject([
      'https://service.example.test/v1/team-skill-installations',
      {
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer token-1' }),
      },
    ])
    const eventBodies = fetch.mock.calls
      .filter(([url]) => String(url).includes('/events'))
      .map(([, init]) => parseJsonBody(init?.body))
    expect(eventBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'downloading', event_sequence: 1 }),
        expect.objectContaining({ status: 'succeeded' }),
      ]),
    )
    expect(JSON.stringify(eventBodies)).not.toContain(projectRoot)
  })

  it('uninstalls a managed copy and confirms that native discovery no longer sees it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const archive = artifact()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          operation_id: 'operation-1',
          status: 'authorized',
          skill_id: 'skill-1',
          runtime_name: RUNTIME_NAME,
          version: VERSION,
          artifact: {
            download_url: 'https://service.example.test/downloads/operation-1',
            expires_at: '2026-08-29T12:00:00Z',
            sha256: sha256(archive),
            size_bytes: archive.byteLength,
            files: [{ path: 'SKILL.md', sha256: sha256(strToU8(`---\nname: ${RUNTIME_NAME}\ndescription: 团队代码评审流程\n---\n`)) }],
          },
        }),
      )
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(new Response(new Uint8Array(archive).buffer))
      .mockImplementation(async () => response({ accepted: true }))
    const discovered: boolean[] = []
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      accessToken: 'token-1',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      fetch,
      refreshSkillCatalog: async (_scope, _workspacePath, _runtimeName, expectedPresent = true) => {
        discovered.push(expectedPresent)
        return true
      },
    })
    const installed = await host.install({
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-alpha',
      scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(installed.status).toBe('succeeded')
    if (installed.status !== 'succeeded') return
    const removed = await host.uninstall({ localInstallationId: installed.installation.localInstallationId })
    expect(removed).toMatchObject({ status: 'succeeded', installation: { state: 'uninstalled' } })
    expect(discovered).toEqual([true, false])
  })

  it('quarantines and hides a managed copy omitted from the authoritative release response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const archive = artifact()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          operation_id: 'operation-1',
          status: 'authorized',
          skill_id: 'skill-1',
          runtime_name: RUNTIME_NAME,
          version: VERSION,
          artifact: {
            download_url: 'https://service.example.test/downloads/operation-1',
            expires_at: '2026-08-29T12:00:00Z',
            sha256: sha256(archive),
            size_bytes: archive.byteLength,
            files: [{ path: 'SKILL.md', sha256: sha256(strToU8(`---\nname: ${RUNTIME_NAME}\ndescription: 团队代码评审流程\n---\n`)) }],
          },
        }),
      )
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(new Response(new Uint8Array(archive).buffer))
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(response({ items: [] }))
    const discovered: boolean[] = []
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      accessToken: 'token-1',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      fetch,
      refreshSkillCatalog: async (_scope, _workspacePath, _runtimeName, expectedPresent = true) => {
        discovered.push(expectedPresent)
        return true
      },
    })
    const installed = await host.install({
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-alpha',
      scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(installed.status).toBe('succeeded')
    const synced = await host.syncReleaseStatus('project-alpha')
    expect(synced).toEqual([])
    const releaseStatusCall = fetch.mock.calls.find(([url]) => String(url).includes('/team-skills/release-status'))
    expect(parseJsonBody(releaseStatusCall?.[1]?.body)).toEqual({
      items: [{ skill_id: 'skill-1', version: VERSION, project_id: 'project-alpha' }],
    })
    expect(discovered).toEqual([true, false])
  })
})

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') throw new Error('Expected a JSON request body.')
  return JSON.parse(body) as unknown
}
