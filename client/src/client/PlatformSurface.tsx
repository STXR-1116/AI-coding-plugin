/** Full-screen, browser-local demo surface for the first-party platform. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type {
  ClientRemote,
  TeamSkillAccessSummary,
  TeamSkillAccountResult,
  TeamSkillAccountState,
  TeamSkillAsset,
  TeamSkillChangePasswordRequest,
  TeamSkillEnvironment,
  TeamSkillLoginRequest,
  TeamSkillOrganization,
  TeamSkillProject,
  TeamSkillProjectAsset,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconArchiveOutline20,
  IconAgentPresetOutline16,
  IconCloseOutline16,
  IconCodeOutline16,
  IconDataOutline16,
  IconFolderOpenOutline16,
  IconGoalOutline16,
  IconInspectOutline12,
  IconPauseOutline16,
  IconPlayOutline16,
  IconQueueOutline14,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconSettingsOutline14,
  IconSkillOutline16,
  IconSparkle16,
  IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import type { PlatformDemoController } from './controller.ts'
import { TeamSkillsView } from './team-skills/TeamSkillsView.tsx'
import css from './PlatformSurface.module.css'

/** Full props for the root-scoped overlay slot. */
export type PlatformSurfaceProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & { controller: PlatformDemoController; remote: ClientRemote }

type ViewId = 'overview' | 'projects' | 'skills' | 'knowledge' | 'memory' | 'collector' | 'agent-config'
type IconComponent = ComponentType<{ size?: number; className?: string }>

interface NavItem {
  id: ViewId
  label: string
  hint: string
  icon: IconComponent
}

interface Project {
  id: string
  organizationId: string
  organizationName: string
  name: string
  description: string
  status: TeamSkillProject['status']
  createdBy: string
  createdAt: string
  updatedAt: string
  memberCount: number
  assetCount: number
  revision: number
}

interface KnowledgeItem {
  id: string
  title: string
  type: string
  source: string
  updated: string
  excerpt: string
  status: '已索引' | '索引中'
}

interface MemoryItem {
  id: string
  title: string
  scope: '项目' | '团队' | '个人'
  detail: string
  updated: string
  confidence: '高' | '中'
}

interface AgentConfig {
  id: string
  name: string
  description: string
  status: '运行中' | '已暂停'
  model: string
  reasoning: string
  accessMode: string
  skills: readonly string[]
  autoContext: boolean
  concurrency: number
  tokenBudget: string
  timeout: string
  updated: string
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'overview', label: '总览', hint: '项目与执行概况', icon: IconSparkle16 },
  { id: 'projects', label: '项目', hint: '权限范围内的项目', icon: IconFolderOpenOutline16 },
  { id: 'skills', label: '团队 Skill', hint: '团队能力目录', icon: IconSkillOutline16 },
  { id: 'knowledge', label: '知识库', hint: '项目资料与规范', icon: IconArchiveOutline20 },
  { id: 'memory', label: '记忆库', hint: '可复用的团队经验', icon: IconGoalOutline16 },
  { id: 'collector', label: '数据采集', hint: 'AI Coding 使用指标', icon: IconDataOutline16 },
  { id: 'agent-config', label: 'Agent 配置', hint: '云端 Agent 参数', icon: IconAgentPresetOutline16 },
]

const KNOWLEDGE: readonly KnowledgeItem[] = [
  { id: 'k-1', title: 'DSH 会话事件与模型可见性规范', type: '架构规范', source: '平台架构组', updated: '今天 09:18', excerpt: '任何到达模型请求的输入都必须能够从会话日志重建。', status: '已索引' },
  { id: 'k-2', title: '远程执行目标接入手册', type: '操作手册', source: '基础设施组', updated: '昨天 16:42', excerpt: '从注册、租约、心跳到断线恢复的完整接入流程。', status: '已索引' },
  { id: 'k-3', title: '前端组件可访问性基线', type: '质量规范', source: '设计系统组', updated: '周一 11:05', excerpt: '键盘焦点、文本对比度和减少动态效果的检查清单。', status: '已索引' },
  { id: 'k-4', title: '采集字段与脱敏规则', type: '数据规范', source: '数据平台组', updated: '周五 14:20', excerpt: '采集提示词摘要、模型和令牌，丢弃凭证与不必要的源码正文。', status: '索引中' },
]

const MEMORIES: readonly MemoryItem[] = [
  { id: 'm-1', title: '运行时错误必须保留稳定错误码', scope: '团队', detail: '展示层可翻译错误文案，但诊断和审计依赖稳定 code。', updated: '今天', confidence: '高' },
  { id: 'm-2', title: 'AI开放平台的弹窗统一使用 12px 圆角', scope: '项目', detail: '对话框、菜单和浮层共享同一圆角规则，按钮保持 8px。', updated: '昨天', confidence: '高' },
  { id: 'm-3', title: '本地回放优先验证空状态和断线状态', scope: '个人', detail: '每次录制演示前先清理浏览器状态，再覆盖异常路径。', updated: '3 天前', confidence: '中' },
  { id: 'm-4', title: '采集失败不能阻塞主对话', scope: '团队', detail: '批量上传允许延迟和重试，主会话只接收可观测告警。', updated: '上周', confidence: '高' },
]

