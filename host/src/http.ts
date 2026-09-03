/** HTTP client for the AI Coding service Team Skill API. */

import { randomUUID } from 'node:crypto'
import type {
  TeamSkillAccessSummary,
  TeamSkillAccountMembership,
  TeamSkillAccountRole,
  TeamSkillAccountStatus,
  TeamSkillAccountUser,
  TeamSkillChangePasswordRequest,
  TeamSkillLoginRequest,
  TeamSkillOrganization,
  TeamSkillProject,
  TeamSkillProjectDetail,
  TeamSkillProjectAsset,
  TeamSkillAsset,
  TeamSkillAuthorizedOperation,
  TeamSkillCatalog,
  TeamSkillCatalogItem,
  TeamSkillEnvironment,
  TeamSkillOperationStatus,
  TeamSkillReleaseStatusItem,
  TeamSkillScope,
  TeamSkillKnowledgeBaseSummary,
  TeamSkillKnowledgeSearchRequest,
  TeamSkillKnowledgeSearchResponse,
  TeamSkillKnowledgePreview,
  TeamSkillMemory,
  TeamSkillMemoryPage,
  TeamSkillMemoryRecallResponse,
  TeamSkillMemoryRecallItem,
  TeamSkillMemoryMutation,
  TeamSkillMemoryJob,
  TeamSkillMemoryAudit,
} from './types.ts'
import type { TeamSkillFileDigest } from './installer.ts'

/** Service failure whose code can be displayed or mapped by the Host. */
export class TeamSkillHttpError extends Error {
  /**
   * @param code - Stable service or transport failure code.
   * @param message - Safe message for the invoking Host.
   */
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'TeamSkillHttpError'
  }
}

/** Options that never enter browser-visible Remote payloads. */
export interface TeamSkillHttpClientOptions {
  /** API base URL including the `/v1` prefix. */
  readonly apiBaseUrl: string
  /** Current OIDC access token. */
  readonly accessToken: string
  /** Injectable fetch implementation for Host tests. */
  readonly fetch?: typeof globalThis.fetch
}

/** Raw session response kept inside the Host and never returned through Remote. */
export interface TeamSkillAccountSessionResponse {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresIn: number
  readonly user: TeamSkillAccountUser
  readonly memberships: readonly TeamSkillAccountMembership[]
  readonly mustChangePassword: boolean
}

/** Host-side HTTP client for the account and access-summary API. */
export class TeamSkillAccountHttpClient {
  private readonly fetch: typeof globalThis.fetch
  private readonly baseUrl: string

  constructor(options: { readonly apiBaseUrl: string; readonly fetch?: typeof globalThis.fetch }) {
    this.baseUrl = options.apiBaseUrl.replace(/\/$/u, '')
    this.fetch = options.fetch ?? globalThis.fetch
  }

