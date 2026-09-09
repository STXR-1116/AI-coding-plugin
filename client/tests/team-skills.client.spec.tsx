// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { TeamSkillsView } from '../src/client/team-skills/TeamSkillsView.tsx'

afterEach(() => {
  cleanup()
})

const environment = {
  dshVersion: '0.1.1-rc.2',
  availableTools: ['read_file'],
  availableMcpServers: [],
  presentEnvironmentVariableNames: [],
} as const

function workspaceState(items: WorkspaceListState['items']): WorkspaceListState {
  return {
    items,
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: items[0]?.workspaceId,
  }
}

const withWorkspace = <S,>(selector: (state: WorkspaceListState) => S): S =>
  selector(
    workspaceState([
      {
        workspaceId: 'ws-1' as WorkspaceId,
        title: 'AI开放平台',
        path: 'hidden',
        sessionIds: [],
        createdAt: '2026-08-29T08:00:00Z',
        updatedAt: '2026-08-29T08:00:00Z',
      },
    ]),
  )
const withoutWorkspace = <S,>(selector: (state: WorkspaceListState) => S): S => selector(workspaceState([]))

function remoteFor(
  catalog: () => Promise<unknown>,
  installations: () => Promise<unknown>,
  install: (request: unknown) => Promise<unknown>,
  uninstall: (request: unknown) => Promise<unknown> = async () => ({ ok: true, value: [] }),
): ClientRemote {
  return {
    teamSkills: { catalog, installations, syncReleaseStatus: installations, installSkill: install, uninstallSkill: uninstall },
  } as unknown as ClientRemote
}

const catalog = {
  status: 'ready' as const,
  catalog: {
    items: [
      {
        skillId: 'skill-review',
        displayName: '代码评审',
        runtimeName: 'code-review',
        summary: '按团队规范检查风险、测试和变更边界。',
        version: '2.4.0',
        category: '质量',
        tags: ['质量', '审核'],
        publishedAt: '2026-08-29T08:00:00Z',
      },
    ],
  },
}

describe('TeamSkillsView', () => {
  it('loads the server catalog and local installations without fake fallback data', async () => {
    const catalogCall = vi.fn(async () => ({ ok: true, value: catalog }))
    const installationsCall = vi.fn(async () => ({ ok: true, value: [] }))
    render(
      <TeamSkillsView
        remote={remoteFor(catalogCall, installationsCall, vi.fn())}
        useWorkspaces={withWorkspace}
        environment={environment}
        projectId="project-alpha"
        projects={[]}
      />,
    )

    expect(screen.getByText('正在读取团队 Skill')).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '代码评审' })).toBeTruthy()
    })
    expect(catalogCall).toHaveBeenCalledWith('project-alpha')
    expect(catalogCall).toHaveBeenCalledOnce()
    expect(installationsCall).toHaveBeenCalledWith('project-alpha')
    expect(installationsCall).toHaveBeenCalledOnce()
    expect(screen.getByText('平台托管版本 v2.4.0')).toBeTruthy()
  })

  it('requires a scope and sends the opaque workspace id for project installation', async () => {
    const installCall = vi.fn(async () => ({
      ok: true,
      value: {
        status: 'succeeded',
        installation: {
          localInstallationId: 'local-1',
          skillId: 'skill-review',
          projectId: 'project-alpha',
          scope: 'project',
          workspaceId: 'ws-1',
          runtimeName: 'code-review',
          version: '2.4.0',
          artifactSha256: 'abc',
          state: 'normal',
          installedAt: '2026-08-29T08:10:00Z',
        },
      },
    }))
    render(
      <TeamSkillsView
        remote={remoteFor(
          async () => ({ ok: true, value: catalog }),
          async () => ({ ok: true, value: [] }),
          installCall,
        )}
        useWorkspaces={withWorkspace}
        environment={environment}
        projectId="project-alpha"
        projects={[]}
      />,
    )
    await waitFor(() => screen.getByRole('heading', { name: '代码评审' }))

    fireEvent.click(screen.getByRole('button', { name: '安装 Skill' }))
    expect(screen.getByRole('dialog', { name: '安装代码评审' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认安装到当前项目' }))
    await waitFor(() => {
      expect(installCall).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: 'skill-review',
          version: '2.4.0',
          scope: 'project',
          workspaceId: 'ws-1',
          environment,
        }),
      )
    })
    expect(await screen.findByText('已安装到当前项目')).toBeTruthy()
  })

  it('disables project scope when there is no workspace and surfaces not-ready state', async () => {
    render(
      <TeamSkillsView
        remote={remoteFor(
          async () => ({ ok: true, value: catalog }),
          async () => ({ ok: true, value: [] }),
          vi.fn(),
        )}
        useWorkspaces={withoutWorkspace}
        environment={environment}
        projectId="project-alpha"
        projects={[]}
      />,
    )
    await waitFor(() => screen.getByRole('heading', { name: '代码评审' }))
    fireEvent.click(screen.getByRole('button', { name: '安装 Skill' }))
    expect(screen.getByRole('radio', { name: /当前项目/ })).toHaveProperty('disabled', true)
    expect(screen.getByText('当前没有可用的 DSH 工作区')).toBeTruthy()
  })

  it('renders service not-ready instead of a successful local fixture', async () => {
    render(
      <TeamSkillsView
        remote={remoteFor(
          async () => ({ ok: true, value: { status: 'not-ready', missing: ['apiBaseUrl'] } }),
          async () => ({ ok: true, value: [] }),
          vi.fn(),
        )}
        useWorkspaces={withoutWorkspace}
        environment={environment}
        projectId="project-alpha"
        projects={[]}
      />,
    )
    expect(await screen.findByRole('heading', { name: '团队 Skill 暂不可用' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '安装 Skill' })).toBeNull()
  })

  it('refreshes the account when the Host catalog reports an authorization failure', async () => {
    const refreshAuthorization = vi.fn()
    render(
      <TeamSkillsView
        remote={remoteFor(
          async () => ({ ok: true, value: { status: 'failed', code: 'UNAUTHORIZED', message: '需要有效的 Bearer 令牌' } }),
          async () => ({ ok: true, value: [] }),
          vi.fn(),
        )}
        useWorkspaces={withWorkspace}
        environment={environment}
        projectId="project-alpha"
        projects={[]}
        onAuthorizationFailure={refreshAuthorization}
      />,
    )

    expect(await screen.findByRole('heading', { name: '团队 Skill 暂不可用' })).toBeTruthy()
    expect(refreshAuthorization).toHaveBeenCalledOnce()
  })

  it('refreshes the account when Host installation sync reports an authorization failure', async () => {
    const refreshAuthorization = vi.fn()
    render(
      <TeamSkillsView
        remote={remoteFor(
          async () => ({ ok: true, value: catalog }),
          async () => ({ ok: true, value: { status: 'failed', code: 'TOKEN_REVOKED', message: '刷新令牌已失效' } }),
          vi.fn(),
        )}
        useWorkspaces={withWorkspace}
        environment={environment}
        projectId="project-alpha"
        projects={[]}
        onAuthorizationFailure={refreshAuthorization}
      />,
    )

    expect(await screen.findByRole('heading', { name: '无法读取本地安装状态' })).toBeTruthy()
    expect(refreshAuthorization).toHaveBeenCalledOnce()
  })
})
