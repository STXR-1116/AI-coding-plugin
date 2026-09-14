/** Typed HTTP client for the cloud workspace `/v1` surface with strict response parsing. */

/**
 * Parses one user-side agent type schema payload; every field member is
 * contract-checked and unknown field types reject.
 * @param value - Raw service payload.
 * @returns the frozen schema.
 * @throws WorkspaceHttpError on any wire drift.
 */
export function parseAgentTypeSchema(value: unknown): AgentTypeSchema {
  const record = requireRecord(value, 'agent type schema')
  const fields = requireArray(record.schema, 'schema')
  return Object.freeze({
    agentTypeId: requireString(record.agent_type_id, 'agent_type_id'),
    key: requireString(record.key, 'key'),
    credentialRequired: record.credential_required === undefined
      ? false
      : requireBoolean(record.credential_required, 'credential_required'),
    schemaVersion: requireString(record.schema_version, 'schema_version'),
    schema: Object.freeze(fields.map((entry) => {
      const field = requireRecord(entry, 'schema field')
      const SCHEMA_FIELD_TYPES = ['string', 'number', 'boolean', 'enum'] as const
      const type = requireEnum(field.type, SCHEMA_FIELD_TYPES, 'field type')
      return Object.freeze({
        key: requireString(field.key, 'field key'),
        label: requireString(field.label, 'field label'),
        type,
        required: requireBoolean(field.required, 'field required'),
        affectsPublish: requireBoolean(field.affects_publish, 'field affects_publish'),
        description: field.description === undefined || field.description === null
          ? null
          : requireString(field.description, 'field description'),
        ...(field.enum === undefined ? {} : { enum: requireStringList(field.enum, 'field enum') }),
        ...(field.min === undefined ? {} : { min: requireNumber(field.min, 'field min') }),
        ...(field.max === undefined ? {} : { max: requireNumber(field.max, 'field max') }),
        ...(field.default === undefined ? {} : { default: field.default as string | number | boolean }),
      })
    })),
  })
}

import type {
  AgentAssetBinding,
  AgentTypeSchema,
  AgentExecutionPolicy,
  AgentProfileSummary,
  AgentRunSnapshot,
  AgentRunStatus,
  AgentTypeSummary,
  CloudWorkspace,
  WorkspaceChangeFile,
  WorkspaceChanges,
  WorkspaceCodeSource,
  WorkspaceDirectory,
  WorkspaceFileContent,
  WorkspaceFileEntry,
  WorkspaceLifecycleStatus,
  WorkspacePreview,
  WorkspacePreviewUrlGrant,
  WorkspaceStreamEvent,
} from './workspace-types.ts'

/** Error carrying the stable service code; `SERVICE_PROTOCOL_ERROR` covers wire drift. */
export class WorkspaceHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceHttpError'
  }
}

/** One parsed payload plus the service's own provenance declaration for it. */
export interface WorkspaceResponse<T> {
  readonly value: T
  /** True when the response declared `x-fixture-only: true`. */
  readonly fixtureOnly: boolean
}

/** One authorized JSON request description. */
export interface WorkspaceRequestOptions {
  readonly method?: string
  readonly body?: unknown
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be a non-empty string.`)
  }
  return value
}

/** Requires a string of any length: absence and non-strings reject, `''` stays a server value. */
function requireStringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be a string.`)
  }
  return value
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be a finite number.`)
  }
  return value
}

/**
 * Requires a non-negative integer.
 *
 * Revisions and byte sizes are counters, not measurements: a negative or
 * fractional value is wire drift and must not be coerced into a plausible
 * number that then silently satisfies an optimistic-concurrency guard.
 */
function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be a non-negative integer.`)
  }
  return value
}

/** Requires a JSON boolean; `1`, `'true'` and absent all reject. */
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be a boolean.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Reads a contract-optional string member without collapsing legitimate empties.
 *
 * `optionalString` answers "is there a non-empty value?", which is the wrong
 * question for a field whose contract says "absent means no value, present means
 * the server's value". An empty file, an empty diff and an empty preview body
 * are legal server values, and turning them into "absent" invents a missing
 * field. Absence and a wrong type still reject.
 */
function optionalStringValue(record: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(record, field) || record[field] === undefined) return undefined
  const value = record[field]
  if (typeof value !== 'string') {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be a string.`)
  }
  return value
}

/** Reads a contract-optional finite number member; absent stays absent, wrong types reject. */
function optionalNumberValue(record: Record<string, unknown>, field: string): number | undefined {
  if (!Object.hasOwn(record, field) || record[field] === undefined) return undefined
  return requireNumber(record[field], field)
}

/** Requires a string array with no silent element filtering. */
function requireStringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be a string array.`)
  }
  return Object.freeze((value as readonly string[]).slice())
}


