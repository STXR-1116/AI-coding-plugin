/** Full-screen, browser-local demo surface for the first-party platform. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { ClientRemote, TeamSkillAccessSummary, TeamSkillAccountResult, TeamSkillAccountState, TeamSkillAsset, TeamSkillChangePasswordRequest, TeamSkillEnvironment, TeamSkillLoginRequest, TeamSkillOrganization, TeamSkillProject, TeamSkillProjectAsset, TeamSkillKnowledgeBaseSummary, TeamSkillKnowledgeSearchResponse, TeamSkillKnowledgePreview, TeamSkillMemory, TeamSkillMemoryPage, TeamSkillMemoryMutation } from '@deepseek-ai/dsh-api-remotes/client'
import type { CollectorSnapshot, CollectorStatus } from '@deepseek-ai/dsh-ai-coding-platform/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconArchiveOutline20, IconAgentPresetOutline16, IconCloseOutline16, IconDataOutline16, IconFolderOpenOutline16, IconGoalOutline16, IconInspectOutline12, IconPauseOutline16, IconPlayOutline16, IconQueueOutline14, IconRefreshOutline16, IconSearchOutline16, IconSettingsOutline14, IconSkillOutline16, IconSparkle16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import type { PlatformDemoController } from './controller.ts'
import { TeamSkillsView } from './team-skills/TeamSkillsView.tsx'
import css from './PlatformSurface.module.css'

/** Full props for the root-scoped overlay slot. */
export type PlatformSurfaceProps = PropsRuntime<'shell.overlay'> &
  PropsLocale<typeof NS> & {
    controller: PlatformDemoController
    remote: ClientRemote
  }

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
  {
    id: 'overview',
    label: '总览',
    hint: '项目与执行概况',
    icon: IconSparkle16,
  },
  {
    id: 'projects',
    label: '项目',
    hint: '权限范围内的项目',
    icon: IconFolderOpenOutline16,
  },
  {
    id: 'skills',
    label: '团队 Skill',
    hint: '团队能力目录',
    icon: IconSkillOutline16,
  },
  {
    id: 'knowledge',
    label: '知识库',
    hint: '项目资料与规范',
    icon: IconArchiveOutline20,
  },
  {
    id: 'memory',
    label: '记忆库',
    hint: '可复用的团队经验',
    icon: IconGoalOutline16,
  },
  {
    id: 'collector',
    label: '数据采集',
    hint: 'AI Coding 使用指标',
    icon: IconDataOutline16,
  },
  {
    id: 'agent-config',
    label: 'Agent 配置',
    hint: '云端 Agent 参数',
    icon: IconAgentPresetOutline16,
  },
]

const AGENTS: readonly [AgentConfig, ...AgentConfig[]] = [
  {
    id: 'frontend-reviewer',
    name: '前端评审 Agent',
    description: '面向组件、交互和可访问性变更的代码评审助手。',
    status: '运行中',
    model: 'DeepSeek-V3',
    reasoning: '高',
    accessMode: '只读评审',
    skills: ['代码评审', '前端交互规范'],
    autoContext: true,
    concurrency: 3,
    tokenBudget: '64k',
    timeout: '10 分钟',
    updated: '今天 10:24',
  },
  {
    id: 'delivery-engineer',
    name: '交付工程 Agent',
    description: '根据项目任务执行实现、测试和交付检查。',
    status: '运行中',
    model: 'DeepSeek-Coder-V2',
    reasoning: '中高',
    accessMode: '工作区读写',
    skills: ['代码评审', '接口设计', '前端交互规范'],
    autoContext: true,
    concurrency: 2,
    tokenBudget: '128k',
    timeout: '30 分钟',
    updated: '昨天 18:06',
  },
  {
    id: 'incident-helper',
    name: '线上排障 Agent',
    description: '关联日志、指标和变更记录，辅助定位线上问题。',
    status: '已暂停',
    model: 'DeepSeek-V3',
    reasoning: '中',
    accessMode: '日志与知识库',
    skills: ['线上排障', '知识库检索'],
    autoContext: false,
    concurrency: 1,
    tokenBudget: '32k',
    timeout: '15 分钟',
    updated: '周一 16:40',
  },
]

const LOCAL_ENVIRONMENT: TeamSkillEnvironment = {
  dshVersion: '0.1.1-rc.2',
  availableTools: [],
  availableMcpServers: [],
  presentEnvironmentVariableNames: [],
}

/** Root overlay: listens to the local controller and mounts the demo shell. */
export function PlatformSurface({ controller, t, remote, useSessions, useWorkspaces }: PlatformSurfaceProps) {
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') controller.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [controller, open])

  if (!open) return null
  return <PlatformShell controller={controller} t={t} remote={remote} useSessions={useSessions} useWorkspaces={useWorkspaces} />
}

