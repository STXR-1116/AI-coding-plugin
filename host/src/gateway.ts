/** Cordis and Typert projection for Host-owned Team Skill operations. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-skill'
import { TeamSkillHost } from './host.ts'
import type {
  TeamSkillCatalogResult,
  TeamSkillAccessSummary,
  TeamSkillAccountResult,
  TeamSkillAccountState,
  TeamSkillChangePasswordRequest,
  TeamSkillInstallRequest,
  TeamSkillInstallResult,
  TeamSkillInstallationView,
  TeamSkillLoginRequest,
  TeamSkillNotReady,
  TeamSkillFailed,
  TeamSkillUninstallRequest,
  TeamSkillUninstallResult,
  TeamSkillProject,
  TeamSkillProjectDetail,
  TeamSkillKnowledgeBaseSummary,
  TeamSkillKnowledgeSearchRequest,
  TeamSkillKnowledgeSearchResponse,
  TeamSkillKnowledgePreview,
  TeamSkillMemory,
  TeamSkillMemoryPage,
  TeamSkillMemoryRecallResponse,
  TeamSkillMemoryMutation,
  TeamSkillMemoryJob,
  TeamSkillMemoryAudit,
} from './types.ts'
import { TeamSkillKnowledgeLoop } from './knowledge-loop.ts'
import type { TeamSkillKnowledgeSelection } from './knowledge-loop.ts'
import { TeamSkillMemoryLoop } from './memory-loop.ts'

/** Deployment-owned Team Skill Host configuration. */
export interface Config {
  /** AI Coding service API base URL including `/v1`; absent produces `not-ready`. */
  readonly apiBaseUrl?: string
  /** OIDC token kept in the Host configuration; absent produces `not-ready`. */
  readonly accessToken?: string
  /** Host-only data root for installation records and quarantined content. */
  readonly stateDirectory: string
  /** Native DSH global Skill discovery directory. */
  readonly globalSkillRoot: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned Team Skill operations projected to browser clients through Typert. */
    teamSkills: TeamSkillGateway
  }
}

/** Host service that exposes Team Skill operations through the typed Remote gateway. */
export class TeamSkillGateway extends TypertRemoteService {
  static inject = ['skills', 'workspaceRegistry', 'agents']

  static Config: Schema<Config> = z.object({
    apiBaseUrl: z.string(),
    accessToken: z.string(),
    stateDirectory: z.string().required(),
    globalSkillRoot: z.string().required(),
  })

  private readonly host: TeamSkillHost
  private readonly knowledgeSelections = new WeakMap<Agent, TeamSkillKnowledgeSelection>()
  private readonly knowledgeLoop: TeamSkillKnowledgeLoop
  private readonly memoryProjects = new WeakMap<Agent, string>()
  private readonly memoryLoop: TeamSkillMemoryLoop