function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = recordOf(value)
  if (record === undefined) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be an object.`)
  }
  return record
}

/**
 * Resolves a member of a union that explicitly declares an `unknown` member.
 * Only these three documented unions use it; everything else rejects an
 * unrecognized member rather than inventing a value.
 */
function knownOrUnknown<T extends string>(value: unknown, allowed: readonly T[], unknownMember: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : unknownMember
}

/** Requires a closed-set enum member; unknown members are wire drift, never a default. */
function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new WorkspaceHttpError(
      'SERVICE_PROTOCOL_ERROR',
      `Cloud workspace response field ${field} must be one of ${allowed.join('|')}.`,
    )
  }
  return value as T
}

/** Requires a nullable string: `null` is the documented absence, any other non-string rejects. */
function requireStringOrNull(value: unknown, field: string): string | null {
  return value === null ? null : requireString(value, field)
}

const LIFECYCLE_STATUSES: readonly WorkspaceLifecycleStatus[] = [
  'draft', 'provisioning', 'starting', 'ready', 'degraded', 'stopping', 'stopped', 'failed', 'archived', 'deleting',
]
const RUN_STATUSES: readonly AgentRunStatus[] = [
  'queued', 'starting', 'running', 'waiting_approval', 'succeeded', 'failed', 'canceled', 'expired',
]
const AGENT_READINESS: readonly AgentTypeSummary['readiness'][] = ['ready', 'degraded', 'unavailable']
const RUN_WRITE_MODES: readonly AgentRunSnapshot['writeMode'][] = ['read_only', 'write']
const FILE_ENTRY_KINDS: readonly WorkspaceFileEntry['kind'][] = ['directory', 'file']
const CHANGE_KINDS: readonly WorkspaceChangeFile['change'][] = ['added', 'modified', 'deleted']
const STREAM_RESOURCE_TYPES: readonly WorkspaceStreamEvent['resourceType'][] = [
  'workspace', 'run', 'file', 'changes', 'agent_profile', 'stream', 'unknown',
]

function lifecycleStatus(value: unknown): WorkspaceLifecycleStatus {
  return typeof value === 'string' && (LIFECYCLE_STATUSES as readonly string[]).includes(value)
    ? value as WorkspaceLifecycleStatus
    : 'unknown'
}

function runStatus(value: unknown): AgentRunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value)
    ? value as AgentRunStatus
    : 'unknown'
}

/** Parses the `{code,message,request_id,data}` success envelope; non-zero codes reject. */
async function errorOf(response: Response): Promise<WorkspaceHttpError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace service returned invalid JSON error response.')
  }
  const record = recordOf(body)
  if (record === undefined || !(typeof record.code === 'string' || typeof record.code === 'number')) {
    return new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace service returned an invalid error envelope.')
  }
  const details = recordOf(record.details)
  const missing = details === undefined ? '' : ` ${JSON.stringify(details)}`
  return new WorkspaceHttpError(
    String(record.code),
    `${typeof record.message === 'string' ? record.message : 'Cloud workspace request failed.'}${missing}`,
  )
}

/**
 * Parses one workspace snapshot DTO.
 * @param value - Raw service payload.
 * @returns the frozen workspace snapshot.
 */
export function parseWorkspace(value: unknown): CloudWorkspace {
  const record = requireRecord(value, 'workspace')
  return Object.freeze({
    workspaceId: requireString(record.workspace_id, 'workspace_id'),
    projectId: requireString(record.project_id, 'project_id'),
    ownerUserId: requireString(record.owner_user_id, 'owner_user_id'),
    repositoryId: requireString(record.repository_id, 'repository_id'),
    branch: requireString(record.branch, 'branch'),
    displayName: requireString(record.display_name, 'display_name'),
    defaultAgentProfileVersionId: requireString(record.default_agent_profile_version_id, 'default_agent_profile_version_id'),
    status: lifecycleStatus(record.status),
    revision: requireNonNegativeInteger(record.revision, 'workspace revision'),
    lastError: requireStringOrNull(record.last_error, 'last_error'),
    createdAt: requireString(record.created_at, 'created_at'),
    updatedAt: requireString(record.updated_at, 'updated_at'),
  })
}

/**
 * Parses one agent type DTO.
 * @param value - Raw service payload.
 * @returns the frozen agent type summary.
 */
export function parseAgentType(value: unknown): AgentTypeSummary {
  const record = requireRecord(value, 'agent type')
  return Object.freeze({
    agentTypeId: requireString(record.agent_type_id, 'agent_type_id'),
    key: requireString(record.key, 'agent type key'),
    name: requireString(record.name, 'agent type name'),
    capabilities: requireStringList(record.capabilities, 'capabilities'),
    readiness: requireEnum(record.readiness, AGENT_READINESS, 'readiness'),
  })
}

/**
 * Parses one repository the account may create a workspace from.
 * @param value - Raw service payload.
 * @returns the frozen code source.
 */
export function parseCodeSource(value: unknown): WorkspaceCodeSource {
  const record = requireRecord(value, 'code source')
  const branches = requireStringList(record.branches, 'code source branches')
  const defaultBranch = requireString(record.default_branch, 'code source default_branch')
  if (!branches.includes(defaultBranch)) {
    // A default branch the service did not publish as a branch is incoherent:
    // accepting it would let the create form submit a branch the list denies.
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace code source default_branch is not one of its branches.')
  }
  return Object.freeze({
    repositoryId: requireString(record.repository_id, 'repository_id'),
    name: requireString(record.name, 'code source name'),
    provider: requireString(record.provider, 'code source provider'),
    defaultBranch,
    branches,
  })
}

/**
 * Parses one team-asset binding entry.
 * @param value - Raw binding entry.
 * @param field - Field name for error messages.
 * @returns the frozen binding.
 */
function parseAgentBinding(value: unknown, field: string): AgentAssetBinding {
  const record = requireRecord(value, field)
  return Object.freeze({
    assetId: requireString(record.asset_id, `${field} asset_id`),
    assetVersionId: requireString(record.asset_version_id, `${field} asset_version_id`),
    name: requireString(record.name, `${field} name`),
    required: requireBoolean(record.required, `${field} required`),
    order: requireNonNegativeInteger(record.order, `${field} order`),
    readiness: requireEnum(record.readiness, AGENT_READINESS, `${field} readiness`),
    unavailableReason: requireStringOrNull(record.unavailable_reason, `${field} unavailable_reason`),
  })
}

/**
 * Parses one published profile DTO; non-published versions reject.
 *
 * The payload is the card's whole vocabulary: display-ready asset entries
 * (names and readiness are resolved server side), the execution policy, the
 * type-extension values and the readiness verdict. Credential material is not
 * part of this surface and is never selected into the client model.
 * @param value - Raw service payload.
 * @returns the frozen profile summary.
 */
export function parseAgentProfile(value: unknown): AgentProfileSummary {
  const record = requireRecord(value, 'agent profile')
  if (record.status !== 'published') {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace returned a non-published agent profile.')
  }
  const extension = requireRecord(record.type_extension_config, 'type_extension_config')
  // Scalar values cross as data; non-scalar values stay present as opaque keys so
  // the UI can show "server extension" without inventing or dropping a field.
  const typeExtension: Record<string, string | number | boolean> = {}
  const typeExtensionOpaqueKeys: string[] = []
  for (const [key, value] of Object.entries(extension)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') typeExtension[key] = value
    else typeExtensionOpaqueKeys.push(key)
  }
  const policy = parseExecutionPolicy(record.execution_policy)
  if (policy.write_mode !== undefined) {
    requireEnum(policy.write_mode, RUN_WRITE_MODES, 'execution_policy write_mode')
  }
  return Object.freeze({
    agentProfileId: requireString(record.agent_profile_id, 'agent_profile_id'),
    agentProfileVersionId: requireString(record.agent_profile_version_id, 'agent_profile_version_id'),
    name: requireString(record.name, 'agent profile name'),
    description: requireStringValue(record.description, 'agent profile description'),
    versionLabel: requireString(record.version_label, 'version_label'),
    changeSummary: requireStringValue(record.change_summary, 'change_summary'),
    agentTypeId: requireString(record.agent_type_id, 'agent_type_id'),
    agentTypeName: requireString(record.agent_type_name, 'agent_type_name'),
    agentTypeKey: requireString(record.agent_type_key, 'agent_type_key'),
    agentTypeReadiness: requireEnum(record.agent_type_readiness, AGENT_READINESS, 'agent_type_readiness'),
    agentTypeCapabilities: requireStringList(record.agent_type_capabilities, 'agent_type_capabilities'),
    model: requireStringValue(record.model, 'agent profile model'),
    reasoning: requireStringValue(record.reasoning, 'agent profile reasoning'),
    skills: Object.freeze(requireArray(record.skills, 'skills').map(entry => parseAgentBinding(entry, 'skill binding'))),
    knowledgeBases: Object.freeze(requireArray(record.knowledge_bases, 'knowledge_bases').map(entry => parseAgentBinding(entry, 'knowledge binding'))),
    memory: record.memory === null ? null : parseAgentBinding(record.memory, 'memory binding'),
    executionPolicy: policy,
    typeExtension: Object.freeze(typeExtension),
    typeExtensionOpaqueKeys: Object.freeze(typeExtensionOpaqueKeys),
    readiness: requireEnum(record.readiness, AGENT_READINESS, 'readiness'),
    unavailableReason: requireStringOrNull(record.unavailable_reason, 'unavailable_reason'),
    default: requireBoolean(record.default, 'agent profile default'),
    status: 'published',
    createdBy: requireString(record.created_by, 'created_by'),
    publishedAt: requireString(record.published_at, 'published_at'),
    updatedAt: requireString(record.updated_at, 'updated_at'),
  })
}

/**
 * Parses one run DTO with its immutable snapshot.
 * @param value - Raw service payload.
 * @returns the frozen run snapshot.
 */
export function parseRun(value: unknown): AgentRunSnapshot {
  const record = requireRecord(value, 'run')
  const retryOf = optionalString(record.retry_of_run_id)
  const timeline = Array.isArray(record.events)
    ? record.events.map((entry) => {
      const timelineRecord = requireRecord(entry, 'run timeline entry')
      const detail = optionalString(timelineRecord.detail)
      return Object.freeze({
        status: runStatus(timelineRecord.status),
        at: requireString(timelineRecord.at, 'timeline at'),
        ...(detail === undefined ? {} : { detail }),
      })
    })
    : undefined
  return Object.freeze({
    runId: requireString(record.run_id, 'run_id'),
    projectId: requireString(record.project_id, 'project_id'),
    workspaceId: requireString(record.workspace_id, 'workspace_id'),
    sessionId: requireString(record.session_id, 'session_id'),
    agentProfileVersionId: requireString(record.agent_profile_version_id, 'agent_profile_version_id'),
    assetVersionIds: requireStringList(record.asset_version_ids, 'asset_version_ids'),
    // A run's policy snapshot is immutable evidence: absence is wire drift, not "no policy".
    executionPolicy: parseExecutionPolicy(requireRecord(record.execution_policy, 'execution_policy')),
    workspaceRevision: requireNonNegativeInteger(record.workspace_revision, 'workspace_revision'),
    status: runStatus(record.status),
    writeMode: requireEnum(record.write_mode, RUN_WRITE_MODES, 'write_mode'),
    leaseId: requireStringOrNull(record.lease_id, 'lease_id'),
    revision: requireNonNegativeInteger(record.revision, 'run revision'),
    ...(retryOf === undefined ? {} : { retryOfRunId: retryOf }),
    errorCode: requireStringOrNull(record.error_code, 'error_code'),
    createdAt: requireString(record.created_at, 'created_at'),
    updatedAt: requireString(record.updated_at, 'updated_at'),
    ...(timeline === undefined ? {} : { timeline: Object.freeze(timeline) }),
  })
}

/**
 * Parses one directory listing.
 * @param value - Raw service payload.
 * @returns the frozen directory.
 */
export function parseDirectory(value: unknown): WorkspaceDirectory {
  const record = requireRecord(value, 'directory')
  const items = requireArray(record.items, 'directory items').map((entry) => {
    const item = requireRecord(entry, 'file entry')
    return Object.freeze({
      path: requireString(item.path, 'entry path'),
      kind: requireEnum(item.kind, FILE_ENTRY_KINDS, 'entry kind'),
      size: requireNonNegativeInteger(item.size, 'entry size'),
      etag: requireString(item.etag, 'entry etag'),
    })
  })
  return Object.freeze({
    path: requireStringValue(record.path, 'directory path'),
    revision: requireNonNegativeInteger(record.revision, 'directory revision'),
    items: Object.freeze(items),
  })
}

/**
 * Parses one file content payload.
 * @param value - Raw service payload.
 * @returns the frozen file content.
 */
export function parseFileContent(value: unknown): WorkspaceFileContent {
  const record = requireRecord(value, 'file content')
  const base64 = optionalStringValue(record, 'content_base64')
  const content = optionalStringValue(record, 'content')
  return Object.freeze({
    path: requireString(record.path, 'file path'),
    contentType: requireString(record.content_type, 'content_type'),
    size: requireNonNegativeInteger(record.size, 'size'),
    etag: requireString(record.etag, 'etag'),
    revision: requireNonNegativeInteger(record.revision, 'file revision'),
    ...(base64 === undefined ? {} : { contentBase64: base64 }),
    ...(content === undefined ? {} : { content }),
  })
}

/**
 * Parses one change set payload.
 * @param value - Raw service payload.
 * @returns the frozen changes.
 */
export function parseChanges(value: unknown): WorkspaceChanges {
  const record = requireRecord(value, 'changes')
  const files = requireArray(record.files, 'change files').map((entry) => {
    const item = requireRecord(entry, 'change file')
    const change = item.change
    return Object.freeze({
      path: requireString(item.path, 'change path'),
      change: requireEnum(change, CHANGE_KINDS, 'change kind'),
      diff: requireStringValue(item.diff, 'change diff'),
    })
  })
  return Object.freeze({
    workspaceId: requireString(record.workspace_id, 'changes workspace_id'),
    baselineRevision: requireNonNegativeInteger(record.baseline_revision, 'baseline_revision'),
    revision: requireNonNegativeInteger(record.revision, 'changes revision'),
    files: Object.freeze(files),
  })
}

const PREVIEW_KINDS = ['text', 'markdown', 'json', 'image', 'diff', 'static_html'] as const

/** Preview kinds whose body is the preview itself; a body must be present. */
const BODY_PREVIEW_KINDS: readonly (typeof PREVIEW_KINDS)[number][] = ['text', 'markdown', 'json', 'image', 'static_html']

/**
 * Parses one preview payload; unknown kinds reject.
 *
 * A `static_html` preview is executable content, so the service contract's
 * digest, CSP and sandbox are required fields: a payload that omits any of them
 * is a protocol error, never an unconstrained page the workbench may render. A
 * present-but-empty body stays a legal value — "no body" and "empty body" are
 * different answers and must not be conflated.
 * @param value - Raw service payload.
 * @returns the frozen preview.
 */
export function parsePreview(value: unknown): WorkspacePreview {
  const record = requireRecord(value, 'preview')
  const kind = record.kind
  if (typeof kind !== 'string' || !PREVIEW_KINDS.includes(kind as (typeof PREVIEW_KINDS)[number])) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace returned an unknown preview kind.')
  }
  const sandbox = record.sandbox === undefined ? undefined : requireStringList(record.sandbox, 'preview sandbox')
  const content = optionalStringValue(record, 'content')
  const contentBase64 = optionalStringValue(record, 'content_base64')
  const diff = optionalStringValue(record, 'diff')
  const sha256 = optionalStringValue(record, 'sha256')
  const csp = optionalStringValue(record, 'csp')
  const previewKind = kind as (typeof PREVIEW_KINDS)[number]
  if (BODY_PREVIEW_KINDS.includes(previewKind) && content === undefined && contentBase64 === undefined) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace preview of kind ${previewKind} carries no body.`)
  }
  if (previewKind === 'diff' && diff === undefined) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace diff preview carries no diff.')
  }
  if (previewKind === 'static_html') {
    if (sha256 === undefined) {
      throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace static_html preview must carry a sha256 digest.')
    }
    if (csp === undefined) {
      throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace static_html preview must carry a csp.')
    }
    if (sandbox === undefined) {
      throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace static_html preview must carry a sandbox.')
    }
  }
  return Object.freeze({
    path: requireString(record.path, 'preview path'),
    revision: requireNonNegativeInteger(record.revision, 'preview revision'),
    etag: requireString(record.etag, 'preview etag'),
    kind: previewKind,
    contentType: requireString(record.content_type, 'preview content_type'),
    ...(content === undefined ? {} : { content }),
    ...(contentBase64 === undefined ? {} : { contentBase64 }),
    ...(diff === undefined ? {} : { diff }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(csp === undefined ? {} : { csp }),
    ...(sandbox === undefined ? {} : { sandbox }),
  })
}

