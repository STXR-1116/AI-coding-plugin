# @deepseek-ai/dsh-ai-coding-platform

English | [中文](README.zh.md)

Host-side Team Skill and knowledge-recall bridge for the first-party AI Coding platform. The package reads the authenticated service catalog, authorizes immutable releases, downloads and verifies ZIP artifacts, writes only the DSH native Skill directory, and projects the result through the `teamSkills` Typert Remote namespace. It also binds selected knowledge bases to one live DSH session and retrieves references before each model step.

## Configuration

`apiBaseUrl` configures the AI Coding service. `accessToken` is an optional Host-owned static service token; when `credentials` is configured, account login stores the service grant there and catalog, release-status, and installation requests use that grant. If the service rejects both the access and refresh tokens, the Host deletes the grant and returns `signed-out`; transport failures remain explicit failures and never reuse cached authorization. `stateDirectory` stores Host-owned installation records and quarantined copies. `globalSkillRoot` is the DSH global Skill discovery directory. Project installations resolve an opaque workspace id through DSH `workspaceRegistry`; browser clients never receive filesystem paths or access tokens.

## Semantics

The Host sends the selected opaque project id with catalog, installation, and knowledge requests; the service rechecks project membership on every request. Catalog, release-status, and installation requests share the account request's single refresh: an expired token triggers exactly one coalesced refresh, and a rejected refresh deletes the stored grant and returns `signed-out` to the browser. Installation records are project authorization records: the record identity is `(skillId, scope, workspaceId, projectId)`, so two projects never overwrite each other's record for the same local copy scope, while the physical copy stays single per scope root and a second project's install explicitly supersedes the prior record as `uninstalled`. Browser installation queries return only records for the reauthorized current project. Release-status checks submit the record's project id; a release omitted from the authoritative response is hidden and quarantined. The Host also sends installation authorization and lifecycle events to the service. It verifies the service SHA-256, declared file digests, ZIP paths, and `SKILL.md` frontmatter before an atomic write. A locally modified managed copy is not replaced or removed without explicit confirmation. A withdrawn release is moved outside the DSH discovery root and marked `withdrawn`; an uninstall removes the managed copy and refreshes native Skill discovery. Knowledge selections stay in memory for one live session, and project or session changes clear them.

The Remote export names are `teamSkills/installSkill` and `teamSkills/uninstallSkill`. The Host method names remain `install` and `uninstall` because the Typert namespace reserves the `install` and `uninstall` service keys.

## Observability Pipeline

The package hosts the AI Coding telemetry collector: a `sessionTelemetry` service projects whitelisted DSH session facts (never prompts, replies, tool arguments, or results) into a per-account-partitioned SQLite queue, and a background reporter delivers single-project batches to the service with per-event acks (accepted/duplicate/retryable/rejected). Capture is authorized: a batch leaves only through the account partition it was claimed from — the delivery re-resolves the current account and refuses to send when the partition and the `Authorization` identity disagree (a mid-flight login/logout produces a deferred batch, never a cross-identity send). The static access token is a fallback only for deployments with a confirmed signed-out state.

Authentication pending windows isolate capture: while a login, refresh, or logout request is in flight, events for bound sessions are counted as isolated (`receivedEventCount` / `isolatedEventCount` in the collector status) and written to neither the old nor the new partition. Every failure path is recoverable without waiting for the claim lease: send, ACK-application, and account-resolution errors register a retry (`TELEMETRY_SEND_THREW` / `TELEMETRY_ACK_FAILED` / `ACCOUNT_RESOLVE_FAILED`); if the recovery operation itself fails, the claim is released directly, and a failing queue stops the pipeline with an explicit storage error. Disposal runs through a constructor-registered Cordis effect: the reporter stops, completes a final drain, and the queue closes exactly once; a closed queue rejects new events with a storage failure instead of dropping them silently. `configureCollectorProject` authorizes the project against the service before binding — unauthorized, archived, or missing projects (and signed-out accounts) are refused with the previous binding untouched. Error summaries are sanitized through one shared redactor (Bearer tokens, keyed secrets, cookies, passwords, user-directory paths) before they reach the queue, status views, or the fixture.

`apps/team-skill-service/tests`-style deterministic scans and the gateway/loop integration suites cover every layer end to end, including a deliberate-leak gate that must fail with the raw sample before sanitization and pass after.


## Cloud workspaces

- `WorkspaceHost` reads REST snapshots before opening SSE, keeps one subscription alive with watermark reconnects, re-reads the project snapshot on `resync_required`, maps 401 `AUTH_REQUIRED`/`TOKEN_EXPIRED` to signed-out by clearing the shared account credential record, and maps every service error to a stable `WorkspaceQueryResult` failure; it never invents local success.
- Write operations carry `Idempotency-Key` and `expected_workspace_revision`/`If-Match` revision guards. `WorkspaceGateway` projects the operations to the browser as the `cloudWorkspaces` Remote namespace; the workbench UI and its states live in `@deepseek-ai/dsh-client-ui-ai-coding-platform`.
- Agent-profile reads (`agentTypes`, `agentProfiles(projectId)`, `agentProfileVersion(versionId)`) return only project-bound published versions with display-ready bindings (name/readiness resolved server side), the execution policy including `write_mode`, generic `type_extension_config` values, and the server's readiness verdict with its reason. `createRun` snapshots the chosen version's execution policy onto the run, and a run's write mode may tighten but never widen it. Every field is strictly parsed: absent members, wrong types, unknown readiness values, and non-published versions are protocol errors instead of defaults, and no credential material exists on this surface.
- Configuration contract: `apiBaseUrl` is the cloud workspace service endpoint. It may be written with or without a trailing `/v1` and with or without a trailing slash; the client normalizes it to the origin and every request path supplies its own `/v1`, so REST reads, writes and the SSE stream each reach exactly one `/v1`. A URL that is not an absolute http(s) URL fails explicitly instead of being rewritten into a request against a wrong host. Identity is equally explicit: `authMode: 'account'` (the default) uses only the shared account credential record and reports `signed-out` when the grant is missing, revoked, unreadable, or cleared by a 401; a static token is a whole-deployment identity substitute usable only with `authMode: 'static-token'`, and carrying one in an account deployment is refused at load.

## Model Experience

### Native DSH conversation

#### What the model sees

Before each admitted model step, the Host searches the selected project knowledge bases through the service, appends a `knowledge-search` event to the DSH Session, and injects cited reference text as untrusted context. The current turn's `AbortSignal` reaches the search; an aborted search writes no event and does not continue the model request. Installed Skills become visible through the native `dsh-skill` provider after discovery refresh.

#### Token effect

The installation workflow consumes no model tokens. Any project context or Skill instructions that later enter a request are owned and measured by the native Session and Skill consumers.

#### KV Cache effect

Knowledge references are reconstructed from the `knowledge-search` events and therefore remain part of the native Session history; the package does not otherwise change the native Session prefix or provider cache behavior.

## Known Limitations and Deferred Work

- Missing service or Host configuration returns `not-ready`; transport, authorization, digest, ZIP, local filesystem, and DSH discovery failures return stable failed results.
- The package does not execute Skill content, accept arbitrary URLs, install dependencies, or provide a browser-side filesystem escape.
- The in-memory `apps/team-skill-service` is a local integration fixture, not a production service.
