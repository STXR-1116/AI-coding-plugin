import { useEffect, useMemo, useState } from 'react'
import type {
  ClientRemote,
  TeamSkillCatalogItem,
  TeamSkillEnvironment,
  TeamSkillInstallationView,
  TeamSkillProject,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutline14,
  IconCloseOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSkillOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TeamSkillsView.module.css'

export interface TeamSkillsViewProps {
  /** Typed DSH Remote assembly carrying the Host-owned Team Skill namespace. */
  readonly remote: ClientRemote
  /** DSH workspace projection used only to select an opaque project id. */
  readonly useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
  /** Opaque selected project identity used for server-side authorization. */
  readonly projectId?: string
  /** Projects the account may explicitly choose for project-scoped Skill operations. */
  readonly projects: readonly TeamSkillProject[]
  /** Set the explicit project context for Skill operations. */
  readonly onProjectSelect?: (projectId: string) => void
  /** Local dependency facts sent to the Host without paths or values. */
  readonly environment: TeamSkillEnvironment
  /** Server-authoritative Skill identifiers visible in the selected project. */
  readonly visibleSkillIds: readonly string[]
  /** Refresh the Host account when the service reports an authorization failure. */
  readonly onAuthorizationFailure?: () => void
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'project-required' }
  | {
    readonly status: 'ready'
    readonly items: readonly TeamSkillCatalogItem[]
    readonly installations: readonly TeamSkillInstallationView[]
  }
  | { readonly status: 'error'; readonly title: string; readonly message: string }

type Scope = 'project' | 'global'

/** Render the server-authoritative local Team Skill catalogue and installer. */
export function TeamSkillsView({
  remote,
  useWorkspaces,
  projectId,
  projects,
  onProjectSelect,
  environment,
  visibleSkillIds,
  onAuthorizationFailure,
}: TeamSkillsViewProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<TeamSkillCatalogItem | undefined>()
  const [view, setView] = useState<'discover' | 'installed'>('discover')
  const [scope, setScope] = useState<Scope>('project')
  const [installing, setInstalling] = useState<string | undefined>()
  const [operationMessage, setOperationMessage] = useState<string | undefined>()

  const load = async (): Promise<void> => {
    if (projectId === undefined) {
      setState({ status: 'project-required' })
      return
    }
    const selectedProjectId = projectId
    setState({ status: 'loading' })
    const [catalogResult, installationsResult] = await Promise.all([
      remote.teamSkills.catalog(selectedProjectId),
      remote.teamSkills.syncReleaseStatus(selectedProjectId),
    ])
    if (!catalogResult.ok) {
      if (isAuthorizationFailure(catalogResult.error.code)) onAuthorizationFailure?.()
      setState({ status: 'error', title: '团队 Skill 暂不可用', message: catalogResult.error.message })
      return
    }
    if (catalogResult.value.status !== 'ready') {
      if (catalogResult.value.status === 'failed' && isAuthorizationFailure(catalogResult.value.code)) onAuthorizationFailure?.()
      setState({ status: 'error', title: '团队 Skill 暂不可用', message: catalogMessage(catalogResult.value) })
      return
    }
    if (!installationsResult.ok) {
      if (isAuthorizationFailure(installationsResult.error.code)) onAuthorizationFailure?.()
      setState({ status: 'error', title: '无法读取本地安装状态', message: installationsResult.error.message })
      return
    }
    if (!isInstallationList(installationsResult.value)) {
      if (installationsResult.value.status === 'failed' && isAuthorizationFailure(installationsResult.value.code))
        onAuthorizationFailure?.()
      setState({ status: 'error', title: '无法读取本地安装状态', message: localInstallationMessage(installationsResult.value) })
      return
    }
    setState({ status: 'ready', items: catalogResult.value.catalog.items, installations: installationsResult.value })
  }

  useEffect(() => {
    void load()
  }, [remote, projectId])

  const filtered = useMemo(() => {
    if (state.status !== 'ready') return []
    const normalized = query.trim().toLocaleLowerCase()
    const visible = state.items.filter(item => visibleSkillIds.includes(item.skillId))
    if (!normalized) return visible
    return visible.filter(item =>
      `${item.displayName}${item.summary}${item.category}${item.tags.join('')}`.toLocaleLowerCase().includes(normalized),
    )
  }, [query, state, visibleSkillIds])

  const installedFor = (item: TeamSkillCatalogItem): TeamSkillInstallationView | undefined => {
    if (state.status !== 'ready') return undefined
    return state.installations.find(value => value.skillId === item.skillId && value.version === item.version && value.state === 'normal')
  }

  const install = async (): Promise<void> => {
    if (selected === undefined || installing !== undefined) return
    if (projectId === undefined) return
    const selectedProjectId = projectId
    if (scope === 'project' && workspaces[0] === undefined) return
    setInstalling(selected.skillId)
    setOperationMessage(undefined)
    const result = await remote.teamSkills.installSkill({
      skillId: selected.skillId,
      version: selected.version,
      projectId: selectedProjectId,
      scope,
      ...(scope === 'project' && workspaces[0] !== undefined ? { workspaceId: workspaces[0].workspaceId } : {}),
      environment,
    })
    setInstalling(undefined)
    if (!result.ok) {
      if (isAuthorizationFailure(result.error.code)) onAuthorizationFailure?.()
      setOperationMessage(`安装失败：${result.error.message}`)
      return
    }
    if (result.value.status === 'not-ready') {
      setOperationMessage(`安装失败：服务端未就绪，缺少配置：${result.value.missing.join('、')}`)
      return
    }
    if (result.value.status === 'failed') {
      setOperationMessage(`安装失败：${result.value.message}`)
      return
    }
    const installation = result.value.installation
    setState(previous =>
      previous.status === 'ready'
        ? {
          ...previous,
          installations: [
            ...previous.installations.filter(item => !(item.skillId === selected.skillId && item.scope === scope)),
            installation,
          ],
        }
        : previous,
    )
    setOperationMessage(scope === 'project' ? '已安装到当前项目' : '已安装到全局 DSH')
    setSelected(undefined)
  }

  const uninstall = async (installation: TeamSkillInstallationView): Promise<void> => {
    if (installing !== undefined) return
    setInstalling(installation.localInstallationId)
    setOperationMessage(undefined)
    const result = await remote.teamSkills.uninstallSkill({ localInstallationId: installation.localInstallationId })
    setInstalling(undefined)
    if (!result.ok) {
      if (isAuthorizationFailure(result.error.code)) onAuthorizationFailure?.()
      setOperationMessage(`卸载失败：${result.error.message}`)
      return
    }
    if (result.value.status === 'failed') {
      setOperationMessage(`卸载失败：${result.value.message}`)
      return
    }
    if (result.value.status === 'not-ready') {
      setOperationMessage(`卸载失败：本地状态未就绪：${result.value.missing.join('、')}`)
      return
    }
    const updatedInstallation = result.value.installation
    setState(previous =>
      previous.status === 'ready'
        ? {
          ...previous,
          installations: previous.installations.map(item =>
            item.localInstallationId === installation.localInstallationId ? updatedInstallation : item,
          ),
        }
        : previous,
    )
    setOperationMessage('已从 DSH 移除该 Skill')
  }

  if (state.status === 'loading')
    return (
      <section className={css.pageState} aria-live="polite">
        <IconRefreshOutline16 size={18} />
        <h2>正在读取团队 Skill</h2>
        <p>从平台服务获取当前用户可见的已发布版本。</p>
      </section>
    )
  if (state.status === 'project-required')
    return (
      <section className={css.pageState} role="status">
        <IconSkillOutline16 size={18} />
        <h2>选择项目后查看 Skill</h2>
        <p>项目级 Skill 目录和安装操作需要显式项目上下文。</p>
        <div className={css.projectOptions}>
          {projects.map(project => (
            <button
              type="button"
              key={project.projectId}
              className={css.secondaryButton}
              onClick={() => {
                onProjectSelect?.(project.projectId)
              }}
            >
              {project.name}
            </button>
          ))}
        </div>
        {projects.length === 0 && <p>当前账号没有可访问的项目。</p>}
      </section>
    )
  if (state.status === 'error')
    return (
      <section className={css.pageState} role="alert">
        <IconCloseOutline16 size={18} />
        <h2>{state.title}</h2>
        <p>{state.message}</p>
        <button type="button" className={css.secondaryButton} onClick={() => void load()}>
          <IconRefreshOutline16 size={15} />
          重新读取
        </button>
      </section>
    )

  return (
    <section className={css.page} aria-label="团队 Skill">
      <div className={css.header}>
        <div>
          <span className={css.eyebrow}>团队 Skill</span>
          <h1>把已发布能力安装到本地 DSH</h1>
          <p>目录由服务端按权限返回，安装由 Host 校验制品并写入 DSH 原生目录。</p>
        </div>
        <div className={css.actions}>
          <label className={css.search}>
            <span className={css.searchIcon}>⌕</span>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              placeholder="搜索 Skill"
            />
          </label>
          <button type="button" className={css.secondaryButton} onClick={() => void load()} title="刷新目录">
            <IconRefreshOutline16 size={15} />
            刷新
          </button>
        </div>
      </div>
      {operationMessage !== undefined && (
        <div className={css.operation} role="status">
          <IconCheckOutline14 size={15} />
          {operationMessage}
        </div>
      )}
      <div className={css.tabs} role="tablist" aria-label="团队 Skill 视图">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'discover'}
          className={view === 'discover' ? css.tabActive : css.tab}
          onClick={() => {
            setView('discover')
          }}
        >
          发现
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'installed'}
          className={view === 'installed' ? css.tabActive : css.tab}
          onClick={() => {
            setView('installed')
          }}
        >
          已安装 ({state.installations.filter(item => item.state === 'normal').length})
        </button>
      </div>
      {view === 'discover' &&
        (filtered.length === 0 ? (
          <div className={css.empty}>
            <IconSkillOutline16 size={21} />
            <h2>没有匹配的已发布 Skill</h2>
            <p>请调整搜索词，或等待管理员发布新的平台制品。</p>
          </div>
        ) : (
          <div className={css.grid}>
            {filtered.map((item) => {
              const installation = installedFor(item)
              return (
                <article key={item.skillId} className={css.card}>
                  <div className={css.cardTop}>
                    <span className={css.skillIcon}>
                      <IconSkillOutline16 size={17} />
                    </span>
                    <span className={css.published}>已发布</span>
                  </div>
                  <h2>{item.displayName}</h2>
                  <p>{item.summary}</p>
                  <div className={css.meta}>
                    <span>{item.category}</span>
                    <span>平台托管版本 v{item.version}</span>
                  </div>
                  <div className={css.tags}>
                    {item.tags.map(tag => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <div className={css.cardBottom}>
                    {installation !== undefined ? (
                      <span className={css.installed}>
                        <IconCheckOutline14 size={14} />
                        {installation.scope === 'project' ? '当前项目已安装' : '全局已安装'}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={css.installButton}
                        onClick={() => {
                          setSelected(item)
                          setScope(workspaces[0] === undefined ? 'global' : 'project')
                        }}
                      >
                        <IconPlusOutline16 size={15} />
                        安装 Skill
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        ))}
      {view === 'installed' && (
        <div className={css.grid}>
          {state.installations
            .filter(item => item.state !== 'uninstalled' && visibleSkillIds.includes(item.skillId))
            .map((item) => {
              const catalogItem = state.items.find(value => value.skillId === item.skillId)
              return (
                <article key={item.localInstallationId} className={css.card}>
                  <div className={css.cardTop}>
                    <span className={css.skillIcon}>
                      <IconSkillOutline16 size={17} />
                    </span>
                    <span className={item.state === 'withdrawn' ? css.withdrawn : css.published}>
                      {item.state === 'withdrawn' ? '已隔离' : '已安装'}
                    </span>
                  </div>
                  <h2>{catalogItem?.displayName ?? item.runtimeName}</h2>
                  <p>{catalogItem?.summary ?? '本地已安装的 Team Skill'}</p>
                  <div className={css.meta}>
                    <span>{item.scope === 'project' ? '当前项目' : '全局 DSH'}</span>
                    <span>v{item.version}</span>
                  </div>
                  <div className={css.tags}>
                    <span>SHA-256 {item.artifactSha256.slice(0, 12)}...</span>
                  </div>
                  <div className={css.cardBottom}>
                    {item.state === 'withdrawn' ? (
                      <span className={css.withdrawnText}>版本已下线，内容保留在隔离区</span>
                    ) : (
                      <button
                        type="button"
                        className={css.secondaryButton}
                        disabled={installing !== undefined}
                        onClick={() => void uninstall(item)}
                      >
                        <IconCloseOutline16 size={14} />
                        卸载
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
        </div>
      )}

      {selected !== undefined && (
        <div className={css.backdrop} role="presentation">
          <div className={css.modal} role="dialog" aria-modal="true" aria-label={`安装${selected.displayName}`}>
            <div className={css.modalHeader}>
              <div>
                <span className={css.eyebrow}>安装确认</span>
                <h2>{selected.displayName}</h2>
              </div>
              <button
                type="button"
                className={css.close}
                aria-label="关闭安装确认"
                onClick={() => {
                  setSelected(undefined)
                }}
              >
                <IconCloseOutline16 size={16} />
              </button>
            </div>
            <p className={css.modalLead}>将安装不可变的 v{selected.version} 制品。文件校验和写入由 DSH Host 完成。</p>
            <fieldset className={css.scopeField}>
              <legend>安装作用域</legend>
              <label className={scope === 'project' ? css.scopeOptionActive : css.scopeOption}>
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'project'}
                  disabled={workspaces[0] === undefined}
                  onChange={() => {
                    setScope('project')
                  }}
                />
                <span>
                  <strong>当前项目</strong>
                  <small>{workspaces[0] === undefined ? '当前没有可用的 DSH 工作区' : '优先于全局副本供当前项目使用'}</small>
                </span>
              </label>
              <label className={scope === 'global' ? css.scopeOptionActive : css.scopeOption}>
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'global'}
                  onChange={() => {
                    setScope('global')
                  }}
                />
                <span>
                  <strong>全局 DSH</strong>
                  <small>供所有未配置项目使用</small>
                </span>
              </label>
            </fieldset>
            <div className={css.modalFooter}>
              <button
                type="button"
                className={css.secondaryButton}
                onClick={() => {
                  setSelected(undefined)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={css.primaryButton}
                disabled={installing !== undefined || (scope === 'project' && workspaces[0] === undefined)}
                onClick={() => void install()}
              >
                {installing !== undefined ? '正在安装…' : scope === 'project' ? '确认安装到当前项目' : '确认安装到全局 DSH'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function catalogMessage(
  value:
    | { readonly status: 'not-ready'; readonly missing: readonly string[] }
    | { readonly status: 'failed'; readonly code: string; readonly message: string },
): string {
  return value.status === 'not-ready' ? `服务端未就绪，缺少配置：${value.missing.join('、')}` : value.message
}

function localInstallationMessage(
  value:
    | { readonly status: 'not-ready'; readonly missing: readonly string[] }
    | { readonly status: 'failed'; readonly code: string; readonly message: string },
): string {
  return value.status === 'not-ready' ? `本地安装状态未就绪：${value.missing.join('、')}` : value.message
}

function isInstallationList(
  value:
    | readonly TeamSkillInstallationView[]
    | { readonly status: 'not-ready'; readonly missing: readonly string[] }
    | { readonly status: 'failed'; readonly code: string; readonly message: string },
): value is readonly TeamSkillInstallationView[] {
  return Array.isArray(value)
}

function isAuthorizationFailure(code: string): boolean {
  return (
    code === 'UNAUTHORIZED' ||
    code === 'AUTH_REQUIRED' ||
    code === 'TOKEN_EXPIRED' ||
    code === 'TOKEN_REVOKED' ||
    code === 'FORBIDDEN' ||
    code === 'ACCOUNT_SUSPENDED' ||
    code === 'PROJECT_NOT_MEMBER' ||
    code === 'RESOURCE_NOT_FOUND' ||
    code === 'NO_ORGANIZATION_ACCESS'
  )
}