/** Deployment policy a preview URL grant is validated against. */
export interface PreviewUrlPolicy {
  /**
   * Exact origins (`https://host[:port]`) the deployment allows a preview URL to
   * point at. The default is an empty list: with nothing allowlisted the
   * workbench refuses every grant instead of opening an arbitrary origin.
   */
  readonly allowedOrigins: readonly string[]
  /** Workspace the grant must belong to; a grant for another workspace rejects. */
  readonly workspaceId: string
  /** Injectable clock in epoch milliseconds; defaults to the wall clock. */
  readonly now?: () => number
}

/**
 * Normalizes one allowlisted origin, rejecting anything that is not a bare
 * http(s) origin so a policy entry cannot smuggle a path or a wildcard.
 * @param origin - Policy entry as written in configuration.
 * @returns the normalized origin.
 */
export function normalizePreviewOrigin(origin: string): string {
  let parsed: URL
  try {
    parsed = new URL(origin.trim())
  } catch {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace preview origin is not an absolute URL: ${origin}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace preview origin must use http or https: ${origin}`)
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace preview origin must be a bare origin: ${origin}`)
  }
  return parsed.origin
}

/**
 * Parses one preview URL grant against the deployment policy.
 *
 * A grant is only usable when it names an allowlisted http(s) origin, belongs to
 * the workspace the caller is looking at, and has not expired. `javascript:` and
 * other non-http schemes, foreign origins, mismatched workspaces and expired or
 * unparseable deadlines all reject, so an invalid grant can never be rendered as
 * a live preview.
 * @param value - Raw service payload.
 * @param policy - Deployment allowlist, expected workspace, and clock.
 * @returns the frozen grant.
 */
