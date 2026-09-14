import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AgentProfileSummary,
  AgentRunSnapshot,
  CloudWorkspace,
  WorkspaceChanges,
  WorkspaceCodeSource,
  WorkspaceDirectory,
  WorkspaceFailure,
  WorkspacePreview,
  WorkspaceQueryResult,
  WorkspaceStreamState,
} from '@deepseek-ai/dsh-ai-coding-platform/types'
import { IconFolderOpenOutline16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './CloudWorkspacesView.module.css'

/** Failure codes that mean the Host account session must be refreshed upstream. */
const AUTHORIZATION_FAILURE_CODES = new Set(['AUTH_REQUIRED', 'TOKEN_EXPIRED', 'UNAUTHORIZED', 'FORBIDDEN'])

/** One switcher face: opaque session ids, the current one, and display labels. */
export interface NativeSessionRow {
  readonly ids: readonly string[]
  readonly current?: string | undefined
  readonly titleOf: (sessionId: string) => string
}

export interface CloudWorkspacesViewProps {
  /** Typed DSH Remote assembly carrying the Host-owned cloud workspace namespace. */
  readonly remote: ClientRemote
  /** DSH workspace projection used only to select an opaque project id. */
  readonly useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
  /** Opaque selected project identity used for server-side authorization. */
  readonly projectId?: string
  /** Projects the account may explicitly choose for cloud workspaces. */
  readonly projects: readonly TeamSkillProject[]
  /** Set the explicit project context. */
  readonly onProjectSelect?: (projectId: string) => void
  /** Current DSH session id bound into every Run request. */
  readonly sessionId?: string
  /** Native session rows the center-pane switcher offers. */
  readonly nativeSessions?: NativeSessionRow
  /** Select the current native session from the workbench switcher. */
  readonly openSession?: (sessionId: string) => void
  /** The native New Session flow, offered beside the switcher. */
  readonly startSession?: () => void
  /**
   * Account the workbench is signed in as.
   *
   * Every retained selection is scoped by it: a workbench that signed out and
   * back in as someone else must not reopen the previous account's workspace,
   * file or pane.
   */
  readonly accountId?: string
  /** Refresh the Host account when the service reports an authorization failure. */
  readonly onAuthorizationFailure?: () => void
}

type Pane = 'preview' | 'changes' | 'run'

interface WorkspaceState {
  readonly workspaces: readonly CloudWorkspace[]
  readonly selected?: CloudWorkspace | undefined
  readonly directory?: WorkspaceDirectory | undefined
  readonly profiles: readonly AgentProfileSummary[]
  readonly changes?: WorkspaceChanges | undefined
  readonly preview?: WorkspacePreview | undefined
  readonly runs: readonly AgentRunSnapshot[]
}

const READY = <T,>(result: WorkspaceQueryResult<T>): T | undefined => (result.status === 'ready' ? result.value : undefined)

/** Client Remote envelope: transport failure is reported before the domain result. */
type RemoteEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

function unwrap<T>(envelope: RemoteEnvelope<T>): T {
  if (!envelope.ok) return { status: 'failed', code: envelope.error.code, message: envelope.error.message } as T
  return envelope.value
}

/**
 * Splits one transport envelope around the stream state, which - unlike a
 * workspace query - is a bare state and never a `WorkspaceQueryResult`.
 */
function streamOutcome(envelope: RemoteEnvelope<WorkspaceStreamState>): WorkspaceStreamState | WorkspaceFailure {
  return envelope.ok ? envelope.value : { status: 'failed', code: envelope.error.code, message: envelope.error.message }
}

/** One batch of the Host's stream event channel; the shape the Remote declares in place. */
interface StreamEventBatch {
  readonly events: readonly { readonly eventId: string; readonly resourceType: string }[]
  readonly truncated: boolean
}

/** Discriminated split for the bare event batch of the stream event channel. */
type EventBatchOutcome =
  | { readonly ok: true; readonly batch: StreamEventBatch }
  | { readonly ok: false; readonly failure: WorkspaceFailure }

function eventBatchOutcome(envelope: RemoteEnvelope<StreamEventBatch>): EventBatchOutcome {
  return envelope.ok
    ? { ok: true, batch: envelope.value }
    : { ok: false, failure: { status: 'failed', code: envelope.error.code, message: envelope.error.message } }
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  provisioning: '初始化中',
  starting: '启动中',
  ready: 'ready',
  degraded: '降级',
  stopping: '停止中',
  stopped: '已停止',
  failed: '失败',
  archived: '已归档',
  deleting: '删除中',
  unknown: '未知状态',
}


/** 两处配置版本下拉共用的选项列表(名称 + 不透明版本 ID)。 */
function ProfileOptions({ profiles }: { readonly profiles: readonly AgentProfileSummary[] }) {
  return (
    <>
      {profiles.map(profile => (
        <option key={profile.agentProfileVersionId} value={profile.agentProfileVersionId}>
          {profile.name} ({profile.agentProfileVersionId})
        </option>
      ))}
    </>
  )
}

/**
 * Cadence of the single scoped stream subscription's state poll. The Remote
 * exposes the Host stream state (not raw events), so the view re-reads the
 * authoritative snapshot whenever the Host watermark advances.
 */
const STREAM_POLL_INTERVAL_MS = 300

/** Lifecycle operations carried by the `workspaceAction` Remote call. */
type LifecycleAction = 'start' | 'stop' | 'retry' | 'archive'

/** Every lifecycle entry point the view offers; `delete` is its own Remote call. */
type LifecycleEntry = LifecycleAction | 'delete'

/** Lifecycle entry points, keyed by the states each one accepts. */
const LIFECYCLE_TRANSITIONS = {
  start: ['draft', 'stopped', 'failed'],
  stop: ['provisioning', 'starting', 'ready', 'degraded'],
  retry: ['failed'],
  archive: ['draft', 'provisioning', 'starting', 'ready', 'degraded', 'stopped', 'failed'],
  delete: ['stopped', 'archived', 'failed', 'draft'],
} as const satisfies Record<LifecycleEntry, readonly CloudWorkspace['status'][]>

/** Downstream dependency failures: the runtime behind the workspace refused the call. */
const DOWNSTREAM_FAILURE_CODES = new Set(['SERVICE_UNAVAILABLE', 'BAD_GATEWAY', 'GATEWAY_TIMEOUT'])

/** State-machine rejections, including acting on an already-archived workspace. */
const INVALID_STATE_CODES = new Set(['INVALID_STATUS', 'ALREADY_ARCHIVED'])

/** Feedback channels; each maps one family of service outcomes onto explicit user copy. */
type FeedbackTone = 'success' | 'fixture' | 'busy' | 'conflict' | 'denied' | 'downstream' | 'invalid' | 'error'

interface ActionFeedback {
  readonly tone: FeedbackTone
  /** The stable service code (or the operation name on success) shown with the message. */
  readonly code: string
  readonly message: string
}

/** Pending destructive operation awaiting explicit confirmation. */
interface PendingConfirmation {
  readonly action: LifecycleEntry | 'discard'
  readonly workspaceId: string
}

/** Button copy for each confirmed operation. */
const CONFIRM_LABEL: Record<PendingConfirmation['action'], string> = {
  start: '确认启动',
  stop: '确认停止',
  retry: '确认重试',
  archive: '确认归档',
  delete: '确认删除',
  discard: '确认丢弃',
}

/** Human copy describing what each confirmed operation does. */
const CONFIRM_DESCRIPTION: Record<PendingConfirmation['action'], string> = {
  start: '启动该 Workspace',
  stop: '停止该 Workspace',
  retry: '重试该 Workspace',
  archive: '归档该 Workspace（归档后写入将被服务端拒绝）',
  delete: '删除该 Workspace（不可恢复）',
  discard: '丢弃全部未提交变更',
}

/** Button copy for each lifecycle operation. */
const LIFECYCLE_LABEL: Record<LifecycleEntry, string> = {
  start: '启动',
  stop: '停止',
  retry: '重试',
  archive: '归档',
  delete: '删除',
}

const LIFECYCLE_ORDER: readonly LifecycleEntry[] = ['start', 'stop', 'retry', 'archive', 'delete']

/** Provenance marker the UI must show whenever the service declared fixture-only data. */
const FIXTURE_ONLY_LABEL = 'fixture-only'

/** The service-declared provenance of one ready result; other outcomes carry none. */
function readyProvenance(result: WorkspaceQueryResult<unknown>): boolean {
  return result.status === 'ready' && result.fixtureOnly
}

/**
 * Success feedback that never presents fixture-served data as production success:
 * a fixture-only result is labelled as such instead of a plain success tone.
 */
function successFeedback(code: string, message: string, fixtureOnly: boolean): ActionFeedback {
  return fixtureOnly
    ? { tone: 'fixture', code: `${code}·${FIXTURE_ONLY_LABEL}`, message }
    : { tone: 'success', code, message }
}

/** Maps a stable service code onto its feedback channel; unknown codes stay explicit. */
function failureFeedback(code: string, message: string): ActionFeedback {
  if (code === 'WORKSPACE_BUSY') return { tone: 'busy', code, message }
  if (code === 'REVISION_CONFLICT') return { tone: 'conflict', code, message }
  if (AUTHORIZATION_FAILURE_CODES.has(code)) return { tone: 'denied', code, message }
  if (DOWNSTREAM_FAILURE_CODES.has(code)) return { tone: 'downstream', code, message }
  if (INVALID_STATE_CODES.has(code)) return { tone: 'invalid', code, message }
  return { tone: 'error', code, message }
}

/** True while `status` legally admits the lifecycle operation. */
function admitsLifecycle(status: CloudWorkspace['status'], action: LifecycleEntry): boolean {
  return (LIFECYCLE_TRANSITIONS[action] as readonly CloudWorkspace['status'][]).includes(status)
}

/**
 * Enforces the workbench's isolation floor on a service-declared sandbox.
 *
 * `allow-scripts` together with `allow-same-origin` lets a framed document drop
 * its own sandbox attribute and then reach the embedding page's DOM, storage and
 * credentials. The pair is never granted: the workbench drops
 * `allow-same-origin` instead of trusting the service to have avoided it, and
 * it never adds a token the service did not ask for.
 * @param declared - Sandbox tokens the service returned.
 * @returns the sandbox attribute value actually applied.
 */
function isolatedSandbox(declared: readonly string[]): string {
  const tokens = new Set(declared)
  if (tokens.has('allow-scripts')) tokens.delete('allow-same-origin')
  return [...tokens].join(' ')
}

/** Escapes a value for use inside a double-quoted HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Applies the service-declared CSP to a static preview document.
 *
 * A `sandbox` attribute isolates the frame but says nothing about what the
 * document may fetch, so the returned policy is installed as the document's own
 * `Content-Security-Policy` meta. The policy is inserted first in `head`, which
 * is the only position a browser honors for a meta policy.
 * @param content - The HTML body the service returned.
 * @param csp - The policy the service returned.
 * @returns the document to render in the frame.
 */
function applyPreviewCsp(content: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`
  const headOpen = content.indexOf('<head')
  if (headOpen !== -1) {
    const headClose = content.indexOf('>', headOpen)
    if (headClose !== -1) return `${content.slice(0, headClose + 1)}${meta}${content.slice(headClose + 1)}`
  }
  const htmlOpen = content.indexOf('<html')
  if (htmlOpen !== -1) {
    const htmlClose = content.indexOf('>', htmlOpen)
    if (htmlClose !== -1) return `${content.slice(0, htmlClose + 1)}<head>${meta}</head>${content.slice(htmlClose + 1)}`
  }
  return `<!DOCTYPE html><html><head>${meta}</head><body>${content}</body></html>`
}

/** Looks up one authorized code source by its repository id. */
function codeSourceOf(sources: readonly WorkspaceCodeSource[], repositoryId: string): WorkspaceCodeSource | undefined {
  return sources.find(source => source.repositoryId === repositoryId)
}

/** Codex-style three-pane cloud workbench: remote tree, DSH session, Preview/Changes/Run. */
export function CloudWorkspacesView({
  remote,
  useWorkspaces: _useWorkspaces,
  projectId,
  projects,
  onProjectSelect,
  sessionId,
  nativeSessions,
  openSession,
  startSession,
  accountId,
  onAuthorizationFailure,
}: CloudWorkspacesViewProps) {
  const [state, setState] = useState<WorkspaceState>({ workspaces: [], profiles: [], runs: [] })
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [openPath, setOpenPath] = useState<string | undefined>()
  const [pane, setPane] = useState<Pane>('preview')
  const [drawer, setDrawer] = useState<'none' | 'left' | 'right'>('none')
  const [conflictMessage, setConflictMessage] = useState<string | undefined>()
  const [streamStatus, setStreamStatus] = useState<WorkspaceStreamState>({ status: 'idle' })
  const [webAppGrant, setWebAppGrant] = useState<{ readonly url: string; readonly expiresAt: string } | undefined>()
  // Set when a grant's own deadline passes: the entry point is removed and the
  // pane offers exactly one action — re-issue the short-lived URL.
  const [webAppExpired, setWebAppExpired] = useState(false)
  const [treePath, setTreePath] = useState('')
  const [overrideProfileId, setOverrideProfileId] = useState('')
  const [runDetail, setRunDetail] = useState<AgentRunSnapshot | undefined>()
  const [draftBranch, setDraftBranch] = useState('')
  const [draftRepositoryId, setDraftRepositoryId] = useState('')
  const [repositories, setRepositories] = useState<readonly WorkspaceCodeSource[]>([])
  const [repositoriesState, setRepositoriesState] = useState<'loading' | 'ready' | 'empty' | 'failed'>('loading')
  const [loadError, setLoadError] = useState<{ code: string; message: string } | undefined>()
  const [signedOut, setSignedOut] = useState(false)
  const [fixtureOnly, setFixtureOnly] = useState(false)
  const [feedback, setFeedback] = useState<ActionFeedback | undefined>()
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmation | undefined>()
  const [commitMessage, setCommitMessage] = useState('')
  const [pullRequestTitle, setPullRequestTitle] = useState('')
  const generation = useRef(0)
  const workspacesGeneration = useRef(0)
  const profilesGeneration = useRef(0)
  const previewGeneration = useRef(0)
  const grantGeneration = useRef(0)
  const repositoriesGeneration = useRef(0)
  const directoryGeneration = useRef(0)
  const openPathRef = useRef<string | undefined>(undefined)
  const treePathRef = useRef('')
  /** Watermark of the last SSE event this view applied. */
  const streamEventWatermark = useRef('')
  const streamStateKey = useRef('')

  const applyResult = useCallback((result: WorkspaceQueryResult<unknown>): boolean => {
    if (result.status === 'ready') {
      setSignedOut(false)
      setFixtureOnly(result.fixtureOnly)
      return true
    }
    if (result.status === 'signed-out') {
      setSignedOut(true)
      onAuthorizationFailure?.()
      setFeedback({ tone: 'denied', code: 'SIGNED_OUT', message: '账号已登出，请重新登录后再执行操作。' })
      return false
    }
    if (result.status === 'not-ready') {
      setLoadError({ code: 'SERVICE_NOT_READY', message: `服务未就绪：缺少 ${result.missing.join('、')}` })
      return false
    }
    if (AUTHORIZATION_FAILURE_CODES.has(result.code)) {
      setSignedOut(true)
      onAuthorizationFailure?.()
      setFeedback(failureFeedback(result.code, result.message))
      return false
    }
    setLoadError({ code: result.code, message: result.message })
    return false
  }, [onAuthorizationFailure])

  /**
   * Reports a failed write through the feedback channel: authorization failures
   * still sign the account out, everything else keeps the action context.
   */
  const reportFailure = useCallback((result: WorkspaceQueryResult<unknown>): void => {
    if (result.status === 'ready') return
    if (result.status === 'signed-out') {
      setSignedOut(true)
      onAuthorizationFailure?.()
      setFeedback({ tone: 'denied', code: 'SIGNED_OUT', message: '账号已登出，请重新登录后再执行操作。' })
      return
    }
    if (result.status === 'not-ready') {
      setLoadError({ code: 'SERVICE_NOT_READY', message: `服务未就绪：缺少 ${result.missing.join('、')}` })
      return
    }
    // Only the failure variant is left: sign out on an authorization code, then
    // always report the stable code through the feedback channel.
    if (AUTHORIZATION_FAILURE_CODES.has(result.code)) setSignedOut(true)
    setFeedback(failureFeedback(result.code, result.message))
  }, [onAuthorizationFailure])

  /** Replaces one workspace in place from an authoritative server snapshot. */
  const applySnapshot = useCallback((snapshot: CloudWorkspace): void => {
    setState(previous => ({
      ...previous,
      workspaces: previous.workspaces.some(item => item.workspaceId === snapshot.workspaceId)
        ? previous.workspaces.map(item => (item.workspaceId === snapshot.workspaceId ? snapshot : item))
        : [snapshot, ...previous.workspaces],
      selected: previous.selected?.workspaceId === snapshot.workspaceId ? snapshot : previous.selected,
    }))
  }, [])

  const loadWorkspaces = useCallback(async (): Promise<void> => {
    if (projectId === undefined) return
    const generationValue = ++workspacesGeneration.current
    const result = unwrap(await remote.cloudWorkspaces.workspaces(projectId))
    if (generationValue !== workspacesGeneration.current) return
    const items = READY(result)
    if (items === undefined) {
      applyResult(result)
      return
    }
    setState((previous) => {
      const refreshed = previous.selected === undefined
        ? undefined
        : items.find(item => item.workspaceId === previous.selected?.workspaceId)
      // A list snapshot older than what the view already applied must never
      // move the selected workspace backwards.
      const stale = refreshed !== undefined && previous.selected !== undefined && refreshed.revision < previous.selected.revision
      // A workspace this snapshot no longer authorizes is not a selection any
      // more: keeping it would let the next action address a resource the
      // current authorization answer does not contain.
      if (refreshed === undefined) return { ...previous, workspaces: items, selected: undefined }
      if (stale) return { ...previous, workspaces: items }
      return { ...previous, workspaces: items, selected: refreshed }
    })
    setSelectedId((previous) => {
      const current = items.find(item => item.workspaceId === previous)
      // Never fall back to a stale id: with no match the view starts over from
      // the new list's first workspace, or from no selection at all.
      return current?.workspaceId ?? items[0]?.workspaceId
    })
  }, [applyResult, projectId, remote])

  const loadWorkspaceContext = useCallback(async (workspaceId: string): Promise<void> => {
    const generationValue = ++generation.current
    const current = (): boolean => generationValue === generation.current
    // The directory is not read here: `loadDirectory` owns it, and two writers
    // behind one generation guard would discard each other's results.
    const envelopes = await Promise.all([
      remote.cloudWorkspaces.workspace(workspaceId),
      remote.cloudWorkspaces.workspaceChanges(workspaceId),
      remote.cloudWorkspaces.workspaceRuns(workspaceId),
      projectId === undefined ? Promise.resolve(undefined) : remote.cloudWorkspaces.agentProfiles(projectId),
    ])
    const snapshot = unwrap(envelopes[0])
    const changes = unwrap(envelopes[1])
    const runs = unwrap(envelopes[2])
    const profiles = envelopes[3] === undefined ? undefined : unwrap(envelopes[3])
    if (!current()) return
    const snapshotValue = snapshot.status === 'ready' ? snapshot.value : undefined
    setState((previous) => {
      // Responses can interleave across refresh triggers; an older revision of
      // the same workspace is dropped instead of regressing the UI.
      const regression = snapshotValue !== undefined && previous.selected !== undefined
        && previous.selected.workspaceId === snapshotValue.workspaceId
        && snapshotValue.revision < previous.selected.revision
      if (regression) return previous
      return {
        ...previous,
        selected: snapshotValue,
        profiles: profiles === undefined ? [] : READY(profiles) ?? [],
        changes: READY(changes),
        runs: READY(runs) ?? [],
      }
    })
    if (snapshot.status !== 'ready') applyResult(snapshot)
    // A failed companion read is a result to show, never an empty pane: each
    // non-ready envelope reports its own status, and authorization codes sign
    // the account out through the shared path.
    for (const envelope of [profiles, changes, runs]) {
      if (envelope !== undefined && envelope.status !== 'ready') {
        if (envelope.status === 'failed' && envelope.code === 'REVISION_CONFLICT') {
          setConflictMessage(envelope.message)
          continue
        }
        applyResult(envelope)
      }
    }
    const openPath = openPathRef.current
    if (openPath !== undefined && snapshotValue !== undefined) {
      const preview = unwrap(await remote.cloudWorkspaces.workspacePreview(workspaceId, openPath))
      if (current()) setState(previous => ({ ...previous, preview: READY(preview) }))
    }
  }, [applyResult, projectId, remote])

  // Load published profiles once per project so the create form and the override
  // selector can list server-authorized options without a workspace.
  const loadProfiles = useCallback(async (): Promise<void> => {
    if (projectId === undefined) return
    const generationValue = ++profilesGeneration.current
    const result = unwrap(await remote.cloudWorkspaces.agentProfiles(projectId))
    if (generationValue !== profilesGeneration.current) return
    const items = READY(result)
    if (items === undefined) {
      // An authorization or transport failure is not an empty profile list.
      applyResult(result)
      return
    }
    setFixtureOnly(readyProvenance(result))
    setState(previous => ({ ...previous, profiles: items }))
  }, [applyResult, projectId, remote])

  /** Reads the repositories the service authorizes for the active project. */
  const loadCodeSources = useCallback(async (): Promise<void> => {
    if (projectId === undefined) return
    const generationValue = ++repositoriesGeneration.current
    setRepositoriesState('loading')
    const result = unwrap(await remote.cloudWorkspaces.codeSources(projectId))
    if (generationValue !== repositoriesGeneration.current) return
    const items = READY(result)
    if (items === undefined) {
      setRepositories([])
      setRepositoriesState('failed')
      applyResult(result)
      return
    }
    setRepositories(items)
    setRepositoriesState(items.length === 0 ? 'empty' : 'ready')
    setDraftRepositoryId(previous => (previous !== '' && items.some(item => item.repositoryId === previous)
      ? previous
      : items[0]?.repositoryId ?? ''))
  }, [applyResult, projectId, remote])

  /**
   * The account/project pair every retained resource belongs to.
   *
   * A change in either half is a new context: the previous account's or
   * project's resources are not this one's to show or act on.
   */
  const contextKey = `${accountId ?? 'unidentified'}:${projectId ?? ''}`

  // A context switch invalidates every resource the previous one authorized.
  // Nothing derived from the old grant survives: keeping any of it would let the
  // workbench act on resources the current authorization answer has not covered.
  useEffect(() => {
    generation.current += 1
    workspacesGeneration.current += 1
    profilesGeneration.current += 1
    previewGeneration.current += 1
    grantGeneration.current += 1
    repositoriesGeneration.current += 1
    directoryGeneration.current += 1
    openPathRef.current = undefined
    treePathRef.current = ''
    streamEventWatermark.current = ''
    streamStateKey.current = ''
    setState({ workspaces: [], profiles: [], runs: [] })
    setSelectedId(undefined)
    setOpenPath(undefined)
    setTreePath('')
    setWebAppGrant(undefined)
    setOverrideProfileId('')
    setRunDetail(undefined)
    setLoadError(undefined)
    setConflictMessage(undefined)
    setPendingConfirm(undefined)
    setDraftBranch('')
    setDraftRepositoryId('')
    setRepositories([])
    setRepositoriesState('loading')
    setSignedOut(false)
    setFixtureOnly(false)
    setFeedback(undefined)
    setWizardStep(1)
  }, [contextKey])

  useEffect(() => {
    if (projectId === undefined) return
    void loadWorkspaces()
    void loadProfiles()
    void loadCodeSources()
  }, [loadCodeSources, loadProfiles, loadWorkspaces, projectId])

  // The chosen repository always has a branch: a branch the repository does not
  // publish is replaced by the service's own default rather than submitted.
  useEffect(() => {
    const source = codeSourceOf(repositories, draftRepositoryId)
    if (source === undefined) return
    setDraftBranch(current => (source.branches.includes(current) ? current : source.defaultBranch))
  }, [draftRepositoryId, repositories])


  // Last selected workspace/file/pane persists per account and project and
  // clears on sign-out; the account is part of the key so a different account
  // never reads the previous one's retained selection.
  const uiStateKey = projectId === undefined ? undefined : `cloud-workspace-ui:${accountId ?? 'unidentified'}:${projectId}`
  useEffect(() => {
    if (uiStateKey === undefined) return
    try {
      const raw = window.localStorage.getItem(uiStateKey)
      const saved = raw === null ? undefined : JSON.parse(raw) as { selectedId?: string }
      if (saved?.selectedId !== undefined) setSelectedId(saved.selectedId)
    } catch {
      // Ignore unreadable UI state; defaults apply.
    }
  }, [uiStateKey])
  useEffect(() => {
    if (uiStateKey === undefined || signedOut) return
    window.localStorage.setItem(uiStateKey, JSON.stringify({ selectedId, openPath, pane }))
  }, [openPath, pane, selectedId, signedOut, uiStateKey])
  useEffect(() => {
    if (signedOut && uiStateKey !== undefined) window.localStorage.removeItem(uiStateKey)
  }, [signedOut, uiStateKey])

  /**
   * A preview URL grant is an entry point, so it lives only as long as its own
   * deadline: the moment it expires the link is removed rather than left for
   * someone to click. Sign-out and a context switch clear it through the effects
   * above.
   */
  useEffect(() => {
    if (webAppGrant === undefined) return
    const deadline = Date.parse(webAppGrant.expiresAt)
    if (!Number.isFinite(deadline)) {
      setWebAppGrant(undefined)
      return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      setWebAppGrant(undefined)
      setWebAppExpired(true)
      return
    }
    // setTimeout saturates above the signed 32-bit range; clamp so a long-lived
    // grant gets a timer that actually fires.
    const timer = window.setTimeout(() => { setWebAppGrant(undefined); setWebAppExpired(true) }, Math.min(remaining, 2 ** 31 - 1))
    return () => { window.clearTimeout(timer) }
  }, [webAppGrant])

  useEffect(() => {
    if (signedOut) setWebAppGrant(undefined)
  }, [signedOut])

  useEffect(() => {
    // Switching workspaces drops every resource the previous one authorized
    // before the next read starts, so a late response for the old workspace can
    // neither render nor be acted on in the new context.
    generation.current += 1
    directoryGeneration.current += 1
    previewGeneration.current += 1
    grantGeneration.current += 1
    openPathRef.current = undefined
    treePathRef.current = ''
    streamEventWatermark.current = ''
    setState(previous => ({
      ...previous,
      selected: undefined,
      directory: undefined,
      changes: undefined,
      preview: undefined,
      runs: [],
    }))
    setOpenPath(undefined)
    setTreePath('')
    setWebAppGrant(undefined)
    setRunDetail(undefined)
    setConflictMessage(undefined)
    if (selectedId === undefined) return
    void loadWorkspaceContext(selectedId)
  }, [loadWorkspaceContext, selectedId])

  const loadDirectory = useCallback(async (workspaceId: string, path: string): Promise<void> => {
    // Its own generation: the directory is written only by this reader, so a
    // read issued before a context change cannot land in the context that
    // replaced it.
    const generationValue = ++directoryGeneration.current
    const result = unwrap(await remote.cloudWorkspaces.workspaceFiles(workspaceId, path))
    if (generationValue !== directoryGeneration.current) return
    const directory = READY(result)
    if (directory === undefined) {
      // A rejected directory read is an error to show, not an empty folder.
      applyResult(result)
      return
    }
    setState(previous => ({ ...previous, directory }))
  }, [applyResult, remote])

  useEffect(() => {
    if (selectedId === undefined) return
    void loadDirectory(selectedId, treePath)
  }, [loadDirectory, selectedId, treePath])

  // Keep the refs the refresh callbacks read so the stream effect below never
  // re-subscribes just because the open file or tree path changed.
  useEffect(() => {
    openPathRef.current = openPath
  }, [openPath])
  useEffect(() => {
    treePathRef.current = treePath
  }, [treePath])

  // Exactly one scoped SSE subscription per project/workspace. The Host owns the
  // socket; this view polls its state and re-reads the authoritative snapshot
  // whenever the watermark advances. The subscription is released on unmount,
  // sign-out and every project/workspace switch.
  useEffect(() => {
    if (projectId === undefined || signedOut || selectedId === undefined) return
    const workspaceId = selectedId
    const subscription = { active: true }
    /** Handle of the Host-side subscription this effect owns; `undefined` until start resolves. */
    let subscriptionId: string | undefined
    streamEventWatermark.current = ''
    streamStateKey.current = ''
    const observe = (next: WorkspaceStreamState): void => {
      if (!subscription.active) return
      const key = next.status === 'live'
        ? `live:${next.lastEventId}`
        : next.status === 'reconnecting'
          ? `reconnecting:${next.attempt}:${next.lastEventId}`
          : next.status === 'resync'
            ? `resync:${next.lastEventId}`
            : next.status === 'stale'
              ? `stale:${next.code}:${next.lastEventId}`
              : next.status
      if (key !== streamStateKey.current) {
        streamStateKey.current = key
        setStreamStatus(next)
      }
      if (next.status === 'resync') {
        // The Host drops its watermark and replays from scratch after a resync,
        // so the view re-reads the snapshot instead of trusting the watermark.
        streamEventWatermark.current = ''
        void loadWorkspaces()
        void loadWorkspaceContext(workspaceId)
        return
      }
      if (next.status === 'stale') {
        // The Host could not re-read the authoritative snapshot, so its replay
        // window may hold holes. Say so and reconcile from a fresh read rather
        // than letting the pane keep presenting an unverified tree as live.
        setLoadError({ code: next.code, message: next.message })
        void loadWorkspaces()
        void loadWorkspaceContext(workspaceId)
        return
      }
      if (next.status !== 'live' && next.status !== 'reconnecting') return
      void consumeEvents()
    }
    // The Host exposes the concrete events it consumed, so the view reacts to the
    // resource each event names instead of inferring progress from the stream state.
    const consumeEvents = async (): Promise<void> => {
      if (subscriptionId === undefined) return
      const outcome = eventBatchOutcome(
        await remote.cloudWorkspaces.streamEventsAfter(subscriptionId, streamEventWatermark.current),
      )
      if (!subscription.active) return
      if (!outcome.ok) {
        // No event channel: reconcile both snapshots from the Host instead of
        // fabricating event state locally.
        void loadWorkspaces()
        void loadWorkspaceContext(workspaceId)
        return
      }
      const batch = outcome.batch
      if (batch.truncated) {
        // The watermark left the retained window, so a full snapshot is authoritative.
        streamEventWatermark.current = ''
        void loadWorkspaces()
        void loadWorkspaceContext(workspaceId)
        return
      }
      if (batch.events.length === 0) return
      const kinds = new Set(batch.events.map(event => event.resourceType))
      // `eventId` is opaque: it is a cursor, never an ordering key, so the view
      // stores the last delivered one rather than comparing ids.
      streamEventWatermark.current = batch.events[batch.events.length - 1]?.eventId ?? streamEventWatermark.current
      if (kinds.has('workspace')) void loadWorkspaces()
      if (kinds.has('workspace') || kinds.has('changes') || kinds.has('run') || kinds.has('file')) {
        void loadWorkspaceContext(workspaceId)
      }
    }
    const poll = async (): Promise<void> => {
      if (subscriptionId === undefined) return
      const outcome = streamOutcome(await remote.cloudWorkspaces.streamState(subscriptionId))
      if (!subscription.active) return
      if (outcome.status === 'failed') reportFailure(outcome)
      else observe(outcome)
    }
    void (async (): Promise<void> => {
      const envelope = await remote.cloudWorkspaces.startStream({ projectId, workspaceId })
      if (!subscription.active) {
        // Unmounted before the handle arrived: release it now so the Host is not
        // left holding a socket nobody will ever stop.
        if (envelope.ok) void remote.cloudWorkspaces.stopStream(envelope.value.subscriptionId)
        return
      }
      if (!envelope.ok) {
        reportFailure({ status: 'failed', code: envelope.error.code, message: envelope.error.message })
        return
      }
      subscriptionId = envelope.value.subscriptionId
      observe(envelope.value.state)
    })()
    const timer = window.setInterval(() => {
      void poll()
    }, STREAM_POLL_INTERVAL_MS)
    return () => {
      subscription.active = false
      window.clearInterval(timer)
      streamEventWatermark.current = ''
      streamStateKey.current = ''
      // Releasing by handle touches only this view's subscription: a second
      // workbench holding its own handle keeps streaming.
      if (subscriptionId !== undefined) void remote.cloudWorkspaces.stopStream(subscriptionId)
    }
  }, [loadWorkspaceContext, loadWorkspaces, projectId, remote, reportFailure, selectedId, signedOut])

  // Four-step create wizard: source -> branch -> profile -> confirm. One
  // primary submit per step; step titles stay visible.
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4>(1)
  // The wizard offers only versions the server reports as ready.
  const readyProfiles = state.profiles.filter(profile => profile.readiness === 'ready')
  const createWorkspace = useCallback(async (): Promise<void> => {
    if (projectId === undefined) return
    if (draftRepositoryId === '') return
    // The default profile is the service's own default binding when it declares
    // one; otherwise the caller must pick explicitly. The form never invents a
    // repository or a profile version.
    const profileId = overrideProfileId !== ''
      ? overrideProfileId
      : state.profiles.find(profile => profile.default)?.agentProfileVersionId
    if (profileId === undefined) return
    const result = unwrap(await remote.cloudWorkspaces.createWorkspace({
      projectId,
      repositoryId: draftRepositoryId,
      branch: draftBranch,
      agentProfileVersionId: profileId,
      displayName: draftBranch,
    }))
    const created = READY(result)
    if (created === undefined) {
      applyResult(result)
      return
    }
    setState(previous => ({ ...previous, workspaces: [created, ...previous.workspaces] }))
    setSelectedId(created.workspaceId)
    // 创建成功回到第 1 步：下一次创建从代码源重新开始。
    setWizardStep(1)
  }, [applyResult, draftBranch, draftRepositoryId, overrideProfileId, projectId, remote, state.profiles])

  const selected = state.selected ?? state.workspaces.find(item => item.workspaceId === selectedId)
  const activeProfile = state.profiles.find(item =>
    selected !== undefined && item.agentProfileVersionId === selected.defaultAgentProfileVersionId,
  )
    ?? state.profiles.find(item => item.default)
    ?? state.profiles[0]

  const openFile = useCallback(async (path: string, kind: string): Promise<void> => {
    if (selectedId === undefined || kind !== 'file') return
    setOpenPath(path)
    setPane('preview')
    const workspaceId = selectedId
    const generationValue = ++previewGeneration.current
    const result = unwrap(await remote.cloudWorkspaces.workspacePreview(workspaceId, path))
    // The preview is written only for the request that is still current and
    // still belongs to the workspace on screen.
    // The generation is bumped by every project and workspace switch, so a
    // response that survived it belongs to the context on screen.
    if (generationValue !== previewGeneration.current) return
    const preview = READY(result)
    if (preview === undefined) {
      setState(previous => ({ ...previous, preview: undefined }))
      applyResult(result)
      return
    }
    setState(previous => ({ ...previous, preview }))
  }, [applyResult, remote, selectedId])

  const issueWebApp = useCallback(async (): Promise<void> => {
    if (selectedId === undefined) return
    const workspaceId = selectedId
    const generationValue = ++grantGeneration.current
    const result = unwrap(await remote.cloudWorkspaces.workspacePreviewUrl(workspaceId, 3000))
    // A grant that arrives after the context moved is discarded rather than
    // installed as an entry point into a workspace that is no longer current.
    if (generationValue !== grantGeneration.current) return
    const grant = READY(result)
    if (grant === undefined) {
      applyResult(result)
      return
    }
    setWebAppGrant(grant)
    setWebAppExpired(false)
  }, [applyResult, remote, selectedId])

  const startRun = useCallback(async (writeMode: 'read_only' | 'write'): Promise<void> => {
    if (selected === undefined || sessionId === undefined) return
    setConflictMessage(undefined)
    const result = unwrap(await remote.cloudWorkspaces.createRun({
      workspaceId: selected.workspaceId,
      sessionId,
      writeMode,
      expectedWorkspaceRevision: selected.revision,
      ...(overrideProfileId === '' ? {} : { agentProfileVersionId: overrideProfileId }),
    }))
    const run = READY(result)
    if (run === undefined) {
      reportFailure(result)
      return
    }
    setState(previous => ({ ...previous, runs: [run, ...previous.runs] }))
  }, [overrideProfileId, remote, reportFailure, selected, sessionId])

  const cancelRun = useCallback(async (runId: string): Promise<void> => {
    const result = unwrap(await remote.cloudWorkspaces.cancelRun(runId))
    const run = READY(result)
    if (run === undefined) {
      applyResult(result)
      return
    }
    setState(previous => ({
      ...previous,
      runs: previous.runs.map(item => (item.runId === run.runId ? run : item)),
    }))
  }, [applyResult, remote])

  const showTimeline = useCallback(async (runId: string): Promise<void> => {
    const result = unwrap(await remote.cloudWorkspaces.run(runId))
    const run = READY(result)
    if (run === undefined) {
      applyResult(result)
      return
    }
    setRunDetail(run)
  }, [applyResult, remote])

  const refresh = useCallback((): void => {
    setConflictMessage(undefined)
    void loadWorkspaces()
    if (selectedId !== undefined) void loadWorkspaceContext(selectedId)
  }, [loadWorkspaceContext, loadWorkspaces, selectedId])

  /** Runs one lifecycle operation guarded by the revision the UI last observed. */
  const runLifecycle = async (action: LifecycleAction): Promise<void> => {
    if (selected === undefined) return
    setFeedback(undefined)
    const envelope = unwrap(await remote.cloudWorkspaces.workspaceAction(selected.workspaceId, action, selected.revision))
    const updated = READY(envelope)
    if (updated === undefined) {
      reportFailure(envelope)
      return
    }
    const provenance = readyProvenance(envelope)
    setFixtureOnly(provenance)
    applySnapshot(updated)
    setFeedback(successFeedback(
      `workspace.${action}`,
      `服务端状态 ${STATUS_LABEL[updated.status] ?? updated.status}`,
      provenance,
    ))
    void loadWorkspaces()
  }

  /** Deletes one workspace under its deletion policy, then drops the selection. */
  const removeWorkspace = async (): Promise<void> => {
    if (selected === undefined) return
    const target = selected
    setFeedback(undefined)
    const envelope = unwrap(await remote.cloudWorkspaces.deleteWorkspace(target.workspaceId, target.revision))
    const removed = READY(envelope)
    if (removed === undefined) {
      reportFailure(envelope)
      return
    }
    const provenance = readyProvenance(envelope)
    setFixtureOnly(provenance)
    applySnapshot(removed)
    setFeedback(successFeedback('workspace.delete', `已请求删除 ${target.workspaceId}`, provenance))
    setSelectedId(undefined)
    setOpenPath(undefined)
    setPane('preview')
    await loadWorkspaces()
  }

  /** Discards the change set at the revision the UI observed. */
  const discardChanges = async (): Promise<void> => {
    if (selected === undefined) return
    const workspaceId = selected.workspaceId
    setFeedback(undefined)
    const envelope = unwrap(await remote.cloudWorkspaces.discardChanges(workspaceId, selected.revision))
    const result = READY(envelope)
    if (result === undefined) {
      reportFailure(envelope)
      return
    }
    const provenance = readyProvenance(envelope)
    setFixtureOnly(provenance)
    applySnapshot({ ...selected, revision: result.revision })
    setFeedback(successFeedback('changes.discard', `变更已丢弃，revision ${result.revision}`, provenance))
    await loadWorkspaceContext(workspaceId)
  }

  /** Commits the change set with a user message at the server revision. */
  const commitChanges = async (): Promise<void> => {
    if (selected === undefined) return
    const message = commitMessage.trim()
    if (message === '') return
    const workspaceId = selected.workspaceId
    setFeedback(undefined)
    const envelope = unwrap(await remote.cloudWorkspaces.gitCommit(workspaceId, message, selected.revision))
    const result = READY(envelope)
    if (result === undefined) {
      reportFailure(envelope)
      return
    }
    const provenance = readyProvenance(envelope)
    setFixtureOnly(provenance)
    applySnapshot({ ...selected, revision: result.revision })
    setCommitMessage('')
    setFeedback(successFeedback('git.commit', `提交成功，revision ${result.revision}`, provenance))
    await loadWorkspaceContext(workspaceId)
  }

  /** Requests a pull request for the change set at the server revision. */
  const openPullRequest = async (): Promise<void> => {
    if (selected === undefined) return
    const title = pullRequestTitle.trim()
    if (title === '') return
    const workspaceId = selected.workspaceId
    setFeedback(undefined)
    const envelope = unwrap(await remote.cloudWorkspaces.createPullRequest(workspaceId, title, selected.revision))
    const result = READY(envelope)
    if (result === undefined) {
      reportFailure(envelope)
      return
    }
    const provenance = readyProvenance(envelope)
    setFixtureOnly(provenance)
    setPullRequestTitle('')
    setFeedback(successFeedback('git.pull_request', `Pull Request ${result.pullRequestId} 已创建`, provenance))
    await loadWorkspaceContext(workspaceId)
  }

  /** Arms confirmation for a destructive operation; nothing is sent until confirmed. */
  const requestConfirmation = (action: PendingConfirmation['action']): void => {
    if (selected === undefined) return
    setFeedback(undefined)
    setPendingConfirm({ action, workspaceId: selected.workspaceId })
  }

  /** Sends the confirmed destructive operation exactly once. */
  const confirmPending = (): void => {
    const pending = pendingConfirm
    setPendingConfirm(undefined)
    if (pending === undefined) return
    if (pending.action === 'discard') void discardChanges()
    else if (pending.action === 'delete') void removeWorkspace()
    else void runLifecycle(pending.action)
  }

  const drawerToggle = (target: 'left' | 'right'): void => {
    setDrawer(previous => (previous === target ? 'none' : target))
  }

  // Panel drag: direct manipulation through pointer capture — there is no
  // animated transition to interrupt, so the drag is interruptible by nature
  // and a release snaps without movement effects (spec §6/§7). Widths persist
  // so returning to the view restores the previous layout.
  const [panelWidths, setPanelWidths] = useState<{ readonly left: number; readonly right: number }>(() => readPanelWidths())
  const [draggingSide, setDraggingSide] = useState<'left' | 'right' | undefined>()
  const dragRef = useRef<{ readonly side: 'left' | 'right'; readonly startX: number; readonly startWidth: number } | null>(null)
  useEffect(() => {
    savePanelWidths(panelWidths)
  }, [panelWidths])
  const onDividerPointerDown = (side: 'left' | 'right') => (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === 'left' ? panelWidths.left : panelWidths.right,
    }
    setDraggingSide(side)
  }
  const onDividerPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null) return
    const delta = event.clientX - drag.startX
    const next = clampPanelWidth(drag.startWidth + (drag.side === 'left' ? delta : -delta))
    setPanelWidths(previous => (drag.side === 'left' ? { ...previous, left: next } : { ...previous, right: next }))
  }
  const endDividerDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
    setDraggingSide(undefined)
  }
  const onDividerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
    if (step === 0) return
    event.preventDefault()
    setPanelWidths(previous => ({ ...previous, left: clampPanelWidth(previous.left + step) }))
  }

  const projectPicker = useMemo(() => (
    <select
      aria-label="cloud-workspace-project"
      className={css.projectSelect}
      value={projectId ?? ''}
      onChange={event => onProjectSelect?.(event.target.value)}
    >
      <option value="" disabled>选择项目</option>
      {projects.map(project => (
        <option key={project.projectId} value={project.projectId}>{project.name}</option>
      ))}
    </select>
  ), [onProjectSelect, projectId, projects])

  if (projectId === undefined) {
    return (
      <section className={css.page} data-view="cloud-workspaces">
        <h2>云工作空间</h2>
        <p className={css.hint}>选择项目后展示服务端授权的 Workspace。</p>
        {projectPicker}
      </section>
    )
  }
  if (signedOut) {
    return (
      <section className={css.page} data-view="cloud-workspaces">
        <h2>云工作空间</h2>
        <p className={css.hint}>账号已登出，请重新登录后再进入云工作空间。</p>
        {feedback !== undefined && (
          <p className={css.feedbackBanner} data-tone={feedback.tone} data-code={feedback.code} role="alert">
            {feedback.code}：{feedback.message}
          </p>
        )}
        <button type="button" className={css.actionButton} onClick={() => onAuthorizationFailure?.()}>登录</button>
      </section>
    )
  }

  return (
    <section className={css.page} data-view="cloud-workspaces">
      <header className={css.header}>
        <h2><IconFolderOpenOutline16 /> 云工作空间</h2>
        {projectPicker}
        <span className={css.streamBadge} data-stream-status={streamStatus.status}>
          {streamStatus.status === 'live' && <span>实时已连接</span>}
          {streamStatus.status === 'reconnecting' && <span>已断线，重连中</span>}
          {streamStatus.status === 'resync' && <span>事件重同步中</span>}
          {streamStatus.status === 'connecting' && <span>连接中</span>}
          {streamStatus.status === 'stale' && <span>快照不可信，重新同步中</span>}
          {(streamStatus.status === 'idle' || streamStatus.status === 'stopped') && <span>未连接</span>}
        </span>
        {fixtureOnly && (
          <span className={css.provenanceBadge} data-provenance={FIXTURE_ONLY_LABEL}>{FIXTURE_ONLY_LABEL}</span>
        )}
        <button type="button" aria-label="refresh-workspaces" className={css.iconButton} onClick={refresh}>
          <IconRefreshOutline16 />
        </button>
      </header>
      {loadError !== undefined && (
        <p className={css.errorBanner} role="alert">
          {loadError.code}: {loadError.message}
          <button type="button" onClick={refresh}>重试</button>
        </p>
      )}
      <div
        className={css.columns}
        data-drawer={drawer}
        {...(draggingSide === undefined ? {} : { 'data-dragging': '' })}
        style={{ '--dsh-tree-w': `${panelWidths.left}px`, '--dsh-panel-w': `${panelWidths.right}px` } as React.CSSProperties}
      >
        <aside className={css.leftPane} aria-label="workspace-tree">
          <div className={css.createForm}>
            <p className={css.paneTitle}>新建 Workspace</p>
            {repositoriesState === 'loading' && <p className={css.hint}>正在读取可用代码源…</p>}
            {repositoriesState === 'empty' && (
              <p className={css.hint} data-state="no-code-source">
                该项目没有可用的代码源，无法创建 Workspace。请先在服务端为项目授权仓库。
              </p>
            )}
            {repositoriesState === 'failed' && (
              <p className={css.hint} data-state="code-source-failed">代码源读取失败，请重试。</p>
            )}
            <ol className={css.wizardSteps} aria-label="创建向导步骤">
              {(['代码源', '分支', 'Agent 配置', '确认'] as const).map((title, index) => (
                <li
                  key={title}
                  aria-current={wizardStep === index + 1 ? 'step' : undefined}
                  className={wizardStep === index + 1 ? css.wizardStepActive : css.wizardStep}
                >
                  {index + 1}. {title}
                </li>
              ))}
            </ol>
            {repositoriesState === 'ready' && wizardStep === 1 && (
              <>
                <label className={css.hint}>
                  代码源
                  <select
                    aria-label="创建代码源"
                    className={css.projectSelect}
                    value={draftRepositoryId}
                    onChange={(event) => {
                      const next = event.target.value
                      setDraftRepositoryId(next)
                      // The branch list belongs to the repository, so a new
                      // repository clears the branch rather than carrying a
                      // branch the new repository may not have.
                      const source = codeSourceOf(repositories, next)
                      setDraftBranch(source?.defaultBranch ?? '')
                    }}
                  >
                    {repositories.map(source => (
                      <option key={source.repositoryId} value={source.repositoryId}>
                        {source.name}（{source.provider} · {source.repositoryId}）
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={css.actionButton}
                  disabled={draftRepositoryId === ''}
                  onClick={() => { setWizardStep(2) }}
                >
                  下一步：选择分支
                </button>
              </>
            )}
            {repositoriesState === 'ready' && wizardStep === 2 && (
              <>
                <label className={css.hint}>
                  创建分支
                  <select
                    aria-label="创建分支"
                    className={css.projectSelect}
                    value={draftBranch}
                    onChange={(event) => { setDraftBranch(event.target.value) }}
                  >
                    <option value="" disabled>选择分支</option>
                    {(codeSourceOf(repositories, draftRepositoryId)?.branches ?? []).map(branch => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className={css.secondaryButton} onClick={() => { setWizardStep(1) }}>上一步</button>
                <button
                  type="button"
                  className={css.actionButton}
                  disabled={draftBranch === ''}
                  onClick={() => { setWizardStep(3) }}
                >
                  下一步：选择 Agent 配置
                </button>
              </>
            )}
            {repositoriesState === 'ready' && wizardStep === 3 && (
              <>
                <label className={css.hint}>
                  Agent 配置版本
                  <select
                    aria-label="创建 Agent 配置"
                    className={css.projectSelect}
                    value={overrideProfileId}
                    onChange={(event) => { setOverrideProfileId(event.target.value) }}
                  >
                    <option value="">
                      {state.profiles.some(profile => profile.default) ? '使用服务默认绑定' : '请选择（服务未声明默认）'}
                    </option>
                    <ProfileOptions profiles={readyProfiles} />
                  </select>
                </label>
                <button type="button" className={css.secondaryButton} onClick={() => { setWizardStep(2) }}>上一步</button>
                <button
                  type="button"
                  className={css.actionButton}
                  disabled={state.profiles.length === 0 || (overrideProfileId === '' && !state.profiles.some(profile => profile.default))}
                  onClick={() => { setWizardStep(4) }}
                >
                  下一步：确认创建
                </button>
              </>
            )}
            {repositoriesState === 'ready' && wizardStep === 4 && (() => {
              const source = codeSourceOf(repositories, draftRepositoryId)
              const profileId = overrideProfileId !== ''
                ? overrideProfileId
                : state.profiles.find(profile => profile.default)?.agentProfileVersionId
              const profile = state.profiles.find(item => item.agentProfileVersionId === profileId)
              return (
                <>
                  <dl className={css.wizardConfirm}>
                    <div><dt>项目</dt><dd>{projectId}</dd></div>
                    <div><dt>仓库</dt><dd>{source?.name ?? draftRepositoryId}</dd></div>
                    <div><dt>分支</dt><dd>{draftBranch}</dd></div>
                    <div><dt>Agent Profile</dt><dd>{profile === undefined ? '服务默认绑定' : profile.name + '（' + profile.agentProfileVersionId + '）'}</dd></div>
                    <div><dt>写入模式</dt><dd>{profile?.executionPolicy.write_mode ?? '—'}</dd></div>
                    <div><dt>数据来源</dt><dd>{fixtureOnly ? 'fixture-only' : '服务端'}</dd></div>
                  </dl>
                  <button type="button" className={css.secondaryButton} onClick={() => { setWizardStep(3) }}>上一步</button>
                  <button
                    type="button"
                    className={css.actionButton}
                    disabled={
                      draftRepositoryId === ''
                      || draftBranch === ''
                      || state.profiles.length === 0
                      || (overrideProfileId === '' && !state.profiles.some(profile => profile.default))
                    }
                    onClick={() => {
                      void createWorkspace()
                    }}
                  >
                    创建 Workspace
                  </button>
                </>
              )
            })()}
          </div>
          <ul className={css.workspaceList}>
            {state.workspaces.map(item => (
              <li key={item.workspaceId}>
                <button
                  type="button"
                  className={item.workspaceId === selectedId ? css.workspaceActive : css.workspaceItem}
                  onClick={() => {
                    setSelectedId(item.workspaceId)
                    setOpenPath(undefined)
                  }}
                >
                  <span className={css.workspaceName}>{item.workspaceId}</span>
                  <span className={css.workspaceMeta}>
                    {item.branch} · {STATUS_LABEL[item.status] ?? item.status} · rev {item.revision}
                  </span>
                  {item.lastError !== null && <span className={css.workspaceError}>{item.lastError}</span>}
                </button>
              </li>
            ))}
          </ul>
          {selected !== undefined && state.directory !== undefined && (
            <div className={css.fileTree}>
              <p className={css.paneTitle}>工程目录 {selected.branch}</p>
              {treePath !== '' && (
                <button
                  type="button"
                  className={css.fileItem}
                  onClick={() => {
                    const parent = treePath.includes('/') ? treePath.slice(0, treePath.lastIndexOf('/')) : ''
                    setTreePath(parent)
                  }}
                >
                  返回上级
                </button>
              )}
              <ul>
                {state.directory.items.map(item => (
                  <li key={item.path}>
                    <button
                      type="button"
                      className={css.fileItem}
                      data-kind={item.kind}
                      disabled={selected.status !== 'ready'}
                      title={selected.status !== 'ready' ? '工作空间未就绪' : undefined}
                      onClick={() => {
                        if (item.kind === 'directory') {
                          setTreePath(item.path)
                          return
                        }
                        void openFile(item.path, item.kind)
                      }}
                    >
                      {item.path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整工程树宽度"
          tabIndex={0}
          data-panel-divider="left"
          aria-valuenow={panelWidths.left}
          aria-valuemin={200}
          aria-valuemax={480}
          className={css.panelDivider}
          onPointerDown={onDividerPointerDown('left')}
          onPointerMove={onDividerPointerMove}
          onPointerUp={endDividerDrag}
          onPointerCancel={endDividerDrag}
          onKeyDown={onDividerKeyDown}
        />
        <section className={css.centerPane} aria-label="workspace-session">
          <section className={css.nativeSessionPane} aria-label="原生会话">
            <div className={css.nativeSessionBar}>
              <label className={css.hint}>
                原生会话
                <select
                  aria-label="切换原生会话"
                  className={css.projectSelect}
                  value={sessionId ?? ''}
                  disabled={(nativeSessions?.ids.length ?? 0) === 0}
                  onChange={(event) => { openSession?.(event.target.value) }}
                >
                  {sessionId === undefined && <option value="">无活跃 Session</option>}
                  {(nativeSessions?.ids ?? []).map(id => (
                    <option key={id} value={id}>{nativeSessions?.titleOf(id) ?? id}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={css.actionButton}
                disabled={startSession === undefined}
                onClick={() => { startSession?.() }}
              >
                新建会话
              </button>
            </div>
            <p className={css.hint}>工作台已让出中栏：原生会话在左侧应用栏中显示与输入，此处的 Session/Run 关联跟随当前原生会话。</p>
          </section>
          {selected === undefined ? (
            <p className={css.hint}>选择一个 Workspace 作为当前 Session 的运行上下文。</p>
          ) : (
            <>
              <p className={css.paneTitle}>当前 Session</p>
              <dl className={css.sessionFacts}>
                <dt>Session</dt>
                <dd>{sessionId ?? '无活跃 Session'}</dd>
                <dt>Workspace</dt>
                <dd>{selected.workspaceId}</dd>
                <dt>分支 / revision</dt>
                <dd>{selected.branch} · rev {selected.revision}</dd>
                <dt>Agent 配置</dt>
                <dd>
                  {activeProfile === undefined ? '未选择' : `${activeProfile.name} (${activeProfile.agentProfileVersionId})`}
                  <select
                    aria-label="Agent 配置覆盖"
                    className={css.projectSelect}
                    value={overrideProfileId}
                    onChange={(event) => { setOverrideProfileId(event.target.value) }}
                  >
                    <option value="">继承 Workspace 默认</option>
                    <ProfileOptions profiles={state.profiles} />
                  </select>
                </dd>
                <dt>状态</dt>
                <dd>{STATUS_LABEL[selected.status] ?? selected.status}{selected.lastError === null ? '' : ` · ${selected.lastError}`}</dd>
              </dl>
              {selected.status !== 'ready' && (
                <p className={css.hint} data-state="not-ready">当前状态不可执行 Run 或写入，仅可查看。</p>
              )}
              {selected.status === 'archived' && (
                <p className={css.hint} data-state="archived">已归档，不再接受写入或生命周期操作。</p>
              )}
              <div className={css.lifecycleActions} role="group" aria-label="工作空间生命周期">
                {LIFECYCLE_ORDER.map(action => (
                  <button
                    key={action}
                    type="button"
                    className={css.actionButton}
                    data-lifecycle={action}
                    disabled={!admitsLifecycle(selected.status, action)}
                    title={admitsLifecycle(selected.status, action) ? undefined : `当前状态 ${selected.status} 不允许 ${action}`}
                    onClick={() => {
                      if (action === 'archive' || action === 'delete') requestConfirmation(action)
                      else void runLifecycle(action)
                    }}
                  >
                    {LIFECYCLE_LABEL[action]} Workspace
                  </button>
                ))}
              </div>
              {pendingConfirm !== undefined && (
                <div className={css.confirmBar} role="group" aria-label="危险操作确认">
                  <span>危险操作：{CONFIRM_DESCRIPTION[pendingConfirm.action]}（{pendingConfirm.workspaceId}）</span>
                  <button type="button" className={css.dangerButton} onClick={confirmPending}>
                    {CONFIRM_LABEL[pendingConfirm.action]}
                  </button>
                  <button type="button" className={css.actionButton} onClick={() => { setPendingConfirm(undefined) }}>取消</button>
                </div>
              )}
              {feedback !== undefined && (
                <p className={css.feedbackBanner} data-tone={feedback.tone} data-code={feedback.code} role="alert">
                  {feedback.code}：{feedback.message}
                </p>
              )}
              {conflictMessage !== undefined && (
                <p className={css.conflictBanner} role="alert">
                  REVISION_CONFLICT：{conflictMessage}
                  <button type="button" onClick={refresh}>刷新</button>
                </p>
              )}
            </>
          )}
        </section>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整预览面板宽度"
          tabIndex={0}
          data-panel-divider="right"
          aria-valuenow={panelWidths.right}
          aria-valuemin={240}
          aria-valuemax={520}
          className={css.panelDivider}
          onPointerDown={onDividerPointerDown('right')}
          onPointerMove={onDividerPointerMove}
          onPointerUp={endDividerDrag}
          onPointerCancel={endDividerDrag}
        />
        <aside className={css.rightPane} aria-label="workspace-panels">
          <div role="tablist" className={css.tabs}>
            {(['preview', 'changes', 'run'] as const).map(name => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={pane === name}
                className={pane === name ? css.tabActive : css.tab}
                onClick={() =>{  setPane(name) }}
              >
                {name === 'preview' && 'Preview'}
                {name === 'changes' && 'Changes'}
                {name === 'run' && 'Run'}
              </button>
            ))}
          </div>
          {pane === 'preview' && (
            <div className={css.panelBody}>
              {openPath === undefined && <p className={css.hint}>在左侧目录中选择文件。</p>}
              {state.preview?.kind === 'static_html' ? (
                <iframe
                  title="preview-iframe"
                  className={css.previewFrame}
                  // The service declared both the isolation and the policy; the
                  // workbench applies them and never widens either. The sandbox
                  // attribute is mandatory here because the parser rejects an
                  // html preview without one.
                  sandbox={isolatedSandbox(state.preview.sandbox ?? [])}
                  srcDoc={applyPreviewCsp(state.preview.content ?? '', state.preview.csp ?? '')}
                />
              ) : state.preview?.kind === 'image' ? (
                <img
                  className={css.previewImage}
                  alt={state.preview.path}
                  src={`data:${state.preview.contentType};base64,${state.preview.contentBase64 ?? ''}`}
                />
              ) : state.preview !== undefined ? (
                <pre className={css.previewText}>{state.preview.content ?? state.preview.diff ?? ''}</pre>
              ) : null}
              <div className={css.webAppRow}>
                <button
                  type="button"
                  className={css.actionButton}
                  disabled={selected?.status !== 'ready'}
                  onClick={() => void issueWebApp()}
                >
                  打开 Web App（签发短期 URL）
                </button>
                {webAppGrant !== undefined && (
                  <span className={css.hint}>
                    <a href={webAppGrant.url} target="_blank" rel="noopener noreferrer">{webAppGrant.url}</a>
                    （{webAppGrant.expiresAt} 前有效）
                  </span>
                )}
                {webAppGrant === undefined && webAppExpired && (
                  <button type="button" className={css.actionButton} disabled={selected?.status !== 'ready'} onClick={() => void issueWebApp()}>
                    重新获取预览
                  </button>
                )}
              </div>
            </div>
          )}
          {pane === 'changes' && (
            <div className={css.panelBody}>
              {state.changes === undefined ? (
                <p className={css.hint}>暂无变更数据。</p>
              ) : (
                <>
                  <p className={css.paneTitle}>基线 {state.changes.baselineRevision} → rev {state.changes.revision}</p>
                  <ul className={css.changeList}>
                    {state.changes.files.map(file => (
                      <li key={file.path}>
                        <span className={css.changePath}>{file.path} ({file.change})</span>
                        <pre className={css.diffText}>{file.diff}</pre>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className={css.changesActions}>
                <label className={css.fieldRow}>
                  提交信息
                  <input
                    aria-label="提交信息"
                    value={commitMessage}
                    onChange={(event) => { setCommitMessage(event.target.value) }}
                  />
                </label>
                <button
                  type="button"
                  className={css.actionButton}
                  disabled={selected?.status !== 'ready' || commitMessage.trim() === ''}
                  title={selected?.status !== 'ready' ? '仅就绪工作空间可提交' : undefined}
                  onClick={() => { void commitChanges() }}
                >
                  提交变更
                </button>
                <label className={css.fieldRow}>
                  Pull Request 标题
                  <input
                    aria-label="Pull Request 标题"
                    value={pullRequestTitle}
                    onChange={(event) => { setPullRequestTitle(event.target.value) }}
                  />
                </label>
                <button
                  type="button"
                  className={css.actionButton}
                  disabled={selected?.status !== 'ready' || pullRequestTitle.trim() === ''}
                  title={selected?.status !== 'ready' ? '仅就绪工作空间可创建 PR' : undefined}
                  onClick={() => { void openPullRequest() }}
                >
                  创建 Pull Request
                </button>
                <button
                  type="button"
                  className={css.dangerButton}
                  disabled={selected?.status !== 'ready'}
                  title={selected?.status !== 'ready' ? '仅就绪工作空间可丢弃变更' : undefined}
                  onClick={() => { requestConfirmation('discard') }}
                >
                  丢弃变更
                </button>
              </div>
            </div>
          )}
          {pane === 'run' && (
            <div className={css.panelBody}>
              <div className={css.runActions}>
                <button
                  type="button"
                  className={css.actionButton}
                  disabled={selected?.status !== 'ready' || sessionId === undefined}
                  onClick={() => void startRun('write')}
                >
                  开始 Run（写入）
                </button>
                <button
                  type="button"
                  className={css.actionButton}
                  disabled={selected?.status !== 'ready' || sessionId === undefined}
                  onClick={() => void startRun('read_only')}
                >
                  开始 Run（只读）
                </button>
              </div>
              <ul className={css.runList}>
                {state.runs.map(run => (
                  <li key={run.runId} className={css.runItem}>
                    <span>{run.runId}</span>
                    <span>{run.status} · {run.writeMode} · rev {run.workspaceRevision}{run.errorCode === null ? '' : ` · ${run.errorCode}`}</span>
                    <span className={css.runSnapshot}>
                      配置 {run.agentProfileVersionId} · 资产 {run.assetVersionIds.length} 项
                      {run.executionPolicy.permission_mode === undefined ? '' : ` · 策略 ${run.executionPolicy.permission_mode}`}
                      {run.executionPolicy.write_mode === undefined ? '' : `/${run.executionPolicy.write_mode === 'write' ? '允许写入' : '只读'}`}
                    </span>
                    {['queued', 'starting', 'running', 'waiting_approval'].includes(run.status) && (
                      <button type="button" className={css.iconButton} onClick={() => void cancelRun(run.runId)}>取消</button>
                    )}
                    <button
                      type="button"
                      className={css.iconButton}
                      aria-label={`时间线-${run.runId}`}
                      onClick={() => void showTimeline(run.runId)}
                    >
                      时间线
                    </button>
                    {runDetail?.runId === run.runId && runDetail.timeline !== undefined && (
                      <ol className={css.timelineList}>
                        {runDetail.timeline.map(entry => (
                          <li key={`${entry.at}-${entry.status}`}>
                            {entry.status} @ {entry.at}{entry.detail === undefined ? '' : ` · ${entry.detail}`}
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
      <div className={css.drawerBar}>
        <button type="button" aria-label="toggle-left-drawer" className={css.drawerToggle} onClick={() =>{  drawerToggle('left') }}>目录</button>
        <button type="button" aria-label="toggle-right-drawer" className={css.drawerToggle} onClick={() =>{  drawerToggle('right') }}>面板</button>
      </div>
    </section>
  )
}


const PANEL_WIDTH_KEY = 'dsh.cloud-workspace.panel-widths'
const PANEL_WIDTH_DEFAULTS = { left: 260, right: 320 } as const
const PANEL_WIDTH_MIN = { left: 200, right: 240 } as const
const PANEL_WIDTH_MAX = { left: 480, right: 520 } as const

/** Read persisted panel widths, clamped into the allowed range; any storage
 * failure or malformed value falls back to the defaults. */
function readPanelWidths(): { readonly left: number; readonly right: number } {
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_KEY)
    if (raw === null) return { ...PANEL_WIDTH_DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<{ left: number; right: number }> | null
    return {
      // clampPanelWidth re-validates at runtime: stored JSON may hold non-numeric garbage.
      left: clampPanelWidth(parsed?.left ?? PANEL_WIDTH_DEFAULTS.left, 'left'),
      right: clampPanelWidth(parsed?.right ?? PANEL_WIDTH_DEFAULTS.right, 'right'),
    }
  } catch {
    return { ...PANEL_WIDTH_DEFAULTS }
  }
}

/** Persist panel widths; best-effort, failures keep the in-memory layout. */
function savePanelWidths(widths: { readonly left: number; readonly right: number }): void {
  try {
    window.localStorage.setItem(PANEL_WIDTH_KEY, JSON.stringify(widths))
  } catch {
    // Storage unavailable: the layout still applies for this session.
  }
}

function clampPanelWidth(width: number, side: 'left' | 'right' = 'left'): number {
  const minimum = side === 'left' ? PANEL_WIDTH_MIN.left : PANEL_WIDTH_MIN.right
  const maximum = side === 'left' ? PANEL_WIDTH_MAX.left : PANEL_WIDTH_MAX.right
  if (!Number.isFinite(width)) return side === 'left' ? PANEL_WIDTH_DEFAULTS.left : PANEL_WIDTH_DEFAULTS.right
  return Math.min(maximum, Math.max(minimum, Math.round(width)))
}
