// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ClientRemote, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { PlatformSurfaceProps } from '../src/client/PlatformSurface.tsx'
import { PlatformEntry } from '../src/client/PlatformEntry.tsx'
import { PlatformSurface } from '../src/client/PlatformSurface.tsx'
import { PlatformDemoController } from '../src/client/controller.ts'

afterEach(() =>{  cleanup(); window.localStorage.clear() })

const copy = {
  'platform.name': '编程协作台',
  'platform.shortName': '协作台',
  'platform.open': '打开编程协作台',
  'platform.close': '关闭编程协作台',
  'platform.demo': '演示数据',
  'platform.offline': '服务端未连接',
}

const t = (key: string): string => copy[key as keyof typeof copy] ?? key

const demoCatalog = {
  status: 'ready' as const,
  catalog: { items: [{ skillId: 'skill-review', displayName: '代码评审', runtimeName: 'code-review', summary: '按团队规范检查风险、测试和变更边界。', version: '2.4.0', category: '质量', tags: ['质量'], publishedAt: '2026-08-29T08:00:00Z' }] },
}

const demoAccount = {
  status: 'authenticated' as const,
  user: {
    userId: 'member-1', username: 'member@example.com', email: 'member@example.com',
    displayName: '成员甲', status: 'active' as const, globalRole: 'member' as const, mustChangePassword: false, revision: 1,
  },
  memberships: [{ organizationId: 'org-1', organizationName: '星河平台', status: 'active' as const, revision: 1 }],
  mustChangePassword: false,
}

const demoOrganizations = [{ organizationId: 'org-1', name: '星河平台', status: 'active' as const, revision: 1 }]
const demoProject = {
  projectId: 'orbit-ui', organizationId: 'org-1', organizationName: '星河平台', name: 'AI开放平台', description: 'AI 开放平台项目', status: 'active' as const,
  createdBy: 'manager-1', createdAt: '2026-08-29T08:00:00Z', updatedAt: '2026-08-29T08:00:00Z', memberCount: 1, assetCount: 1, revision: 1,
}
const demoProjectDetail = {
  project: demoProject,
  assets: [{ projectId: 'orbit-ui', assetType: 'skill' as const, assetId: 'skill-review', name: '代码评审', relationKind: 'reference' as const, createdAt: '2026-08-29T08:00:00Z', updatedAt: '2026-08-29T08:00:00Z', revision: 1 }],
}
const demoKnowledgeBases = [
  { knowledgeBaseId: 'k-1', name: 'DSH 会话事件与模型可见性规范', description: '会话日志与模型可见性要求。', type: 'document' as const, state: 'active' as const, searchable: true, updatedAt: '2026-08-29T08:00:00Z', revision: 1 },
  { knowledgeBaseId: 'k-2', name: '远程执行目标接入手册', description: '远程执行目标的接入约定。', type: 'document' as const, state: 'active' as const, searchable: true, updatedAt: '2026-08-29T08:00:00Z', revision: 1 },
]
const demoAccess = {
  organizations: demoOrganizations,
  projects: [demoProject],
  assets: [
    { assetId: 'orbit-ui', assetType: 'project' as const, name: 'AI开放平台', visibility: 'project' as const, organizationId: 'org-1', projectId: 'orbit-ui' },
    { assetId: 'skill-review', assetType: 'skill' as const, name: '代码评审', visibility: 'project' as const, organizationId: 'org-1', projectId: 'orbit-ui' },
    { assetId: 'k-1', assetType: 'knowledge' as const, name: 'DSH 规范', visibility: 'organization' as const, organizationId: 'org-1' },
    { assetId: 'k-2', assetType: 'knowledge' as const, name: '接入手册', visibility: 'organization' as const, organizationId: 'org-1' },
    { assetId: 'm-1', assetType: 'memory' as const, name: '稳定错误码', visibility: 'organization' as const, organizationId: 'org-1' },
    { assetId: 'm-4', assetType: 'memory' as const, name: '采集失败不阻塞', visibility: 'organization' as const, organizationId: 'org-1' },
  ],
  management: { organizationIds: [], projectIds: [] }, revision: 1,
}

const demoWorkspaceState: WorkspaceListState = {
  items: [{ workspaceId: 'ws-1' as WorkspaceId, title: 'AI开放平台', path: 'hidden', sessionIds: [], createdAt: '2026-08-29T08:00:00Z', updatedAt: '2026-08-29T08:00:00Z' }],
  archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: 'ws-1' as WorkspaceId,
}

const demoSessionState = { current: 'session-1', byId: { 'session-1': { blank: false } } }

