/** Host-only Team Skill workflow: authorized download, verified write and local record. */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { TeamSkillInstallError, installTeamSkill, quarantineTeamSkill, uninstallTeamSkill } from './installer.ts'
import { TeamSkillAccountHttpClient, type TeamSkillAccountSessionResponse, TeamSkillHttpClient, TeamSkillHttpError } from './http.ts'
import { TeamSkillInstallationStore } from './installation-store.ts'
import type {
  TeamSkillCatalogResult,
  TeamSkillAccessSummary,
  TeamSkillAccountResult,
  TeamSkillAccountState,
  TeamSkillChangePasswordRequest,
  TeamSkillLoginRequest,
  TeamSkillFailed,
  TeamSkillInstallRequest,
  TeamSkillInstallResult,
  TeamSkillInstallationRecord,
  TeamSkillInstallationView,
  TeamSkillNotReady,
  TeamSkillScope,
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

const ACCOUNT_CREDENTIAL_KEY = credentialKey('dsh-ai-coding-platform', 'account')

interface AccountGrant {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
}

/** Private Host settings supplied by the Cordis plugin configuration. */
export interface TeamSkillHostOptions {
  /** AI Coding service endpoint including `/v1`; omitted means catalog is not ready. */
  readonly apiBaseUrl?: string
  /** OIDC access token kept in the Host plane; omitted means catalog is not ready. */
  readonly accessToken?: string
  /** DSH credential record provider used for the account session. */
  readonly credentials?: CredentialProvider
  /** Private platform state root; it is never sent to the service. */
  readonly stateDirectory?: string
  /** DSH global Skill discovery root. */
  readonly globalSkillRoot?: string
  /** Resolve an opaque DSH workspace id without exposing its path to the browser or service. */
  readonly resolveWorkspace?: (workspaceId: string) => string | undefined
  /** Confirm DSH's native Skill registry discovers a newly written copy. */
  readonly refreshSkillCatalog?: (
    scope: TeamSkillScope,
    workspacePath: string | undefined,
    runtimeName: string,
    expectedPresent?: boolean,
  ) => Promise<boolean>
  /** Injectable fetch implementation for focused Host tests. */
  readonly fetch?: typeof globalThis.fetch
}

/** Orchestrates a real local Team Skill operation from server authorization to DSH discovery. */
export class TeamSkillHost {
  constructor(private readonly options: TeamSkillHostOptions) {}

  /** Authenticate and persist a service session in the Host credential store.
   * @param request - Username and password submitted to the service.
   * @returns Browser-safe account state or an explicit unavailable, signed-out, or failed state.
   */
  async login(request: TeamSkillLoginRequest): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    const client = this.accountClient()
    if ('status' in client) return client
    if (this.options.credentials === undefined) return missing(['credentials'])
    try {
      const session = await client.login(request)
      await this.writeAccountSession(session)
      return accountState(session)
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Read the current account from the service, refreshing one expired session when needed and deleting a rejected grant.
   * @returns Browser-safe account state or an explicit unavailable, signed-out, or failed state.
   */
  async account(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    const client = this.accountClient()
    if ('status' in client) return client
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      const me = await this.accountRequest(client, session, accessToken => client.me(accessToken))
      return { status: 'authenticated', user: me.user, memberships: me.memberships, mustChangePassword: me.user.mustChangePassword }
    } catch (error) {
      if (error instanceof TeamSkillHttpError && isExpiredTokenCode(error.code)) {
        await this.clearAccountSession()
        return { status: 'signed-out' }
      }
      return failureOf(error)
    }
  }

  /** Rotate the current service session without exposing replacement tokens.
   * @returns Browser-safe account state or an explicit unavailable, signed-out, or failed state.
   */
  async refreshAccount(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    const client = this.accountClient()
    if ('status' in client) return client
    if (this.options.credentials === undefined) return missing(['credentials'])
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      const next = await client.refresh(session.refreshToken)
      await this.writeAccountSession(next)
      return accountState(next)
    } catch (error) {
      await this.clearAccountSession()
      return failureOf(error)
    }
  }

  /** Change the current password and replace the service session.
   * @param request - Current and replacement password values.
   * @returns Browser-safe account state or an explicit unavailable, signed-out, or failed state.
   */
  async changePassword(request: TeamSkillChangePasswordRequest): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    const client = this.accountClient()
    if ('status' in client) return client
    if (this.options.credentials === undefined) return missing(['credentials'])
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      const next = await this.accountRequest(client, session, accessToken => client.changePassword(accessToken, request))
      await this.writeAccountSession(next)
      return accountState(next)
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Revoke the service session and clear Host credentials even when revocation fails.
   * @returns Signed-out account state or an explicit unavailable or failed state.
   */
  async logout(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    const client = this.accountClient()
    if ('status' in client) return client
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      await client.logout(session.accessToken)
    } catch {
      // Local credential removal is required even when the service is unavailable.
    }
    await this.clearAccountSession()
    return { status: 'signed-out' }
  }

  /** Read the aggregate access summary after confirming the current session.
   * @returns Server-filtered access summary or an explicit unavailable, signed-out, or failed state.
   */
  async accessSummary(): Promise<TeamSkillAccountResult<TeamSkillAccessSummary>> {
    const client = this.accountClient()
    if ('status' in client) return client
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      return await this.accountRequest(client, session, accessToken => client.accessSummary(accessToken))
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Read the service-authoritative active project list for the signed-in account.
   * @returns Active project summaries or an explicit signed-out or failed state.
   */
  async projects(): Promise<TeamSkillAccountResult<readonly TeamSkillProject[]>> {
    const client = this.accountClient()
    if ('status' in client) return client
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      return await this.accountRequest(client, session, accessToken => client.projects(accessToken))
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Read one authorized project and its asset relation summaries.
   * @param projectId - Opaque project identity selected by the user.
   * @returns Authorized project detail or an explicit failed state.
   */
  async project(projectId: string): Promise<TeamSkillAccountResult<TeamSkillProjectDetail>> {
    const client = this.accountClient()
    if ('status' in client) return client
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      return await this.accountRequest(client, session, accessToken => client.project(accessToken, projectId))
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Read the visible catalog without returning a fake fallback when service configuration is incomplete.
   * @param projectId - Opaque project identity authorized by the service.
   * @returns Current catalog or an explicit unavailable or failed state.
   */
  async catalog(projectId: string): Promise<TeamSkillCatalogResult> {
    const client = await this.client()
    if ('status' in client) return client
    try {
      return { status: 'ready', catalog: await client.catalog(projectId) }
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Read current project knowledge-base summaries through the service.
   * @param projectId - Opaque project identity authorized by the service.
   * @returns Server-authoritative knowledge-base summaries or an explicit failure.
   */
  async knowledgeBases(projectId: string): Promise<TeamSkillAccountResult<readonly TeamSkillKnowledgeBaseSummary[]>> {
    return this.knowledgeRequest(client => client.knowledgeBases(projectId))
  }

  /** Search explicitly selected knowledge bases for one conversation turn.
   * @param request - Project and knowledge-base search request.
   * @param signal - Optional cancellation signal for the service request.
   * @returns Server-authoritative search results or an explicit failure.
   */
  async knowledgeSearch(
    request: TeamSkillKnowledgeSearchRequest,
    signal?: AbortSignal,
  ): Promise<TeamSkillAccountResult<{ readonly status: 'ready'; readonly response: TeamSkillKnowledgeSearchResponse }>> {
    const result = await this.knowledgeRequest(client => client.knowledgeSearch(request, signal), signal)
    if (isKnowledgeFailure(result)) return result
    return { status: 'ready', response: result }
  }

  /** Resolve an authorized document preview URL.
   * @param knowledgeBaseId - Opaque knowledge-base identity.
   * @param documentId - Opaque document identity.
   * @returns Server-authoritative preview or an explicit failure.
   */
  async knowledgePreview(knowledgeBaseId: string, documentId: string): Promise<TeamSkillAccountResult<TeamSkillKnowledgePreview>> {
    return this.knowledgeRequest(client => client.knowledgePreview(knowledgeBaseId, documentId))
  }

  /** Recall project memories without blocking the native coding request.
   * @param request - Project and query sent to the service.
   * @param signal - Optional cancellation signal for the service request.
   * @returns Recall results or an explicit service failure.
   */
  async memoryRecall(
    request: { readonly projectId: string; readonly query: string },
    signal?: AbortSignal,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryRecallResponse>> {
    return this.memoryRequest(client => client.memoryRecall(request, signal), signal)
  }

  /** Accept one asynchronous automatic-capture batch.
   * @param request - Project, session, and cleaned transcript messages.
   * @param idempotencyKey - Unique key for this capture attempt.
   * @returns Accepted mutation or an explicit service failure.
   */
  async memoryCapture(
    request: {
      readonly projectId: string
      readonly sessionId: string
      readonly taskId?: string
      readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
    },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.memoryRequest(client => client.memoryCapture(request, idempotencyKey))
  }

  /** List project memories from the server cursor.
   * @param request - Project, optional search term, cursor, and page size.
   * @returns Server-authoritative memory page or an explicit service failure.
   */
  async memoryList(request: {
    readonly projectId: string
    readonly keyword?: string
    readonly cursor?: string
    readonly limit?: number
  }): Promise<TeamSkillAccountResult<TeamSkillMemoryPage>> {
    return this.memoryRequest(client => client.memoryList(request))
  }

  /** Read one project-memory detail.
   * @param memoryId - Opaque memory identity.
   * @returns Server-authoritative memory detail or an explicit service failure.
   */
  async memoryGet(memoryId: string): Promise<TeamSkillAccountResult<TeamSkillMemory>> {
    return this.memoryRequest(client => client.memoryGet(memoryId))
  }

  /** Update one project-memory body with server revision control.
   * @param request - Memory identity, replacement body, and expected revision.
   * @returns Accepted mutation or an explicit revision or authorization failure.
   */
  async memoryUpdate(request: {
    readonly memoryId: string
    readonly content: string
    readonly expectedRevision: number
  }): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.memoryRequest(client => client.memoryUpdate(request))
  }

  /** Delete one project-memory record and return its cleanup job.
   * @param request - Memory identity and expected revision.
   * @param idempotencyKey - Unique key for this delete attempt.
   * @returns Accepted deletion or an explicit revision or authorization failure.
   */
  async memoryDelete(
    request: { readonly memoryId: string; readonly expectedRevision: number },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.memoryRequest(client => client.memoryDelete(request, idempotencyKey))
  }

  /** List capture, indexing, and cleanup jobs.
   * @param projectId - Optional project filter.
   * @returns Server-authoritative jobs or an explicit service failure.
   */
  async memoryJobs(projectId?: string): Promise<TeamSkillAccountResult<readonly TeamSkillMemoryJob[]>> {
    return this.memoryRequest(client => client.memoryJobs(projectId))
  }

  /** List server memory governance audit records.
   * @param projectId - Optional project filter.
   * @returns Server-authoritative audit records or an explicit service failure.
   */
  async memoryAudit(projectId?: string): Promise<TeamSkillAccountResult<readonly TeamSkillMemoryAudit[]>> {
    return this.memoryRequest(client => client.memoryAudit(projectId))
  }

  /** Return browser-safe, service-authorized installation summaries for one project.
   * @param projectId - Opaque project identity to reauthorize before returning local records.
   * @returns Browser-safe installation summaries or an explicit local-state error.
   */
  async installations(projectId: string): Promise<readonly TeamSkillInstallationView[] | TeamSkillNotReady | TeamSkillFailed> {
    if (this.options.stateDirectory === undefined) return missing(['stateDirectory'])
    try {
      const records = (await this.store().list()).filter(record => record.projectId === projectId)
      if (records.length === 0) return Object.freeze([])
      const client = await this.client()
      if ('status' in client) return client
      const statuses = await client.releaseStatus(
        records.map(record => ({ projectId: record.projectId, skillId: record.skillId, version: record.installed.version })),
      )
      const visibleKeys = new Set(statuses.map(item => `${item.projectId}:${item.skillId}:${item.version}`))
      return Object.freeze(
        records
          .filter(record => visibleKeys.has(`${record.projectId}:${record.skillId}:${record.installed.version}`))
          .map(toInstallationView),
      )
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Synchronize one project's local copies with server release state and quarantine unavailable versions.
   * @param projectId - Opaque project identity to reauthorize before synchronizing local records.
   * @returns Updated local copies or an explicit unavailable or failed state.
   */
  async syncReleaseStatus(projectId: string): Promise<readonly TeamSkillInstallationView[] | TeamSkillNotReady | TeamSkillFailed> {
    if (this.options.stateDirectory === undefined) return missing(['stateDirectory'])
    try {
      const records = (await this.store().list()).filter(record => record.projectId === projectId)
      if (records.length === 0) return Object.freeze([])
      const client = await this.client()
      if ('status' in client) return client
      const statuses = await client.releaseStatus(
        records.map(record => ({ projectId: record.projectId, skillId: record.skillId, version: record.installed.version })),
      )
      const statusByKey = new Map(statuses.map(item => [`${item.projectId}:${item.skillId}:${item.version}`, item.status]))
      const updated: TeamSkillInstallationRecord[] = []
      for (const record of records) {
        const releaseStatus = statusByKey.get(`${record.projectId}:${record.skillId}:${record.installed.version}`)
        if (record.installed.state !== 'normal') {
          if (releaseStatus !== undefined) updated.push(record)
          continue
        }
        if (releaseStatus === 'published') {
          updated.push(record)
          continue
        }
        const root = this.localRoot(record.scope, record.workspaceId)
        if ('status' in root) throw new TeamSkillHttpError('LOCAL_WORKSPACE_UNAVAILABLE', '无法定位已下线 Skill 的本地作用域。')
        const withdrawn = await quarantineTeamSkill({
          installed: record.installed,
          quarantineRoot: join(this.options.stateDirectory, 'quarantine', record.localInstallationId),
        })
        const discovered =
          this.options.refreshSkillCatalog === undefined
            ? true
            : await this.options.refreshSkillCatalog(record.scope, root.workspacePath, record.installed.runtimeName, false)
        if (!discovered) throw new TeamSkillHttpError('LOCAL_REFRESH_FAILED', 'DSH 未能移除已下线的 Team Skill。')
        const next = Object.freeze({ ...record, installed: withdrawn })
        await this.store().upsert(next)
        if (releaseStatus !== undefined) updated.push(next)
      }
      return Object.freeze(updated.map(toInstallationView))
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Remove one managed copy and confirm that DSH no longer discovers it.
   * @param request - Opaque local installation identity and scope.
   * @returns Final explicit uninstall result.
   */
  async uninstall(request: TeamSkillUninstallRequest): Promise<TeamSkillUninstallResult> {
    if (this.options.stateDirectory === undefined) return missing(['stateDirectory'])
    if (this.options.refreshSkillCatalog === undefined) return missing(['refreshSkillCatalog'])
    try {
      const record = (await this.store().list()).find(item => item.localInstallationId === request.localInstallationId)
      if (record === undefined) throw new TeamSkillHttpError('LOCAL_INSTALLATION_NOT_FOUND', '找不到由本插件管理的 Team Skill 安装。')
      if (record.installed.state !== 'normal') return { status: 'succeeded', installation: toInstallationView(record) }
      const root = this.localRoot(record.scope, record.workspaceId)
      if ('status' in root) return root
      const removed = await uninstallTeamSkill({
        installed: record.installed,
        ...(request.confirmModifiedReplace === true ? { confirmModifiedReplace: true } : {}),
      })
      const discovered = await this.options.refreshSkillCatalog(record.scope, root.workspacePath, record.installed.runtimeName, false)
      if (!discovered) throw new TeamSkillHttpError('LOCAL_REFRESH_FAILED', 'DSH 未能移除本地 Team Skill。')
      const next = Object.freeze({ ...record, installed: removed })
      await this.store().upsert(next)
      return { status: 'succeeded', installation: toInstallationView(next) }
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Install one server-authorized immutable Skill into a DSH root selected by scope.
   * @param request - Skill, scope and local dependency preflight data.
   * @returns Final explicit installation result.
   */
  async install(request: TeamSkillInstallRequest): Promise<TeamSkillInstallResult> {
    const client = await this.client()
    if ('status' in client) return client
    const localRoot = this.localRoot(request.scope, request.workspaceId)
    if ('status' in localRoot) return localRoot
    if (this.options.stateDirectory === undefined) return missing(['stateDirectory'])
    if (this.options.refreshSkillCatalog === undefined) return missing(['refreshSkillCatalog'])

    const localInstallationId = randomUUID()
    let operationId: string | undefined
    let eventSequence = 0
    try {
      const authorized = await client.createInstallation({
        skillId: request.skillId,
        version: request.version,
        projectId: request.projectId,
        scope: request.scope,
        localInstallationId,
        environment: request.environment,
      })
      operationId = authorized.operationId
      await this.report(client, operationId, ++eventSequence, 'downloading')
      const archive = await client.download(authorized.artifact.downloadUrl)
      await this.report(client, operationId, ++eventSequence, 'verifying')

      const current = (await this.store().list()).find(record => sameScope(record, request.scope, request.workspaceId, request.skillId))
      await this.report(client, operationId, ++eventSequence, 'writing')
      const installed = await installTeamSkill({
        scopeRoot: localRoot.root,
        runtimeName: authorized.runtimeName,
        version: authorized.version,
        archive,
        expectedSha256: authorized.artifact.sha256,
        expectedFileDigests: authorized.artifact.files,
        ...(current === undefined ? {} : { current: current.installed }),
        ...(request.confirmModifiedReplace === true ? { confirmModifiedReplace: true } : {}),
      })
      const installation: TeamSkillInstallationRecord = Object.freeze({
        localInstallationId,
        skillId: authorized.skillId,
        projectId: request.projectId,
        scope: request.scope,
        ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
        installed,
        installedAt: new Date().toISOString(),
      })
      await this.store().upsert(installation)
      await this.report(client, operationId, ++eventSequence, 'refreshing')
      const discovered = await this.options.refreshSkillCatalog(request.scope, localRoot.workspacePath, authorized.runtimeName)
      if (!discovered) {
        throw new TeamSkillHttpError('LOCAL_REFRESH_FAILED', 'DSH did not discover the installed Team Skill.')
      }
      await this.report(client, operationId, ++eventSequence, 'succeeded')
      return { status: 'succeeded', installation: toInstallationView(installation) }
    } catch (error) {
      const failure = failureOf(error)
      if (operationId !== undefined) {
        try {
          await this.report(client, operationId, ++eventSequence, 'failed', failure.code)
        } catch {
          // The original operation failure remains the user-visible cause.
        }
      }
      return failure
    }
  }

  private async client(): Promise<TeamSkillHttpClient | TeamSkillNotReady | TeamSkillFailed> {
    const apiBaseUrl = this.options.apiBaseUrl
    let accessToken = this.options.accessToken
    if (accessToken === undefined && this.options.credentials !== undefined) {
      try {
        const session = await this.readAccountSession()
        if (session !== undefined) {
          if (session.expiresAt <= Date.now() + 30_000) {
            const accountClient = this.accountClient()
            if ('status' in accountClient) return accountClient
            const refreshed = await accountClient.refresh(session.refreshToken)
            await this.writeAccountSession(refreshed)
            accessToken = refreshed.accessToken
          } else {
            accessToken = session.accessToken
          }
        }
      } catch (error) {
        await this.clearAccountSession()
        return failureOf(error)
      }
    }
    if (apiBaseUrl === undefined || apiBaseUrl.length === 0 || accessToken === undefined || accessToken.length === 0) {
      return missing([
        ...(apiBaseUrl === undefined || apiBaseUrl.length === 0 ? ['apiBaseUrl'] : []),
        ...(accessToken === undefined || accessToken.length === 0 ? ['accessToken'] : []),
      ])
    }
    return new TeamSkillHttpClient({
      apiBaseUrl,
      accessToken,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    })
  }

  private accountClient(): TeamSkillAccountHttpClient | TeamSkillNotReady {
    if (this.options.apiBaseUrl === undefined || this.options.apiBaseUrl.length === 0) return missing(['apiBaseUrl'])
    return new TeamSkillAccountHttpClient({
      apiBaseUrl: this.options.apiBaseUrl,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    })
  }

  private async readAccountSession(): Promise<AccountGrant | undefined> {
    const credentials = this.options.credentials
    if (credentials === undefined) return undefined
    const record = await credentials.readRecord(ACCOUNT_CREDENTIAL_KEY)
    if (record === undefined) return undefined
    if (record.kind !== 'grant' || !isAccountGrant(record.payload))
      throw new TeamSkillHttpError('CREDENTIALS_INVALID', 'DSH 账号授权记录无效。')
    return record.payload
  }

  private async writeAccountSession(session: TeamSkillAccountSessionResponse): Promise<void> {
    const credentials = this.options.credentials
    if (credentials === undefined) throw new TeamSkillHttpError('CREDENTIALS_UNAVAILABLE', 'DSH 凭据服务不可用。')
    const payload: AccountGrant = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: Date.now() + session.expiresIn * 1000,
    }
    await credentials.modifyRecord(ACCOUNT_CREDENTIAL_KEY, () => Promise.resolve({ kind: 'grant', payload }))
  }

  private async clearAccountSession(): Promise<void> {
    await this.options.credentials?.deleteRecord(ACCOUNT_CREDENTIAL_KEY)
  }

  private async accountRequest<T>(
    client: TeamSkillAccountHttpClient,
    session: AccountGrant,
    operation: (accessToken: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted()
    try {
      if (session.expiresAt <= Date.now() + 30_000) {
        const refreshed = await client.refresh(session.refreshToken)
        await this.writeAccountSession(refreshed)
        signal?.throwIfAborted()
        return await operation(refreshed.accessToken)
      }
      return await operation(session.accessToken)
    } catch (error) {
      if (!(error instanceof TeamSkillHttpError) || !isExpiredTokenCode(error.code)) throw error
      signal?.throwIfAborted()
      const refreshed = await client.refresh(session.refreshToken)
      await this.writeAccountSession(refreshed)
      signal?.throwIfAborted()
      return await operation(refreshed.accessToken)
    }
  }

  private async knowledgeRequest<T>(
    operation: (client: TeamSkillHttpClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' }> {
    signal?.throwIfAborted()
    if (this.options.accessToken !== undefined || this.options.credentials === undefined) {
      const client = await this.client()
      if ('status' in client) return client
      try {
        return await operation(client)
      } catch (error) {
        return failureOf(error)
      }
    }
    const accountClient = this.accountClient()
    if ('status' in accountClient) return accountClient
    const apiBaseUrl = this.options.apiBaseUrl
    if (apiBaseUrl === undefined || apiBaseUrl.length === 0) return missing(['apiBaseUrl'])
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      return await this.accountRequest(
        accountClient,
        session,
        accessToken =>
          operation(
            new TeamSkillHttpClient({
              apiBaseUrl,
              accessToken,
              ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
            }),
          ),
        signal,
      )
    } catch (error) {
      if (error instanceof TeamSkillHttpError && isExpiredTokenCode(error.code)) {
        await this.clearAccountSession()
        return { status: 'signed-out' }
      }
      return failureOf(error)
    }
  }

  private memoryRequest<T>(
    operation: (client: TeamSkillHttpClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' }> {
    return this.knowledgeRequest(operation, signal)
  }

  private store(): TeamSkillInstallationStore {
    if (this.options.stateDirectory === undefined) throw new Error('Team Skill state directory is not configured.')
    return new TeamSkillInstallationStore(this.options.stateDirectory)
  }

  private localRoot(
    scope: TeamSkillScope,
    workspaceId: string | undefined,
  ): { readonly root: string; readonly workspacePath?: string } | TeamSkillNotReady {
    if (scope === 'global') {
      if (this.options.globalSkillRoot === undefined) return missing(['globalSkillRoot'])
      return { root: this.options.globalSkillRoot }
    }
    if (workspaceId === undefined || this.options.resolveWorkspace === undefined) return missing(['workspaceId'])
    const workspacePath = this.options.resolveWorkspace(workspaceId)
    if (workspacePath === undefined) return missing(['workspaceId'])
    return { root: join(workspacePath, '.dsh', 'skills'), workspacePath }
  }

  private async report(
    client: TeamSkillHttpClient,
    operationId: string,
    eventSequence: number,
    status: Parameters<TeamSkillHttpClient['reportOperationEvent']>[2],
    errorCode?: string,
  ): Promise<void> {
    await client.reportOperationEvent(operationId, eventSequence, status, errorCode)
  }
}

function missing(fields: readonly string[]): TeamSkillNotReady {
  return Object.freeze({ status: 'not-ready', missing: Object.freeze([...fields]) })
}

function accountState(session: TeamSkillAccountSessionResponse): TeamSkillAccountState {
  return { status: 'authenticated', user: session.user, memberships: session.memberships, mustChangePassword: session.mustChangePassword }
}

function isAccountGrant(value: unknown): value is AccountGrant {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.accessToken === 'string' &&
    record.accessToken.length > 0 &&
    typeof record.refreshToken === 'string' &&
    record.refreshToken.length > 0 &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt)
  )
}

function isExpiredTokenCode(code: string): boolean {
  return code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED' || code === 'TOKEN_EXPIRED' || code === 'TOKEN_REVOKED'
}

function failureOf(error: unknown): TeamSkillFailed {
  if (error instanceof TeamSkillHttpError || error instanceof TeamSkillInstallError) {
    return Object.freeze({ status: 'failed', code: error.code, message: error.message })
  }
  return Object.freeze({
    status: 'failed',
    code: 'LOCAL_OPERATION_FAILED',
    message: error instanceof Error ? error.message : 'Team Skill local operation failed.',
  })
}

function isKnowledgeFailure(
  value: unknown,
): value is TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' } {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false
  const status = (value as { readonly status?: unknown }).status
  return status === 'not-ready' || status === 'failed' || status === 'signed-out'
}

function sameScope(record: TeamSkillInstallationRecord, scope: TeamSkillScope, workspaceId: string | undefined, skillId: string): boolean {
  return record.skillId === skillId && record.scope === scope && record.workspaceId === workspaceId
}

/** Remove Host-private filesystem metadata before crossing the typed Remote. */
function toInstallationView(record: TeamSkillInstallationRecord): TeamSkillInstallationView {
  return Object.freeze({
    localInstallationId: record.localInstallationId,
    skillId: record.skillId,
    projectId: record.projectId,
    scope: record.scope,
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    runtimeName: record.installed.runtimeName,
    version: record.installed.version,
    artifactSha256: record.installed.artifactSha256,
    state: record.installed.state,
    installedAt: record.installedAt,
  })
}
