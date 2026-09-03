/** Client-safe data vocabulary for platform-hosted local DSH Team Skills. */

import type { InstalledTeamSkill, TeamSkillFileDigest } from './installer.ts'

/** Installation root selected by the user. */
export type TeamSkillScope = 'project' | 'global'

/** Account roles returned by the authoritative user service. */
export type TeamSkillAccountRole = 'admin' | 'manager' | 'member'

/** Account status returned by the authoritative user service. */
export type TeamSkillAccountStatus = 'active' | 'suspended'

/** Browser-safe account summary returned by the Host. */
export interface TeamSkillAccountUser {
  /** Stable opaque account identity. */
  readonly userId: string
  /** Login name or organization email. */
  readonly username: string
  /** Organization email displayed by the account drawer. */
  readonly email: string
  /** Human-facing display name. */
  readonly displayName: string
  /** Current service-side account state. */
  readonly status: TeamSkillAccountStatus
  /** Single account-wide role used for management scope. */
  readonly globalRole: TeamSkillAccountRole
  /** Whether the first-login password flow is still required. */
  readonly mustChangePassword: boolean
  /** Service-side user revision. */
  readonly revision: number
}

/** Browser-safe organization membership summary. */
export interface TeamSkillAccountMembership {
  /** Organization identity. */
  readonly organizationId: string
  /** Organization display name. */
  readonly organizationName: string
  /** Membership state. */
  readonly status: TeamSkillAccountStatus
  /** Service-side membership revision. */
  readonly revision: number
}

/** Browser-safe organization visible to the current account. */
export interface TeamSkillOrganization {
  /** Organization identity. */
  readonly organizationId: string
  /** Organization display name. */
  readonly name: string
  /** Organization lifecycle state. */
  readonly status: 'active' | 'archived'
  /** Service-side organization revision. */
  readonly revision: number
}

/** Browser-safe project visible to the current account. */
export interface TeamSkillProject {
  /** Project identity. */
  readonly projectId: string
  /** Owning organization identity. */
  readonly organizationId: string
  /** Owning organization display name. */
  readonly organizationName: string
  /** Project display name. */
  readonly name: string
  /** Non-sensitive project description. */
  readonly description: string
  /** Project lifecycle state. */
  readonly status: 'draft' | 'active' | 'archived'
  /** Server timestamps and governance counters. */
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly memberCount: number
  readonly assetCount: number
  /** Service-side project revision. */
  readonly revision: number
}

/** Asset relation summary returned for an active project. */
export interface TeamSkillProjectAsset {
  readonly projectId: string
  readonly assetType: 'skill' | 'knowledge' | 'memory'
  readonly assetId: string
  readonly name: string
  readonly relationKind: 'reference' | 'context'
  readonly createdAt: string
  readonly updatedAt: string
  readonly revision: number
}

/** Project detail returned after project-level authorization. */
export interface TeamSkillProjectDetail {
  readonly project: TeamSkillProject
  readonly assets: readonly TeamSkillProjectAsset[]
}

/** Asset visibility scope returned by the service. */
export type TeamSkillAssetVisibility = 'platform' | 'organization' | 'project' | 'account'

/** Browser-safe asset summary returned by the service. */
export interface TeamSkillAsset {
  /** Stable opaque asset identity. */
  readonly assetId: string
  /** Module-owned asset type. */
  readonly assetType: 'project' | 'skill' | 'knowledge' | 'memory'
  /** Human-facing name. */
  readonly name: string
  /** Matched authorization scope. */
  readonly visibility: TeamSkillAssetVisibility
  /** Owning organization when applicable. */
  readonly organizationId?: string
  /** Owning project when applicable. */
  readonly projectId?: string
}

/** Browser-safe service-authoritative access summary across all organizations. */
export interface TeamSkillAccessSummary {
  /** Organizations currently visible to the account. */
  readonly organizations: readonly TeamSkillOrganization[]
  /** Projects currently visible to the account. */
  readonly projects: readonly TeamSkillProject[]
  /** Assets currently visible to the account. */
  readonly assets: readonly TeamSkillAsset[]
  /** Organization and project identifiers the account may manage. */
  readonly management: { readonly organizationIds: readonly string[]; readonly projectIds: readonly string[] }
  /** Revision for the access summary. */
  readonly revision: number
}