  constructor(ctx: Context, config: Config) {
    super(ctx, 'teamSkills')
    const credentials = ctx.get('credentials')
    this.host = new TeamSkillHost({
      ...(config.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.apiBaseUrl }),
      ...(config.accessToken === undefined ? {} : { accessToken: config.accessToken }),
      stateDirectory: config.stateDirectory,
      globalSkillRoot: config.globalSkillRoot,
      ...(credentials === undefined ? {} : { credentials }),
      resolveWorkspace: workspaceId => ctx.workspaceRegistry.get(WorkspaceId(workspaceId))?.path,
      refreshSkillCatalog: async (_scope, workspacePath, runtimeName, expectedPresent = true) =>
        (await ctx.skills.list(...(workspacePath === undefined ? [] : [{ cwd: workspacePath }]))).some(
          skill => skill.name === runtimeName,
        ) === expectedPresent,
    })
    this.knowledgeLoop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: agent => this.knowledgeSelections.get(agent),
      search: (request, signal) =>
        this.host.knowledgeSearch(request, signal).then((result) => {
          if (result.status === 'ready') return result
          return result
        }),
    })
    this.memoryLoop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: agent => this.memoryProjects.get(agent),
      recall: (request, signal) =>
        this.host.memoryRecall(request, signal).then((result) => {
          if (isMemoryRecallResponse(result)) return result
          if ('status' in result && result.status === 'failed')
            return {
              status: 'UNAVAILABLE',
              items: [],
              contextText: '',
              strategy: 'unavailable',
              effectivePolicy: { topK: 0, relevanceThreshold: 1, tokenBudget: 0 },
            }
          return {
            status: 'PROJECT_REQUIRED',
            items: [],
            contextText: '',
            strategy: 'not-ready',
            effectivePolicy: { topK: 0, relevanceThreshold: 1, tokenBudget: 0 },
          }
        }),
      capture: (request, idempotencyKey) =>
        this.host.memoryCapture(request, idempotencyKey).then((result) => {
          if (isMemoryMutation(result)) return result
          return result
        }),
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.knowledgeSelections.delete(agent)
      this.memoryProjects.delete(agent)
    })
    ctx.effect(
      () => () => {
        this.knowledgeLoop.dispose()
        this.memoryLoop.dispose()
      },
      'ai-coding-platform: knowledge and memory loops',
    )
  }

  /** Select project knowledge bases for one live native DSH session. */
  private setKnowledgeSelection(agent: Agent, selection: TeamSkillKnowledgeSelection): void {
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`agent "${agent.id}" is not live in the registry`)
    if (selection.projectId.length === 0 || selection.knowledgeBaseIds.length === 0) {
      this.knowledgeSelections.delete(agent)
      return
    }
    this.knowledgeSelections.set(
      agent,
      Object.freeze({ projectId: selection.projectId, knowledgeBaseIds: Object.freeze([...new Set(selection.knowledgeBaseIds)]) }),
    )
  }

  /** Clear the session-only knowledge selection without touching the Session log. */
  private clearKnowledgeSelectionForAgent(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`agent "${agent.id}" is not live in the registry`)
    this.knowledgeSelections.delete(agent)
  }

  /** Authenticate through the service and persist the session in Host credentials.
   * @param request - Username and password submitted to the service.
   * @returns Browser-safe authenticated account state or an explicit failure.
   */
  @Remote('login')
  login(request: TeamSkillLoginRequest): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    return this.host.login(request)
  }

  /** Read the current browser-safe account state.
   * @returns Current account state or an explicit signed-out or failed state.
   */
  @Remote('account')
  account(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    return this.host.account()
  }

  /** Rotate the current service session.
   * @returns Replacement browser-safe account state or an explicit failure.
   */
  @Remote('refreshAccount')
  refreshAccount(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    return this.host.refreshAccount()
  }

  /** Change the current account password.
   * @param request - Current and replacement password values.
   * @returns Replacement browser-safe account state or an explicit failure.
   */
  @Remote('changePassword')
  changePassword(request: TeamSkillChangePasswordRequest): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    return this.host.changePassword(request)
  }

  /** Revoke the current service session and clear Host credentials.
   * @returns Signed-out account state.
   */
  @Remote('logout')
  logout(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    return this.host.logout()
  }

  /** Read the aggregate access summary across all organizations.
   * @returns Server-filtered access or an explicit failure.
   */
  @Remote('accessSummary')
  accessSummary(): Promise<TeamSkillAccountResult<TeamSkillAccessSummary>> {
    return this.host.accessSummary()
  }

  /** Read active projects visible to the authenticated account.
   * @returns Service-authorized project summaries or an explicit failure.
   */
  @Remote('projects')
  projects(): Promise<TeamSkillAccountResult<readonly TeamSkillProject[]>> {
    return this.host.projects()
  }

  /** Read one active project and its authorized asset summaries.
   * @param projectId - Opaque project identity selected by the user.
   * @returns Service-authorized project detail or an explicit failure.
   */
  @Remote('project')
  project(projectId: string): Promise<TeamSkillAccountResult<TeamSkillProjectDetail>> {
    return this.host.project(projectId)
  }

  /** Return the current caller-visible server catalog or an explicit unavailable state.
   * @param projectId - Opaque project identity authorized by the service.
   * @returns Current caller-visible catalog or an explicit unavailable state.
   */
  @Remote('catalog')
  catalog(projectId: string): Promise<TeamSkillCatalogResult> {
    return this.host.catalog(projectId)
  }

  /** Read the current project's knowledge-base summaries.
   * @param projectId - Opaque project identity selected by the user.
   * @returns Server-authoritative knowledge-base summaries or an explicit failure.
   */
  @Remote('knowledgeBases')
  knowledgeBases(projectId: string): Promise<TeamSkillAccountResult<readonly TeamSkillKnowledgeBaseSummary[]>> {
    return this.host.knowledgeBases(projectId)
  }

  /** Search the explicitly selected knowledge bases for one conversation turn.
   * @param request - Project and knowledge-base search request.
   * @returns Server-authoritative search results or an explicit failure.
   */
  @Remote('knowledgeSearch')
  knowledgeSearch(
    request: TeamSkillKnowledgeSearchRequest,
  ): Promise<TeamSkillAccountResult<{ readonly status: 'ready'; readonly response: TeamSkillKnowledgeSearchResponse }>> {
    return this.host.knowledgeSearch(request)
  }

  /** Resolve an authorized knowledge document preview.
   * @param knowledgeBaseId - Opaque knowledge-base identity.
   * @param documentId - Opaque document identity.
   * @returns Server-authoritative preview or an explicit failure.
   */
  @Remote('knowledgePreview')
  knowledgePreview(knowledgeBaseId: string, documentId: string): Promise<TeamSkillAccountResult<TeamSkillKnowledgePreview>> {
    return this.host.knowledgePreview(knowledgeBaseId, documentId)
  }

  /** Recall server-authoritative project memories for one coding request.
   * @param request - Project and query sent to the service.
   * @returns Recall results with explicit service status.
   */
  @Remote('memoryRecall')
  memoryRecall(request: {
    readonly projectId: string
    readonly query: string
  }): Promise<TeamSkillAccountResult<TeamSkillMemoryRecallResponse>> {
    return this.host.memoryRecall(request)
  }

  /** Accept one automatic capture batch after a completed turn.
   * @param request - Project, session, and cleaned transcript messages.
   * @param idempotencyKey - Unique key for this capture attempt.
   * @returns Accepted mutation or an explicit failure.
   */
  @Remote('memoryCapture')
  memoryCapture(
    request: {
      readonly projectId: string
      readonly sessionId: string
      readonly taskId?: string
      readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
    },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.host.memoryCapture(request, idempotencyKey)
  }

  /** List current project memories using the service cursor.
   * @param request - Project, optional search term, cursor, and page size.
   * @returns Server-authoritative memory page or an explicit failure.
   */
  @Remote('memoryList')
  memoryList(request: {
    readonly projectId: string
    readonly keyword?: string
    readonly cursor?: string
    readonly limit?: number
  }): Promise<TeamSkillAccountResult<TeamSkillMemoryPage>> {
    return this.host.memoryList(request)
  }

  /** Read one project-memory detail.
   * @param memoryId - Opaque memory identity.
   * @returns Server-authoritative memory detail or an explicit failure.
   */
  @Remote('memoryGet')
  memoryGet(memoryId: string): Promise<TeamSkillAccountResult<TeamSkillMemory>> {
    return this.host.memoryGet(memoryId)
  }

  /** Update one project-memory body with optimistic revision control.
   * @param request - Memory identity, replacement body, and expected revision.
   * @returns Accepted mutation or an explicit revision or authorization failure.
   */
  @Remote('memoryUpdate')
  memoryUpdate(request: {
    readonly memoryId: string
    readonly content: string
    readonly expectedRevision: number
  }): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.host.memoryUpdate(request)
  }

  /** Delete one project-memory record with an idempotency key.
   * @param request - Memory identity and expected revision.
   * @param idempotencyKey - Unique key for this delete attempt.
   * @returns Accepted deletion and cleanup job or an explicit failure.
   */
  @Remote('memoryDelete')
  memoryDelete(
    request: { readonly memoryId: string; readonly expectedRevision: number },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.host.memoryDelete(request, idempotencyKey)
  }

  /** Read project-memory processing jobs.
   * @param projectId - Optional project filter.
   * @returns Server-authoritative jobs or an explicit failure.
   */
  @Remote('memoryJobs')
  memoryJobs(projectId?: string): Promise<TeamSkillAccountResult<readonly TeamSkillMemoryJob[]>> {
    return this.host.memoryJobs(projectId)
  }

  /** Read project-memory governance audit records.
   * @param projectId - Optional project filter.
   * @returns Server-authoritative audit records or an explicit failure.
   */
  @Remote('memoryAudit')
  memoryAudit(projectId?: string): Promise<TeamSkillAccountResult<readonly TeamSkillMemoryAudit[]>> {
    return this.host.memoryAudit(projectId)
  }

  /** Enable session-only knowledge recall for the live agent behind one session id.
   * @param sessionId - Live DSH session identity.
   * @param selection - Project and knowledge bases to use for recall.
   */
  @Remote('configureKnowledgeSelection')
  configureKnowledgeSelection(sessionId: string, selection: TeamSkillKnowledgeSelection): void {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`session "${sessionId}" is not a live agent`)
    this.setKnowledgeSelection(agent, selection)
  }

  /** Clear session-only knowledge recall for the live agent behind one session id.
   * @param sessionId - Live DSH session identity.
   */
  @Remote('clearKnowledgeSelection')
  clearKnowledgeSelection(sessionId: string): void {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`session "${sessionId}" is not a live agent`)
    this.clearKnowledgeSelectionForAgent(agent)
  }

  /** Bind automatic project-memory recall and capture to one live session.
   * @param sessionId - Live DSH session identity.
   * @param projectId - Opaque project identity used by automatic memory operations.
   */
  @Remote('configureProjectMemory')
  configureProjectMemory(sessionId: string, projectId: string): void {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`session "${sessionId}" is not a live agent`)
    if (projectId.length === 0) this.memoryProjects.delete(agent)
    else this.memoryProjects.set(agent, projectId)
  }

  /** Clear automatic project-memory context for one live session.
   * @param sessionId - Live DSH session identity.
   */
  @Remote('clearProjectMemory')
  clearProjectMemory(sessionId: string): void {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`session "${sessionId}" is not a live agent`)
    this.memoryProjects.delete(agent)
  }

  /** Return local copies managed by this Host, or an explicit local-state error.
   * @param projectId - Opaque project identity reauthorized by the service.
   * @returns Browser-safe local copies or an explicit local-state error.
   */
  @Remote('installations')
  installations(projectId: string): Promise<readonly TeamSkillInstallationView[] | TeamSkillNotReady | TeamSkillFailed> {
    return this.host.installations(projectId)
  }

  /** Synchronize local copies against server release state and isolate withdrawals.
   * @param projectId - Opaque project identity reauthorized by the service.
   * @returns Updated local copies or an explicit unavailable or failed state.
   */
  @Remote('syncReleaseStatus')
  syncReleaseStatus(projectId: string): Promise<readonly TeamSkillInstallationView[] | TeamSkillNotReady | TeamSkillFailed> {
    return this.host.syncReleaseStatus(projectId)
  }

  /**
   * Authorize, download, verify, install and discover one Team Skill without
   * allowing the browser to write a local path.
   * @param request - Opaque Skill, scope and local dependency preflight data.
   * @returns Final explicit operation result.
   */
  @Remote('installSkill')
  install(request: TeamSkillInstallRequest): Promise<TeamSkillInstallResult> {
    return this.host.install(request)
  }

  /** Remove one Host-managed local copy and refresh native DSH discovery.
   * @param request - Opaque local installation identity and scope.
   * @returns Final explicit uninstall result.
   */
  @Remote('uninstallSkill')
  uninstall(request: TeamSkillUninstallRequest): Promise<TeamSkillUninstallResult> {
    return this.host.uninstall(request)
  }
}

export default TeamSkillGateway

function isMemoryRecallResponse(value: unknown): value is TeamSkillMemoryRecallResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    ['READY', 'PARTIAL', 'UNAVAILABLE', 'PROJECT_REQUIRED'].includes((value as { status?: unknown }).status as string)
  )
}

function isMemoryMutation(value: unknown): value is TeamSkillMemoryMutation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    ['PENDING', 'INDEX_PENDING'].includes((value as { status?: unknown }).status as string)
  )
}