export function parsePreviewUrlGrant(value: unknown, policy: PreviewUrlPolicy): WorkspacePreviewUrlGrant {
  const record = requireRecord(value, 'preview url grant')
  const rawUrl = requireString(record.url, 'preview url')
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace preview url is not an absolute URL: ${rawUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace preview url must use http or https: ${rawUrl}`)
  }
  const allowed = new Set(policy.allowedOrigins.map(normalizePreviewOrigin))
  if (!allowed.has(parsed.origin)) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace preview url origin is not allowlisted: ${parsed.origin}`)
  }
  const workspaceId = requireString(record.workspace_id, 'workspace_id')
  if (workspaceId !== policy.workspaceId) {
    throw new WorkspaceHttpError(
      'SERVICE_PROTOCOL_ERROR',
      `Cloud workspace preview url grant belongs to ${workspaceId}, not ${policy.workspaceId}.`,
    )
  }
  const expiresAt = requireString(record.expires_at, 'expires_at')
  const deadline = Date.parse(expiresAt)
  if (!Number.isFinite(deadline)) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace preview url expires_at is not a valid timestamp: ${expiresAt}`)
  }
  const now = policy.now?.() ?? Date.now()
  if (deadline <= now) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace preview url grant expired at ${expiresAt}.`)
  }
  return Object.freeze({ url: rawUrl, expiresAt, workspaceId })
}