/** Browser-safe authentication state. */
export type TeamSkillAccountState =
  | { readonly status: 'signed-out' }
  | {
    readonly status: 'authenticated'
    readonly user: TeamSkillAccountUser
    readonly memberships: readonly TeamSkillAccountMembership[]
    readonly mustChangePassword: boolean
  }

/** Login request accepted by the Host. */
export interface TeamSkillLoginRequest {
  /** Username or organization email. */
  readonly username: string
  /** Password supplied by the user. */
  readonly password: string
}

/** First-login or account password change request. */
export interface TeamSkillChangePasswordRequest {
  /** Current password supplied by the user. */
  readonly currentPassword: string
  /** New password supplied by the user. */
  readonly newPassword: string
}

/** Account operation result projected through the typed Remote. */
export type TeamSkillAccountResult<T> = T | { readonly status: 'signed-out' } | TeamSkillNotReady | TeamSkillFailed

/** Knowledge base type owned by the external WeKnora data plane. */
export type TeamSkillKnowledgeBaseType = 'document' | 'faq' | 'wiki'

/** Platform lifecycle state for one knowledge base. */
export type TeamSkillKnowledgeBaseState = 'active' | 'unavailable' | 'deleting'

/** Browser-safe project knowledge base summary. */
export interface TeamSkillKnowledgeBaseSummary {
  readonly knowledgeBaseId: string
  readonly name: string
  readonly description: string
  readonly type: TeamSkillKnowledgeBaseType
  readonly state: TeamSkillKnowledgeBaseState
  readonly searchable: boolean
  readonly updatedAt: string
  readonly revision: number
}

/** Citation location returned with an authorized search result. */
export interface TeamSkillKnowledgeCitation {
  readonly page?: number
  readonly chunk?: string
}

/** One constrained, model-visible knowledge result. */
export interface TeamSkillKnowledgeSearchResult {
  readonly knowledgeBaseId: string
  readonly knowledgeId: string
  readonly title: string
  readonly snippet: string
  readonly score: number
  readonly sourceUrl: string
  readonly citation?: TeamSkillKnowledgeCitation
}

/** Per-knowledge-base status for a search request. */
export interface TeamSkillKnowledgeSearchStatus {
  readonly knowledgeBaseId: string
  readonly status: 'used' | 'no_hits' | 'skipped'
  readonly reason?: 'processing' | 'unavailable' | 'forbidden' | 'not_found' | 'timeout' | 'external_error' | null
}

/** Platform search response preserving per-KB status. */
export interface TeamSkillKnowledgeSearchResponse {
  readonly requestId: string
  readonly results: readonly TeamSkillKnowledgeSearchResult[]
  readonly knowledgeBases: readonly TeamSkillKnowledgeSearchStatus[]
}

/** Request for one explicit project-scoped knowledge search. */
export interface TeamSkillKnowledgeSearchRequest {
  readonly projectId: string
  readonly knowledgeBaseIds: readonly string[]
  readonly query: string
  readonly topK?: number
  readonly traceId?: string
}

/** Session-only knowledge bases selected for one live native DSH agent. */
export interface TeamSkillKnowledgeSelection {
  readonly projectId: string
  readonly knowledgeBaseIds: readonly string[]
}

/** Minimal authorized document preview link. */
export interface TeamSkillKnowledgePreview {
  readonly knowledgeBaseId: string
  readonly documentId: string
  readonly title: string
  readonly previewUrl: string
}

/** Service-authoritative project memory record visible to the current caller. */
export interface TeamSkillMemory {
  readonly memoryId: string
  readonly teamId: string
  readonly projectId: string
  readonly content: string
  readonly layer: 'L1'
  readonly capturedByUserId: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly revision: number
  readonly status: 'ACTIVE' | 'DELETED'
  readonly importance: number
  readonly recallCount: number
  readonly lastRecalledAt: string | null
  readonly sourceKind: 'agent_turn'
}

/** Search result returned by project-memory recall. */
export interface TeamSkillMemoryRecallItem {
  readonly memoryId: string
  readonly content: string
  readonly score: number
  readonly layer: 'L1'
}

/** Server state for one project-memory recall request. */
export type TeamSkillMemoryRecallStatus = 'READY' | 'PARTIAL' | 'UNAVAILABLE' | 'PROJECT_REQUIRED'

