/** Host orchestration for cloud workspaces: snapshots first, SSE resync, stable errors. */

import { randomUUID } from 'node:crypto'
import {
  WorkspaceHttpClient,
  WorkspaceHttpError,
  parseAgentProfile,
  parseAgentType,
  parseAgentTypeSchema,
  parsePage,
  parseCodeSource,
  parseChanges,
  parseDirectory,
  parseFileContent,
  parsePreview,
  parsePreviewUrlGrant,
  parsePullRequestResult,
  parseRevisionResult,
  parseRun,
  parseStreamEventData,
  parseWorkspace,
} from './workspace-http.ts'
import type { PreviewUrlPolicy, SseFrame, SseProtocolViolation, WorkspaceRequestOptions } from './workspace-http.ts'
import type {
  AgentProfileSummary,
  AgentTypeSchema,
  AgentRunSnapshot,
  AgentTypeSummary,
  CloudWorkspace,
  WorkspaceChanges,
  WorkspaceCodeSource,
  WorkspaceDirectory,
  WorkspaceFailure,
  WorkspaceFileContent,
  WorkspacePreview,
  WorkspacePreviewUrlGrant,
  WorkspaceQueryResult,
  WorkspaceStreamEvent,
  WorkspaceStreamEvents,
  WorkspaceStreamState,
  WorkspaceStreamSubscription as WorkspaceStreamSubscriptionHandle,
} from './workspace-types.ts'

/**
 * The credential a Host call was issued under.
 *
 * `identity` is an opaque, non-secret digest of the stored grant. It exists so
 * an in-flight request can prove, at the moment its 401 arrives, that the
 * credential it failed with is still the credential in the store. Carrying the
 * raw token here would put a secret into comparison state that can reach a log;
 * a digest compares the same way without being replayable.
 */
export interface WorkspaceSessionHandle {
  readonly accessToken: string
  readonly identity: string
}

/** Session access used for credential isolation; the Host never stores tokens itself. */
export interface WorkspaceSessionProvider {
  /** Reads the current account credential and the identity of the record it came from. */
  read(): Promise<WorkspaceSessionHandle | undefined>
  /**
   * Clears the stored session after an authorization failure, but only while
   * `identity` still describes the credential in the store.
   *
   * A request issued under account A can answer 401 after the user signed in as
   * account B. Clearing unconditionally would sign B out with A's failure. The
   * decision reads the store itself rather than trusting the caller's snapshot,
   * so the comparison happens against the credential that is actually there.
   * @param identity - Identity read together with the token that failed.
   * @returns true when this call actually cleared the stored credential.
   */
  clear(identity: string): Promise<boolean>
}

/** Cloud workspace Host wiring; every field is deployment- or test-supplied. */
export interface WorkspaceHostOptions {
  /**
   * Cloud workspace service endpoint; `/v1` and a trailing slash are optional —
   * the client normalizes to exactly one `/v1`. Absent/blank produces `not-ready`;
   * malformed produces an explicit `INVALID_CONFIGURATION` failure.
   */
  readonly apiBaseUrl?: string
  readonly session: WorkspaceSessionProvider
  readonly fetch?: typeof globalThis.fetch
  /** Idempotency key generator for write operations; one key per logical operation. */
  readonly idempotencyKey?: () => string
  /** Reconnect backoff for the SSE loop; defaults to a short fixture-friendly delay. */
  readonly reconnectDelayMs?: (attempt: number) => number
  /**
   * Origins a preview URL grant may point at. The default is empty: with nothing
   * allowlisted every grant is refused rather than opening an arbitrary origin.
   */
  readonly previewOrigins?: readonly string[]
  /** Injectable clock for grant expiry checks; defaults to the wall clock. */
  readonly now?: () => number
  /** How many consumed events one subscription keeps replayable for its consumer. */
  readonly eventBufferLimit?: number
}

/** Scope of one SSE subscription plus the resync handoff. */
export interface WorkspaceStreamScope {
  readonly projectId?: string
  readonly workspaceId?: string
  readonly runId?: string
  /** Watermark from the REST snapshot taken before the first connect. */
  readonly lastEventId?: string
  /** Invoked on `resync_required` before the Host resubscribes without a watermark. */
  readonly resync?: () => Promise<void>
}

/** User input for workspace creation; ids are opaque server identifiers. */
export interface CreateWorkspaceInput {
  readonly projectId: string
  readonly repositoryId: string
  readonly branch: string
  readonly agentProfileVersionId: string
  readonly displayName?: string
}

/** User input for run creation; the server snapshots the configuration. */
export interface CreateRunInput {
  readonly workspaceId: string
  readonly sessionId: string
  readonly writeMode: 'read_only' | 'write'
  readonly expectedWorkspaceRevision: number
  readonly agentProfileVersionId?: string
}

/** How many consumed SSE events stay replayable for a browser consumer. */
const EVENT_BUFFER_LIMIT = 256