/**
 * Parses the mutation result that carries the resulting workspace revision.
 * @param value - Raw service payload.
 * @returns the frozen revision result.
 */
export function parseRevisionResult(value: unknown): { readonly revision: number } {
  const record = requireRecord(value, 'mutation result')
  return Object.freeze({ revision: requireNonNegativeInteger(record.revision, 'mutation revision') })
}

/**
 * Parses the pull-request result that carries the provider-side PR id.
 * @param value - Raw service payload.
 * @returns the frozen pull request result.
 */
export function parsePullRequestResult(value: unknown): { readonly pullRequestId: string } {
  const record = requireRecord(value, 'pull request result')
  return Object.freeze({ pullRequestId: requireString(record.pull_request_id, 'pull_request_id') })
}


/**
 * Parses the execution policy attached to one published profile version.
 *
 * Every member is contract-optional, but "optional" means absent — a member the
 * service did send is data and must satisfy its declared type. Filtering a
 * wrong-typed budget or timeout out of the policy would quietly widen the
 * constraints the run is supposed to execute under.
 */
function parseExecutionPolicy(value: unknown): AgentExecutionPolicy {
  const record = requireRecord(value ?? {}, 'execution_policy')
  const permissionMode = optionalStringValue(record, 'permission_mode')
  const allowlist = record.tool_allowlist === undefined
    ? undefined
    : requireStringList(record.tool_allowlist, 'execution_policy tool_allowlist')
  const maxConcurrency = optionalNumberValue(record, 'max_concurrency')
  const budget = optionalNumberValue(record, 'budget')
  const timeoutMs = optionalNumberValue(record, 'timeout_ms')
  const writeMode = record.write_mode === undefined
    ? undefined
    : requireEnum(record.write_mode, RUN_WRITE_MODES, 'execution_policy write_mode')
  return Object.freeze({
    ...(permissionMode === undefined ? {} : { permission_mode: permissionMode }),
    ...(allowlist === undefined ? {} : { tool_allowlist: allowlist }),
    ...(maxConcurrency === undefined ? {} : { max_concurrency: maxConcurrency }),
    ...(budget === undefined ? {} : { budget }),
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
    ...(writeMode === undefined ? {} : { write_mode: writeMode }),
  })
}