/** Project-memory recall response; failure states are not empty success responses. */
export interface TeamSkillMemoryRecallResponse {
  readonly status: TeamSkillMemoryRecallStatus
  readonly items: readonly TeamSkillMemoryRecallItem[]
  readonly contextText: string
  readonly strategy: string
  readonly effectivePolicy: { readonly topK: number; readonly relevanceThreshold: number; readonly tokenBudget: number }
}

/** Cursor page for project-memory list and search. */
export interface TeamSkillMemoryPage {
  readonly items: readonly TeamSkillMemory[]
  readonly nextCursor: string | null
  readonly totalEstimate: number
}

/** Accepted asynchronous memory mutation. */
export interface TeamSkillMemoryMutation {
  readonly memory?: TeamSkillMemory
  readonly eventId: string
  readonly jobId: string
  readonly status: 'PENDING' | 'INDEX_PENDING'
  readonly acceptedCount?: number
  readonly cleanupStatus?: 'PENDING' | 'FAILED'
}

/** Project-memory job visible to the current caller. */
export interface TeamSkillMemoryJob {
  readonly jobId: string
  readonly eventId: string
  readonly kind: 'CAPTURE' | 'INDEX_REFRESH' | 'DELETE_CLEANUP' | 'SCOPE_MOVED'
  readonly teamId: string
  readonly projectId: string
  readonly requestedByUserId: string
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED'
  readonly retryable: boolean
  readonly retryCount: number
  readonly createdAt: string
  readonly finishedAt: string | null
  readonly errorCode: string | null
  readonly revision: number
}

/** Project-memory audit record without source transcript content. */
export interface TeamSkillMemoryAudit {
  readonly auditId: string
  readonly operation: string
  readonly operatedByUserId: string
  readonly role: TeamSkillAccountRole
  readonly memoryId: string | null
  readonly projectId: string
  readonly result: string
  readonly eventId: string
}

/** Server-controlled publication state of a Team Skill version. */
export type TeamSkillReleaseState = 'published' | 'withdrawn'

/** Minimal server-authoritative Team Skill list item. */
export interface TeamSkillCatalogItem {
  /** Stable opaque server identity. */
  readonly skillId: string
  /** Human-facing Chinese or localized name. */
  readonly displayName: string
  /** Server-generated DSH runtime name. */
  readonly runtimeName: string
  /** Short purpose statement. */
  readonly summary: string
  /** Current recommended immutable release version. */
  readonly version: string
  /** Catalog classification. */
  readonly category: string
  /** Searchable server-controlled tags. */
  readonly tags: readonly string[]
  /** Current release timestamp. */
  readonly publishedAt: string
}

/** Page returned by the visible Team Skill catalog. */
export interface TeamSkillCatalog {
  /** Skills visible to the authenticated user only. */
  readonly items: readonly TeamSkillCatalogItem[]
  /** Opaque next-page cursor, when additional items exist. */
  readonly nextCursor?: string
}

/** Server-authoritative release state for one locally installed version. */
export interface TeamSkillReleaseStatusItem {
  /** Stable server Skill identity. */
  readonly skillId: string
  /** Immutable installed version. */
  readonly version: string
  /** Opaque project identity used for server-side release authorization. */
  readonly projectId: string
  /** Current server release state. */
  readonly status: TeamSkillReleaseState
}

/** Environment facts used only for dependency preflight. */
export interface TeamSkillEnvironment {
  /** Running DSH version. */
  readonly dshVersion: string
  /** Tool names available to the local DSH profile. */
  readonly availableTools: readonly string[]
  /** Locally registered MCP server names. */
  readonly availableMcpServers: readonly string[]
  /** Present environment variable names; values are never reported. */
  readonly presentEnvironmentVariableNames: readonly string[]
}

/** Browser request for one host-owned installation operation. */
export interface TeamSkillInstallRequest {
  /** Stable server Skill identity. */
  readonly skillId: string
  /** Immutable release version selected from server data. */
  readonly version: string
  /** Opaque project identity used for server-side resource authorization. */
  readonly projectId: string
  /** Local DSH installation root. */
  readonly scope: TeamSkillScope
  /** Opaque DSH workspace identity required only for project scope. */
  readonly workspaceId?: string
  /** Local preflight facts that contain no values or paths. */
  readonly environment: TeamSkillEnvironment
  /** Explicit user confirmation when replacing a modified managed copy. */
  readonly confirmModifiedReplace?: boolean
}