  /** Authenticate one username/password pair.
   * @param request - Username and password submitted to the service.
   * @returns Raw session response retained by the Host.
   */
  async login(request: TeamSkillLoginRequest): Promise<TeamSkillAccountSessionResponse> {
    return parseAccountSession(
      await this.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: request.username, password: request.password }),
      }),
    )
  }

  /** Rotate a refresh token and return the replacement session.
   * @param refreshToken - Current refresh token retained by the Host.
   * @returns Replacement raw session response retained by the Host.
   */
  async refresh(refreshToken: string): Promise<TeamSkillAccountSessionResponse> {
    return parseAccountSession(
      await this.request('/auth/refresh', {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }),
    )
  }

  /** Revoke the current access-token session.
   * @param accessToken - Current access token retained by the Host.
   */
  async logout(accessToken: string): Promise<void> {
    await this.request('/auth/logout', { method: 'POST', headers: { 'idempotency-key': randomUUID() } }, accessToken)
  }

  /** Change the current password and return the replacement session.
   * @param accessToken - Current access token retained by the Host.
   * @param request - Current and replacement password values.
   * @returns Replacement raw session response retained by the Host.
   */
  async changePassword(accessToken: string, request: TeamSkillChangePasswordRequest): Promise<TeamSkillAccountSessionResponse> {
    return parseAccountSession(
      await this.request(
        '/auth/change-password',
        {
          method: 'POST',
          headers: { 'idempotency-key': randomUUID() },
          body: JSON.stringify({ current_password: request.currentPassword, new_password: request.newPassword }),
        },
        accessToken,
      ),
    )
  }

  /** Read the current account summary.
   * @param accessToken - Current access token retained by the Host.
   * @returns Service-authoritative user and membership summary.
   */
  async me(
    accessToken: string,
  ): Promise<{ readonly user: TeamSkillAccountUser; readonly memberships: readonly TeamSkillAccountMembership[] }> {
    const record = requireRecord(await this.request('/me', { method: 'GET' }, accessToken), 'account summary')
    const userRecord = recordOf(record.user) ?? record
    return { user: parseAccountUser(userRecord), memberships: parseMemberships(record.memberships) }
  }

  /** Read one service-authoritative access summary across all organizations.
   * @param accessToken - Current access token retained by the Host.
   * @returns Service-filtered aggregate access summary.
   */
  async accessSummary(accessToken: string): Promise<TeamSkillAccessSummary> {
    const record = requireRecord(await this.request('/me/access-summary', { method: 'GET' }, accessToken), 'access summary')
    return Object.freeze({
      organizations: Object.freeze(requireArray(record.organizations, 'access organizations').map(parseOrganization)),
      projects: Object.freeze(requireArray(record.projects, 'access projects').map(parseProject)),
      assets: Object.freeze(requireArray(record.assets, 'access assets').map(parseAsset)),
      management: Object.freeze({
        organizationIds: Object.freeze(
          requireArray(record.management_organization_ids, 'access management_organization_ids').map((item, index) =>
            requireString(item, `access management_organization_ids[${index}]`),
          ),
        ),
        projectIds: Object.freeze(
          requireArray(record.management_project_ids, 'access management_project_ids').map((item, index) =>
            requireString(item, `access management_project_ids[${index}]`),
          ),
        ),
      }),
      revision: requireNumber(record.revision, 'access revision'),
    })
  }

  /** Read the current caller's active projects from the dedicated project endpoint.
   * @param accessToken - Current access token retained by the Host.
   * @returns Service-authorized active project summaries.
   */
  async projects(accessToken: string): Promise<readonly TeamSkillProject[]> {
    const record = requireRecord(await this.request('/me/projects', { method: 'GET' }, accessToken), 'project list')
    return Object.freeze(requireArray(record.items, 'project items').map(parseProject))
  }

  /** Read one project and its doubly-authorized asset summaries.
   * @param accessToken - Current access token retained by the Host.
   * @param projectId - Opaque project id selected by the user.
   * @returns Service-authorized project detail.
   */
  async project(accessToken: string, projectId: string): Promise<TeamSkillProjectDetail> {
    const record = requireRecord(
      await this.request(`/me/projects/${encodeURIComponent(projectId)}`, { method: 'GET' }, accessToken),
      'project detail',
    )
    return {
      project: parseProject(record.project),
      assets: Object.freeze(requireArray(record.assets, 'project assets').map(parseProjectAsset)),
    }
  }

  private async request(path: string, init: RequestInit, accessToken?: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (accessToken !== undefined) headers.authorization = `Bearer ${accessToken}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.headers !== undefined)
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value
      })
    const response = await this.fetch(`${this.baseUrl}${path}`, { ...init, headers })
    if (!response.ok) throw await accountErrorOf(response)
    if (response.status === 204) return undefined
    try {
      return await response.json()
    } catch {
      throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned an invalid JSON response.')
    }
  }
}

/** Request body sent to authorize one local installation. */
export interface CreateTeamSkillInstallationRequest {
  /** Server Skill identity. */
  readonly skillId: string
  /** Immutable version. */
  readonly version: string
  /** Opaque project identity used for server-side resource authorization. */
  readonly projectId: string
  /** User-selected local root. */
  readonly scope: TeamSkillScope
  /** Host-generated local installation identity. */
  readonly localInstallationId: string
  /** Dependency-preflight facts only. */
  readonly environment: TeamSkillEnvironment
}

/** Small, explicit HTTP client shared by the Host gateway and tests. */
export class TeamSkillHttpClient {
  private readonly fetch: typeof globalThis.fetch

  constructor(private readonly options: TeamSkillHttpClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
  }

  /** Read the current caller's visible published catalog.
   * @param projectId - Opaque project identity authorized by the service.
   * @returns Published catalog returned by the service.
   */
  async catalog(projectId: string): Promise<TeamSkillCatalog> {
    const body = await this.request(`/team-skills?project_id=${encodeURIComponent(projectId)}`, { method: 'GET' })
    return parseCatalog(body)
  }

  /** Read the current project knowledge-base summaries.
   * @param projectId - Opaque project identity authorized by the service.
   * @returns Server-authoritative knowledge-base summaries.
   */
  async knowledgeBases(projectId: string): Promise<readonly TeamSkillKnowledgeBaseSummary[]> {
    const body = await this.request(`/projects/${encodeURIComponent(projectId)}/knowledge-bases`, { method: 'GET' })
    const record = requireRecord(body, 'knowledge base response')
    return Object.freeze(requireArray(record.items, 'knowledge base items').map(parseKnowledgeBase))
  }

  /** Search only the explicitly selected project knowledge bases.
   * @param request - Project and knowledge-base search request.
   * @param signal - Optional cancellation signal for the service request.
   * @returns Server-authoritative search results.
   */
  async knowledgeSearch(
    request: Omit<TeamSkillKnowledgeSearchRequest, 'projectId'> & { readonly projectId: string },
    signal?: AbortSignal,
  ): Promise<TeamSkillKnowledgeSearchResponse> {
    const body = await this.request(`/projects/${encodeURIComponent(request.projectId)}/knowledge-search`, {
      method: 'POST',
      body: JSON.stringify({
        query: request.query,
        knowledge_base_ids: request.knowledgeBaseIds,
        ...(request.topK === undefined ? {} : { top_k: request.topK }),
        ...(request.traceId === undefined ? {} : { trace_id: request.traceId }),
      }),
      ...(signal === undefined ? {} : { signal }),
    })
    return parseKnowledgeSearch(body)
  }

  /** Return a server-authorized document preview URL.
   * @param knowledgeBaseId - Opaque knowledge-base identity.
   * @param documentId - Opaque document identity.
   * @returns Server-authoritative preview.
   */
  async knowledgePreview(knowledgeBaseId: string, documentId: string): Promise<TeamSkillKnowledgePreview> {
    const body = await this.request(
      `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/preview`,
      { method: 'GET' },
    )
    const record = requireRecord(body, 'knowledge preview')
    return {
      knowledgeBaseId: requireString(record.knowledge_base_id, 'preview knowledge_base_id'),
      documentId: requireString(record.document_id, 'preview document_id'),
      title: requireString(record.title, 'preview title'),
      previewUrl: requireString(record.preview_url, 'preview preview_url'),
    }
  }

  /** Recall active L1 memories for one authorized project.
   * @param request - Project and query sent to the service.
   * @param signal - Optional cancellation signal for the service request.
   * @returns Server-authoritative recall results.
   */
  async memoryRecall(
    request: { readonly projectId: string; readonly query: string },
    signal?: AbortSignal,
  ): Promise<TeamSkillMemoryRecallResponse> {
    const value = await this.memoryRequest('/project-memory/recall', {
      method: 'POST',
      body: JSON.stringify({ project_id: request.projectId, query: request.query }),
      ...(signal === undefined ? {} : { signal }),
    })
    const record = memoryData(value)
    return Object.freeze({
      status: memoryStatus(record.status),
      items: Object.freeze(requireArray(record.items, 'memory recall items').map(parseMemoryRecallItem)),
      contextText: requireString(record.context_text, 'memory context_text'),
      strategy: requireString(record.strategy, 'memory strategy'),
      effectivePolicy: parseMemoryPolicy(record.effective_policy),
    })
  }

  /** Accept one asynchronous capture using an idempotency key.
   * @param request - Project, session, and cleaned transcript messages.
   * @param idempotencyKey - Unique key for this capture attempt.
   * @returns Accepted mutation from the service.
   */
  async memoryCapture(
    request: {
      readonly projectId: string
      readonly sessionId: string
      readonly taskId?: string
      readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
    },
    idempotencyKey: string,
  ): Promise<TeamSkillMemoryMutation> {
    const value = await this.memoryRequest('/project-memory/capture', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        project_id: request.projectId,
        session_id: request.sessionId,
        ...(request.taskId === undefined ? {} : { task_id: request.taskId }),
        messages: request.messages,
      }),
    })
    return parseMemoryMutation(memoryData(value))
  }

  /** Read a cursor page of active project memories.
   * @param request - Project, optional search term, cursor, and page size.
   * @returns Server-authoritative memory page.
   */
  async memoryList(request: {
    readonly projectId: string
    readonly keyword?: string
    readonly cursor?: string
    readonly limit?: number
  }): Promise<TeamSkillMemoryPage> {
    const value = await this.memoryRequest('/project-memory/list', {
      method: 'POST',
      body: JSON.stringify({
        project_id: request.projectId,
        ...(request.keyword === undefined ? {} : { keyword: request.keyword }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      }),
    })
    const record = memoryData(value)
    return Object.freeze({
      items: Object.freeze(requireArray(record.items, 'memory list items').map(parseMemory)),
      nextCursor: optionalString(record.next_cursor, 'memory next_cursor') ?? null,
      totalEstimate: requireNumber(record.total_estimate, 'memory total_estimate'),
    })
  }

  /** Read one memory detail.
   * @param memoryId - Opaque memory identity.
   * @returns Server-authoritative memory detail.
   */
  async memoryGet(memoryId: string): Promise<TeamSkillMemory> {
    const value = await this.memoryRequest('/project-memory/get', { method: 'POST', body: JSON.stringify({ memory_id: memoryId }) })
    return parseMemory(memoryData(value))
  }

  /** Update one memory body with optimistic revision control.
   * @param request - Memory identity, replacement body, and expected revision.
   * @returns Accepted mutation from the service.
   */
  async memoryUpdate(request: {
    readonly memoryId: string
    readonly content: string
    readonly expectedRevision: number
  }): Promise<TeamSkillMemoryMutation> {
    const value = await this.memoryRequest('/project-memory/update', {
      method: 'POST',
      headers: { 'If-Match': String(request.expectedRevision) },
      body: JSON.stringify({ memory_id: request.memoryId, content: request.content, expected_revision: request.expectedRevision }),
    })
    return parseMemoryMutation(memoryData(value))
  }

  /** Accept deletion and immediately remove the record from recall.
   * @param request - Memory identity and expected revision.
   * @param idempotencyKey - Unique key for this delete attempt.
   * @returns Accepted deletion and cleanup job.
   */
  async memoryDelete(
    request: { readonly memoryId: string; readonly expectedRevision: number },
    idempotencyKey: string,
  ): Promise<TeamSkillMemoryMutation> {
    const value = await this.memoryRequest('/project-memory/delete', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': String(request.expectedRevision) },
      body: JSON.stringify({ memory_id: request.memoryId, expected_revision: request.expectedRevision }),
    })
    return parseMemoryMutation(memoryData(value))
  }

  /** List memory jobs visible to the current account.
   * @param projectId - Optional project filter.
   * @returns Server-authoritative jobs.
   */
  async memoryJobs(projectId?: string): Promise<readonly TeamSkillMemoryJob[]> {
    const value = await this.memoryRequest('/project-memory/jobs/list', {
      method: 'POST',
      body: JSON.stringify(projectId === undefined ? {} : { project_id: projectId }),
    })
    return Object.freeze(requireArray(memoryData(value).items, 'memory jobs').map(parseMemoryJob))
  }

  /** List memory governance audit records visible to the current account.
   * @param projectId - Optional project filter.
   * @returns Server-authoritative audit records.
   */
  async memoryAudit(projectId?: string): Promise<readonly TeamSkillMemoryAudit[]> {
    const value = await this.memoryRequest('/project-memory/audit/list', {
      method: 'POST',
      body: JSON.stringify(projectId === undefined ? {} : { project_id: projectId }),
    })
    return Object.freeze(requireArray(memoryData(value).items, 'memory audit').map(parseMemoryAudit))
  }

  private async memoryRequest(path: string, init: RequestInit): Promise<unknown> {
    const base = this.options.apiBaseUrl.replace(/\/v1\/?$/u, '/v3').replace(/\/$/u, '')
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.accessToken}` }
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const response = await this.fetch(`${base}${path}`, { ...init, headers })
    if (!response.ok) throw await this.errorOf(response)
    return response.status === 204 ? undefined : response.json()
  }

  /** Read publication state for installed versions before local discovery is refreshed.
   * @param items - Installed Skill identities to check.
   * @returns Publication state for each requested identity.
   */
  async releaseStatus(
    items: readonly Pick<TeamSkillReleaseStatusItem, 'skillId' | 'version' | 'projectId'>[],
  ): Promise<readonly TeamSkillReleaseStatusItem[]> {
    if (items.length === 0) return Object.freeze([])
    const body = await this.request('/team-skills/release-status', {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ items: items.map(item => ({ skill_id: item.skillId, version: item.version, project_id: item.projectId })) }),
    })
    const record = requireRecord(body, 'release status response')
    const values = requireArray(record.items, 'release status items')
    return Object.freeze(
      values.map((value) => {
        const entry = requireRecord(value, 'release status item')
        const status = entry.status === 'published' || entry.status === 'withdrawn' ? entry.status : undefined
        if (status === undefined)
          throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid release status.')
        return Object.freeze({
          skillId: requireString(entry.skill_id, 'release status skill_id'),
          version: requireString(entry.version, 'release status version'),
          projectId: requireString(entry.project_id, 'release status project_id'),
          status,
        })
      }),
    )
  }

  /** Ask the service to authorize one immutable artifact installation.
   * @param request - Skill, scope and local dependency preflight data.
   * @returns Short-lived artifact authorization and operation identity.
   */
  async createInstallation(request: CreateTeamSkillInstallationRequest): Promise<TeamSkillAuthorizedOperation> {
    const body = await this.request('/team-skill-installations', {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        skill_id: request.skillId,
        version: request.version,
        project_id: request.projectId,
        scope: request.scope,
        local_installation_id: request.localInstallationId,
        environment: {
          dsh_version: request.environment.dshVersion,
          available_tools: request.environment.availableTools,
          available_mcp_servers: request.environment.availableMcpServers,
          present_environment_variable_names: request.environment.presentEnvironmentVariableNames,
        },
      }),
    })
    return parseAuthorizedOperation(body)
  }

  /** Download one already-authorized artifact with the same OIDC token.
   * @param url - Service-issued artifact download URL.
   * @returns Exact artifact bytes returned by the service.
   */
  async download(url: string): Promise<Uint8Array> {
    const response = await this.fetch(url, { headers: this.headers() })
    if (!response.ok) throw await this.errorOf(response)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Append one ordered local-operation event to the server audit record.
   * @param operationId - Service-issued installation operation identity.
   * @param eventSequence - Monotonic event sequence for this operation.
   * @param status - New local-operation status.
   * @param errorCode - Optional stable failure code for a failed operation.
   */
  async reportOperationEvent(
    operationId: string,
    eventSequence: number,
    status: TeamSkillOperationStatus,
    errorCode?: string,
  ): Promise<void> {
    await this.request(`/team-skill-installations/${encodeURIComponent(operationId)}/events`, {
      method: 'POST',
      headers: { 'idempotency-key': `${operationId}:${eventSequence}` },
      body: JSON.stringify({
        event_sequence: eventSequence,
        status,
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
      }),
    })
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.accessToken}` }
    if (init.headers !== undefined) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value
      })
    }
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const response = await this.fetch(`${this.options.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
      ...init,
      headers,
    })
    if (!response.ok) throw await this.errorOf(response)
    if (response.status === 204) return undefined
    try {
      return await response.json()
    } catch {
      throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned an invalid JSON response.')
    }
  }

  private headers(): HeadersInit {
    return { authorization: `Bearer ${this.options.accessToken}` }
  }

  private async errorOf(response: Response): Promise<TeamSkillHttpError> {
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return new TeamSkillHttpError(`HTTP_${response.status}`, `AI Coding service returned HTTP ${response.status}.`)
    }
    const record = recordOf(body)
    const code = typeof record?.code === 'string' ? record.code : `HTTP_${response.status}`
    const message = typeof record?.message === 'string' ? record.message : `AI Coding service returned HTTP ${response.status}.`
    return new TeamSkillHttpError(code, message)
  }
}