const AGENTS: readonly AgentConfig[] = [
  {
    id: 'frontend-reviewer', name: '前端评审 Agent', description: '面向组件、交互和可访问性变更的代码评审助手。', status: '运行中',
    model: 'DeepSeek-V3', reasoning: '高', accessMode: '只读评审', skills: ['代码评审', '前端交互规范'], autoContext: true,
    concurrency: 3, tokenBudget: '64k', timeout: '10 分钟', updated: '今天 10:24',
  },
  {
    id: 'delivery-engineer', name: '交付工程 Agent', description: '根据项目任务执行实现、测试和交付检查。', status: '运行中',
    model: 'DeepSeek-Coder-V2', reasoning: '中高', accessMode: '工作区读写', skills: ['代码评审', '接口设计', '前端交互规范'], autoContext: true,
    concurrency: 2, tokenBudget: '128k', timeout: '30 分钟', updated: '昨天 18:06',
  },
  {
    id: 'incident-helper', name: '线上排障 Agent', description: '关联日志、指标和变更记录，辅助定位线上问题。', status: '已暂停',
    model: 'DeepSeek-V3', reasoning: '中', accessMode: '日志与知识库', skills: ['线上排障', '知识库检索'], autoContext: false,
    concurrency: 1, tokenBudget: '32k', timeout: '15 分钟', updated: '周一 16:40',
  },
]

const EVENTS = [
  { time: '09:42:18', type: '模型请求', detail: 'deepseek-chat / 1,248 输入令牌', status: '已记录' },
  { time: '09:42:21', type: '工具调用', detail: 'read_file × 3 / 412 输出令牌', status: '已记录' },
  { time: '09:43:02', type: '执行完成', detail: 'orbit-ui / task-1 / 44 秒', status: '已记录' },
  { time: '09:44:10', type: '反馈事件', detail: '任务状态更新为待复核', status: '已记录' },
]

const LOCAL_ENVIRONMENT: TeamSkillEnvironment = {
  dshVersion: '0.1.1-rc.2',
  availableTools: [],
  availableMcpServers: [],
  presentEnvironmentVariableNames: [],
}

/** Root overlay: listens to the local controller and mounts the demo shell. */
export function PlatformSurface({ controller, t, remote, useWorkspaces }: PlatformSurfaceProps) {
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') controller.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [controller, open])

  if (!open) return null
  return <PlatformShell controller={controller} t={t} remote={remote} useWorkspaces={useWorkspaces} />
}