function PlatformShell({ controller, t, remote, useSessions, useWorkspaces }: Pick<PlatformSurfaceProps, 'controller' | 't' | 'remote' | 'useSessions' | 'useWorkspaces'>) {
  const [view, setView] = useState<ViewId>('overview')
  const [gate, setGate] = useState<AccountGate>('loading')
  const [account, setAccount] = useState<AuthenticatedAccount | undefined>()
  const [organizations, setOrganizations] = useState<readonly TeamSkillOrganization[]>([])
  const [access, setAccess] = useState<TeamSkillAccessSummary | undefined>()
  const [organizationFilterId, setOrganizationFilterId] = useState<string | undefined>()
  const [projectId, setProjectId] = useState<string | undefined>()
  const [serviceProjects, setServiceProjects] = useState<readonly TeamSkillProject[]>([])
  const [projectAssets, setProjectAssets] = useState<readonly TeamSkillProjectAsset[] | undefined>()
  const [knowledgeBases, setKnowledgeBases] = useState<readonly TeamSkillKnowledgeBaseSummary[]>([])
  const [selectedKnowledgeBaseIds, setSelectedKnowledgeBaseIds] = useState<Set<string>>(() => new Set())
  const [knowledgeSearch, setKnowledgeSearch] = useState<TeamSkillKnowledgeSearchResponse | undefined>()
  const [knowledgePreview, setKnowledgePreview] = useState<TeamSkillKnowledgePreview | undefined>()
  const [detailProject, setDetailProject] = useState<Project | undefined>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false)
  const [memories, setMemories] = useState<readonly TeamSkillMemory[]>([])
  const [memoryPage, setMemoryPage] = useState<TeamSkillMemoryPage | undefined>()
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryRefresh, setMemoryRefresh] = useState(0)
  const [memoryKeyword, setMemoryKeyword] = useState<string | undefined>()
  const [memoryError, setMemoryError] = useState<string | undefined>()
  const [collectorSnapshot, setCollectorSnapshot] = useState<CollectorSnapshot | undefined>()
  const [collectorLoading, setCollectorLoading] = useState(false)
  const [collectorError, setCollectorError] = useState<string | undefined>()
  const [collectorBusy, setCollectorBusy] = useState(false)
  const [collectorTick, setCollectorTick] = useState(0)
  const [confirmation, setConfirmation] = useState<{
    readonly message: string
    readonly resolve: (value: boolean) => void
  }>()
  const [selectedAgentId, setSelectedAgentId] = useState(AGENTS[0].id)
  const currentSessionId = useSessions(s => s.current)
  const knowledgeBinding = useRef<
    | {
      readonly sessionId: string
      readonly projectId: string
      readonly knowledgeBaseIds: readonly string[]
    }
    | undefined
  >()
  const knowledgeSync = useRef(Promise.resolve())
  const memoryBinding = useRef<{ readonly sessionId: string; readonly projectId: string } | undefined>()
  const memorySync = useRef(Promise.resolve())
  const memoryBindingGeneration = useRef(0)
  const memoryRequest = useRef(0)
  const collectorBinding = useRef<{ readonly sessionId: string; readonly projectId: string } | undefined>()
  const collectorSync = useRef(Promise.resolve())
  const collectorBindingGeneration = useRef(0)
  const collectorRequest = useRef(0)
  const selectedKnowledgeKey = [...selectedKnowledgeBaseIds].sort().join('\u0000')

  useEffect(() => {
    const previous = knowledgeBinding.current
    const sessionId = currentSessionId === undefined ? undefined : String(currentSessionId)
    const sessionChanged = previous !== undefined && previous.sessionId !== sessionId
    const next =
      sessionChanged || sessionId === undefined || projectId === undefined || selectedKnowledgeBaseIds.size === 0
        ? undefined
        : {
          sessionId,
          projectId,
          knowledgeBaseIds: [...selectedKnowledgeBaseIds],
        }
    knowledgeBinding.current = next
    if (sessionChanged) {
      setSelectedKnowledgeBaseIds(new Set())
      setKnowledgeSearch(undefined)
    }
    knowledgeSync.current = knowledgeSync.current
      .then(async () => {
        if (previous !== undefined) {
          const cleared = await remote.teamSkills.clearKnowledgeSelection(previous.sessionId)
          if (!cleared.ok) throw new Error(cleared.error.message)
        }
        if (next === undefined || knowledgeBinding.current !== next) return
        const configured = await remote.teamSkills.configureKnowledgeSelection(next.sessionId, {
          projectId: next.projectId,
          knowledgeBaseIds: next.knowledgeBaseIds,
        })
        if (!configured.ok) throw new Error(configured.error.message)
        if (knowledgeBinding.current === next) setMessage(undefined)
      })
      .catch((error: unknown) => {
        if (knowledgeBinding.current === next) {
          knowledgeBinding.current = undefined
          setSelectedKnowledgeBaseIds(new Set())
          setKnowledgeSearch(undefined)
          setMessage(remoteFailureMessage(error))
        }
      })
  }, [currentSessionId, projectId, remote, selectedKnowledgeKey])

  useEffect(() => {
    const generation = ++memoryBindingGeneration.current
    const previous = memoryBinding.current
    const sessionId = currentSessionId === undefined ? undefined : String(currentSessionId)
    const next = sessionId === undefined || projectId === undefined ? undefined : { sessionId, projectId }
    memoryBinding.current = next
    memorySync.current = memorySync.current
      .then(async () => {
        if (previous !== undefined) {
          const cleared = await remote.teamSkills.clearProjectMemory(previous.sessionId)
          if (!cleared.ok) throw new Error(cleared.error.message)
        }
        if (generation !== memoryBindingGeneration.current || memoryBinding.current !== next || next === undefined) return
        const configured = await remote.teamSkills.configureProjectMemory(next.sessionId, next.projectId)
        if (!configured.ok) throw new Error(configured.error.message)
        if (generation === memoryBindingGeneration.current && memoryBinding.current === next) setMessage(undefined)
      })
      .catch((error: unknown) => {
        if (generation !== memoryBindingGeneration.current || memoryBinding.current !== next) return
        memoryBinding.current = undefined
        setMessage(remoteFailureMessage(error))
      })
  }, [currentSessionId, projectId, remote])

  useEffect(() => {
    const generation = ++collectorBindingGeneration.current
    const previous = collectorBinding.current
    const sessionId = currentSessionId === undefined ? undefined : String(currentSessionId)
    const next = sessionId === undefined || projectId === undefined ? undefined : { sessionId, projectId }
    collectorBinding.current = next
    collectorSync.current = collectorSync.current
      .then(async () => {
        if (previous !== undefined) {
          const cleared = await remote.teamSkills.clearCollectorProject(previous.sessionId)
          if (!cleared.ok) throw new Error(cleared.error.message)
        }
        if (generation !== collectorBindingGeneration.current || collectorBinding.current !== next || next === undefined) return
        const configured = await remote.teamSkills.configureCollectorProject(next.sessionId, next.projectId)
        if (!configured.ok) throw new Error(configured.error.message)
      })
      .catch((error: unknown) => {
        if (generation !== collectorBindingGeneration.current || collectorBinding.current !== next) return
        collectorBinding.current = undefined
        setMessage(remoteFailureMessage(error))
      })
  }, [currentSessionId, projectId, remote])

  useEffect(() => {
    setMemoryKeyword(undefined)
  }, [projectId])

  useEffect(() => {
    if (view !== 'memory' || projectId === undefined) return
    setMemories([])
    setMemoryPage(undefined)
  }, [projectId, view])

  useEffect(() => {
    if (view !== 'memory' || projectId === undefined) {
      setMemories([])
      setMemoryPage(undefined)
      setMemoryError(undefined)
      return
    }
    const requestId = ++memoryRequest.current
    setMemoryLoading(true)
    setMemoryError(undefined)
    void remote.teamSkills
      .memoryList({
        projectId,
        ...(memoryKeyword === undefined ? {} : { keyword: memoryKeyword }),
        limit: 50,
      })
      .then((result) => {
        if (requestId !== memoryRequest.current) return
        setMemoryLoading(false)
        if (!result.ok) {
          setMemoryError(result.error.message)
          setMemories([])
          setMemoryPage(undefined)
          return
        }
        if (isHostFailure(result.value) || isSignedOut(result.value)) {
          setMemoryError(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
          setMemories([])
          setMemoryPage(undefined)
          return
        }
        setMemoryPage(result.value)
        setMemories(result.value.items)
      })
      .catch((error: unknown) => {
        if (requestId !== memoryRequest.current) return
        setMemoryLoading(false)
        setMemoryError(remoteFailureMessage(error))
        setMemories([])
        setMemoryPage(undefined)
      })
  }, [memoryKeyword, memoryRefresh, projectId, remote, view])

  const loadMoreMemories = async (): Promise<void> => {
    const cursor = memoryPage?.nextCursor
    if (view !== 'memory' || projectId === undefined || cursor === undefined || cursor === null || memoryLoading) return
    const requestId = memoryRequest.current
    setMemoryLoading(true)
    try {
      const result = await remote.teamSkills.memoryList({
        projectId,
        ...(memoryKeyword === undefined ? {} : { keyword: memoryKeyword }),
        cursor,
        limit: 50,
      })
      if (requestId !== memoryRequest.current) return
      if (!result.ok) {
        setMemoryError(result.error.message)
        return
      }
      if (isHostFailure(result.value) || isSignedOut(result.value)) {
        setMemoryError(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
        return
      }
      const page = result.value
      setMemoryPage(page)
      setMemories(current => [...current, ...page.items])
    } catch (error: unknown) {
      if (requestId === memoryRequest.current) setMemoryError(remoteFailureMessage(error))
    } finally {
      if (requestId === memoryRequest.current) setMemoryLoading(false)
    }
  }

  useEffect(() => {
    if (view !== 'collector') return
    const requestId = ++collectorRequest.current
    setCollectorLoading(true)
    setCollectorError(undefined)
    void remote.teamSkills
      .collectorStatus()
      .then((result) => {
        if (requestId !== collectorRequest.current) return
        setCollectorLoading(false)
        if (!result.ok) {
          setCollectorError(result.error.message)
          setCollectorSnapshot(undefined)
          return
        }
        setCollectorSnapshot(result.value)
      })
      .catch((error: unknown) => {
        if (requestId !== collectorRequest.current) return
        setCollectorLoading(false)
        setCollectorError(remoteFailureMessage(error))
        setCollectorSnapshot(undefined)
      })
  }, [collectorTick, remote, view])

  useEffect(() => {
    if (view !== 'collector') return
    const timer = setInterval(() => {
      setCollectorTick(tick => tick + 1)
    }, 5000)
    return () => {
      clearInterval(timer)
    }
  }, [view])

  const collectorAction = async (action: 'pause' | 'resume' | 'flush' | 'clear'): Promise<void> => {
    if (collectorBusy) return
    if (
      action === 'clear' &&
      !(await new Promise<boolean>((resolve) => {
        setConfirmation({
          message: '清空后所有未发送事件将被删除，并记录 manual_clear 数据缺口。确定清空未上报数据？',
          resolve,
        })
      }))
    )
      return
    setCollectorBusy(true)
    const requestId = ++collectorRequest.current
    try {
      const result = action === 'pause' ? await remote.teamSkills.pauseCollector() : action === 'resume' ? await remote.teamSkills.resumeCollector() : action === 'flush' ? await remote.teamSkills.flushCollector() : await remote.teamSkills.clearPendingCollectorData()
      if (requestId !== collectorRequest.current) return
      if (!result.ok) {
        setCollectorError(result.error.message)
        return
      }
      setCollectorSnapshot(result.value)
      setCollectorError(undefined)
    } catch (error: unknown) {
      if (requestId === collectorRequest.current) setCollectorError(remoteFailureMessage(error))
    } finally {
      if (requestId === collectorRequest.current) setCollectorBusy(false)
    }
  }

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
    const projectAssetViews = (projectAssets ?? []).map((item) => {
      const owner = serviceProjects.find(project => project.projectId === item.projectId)
      return {
        assetId: item.assetId,
        assetType: item.assetType,
        name: item.name,
        visibility: 'project' as const,
        projectId: item.projectId,
        ...(owner === undefined ? {} : { organizationId: owner.organizationId }),
      }
    })
    const unique = new Map<string, TeamSkillAsset>()
    for (const item of [...assets, ...projectAssetViews]) unique.set(`${item.assetType}:${item.assetId}:${item.projectId ?? ''}`, item)
    return [...unique.values()]
      .filter(item => item.projectId === undefined || item.projectId === projectId)
      .filter(
        item =>
          organizationFilterId === undefined ||
          item.organizationId === undefined ||
          item.organizationId === organizationFilterId,
      )
  }, [access, organizationFilterId, projectAssets, projectId])
  const selectedAgent = AGENTS.find(item => item.id === selectedAgentId) ?? AGENTS[0]

  const showError = (next: string): void => {
    setMessage(next)
    setGate('error')
  }

  const consumeAccount = async (value: TeamSkillAccountResult<TeamSkillAccountState>): Promise<void> => {
    if (isHostFailure(value)) {
      showError(hostFailureMessage(value))
      return
    }
    if (value.status === 'signed-out') {
      memoryBindingGeneration.current += 1
      memoryBinding.current = undefined
      memoryRequest.current += 1
      setMemories([])
      setMemoryPage(undefined)
      setMemoryError(undefined)
      setMemoryKeyword(undefined)
      collectorBindingGeneration.current += 1
      collectorBinding.current = undefined
      collectorRequest.current += 1
      setCollectorSnapshot(undefined)
      setCollectorError(undefined)
      setAccount(undefined)
      setOrganizations([])
      setAccess(undefined)
      setOrganizationFilterId(undefined)
      setProjectId(undefined)
      setGate('signed-out')
      return
    }
    setAccount(value)
    setMessage(undefined)
    if (value.mustChangePassword || value.user.mustChangePassword) {
      setGate('change-password')
      return
    }
    await loadAccessSummary(value.user.userId)
  }

  const loadAccount = async (): Promise<void> => {
    setGate('loading')
    setMessage(undefined)
    try {
      const result = await remote.teamSkills.account()
      if (!result.ok) {
        showError(result.error.message)
        return
      }
      await consumeAccount(result.value)
    } catch (error: unknown) {
      showError(remoteFailureMessage(error))
    }
  }

  const loadAccessSummary = async (userId = account?.user.userId): Promise<void> => {
    setGate('loading')
    setProjectId(undefined)
    setProjectAssets(undefined)
    setDetailProject(undefined)
    setKnowledgeBases([])
    setSelectedKnowledgeBaseIds(new Set())
    setKnowledgeSearch(undefined)
    try {
      const [projectsResult, accessResult] = await Promise.all([remote.teamSkills.projects(), remote.teamSkills.accessSummary()])
      if (!projectsResult.ok) {
        showError(projectsResult.error.message)
        return
      }
      if (isHostFailure(projectsResult.value) || isSignedOut(projectsResult.value)) {
        setGate('signed-out')
        return
      }
      if (!accessResult.ok) {
        showError(accessResult.error.message)
        return
      }
      const accessValue = accessResult.value
      if (isHostFailure(accessValue) || isSignedOut(accessValue) || !isAccessSummary(accessValue)) {
        setGate('signed-out')
        return
      }
      const projects = projectsResult.value.filter(item => item.status === 'active')
      const nextAccess = { ...accessValue, projects }
      setAccess(nextAccess)
      setServiceProjects(projects)
      setOrganizations(accessValue.organizations)
      setOrganizationFilterId(undefined)
      setGate('ready')
      const stored = readStoredProjectId(currentStorageKey(userId))
      if (stored !== undefined && projects.some(item => item.projectId === stored)) await loadProjectDetail(stored, true, userId)
      else if (stored !== undefined) clearStoredProjectId(currentStorageKey(userId))
    } catch (error: unknown) {
      showError(remoteFailureMessage(error))
    }
  }

  const projectRequest = useRef(0)
  const knowledgeRequest = useRef(0)
  const loadProjectDetail = async (nextProjectId: string, activate: boolean, userId = account?.user.userId): Promise<void> => {
    const requestId = ++projectRequest.current
    if (activate) {
      setProjectId(nextProjectId)
      setProjectAssets(undefined)
      setDetailProject(undefined)
      setKnowledgeBases([])
      setSelectedKnowledgeBaseIds(new Set())
      setKnowledgeSearch(undefined)
      setKnowledgePreview(undefined)
      knowledgeRequest.current += 1
    }
    const result = await remote.teamSkills.project(nextProjectId)
    if (requestId !== projectRequest.current) return
    if (!result.ok) {
      setProjectAssets(undefined)
      setKnowledgeBases([])
      setSelectedKnowledgeBaseIds(new Set())
      setKnowledgeSearch(undefined)
      if (result.error.code === 'PROJECT_NOT_MEMBER' || result.error.code === 'RESOURCE_NOT_FOUND') {
        clearStoredProjectId(currentStorageKey(userId))
        await loadAccessSummary(userId)
      } else showError(result.error.message)
      return
    }
    const value = result.value
    if (isHostFailure(value) || isSignedOut(value)) {
      setProjectAssets(undefined)
      if (isSignedOut(value)) setGate('signed-out')
      else showError(hostFailureMessage(value))
      return
    }
    setDetailProject(projectModel(value.project))
    if (activate) {
      setProjectAssets(value.assets)
      const knowledge = await remote.teamSkills.knowledgeBases(nextProjectId)
      if (requestId !== projectRequest.current) return
      if (!knowledge.ok) {
        setKnowledgeBases([])
        setSelectedKnowledgeBaseIds(new Set())
        showError(knowledge.error.message)
        return
      }
      if (isHostFailure(knowledge.value) || isSignedOut(knowledge.value)) {
        setKnowledgeBases([])
        setSelectedKnowledgeBaseIds(new Set())
        showError(isSignedOut(knowledge.value) ? '账号已退出，请重新登录。' : hostFailureMessage(knowledge.value))
        return
      }
      setKnowledgeBases(knowledge.value.filter(item => item.state === 'active' && item.searchable))
      setSelectedKnowledgeBaseIds(new Set())
      setKnowledgeSearch(undefined)
      setKnowledgePreview(undefined)
      writeStoredProjectId(currentStorageKey(userId), nextProjectId)
    }
  }

  const login = async (request: TeamSkillLoginRequest): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(undefined)
    setGate('loading')
    try {
      const result = await remote.teamSkills.login(request)
      if (!result.ok) {
        showError(result.error.message)
        return
      }
      await consumeAccount(result.value)
    } finally {
      setBusy(false)
    }
  }

  const changePassword = async (request: TeamSkillChangePasswordRequest): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await remote.teamSkills.changePassword(request)
      if (!result.ok) {
        setMessage(result.error.message)
        return
      }
      await consumeAccount(result.value)
    } finally {
      setBusy(false)
    }
  }

  const logout = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await remote.teamSkills.logout()
    } finally {
      memoryBindingGeneration.current += 1
      const previousMemoryBinding = memoryBinding.current
      memoryBinding.current = undefined
      if (previousMemoryBinding !== undefined) {
        memorySync.current = memorySync.current
          .then(async () => {
            const cleared = await remote.teamSkills.clearProjectMemory(previousMemoryBinding.sessionId)
            if (!cleared.ok) throw new Error(cleared.error.message)
          })
          .catch((error: unknown) => {
            setMessage(remoteFailureMessage(error))
          })
      }
      memoryRequest.current += 1
      setMemories([])
      setMemoryPage(undefined)
      setMemoryError(undefined)
      setMemoryKeyword(undefined)
      clearStoredProjectId(currentStorageKey(account?.user.userId))
      setBusy(false)
      setAccount(undefined)
      setOrganizations([])
      setAccess(undefined)
      setOrganizationFilterId(undefined)
      setProjectId(undefined)
      setAccountDrawerOpen(false)
      setGate('signed-out')
      setMessage(undefined)
    }
  }

  const refreshAuthorization = async (): Promise<void> => {
    if (gate === 'signed-out' || gate === 'loading' || gate === 'change-password') return
    await loadAccount()
  }

  useEffect(() => {
    void loadAccount()
  }, [remote])
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') void refreshAuthorization()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [gate, remote])

  const selectProject = (nextProjectId: string, nextView: ViewId): void => {
    if (nextProjectId.length === 0) {
      projectRequest.current += 1
      knowledgeRequest.current += 1
      setProjectId(undefined)
      setProjectAssets(undefined)
      setDetailProject(undefined)
      setKnowledgeBases([])
      setSelectedKnowledgeBaseIds(new Set())
      setKnowledgeSearch(undefined)
      setKnowledgePreview(undefined)
      clearStoredProjectId(currentStorageKey(account?.user.userId))
      setView(nextView)
      return
    }
    if (!availableProjects.some(item => item.id === nextProjectId)) return
    setView(nextView)
    setGate('ready')
    void loadProjectDetail(nextProjectId, true)
  }

  return (
    <div className={css.surface} role="dialog" aria-modal="true" aria-label={t('platform.name')}>
      <aside className={css.rail}>
        <div className={css.brandBlock}>
          <div className={css.brandMark} aria-hidden="true">
            <IconSparkle16 size={18} />
          </div>
          <div>
            <strong>{t('platform.name')}</strong>
            <span>AI CODING PLATFORM</span>
          </div>
        </div>

        {gate === 'ready' && account !== undefined && (
          <label className={css.projectPicker}>
            <span>当前项目</span>
            <select
              aria-label="当前项目"
              value={projectId ?? ''}
              onChange={(event) => {
                selectProject(event.target.value, view)
              }}
            >
              <option value="">选择项目</option>
              {groupProjects(serviceProjects).map(group => (
                <optgroup key={group.organizationId} label={group.organizationName}>
                  {group.projects.map(item => (
                    <option key={item.projectId} value={item.projectId}>
                      {item.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}

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
                  onClick={() => {
                    setView(item.id)
                  }}
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
          {gate === 'ready' && (
            <div className={css.demoNotice}>
              <span className={css.statusLive} />
              <div>
                <strong>账号已验证</strong>
                <span>服务端权限生效</span>
              </div>
            </div>
          )}
          {gate === 'ready' && account !== undefined ? (
            <button
              type="button"
              className={css.userButton}
              aria-label={`账号与权限：${account.user.displayName}`}
              onClick={() => {
                setAccountDrawerOpen(true)
              }}
            >
              <span className={css.avatar}>{account.user.displayName.slice(0, 1)}</span>
              <span>
                <strong>{account.user.displayName}</strong>
                <small>{account.user.email}</small>
              </span>
              <IconUserOutline16 size={15} />
            </button>
          ) : null}
        </div>
      </aside>

      <main className={css.main}>
        <header className={css.topbar}>
          <div className={css.breadcrumb}>
            <span>DSH</span>
            <span>/</span>
            <strong>{gate === 'ready' ? NAV_ITEMS.find(item => item.id === view)?.label : gate === 'signed-out' ? '登录' : '账号验证'}</strong>
          </div>
          <div className={css.topbarActions}>
            <span className={css.connection}>
              <span className={gate === 'ready' ? css.statusLive : css.statusWarn} />
              {gate === 'ready' ? '服务已连接' : '需要登录'}
            </span>
            <button type="button" className={css.closeButton} aria-label={t('platform.close')} title={t('platform.close')} onClick={controller.close}>
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </header>

        {gate === 'loading' && <GateState title="正在验证账号" message="正在从 Host 读取服务端身份和访问范围。" />}
        {gate === 'signed-out' && <LoginView busy={busy} error={message} onLogin={login} />}
        {gate === 'error' && (
          <GateState
            title="账号服务暂不可用"
            message={message ?? '无法读取服务端授权，请稍后重试。'}
            action={
              <button type="button" className={css.primaryButton} onClick={() => void loadAccount()}>
                <IconRefreshOutline16 size={15} />
                重新连接
              </button>
            }
          />
        )}
        {gate === 'change-password' && <ChangePasswordView busy={busy} error={message} onSubmit={changePassword} />}
        {gate === 'ready' && message !== undefined && (
          <div className={css.surfaceNotice} role="alert">
            {message}
          </div>
        )}
        {gate === 'ready' && access !== undefined && (
          <div className={css.content}>
            {view === 'overview' && <AssetOverviewView projects={availableProjects} assets={visibleAssets} onNavigate={setView} />}
            {view === 'projects' && (
              <ProjectsView
                project={detailProject ?? project}
                projectId={(detailProject ?? project)?.id}
                projects={availableProjects}
                onProjectChange={(projectId) => {
                  void loadProjectDetail(projectId, false)
                }}
              />
            )}
            {view === 'skills' && (
              <TeamSkillsView
                remote={remote}
                useWorkspaces={useWorkspaces}
                {...(project === undefined ? {} : { projectId: project.id })}
                projects={visibleServiceProjects}
                onProjectSelect={(projectId) => {
                  selectProject(projectId, 'skills')
                }}
                environment={LOCAL_ENVIRONMENT}
                onAuthorizationFailure={() => void refreshAuthorization()}
              />
            )}
            {view === 'knowledge' && (
              <KnowledgeView
                projectId={projectId}
                knowledgeBases={knowledgeBases}
                selectedIds={selectedKnowledgeBaseIds}
                onSelectionChange={setSelectedKnowledgeBaseIds}
                search={knowledgeSearch}
                preview={knowledgePreview}
                onSearch={async (query) => {
                  if (projectId === undefined || selectedKnowledgeBaseIds.size === 0) return
                  const request = ++knowledgeRequest.current
                  const result = await remote.teamSkills.knowledgeSearch({
                    projectId,
                    knowledgeBaseIds: [...selectedKnowledgeBaseIds],
                    query,
                  })
                  if (request !== knowledgeRequest.current) return
                  if (!result.ok) {
                    setMessage(result.error.message)
                    return
                  }
                  if (isHostFailure(result.value) || isSignedOut(result.value)) {
                    setMessage(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
                    return
                  }
                  setKnowledgeSearch(result.value.response)
                }}
                onPreview={async (knowledgeBaseId, documentId) => {
                  const result = await remote.teamSkills.knowledgePreview(knowledgeBaseId, documentId)
                  if (!result.ok) {
                    setMessage(result.error.message)
                    return
                  }
                  if (isHostFailure(result.value) || isSignedOut(result.value)) {
                    setMessage(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
                    return
                  }
                  setKnowledgePreview(result.value)
                }}
              />
            )}
            {view === 'memory' && (
              <MemoryView
                projectId={projectId}
                memories={memories}
                page={memoryPage}
                loading={memoryLoading}
                error={memoryError}
                remote={remote}
                keyword={memoryKeyword}
                onSearch={(keyword) => {
                  setMemoryKeyword(keyword.length === 0 ? undefined : keyword)
                  setMemoryRefresh(value => value + 1)
                }}
                onLoadMore={() => void loadMoreMemories()}
                onRefresh={() => {
                  setMemoryRefresh(value => value + 1)
                }}
                onConfirm={message =>
                  new Promise<boolean>((resolve) => {
                    setConfirmation({ message, resolve })
                  })
                }
              />
            )}
            {view === 'collector' && (
              <CollectorView
                projectId={projectId}
                snapshot={collectorSnapshot}
                loading={collectorLoading}
                error={collectorError}
                busy={collectorBusy}
                onRefresh={() => {
                  setCollectorTick(tick => tick + 1)
                }}
                onAction={(action) => {
                  void collectorAction(action)
                }}
              />
            )}
            {view === 'agent-config' && <AgentConfigView agent={selectedAgent} agents={AGENTS} onAgentSelect={setSelectedAgentId} />}
          </div>
        )}
      </main>
      {accountDrawerOpen && account !== undefined && (
        <AccountDrawer
          account={account}
          organizations={organizations}
          selectedOrganizationId={organizationFilterId}
          onClose={() => {
            setAccountDrawerOpen(false)
          }}
          onOrganizationChange={(next) => {
            projectRequest.current += 1
            knowledgeRequest.current += 1
            setOrganizationFilterId(next.length === 0 ? undefined : next)
            setProjectId(undefined)
            setProjectAssets(undefined)
            setDetailProject(undefined)
            setKnowledgeBases([])
            setSelectedKnowledgeBaseIds(new Set())
            setKnowledgeSearch(undefined)
            setKnowledgePreview(undefined)
            setView('overview')
          }}
          onRefresh={() => void refreshAuthorization()}
          onLogout={() => void logout()}
        />
      )}
      {confirmation !== undefined && (
        <div className={css.drawerBackdrop} role="presentation">
          <section className={css.accountDrawer} role="dialog" aria-modal="true" aria-label="确认操作">
            <h2>确认操作</h2>
            <p>{confirmation.message}</p>
            <div className={css.memoryActions}>
              <button
                type="button"
                className={css.outlineButton}
                onClick={() => {
                  const current = confirmation
                  setConfirmation(undefined)
                  current.resolve(false)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={css.primaryButton}
                onClick={() => {
                  const current = confirmation
                  setConfirmation(undefined)
                  current.resolve(true)
                }}
              >
                确认
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

type AccountGate = 'loading' | 'signed-out' | 'error' | 'change-password' | 'ready'
type AuthenticatedAccount = Extract<TeamSkillAccountState, { readonly status: 'authenticated' }>

function LoginView({
  busy,
  error,
  onLogin,
}: {
  busy: boolean
  error: string | undefined
  onLogin: (request: TeamSkillLoginRequest) => Promise<void>
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return (
    <div className={css.loginPage}>
      <div className={css.loginAccent}>
        <IconSparkle16 size={20} />
      </div>
      <p className={css.kicker}>DSH / AI CODING PLATFORM</p>
      <h1>登录你的编程协作台</h1>
      <p>登录后查看权限范围内的项目与团队资产。</p>
      <form
        className={css.loginForm}
        onSubmit={(event) => {
          event.preventDefault()
          void onLogin({ username: username.trim(), password })
        }}
      >
        <label>
          用户名或邮箱
          <input
            type="text"
            inputMode="text"
            autoComplete="username"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value)
            }}
            required
          />
        </label>
        <label>
          访问密码
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
            }}
            required
          />
        </label>
        {error !== undefined && (
          <span className={css.formError} role="alert">
            {error}
          </span>
        )}
        <button type="submit" className={css.primaryButton} disabled={busy || username.trim().length === 0 || password.length === 0}>
          <IconSparkle16 size={15} />
          {busy ? '正在登录…' : '登录'}
        </button>
      </form>
      <span className={css.formHint}>凭据由服务端用户服务验证，访问令牌由 DSH Host 管理。</span>
    </div>
  )
}

function ChangePasswordView({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean
  error: string | undefined
  onSubmit: (request: TeamSkillChangePasswordRequest) => Promise<void>
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const mismatch = confirmation.length > 0 && newPassword !== confirmation
  return (
    <div className={css.loginPage}>
      <div className={css.loginAccent}>
        <IconSettingsOutline14 size={20} />
      </div>
      <p className={css.kicker}>DSH / 首次登录</p>
      <h1>请先修改密码</h1>
      <p>初始密码只能使用一次。修改成功后才能进入协作台。</p>
      <form
        className={css.loginForm}
        onSubmit={(event) => {
          event.preventDefault()
          if (mismatch) return
          void onSubmit({ currentPassword, newPassword })
        }}
      >
        <label>
          当前密码
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value)
            }}
            required
          />
        </label>
        <label>
          新密码
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value)
            }}
            required
          />
        </label>
        <label>
          确认新密码
          <input
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value)
            }}
            required
          />
        </label>
        {mismatch && (
          <span className={css.formError} role="alert">
            两次输入的新密码不一致
          </span>
        )}
        {error !== undefined && (
          <span className={css.formError} role="alert">
            {error}
          </span>
        )}
        <button type="submit" className={css.primaryButton} disabled={busy || mismatch || newPassword.length === 0}>
          <IconSettingsOutline14 size={15} />
          {busy ? '正在保存…' : '保存新密码'}
        </button>
      </form>
    </div>
  )
}

function AssetOverviewView({
  projects,
  assets,
  onNavigate,
}: {
  projects: readonly Project[]
  assets: readonly TeamSkillAsset[]
  onNavigate: (view: ViewId) => void
}) {
  const counts = new Map<TeamSkillAsset['assetType'], number>()
  for (const asset of assets) counts.set(asset.assetType, (counts.get(asset.assetType) ?? 0) + 1)
  return (
    <div className={css.page}>
      <PageIntro eyebrow="资产总览" title="从权限范围内的资产开始协作" description="项目、Skill、知识库和记忆由服务端按账号权限返回；进入具体项目或安装项目级 Skill 时再选择项目。" />
      <div className={css.metricGrid}>
        <Metric label="可见项目" value={String(projects.length)} detail="服务端已授权" icon={<IconFolderOpenOutline16 size={16} />} />
        <Metric label="团队 Skill" value={String(counts.get('skill') ?? 0)} detail="可用版本" icon={<IconSkillOutline16 size={16} />} />
        <Metric label="知识库" value={String(counts.get('knowledge') ?? 0)} detail="当前账号可见" icon={<IconArchiveOutline20 size={16} />} />
        <Metric label="记忆" value={String(counts.get('memory') ?? 0)} detail="当前账号可见" icon={<IconGoalOutline16 size={16} />} />
      </div>
      <section className={css.panel}>
        <SectionHeading
          title="权限内项目"
          action={
            <button
              type="button"
              className={css.outlineButton}
              onClick={() => {
                onNavigate('projects')
              }}
            >
              <IconFolderOpenOutline16 size={15} />
              查看项目
            </button>
          }
        />
        {projects.length === 0 ? (
          <div className={css.empty}>
            <IconFolderOpenOutline16 size={21} />
            <h2>暂无可见项目</h2>
            <p>当前账号没有被授予项目访问权限。</p>
          </div>
        ) : (
          <div className={css.projectCards}>
            {projects.map(project => (
              <div key={project.id} className={css.projectCard}>
                <strong>{project.name}</strong>
                <small>
                  {project.organizationId} · {project.status}
                </small>
                <span>请使用左上角项目选择器切换</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className={css.panel}>
        <SectionHeading
          title="其他资产"
          action={
            <div className={css.inlineActions}>
              <button
                type="button"
                className={css.outlineButton}
                onClick={() => {
                  onNavigate('skills')
                }}
              >
                <IconSkillOutline16 size={15} />
                团队 Skill
              </button>
              <button
                type="button"
                className={css.outlineButton}
                onClick={() => {
                  onNavigate('knowledge')
                }}
              >
                <IconArchiveOutline20 size={15} />
                知识库
              </button>
              <button
                type="button"
                className={css.outlineButton}
                onClick={() => {
                  onNavigate('memory')
                }}
              >
                <IconGoalOutline16 size={15} />
                记忆库
              </button>
            </div>
          }
        />
        {assets.length === 0 ? (
          <div className={css.empty}>
            <IconInspectOutline12 size={21} />
            <h2>暂无可见资产</h2>
            <p>服务端没有返回当前账号可见的资产。</p>
          </div>
        ) : (
          <div className={css.assetList}>
            {assets
              .filter(asset => asset.assetType !== 'project')
              .map(asset => (
                <div key={`${asset.assetType}:${asset.assetId}`} className={css.assetRow}>
                  <span>{asset.assetType}</span>
                  <strong>{asset.name}</strong>
                  <small>{asset.visibility}</small>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  )
}

function GateState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <section className={css.gateState} role="status">
      <IconInspectOutline12 size={22} />
      <h1>{title}</h1>
      <p>{message}</p>
      {action}
    </section>
  )
}

function AccountDrawer({
  account,
  organizations,
  selectedOrganizationId,
  onClose,
  onOrganizationChange,
  onRefresh,
  onLogout,
}: {
  account: AuthenticatedAccount
  organizations: readonly TeamSkillOrganization[]
  selectedOrganizationId: string | undefined
  onClose: () => void
  onOrganizationChange: (organizationId: string) => void
  onRefresh: () => void
  onLogout: () => void
}) {
  return (
    <div className={css.drawerBackdrop} role="presentation">
      <aside className={css.accountDrawer} role="dialog" aria-modal="true" aria-label="账号与访问范围">
        <div className={css.drawerHeader}>
          <div>
            <span className={css.eyebrow}>账号与访问范围</span>
            <h2>{account.user.displayName}</h2>
          </div>
          <button type="button" className={css.closeButton} aria-label="关闭账号抽屉" onClick={onClose}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>
        <p className={css.drawerEmail}>{account.user.email}</p>
        <dl className={css.accountFacts}>
          <div>
            <dt>账号状态</dt>
            <dd>{account.user.status === 'active' ? '正常' : '已停用'}</dd>
          </div>
          <div>
            <dt>全局角色</dt>
            <dd>{account.user.globalRole}</dd>
          </div>
        </dl>
        <label className={css.drawerField}>
          组织筛选
          <select
            aria-label="组织筛选"
            value={selectedOrganizationId ?? ''}
            onChange={(event) => {
              onOrganizationChange(event.target.value)
            }}
          >
            <option value="">全部可见组织</option>
            {organizations.map(item => (
              <option key={item.organizationId} value={item.organizationId}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className={css.drawerActions}>
          <button type="button" className={css.outlineButton} onClick={onRefresh}>
            <IconRefreshOutline16 size={15} />
            刷新访问范围
          </button>
          <button type="button" className={css.primaryButton} onClick={onLogout}>
            <IconCloseOutline16 size={15} />
            退出登录
          </button>
        </div>
      </aside>
    </div>
  )
}

function ProjectsView({
  project,
  projectId,
  projects,
  onProjectChange,
}: {
  project: Project | undefined
  projectId: string | undefined
  projects: readonly Project[]
  onProjectChange: (id: string) => void
}) {
  if (project === undefined)
    return (
      <div className={css.page}>
        <PageIntro eyebrow="项目" title="选择要查看的项目" description="项目是与 Skill、知识库和记忆同级的资产；详情页只读取服务端返回的项目摘要。" />
        <section className={css.panel}>
          <SectionHeading title="权限内项目" action={<span className={css.mutedLabel}>{projects.length} 个项目</span>} />
          <div className={css.projectList}>
            {projects.map(item => (
              <button
                type="button"
                key={item.id}
                className={css.projectRow}
                onClick={() => {
                  onProjectChange(item.id)
                }}
              >
                <strong>{item.name}</strong>
                <small>
                  {item.organizationName} · {projectStatusLabel(item.status)}
                </small>
                <span>打开详情</span>
              </button>
            ))}
          </div>
          {projects.length === 0 && (
            <div className={css.empty}>
              <h2>暂无可见项目</h2>
              <p>服务端没有返回当前账号可访问的项目。</p>
            </div>
          )}
        </section>
      </div>
    )
  return (
    <div className={css.page}>
      <PageIntro eyebrow="项目" title={project.name} description="项目详情由服务端按当前账号权限返回；进入详情不会切换左上角的当前项目。" />
      <div className={css.projectToolbar}>
        <label className={css.selectBox}>
          <span>查看项目</span>
          <select
            aria-label="查看项目"
            value={projectId ?? ''}
            onChange={(event) => {
              onProjectChange(event.target.value)
            }}
          >
            {projects.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <span className={css.toolbarMeta}>{project.organizationName}</span>
      </div>
      <section className={css.panel}>
        <div className={css.projectDetailHead}>
          <div className={css.projectIcon}>
            <IconFolderOpenOutline16 size={19} />
          </div>
          <div>
            <h2>{project.name}</h2>
            <p>{project.organizationName}</p>
          </div>
          <span className={css.stateTag}>
            <span className={css.statusLive} />
            {projectStatusLabel(project.status)}
          </span>
        </div>
        <p className={css.panelLead}>{project.description || '暂无项目描述。'}</p>
        <dl className={css.projectFacts}>
          <div>
            <dt>项目 ID</dt>
            <dd>{project.id}</dd>
          </div>
          <div>
            <dt>项目修订</dt>
            <dd>{project.revision}</dd>
          </div>
          <div>
            <dt>成员</dt>
            <dd>{project.memberCount}</dd>
          </div>
          <div>
            <dt>关联资产</dt>
            <dd>{project.assetCount}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{formatProjectDate(project.createdAt)}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{formatProjectDate(project.updatedAt)}</dd>
          </div>
        </dl>
        <div className={css.empty}>
          <IconInspectOutline12 size={21} />
          <h2>项目级操作由后台管理</h2>
          <p>插件只提供项目选择和授权资产入口，不提供创建、编辑、成员或资产关联写入。</p>
        </div>
      </section>
    </div>
  )
}

function KnowledgeView({
  projectId,
  knowledgeBases,
  selectedIds,
  onSelectionChange,
  search,
  preview,
  onSearch,
  onPreview,
}: {
  projectId: string | undefined
  knowledgeBases: readonly TeamSkillKnowledgeBaseSummary[]
  selectedIds: Set<string>
  onSelectionChange: (value: Set<string>) => void
  search: TeamSkillKnowledgeSearchResponse | undefined
  preview: TeamSkillKnowledgePreview | undefined
  onSearch: (query: string) => Promise<void>
  onPreview: (knowledgeBaseId: string, documentId: string) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const toggle = (id: string): void => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange(next)
  }
  return (
    <div className={css.page}>
      <PageIntro
        eyebrow="知识库"
        title="让规范在对话开始前就到位"
        description={projectId === undefined ? '请先选择 active 项目。' : '只检索当前项目显式开启的知识库，检索状态和引用来源由服务端返回。'}
        action={
          <form
            className={css.searchBox}
            onSubmit={(event) => {
              event.preventDefault()
              void onSearch(query.trim())
            }}
          >
            <IconSearchOutline16 size={15} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              placeholder="搜索知识库"
            />
            <button type="submit" aria-label="检索" disabled={projectId === undefined || selectedIds.size === 0 || query.trim().length === 0}>
              <IconSearchOutline16 size={14} />
            </button>
          </form>
        }
      />
      <div className={css.knowledgeLayout}>
        <section className={css.panel}>
          <div className={css.listHeader}>
            <span>项目知识库</span>
            <span>{selectedIds.size} 个已开启</span>
          </div>
          <div className={css.knowledgeList}>
            {knowledgeBases.map(item => (
              <label key={item.knowledgeBaseId} className={css.knowledgeRow}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.knowledgeBaseId)}
                  onChange={() => {
                    toggle(item.knowledgeBaseId)
                  }}
                />
                <span className={css.knowledgeType}>{item.type}</span>
                <span className={css.knowledgeCopy}>
                  <strong>{item.name}</strong>
                  <small>{item.description}</small>
                  <em>
                    {item.knowledgeBaseId} · r{item.revision}
                  </em>
                </span>
                <span className={item.state === 'active' ? css.indexed : css.indexing}>{item.state}</span>
              </label>
            ))}
          </div>
          {knowledgeBases.length === 0 && (
            <div className={css.empty}>
              <h2>当前项目没有可用知识库</h2>
              <p>项目映射、成员权限和外部处理状态由服务端实时确认。</p>
            </div>
          )}
        </section>
        <aside className={css.knowledgeAside}>
          <div className={css.knowledgeAsideMark}>
            <IconArchiveOutline20 size={20} />
          </div>
          <h2>检索结果</h2>
          {search === undefined ? (
            <p>选择一个或多个知识库并提交查询。</p>
          ) : (
            <>
              <p>
                {search.knowledgeBases
                  .filter(item => item.status === 'skipped')
                  .map(item => `未使用 ${item.knowledgeBaseId}${item.reason === null ? '' : `（${item.reason}）`}`)
                  .join('；') || '本轮知识库均可用。'}
              </p>
              <div className={css.contextStat}>
                <span>
                  命中<strong>{search.results.length}</strong>
                </span>
                <span>
                  知识库<strong>{search.knowledgeBases.length}</strong>
                </span>
              </div>
              <div className={css.knowledgeList}>
                {search.results.map(item => (
                  <div key={item.knowledgeId} className={css.knowledgeRow}>
                    <span className={css.knowledgeType}>引用</span>
                    <span className={css.knowledgeCopy}>
                      <strong>{item.title}</strong>
                      <small>{item.snippet}</small>
                      <em>{item.sourceUrl}</em>
                    </span>
                    <button type="button" className={css.outlineButton} onClick={() => void onPreview(item.knowledgeBaseId, item.knowledgeId)}>
                      预览
                    </button>
                    <span className={css.indexed}>{item.score.toFixed(2)}</span>
                  </div>
                ))}
              </div>
              {preview !== undefined && (
                <div className={css.callout}>
                  <strong>{preview.title}</strong>
                  <a href={preview.previewUrl} target="_blank" rel="noreferrer">
                    打开受权预览
                  </a>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

function MemoryView({
  projectId,
  memories,
  page,
  loading,
  error,
  remote,
  keyword,
  onSearch,
  onLoadMore,
  onRefresh,
  onConfirm,
}: {
  projectId: string | undefined
  memories: readonly TeamSkillMemory[]
  page: TeamSkillMemoryPage | undefined
  loading: boolean
  error: string | undefined
  remote: ClientRemote
  keyword: string | undefined
  onSearch: (keyword: string) => void
  onLoadMore: () => void
  onRefresh: () => void
  onConfirm: (message: string) => Promise<boolean>
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [selectedRecord, setSelectedRecord] = useState<TeamSkillMemory | undefined>()
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | undefined>()
  const [query, setQuery] = useState(keyword ?? '')
  const detailRequest = useRef(0)
  const mutationGeneration = useRef(0)
  const selectedRecordRef = useRef<TeamSkillMemory | undefined>()

  useEffect(() => {
    mutationGeneration.current += 1
    setSelectedId(undefined)
    setSelectedRecord(undefined)
    selectedRecordRef.current = undefined
    setEditing(false)
    setContent('')
    setActionMessage(undefined)
    setQuery('')
    detailRequest.current += 1
  }, [projectId])

  const selected = selectedRecord?.memoryId === selectedId ? selectedRecord : memories.find(item => item.memoryId === selectedId)
  const open = async (memory: TeamSkillMemory): Promise<void> => {
    const requestId = ++detailRequest.current
    setSelectedId(memory.memoryId)
    setSelectedRecord(memory)
    selectedRecordRef.current = memory
    setContent(memory.content)
    setEditing(false)
    const result = await remote.teamSkills.memoryGet(memory.memoryId)
    if (requestId !== detailRequest.current) return
    if (!result.ok) {
      setActionMessage(result.error.message)
      return
    }
    if (isHostFailure(result.value) || isSignedOut(result.value)) {
      setActionMessage(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
      return
    }
    selectedRecordRef.current = result.value
    setSelectedRecord(result.value)
    setContent(result.value.content)
  }
  const save = async (): Promise<void> => {
    const current = selectedRecordRef.current ?? selected
    if (current === undefined || content.trim().length === 0 || busy) return
    const generation = mutationGeneration.current
    const requestedProjectId = projectId
    setBusy(true)
    setActionMessage(undefined)
    try {
      const result = await remote.teamSkills.memoryUpdate({
        memoryId: current.memoryId,
        content: content.trim(),
        expectedRevision: current.revision,
      })
      if (generation !== mutationGeneration.current || requestedProjectId !== projectId) return
      const value = memoryMutationValue(result, setActionMessage)
      if (value === undefined) return
      if (value.memory !== undefined) {
        selectedRecordRef.current = value.memory
        setSelectedRecord(value.memory)
        setContent(value.memory.content)
        setSelectedId(value.memory.memoryId)
      }
      setEditing(false)
      setActionMessage(`记忆已提交，任务 ${value.jobId} 处理中。`)
      onRefresh()
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    const current = selectedRecordRef.current ?? selected
    if (current === undefined || busy || !(await onConfirm('删除后该记忆将立即不再参与召回，确认删除？'))) return
    const generation = mutationGeneration.current
    const requestedProjectId = projectId
    setBusy(true)
    setActionMessage(undefined)
    try {
      const result = await remote.teamSkills.memoryDelete(
        { memoryId: current.memoryId, expectedRevision: current.revision },
        crypto.randomUUID(),
      )
      if (generation !== mutationGeneration.current || requestedProjectId !== projectId) return
      const value = memoryMutationValue(result, setActionMessage)
      if (value === undefined) return
      setSelectedId(undefined)
      setSelectedRecord(undefined)
      selectedRecordRef.current = undefined
      setContent('')
      setActionMessage(`记忆已删除，清理任务 ${value.jobId} 已提交。`)
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.page}>
      <PageIntro
        eyebrow="记忆库"
        title="保留项目经验，也保留服务端边界"
        description={projectId === undefined ? '请先选择 active 项目。' : '记忆只来自当前项目的服务端列表；自动捕获始终开启，服务不可用不会阻塞编码。'}
        action={
          <div className={css.memoryActions}>
            <form
              className={css.searchBox}
              onSubmit={(event) => {
                event.preventDefault()
                onSearch(query.trim())
              }}
            >
              <IconSearchOutline16 size={14} />
              <input
                aria-label="搜索记忆"
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                }}
                placeholder="搜索当前项目记忆"
              />
              <button type="submit" aria-label="搜索记忆">
                <IconSearchOutline16 size={14} />
              </button>
            </form>
            <button type="button" className={css.outlineButton} onClick={onRefresh} disabled={loading}>
              <IconRefreshOutline16 size={15} />
              刷新
            </button>
          </div>
        }
      />
      {actionMessage !== undefined && (
        <div className={css.surfaceNotice} role="status">
          {actionMessage}
        </div>
      )}
      {projectId === undefined && (
        <div className={css.empty}>
          <h2>需要项目上下文</h2>
          <p>选择项目后才能读取项目记忆。</p>
        </div>
      )}
      {projectId !== undefined && error !== undefined && (
        <div className={css.empty} role="alert">
          <h2>记忆服务不可用</h2>
          <p>{error}</p>
          <button type="button" className={css.primaryButton} onClick={onRefresh}>
            <IconRefreshOutline16 size={15} />
            重试
          </button>
        </div>
      )}
      {projectId !== undefined && error === undefined && (
        <div className={css.memoryLayout}>
          <section className={css.memoryPanel}>
            <div className={css.listHeader}>
              <span>当前项目记忆</span>
              <span>{loading ? '读取中…' : `${page?.totalEstimate ?? memories.length} 条`}</span>
            </div>
            <div className={css.memoryList}>
              {memories.map(memory => (
                <button key={memory.memoryId} type="button" className={selectedId === memory.memoryId ? `${css.memoryRow} ${css.memoryRowActive}` : css.memoryRow} onClick={() => void open(memory)}>
                  <div className={css.memoryMark}>
                    <IconGoalOutline16 size={16} />
                  </div>
                  <div className={css.memoryCopy}>
                    <div>
                      <h2>
                        {memory.content.slice(0, 60)}
                        {memory.content.length > 60 ? '…' : ''}
                      </h2>
                      <span className={css.scopeTag}>项目记忆</span>
                    </div>
                    <p>{memory.content}</p>
                    <small>
                      r{memory.revision} · 更新于 {formatMemoryDate(memory.updatedAt)}
                    </small>
                  </div>
                  <span className={css.confidenceHigh}>L1</span>
                </button>
              ))}
            </div>
            {!loading && memories.length === 0 && (
              <div className={css.empty}>
                <h2>当前项目暂无记忆</h2>
                <p>完成一次编码回合后，自动捕获会提交可治理的项目经验。</p>
              </div>
            )}
            {page?.nextCursor !== null && page?.nextCursor !== undefined && (
              <button type="button" className={css.memoryFooter} onClick={onLoadMore} disabled={loading}>
                <IconQueueOutline14 size={14} />
                {loading ? '读取中…' : '加载更多记忆'}
              </button>
            )}
          </section>
          <aside className={css.memoryAside}>
            {selected === undefined ? (
              <>
                <div className={css.knowledgeAsideMark}>
                  <IconGoalOutline16 size={20} />
                </div>
                <h2>选择一条记忆</h2>
                <p>查看服务端正文和 revision，再进行受权编辑或删除。</p>
              </>
            ) : (
              <>
                <div className={css.listHeader}>
                  <span>记忆详情</span>
                  <span>{selected.memoryId}</span>
                </div>
                {editing ? (
                  <label className={css.memoryEditor}>
                    记忆正文
                    <textarea
                      aria-label="记忆正文"
                      value={content}
                      onChange={(event) => {
                        setContent(event.target.value)
                      }}
                      rows={8}
                    />
                  </label>
                ) : (
                  <p className={css.memoryDetail}>{content}</p>
                )}
                <dl className={css.projectFacts}>
                  <div>
                    <dt>项目</dt>
                    <dd>{selected.projectId}</dd>
                  </div>
                  <div>
                    <dt>捕获者</dt>
                    <dd>{selected.capturedByUserId}</dd>
                  </div>
                  <div>
                    <dt>修订</dt>
                    <dd>r{selected.revision}</dd>
                  </div>
                  <div>
                    <dt>召回</dt>
                    <dd>{selected.recallCount}</dd>
                  </div>
                </dl>
                <div className={css.reviewActions}>
                  {editing ? (
                    <>
                      <button type="button" className={css.primaryButton} disabled={busy || content.trim().length === 0} onClick={() => void save()}>
                        <IconSettingsOutline14 size={14} />
                        保存记忆
                      </button>
                      <button
                        type="button"
                        className={css.outlineButton}
                        onClick={() => {
                          setEditing(false)
                          setContent(selected.content)
                        }}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={css.outlineButton}
                        onClick={() => {
                          setEditing(true)
                        }}
                      >
                        编辑记忆
                      </button>
                      <button type="button" className={css.dangerButton} onClick={() => void remove()} disabled={busy}>
                        删除记忆
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}

const COLLECTOR_MODE_LABELS: Record<CollectorStatus['mode'], string> = {
  active: '采集中',
  paused: '已暂停',
  'not-ready': '配置未就绪',
  'signed-out': '账号未登录',
  'authorization-revoked': '项目授权已撤销',
  'storage-error': '本地存储异常',
  failed: '上报失败',
}

function formatQueueBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function CollectorView({
  projectId,
  snapshot,
  loading,
  error,
  busy,
  onRefresh,
  onAction,
}: {
  projectId: string | undefined
  snapshot: CollectorSnapshot | undefined
  loading: boolean
  error: string | undefined
  busy: boolean
  onRefresh: () => void
  onAction: (action: 'pause' | 'resume' | 'flush' | 'clear') => void
}) {
  const status = snapshot !== undefined && snapshot.status === 'ready' ? snapshot.value : undefined
  const modeLabel = status === undefined ? '未知' : COLLECTOR_MODE_LABELS[status.mode]
  return (
    <div className={css.page}>
      <PageIntro
        eyebrow="数据采集"
        title="当前项目的采集管道状态"
        description="插件仅上报白名单结构化事件；提示词、回复、命令与文件路径不进入上报。服务端负责校验、去重和聚合。"
        action={
          <span className={css.collectorActions}>
            <button type="button" className={css.outlineButton} disabled={busy || loading} onClick={onRefresh}>
              <IconRefreshOutline16 size={15} />
              刷新状态
            </button>
            {status !== undefined && status.mode === 'paused' ? (
              <button
                type="button"
                className={css.outlineButton}
                disabled={busy || loading}
                onClick={() => {
                  onAction('resume')
                }}
              >
                <IconPlayOutline16 size={15} />
                恢复采集
              </button>
            ) : (
              <button
                type="button"
                className={css.outlineButton}
                disabled={busy || loading}
                onClick={() => {
                  onAction('pause')
                }}
              >
                <IconPauseOutline16 size={15} />
                暂停采集
              </button>
            )}
            <button
              type="button"
              className={css.outlineButton}
              disabled={busy || loading}
              onClick={() => {
                onAction('flush')
              }}
            >
              <IconQueueOutline14 size={15} />
              立即发送
            </button>
            <button
              type="button"
              className={css.outlineButton}
              disabled={busy || loading}
              onClick={() => {
                onAction('clear')
              }}
            >
              清空未上报数据
            </button>
          </span>
        }
      />
      {error !== undefined && (
        <div className={css.formError} role="alert">
          {error}
        </div>
      )}
      {snapshot !== undefined && snapshot.status === 'not-ready' && (
        <div className={css.panel} role="status">
          采集配置未就绪：缺少 {snapshot.missing.join('、')}。
        </div>
      )}
      {snapshot !== undefined && snapshot.status === 'failed' && (
        <div className={css.panel} role="alert">
          采集操作失败：{snapshot.message}
        </div>
      )}
      {snapshot === undefined && (loading ? <div className={css.panel}>正在读取采集状态…</div> : null)}
      {status !== undefined && (
        <>
          <div className={css.metricGrid}>
            <Metric label="采集模式" value={modeLabel} detail={projectId === undefined ? '请先选择 active 项目' : `当前项目 ${projectId}`} icon={<IconDataOutline16 size={16} />} />
            <Metric label="队列事件" value={String(status.queueEventCount)} detail={`占用 ${formatQueueBytes(status.queueByteCount)}`} icon={<IconQueueOutline14 size={16} />} />
            <Metric label="最近确认" value={status.lastAcceptedAt === null ? '暂无' : new Date(status.lastAcceptedAt).toLocaleTimeString()} detail={status.lastAcceptedAt === null ? '尚无 accepted 批次' : '服务端已确认最近批次'} icon={<IconSparkle16 size={16} />} />
            <Metric label="数据缺口" value={String(status.gapCount)} detail={status.gapCount > 0 ? '存在丢弃或未上报数据' : '暂无缺口'} icon={<IconInspectOutline12 size={16} />} />
          </div>
          <section className={css.panel}>
            <SectionHeading title="管道诊断" action={<span className={status.mode === 'paused' ? css.pausedTag : css.collectingTag}>{modeLabel}</span>} />
            <div className={css.eventList}>
              <div className={css.eventRow}>
                <span>项目绑定</span>
                <strong>{status.projectId === null ? '未绑定' : status.projectId}</strong>
                <p>
                  授权状态：
                  {status.authorizationState === 'authorized' ? '已授权' : status.authorizationState === 'revoked' ? '已撤销' : '未知'}
                </p>
                <em>{status.projectId === null ? '等待选择' : '已绑定'}</em>
              </div>
              <div className={css.eventRow}>
                <span>最近失败</span>
                <strong>{status.lastFailure === null ? '无' : `${status.lastFailure.stage} / ${status.lastFailure.code}`}</strong>
                <p>{status.lastFailure === null ? '管道未记录失败' : `${new Date(status.lastFailure.at).toLocaleString()} · ${status.lastFailure.summary}`}</p>
                <em>{status.lastFailure === null ? '健康' : '已记录'}</em>
              </div>
              <div className={css.eventRow}>
                <span>本地存储</span>
                <strong>{status.storageError === null ? '正常' : '异常'}</strong>
                <p>{status.storageError === null ? 'telemetry 队列可读写' : status.storageError}</p>
                <em>{status.storageError === null ? '正常' : '停发'}</em>
              </div>
            </div>
          </section>
          <div className={css.collectionNote}>
            <IconInspectOutline12 size={16} />
            <span>{status.gapCount > 0 ? `当前存在 ${status.gapCount} 条缺口记录：丢弃与未上报数据不会被伪装为健康。` : '未发送事件保存在本地队列；采集失败不会阻塞主对话。'}</span>
          </div>
        </>
      )}
    </div>
  )
}

function AgentConfigView({
  agent,
  agents,
  onAgentSelect,
}: {
  agent: AgentConfig
  agents: readonly AgentConfig[]
  onAgentSelect: (agentId: string) => void
}) {
  return (
    <div className={css.page}>
      <PageIntro
        eyebrow="Agent 配置"
        title="管理云平台里的 Coding Agent"
        description="查看不同 Agent 的模型、推理和执行参数。当前仅展示本地示例配置，未连接云端配置服务。"
        action={
          <span className={css.demoConfigTag}>
            <span className={css.statusWarn} />
            仅本地演示
          </span>
        }
      />
      <div className={css.agentConfigLayout}>
        <section className={css.panel}>
          <SectionHeading title="Agent 列表" action={<span className={css.mutedLabel}>{agents.length} 个配置</span>} />
          <div className={css.agentList} role="list" aria-label="Coding Agent 列表">
            {agents.map((item) => {
              const active = item.id === agent.id
              return (
                <button
                  key={item.id}
                  type="button"
                  className={active ? `${css.agentListItem} ${css.agentListItemActive}` : css.agentListItem}
                  aria-pressed={active}
                  onClick={() => {
                    onAgentSelect(item.id)
                  }}
                >
                  <span className={css.agentListIcon}>
                    <IconAgentPresetOutline16 size={17} />
                  </span>
                  <span className={css.agentListCopy}>
                    <strong>{item.name}</strong>
                    <small>{item.description}</small>
                  </span>
                  <span className={item.status === '运行中' ? css.agentRunning : css.agentPaused}>
                    <span className={item.status === '运行中' ? css.statusLive : css.statusWarn} />
                    {item.status}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <section className={`${css.panel} ${css.agentDetail}`}>
          <div className={css.agentDetailHeader}>
            <div className={css.agentDetailIdentity}>
              <span className={css.agentDetailIcon}>
                <IconAgentPresetOutline16 size={20} />
              </span>
              <div>
                <span className={css.eyebrow}>Coding Agent</span>
                <h2>{agent.name}</h2>
                <p>{agent.description}</p>
              </div>
            </div>
            <span className={agent.status === '运行中' ? css.agentRunning : css.agentPaused}>
              <span className={agent.status === '运行中' ? css.statusLive : css.statusWarn} />
              {agent.status}
            </span>
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
            <div className={css.agentSkillList}>
              {agent.skills.map(skill => (
                <span key={skill} className={css.agentSkillTag}>
                  <IconSkillOutline16 size={14} />
                  {skill}
                </span>
              ))}
            </div>
          </div>

          <div className={css.agentSection}>
            <SectionHeading title="上下文策略" />
            <div className={css.agentToggleRow}>
              <div>
                <strong>自动注入项目上下文</strong>
                <small>运行任务时带入当前项目、分支和授权资产摘要。</small>
              </div>
              <span className={agent.autoContext ? `${css.toggle} ${css.toggleOn}` : css.toggle} aria-label={agent.autoContext ? '已开启' : '已关闭'}>
                <i />
              </span>
            </div>
          </div>

          <div className={css.agentConfigFooter}>
            <span>最后更新于 {agent.updated}</span>
            <button type="button" className={css.outlineButton} disabled title="演示版本未连接云端配置服务">
              <IconSettingsOutline14 size={14} />
              保存配置
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

function AgentField({ label, value }: { label: string; value: string }) {
  return (
    <div className={css.agentField}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className={css.pageIntro}>
      <div>
        <span className={css.eyebrow}>{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action !== undefined && <div className={css.pageAction}>{action}</div>}
    </div>
  )
}

function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className={css.sectionHeading}>
      <h2>{title}</h2>
      {action}
    </div>
  )
}

function Metric({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: ReactNode }) {
  return (
    <div className={css.metric}>
      <span className={css.metricIcon}>{icon}</span>
      <span className={css.metricLabel}>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
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

function formatMemoryDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function currentStorageKey(userId: string | undefined): string {
  return `dsh.ai-coding-platform.project:${window.location.origin}:${userId ?? 'signed-out'}`
}

function readStoredProjectId(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function writeStoredProjectId(key: string, projectId: string): void {
  try {
    window.localStorage.setItem(key, projectId)
  } catch {
    /* Storage is optional in embedded clients. */
  }
}

function clearStoredProjectId(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* Storage is optional in embedded clients. */
  }
}

function groupProjects(projects: readonly TeamSkillProject[]): readonly {
  readonly organizationId: string
  readonly organizationName: string
  readonly projects: readonly TeamSkillProject[]
}[] {
  const groups = new Map<
    string,
    {
      readonly organizationId: string
      readonly organizationName: string
      readonly projects: TeamSkillProject[]
    }
  >()
  for (const project of projects) {
    const group = groups.get(project.organizationId) ?? {
      organizationId: project.organizationId,
      organizationName: project.organizationName,
      projects: [],
    }
    group.projects.push(project)
    groups.set(project.organizationId, group)
  }
  return [...groups.values()]
}

function isHostFailure(value: unknown): value is
  | { readonly status: 'not-ready'; readonly missing: readonly string[] }
  | {
    readonly status: 'failed'
    readonly code: string
    readonly message: string
  } {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false
  const status = value.status
  return status === 'not-ready' || status === 'failed'
}

function isSignedOut(value: unknown): value is { readonly status: 'signed-out' } {
  return typeof value === 'object' && value !== null && 'status' in value && value.status === 'signed-out'
}

function isMemoryMutation(value: unknown): value is TeamSkillMemoryMutation {
  return typeof value === 'object' && value !== null && 'jobId' in value && typeof value.jobId === 'string'
}

type MemoryMutationResult = { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly message: string } }

function memoryMutationValue(result: MemoryMutationResult, setError: (message: string) => void): TeamSkillMemoryMutation | undefined {
  if (!result.ok) {
    setError(result.error.message)
    return undefined
  }
  if (isHostFailure(result.value) || isSignedOut(result.value)) {
    setError(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
    return undefined
  }
  if (!isMemoryMutation(result.value)) return undefined
  return result.value
}

function hostFailureMessage(
  value:
    | { readonly status: 'not-ready'; readonly missing: readonly string[] }
    | {
      readonly status: 'failed'
      readonly code: string
      readonly message: string
    },
): string {
  return value.status === 'not-ready' ? `服务端未就绪：${value.missing.join('、')}` : value.message
}

function remoteFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : '无法读取服务端授权，请稍后重试。'
}

function isAccessSummary(value: unknown): value is TeamSkillAccessSummary {
  return typeof value === 'object' && value !== null && 'organizations' in value && Array.isArray(value.organizations) && 'projects' in value && Array.isArray(value.projects) && 'assets' in value && Array.isArray(value.assets)
}