const READY = <T>(value: T, fixtureOnly: boolean): WorkspaceQueryResult<T> => ({ status: 'ready', value, fixtureOnly })

/**
 * Reads the `items` array of one list payload.
 *
 * A list response that is missing `items`, or carries something other than an
 * array there, is protocol drift. Casting and calling `.map` would raise a
 * `TypeError` outside the failure mapping and reach the caller as an unhandled
 * rejection, which is exactly the difference between "the service answered
 * wrong" and "the workbench is broken".
 */
function listItems(payload: unknown, field: string): readonly unknown[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be an object.`)
  }
  const items = (payload as { items?: unknown }).items
  if (!Array.isArray(items)) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be an array.`)
  }
  return items
}


/**
 * The one captured request an authorized query may issue. It unwraps the client's
 * payload and records the service's provenance so the query result can carry it.
 */
interface WorkspaceRequester {
  request(path: string, options: WorkspaceRequestOptions, accessToken: string): Promise<unknown>
}
const SIGNED_OUT = { status: 'signed-out' } as const
const notReady = (missing: readonly string[]): WorkspaceQueryResult<never> => ({ status: 'not-ready', missing })
const failure = (code: string, message: string): WorkspaceFailure => ({ status: 'failed', code, message })

function errorToFailure(error: unknown): WorkspaceFailure {
  if (error instanceof WorkspaceHttpError) return failure(error.code, error.message)
  if (error instanceof Error && error.name === 'AbortError') return failure('OPERATION_CANCELED', '请求已取消')
  return failure('LOCAL_OPERATION_FAILED', error instanceof Error ? error.message : '本地操作失败')
}

/**
 * 分页游走的页数上限：只是失控保护，不是产品限制。
 *
 * 达到上限意味着「不知道服务端还有没有下一页」，因此必须显式失败——
 * 返回一个恰好到这里为止的列表会让调用方把截断当成完整结果。
 */
const PAGE_WALK_LIMIT = 1000

/**
 * 按不透明游标游走分页，直到服务端声明耗尽（`nextCursor` 为 null）。
 *
 * 两种无法收敛的情形都必须显式失败，不允许返回部分列表冒充完整结果：
 * 服务端重复给出已消费过的游标（循环）→ `SERVICE_PROTOCOL_ERROR`；
 * 页数达到 `PAGE_WALK_LIMIT`（1000）→ `PAGINATION_LIMIT`。
 *
 * 该上限只是**失控保护，不是产品限制**：正常规模不会触达；一旦触达就意味着
 * 「不知道服务端还有没有下一页」，因此只能失败，不能当成读完。
 */
async function walkPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ readonly items: readonly T[]; readonly nextCursor: string | null }>,
): Promise<readonly T[]> {
  const all: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; ; page += 1) {
    if (page >= PAGE_WALK_LIMIT) {
      throw new WorkspaceHttpError('PAGINATION_LIMIT', `分页超过实现上限 ${String(PAGE_WALK_LIMIT)} 页，结果不完整`)
    }
    const pageResult = await fetchPage(cursor)
    all.push(...pageResult.items)
    const next = pageResult.nextCursor
    if (next === null) return Object.freeze(all)
    if (seen.has(next)) {
      throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `服务端重复返回游标，分页无法收敛：${next}`)
    }
    seen.add(next)
    cursor = next
  }
}

/**
 * Host-side cloud workspace orchestrator. Reads REST snapshots before streaming,
 * keeps one SSE subscription alive with watermark reconnects, maps 401 to
 * signed-out by clearing credentials, and surfaces stable service error codes
 * without inventing local success states.
 */
export class WorkspaceHost {
  private readonly fetcher: typeof globalThis.fetch
  private readonly idempotencyKey: () => string
  private readonly reconnectDelay: (attempt: number) => number
  private readonly previewOrigins: readonly string[]
  private readonly now: () => number
  private readonly eventBufferLimit: number
  private client: WorkspaceHttpClient | undefined
  private disposed = false
  /** Every live subscription, keyed by its opaque owner handle. */
  private readonly subscriptions = new Map<string, StreamSubscription>()
  private readonly eventListeners = new Set<(subscriptionId: string, event: WorkspaceStreamEvent) => void>()
  private readonly stateListeners = new Set<(subscriptionId: string, state: WorkspaceStreamState) => void>()

  constructor(private readonly options: WorkspaceHostOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.idempotencyKey = options.idempotencyKey ?? randomUUID
    this.reconnectDelay = options.reconnectDelayMs ?? (attempt => Math.min(250 * attempt, 2000))
    this.previewOrigins = options.previewOrigins ?? []
    this.now = options.now ?? Date.now
    this.eventBufferLimit = options.eventBufferLimit ?? EVENT_BUFFER_LIMIT
  }