function PlatformShell({ controller, t, remote, useWorkspaces }: Pick<PlatformSurfaceProps, 'controller' | 't' | 'remote' | 'useWorkspaces'>) {
  const [view, setView] = useState<ViewId>('overview')
  const [gate, setGate] = useState<AccountGate>('loading')
  const [account, setAccount] = useState<AuthenticatedAccount | undefined>()
  const [organizations, setOrganizations] = useState<readonly TeamSkillOrganization[]>([])
  const [access, setAccess] = useState<TeamSkillAccessSummary | undefined>()
  const [organizationFilterId, setOrganizationFilterId] = useState<string | undefined>()
  const [projectId, setProjectId] = useState<string | undefined>()
  const [serviceProjects, setServiceProjects] = useState<readonly TeamSkillProject[]>([])
  const [projectAssets, setProjectAssets] = useState<readonly TeamSkillProjectAsset[] | undefined>()
  const [detailProject, setDetailProject] = useState<Project | undefined>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false)
  const [favoriteKnowledge, setFavoriteKnowledge] = useState<Set<string>>(() => new Set(['k-1']))
  const [memoryFilter, setMemoryFilter] = useState<'全部' | MemoryItem['scope']>('全部')
  const [collectorPaused, setCollectorPaused] = useState(false)
  const [selectedAgentId, setSelectedAgentId] = useState(AGENTS[0]!.id)

  const visibleServiceProjects = useMemo(() => {
    const projects = serviceProjects
    return projects.filter(item => organizationFilterId === undefined || item.organizationId === organizationFilterId)
  }, [serviceProjects, organizationFilterId])
  const availableProjects = useMemo(() => {
    const projects = serviceProjects
    return projects.filter(item => organizationFilterId === undefined || item.organizationId === organizationFilterId).map(projectModel)
  }, [serviceProjects, organizationFilterId])
  const project = projectId === undefined ? undefined : availableProjects.find(item => item.id === projectId)
  const visibleAssets = useMemo(() => {
    const assets = access?.assets ?? []
    const projectAssetViews = (projectAssets ?? []).map(item => { const owner = serviceProjects.find(project => project.projectId === item.projectId); return { assetId: item.assetId, assetType: item.assetType, name: item.name, visibility: 'project' as const, projectId: item.projectId, ...(owner === undefined ? {} : { organizationId: owner.organizationId }) } })
    const unique = new Map<string, TeamSkillAsset>()
    for (const item of [...assets, ...projectAssetViews]) unique.set(`${item.assetType}:${item.assetId}:${item.projectId ?? ''}`, item)
    return [...unique.values()]
      .filter(item => item.projectId === undefined || item.projectId === projectId)
      .filter(item => organizationFilterId === undefined || item.organizationId === undefined || item.organizationId === organizationFilterId)
  }, [access, organizationFilterId, projectAssets, projectId])
  const visibleResourceIds = (assetType: TeamSkillAsset['assetType']): readonly string[] => visibleAssets
    .filter(item => item.assetType === assetType && (item.projectId === undefined || item.projectId === projectId))
    .map(item => item.assetId)
  const selectedAgent = AGENTS.find(item => item.id === selectedAgentId) ?? AGENTS[0]!

  const showError = (next: string): void => { setMessage(next); setGate('error') }

  const consumeAccount = async (value: TeamSkillAccountResult<TeamSkillAccountState>): Promise<void> => {
    if (isHostFailure(value)) { showError(hostFailureMessage(value)); return }
    if (value.status === 'signed-out') {
      setAccount(undefined); setOrganizations([]); setAccess(undefined); setOrganizationFilterId(undefined); setProjectId(undefined); setGate('signed-out'); return
    }
    setAccount(value)
    setMessage(undefined)
    if (value.mustChangePassword || value.user.mustChangePassword) { setGate('change-password'); return }
    await loadAccessSummary(value.user.userId)
  }

  const loadAccount = async (): Promise<void> => {
    setGate('loading'); setMessage(undefined)
    const result = await remote.teamSkills.account()
    if (!result.ok) { showError(result.error.message); return }
    await consumeAccount(result.value)
  }

  const loadAccessSummary = async (userId = account?.user.userId): Promise<void> => {
    setGate('loading'); setProjectId(undefined); setProjectAssets(undefined); setDetailProject(undefined)
    const [projectsResult, accessResult] = await Promise.all([remote.teamSkills.projects(), remote.teamSkills.accessSummary()])
    if (!projectsResult.ok) { showError(projectsResult.error.message); return }
    if (isHostFailure(projectsResult.value) || isSignedOut(projectsResult.value)) { setGate('signed-out'); return }
    if (!accessResult.ok) { showError(accessResult.error.message); return }
    const accessValue = accessResult.value
    if (isHostFailure(accessValue) || isSignedOut(accessValue) || !isAccessSummary(accessValue)) { setGate('signed-out'); return }
    const projects = projectsResult.value.filter(item => item.status === 'active')
    const nextAccess = { ...accessValue, projects }
    setAccess(nextAccess); setServiceProjects(projects); setOrganizations(accessValue.organizations); setOrganizationFilterId(undefined); setGate('ready')
    const stored = readStoredProjectId(currentStorageKey(userId))
    if (stored !== undefined && projects.some(item => item.projectId === stored)) await loadProjectDetail(stored, true, userId)
    else if (stored !== undefined) clearStoredProjectId(currentStorageKey(userId))
  }

  const projectRequest = useRef(0)
  const loadProjectDetail = async (nextProjectId: string, activate: boolean, userId = account?.user.userId): Promise<void> => {
    const requestId = ++projectRequest.current
    if (activate) { setProjectId(nextProjectId); setProjectAssets(undefined); setDetailProject(undefined) }
    const result = await remote.teamSkills.project(nextProjectId)
    if (requestId !== projectRequest.current) return
    if (!result.ok) { setProjectAssets(undefined); if (result.error.code === 'PROJECT_NOT_MEMBER' || result.error.code === 'RESOURCE_NOT_FOUND') { clearStoredProjectId(currentStorageKey(userId)); await loadAccessSummary(userId) } else showError(result.error.message); return }
    const value = result.value
    if (isHostFailure(value) || isSignedOut(value)) { setProjectAssets(undefined); if (isSignedOut(value)) setGate('signed-out'); else showError(hostFailureMessage(value)); return }
    setDetailProject(projectModel(value.project));
    if (activate) { setProjectAssets(value.assets); writeStoredProjectId(currentStorageKey(userId), nextProjectId) }
  }

  const login = async (request: TeamSkillLoginRequest): Promise<void> => {
    if (busy) return
    setBusy(true); setMessage(undefined); setGate('loading')
    try {
      const result = await remote.teamSkills.login(request)
      if (!result.ok) { showError(result.error.message); return }
      await consumeAccount(result.value)
    } finally { setBusy(false) }
  }

  const changePassword = async (request: TeamSkillChangePasswordRequest): Promise<void> => {
    if (busy) return
    setBusy(true); setMessage(undefined)
    try {
      const result = await remote.teamSkills.changePassword(request)
      if (!result.ok) { setMessage(result.error.message); return }
      await consumeAccount(result.value)
    } finally { setBusy(false) }
  }

  const logout = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await remote.teamSkills.logout() } finally {
      clearStoredProjectId(currentStorageKey(account?.user.userId))
      setBusy(false); setAccount(undefined); setOrganizations([]); setAccess(undefined); setOrganizationFilterId(undefined); setProjectId(undefined); setAccountDrawerOpen(false); setGate('signed-out'); setMessage(undefined)
    }
  }

  const refreshAuthorization = async (): Promise<void> => {
    if (gate === 'signed-out' || gate === 'loading' || gate === 'change-password') return
    await loadAccount()
  }

  useEffect(() => { void loadAccount() }, [remote])
  useEffect(() => {
    const refresh = (): void => { if (document.visibilityState === 'visible') void refreshAuthorization() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [gate, remote])

  const selectProject = (nextProjectId: string, nextView: ViewId): void => {
    if (nextProjectId.length === 0) { setProjectId(undefined); setProjectAssets(undefined); setDetailProject(undefined); clearStoredProjectId(currentStorageKey(account?.user.userId)); setView(nextView); return }
    if (!availableProjects.some(item => item.id === nextProjectId)) return
    setView(nextView); setGate('ready'); void loadProjectDetail(nextProjectId, true)
  }

  return (
    <div className={css.surface} role="dialog" aria-modal="true" aria-label={t('platform.name')}>
      <aside className={css.rail}>
        <div className={css.brandBlock}>
          <div className={css.brandMark} aria-hidden="true"><IconSparkle16 size={18} /></div>
          <div>
            <strong>{t('platform.name')}</strong>
            <span>AI CODING PLATFORM</span>
          </div>
        </div>

        {gate === 'ready' && account !== undefined && <label className={css.projectPicker}><span>当前项目</span><select aria-label="当前项目" value={projectId ?? ''} onChange={event => selectProject(event.target.value, view)}><option value="">选择项目</option>{groupProjects(serviceProjects).map(group => <optgroup key={group.organizationId} label={group.organizationName}>{group.projects.map(item => <option key={item.projectId} value={item.projectId}>{item.name}</option>)}</optgroup>)}</select></label>}

        {gate === 'ready' && (
          <nav className={css.nav} aria-label="平台模块">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const active = view === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  className={active ? `${css.navItem} ${css.navItemActive}` : css.navItem}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  onClick={() =>{  setView(item.id); }}
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                  <small>{item.hint}</small>
                </button>
              )
            })}
          </nav>
        )}

        <div className={css.railBottom}>
          {gate === 'ready' && <div className={css.demoNotice}>
            <span className={css.statusLive} />
            <div><strong>账号已验证</strong><span>服务端权限生效</span></div>
          </div>}
          {gate === 'ready' && account !== undefined
            ? (
              <button type="button" className={css.userButton} aria-label={`账号与权限：${account.user.displayName}`} onClick={() =>{ setAccountDrawerOpen(true) }}>
                <span className={css.avatar}>{account.user.displayName.slice(0, 1)}</span>
                <span><strong>{account.user.displayName}</strong><small>{account.user.email}</small></span>
                <IconUserOutline16 size={15} />
              </button>
            )
            : null}
        </div>
      </aside>

      <main className={css.main}>
        <header className={css.topbar}>
          <div className={css.breadcrumb}><span>DSH</span><span>/</span><strong>{gate === 'ready' ? NAV_ITEMS.find(item => item.id === view)?.label : gate === 'signed-out' ? '登录' : '账号验证'}</strong></div>
          <div className={css.topbarActions}>
            <span className={css.connection}><span className={gate === 'ready' ? css.statusLive : css.statusWarn} />{gate === 'ready' ? '服务已连接' : '需要登录'}</span>
            <button type="button" className={css.closeButton} aria-label={t('platform.close')} title={t('platform.close')} onClick={controller.close}>
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </header>

        {gate === 'loading' && <GateState title="正在验证账号" message="正在从 Host 读取服务端身份和访问范围。" />}
        {gate === 'signed-out' && <LoginView busy={busy} error={message} onLogin={login} />}
        {gate === 'error' && <GateState title="账号服务暂不可用" message={message ?? '无法读取服务端授权，请稍后重试。'} action={<button type="button" className={css.primaryButton} onClick={() => void loadAccount()}><IconRefreshOutline16 size={15} />重新连接</button>} />}
        {gate === 'change-password' && <ChangePasswordView busy={busy} error={message} onSubmit={changePassword} />}
        {gate === 'ready' && access !== undefined && (
          <div className={css.content}>
            {view === 'overview' && <AssetOverviewView projects={availableProjects} assets={visibleAssets} onNavigate={setView} />}
            {view === 'projects' && <ProjectsView project={detailProject ?? project} projectId={(detailProject ?? project)?.id} projects={availableProjects} onProjectChange={projectId => { void loadProjectDetail(projectId, false) }} />}
            {view === 'skills' && <TeamSkillsView remote={remote} useWorkspaces={useWorkspaces} {...project === undefined ? {} : { projectId: project.id }} projects={visibleServiceProjects} onProjectSelect={projectId => selectProject(projectId, 'skills')} environment={LOCAL_ENVIRONMENT} visibleSkillIds={visibleResourceIds('skill')} onAuthorizationFailure={() => void refreshAuthorization()} />}
            {view === 'knowledge' && <KnowledgeView visibleKnowledgeIds={visibleResourceIds('knowledge')} favoriteKnowledge={favoriteKnowledge} onToggleFavorite={itemId =>{  setFavoriteKnowledge(previous => toggleSet(previous, itemId)); }} />}
            {view === 'memory' && <MemoryView visibleMemoryIds={visibleResourceIds('memory')} filter={memoryFilter} onFilterChange={setMemoryFilter} />}
            {view === 'collector' && <CollectorView paused={collectorPaused} onToggle={() =>{  setCollectorPaused(value => !value); }} />}
            {view === 'agent-config' && <AgentConfigView agent={selectedAgent} agents={AGENTS} onAgentSelect={setSelectedAgentId} />}
          </div>
        )}
      </main>
      {accountDrawerOpen && account !== undefined && <AccountDrawer account={account} organizations={organizations} selectedOrganizationId={organizationFilterId} onClose={() =>{ setAccountDrawerOpen(false) }} onOrganizationChange={next =>{ setOrganizationFilterId(next.length === 0 ? undefined : next); setProjectId(undefined); setView('overview') }} onRefresh={() => void refreshAuthorization()} onLogout={() => void logout()} />}
    </div>
  )
}

