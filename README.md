# 第一方 AI Coding 项目插件

本目录是交给 AI coding 服务端同事进行 API 开发和 HTTP 联调的第一方插件源码快照。插件由 DSH Host 侧桥接和 Web Client 协作台两部分组成，源码分别位于 `host/` 和 `client/`。`apps/team-skill-service` 内存服务不在本交付物中；它只用于原仓库的本地联调测试，不能作为生产后端实现。

接口和交互的确认文档随交付物保存在 `docs/`，包括项目管理和知识库设计/API 文档；实现以这些文档和源码共同约束。

## 交付范围

- `host/src`：账号会话、项目读取、项目授权资产读取、Team Skill 目录、版本授权、ZIP 校验、原子安装、卸载、隔离和 Typert Remote 网关。
- `host/src/knowledge-loop.ts`：DSH 原生 `agent/pre-step` 自动检索、`knowledge-search` 会话事件和当前轮次取消；知识库列表、检索与预览通过 Host Remote 统一请求。
- `host/tests`：Host、HTTP 客户端、Remote 装配和真实 HTTP 夹具测试。
- `client/src`：协作台入口、账号状态、按组织分组的项目选择器、项目详情只读页、Team Skill/知识库/记忆视图和失败状态呈现。
- `client/tests`：浏览器端项目恢复、原子切换、授权过滤和 Team Skill 操作测试。

当前不包含项目创建、编辑、归档、成员管理或资产关联写入；这些治理操作由独立 Web 管理后台交付。也不包含代码源、Git、Workspace、Run、任务、Prompt 注入或 DSH 原生会话改造。

## 运行依赖

源码快照依赖 DeepSeek Harness monorepo 的 Cordis、Typert、凭据、Workspace、Skill 和 UI 基础包，不能在本目录直接执行 `pnpm install`。联调时将两个目录放回原仓库对应位置，或在后端同事的集成分支中保持相同 workspace 包名：

```text
packages/platform/ai-coding-platform   <- host
packages/client/ui-ai-coding-platform  <- client
```

Node.js 使用仓库要求的 `^22.19.0 || >=24.0.0`，包管理器使用 pnpm 11。Web Bundle 在 `packages/bundle/web-app/cordis.patch.yml` 中以 `ui-ai-coding-platform` 装配，Host 配置行以 `ai-coding-platform` 装配。

## Host 配置与令牌

Host 配置字段如下：

| 字段 | 用途 |
| --- | --- |
| `apiBaseUrl` | AI coding 服务 URL，必须包含 `/v1`，对应环境变量 `DSH_AI_CODING_PLATFORM_API_URL`。 |
| `accessToken` | 可选的 Host 管理静态服务令牌，对应 `DSH_AI_CODING_PLATFORM_ACCESS_TOKEN`；账号登录后优先使用凭据中的授权记录。 |
| `stateDirectory` | Host 安装记录、隔离副本和本地状态目录。 |
| `globalSkillRoot` | DSH 全局 Skill 发现目录。 |

浏览器只得到账号摘要、项目摘要、资产摘要和安装结果，不会得到 Access Token、Refresh Token、下载 URL、本机路径或 ZIP 内容。Host 将授权记录保存到 DSH credentials，并在恢复项目或读取目录前重新鉴权；服务端同时拒绝两个令牌时清除凭据并返回 `signed-out`。

## 服务端 HTTP 请求

所有请求由 Host 加 `Authorization: Bearer <access_token>`。`project_id` 是服务端生成的不透明资源 ID，只用于服务端鉴权和资源选择，不能当作权限凭据，也不能写入 DSH 原生会话。

| 方法 | 路径 | 调用时机和要求 |
| --- | --- | --- |
| `POST` | `/v1/auth/login` | `{ username, password }`；返回 Access/Refresh Token、过期时间、账号和组织摘要。 |
| `POST` | `/v1/auth/refresh` | `{ refresh_token }`，必须带 `Idempotency-Key`，返回轮换后的令牌。 |
| `POST` | `/v1/auth/logout` | 撤销当前会话，必须带 `Idempotency-Key`。 |
| `POST` | `/v1/auth/change-password` | `{ current_password, new_password }`，必须带 `Idempotency-Key`。 |
| `GET` | `/v1/me` | 当前账号和有效组织成员关系。 |
| `GET` | `/v1/me/access-summary` | 当前账号可见组织、项目、资产和管理范围。 |
| `GET` | `/v1/me/projects` | 只返回当前账号可使用的 `active` 项目；无项目返回空 `items`。 |
| `GET` | `/v1/me/projects/{project_id}` | 返回项目基础摘要及同时通过项目授权和资产自身授权的资产摘要。 |
| `GET` | `/v1/team-skills?project_id={project_id}` | 项目级 Skill 目录；缺少项目 ID 必须拒绝。 |
| `POST` | `/v1/team-skill-installations` | 请求体包含 `skill_id`、`version`、`project_id`、`scope`、可选 `workspace_id` 和环境摘要；必须带 `Idempotency-Key`。 |
| `POST` | `/v1/team-skills/release-status` | 批量提交 `{ skill_id, version, project_id }`，服务端返回仍可见的版本。 |
| `POST` | `/v1/team-skill-installations/{operation_id}/events` | 上报 `event_sequence` 和 `status`；幂等键为 `{operation_id}:{event_sequence}`。 |