async function accountErrorOf(response: Response): Promise<TeamSkillHttpError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return new TeamSkillHttpError(`HTTP_${response.status}`, `AI Coding service returned HTTP ${response.status}.`)
  }
  const record = recordOf(body)
  const nested = recordOf(record?.error)
  const code = typeof nested?.code === 'string' ? nested.code : typeof record?.code === 'string' ? record.code : `HTTP_${response.status}`
  const message =
    typeof nested?.message === 'string'
      ? nested.message
      : typeof record?.message === 'string'
        ? record.message
        : `AI Coding service returned HTTP ${response.status}.`
  return new TeamSkillHttpError(code, message)
}

function parseAccountSession(value: unknown): TeamSkillAccountSessionResponse {
  const record = requireRecord(value, 'account session')
  return Object.freeze({
    accessToken: requireString(record.access_token, 'access_token'),
    refreshToken: requireString(record.refresh_token, 'refresh_token'),
    expiresIn: requireNumber(record.expires_in, 'expires_in'),
    user: parseAccountUser(requireRecord(record.user, 'account user')),
    memberships: parseMemberships(record.memberships),
    mustChangePassword: requireBoolean(record.must_change_password, 'must_change_password'),
  })
}

function parseAccountUser(value: Record<string, unknown>): TeamSkillAccountUser {
  return Object.freeze({
    userId: requireString(value.user_id, 'user_id'),
    username: requireString(value.username, 'username'),
    email: requireString(value.email, 'email'),
    displayName: requireString(value.display_name, 'display_name'),
    status: requireAccountStatus(value.status, 'account status'),
    globalRole: requireAccountRole(value.global_role, 'global role'),
    mustChangePassword: requireBoolean(value.must_change_password, 'must_change_password'),
    revision: requireNumber(value.revision, 'user revision'),
  })
}