/**
 * Parses one stream event DTO.
 * @param value - Raw event payload.
 * @returns the frozen stream event.
 */
export function parseStreamEvent(value: unknown): WorkspaceStreamEvent {
  const record = requireRecord(value, 'stream event')
  return Object.freeze({
    eventId: requireString(record.event_id, 'event_id'),
    resourceType: knownOrUnknown(record.resource_type, STREAM_RESOURCE_TYPES, 'unknown'),
    resourceId: requireString(record.resource_id, 'resource_id'),
    revision: requireNonNegativeInteger(record.revision, 'event revision'),
    eventType: requireString(record.event_type, 'event_type'),
    occurredAt: requireString(record.occurred_at, 'occurred_at'),
    payload: requireRecord(record.payload, 'event payload'),
  })
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace response field ${field} must be an array.`)
  }
  return value
}

interface EnvelopeResult {
  readonly requestId: string
  readonly data: unknown
}

function parseEnvelope(value: unknown): EnvelopeResult {
  const record = recordOf(value)
  if (record === undefined || typeof record.request_id !== 'string' || !Object.hasOwn(record, 'data')) {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace service returned an invalid envelope.')
  }
  if (record.code !== 0) {
    throw new WorkspaceHttpError(
      String(record.code),
      typeof record.message === 'string' ? record.message : 'Cloud workspace request failed.',
    )
  }
  return { requestId: record.request_id, data: record.data }
}

/**
 * Normalizes the deployment `apiBaseUrl` into the service origin.
 *
 * Single contract: `apiBaseUrl` is the cloud workspace service endpoint and may
 * be written with or without a trailing `/v1` and with or without a trailing
 * slash. Every request path already carries its own `/v1`, so only the origin is
 * stored — the client can never emit a duplicated `/v1`.
 * @param apiBaseUrl - Deployment-supplied base URL.
 * @returns the normalized origin with no trailing slash and no trailing `/v1`.
 */
export function normalizeApiBaseUrl(apiBaseUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(apiBaseUrl.trim())
  } catch {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace apiBaseUrl is not an absolute URL: ${apiBaseUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace apiBaseUrl must use http or https: ${apiBaseUrl}`)
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', `Cloud workspace apiBaseUrl must not carry a query or fragment: ${apiBaseUrl}`)
  }
  const path = parsed.pathname.replace(/\/+$/u, '').replace(/(?:\/v1)+$/u, '')
  return `${parsed.origin}${path}`
}