function demoRemote(): ClientRemote {
  return {
    teamSkills: {
      account: vi.fn(async () => ({ ok: true, value: demoAccount })),
      login: vi.fn(async () => ({ ok: true, value: demoAccount })),
      refreshAccount: vi.fn(async () => ({ ok: true, value: demoAccount })),
      changePassword: vi.fn(async () => ({ ok: true, value: demoAccount })),
      logout: vi.fn(async () => ({ ok: true, value: { status: 'signed-out' as const } })),
      organizations: vi.fn(async () => ({ ok: true, value: demoOrganizations })),
      projects: vi.fn(async () => ({ ok: true, value: [demoProject] })),
      project: vi.fn(async () => ({ ok: true, value: demoProjectDetail })),
      knowledgeBases: vi.fn(async () => ({ ok: true, value: demoKnowledgeBases })),
      knowledgeSearch: vi.fn(async () => ({ ok: true, value: { status: 'ready' as const, response: { requestId: 'req-1', results: [], knowledgeBases: [] } } })),
      knowledgePreview: vi.fn(async () => ({ ok: true, value: { knowledgeBaseId: 'k-1', documentId: 'doc-1', title: '预览', previewUrl: 'https://service.test/preview/doc-1' } })),
      configureKnowledgeSelection: vi.fn(async () => ({ ok: true as const, value: undefined })),
      clearKnowledgeSelection: vi.fn(async () => ({ ok: true as const, value: undefined })),
      accessSummary: vi.fn(async () => ({ ok: true, value: demoAccess })),
      catalog: vi.fn(async () => ({ ok: true, value: demoCatalog })),
      installations: vi.fn(async () => ({ ok: true, value: [] })),
      syncReleaseStatus: vi.fn(async () => ({ ok: true, value: [] })),
      uninstallSkill: vi.fn(async () => ({ ok: true, value: [] })),
      installSkill: vi.fn(async () => ({ ok: true, value: { status: 'succeeded', installation: { localInstallationId: 'local-1', skillId: 'skill-review', projectId: 'orbit-ui', scope: 'project', workspaceId: 'ws-1', runtimeName: 'code-review', version: '2.4.0', artifactSha256: 'abc', state: 'normal', installedAt: '2026-08-29T08:00:00Z' } } })),
    },
  } as unknown as ClientRemote
}

function signedOutRemote(): ClientRemote {
  const remote = demoRemote()
  remote.teamSkills.account = vi.fn(async () => ({ ok: true as const, value: { status: 'signed-out' as const } }))
  return remote
}

function mountSurface(controller = new PlatformDemoController(), remote = demoRemote()) {
  const props = {
    controller,
    t,
    useSessions: (<S,>(selector: (state: typeof demoSessionState) => S): S => selector(demoSessionState)) as never,
    useWorkspaces: (<S,>(selector: (state: WorkspaceListState) => S): S => selector(demoWorkspaceState)) as never,
    remote,
  } as PlatformSurfaceProps
  return { controller, ...render(<PlatformSurface {...props} />) }
}

it('binds selected knowledge bases to the current native DSH session and clears them on project changes', async () => {
  const controller = new PlatformDemoController()
  controller.open()
  const remote = demoRemote()
  mountSurface(controller, remote)

  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui'))
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '知识库' }))
  await screen.findByText('DSH 会话事件与模型可见性规范')
  const knowledgeRow = screen.getByText('DSH 会话事件与模型可见性规范').closest('label')
  if (knowledgeRow === null) throw new Error('knowledge row not found')
  fireEvent.click(knowledgeRow.querySelector('input'))

  await waitFor(() => expect(remote.teamSkills.configureKnowledgeSelection).toHaveBeenCalledWith('session-1', {
    projectId: 'orbit-ui',
    knowledgeBaseIds: ['k-1'],
  }))

  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: '' } })
  await waitFor(() => expect(remote.teamSkills.clearKnowledgeSelection).toHaveBeenCalledWith('session-1'))
})

it('shows a configure rejection and does not retain a local knowledge binding', async () => {
  const controller = new PlatformDemoController()
  controller.open()
  const remote = demoRemote()
  remote.teamSkills.configureKnowledgeSelection = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'SESSION_NOT_FOUND', message: '当前 DSH 会话已结束。', details: {} },
  }))
  mountSurface(controller, remote)

  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui'))
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '知识库' }))
  const knowledgeRow = (await screen.findByText('DSH 会话事件与模型可见性规范')).closest('label')
  if (knowledgeRow === null) throw new Error('knowledge row not found')
  fireEvent.click(knowledgeRow.querySelector('input'))

  expect((await screen.findByRole('alert')).textContent).toContain('当前 DSH 会话已结束。')
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: '' } })
  await waitFor(() => expect(remote.teamSkills.clearKnowledgeSelection).not.toHaveBeenCalled())
})