function parseMemberships(value: unknown): readonly TeamSkillAccountMembership[] {
  return Object.freeze(
    requireArray(value, 'memberships').map((entry) => {
      const record = requireRecord(entry, 'membership')
      return Object.freeze({
        organizationId: requireString(record.organization_id, 'membership organization_id'),
        organizationName: requireString(record.organization_name, 'membership organization_name'),
        status: requireAccountStatus(record.status, 'membership status'),
        revision: requireNumber(record.revision, 'membership revision'),
      })
    }),
  )
}

function parseOrganization(value: unknown): TeamSkillOrganization {
  const record = requireRecord(value, 'organization')
  return Object.freeze({
    organizationId: requireString(record.organization_id, 'organization_id'),
    name: requireString(record.name, 'organization name'),
    status:
      record.status === 'active' || record.status === 'archived'
        ? record.status
        : (() => {
          throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid organization status.')
        })(),
    revision: requireNumber(record.revision, 'organization revision'),
  })
}

function parseProject(value: unknown): TeamSkillProject {
  const record = requireRecord(value, 'project')
  return Object.freeze({
    projectId: requireString(record.project_id, 'project_id'),
    organizationId: requireString(record.organization_id, 'project organization_id'),
    name: requireString(record.name, 'project name'),
    organizationName: requireString(record.organization_name, 'project organization_name'),
    description: requireString(record.description, 'project description'),
    status:
      record.status === 'draft' || record.status === 'active' || record.status === 'archived'
        ? record.status
        : (() => {
          throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid project status.')
        })(),
    createdBy: requireString(record.created_by, 'project created_by'),
    createdAt: requireString(record.created_at, 'project created_at'),
    updatedAt: requireString(record.updated_at, 'project updated_at'),
    memberCount: requireNumber(record.member_count, 'project member_count'),
    assetCount: requireNumber(record.asset_count, 'project asset_count'),
    revision: requireNumber(record.revision, 'project revision'),
  })
}