  /** Deployment allowlist a preview grant is validated against; empty means default-deny. */
  private previewPolicy(workspaceId: string): PreviewUrlPolicy {
    return { allowedOrigins: this.previewOrigins, workspaceId, now: this.now }
  }

  private async resolve(): Promise<
    { readonly kind: 'ready'; readonly client: WorkspaceHttpClient; readonly session: WorkspaceSessionHandle } |
    { readonly kind: 'signed-out' } |
    { readonly kind: 'not-ready'; readonly missing: readonly string[] } |
    { readonly kind: 'invalid-configuration'; readonly message: string }
  > {
    if (this.options.apiBaseUrl === undefined || this.options.apiBaseUrl.trim().length === 0) {
      return { kind: 'not-ready', missing: ['apiBaseUrl'] }
    }
    if (this.client === undefined) {
      try {
        this.client = new WorkspaceHttpClient(this.options.apiBaseUrl, this.fetcher)
      } catch (error) {
        // A malformed apiBaseUrl is a deployment error: it surfaces here rather than
        // being rewritten into a request against a wrong host.
        return {
          kind: 'invalid-configuration',
          message: error instanceof Error ? error.message : 'Cloud workspace apiBaseUrl is invalid.',
        }
      }
    }
    const session = await this.options.session.read()
    if (session === undefined || session.accessToken.length === 0) return { kind: 'signed-out' }
    return { kind: 'ready', client: this.client, session }
  }

  /**
   * Signs the account out after an authorization failure, but only while the
   * credential that failed is still the stored one.
   *
   * The identity travels with the request that failed; the store is re-read
   * inside `clear`, so a 401 from a request issued under a previous account
   * cannot delete the account that replaced it.
   * @param identity - Identity of the credential the failed request used.
   * @returns true when the stored credential was actually cleared.
   */
  private async clearFailedCredential(identity: string): Promise<boolean> {
    try {
      return await this.options.session.clear(identity)
    } catch {
      // An unreadable or unwritable credential store is not an identity: report
      // "not cleared" rather than raising out of a request path.
      return false
    }
  }

  /** Runs one authorized request, mapping 401 to session clearing and signed-out. */
  private async authorizedQuery<T>(
    run: (client: WorkspaceRequester, accessToken: string) => Promise<T>,
  ): Promise<WorkspaceQueryResult<T>> {
    const resolved = await this.resolve()
    if (resolved.kind === 'signed-out') return SIGNED_OUT
    if (resolved.kind === 'not-ready') return notReady(resolved.missing)
    if (resolved.kind === 'invalid-configuration') return failure('INVALID_CONFIGURATION', resolved.message)
    // Provenance is captured per call, not read off the shared client, so
    // concurrent queries cannot observe each other's responses.
    let fixtureOnly = false
    const requester: WorkspaceRequester = {
      request: async (path, options, accessToken) => {
        const response = await resolved.client.request(path, options, accessToken)
        if (response.fixtureOnly) fixtureOnly = true
        return response.value
      },
    }
    try {
      return READY(await run(requester, resolved.session.accessToken), fixtureOnly)
    } catch (error) {
      if (error instanceof WorkspaceHttpError && (error.code === 'AUTH_REQUIRED' || error.code === 'TOKEN_EXPIRED')) {
        // The identity is the one this very request used; a late 401 from an
        // older account therefore cannot clear the current one.
        await this.clearFailedCredential(resolved.session.identity)
        return SIGNED_OUT
      }
      return errorToFailure(error)
    }
  }