type AccountGate = 'loading' | 'signed-out' | 'error' | 'change-password' | 'ready'
type AuthenticatedAccount = Extract<TeamSkillAccountState, { readonly status: 'authenticated' }>

function LoginView({ busy, error, onLogin }: { busy: boolean; error: string | undefined; onLogin: (request: TeamSkillLoginRequest) => Promise<void> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return (
    <div className={css.loginPage}>
      <div className={css.loginAccent}><IconSparkle16 size={20} /></div>
      <p className={css.kicker}>DSH / AI CODING PLATFORM</p>
      <h1>登录你的编程协作台</h1>
      <p>登录后查看权限范围内的项目与团队资产。</p>
      <form className={css.loginForm} onSubmit={(event) => { event.preventDefault(); void onLogin({ username: username.trim(), password }) }}>
        <label>工作邮箱<input type="email" autoComplete="username" value={username} onChange={event =>{ setUsername(event.target.value) }} required /></label>
        <label>访问密码<input type="password" autoComplete="current-password" value={password} onChange={event =>{ setPassword(event.target.value) }} required /></label>
        {error !== undefined && <span className={css.formError} role="alert">{error}</span>}
        <button type="submit" className={css.primaryButton} disabled={busy || username.trim().length === 0 || password.length === 0}><IconSparkle16 size={15} />{busy ? '正在登录…' : '登录'}</button>
      </form>
      <span className={css.formHint}>凭据由服务端用户服务验证，访问令牌由 DSH Host 管理。</span>
    </div>
  )
}

function ChangePasswordView({ busy, error, onSubmit }: { busy: boolean; error: string | undefined; onSubmit: (request: TeamSkillChangePasswordRequest) => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const mismatch = confirmation.length > 0 && newPassword !== confirmation
  return <div className={css.loginPage}><div className={css.loginAccent}><IconSettingsOutline14 size={20} /></div><p className={css.kicker}>DSH / 首次登录</p><h1>请先修改密码</h1><p>初始密码只能使用一次。修改成功后才能进入协作台。</p><form className={css.loginForm} onSubmit={event => { event.preventDefault(); if (mismatch) return; void onSubmit({ currentPassword, newPassword }) }}><label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={event =>{ setCurrentPassword(event.target.value) }} required /></label><label>新密码<input type="password" autoComplete="new-password" value={newPassword} onChange={event =>{ setNewPassword(event.target.value) }} required /></label><label>确认新密码<input type="password" autoComplete="new-password" value={confirmation} onChange={event =>{ setConfirmation(event.target.value) }} required /></label>{mismatch && <span className={css.formError} role="alert">两次输入的新密码不一致</span>}{error !== undefined && <span className={css.formError} role="alert">{error}</span>}<button type="submit" className={css.primaryButton} disabled={busy || mismatch || newPassword.length === 0}><IconSettingsOutline14 size={15} />{busy ? '正在保存…' : '保存新密码'}</button></form></div>
}

function AssetOverviewView({ projects, assets, onNavigate }: { projects: readonly Project[]; assets: readonly TeamSkillAsset[]; onNavigate: (view: ViewId) => void }) {
  const counts = new Map<TeamSkillAsset['assetType'], number>()
  for (const asset of assets) counts.set(asset.assetType, (counts.get(asset.assetType) ?? 0) + 1)
  return <div className={css.page}>
    <PageIntro eyebrow="资产总览" title="从权限范围内的资产开始协作" description="项目、Skill、知识库和记忆由服务端按账号权限返回；进入具体项目或安装项目级 Skill 时再选择项目。" />
    <div className={css.metricGrid}>
      <Metric label="可见项目" value={String(projects.length)} detail="服务端已授权" icon={<IconFolderOpenOutline16 size={16} />} />
      <Metric label="团队 Skill" value={String(counts.get('skill') ?? 0)} detail="可用版本" icon={<IconSkillOutline16 size={16} />} />
      <Metric label="知识库" value={String(counts.get('knowledge') ?? 0)} detail="当前账号可见" icon={<IconArchiveOutline20 size={16} />} />
      <Metric label="记忆" value={String(counts.get('memory') ?? 0)} detail="当前账号可见" icon={<IconGoalOutline16 size={16} />} />
    </div>
    <section className={css.panel}><SectionHeading title="权限内项目" action={<button type="button" className={css.outlineButton} onClick={() =>{ onNavigate('projects') }}><IconFolderOpenOutline16 size={15} />查看项目</button>} />
      {projects.length === 0 ? <div className={css.empty}><IconFolderOpenOutline16 size={21} /><h2>暂无可见项目</h2><p>当前账号没有被授予项目访问权限。</p></div> : <div className={css.projectCards}>{projects.map(project => <div key={project.id} className={css.projectCard}><strong>{project.name}</strong><small>{project.organizationId} · {project.status}</small><span>请使用左上角项目选择器切换</span></div>)}</div>}
    </section>
    <section className={css.panel}><SectionHeading title="其他资产" action={<div className={css.inlineActions}><button type="button" className={css.outlineButton} onClick={() =>{ onNavigate('skills') }}><IconSkillOutline16 size={15} />团队 Skill</button><button type="button" className={css.outlineButton} onClick={() =>{ onNavigate('knowledge') }}><IconArchiveOutline20 size={15} />知识库</button><button type="button" className={css.outlineButton} onClick={() =>{ onNavigate('memory') }}><IconGoalOutline16 size={15} />记忆库</button></div>} />
      {assets.length === 0 ? <div className={css.empty}><IconInspectOutline12 size={21} /><h2>暂无可见资产</h2><p>服务端没有返回当前账号可见的资产。</p></div> : <div className={css.assetList}>{assets.filter(asset => asset.assetType !== 'project').map(asset => <div key={`${asset.assetType}:${asset.assetId}`} className={css.assetRow}><span>{asset.assetType}</span><strong>{asset.name}</strong><small>{asset.visibility}</small></div>)}</div>}
    </section>
  </div>
}

function GateState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return <section className={css.gateState} role="status"><IconInspectOutline12 size={22} /><h1>{title}</h1><p>{message}</p>{action}</section>
}

function AccountDrawer({ account, organizations, selectedOrganizationId, onClose, onOrganizationChange, onRefresh, onLogout }: { account: AuthenticatedAccount; organizations: readonly TeamSkillOrganization[]; selectedOrganizationId: string | undefined; onClose: () => void; onOrganizationChange: (organizationId: string) => void; onRefresh: () => void; onLogout: () => void }) {
  return <div className={css.drawerBackdrop} role="presentation"><aside className={css.accountDrawer} role="dialog" aria-modal="true" aria-label="账号与访问范围"><div className={css.drawerHeader}><div><span className={css.eyebrow}>账号与访问范围</span><h2>{account.user.displayName}</h2></div><button type="button" className={css.closeButton} aria-label="关闭账号抽屉" onClick={onClose}><IconCloseOutline16 size={16} /></button></div><p className={css.drawerEmail}>{account.user.email}</p><dl className={css.accountFacts}><div><dt>账号状态</dt><dd>{account.user.status === 'active' ? '正常' : '已停用'}</dd></div><div><dt>全局角色</dt><dd>{account.user.globalRole}</dd></div></dl><label className={css.drawerField}>组织筛选<select aria-label="组织筛选" value={selectedOrganizationId ?? ''} onChange={event =>{ onOrganizationChange(event.target.value) }}><option value="">全部可见组织</option>{organizations.map(item => <option key={item.organizationId} value={item.organizationId}>{item.name}</option>)}</select></label><div className={css.drawerActions}><button type="button" className={css.outlineButton} onClick={onRefresh}><IconRefreshOutline16 size={15} />刷新访问范围</button><button type="button" className={css.primaryButton} onClick={onLogout}><IconCloseOutline16 size={15} />退出登录</button></div></aside></div>
}

function ProjectsView({ project, projectId, projects, onProjectChange }: { project: Project | undefined; projectId: string | undefined; projects: readonly Project[]; onProjectChange: (id: string) => void }) {
  if (project === undefined) return <div className={css.page}><PageIntro eyebrow="项目" title="选择要查看的项目" description="项目是与 Skill、知识库和记忆同级的资产；详情页只读取服务端返回的项目摘要。" /><section className={css.panel}><SectionHeading title="权限内项目" action={<span className={css.mutedLabel}>{projects.length} 个项目</span>} /><div className={css.projectList}>{projects.map(item => <button type="button" key={item.id} className={css.projectRow} onClick={() =>{ onProjectChange(item.id) }}><strong>{item.name}</strong><small>{item.organizationName} · {projectStatusLabel(item.status)}</small><span>打开详情</span></button>)}</div>{projects.length === 0 && <div className={css.empty}><h2>暂无可见项目</h2><p>服务端没有返回当前账号可访问的项目。</p></div>}</section></div>
  return (
    <div className={css.page}>
      <PageIntro eyebrow="项目" title={project.name} description="项目详情由服务端按当前账号权限返回；进入详情不会切换左上角的当前项目。" />
      <div className={css.projectToolbar}>
        <label className={css.selectBox}><span>查看项目</span><select aria-label="查看项目" value={projectId ?? ''} onChange={event =>{ onProjectChange(event.target.value) }}>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <span className={css.toolbarMeta}>{project.organizationName}</span>
      </div>
      <section className={css.panel}>
        <div className={css.projectDetailHead}><div className={css.projectIcon}><IconFolderOpenOutline16 size={19} /></div><div><h2>{project.name}</h2><p>{project.organizationName}</p></div><span className={css.stateTag}><span className={css.statusLive} />{projectStatusLabel(project.status)}</span></div>
        <p className={css.panelLead}>{project.description || '暂无项目描述。'}</p>
        <dl className={css.projectFacts}>
          <div><dt>项目 ID</dt><dd>{project.id}</dd></div>
          <div><dt>项目修订</dt><dd>{project.revision}</dd></div>
          <div><dt>成员</dt><dd>{project.memberCount}</dd></div>
          <div><dt>关联资产</dt><dd>{project.assetCount}</dd></div>
          <div><dt>创建时间</dt><dd>{formatProjectDate(project.createdAt)}</dd></div>
          <div><dt>更新时间</dt><dd>{formatProjectDate(project.updatedAt)}</dd></div>
        </dl>
        <div className={css.empty}><IconInspectOutline12 size={21} /><h2>项目级操作由后台管理</h2><p>插件只提供项目选择和授权资产入口，不提供创建、编辑、成员或资产关联写入。</p></div>
      </section>
    </div>
  )
}

function KnowledgeView({ visibleKnowledgeIds, favoriteKnowledge, onToggleFavorite }: { visibleKnowledgeIds: readonly string[]; favoriteKnowledge: Set<string>; onToggleFavorite: (itemId: string) => void }) {
  const [query, setQuery] = useState('')
  const items = KNOWLEDGE.filter(item => visibleKnowledgeIds.includes(item.id) && `${item.title}${item.type}${item.source}${item.excerpt}`.includes(query))
  return (
    <div className={css.page}>
      <PageIntro eyebrow="知识库" title="让规范在对话开始前就到位" description="项目与团队文档通过授权上下文进入 DSH 原生会话，来源和索引状态始终可见。" action={<label className={css.searchBox}><IconSearchOutline16 size={15} /><input value={query} onChange={event =>{  setQuery(event.target.value); }} placeholder="搜索知识条目" /></label>} />
      <div className={css.knowledgeLayout}><section className={css.panel}><div className={css.listHeader}><span>全部资料</span><span>{items.length} 条</span></div><div className={css.knowledgeList}>{items.map(item => <button type="button" key={item.id} className={css.knowledgeRow} onClick={() =>{  onToggleFavorite(item.id); }}><span className={css.knowledgeType}>{item.type}</span><span className={css.knowledgeCopy}><strong>{item.title}</strong><small>{item.excerpt}</small><em>{item.source} · {item.updated}</em></span><span className={item.status === '已索引' ? css.indexed : css.indexing}>{item.status}</span><span className={favoriteKnowledge.has(item.id) ? `${css.star} ${css.starOn}` : css.star} aria-label={favoriteKnowledge.has(item.id) ? '已收藏' : '收藏'}>★</span></button>)}</div></section><aside className={css.knowledgeAside}><div className={css.knowledgeAsideMark}><IconArchiveOutline20 size={20} /></div><h2>授权上下文</h2><p>当前项目可读取 24 条知识，已索引 22 条。点击资料行可收藏到 DSH 原生会话上下文。</p><div className={css.contextStat}><span>项目资料<strong>14</strong></span><span>团队规范<strong>10</strong></span></div><span className={css.smallNote}>服务端连接后将按项目权限实时更新</span></aside></div>
    </div>
  )
}

function MemoryView({ visibleMemoryIds, filter, onFilterChange }: { visibleMemoryIds: readonly string[]; filter: '全部' | MemoryItem['scope']; onFilterChange: (filter: '全部' | MemoryItem['scope']) => void }) {
  const items = MEMORIES.filter(item => visibleMemoryIds.includes(item.id) && (filter === '全部' || item.scope === filter))
  return (
    <div className={css.page}>
      <PageIntro eyebrow="记忆库" title="保留有用经验，也保留它的边界" description="按项目、团队和个人范围查看可见记忆；演示页面只展示读取和筛选。" action={<div className={css.segmented}>{(['全部', '项目', '团队', '个人'] as const).map(value => <button key={value} type="button" className={filter === value ? css.segmentActive : undefined} onClick={() =>{  onFilterChange(value); }}>{value}</button>)}</div>} />
      <section className={css.memoryPanel}><div className={css.listHeader}><span>可见记忆</span><span>{items.length} 条</span></div><div className={css.memoryList}>{items.map(item => <article key={item.id} className={css.memoryRow}><div className={css.memoryMark}><IconGoalOutline16 size={16} /></div><div className={css.memoryCopy}><div><h2>{item.title}</h2><span className={css.scopeTag}>{item.scope}</span></div><p>{item.detail}</p><small>更新于 {item.updated}</small></div><span className={item.confidence === '高' ? css.confidenceHigh : css.confidenceMedium}>置信度 {item.confidence}</span></article>)}</div><button type="button" className={css.memoryFooter}><IconQueueOutline14 size={14} />提交一条受控沉淀请求</button></section>
    </div>
  )
}

function CollectorView({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  return (
    <div className={css.page}>
      <PageIntro eyebrow="数据采集" title="看见每一次 AI Coding 的消耗" description="插件侧采集必要指标并脱敏上报；服务端负责校验、去重和聚合。当前页面使用本地演示批次。" action={<button type="button" className={paused ? `${css.outlineButton} ${css.resumeButton}` : css.outlineButton} aria-pressed={paused} onClick={onToggle}>{paused ? <><IconPlayOutline16 size={15} />恢复采集</> : <><IconPauseOutline16 size={15} />暂停采集</>}</button>} />
      <div className={css.metricGrid}><Metric label="今日令牌" value="6,842" detail="输入 4,920 · 输出 1,922" icon={<IconDataOutline16 size={16} />} /><Metric label="模型调用" value="24" detail="成功率 95.8%" icon={<IconSparkle16 size={16} />} /><Metric label="工具调用" value="61" detail="读取文件占 48%" icon={<IconCodeOutline16 size={16} />} /><Metric label="平均响应" value="18.4s" detail="较昨日下降 2.1s" icon={<IconRefreshOutline16 size={16} />} /></div>
      <div className={css.collectorGrid}><section className={css.panel}><SectionHeading title="使用趋势" action={<span className={css.periodTag}>最近 7 天</span>} /><div className={css.chart}><div className={css.chartLabels}><span>8k</span><span>4k</span><span>0</span></div><div className={css.chartBars}>{[42, 56, 38, 64, 51, 76, 68].map((height, index) => <div key={index} className={css.chartColumn}><i style={{ height: `${height}%` }} /><span>{['一', '二', '三', '四', '五', '六', '今'][index]}</span></div>)}</div></div></section><section className={css.panel}><SectionHeading title="实时事件" action={<span className={paused ? css.pausedTag : css.collectingTag}>{paused ? '已暂停' : '采集中'}</span>} /><div className={css.eventList}>{EVENTS.map(event => <div key={`${event.time}-${event.type}`} className={css.eventRow}><span>{event.time}</span><strong>{event.type}</strong><p>{event.detail}</p><em>{event.status}</em></div>)}</div></section></div>
      <div className={css.collectionNote}><IconInspectOutline12 size={16} /><span>默认不采集 API Key、凭证和不必要的源代码正文。采集失败不会阻塞主对话。</span><strong>批次 #demo-0827-0944</strong></div>
    </div>
  )
}

function AgentConfigView({ agent, agents, onAgentSelect }: { agent: AgentConfig; agents: readonly AgentConfig[]; onAgentSelect: (agentId: string) => void }) {
  return (
    <div className={css.page}>
      <PageIntro eyebrow="Agent 配置" title="管理云平台里的 Coding Agent" description="查看不同 Agent 的模型、推理和执行参数。当前仅展示本地示例配置，未连接云端配置服务。" action={<span className={css.demoConfigTag}><span className={css.statusWarn} />仅本地演示</span>} />
      <div className={css.agentConfigLayout}>
        <section className={css.panel}>
          <SectionHeading title="Agent 列表" action={<span className={css.mutedLabel}>{agents.length} 个配置</span>} />
          <div className={css.agentList} role="list" aria-label="Coding Agent 列表">
            {agents.map((item) => {
              const active = item.id === agent.id
              return (
                <button key={item.id} type="button" className={active ? `${css.agentListItem} ${css.agentListItemActive}` : css.agentListItem} aria-pressed={active} onClick={() =>{  onAgentSelect(item.id); }}>
                  <span className={css.agentListIcon}><IconAgentPresetOutline16 size={17} /></span>
                  <span className={css.agentListCopy}><strong>{item.name}</strong><small>{item.description}</small></span>
                  <span className={item.status === '运行中' ? css.agentRunning : css.agentPaused}><span className={item.status === '运行中' ? css.statusLive : css.statusWarn} />{item.status}</span>
                </button>
              )
            })}
          </div>
        </section>

        <section className={`${css.panel} ${css.agentDetail}`}>
          <div className={css.agentDetailHeader}>
            <div className={css.agentDetailIdentity}>
              <span className={css.agentDetailIcon}><IconAgentPresetOutline16 size={20} /></span>
              <div><span className={css.eyebrow}>Coding Agent</span><h2>{agent.name}</h2><p>{agent.description}</p></div>
            </div>
            <span className={agent.status === '运行中' ? css.agentRunning : css.agentPaused}><span className={agent.status === '运行中' ? css.statusLive : css.statusWarn} />{agent.status}</span>
          </div>

          <div className={css.agentFieldGrid}>
            <AgentField label="默认模型" value={agent.model} />
            <AgentField label="推理等级" value={agent.reasoning} />
            <AgentField label="访问模式" value={agent.accessMode} />
            <AgentField label="并发任务数" value={`${agent.concurrency} 个`} />
            <AgentField label="单次 Token 预算" value={agent.tokenBudget} />
            <AgentField label="执行超时" value={agent.timeout} />
          </div>

          <div className={css.agentSection}>
            <SectionHeading title="可用 Team Skill" action={<span className={css.mutedLabel}>{agent.skills.length} 个已绑定</span>} />
            <div className={css.agentSkillList}>{agent.skills.map(skill => <span key={skill} className={css.agentSkillTag}><IconSkillOutline16 size={14} />{skill}</span>)}</div>
          </div>

          <div className={css.agentSection}>
            <SectionHeading title="上下文策略" />
            <div className={css.agentToggleRow}><div><strong>自动注入项目上下文</strong><small>运行任务时带入当前项目、分支和授权资产摘要。</small></div><span className={agent.autoContext ? `${css.toggle} ${css.toggleOn}` : css.toggle} aria-label={agent.autoContext ? '已开启' : '已关闭'}><i /></span></div>
          </div>

          <div className={css.agentConfigFooter}><span>最后更新于 {agent.updated}</span><button type="button" className={css.outlineButton} disabled title="演示版本未连接云端配置服务"><IconSettingsOutline14 size={14} />保存配置</button></div>
        </section>
      </div>
    </div>
  )
}

function AgentField({ label, value }: { label: string; value: string }) {
  return <div className={css.agentField}><span>{label}</span><strong>{value}</strong></div>
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className={css.pageIntro}><div><span className={css.eyebrow}>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action !== undefined && <div className={css.pageAction}>{action}</div>}</div>
}

function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  return <div className={css.sectionHeading}><h2>{title}</h2>{action}</div>
}