function parseProjectAsset(value: unknown): TeamSkillProjectAsset {
  const record = requireRecord(value, 'project asset')
  const assetType = record.asset_type
  const relationKind = record.relation_kind
  if (assetType !== 'skill' && assetType !== 'knowledge' && assetType !== 'memory')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid project asset type.')
  if (relationKind !== 'reference' && relationKind !== 'context')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid project relation kind.')
  return {
    projectId: requireString(record.project_id, 'project asset project_id'),
    assetType,
    assetId: requireString(record.asset_id, 'project asset asset_id'),
    name: requireString(record.name, 'project asset name'),
    relationKind,
    createdAt: requireString(record.created_at, 'project asset created_at'),
    updatedAt: requireString(record.updated_at, 'project asset updated_at'),
    revision: requireNumber(record.revision, 'project asset revision'),
  }
}

function parseKnowledgeBase(value: unknown): TeamSkillKnowledgeBaseSummary {
  const record = requireRecord(value, 'knowledge base')
  const type = record.type
  const state = record.state
  if (type !== 'document' && type !== 'faq' && type !== 'wiki')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid knowledge base type.')
  if (state !== 'active' && state !== 'unavailable' && state !== 'deleting')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid knowledge base state.')
  return Object.freeze({
    knowledgeBaseId: requireString(record.knowledge_base_id, 'knowledge_base_id'),
    name: requireString(record.name, 'knowledge base name'),
    description: requireString(record.description, 'knowledge base description'),
    type,
    state,
    searchable: requireBoolean(record.searchable, 'knowledge base searchable'),
    updatedAt: requireString(record.updated_at, 'knowledge base updated_at'),
    revision: requireNumber(record.revision, 'knowledge base revision'),
  })
}

