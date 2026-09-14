# @deepseek-ai/dsh-client-ui-ai-coding-platform

English | [中文](README.zh.md)

Single first-party AI Coding workspace plugin. It contributes a `sidebar.footer.action` button in the native DSH sidebar; the surface is closed initially and opens through `shell.overlay` only after that button is clicked. The surface presents account sign-in, authorized project selection and read-only project details, team Skills, knowledge, memory, AI Coding telemetry, and cloud Coding Agent configuration. Session rendering and execution remain in the native DSH conversation UI.

Account sign-in, mandatory password changes, organization selection, project selection, and per-project resource identifiers use the Host-owned `teamSkills` Remote. The Host keeps access and refresh tokens in DSH credentials; the browser receives only account and access summaries. The project picker groups service-authorized active projects by organization, persists only an opaque `project_id` per service address and account, and reauthorizes it before restoring the selection. Selecting a project clears the previous project assets before loading its detail; authorization, transport, and service failures show an explicit failure state without local success. Team Skills renders the Host-owned Remote catalog and installation records as the service returns them; the service-side organization and project-asset authorization is the only filter, and a signed-out recovery from any Skill request sends the caller back through the account refresh path. Knowledge bases are service-backed: the Client lists authorized summaries, binds an explicit selection to the current DSH session, and displays service-returned search results and previews. Project memory is also service-backed: the Client searches and pages the current project's server-authoritative records, then uses server revisions for detail, edit, and delete operations. A missing service or Host configuration produces an explicit `not-ready` or failure state; it never grants a local success result. Installation and uninstall are performed by the Host, which verifies the immutable ZIP and writes the DSH native Skill directory.

The Agent 配置 page is a read-only consumer of the project's published Agent Profile Versions through the `cloudWorkspaces` Remote: cards carry name, description, agent type with readiness, published version and update time, ordered Skill bindings with unavailable-asset flags, knowledge-base count, the single memory library or 未使用记忆库, the server's readiness verdict with its reason, and the project-default mark. The detail pane re-reads one version and shows 基本信息, 模型参数, 团队资产 (ordered skills, knowledge set, single memory or none), the execution-policy summary, and generic type-extension values (unrecognized values render as 服务端扩展字段). The page owns no governance action, distinguishes signed-out / not-ready / authorization / protocol failure from an empty project list, and clears the previous project's cards, detail and selection on project or account switches.

The `/client` entry exports `apply`, `inject`, `PlatformEntry`, `PlatformSurface`, and `PlatformDemoController`. The Web Bundle loads the plugin as `ui-ai-coding-platform` in `cordis.patch.yml`.


## Cloud workspaces workbench

- The 云工作空间 entry opens `CloudWorkspacesView`, a three-pane workbench: project/Workspace/branch plus the remote file tree on the left, the current DSH Session binding in the middle, and `Preview`/`Changes`/`Run` panels on the right; under 960px the side panes become drawers. Static HTML previews render inside a sandboxed iframe with the server-declared CSP, and the view renders explicit busy, revision-conflict, signed-out, and stream (live/reconnecting/resync) states. All data comes from the `cloudWorkspaces` Remote namespace; the view keeps no local fixture objects.

## Model Experience

### Native DSH conversation

#### What the model sees

This browser UI adds no model-visible content and makes no `DSH Session` call; the Host package owns session-scoped knowledge retrieval. The “Return to DSH session” action only closes the overlay; the native DSH conversation remains responsible for prompt assembly and any authorized project or task context.

#### Token effect

The demo consumes no model tokens. Team Skill installation does not enter a model request; a production implementation will account for authorized project context through the native Session request and the collector will report resulting usage.

#### KV Cache effect

The UI does not change the native Session prefix or provider cache behavior; Host-injected knowledge references are logged by the Host package.

## Known Limitations and Deferred Work

- Project metadata and access are service-backed; task, Run, Git, Workspace, code-source, and project-governance workflows are outside this plugin's scope. Telemetry and Agent configuration retain browser-local demo descriptions and have no service-backed persistence or governance workflow. Memory and knowledge listing, search, preview, and memory mutations use the Host Remote, while the local UI does not store knowledge or memory content or tokens.
- Team Skill operations require the Host `teamSkills` Remote and an available service; the Client reports `not-ready` or failure instead of inferring local success.
- The local UI does not execute Skill content or expose filesystem paths and access tokens; installation and quarantine remain Host responsibilities.
