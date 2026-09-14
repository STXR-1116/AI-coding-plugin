/**
 * Browser-safe state models for cloud workspaces. These types are the Host→UI
 * vocabulary for the cloud workspace feature and are distinct from the local
 * `WorkspaceRegistry` paths owned by `@deepseek-ai/dsh-workspace`: every resource
 * is identified by an opaque server id and carries no local filesystem location.
 */

/** Server-side workspace lifecycle states; unknown states must map to `unknown`. */
export type WorkspaceLifecycleStatus =
  | 'draft'
  | 'provisioning'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'archived'
  | 'deleting'
  | 'unknown'

/** Run states recognized by the plugin; unknown states must map to `unknown`. */
export type AgentRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'expired'
  | 'unknown'

/** A cloud workspace snapshot as returned by the service. */
export interface CloudWorkspace {
  readonly workspaceId: string
  readonly projectId: string
  readonly ownerUserId: string
  readonly repositoryId: string
  readonly branch: string
  readonly displayName: string
  readonly defaultAgentProfileVersionId: string
  readonly status: WorkspaceLifecycleStatus
  readonly revision: number
  readonly lastError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One authorized directory or file summary inside a cloud workspace. */
export interface WorkspaceFileEntry {
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly size: number
  readonly etag: string
}

/**
 * One repository the account may create a cloud workspace from.
 *
 * The list is the service's authorization answer, not a catalogue the
 * workbench may invent: a project whose repositories are not published here has
 * no creatable code source, and the create form must say so rather than picking
 * a placeholder id.
 */
export interface WorkspaceCodeSource {
  readonly repositoryId: string
  readonly name: string
  readonly provider: string
  readonly defaultBranch: string
  readonly branches: readonly string[]
}

/** One directory listing with the workspace revision it reflects. */
export interface WorkspaceDirectory {
  readonly path: string
  readonly revision: number
  readonly items: readonly WorkspaceFileEntry[]
}

/** Restricted file content; binary content arrives base64 encoded. */
export interface WorkspaceFileContent {
  readonly path: string
  readonly contentType: string
  readonly size: number
  readonly etag: string
  readonly revision: number
  readonly content?: string
  readonly contentBase64?: string
}

/** One changed file with its unified diff against the baseline. */
export interface WorkspaceChangeFile {
  readonly path: string
  readonly change: 'added' | 'modified' | 'deleted'
  readonly diff: string
}

/** The workspace change set: baseline revision, current revision, and files. */
export interface WorkspaceChanges {
  readonly workspaceId: string
  readonly baselineRevision: number
  readonly revision: number
  readonly files: readonly WorkspaceChangeFile[]
}

/** A server-authorized preview resource; static HTML carries CSP and sandbox demands. */
export interface WorkspacePreview {
  readonly path: string
  readonly revision: number
  readonly etag: string
  readonly kind: 'text' | 'markdown' | 'json' | 'image' | 'diff' | 'static_html'
  readonly contentType: string
  readonly content?: string
  readonly contentBase64?: string
  readonly diff?: string
  readonly sha256?: string
  readonly csp?: string
  readonly sandbox?: readonly string[]
}

/** A short-lived, single-workspace, single-user web app preview URL. */
export interface WorkspacePreviewUrlGrant {
  readonly url: string
  readonly expiresAt: string
  readonly workspaceId: string
}

/** Agent executor type with its server-declared readiness. */
export interface AgentTypeSummary {
  readonly agentTypeId: string
  readonly key: string
  readonly name: string
  readonly capabilities: readonly string[]
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
}

/** Server-declared execution constraints attached to one profile version. */
export interface AgentExecutionPolicy {
  readonly permission_mode?: string
  readonly tool_allowlist?: readonly string[]
  readonly max_concurrency?: number
  readonly budget?: number
  readonly timeout_ms?: number
  /** The version's declared write capability; a Run's write mode may tighten it, never widen it. */
  readonly write_mode?: 'read_only' | 'write'
}

/** One team-asset binding as the server resolved it: display metadata, never asset content. */
export interface AgentAssetBinding {
  readonly assetId: string
  readonly assetVersionId: string
  readonly name: string
  readonly required: boolean
  /** Server-assigned display position (1-based); the plugin never reorders. */
  readonly order: number
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
  readonly unavailableReason: string | null
}

/** One server-declared type-extension schema field (user-side contract). */
export interface AgentTypeSchemaField {
  readonly key: string
  readonly label: string
  readonly type: 'string' | 'number' | 'boolean' | 'enum'
  readonly required: boolean
  readonly affectsPublish: boolean
  readonly description: string | null
  readonly enum?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly default?: string | number | boolean
}

/** User-side type schema: fields, version and per-type credential semantics. */
export interface AgentTypeSchema {
  readonly agentTypeId: string
  readonly key: string
  readonly credentialRequired: boolean
  readonly schemaVersion: string
  readonly schema: readonly AgentTypeSchemaField[]
}

/** Published agent profile version selectable for one project. */
export interface AgentProfileSummary {
  readonly agentProfileId: string
  readonly agentProfileVersionId: string
  readonly name: string
  readonly description: string
  readonly versionLabel: string
  readonly changeSummary: string
  readonly agentTypeId: string
  readonly agentTypeName: string
  readonly agentTypeKey: string
  readonly agentTypeReadiness: 'ready' | 'degraded' | 'unavailable'
  readonly agentTypeCapabilities: readonly string[]
  readonly model: string
  readonly reasoning: string
  /** Ordered skill bindings; the wire order is the server's order. */
  readonly skills: readonly AgentAssetBinding[]
  readonly knowledgeBases: readonly AgentAssetBinding[]
  /** The single bound memory library, or null when the version uses none. */
  readonly memory: AgentAssetBinding | null
  readonly executionPolicy: AgentExecutionPolicy
  /** Server-defined scalar type-extension values; displayed generically, never interpreted. */
  readonly typeExtension: Readonly<Record<string, string | number | boolean>>
  /** Extension keys whose values are not scalar; the UI shows them as opaque server extensions. */
  readonly typeExtensionOpaqueKeys: readonly string[]
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
  readonly unavailableReason: string | null
  readonly default: boolean
  readonly status: 'published'
  readonly createdBy: string
  readonly publishedAt: string
  readonly updatedAt: string
}

/** One traceable, cancelable and retryable agent run with its immutable snapshot. */
export interface AgentRunSnapshot {
  readonly runId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly agentProfileVersionId: string
  readonly assetVersionIds: readonly string[]
  /** The config's execution policy frozen at run creation; later publishes never change it. */
  readonly executionPolicy: AgentExecutionPolicy
  readonly workspaceRevision: number
  readonly status: AgentRunStatus
  readonly writeMode: 'read_only' | 'write'
  readonly leaseId: string | null
  readonly revision: number
  readonly retryOfRunId?: string
  readonly errorCode: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly timeline?: readonly AgentRunTimelineEntry[]
}

/** One observed run status transition with its server timestamp. */
export interface AgentRunTimelineEntry {
  readonly status: AgentRunStatus
  readonly at: string
  readonly detail?: string
}

/** One replayable stream event; `revision` ordering is owned by the service. */
export interface WorkspaceStreamEvent {
  readonly eventId: string
  readonly resourceType: 'workspace' | 'run' | 'file' | 'changes' | 'agent_profile' | 'stream' | 'unknown'
  readonly resourceId: string
  readonly revision: number
  readonly eventType: string
  readonly occurredAt: string
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * One stream event as projected across the Remote boundary.
 *
 * The Host-side payload is arbitrary JSON; the Remote boundary rejects
 * unconstrained `unknown`, so the payload crosses as its JSON encoding and the
 * consumer decodes it only when it needs the individual fields.
 */
export interface WorkspaceProjectedStreamEvent {
  readonly eventId: string
  readonly resourceType: WorkspaceStreamEvent['resourceType']
  readonly resourceId: string
  readonly revision: number
  readonly eventType: string
  readonly occurredAt: string
  readonly payloadJson: string
}

/**
 * Events the Host consumed after a caller's watermark.
 *
 * `truncated` is true when the watermark predates the retained replay window, in
 * which case the caller must reconcile from a fresh snapshot instead of applying a
 * partial event list.
 */
export interface WorkspaceStreamEvents {
  readonly events: readonly WorkspaceProjectedStreamEvent[]
  readonly truncated: boolean
}

/** Failed query or write outcome carrying the stable service error code. */
export interface WorkspaceFailure {
  readonly status: 'failed'
  readonly code: string
  readonly message: string
}

/**
 * Query outcome union crossing the Host→UI seam; never an exception.
 *
 * A `ready` outcome carries the service's own provenance declaration for the data:
 * `fixtureOnly` is true when the response declared `x-fixture-only: true`. The UI
 * must render that as `fixture-only`, never as production success.
 */
export type WorkspaceQueryResult<T> =
  | { readonly status: 'ready'; readonly value: T; readonly fixtureOnly: boolean }
  | { readonly status: 'signed-out' }
  | { readonly status: 'not-ready'; readonly missing: readonly string[] }
  | WorkspaceFailure

/** Live SSE connection state exposed to the UI. */
export type WorkspaceStreamState =
  | { readonly status: 'idle' }
  | { readonly status: 'connecting' }
  | { readonly status: 'live'; readonly lastEventId: string }
  | { readonly status: 'reconnecting'; readonly attempt: number; readonly lastEventId: string }
  | { readonly status: 'resync'; readonly lastEventId: string }
  /**
   * The stream is connected but the authoritative snapshot could not be
   * re-read, so the replay window cannot be trusted. This is deliberately NOT
   * `live`: a failed resync must never be presented as a healthy live stream.
   */
  | { readonly status: 'stale'; readonly code: string; readonly message: string; readonly lastEventId: string }
  | { readonly status: 'stopped' }

/**
 * One caller's owned SSE subscription.
 *
 * The Host keeps a separate connection, replay window and cursor per
 * subscription, so a second client stopping its own stream can never tear down
 * a subscription another client still holds. `subscriptionId` is opaque and is
 * the only handle a client may pass back to `stopStream` / `streamEventsAfter`.
 */
export interface WorkspaceStreamSubscription {
  readonly subscriptionId: string
  readonly state: WorkspaceStreamState
}