function parseKnowledgeSearch(value: unknown): TeamSkillKnowledgeSearchResponse {
  const record = requireRecord(value, 'knowledge search')
  const statuses: TeamSkillKnowledgeSearchResponse['knowledgeBases'] = requireArray(
    record.knowledge_bases,
    'knowledge search statuses',
  ).map((item) => {
    const entry = requireRecord(item, 'knowledge search status')
    const status = entry.status
    if (status !== 'used' && status !== 'no_hits' && status !== 'skipped')
      throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid knowledge search status.')
    const reason =
      entry.reason === null ||
      entry.reason === undefined ||
      entry.reason === 'processing' ||
      entry.reason === 'unavailable' ||
      entry.reason === 'forbidden' ||
      entry.reason === 'not_found' ||
      entry.reason === 'timeout' ||
      entry.reason === 'external_error'
        ? (entry.reason ?? null)
        : undefined
    if (reason === undefined)
      throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid knowledge search reason.')
    return { knowledgeBaseId: requireString(entry.knowledge_base_id, 'knowledge search knowledge_base_id'), status: status, reason }
  })
  const results = requireArray(record.results, 'knowledge search results').map((item) => {
    const entry = requireRecord(item, 'knowledge search result')
    const citation = recordOf(entry.citation)
    return {
      knowledgeBaseId: requireString(entry.knowledge_base_id, 'knowledge result knowledge_base_id'),
      knowledgeId: requireString(entry.knowledge_id, 'knowledge result knowledge_id'),
      title: requireString(entry.title, 'knowledge result title'),
      snippet: requireString(entry.snippet, 'knowledge result snippet'),
      score: requireNumber(entry.score, 'knowledge result score'),
      sourceUrl: requireString(entry.source_url, 'knowledge result source_url'),
      ...(citation === undefined
        ? {}
        : {
          citation: {
            ...(citation.page === undefined ? {} : { page: requireNumber(citation.page, 'citation page') }),
            ...(citation.chunk === undefined ? {} : { chunk: requireString(citation.chunk, 'citation chunk') }),
          },
        }),
    }
  })
  return Object.freeze({
    requestId: requireString(record.request_id, 'knowledge search request_id'),
    results: Object.freeze(results),
    knowledgeBases: Object.freeze(statuses),
  })
}

function memoryData(value: unknown): Record<string, unknown> {
  const outer = requireRecord(value, 'project memory response')
  return requireRecord(outer.data ?? outer, 'project memory data')
}