function Metric({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: ReactNode }) {
  return <div className={css.metric}><span className={css.metricIcon}>{icon}</span><span className={css.metricLabel}>{label}</span><strong>{value}</strong><small>{detail}</small></div>
}

function projectModel(project: TeamSkillProject): Project {
  return {
    id: project.projectId,
    organizationId: project.organizationId,
    organizationName: project.organizationName,
    name: project.name,
    description: project.description,
    status: project.status,
    createdBy: project.createdBy,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    memberCount: project.memberCount,
    assetCount: project.assetCount,
    revision: project.revision,
  }
}

function projectStatusLabel(status: TeamSkillProject['status']): string {
  return status === 'active' ? '进行中' : status === 'draft' ? '草稿' : '已归档'
}

function formatProjectDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function currentStorageKey(userId: string | undefined): string {
  return `dsh.ai-coding-platform.project:${window.location.origin}:${userId ?? 'signed-out'}`
}

function readStoredProjectId(key: string): string | undefined {
  try { return window.localStorage.getItem(key) ?? undefined } catch { return undefined }
}

function writeStoredProjectId(key: string, projectId: string): void {
  try { window.localStorage.setItem(key, projectId) } catch { /* Storage is optional in embedded clients. */ }
}

function clearStoredProjectId(key: string): void {
  try { window.localStorage.removeItem(key) } catch { /* Storage is optional in embedded clients. */ }
}