  private async authorizedWrite<T>(
    path: string,
    body: Record<string, unknown>,
    run: (data: unknown) => T,
  ): Promise<WorkspaceQueryResult<T>> {
    return this.authorizedQuery((client, accessToken) =>
      client.request(path, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': this.idempotencyKey() },
      }, accessToken).then(run),
    )
  }

  // --- queries ---------------------------------------------------------------

  /**
   * Lists the agent executor types with their server-declared readiness.
   * @returns the query result with agent type summaries.
   */
  agentTypes(): Promise<WorkspaceQueryResult<readonly AgentTypeSummary[]>> {
    return this.authorizedQuery((client, accessToken) =>
      walkPages(async cursor =>
        parsePage(
          await client.request(`/v1/me/agent-types${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, {}, accessToken),
          parseAgentType,
          'agent types',
        ),
      ),
    )
  }

  /**
   * Lists published agent profile versions usable for one project.
   * @param projectId - Opaque project id.
   * @returns the query result with profile summaries.
   */
  agentProfiles(projectId: string): Promise<WorkspaceQueryResult<readonly AgentProfileSummary[]>> {
    return this.authorizedQuery((client, accessToken) =>
      // 游标只透传：逐页拉取直到服务端声明耗尽（next_cursor 缺省/null）。
      walkPages(async cursor =>
        parsePage(
          await client.request(
            `/v1/me/agent-profiles?project_id=${encodeURIComponent(projectId)}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
            {},
            accessToken,
          ),
          parseAgentProfile,
          'agent profiles',
        ),
      ),
    )
  }

  /**
   * Reads one published agent profile version.
   * @param versionId - Opaque profile version id.
   * @returns the query result with the profile summary.
   */
  agentProfileVersion(versionId: string): Promise<WorkspaceQueryResult<AgentProfileSummary>> {
    return this.authorizedQuery(async (client, accessToken) =>
      parseAgentProfile(await client.request(`/v1/me/agent-profiles/${encodeURIComponent(versionId)}`, {}, accessToken)),
    )
  }

  /**
   * Reads the user-side schema of one agent type.
   * @param agentTypeId - Opaque agent type id.
   * @returns the query result with the strictly parsed schema.
   */
  agentTypeSchema(agentTypeId: string): Promise<WorkspaceQueryResult<AgentTypeSchema>> {
    return this.authorizedQuery(async (client, accessToken) =>
      parseAgentTypeSchema(await client.request(`/v1/me/agent-types/${encodeURIComponent(agentTypeId)}/schema`, {}, accessToken)),
    )
  }

  /**
   * Lists the project repositories the account may start a workspace from.
   * @param projectId - Opaque project id.
   * @returns the query result with the authorized code sources.
   */
  codeSources(projectId: string): Promise<WorkspaceQueryResult<readonly WorkspaceCodeSource[]>> {
    return this.authorizedQuery(async (client, accessToken) => {
      const payload = await client.request(`/v1/me/code-sources?project_id=${encodeURIComponent(projectId)}`, {}, accessToken)
      return Object.freeze(listItems(payload, 'code sources items').map(parseCodeSource))
    })
  }

  /**
   * Lists the project workspaces the account may use.
   * @param projectId - Opaque project id.
   * @returns the query result with workspace snapshots.
   */
  workspaces(projectId: string): Promise<WorkspaceQueryResult<readonly CloudWorkspace[]>> {
    return this.authorizedQuery(async (client, accessToken) => {
      const payload = await client.request(`/v1/projects/${encodeURIComponent(projectId)}/workspaces`, {}, accessToken)
      return Object.freeze(listItems(payload, 'workspaces items').map(parseWorkspace))
    })
  }

  /**
   * Reads one workspace snapshot.
   * @param workspaceId - Opaque workspace id.
   * @returns the query result with the snapshot.
   */
  workspace(workspaceId: string): Promise<WorkspaceQueryResult<CloudWorkspace>> {
    return this.authorizedQuery(async (client, accessToken) =>
      parseWorkspace(await client.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}`, {}, accessToken)),
    )
  }

  /**
   * Lists one workspace directory.
   * @param workspaceId - Opaque workspace id.
   * @param path - Workspace-relative directory path.
   * @returns the query result with the listing.
   */
  workspaceFiles(workspaceId: string, path = ''): Promise<WorkspaceQueryResult<WorkspaceDirectory>> {
    return this.authorizedQuery(async (client, accessToken) =>
      parseDirectory(await client.request(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`,
        {},
        accessToken,
      )),
    )
  }

  /**
   * Reads one workspace file's restricted content.
   * @param workspaceId - Opaque workspace id.
   * @param path - Workspace-relative file path.
   * @returns the query result with the content.
   */
  workspaceFileContent(workspaceId: string, path: string): Promise<WorkspaceQueryResult<WorkspaceFileContent>> {
    return this.authorizedQuery(async (client, accessToken) =>
      parseFileContent(await client.request(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        {},
        accessToken,
      )),
    )
  }

  /**
   * Reads the change set against its baseline.
   * @param workspaceId - Opaque workspace id.
   * @returns the query result with the changes.
   */
  workspaceChanges(workspaceId: string): Promise<WorkspaceQueryResult<WorkspaceChanges>> {
    return this.authorizedQuery(async (client, accessToken) => {
      const changes = parseChanges(await client.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/changes`, {}, accessToken))
      if (changes.workspaceId !== workspaceId) {
        // A change set that belongs to another workspace is wire drift, not data.
        throw new WorkspaceHttpError(
          'SERVICE_PROTOCOL_ERROR',
          `Cloud workspace changes belong to ${changes.workspaceId}, not ${workspaceId}.`,
        )
      }
      return changes
    })
  }

  /**
   * Reads one server-authorized preview.
   * @param workspaceId - Opaque workspace id.
   * @param path - Workspace-relative file path.
   * @param mode - Optional diff mode for changed files.
   * @returns the query result with the preview.
   */
  workspacePreview(workspaceId: string, path: string, mode?: 'diff'): Promise<WorkspaceQueryResult<WorkspacePreview>> {
    return this.authorizedQuery(async (client, accessToken) =>
      parsePreview(await client.request(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/preview?path=${encodeURIComponent(path)}${mode === undefined ? '' : `&mode=${mode}`}`,
        {},
        accessToken,
      )),
    )
  }

  // --- writes ----------------------------------------------------------------

  /**
   * Creates a workspace; the service returns its provisioning state.
   * @param input - Project, repository, branch, and published profile version.
   * @returns the query result with the created snapshot.
   */
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceQueryResult<CloudWorkspace>> {
    return this.authorizedWrite(
      `/v1/projects/${encodeURIComponent(input.projectId)}/workspaces`,
      {
        repository_id: input.repositoryId,
        branch: input.branch,
        agent_profile_version_id: input.agentProfileVersionId,
        ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
      },
      parseWorkspace,
    )
  }

  /**
   * Runs one lifecycle operation.
   * @param workspaceId - Opaque workspace id.
   * @param action - Start, stop, retry, or archive.
   * @param expectedRevision - Optimistic revision guard.
   * @returns the query result with the updated snapshot.
   */
  workspaceAction(
    workspaceId: string,
    action: 'start' | 'stop' | 'retry' | 'archive',
    expectedRevision?: number,
  ): Promise<WorkspaceQueryResult<CloudWorkspace>> {
    return this.authorizedWrite(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}:${action}`,
      expectedRevision === undefined ? {} : { expected_workspace_revision: expectedRevision },
      parseWorkspace,
    )
  }

  /**
   * Deletes a stopped or archived workspace under its deletion policy.
   * @param workspaceId - Opaque workspace id.
   * @param expectedRevision - Optimistic revision guard.
   * @returns the query result with the final snapshot.
   */
  deleteWorkspace(workspaceId: string, expectedRevision: number): Promise<WorkspaceQueryResult<CloudWorkspace>> {
    return this.authorizedQuery(async (client, accessToken) =>
      parseWorkspace(await client.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: 'DELETE',
        body: { expected_workspace_revision: expectedRevision },
        headers: { 'idempotency-key': this.idempotencyKey() },
      }, accessToken)),
    )
  }

  /**
   * Discards the change set at a revision.
   * @param workspaceId - Opaque workspace id.
   * @param expectedRevision - Revision the caller observed.
   * @returns the query result with the new revision.
   */
  discardChanges(workspaceId: string, expectedRevision: number): Promise<WorkspaceQueryResult<{ readonly revision: number }>> {
    return this.authorizedWrite(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/changes:discard`,
      { expected_workspace_revision: expectedRevision },
      parseRevisionResult,
    )
  }

  /**
   * Commits the change set at a revision.
   * @param workspaceId - Opaque workspace id.
   * @param message - User-supplied commit message.
   * @param expectedRevision - Revision the caller observed.
   * @returns the query result with the new revision.
   */
  gitCommit(workspaceId: string, message: string, expectedRevision: number): Promise<WorkspaceQueryResult<{ readonly revision: number }>> {
    return this.authorizedWrite(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/git/commit`,
      { message, expected_workspace_revision: expectedRevision },
      parseRevisionResult,
    )
  }

  /**
   * Requests a pull request for the workspace changes.
   * @param workspaceId - Opaque workspace id.
   * @param title - User-supplied PR title.
   * @param expectedRevision - Revision the caller observed.
   * @returns the query result with the pull request id.
   */
  createPullRequest(
    workspaceId: string,
    title: string,
    expectedRevision: number,
  ): Promise<WorkspaceQueryResult<{ readonly pullRequestId: string }>> {
    return this.authorizedWrite(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/git/pull-request`,
      { title, expected_workspace_revision: expectedRevision },
      parsePullRequestResult,
    )
  }

  /**
   * Issues a short-lived web app preview URL.
   * @param workspaceId - Opaque workspace id.
   * @param appPort - The single allowlisted app port.
   * @returns the query result with the URL grant.
   */
  issuePreviewUrl(workspaceId: string, appPort: number): Promise<WorkspaceQueryResult<WorkspacePreviewUrlGrant>> {
    return this.authorizedWrite(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/preview-url`,
      { app: 'workspace_app', port: appPort },
      value => parsePreviewUrlGrant(value, this.previewPolicy(workspaceId)),
    )
  }

  /**
   * Creates a run with an immutable configuration snapshot.
   * @param input - Workspace, Session binding, write mode, and revision guard.
   * @returns the query result with the run snapshot.
   */
  createRun(input: CreateRunInput): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.authorizedWrite(
      `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/runs`,
      {
        session_id: input.sessionId,
        write_mode: input.writeMode,
        expected_workspace_revision: input.expectedWorkspaceRevision,
        ...(input.agentProfileVersionId === undefined ? {} : { agent_profile_version_id: input.agentProfileVersionId }),
      },
      parseRun,
    )
  }

  /**
   * Reads one run snapshot.
   * @param runId - Opaque run id.
   * @returns the query result with the run snapshot.
   */
  run(runId: string): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.authorizedQuery(async (client, accessToken) =>
      parseRun(await client.request(`/v1/runs/${encodeURIComponent(runId)}`, {}, accessToken)),
    )
  }

  /**
   * Lists the workspace runs.
   * @param workspaceId - Opaque workspace id.
   * @returns the query result with run snapshots.
   */
  workspaceRuns(workspaceId: string): Promise<WorkspaceQueryResult<readonly AgentRunSnapshot[]>> {
    return this.authorizedQuery(async (client, accessToken) => {
      const payload = await client.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/runs`, {}, accessToken)
      return Object.freeze(listItems(payload, 'runs items').map(parseRun))
    })
  }

  /**
   * Cancels one active run; the record stays.
   * @param runId - Opaque run id.
   * @returns the query result with the updated snapshot.
   */
  cancelRun(runId: string): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.authorizedWrite(`/v1/runs/${encodeURIComponent(runId)}:cancel`, {}, parseRun)
  }

  /**
   * Creates a new run linked to the original.
   * @param runId - Opaque id of the retried run.
   * @param expectedWorkspaceRevision - Current workspace revision.
   * @returns the query result with the new run snapshot.
   */
  retryRun(runId: string, expectedWorkspaceRevision: number): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.authorizedWrite(
      `/v1/runs/${encodeURIComponent(runId)}:retry`,
      { expected_workspace_revision: expectedWorkspaceRevision },
      parseRun,
    )
  }

  // --- SSE stream ------------------------------------------------------------

  /**
   * Starts one owned SSE subscription.
   *
   * The Host keeps a connection, a replay window and a cursor per subscription,
   * so ownership is explicit: a caller receives an opaque id and every later
   * read or release names that id. Two workbenches therefore never share a
   * teardown path, and a client that stops its own stream cannot stop another
   * client's.
   * @param scope - Project/workspace/run scope, snapshot watermark, and resync handoff.
   * @returns the opaque subscription id and the state observed at start.
   */
  startStream(scope: WorkspaceStreamScope): WorkspaceStreamSubscriptionHandle {
    const subscription: StreamSubscription = {
      id: randomUUID(),
      scope,
      abort: new AbortController(),
      generation: 0,
      state: { status: 'idle' },
      buffer: [],
      appliedRevisions: new Map(),
      seenEventIds: new Set(),
      cursor: scope.lastEventId ?? '',
    }
    if (this.disposed) {
      subscription.state = { status: 'stopped' }
      return { subscriptionId: subscription.id, state: subscription.state }
    }
    this.subscriptions.set(subscription.id, subscription)
    void this.streamLoop(subscription, 0)
    return { subscriptionId: subscription.id, state: subscription.state }
  }

  /**
   * Releases one owned subscription, or every subscription this Host owns.
   *
   * Releasing detaches the connection, aborts its backoff timer, and drops the
   * replay window, applied revisions and cursor — a released subscription has
   * no readable history left, so a stale consumer cannot keep rendering old
   * account or project events.
   * @param subscriptionId - The owned handle; omitted releases every subscription.
   */
  stopStream(subscriptionId?: string): void {
    const targets = subscriptionId === undefined ? [...this.subscriptions.keys()] : [subscriptionId]
    for (const id of targets) {
      const subscription = this.subscriptions.get(id)
      if (subscription === undefined) continue
      this.subscriptions.delete(id)
      subscription.generation += 1
      subscription.abort.abort()
      subscription.buffer.length = 0
      subscription.appliedRevisions.clear()
      subscription.seenEventIds.clear()
      subscription.cursor = ''
      this.setState(subscription, { status: 'idle' })
    }
  }

  /**
   * Releases every subscription and every listener.
   *
   * This is the Cordis-unload path: after it runs the Host holds no socket, no
   * pending backoff timer and no replay window, so unmounting the plugin leaves
   * nothing behind.
   */
  dispose(): void {
    this.disposed = true
    this.stopStream()
    this.eventListeners.clear()
    this.stateListeners.clear()
  }

  /**
   * Reports the live SSE connection state.
   * @param subscriptionId - The owned handle; omitted reports the first subscription.
   * @returns the current stream state, or idle when nothing is subscribed.
   */
  streamState(subscriptionId?: string): WorkspaceStreamState {
    if (subscriptionId !== undefined) return this.subscriptions.get(subscriptionId)?.state ?? { status: 'idle' }
    const first = this.subscriptions.values().next().value
    return first?.state ?? { status: 'idle' }
  }

  /**
   * Subscribes to stream events.
   * @param listener - Called with the owning subscription id for every parsed event.
   * @returns the disposer.
   */
  onStreamEvent(listener: (subscriptionId: string, event: WorkspaceStreamEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /**
   * Subscribes to stream state transitions.
   * @param listener - Called with the owning subscription id for every state change.
   * @returns the disposer.
   */
  onStreamStateChange(listener: (subscriptionId: string, state: WorkspaceStreamState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  private setState(subscription: StreamSubscription, state: WorkspaceStreamState): void {
    subscription.state = state
    for (const listener of this.stateListeners) listener(subscription.id, state)
  }

  private emit(subscription: StreamSubscription, event: WorkspaceStreamEvent): void {
    subscription.buffer.push(event)
    if (subscription.buffer.length > this.eventBufferLimit) {
      subscription.buffer.splice(0, subscription.buffer.length - this.eventBufferLimit)
    }
    for (const listener of this.eventListeners) listener(subscription.id, event)
  }

  /** Remembers an applied event id, keeping the duplicate guard bounded. */
  private remember(subscription: StreamSubscription, eventId: string): void {
    subscription.seenEventIds.add(eventId)
    if (subscription.seenEventIds.size <= this.eventBufferLimit) return
    const oldest = subscription.seenEventIds.values().next().value
    if (oldest !== undefined) subscription.seenEventIds.delete(oldest)
  }

  /**
   * Decides whether one event advances this subscription.
   *
   * `eventId` is opaque — the service documents it as `evt_opaque_id` and
   * promises no lexical contract — so it is used only as a replay cursor and as
   * an exact-duplicate guard, never as an ordering key. Ordering is decided per
   * resource by `revision`, which the service owns: the same revision on two
   * resources is two independent facts, while a revision at or below the one
   * already applied for a resource is state the consumer has seen and must not
   * be replayed as progress.
   * @param subscription - The subscription the event arrived on.
   * @param event - Parsed stream event.
   * @returns true when the event is new progress and should be delivered.
   */
  private accept(subscription: StreamSubscription, event: WorkspaceStreamEvent): boolean {
    if (subscription.seenEventIds.has(event.eventId)) return false
    this.remember(subscription, event.eventId)
    const key = `${event.resourceType}:${event.resourceId}`
    const applied = subscription.appliedRevisions.get(key)
    if (applied !== undefined && event.revision <= applied) return false
    subscription.appliedRevisions.set(key, event.revision)
    subscription.cursor = event.eventId
    return true
  }

  /**
   * Observes the events the SSE loop has consumed after a watermark.
   *
   * This is the Remote-side event channel: without it a browser consumer could only
   * poll `streamState()` and could never act on the concrete `workspace`/`run`/
   * `changes`/`file` events the checklist requires the UI to react to. When the
   * requested watermark has fallen outside the retained window the caller must
   * reconcile from a fresh snapshot instead, so a truncation is reported explicitly
   * rather than silently returning a partial event list.
   * @param afterEventId - Watermark the caller has already applied; `''` means none.
   * @param subscriptionId - The owned handle; omitted reads every live subscription.
   * @returns the events after the watermark, oldest first, plus the truncation flag.
   */
  streamEventsAfter(afterEventId: string, subscriptionId?: string): WorkspaceStreamEvents {
    const windows = subscriptionId === undefined
      ? [...this.subscriptions.values()]
      : [...this.subscriptions.values()].filter(subscription => subscription.id === subscriptionId)
    const events: WorkspaceStreamEvent[] = []
    let truncated = false
    for (const subscription of windows) {
      if (afterEventId === '') {
        events.push(...subscription.buffer)
        continue
      }
      const index = subscription.buffer.findIndex(event => event.eventId === afterEventId)
      if (index === -1) {
        // The watermark is not in this window. With events still retained the
        // caller is missing an unknown prefix of them; reporting that as a
        // partial list would let it render an incomplete view as current.
        if (subscription.buffer.length > 0) truncated = true
        events.push(...subscription.buffer)
        continue
      }
      events.push(...subscription.buffer.slice(index + 1))
    }
    return {
      events: Object.freeze(events.map(event => Object.freeze({
        eventId: event.eventId,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        revision: event.revision,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        payloadJson: JSON.stringify(event.payload),
      }))),
      truncated,
    }
  }

  /** Builds the replay query for one subscription from its own cursor. */
  private streamQuery(subscription: StreamSubscription): string {
    const scope = subscription.scope
    return `?${[
      scope.projectId === undefined ? null : `project_id=${encodeURIComponent(scope.projectId)}`,
      scope.workspaceId === undefined ? null : `workspace_id=${encodeURIComponent(scope.workspaceId)}`,
      scope.runId === undefined ? null : `run_id=${encodeURIComponent(scope.runId)}`,
      `after=${encodeURIComponent(subscription.cursor)}`,
    ].filter(part => part !== null).join('&')}`
  }

  /**
   * Applies the authoritative snapshot the scope declared.
   *
   * The result is not discarded: a snapshot that cannot be re-read means the
   * replay window may have holes, so the caller is told instead of being left
   * with a stream that claims to be live.
   */
  /**
   * Whether one subscription is still the live record for its id.
   *
   * Releasing a subscription removes it and bumps its generation, so membership
   * is the whole answer: a loop that wakes up after that stops without touching
   * a record its consumer can no longer reach.
   */
  private isLive(subscription: StreamSubscription): boolean {
    return this.subscriptions.get(subscription.id) === subscription
  }

  private async resync(
    subscription: StreamSubscription,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }> {
    const resync = subscription.scope.resync
    if (resync === undefined) return { ok: true }
    try {
      await resync()
      return { ok: true }
    } catch (error) {
      const outcome = errorToFailure(error)
      return { ok: false, code: outcome.code, message: outcome.message }
    }
  }

  private async streamLoop(subscription: StreamSubscription, initialAttempt: number): Promise<void> {
    let attempt = initialAttempt
    for (;;) {
      if (!this.isLive(subscription)) return
      const generation = subscription.generation
      const resolved = await this.resolve()
      if (generation !== subscription.generation || !this.isLive(subscription)) return
      if (resolved.kind !== 'ready') {
        this.setState(subscription, { status: 'stopped' })
        return
      }
      this.setState(
        subscription,
        attempt === 0 && subscription.cursor === ''
          ? { status: 'connecting' }
          : { status: 'reconnecting', attempt, lastEventId: subscription.cursor },
      )
      try {
        const stream = await resolved.client.openStream(
          this.streamQuery(subscription),
          resolved.session.accessToken,
          subscription.abort.signal,
        )
        for await (const frame of stream) {
          if (generation !== subscription.generation || !this.isLive(subscription)) return
          if (frame === 'resync_required') {
            this.setState(subscription, { status: 'resync', lastEventId: subscription.cursor })
            const outcome = await this.resync(subscription)
            if (generation !== subscription.generation || !this.isLive(subscription)) return
            if (!outcome.ok) {
              // Snapshot failed: keep the error visible and never claim live.
              this.setState(subscription, {
                status: 'stale',
                code: outcome.code,
                message: outcome.message,
                lastEventId: subscription.cursor,
              })
              attempt += 1
              break
            }
            // The snapshot is authoritative again, so the replay restarts from
            // the beginning of the service's window under fresh dedupe state.
            subscription.cursor = ''
            subscription.appliedRevisions.clear()
            subscription.seenEventIds.clear()
            attempt = 0
            break
          }
          if (frame === 'replay_done') continue
          if (isProtocolViolation(frame)) {
            this.setState(subscription, {
              status: 'stale',
              code: 'SERVICE_PROTOCOL_ERROR',
              message: frame.protocolError,
              lastEventId: subscription.cursor,
            })
            attempt += 1
            break
          }
          let event: WorkspaceStreamEvent
          try {
            event = parseStreamEventData(frame)
          } catch (error) {
            this.setState(subscription, {
              status: 'stale',
              code: 'SERVICE_PROTOCOL_ERROR',
              message: error instanceof Error ? error.message : 'Cloud workspace event stream delivered an invalid event.',
              lastEventId: subscription.cursor,
            })
            attempt += 1
            break
          }
          if (!this.accept(subscription, event)) continue
          this.setState(subscription, { status: 'live', lastEventId: subscription.cursor })
          this.emit(subscription, event)
        }
        attempt += 1
      } catch (error) {
        if (generation !== subscription.generation || subscription.abort.signal.aborted) return
        if (error instanceof WorkspaceHttpError && (error.code === 'AUTH_REQUIRED' || error.code === 'TOKEN_EXPIRED')) {
          // Same identity guard as the REST path: a late 401 from an older
          // account cannot sign the current one out.
          await this.clearFailedCredential(resolved.session.identity)
          this.setState(subscription, { status: 'stopped' })
          return
        }
        attempt += 1
      }
      if (generation !== subscription.generation || subscription.abort.signal.aborted) return
      await delay(this.reconnectDelay(attempt), subscription.abort.signal)
    }
  }
}

/** Narrows a decoded stream element to a protocol violation, if it is one. */
function isProtocolViolation(
  frame: SseFrame | 'resync_required' | 'replay_done' | SseProtocolViolation,
): frame is SseProtocolViolation {
  return typeof frame === 'object' && Object.hasOwn(frame, 'protocolError')
}

/** One owned SSE subscription: its own connection, replay window and cursor. */
interface StreamSubscription {
  readonly id: string
  readonly scope: WorkspaceStreamScope
  readonly abort: AbortController
  /** Bumped on release so an in-flight loop stops touching a released record. */
  generation: number
  state: WorkspaceStreamState
  /** Bounded replay window; only this subscription's consumer can read it. */
  readonly buffer: WorkspaceStreamEvent[]
  /** Highest applied revision per `resourceType:resourceId`. */
  readonly appliedRevisions: Map<string, number>
  /** Event ids already applied, so an exact replay is not applied twice. */
  readonly seenEventIds: Set<string>
  /** Opaque service cursor replayed as `after=`. */
  cursor: string
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