function parseMemory(value: unknown): TeamSkillMemory {
  const record = requireRecord(value, 'memory')
  const status = record.status
  if (status !== 'ACTIVE' && status !== 'DELETED')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid memory status.')
  if (record.layer !== 'L1' || record.source_kind !== 'agent_turn')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid memory metadata.')
  return Object.freeze({
    memoryId: requireString(record.memory_id, 'memory_id'),
    teamId: requireString(record.team_id, 'memory team_id'),
    projectId: requireString(record.project_id, 'memory project_id'),
    content: requireString(record.content, 'memory content'),
    layer: 'L1',
    capturedByUserId: requireString(record.captured_by_user_id, 'memory captured_by_user_id'),
    createdAt: requireString(record.created_at, 'memory created_at'),
    updatedAt: requireString(record.updated_at, 'memory updated_at'),
    revision: requireNumber(record.revision, 'memory revision'),
    status,
    importance: requireNumber(record.importance, 'memory importance'),
    recallCount: requireNumber(record.recall_count, 'memory recall_count'),
    lastRecalledAt: record.last_recalled_at === null ? null : requireString(record.last_recalled_at, 'memory last_recalled_at'),
    sourceKind: 'agent_turn',
  })
}

function parseMemoryRecallItem(value: unknown): TeamSkillMemoryRecallItem {
  const record = requireRecord(value, 'memory recall item')
  if (record.layer !== 'L1')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid memory recall layer.')
  return {
    memoryId: requireString(record.memory_id, 'memory recall memory_id'),
    content: requireString(record.content, 'memory recall content'),
    score: requireNumber(record.score, 'memory recall score'),
    layer: 'L1',
  }
}

function parseMemoryMutation(value: Record<string, unknown>): TeamSkillMemoryMutation {
  const memoryValue = value.memory === undefined ? undefined : parseMemory(value.memory)
  const status = value.status === 'PENDING' || value.status === 'INDEX_PENDING' ? value.status : undefined
  if (status === undefined)
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid memory mutation status.')
  const cleanup =
    value.cleanup_status === undefined
      ? undefined
      : value.cleanup_status === 'PENDING' || value.cleanup_status === 'FAILED'
        ? value.cleanup_status
        : undefined
  if (value.cleanup_status !== undefined && cleanup === undefined)
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid memory cleanup status.')
  return Object.freeze({
    ...(memoryValue === undefined ? {} : { memory: memoryValue }),
    eventId: requireString(value.event_id, 'memory event_id'),
    jobId: requireString(value.job_id, 'memory job_id'),
    status,
    ...(typeof value.accepted_count === 'number' ? { acceptedCount: value.accepted_count } : {}),
    ...(cleanup === undefined ? {} : { cleanupStatus: cleanup }),
  })
}

function parseMemoryPolicy(value: unknown): { readonly topK: number; readonly relevanceThreshold: number; readonly tokenBudget: number } {
  const record = requireRecord(value, 'memory effective policy')
  return {
    topK: requireNumber(record.top_k, 'memory policy top_k'),
    relevanceThreshold: requireNumber(record.relevance_threshold, 'memory policy relevance_threshold'),
    tokenBudget: requireNumber(record.token_budget, 'memory policy token_budget'),
  }
}

function memoryStatus(value: unknown): TeamSkillMemoryRecallResponse['status'] {
  if (value === 'READY' || value === 'PARTIAL' || value === 'UNAVAILABLE' || value === 'PROJECT_REQUIRED') return value
  throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid memory recall status.')
}

function parseMemoryJob(value: unknown): TeamSkillMemoryJob {
  const record = requireRecord(value, 'memory job')
  const kind = record.kind
  const status = record.status
  if (kind !== 'CAPTURE' && kind !== 'INDEX_REFRESH' && kind !== 'DELETE_CLEANUP' && kind !== 'SCOPE_MOVED')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid memory job kind.')
  if (status !== 'PENDING' && status !== 'SUCCEEDED' && status !== 'FAILED')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid memory job status.')
  return {
    jobId: requireString(record.job_id, 'memory job_id'),
    eventId: requireString(record.event_id, 'memory job event_id'),
    kind,
    teamId: requireString(record.team_id, 'memory job team_id'),
    projectId: requireString(record.project_id, 'memory job project_id'),
    requestedByUserId: requireString(record.requested_by_user_id, 'memory job requested_by_user_id'),
    status,
    retryable: requireBoolean(record.retryable, 'memory job retryable'),
    retryCount: requireNumber(record.retry_count, 'memory job retry_count'),
    createdAt: requireString(record.created_at, 'memory job created_at'),
    finishedAt: record.finished_at === null ? null : requireString(record.finished_at, 'memory job finished_at'),
    errorCode: record.error_code === null ? null : requireString(record.error_code, 'memory job error_code'),
    revision: requireNumber(record.revision, 'memory job revision'),
  }
}