/** Short-lived service authorization for one immutable release artifact. */
export interface TeamSkillAuthorizedArtifact {
  /** Download URL authorized for this user, Skill and version. */
  readonly downloadUrl: string
  /** Download authorization expiry. */
  readonly expiresAt: string
  /** Archive SHA-256 from the server artifact record. */
  readonly sha256: string
  /** Expected ZIP size in bytes. */
  readonly sizeBytes: number
  /** Every allowed regular file and its digest. */
  readonly files: readonly TeamSkillFileDigest[]
}

/** Authorized installation operation returned before local writing begins. */
export interface TeamSkillAuthorizedOperation {
  /** Service-issued lifecycle operation identity. */
  readonly operationId: string
  /** Platform Skill identity. */
  readonly skillId: string
  /** Server-owned DSH runtime name. */
  readonly runtimeName: string
  /** Immutable target release version. */
  readonly version: string
  /** Download and integrity information. */
  readonly artifact: TeamSkillAuthorizedArtifact
}

/** One locally persisted, plugin-owned installation record. */
export interface TeamSkillInstallationRecord {
  /** Host-generated local installation identity; never contains a path. */
  readonly localInstallationId: string
  /** Server Team Skill identity. */
  readonly skillId: string
  /** Opaque server project identity used to authorize release status checks. */
  readonly projectId: string
  /** Install root selection. */
  readonly scope: TeamSkillScope
  /** Owning local workspace for project scope only. */
  readonly workspaceId?: string
  /** Private on-device file record. */
  readonly installed: InstalledTeamSkill
  /** ISO timestamp of the most recent successful local write. */
  readonly installedAt: string
}

/** Browser-safe summary of one locally managed Team Skill copy. */
export interface TeamSkillInstallationView {
  /** Host-generated local installation identity. */
  readonly localInstallationId: string
  /** Server Team Skill identity. */
  readonly skillId: string
  /** Opaque server project identity that authorized this local copy. */
  readonly projectId: string
  /** Install root selection. */
  readonly scope: TeamSkillScope
  /** Owning local workspace for project scope only. */
  readonly workspaceId?: string
  /** DSH runtime name. */
  readonly runtimeName: string
  /** Installed immutable release version. */
  readonly version: string
  /** Installed release archive digest. */
  readonly artifactSha256: string
  /** Current Host lifecycle state. */
  readonly state: InstalledTeamSkill['state']
  /** ISO timestamp of the most recent successful local write. */
  readonly installedAt: string
}

/** Action stage carried to the service audit trail without local paths. */
export type TeamSkillOperationStatus = 'downloading' | 'verifying' | 'writing' | 'refreshing' | 'succeeded' | 'failed' | 'cancelled'

/** User-displayable Host status when service configuration is incomplete. */
export interface TeamSkillNotReady {
  readonly status: 'not-ready'
  /** Missing configuration field names, never secret values. */
  readonly missing: readonly string[]
}

/** User-displayable Host failure. */
export interface TeamSkillFailed {
  readonly status: 'failed'
  /** Stable error code from the service or Host. */
  readonly code: string
  /** Safe action summary. */
  readonly message: string
}

/** Result of a Team Skill catalog request. */
export type TeamSkillCatalogResult = { readonly status: 'ready'; readonly catalog: TeamSkillCatalog } | TeamSkillNotReady | TeamSkillFailed

/** Result of an installation request. */
export type TeamSkillInstallResult =
  | { readonly status: 'succeeded'; readonly installation: TeamSkillInstallationView }
  | TeamSkillNotReady
  | TeamSkillFailed

/** Request to remove one Host-managed local copy. */
export interface TeamSkillUninstallRequest {
  /** Host-generated local installation identity. */
  readonly localInstallationId: string
  /** Explicit confirmation when local files were changed. */
  readonly confirmModifiedReplace?: boolean
}

/** Result of a Host-managed uninstall. */
export type TeamSkillUninstallResult =
  | { readonly status: 'succeeded'; readonly installation: TeamSkillInstallationView }
  | TeamSkillNotReady
  | TeamSkillFailed