/** HTTP client for user cloud-workspace routes; every response is strictly parsed. */
export class WorkspaceHttpClient {
  private readonly origin: string
  private readonly fetcher: typeof globalThis.fetch

  constructor(baseUrl: string, fetcher: typeof globalThis.fetch) {
    this.origin = normalizeApiBaseUrl(baseUrl)
    this.fetcher = fetcher
  }

  /** Executes one authorized request and returns the envelope data.
   * @param path - Service path including query.
   * @param options - Method, body, and extra headers.
   * @param accessToken - Current account access token.
   * @returns the parsed `data` field.
   */
  async request(path: string, options: WorkspaceRequestOptions = {}, accessToken: string): Promise<WorkspaceResponse<unknown>> {
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${accessToken}` }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.headers !== undefined) Object.assign(headers, options.headers)
    const response = await this.fetcher(`${this.origin}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!response.ok) throw await errorOf(response)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace service returned invalid JSON.')
    }
    return {
      value: parseEnvelope(body).data,
      // The service declares its own provenance; the Host never infers it.
      fixtureOnly: response.headers.get('x-fixture-only') === 'true',
    }
  }

  /** Opens the SSE stream; frames must be parsed by `parseStreamEventData`.
   * @param query - Stream query string beginning with `?`.
   * @param accessToken - Current account access token.
   * @param signal - Abort signal owning the connection.
   * @returns an async iterable of frames, control markers and protocol violations.
   */
  async openStream(query: string, accessToken: string, signal: AbortSignal): Promise<AsyncIterable<SseFrame | 'resync_required' | 'replay_done' | SseProtocolViolation>> {
    const response = await this.fetcher(`${this.origin}/v1/events/stream${query}`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${accessToken}` },
      signal,
    })
    if (!response.ok) throw await errorOf(response)
    if (response.body === null) {
      throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace event stream has no body.')
    }
    return decodeSse(response.body)
  }
}

/** One parsed SSE frame with its event name, id, and raw JSON data. */
export interface SseFrame {
  readonly event: string
  readonly id: string
  readonly data: string
}

/**
 * A frame the wire delivered but this client cannot use.
 *
 * Protocol drift is reported rather than skipped: silently dropping a frame and
 * continuing to present the stream as healthy is how a workbench ends up
 * showing a stale tree as live.
 */
export interface SseProtocolViolation {
  readonly protocolError: string
}

/** Finds the next line terminator, accepting LF, CRLF and a bare CR. */
function nextLineBreak(text: string): { readonly index: number; readonly length: number } | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\n') return { index, length: 1 }
    if (char === '\r') {
      // A CR at the buffer's end may be the first half of a CRLF split across
      // chunks: wait for the next chunk instead of terminating a line early.
      if (index === text.length - 1) return undefined
      return { index, length: text[index + 1] === '\n' ? 2 : 1 }
    }
  }
  return undefined
}

/**
 * Parses a paginated list envelope: `items` plus an opaque `next_cursor` that
 * the client must treat as opaque and pass back verbatim. A missing field is
 * the documented absence of a next page.
 * @param value - Raw envelope payload.
 * @param parseItem - Strict per-item parser.
 * @param label - Field name for error messages.
 * @returns frozen items and the next cursor (null when exhausted).
 */
export function parsePage<T>(
  value: unknown,
  parseItem: (entry: unknown) => T,
  label: string,
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  const record = requireRecord(value, label)
  const items = requireArray(record.items, `${label} items`).map(parseItem)
  const rawCursor = record.next_cursor
  if (rawCursor !== undefined && rawCursor !== null && typeof rawCursor !== 'string') {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace response field next_cursor must be a string or null.')
  }
  return { items: Object.freeze(items), nextCursor: typeof rawCursor === 'string' ? rawCursor : null }
}

/**
 * Applies one SSE line to the frame state: comment lines are skipped and
 * `event` / `id` / `data` fields update the frame under construction.
 * @param line - Raw line without its terminator.
 * @param setField - Invoked once per recognized field.
 */
function applySseLine(line: string, setField: (field: string, value: string) => void): void {
  if (line === '' || line.startsWith(':')) return
  const colon = line.indexOf(':')
  const field = colon === -1 ? line : line.slice(0, colon)
  const raw = colon === -1 ? '' : line.slice(colon + 1)
  setField(field, raw.startsWith(' ') ? raw.slice(1) : raw)
}

/**
 * Decodes an SSE byte stream into frames.
 *
 * Framing follows the event-stream grammar rather than a literal `\n\n` search:
 * LF, CRLF and bare CR all terminate a line; a line terminator split across
 * chunks and a multi-byte UTF-8 character split across chunks are both held
 * until the bytes that complete them arrive; comment lines are ignored; the
 * deployment's `resync_required` and `stream.replay-done` control events become
 * explicit markers. Anything else is data: a `data:` payload that is not JSON
 * surfaces as an {@link SseProtocolViolation} instead of vanishing.
 *
 * Reads through an explicit reader loop: `for await` directly over the undici
 * ReadableStream suspends inside generators without releasing the event loop.
 * @param body - The response body reader stream.
 * @returns frames plus control markers for resync, replay completion and protocol drift.
 */
export async function* decodeSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame | 'resync_required' | 'replay_done' | SseProtocolViolation> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let event = ''
  let id = ''
  let data = ''
  let sawField = false

  const dispatch = (): (SseFrame | 'resync_required' | 'replay_done' | SseProtocolViolation)[] => {
    const frameEvent = event === '' ? 'message' : event
    const frameId = id
    const frameData = data
    event = ''
    id = ''
    data = ''
    if (!sawField && frameEvent === 'message' && frameId === '' && frameData === '') return []
    sawField = false
    if (frameEvent === 'resync_required') return ['resync_required']
    if (frameEvent === 'stream.replay-done') return ['replay_done']
    if (frameData === '' && frameId === '') return []
    if (frameEvent === 'message' && frameData !== '') {
      try {
        JSON.parse(frameData)
      } catch {
        return [{ protocolError: `Cloud workspace event stream delivered a non-JSON data frame: ${frameData.slice(0, 120)}` }]
      }
    }
    return [{ event: frameEvent, id: frameId, data: frameData }]
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      for (;;) {
        const terminator = nextLineBreak(buffered)
        if (terminator === undefined) break
        const line = buffered.slice(0, terminator.index)
        buffered = buffered.slice(terminator.index + terminator.length)
        if (line === '') {
          for (const frame of dispatch()) yield frame
          continue
        }
        applySseLine(line, (field, value) => {
          sawField = true
          if (field === 'event') event = value
          else if (field === 'id') id = value
          else if (field === 'data') data += (data.length === 0 ? '' : '\n') + value
        })
      }
    }
    // Flush the decoder's pending bytes, then accept a final frame that the
    // server ended without a blank-line terminator.
    buffered += decoder.decode()
    const terminator = nextLineBreak(buffered)
    if (terminator !== undefined) {
      const line = buffered.slice(0, terminator.index)
      buffered = buffered.slice(terminator.index + terminator.length)
      applySseLine(line, (field, value) => {
        sawField = true
        if (field === 'event') event = value
        else if (field === 'id') id = value
        else if (field === 'data') data += (data.length === 0 ? '' : '\n') + value
      })
    }
    for (const frame of dispatch()) yield frame
  } finally {
    reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * Parses an SSE frame's JSON data.
 *
 * A frame whose data is not a valid event DTO is protocol drift, not an event
 * to skip: it throws so the caller can mark the stream stale and resynchronize
 * instead of continuing to present an incomplete view as current.
 * @param frame - Parsed SSE frame.
 * @returns the stream event.
 * @throws WorkspaceHttpError when the payload is not a valid event DTO.
 */
export function parseStreamEventData(frame: SseFrame): WorkspaceStreamEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.data)
  } catch {
    throw new WorkspaceHttpError('SERVICE_PROTOCOL_ERROR', 'Cloud workspace event stream delivered a non-JSON event payload.')
  }
  return parseStreamEvent(parsed)
}