function parseMemoryAudit(value: unknown): TeamSkillMemoryAudit {
  const record = requireRecord(value, 'memory audit record')
  const role = record.role
  if (role !== 'admin' && role !== 'manager' && role !== 'member')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid memory audit role.')
  return {
    auditId: requireString(record.audit_id, 'memory audit_id'),
    operation: requireString(record.operation, 'memory audit operation'),
    operatedByUserId: requireString(record.operated_by_user_id, 'memory audit operated_by_user_id'),
    role,
    memoryId: record.memory_id === null ? null : requireString(record.memory_id, 'memory audit memory_id'),
    projectId: requireString(record.project_id, 'memory audit project_id'),
    result: requireString(record.result, 'memory audit result'),
    eventId: requireString(record.event_id, 'memory audit event_id'),
  }
}

function parseAsset(value: unknown): TeamSkillAsset {
  const record = requireRecord(value, 'asset')
  const assetType = record.asset_type
  const visibility = record.visibility
  if (assetType !== 'project' && assetType !== 'skill' && assetType !== 'knowledge' && assetType !== 'memory')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid asset type.')
  if (visibility !== 'platform' && visibility !== 'organization' && visibility !== 'project' && visibility !== 'account')
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', 'AI Coding service returned invalid asset visibility.')
  return Object.freeze({
    assetId: requireString(record.asset_id, 'asset_id'),
    assetType,
    name: requireString(record.name, 'asset name'),
    visibility,
    ...(record.organization_id === undefined ? {} : { organizationId: requireString(record.organization_id, 'asset organization_id') }),
    ...(record.project_id === undefined ? {} : { projectId: requireString(record.project_id, 'asset project_id') }),
  })
}

function requireAccountRole(value: unknown, field: string): TeamSkillAccountRole {
  if (value === 'admin' || value === 'manager' || value === 'member') return value
  throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', `AI Coding service returned invalid ${field}.`)
}

function requireAccountStatus(value: unknown, field: string): TeamSkillAccountStatus {
  if (value === 'active' || value === 'suspended') return value
  throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', `AI Coding service returned invalid ${field}.`)
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value
  throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', `AI Coding service returned invalid ${field}.`)
}

function parseCatalog(value: unknown): TeamSkillCatalog {
  const record = requireRecord(value, 'catalog response')
  const values = requireArray(record.items, 'catalog items')
  const items = values.map(parseCatalogItem)
  const cursor = optionalString(record.next_cursor, 'catalog next_cursor')
  return Object.freeze({ items: Object.freeze(items), ...(cursor === undefined ? {} : { nextCursor: cursor }) })
}

function parseCatalogItem(value: unknown): TeamSkillCatalogItem {
  const record = requireRecord(value, 'catalog item')
  return Object.freeze({
    skillId: requireString(record.skill_id, 'catalog item skill_id'),
    displayName: requireString(record.display_name, 'catalog item display_name'),
    runtimeName: requireString(record.runtime_name, 'catalog item runtime_name'),
    summary: requireString(record.summary, 'catalog item summary'),
    version: requireString(record.version, 'catalog item version'),
    category: requireString(record.category, 'catalog item category'),
    tags: Object.freeze(requireArray(record.tags, 'catalog item tags').map(tag => requireString(tag, 'catalog item tag'))),
    publishedAt: requireString(record.published_at, 'catalog item published_at'),
  })
}

function parseAuthorizedOperation(value: unknown): TeamSkillAuthorizedOperation {
  const record = requireRecord(value, 'installation authorization')
  const artifact = requireRecord(record.artifact, 'installation artifact')
  const files = requireArray(artifact.files, 'artifact files').map((file): TeamSkillFileDigest => {
    const entry = requireRecord(file, 'artifact file')
    return Object.freeze({
      path: requireString(entry.path, 'artifact file path'),
      sha256: requireString(entry.sha256, 'artifact file sha256'),
    })
  })
  return Object.freeze({
    operationId: requireString(record.operation_id, 'operation_id'),
    skillId: requireString(record.skill_id, 'skill_id'),
    runtimeName: requireString(record.runtime_name, 'runtime_name'),
    version: requireString(record.version, 'version'),
    artifact: Object.freeze({
      downloadUrl: requireString(artifact.download_url, 'artifact download_url'),
      expiresAt: requireString(artifact.expires_at, 'artifact expires_at'),
      sha256: requireString(artifact.sha256, 'artifact sha256'),
      sizeBytes: requireNumber(artifact.size_bytes, 'artifact size_bytes'),
      files: Object.freeze(files),
    }),
  })
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = recordOf(value)
  if (record === undefined) throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', `AI Coding service returned an invalid ${field}.`)
  return record
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', `AI Coding service returned invalid ${field}.`)
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', `AI Coding service returned invalid ${field}.`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, field)
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TeamSkillHttpError('SERVICE_PROTOCOL_ERROR', `AI Coding service returned invalid ${field}.`)
  }
  return value
}