安装授权响应必须包含短期下载 URL、过期时间、ZIP SHA-256、大小和每个允许文件的摘要。Host 在写入前校验路径、摘要、`SKILL.md` frontmatter，并以原子方式写入 DSH Skill 根目录。受管文件被本地修改时，必须由用户明确确认才可替换或卸载；撤回版本移出发现根并标记为隔离。

## 项目与权限语义

- 生命周期只有 `draft -> active -> archived`；归档是终态，插件只消费 `active` 项目。
- `admin` 可使用服务端返回的全部 active 项目；`manager` 只能使用其有效组织内项目；`member` 只有明确项目成员关系才可使用项目级资产。
- 项目关联不扩大 Skill、知识库或记忆自身的 `platform`、`organization`、`project`、`account` 可见范围；服务端每次请求重新鉴权。
- 项目选择器按组织分组。浏览器只按服务地址和 `user_id` 保存不透明 `project_id`，恢复前必须重新读取 active 列表；失效 ID 立即删除。
- 进入项目详情不会切换当前项目。只有下拉框选择才切换。
- 切换先清空旧项目资产，再请求新项目详情和授权摘要；并发旧响应不得覆盖新选择。`403` 作为当前操作失败展示，项目专用的 `PROJECT_NOT_MEMBER` 或 `RESOURCE_NOT_FOUND` 才会清除项目并刷新列表。
- 无当前项目时，项目级 Skill/知识/记忆显示空状态，不展示旧缓存；平台、组织和账号级资产由各资产模块按自身授权决定。

服务端错误码由 Host 映射为明确失败状态：`401 AUTH_REQUIRED/TOKEN_EXPIRED/TOKEN_REVOKED` 清理凭据并回到登录页；普通 `403 FORBIDDEN` 保留其他授权内容；`404 PROJECT_NOT_MEMBER/RESOURCE_NOT_FOUND` 清除失效项目；`422 PROJECT_REQUIRED` 要求先选项目；`503 SERVICE_UNAVAILABLE` 显示服务不可用。任何网络、解析、授权或安装失败都不能使用本地 Fixture 冒充成功。

## Web Client 入口

`client/src/client/index.ts` 注册 `sidebar.footer.action` 和 `shell.overlay`，导出 `apply`、`inject`、`PlatformEntry`、`PlatformSurface`、`PlatformDemoController`。所有账号和项目方法都通过 Host 的 `teamSkills` Remote 调用，浏览器不直接访问服务端，不持有令牌。

知识库已接入当前项目选择、显式检索、每轮自动检索、引用预览、会话事件和当前轮取消；后台治理写入口不在本仓库。记忆、数据采集和 Agent 配置仍是演示视图。只有项目/资产 ID 同时出现在服务端访问摘要中时才渲染项目级内容；项目上下文不注入 DSH 原生 Session。

## 本地联调与校验

在原 DeepSeek Harness 仓库根目录执行：

```sh
pnpm install
pnpm exec vitest run packages/platform/ai-coding-platform/tests packages/client/ui-ai-coding-platform/tests
pnpm exec tsc -b packages/platform/ai-coding-platform/tsconfig.json packages/client/ui-ai-coding-platform/tsconfig.json
pnpm --filter @deepseek-ai/dsh-client-ui-ai-coding-platform run bundle
```

内存服务由原仓库 `apps/team-skill-service` 启动，默认监听 `http://127.0.0.1:4100`，健康检查为 `/health`。设置 `DSH_AI_CODING_PLATFORM_API_URL=http://127.0.0.1:4100/v1` 后启动 Web Bundle。知识库默认使用内存文本匹配 fixture，不连接真实 WeKnora；文件导入只接受 JSON 文件名描述，不保存 multipart 字节。服务还不提供生产数据库、OIDC、对象存储、游标分页、FAQ/Wiki/Graph CRUD 或完整审计；生产实现必须以 `docs/服务API-知识库需求文档.md` 为准。

## 后端交接清单

1. 实现上述账号、项目、资产双重鉴权、Team Skill 目录/安装和操作事件接口。
2. 保证每个请求重新检查账号状态、组织范围、项目状态、成员关系和资产自身授权。
3. 所有写入支持 `Idempotency-Key` 与 `If-Match`/`expected_revision`；过期修订返回 `409 REVISION_CONFLICT`，重复键同请求返回首次结果，不同请求返回 `409 IDEMPOTENCY_CONFLICT`。
4. 项目、成员、资产关联和拒绝结果写入审计，不记录 Token、密码、Prompt、代码正文、本机路径或完整请求体。
5. 用真实服务替换内存夹具后，重新执行插件和后台的 HTTP、桌面及 390x844 浏览器验收。