it('shows a clear rejection without attempting a new local binding', async () => {
  const controller = new PlatformDemoController()
  controller.open()
  const remote = demoRemote()
  remote.teamSkills.clearKnowledgeSelection = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'SESSION_NOT_FOUND', message: '当前 DSH 会话已结束。', details: {} },
  }))
  mountSurface(controller, remote)

  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui'))
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '知识库' }))
  const knowledgeRow = (await screen.findByText('DSH 会话事件与模型可见性规范')).closest('label')
  if (knowledgeRow === null) throw new Error('knowledge row not found')
  fireEvent.click(knowledgeRow.querySelector('input'))
  await waitFor(() => expect(remote.teamSkills.configureKnowledgeSelection).toHaveBeenCalled())

  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: '' } })
  expect((await screen.findByRole('alert')).textContent).toContain('当前 DSH 会话已结束。')
  expect(remote.teamSkills.configureKnowledgeSelection).toHaveBeenCalledTimes(1)
})

describe('AI Coding platform demo', () => {
  it('enters the asset overview immediately after Host authentication', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    const props = {
      controller,
      t,
      useSessions: (() => ({ current: undefined, byId: {} })) as never,
      useWorkspaces: (<S,>(selector: (state: WorkspaceListState) => S): S => selector(demoWorkspaceState)) as never,
      remote: signedOutRemote(),
    } as PlatformSurfaceProps
    render(<PlatformSurface {...props} />)

    expect(await screen.findByRole('heading', { name: '登录你的编程协作台' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeNull()

    fireEvent.change(screen.getByLabelText('工作邮箱'), { target: { value: 'member@example.com' } })
    fireEvent.change(screen.getByLabelText('访问密码'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '选择项目' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '选择组织' })).toBeNull()
  })

  it('shows an explicit service error when access loading rejects', async () => {
    const remote = demoRemote()
    remote.teamSkills.projects = vi.fn(async () => { throw new Error('项目访问接口未装配') })
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller, remote)

    expect(await screen.findByRole('heading', { name: '账号服务暂不可用' })).toBeTruthy()
    expect(screen.getByText('项目访问接口未装配')).toBeTruthy()
  })

  it('opens from the sidebar entry and closes from the overlay', () => {
    const controller = new PlatformDemoController()
    const onOpen = () =>{  controller.open(); }
    const entryProps = {
      wide: true,
      onOpen,
      t,
      useSessions: (() => ({ current: undefined, byId: {} })) as never,
      useWorkspaces: (() => ({})) as never,
    } as Parameters<typeof PlatformEntry>[0]
    const entry = render(<PlatformEntry {...entryProps} />)
    fireEvent.click(screen.getByRole('button', { name: '打开编程协作台' }))
    expect(controller.getSnapshot()).toBe(true)
    entry.unmount()

    mountSurface(controller)
    fireEvent.click(screen.getByRole('button', { name: '关闭编程协作台' }))
    expect(controller.getSnapshot()).toBe(false)
  })

  it('leaves the native DSH surface visible until the sidebar entry is clicked', () => {
    const controller = new PlatformDemoController()
    mountSurface(controller)
    expect(screen.queryByRole('dialog', { name: '编程协作台' })).toBeNull()
  })

  it('keeps non-Skill demo modules available while Skill uses the Host Remote', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller)

    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: '平台模块' })
    fireEvent.click(within(nav).getByRole('button', { name: '团队 Skill' }))
    expect(await screen.findByRole('heading', { name: '选择项目后查看 Skill' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'AI开放平台' }))
    await waitFor(() =>{  expect(screen.getByRole('heading', { name: '把已发布能力安装到本地 DSH' })).toBeTruthy(); })
    fireEvent.click(screen.getByRole('button', { name: '安装 Skill' }))
    fireEvent.click(screen.getByRole('button', { name: '确认安装到当前项目' }))
    expect(await screen.findByText('已安装到当前项目')).toBeTruthy()

    fireEvent.click(within(nav).getByRole('button', { name: '知识库' }))
    expect(await screen.findByText('远程执行目标接入手册')).toBeTruthy()

    fireEvent.click(within(nav).getByRole('button', { name: '记忆库' }))
    fireEvent.click(screen.getByRole('button', { name: /^团队$/ }))
    expect(screen.getByText('2 条')).toBeTruthy()

    fireEvent.click(within(nav).getByRole('button', { name: '数据采集' }))
    fireEvent.click(screen.getByRole('button', { name: '暂停采集' }))
    expect(screen.getByText('已暂停')).toBeTruthy()

    fireEvent.click(within(nav).getByRole('button', { name: 'Agent 配置' }))
    expect(screen.getByRole('heading', { name: '管理云平台里的 Coding Agent' })).toBeTruthy()
    expect(screen.getAllByText('DeepSeek-V3').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /交付工程 Agent/ }))
    expect(screen.getByText('DeepSeek-Coder-V2')).toBeTruthy()
    expect(screen.getByText('128k')).toBeTruthy()

    expect(screen.queryByRole('button', { name: '工作台' })).toBeNull()

    fireEvent.click(within(nav).getByRole('button', { name: '项目' }))
    expect(screen.getByRole('heading', { name: 'AI开放平台', level: 1 })).toBeTruthy()
    expect(screen.getByText('项目级操作由后台管理')).toBeTruthy()
    expect(screen.queryByText('任务列表')).toBeNull()
  })

  it('does not render knowledge or memory outside the selected project access summary', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller)

    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: '平台模块' })
    fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
    await waitFor(() => expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui'))
    fireEvent.click(within(nav).getByRole('button', { name: '知识库' }))
    expect(screen.getByText('DSH 会话事件与模型可见性规范')).toBeTruthy()
    expect(screen.queryByText('前端组件可访问性基线')).toBeNull()

    fireEvent.click(within(nav).getByRole('button', { name: '记忆库' }))
    expect(screen.getByText('运行时错误必须保留稳定错误码')).toBeTruthy()
    expect(screen.queryByText('AI开放平台的弹窗统一使用 12px 圆角')).toBeNull()
  })

  it('does not render a Team Skill outside the selected project access summary', async () => {
    const remote = demoRemote()
    remote.teamSkills.catalog = vi.fn(async () => ({
      ok: true as const,
      value: {
        status: 'ready' as const,
        catalog: {
          items: [
            ...demoCatalog.catalog.items,
            { skillId: 'restricted-skill', displayName: '受限 Skill', runtimeName: 'restricted-skill', summary: '不应向当前项目显示。', version: '1.0.0', category: '质量', tags: ['受限'], publishedAt: '2026-08-30T00:00:00Z' },
          ],
        },
      },
    }))
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller, remote)

    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: '平台模块' })
    fireEvent.click(within(nav).getByRole('button', { name: '团队 Skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'AI开放平台' }))

    expect(await screen.findByText('代码评审')).toBeTruthy()
    expect(screen.queryByText('受限 Skill')).toBeNull()
  })

  it.each(['PROJECT_NOT_MEMBER', 'RESOURCE_NOT_FOUND', 'NO_ORGANIZATION_ACCESS'])(
    'refreshes the service authorization after Team Skill returns %s',
    async (code) => {
      const remote = demoRemote()
      remote.teamSkills.catalog = vi.fn(async () => ({
        ok: false as const,
        error: { code, message: '当前项目授权已变更。', details: {} },
      }))
      remote.teamSkills.accessSummary = vi.fn()
        .mockResolvedValueOnce({ ok: true, value: demoAccess })
        .mockResolvedValueOnce({
          ok: true,
          value: { ...demoAccess, projects: [], assets: [] },
        }).mockResolvedValue({ ok: true, value: { ...demoAccess, projects: [], assets: [] } })
      remote.teamSkills.projects = vi.fn()
        .mockResolvedValueOnce({ ok: true, value: [demoProject] })
        .mockResolvedValue({ ok: true, value: [] })
      const controller = new PlatformDemoController()
      controller.open()
      mountSurface(controller, remote)

      expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
      const nav = screen.getByRole('navigation', { name: '平台模块' })
      fireEvent.click(within(nav).getByRole('button', { name: '团队 Skill' }))
      fireEvent.click(screen.getByRole('button', { name: 'AI开放平台' }))

      expect(await screen.findByText('当前账号没有可访问的项目。')).toBeTruthy()
    },
  )

  it('shows the local login state after signing out', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller)
    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: '账号与权限：成员甲' }))
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    expect(await screen.findByRole('heading', { name: '登录你的编程协作台' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('工作邮箱'), { target: { value: 'member@example.com' } })
    fireEvent.change(screen.getByLabelText('访问密码'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  })

  it('keeps the selected project while a detail refresh fails', async () => {
    const remote = demoRemote()
    remote.teamSkills.project = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: demoProjectDetail })
      .mockResolvedValueOnce({ ok: false as const, error: { code: 'NETWORK_ERROR', message: '服务暂时不可用', details: {} } })
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller, remote)
    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
    await waitFor(() =>{ expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui') })
    fireEvent.click(screen.getByRole('button', { name: '项目' }))
    const projectSelect = screen.getByRole('combobox', { name: '查看项目' })
    fireEvent.change(projectSelect, { target: { value: 'orbit-ui' } })
    await waitFor(() =>{ expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui') })
    expect(screen.queryByText('代码评审')).toBeNull()
    expect(screen.getByText('服务暂时不可用')).toBeTruthy()
  })
})