function groupProjects(projects: readonly TeamSkillProject[]): readonly { readonly organizationId: string; readonly organizationName: string; readonly projects: readonly TeamSkillProject[] }[] {
  const groups = new Map<string, { readonly organizationId: string; readonly organizationName: string; readonly projects: TeamSkillProject[] }>()
  for (const project of projects) {
    const group = groups.get(project.organizationId) ?? { organizationId: project.organizationId, organizationName: project.organizationName, projects: [] }
    group.projects.push(project); groups.set(project.organizationId, group)
  }
  return [...groups.values()]
}

function isHostFailure(value: unknown): value is { readonly status: 'not-ready'; readonly missing: readonly string[] } | { readonly status: 'failed'; readonly code: string; readonly message: string } {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false
  const status = value.status
  return status === 'not-ready' || status === 'failed'
}

function isSignedOut(value: unknown): value is { readonly status: 'signed-out' } {
  return typeof value === 'object' && value !== null && 'status' in value && value.status === 'signed-out'
}

function hostFailureMessage(value: { readonly status: 'not-ready'; readonly missing: readonly string[] } | { readonly status: 'failed'; readonly code: string; readonly message: string }): string {
  return value.status === 'not-ready' ? `服务端未就绪：${value.missing.join('、')}` : value.message
}

function isAccessSummary(value: unknown): value is TeamSkillAccessSummary {
  return typeof value === 'object' && value !== null && 'organizations' in value && Array.isArray(value.organizations) && 'projects' in value && Array.isArray(value.projects) && 'assets' in value && Array.isArray(value.assets)
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}
