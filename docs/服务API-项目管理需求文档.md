# 服务API-项目管理需求文档

## 1. 目的与实现边界

本文向 AI coding 服务端开发者提出项目资源、项目成员、项目资产关联和项目审计 API 需求，供第一方 AI coding 插件与 Web 管理后台消费。

服务端是项目、组织关系、项目权限、资产关联、修订号、幂等结果和审计的唯一权威。本文是接口需求，不要求本地内存联调服务扩展为生产服务。

本轮不定义项目任务、Run、Git、Workspace、Agent Pool、MCP、预算、交付审核、代码源或资产上传接口。Skill、知识库和记忆的内容及上传接口由各资产模块负责；本文件只定义项目与资产的关联。

## 2. 通用协议

- API 前缀为 `/v1`，请求和响应使用 JSON，时间使用 UTC ISO 8601。
- 受保护请求使用 `Authorization: Bearer <access_token>`；Token 生命周期沿用账号权限 API。
- 每个响应包含 `request_id`；错误包含稳定 `code`、用户可读 `message` 和可选的最小 `details`。
- 所有创建、编辑、状态动作、成员关系和资产关联写请求必须带 `Idempotency-Key`。
- 竞争资源写请求必须带 `If-Match` 或 JSON 字段 `expected_revision`；服务端拒绝过期修订，不覆盖其他写入。
- 列表接口支持 `page_size`、`page_token`、`sort` 和资源域筛选，返回 `items`、`next_page_token` 和查询修订信息。
- 列表过滤无权资源；详情和写请求再次执行对象级鉴权。

## 3. 数据模型

### 3.1 Project

```text
project_id       服务端生成的不透明 ID
organization_id  所属组织不透明 ID，创建后不可变
name             规范化项目名称
description      可选描述
status           draft | active | archived
created_by       创建账号不透明 ID，仅审计和展示
created_at       UTC ISO 8601 时间
updated_at       UTC ISO 8601 时间
revision         单调项目修订号
```

项目名称去除首尾空白后必须为 1-80 个字符，不得包含控制字符或路径分隔符。同一组织内 `draft` 和 `active` 名称大小写不敏感唯一；归档名称保留且不能被复用。项目 ID 不得由客户端提交。

### 3.2 ProjectMembership

```text
project_id       项目不透明 ID
organization_id  项目所属组织不透明 ID
user_id          成员账号不透明 ID
status           active | removed
created_at       UTC ISO 8601 时间
updated_at       UTC ISO 8601 时间
revision         单调关系修订号
```

只有所属组织内的 active `member` 可以写入项目成员关系。`admin` 和 `manager` 通过全局角色及组织范围获得治理能力，不需要建立重复项目成员关系。

### 3.3 ProjectAssetRelation

```text
project_id       项目不透明 ID
asset_type       skill | knowledge | memory
asset_id         资产不透明 ID
relation_kind    reference | context
created_at       UTC ISO 8601 时间
updated_at       UTC ISO 8601 时间
revision         单调关联修订号
```

同一项目内同一 `asset_type + asset_id` 只能有一条关联。关联不改变资产自身 `platform`、`organization`、`project` 或 `account` 可见范围；服务端必须再次调用或执行对应资产模块的授权检查。

## 4. 授权规则

| 角色 | 项目列表/详情 | 项目治理写入 | 项目成员使用 |
|---|---|---|---|
| `admin` | 全平台可见范围 | 全平台 | 全部 active 项目中服务端返回的资产 |
| `manager` | 账号加入的全部有效组织 | 这些组织内的项目 | 这些组织中服务端返回的资产 |
| `member` | 仅明确可见的 active 项目 | 无 | 仅有 active 项目成员关系的项目 |

`draft` 只对 `admin` 和所属组织 `manager` 可见；`active` 才能被插件项目列表返回；`archived` 仅后台治理范围内可见且只读。项目属于单一组织，`organization_id` 不可迁移。

项目资产读取和 Skill 目录/安装必须同时满足项目访问权限和资产自身授权。项目关联、项目成员关系和组织成员关系不能扩大资产原权限。

## 5. 插件读取 API

### 5.1 当前账号项目列表

`GET /v1/me/projects`

默认只返回当前账号可使用的 `active` 项目，支持 `organization_id`、名称关键字、`page_size`、`page_token` 和稳定排序筛选。组织筛选只缩小返回列表，不要求客户端先选择组织。

响应中的项目摘要至少包含：

```json
{
  "project_id": "proj_opaque_id",
  "organization_id": "org_opaque_id",
  "organization_name": "研发组织",
  "name": "协作项目",
  "status": "active",
  "updated_at": "2026-08-31T00:00:00Z",
  "revision": 4
}
```

不得返回草稿、归档、无权项目、隐藏项目数量或隐藏项目名称。无项目时返回空 `items`，不是错误。

### 5.2 当前账号项目详情

`GET /v1/me/projects/{project_id}`

仅允许读取当前账号可使用的 active 项目。响应返回项目非敏感摘要和当前账号同时满足项目关联、资产自身授权的资产摘要：

```json
{
  "project": {
    "project_id": "proj_opaque_id",
    "organization_id": "org_opaque_id",
    "organization_name": "研发组织",
    "name": "协作项目",
    "description": "项目说明",
    "status": "active",
    "updated_at": "2026-08-31T00:00:00Z",
    "revision": 4
  },
  "assets": [
    {
      "asset_type": "skill",
      "asset_id": "skill_opaque_id",
      "name": "代码审查",
      "relation_kind": "reference",
      "updated_at": "2026-08-31T00:00:00Z",
      "revision": 2
    }
  ],
  "request_id": "req_opaque_id"
}
```

不得返回资产全文、知识片段、记忆内容、Prompt、代码、Token、凭据、本机路径或 Git 地址。项目失权、归档或不可见时返回 `404 PROJECT_NOT_MEMBER` 或 `404 RESOURCE_NOT_FOUND`。

### 5.3 项目级 Skill 请求

`GET /v1/team-skills?project_id={project_id}` 和现有 Skill 安装请求必须显式携带 `project_id`。服务端必须校验当前账号、项目状态、项目组织范围、项目成员关系和 Skill 自身可见范围。

缺少项目 ID 返回 `422 PROJECT_REQUIRED`；项目不可见返回 `404 PROJECT_NOT_MEMBER` 或 `404 RESOURCE_NOT_FOUND`；不能以 Skill 的组织可见性替代项目级授权。

项目 ID 不进入 DSH 原生会话。未来云端任务若属于项目，创建、查询、更新和取消都必须显式携带 `project_id` 并再次鉴权。

## 6. 管理项目 API

### 6.1 项目列表和详情

| 方法 | 路径 | 权限和用途 |
|---|---|---|
| `GET` | `/v1/admin/projects` | `admin` 全平台；`manager` 自己有效组织；支持组织、状态、名称和游标分页 |
| `POST` | `/v1/admin/projects` | `admin` 或有效组织 `manager` 创建草稿 |
| `GET` | `/v1/admin/projects/{project_id}` | `admin` 或项目所属组织 `manager` |
| `PATCH` | `/v1/admin/projects/{project_id}` | 仅修改名称和描述 |
| `POST` | `/v1/admin/projects/{project_id}:activate` | 草稿转 active |
| `POST` | `/v1/admin/projects/{project_id}:archive` | active 转 archived |

`GET /v1/admin/projects` 默认返回 `draft` 和 `active`；读取归档项目必须显式请求 `status=archived`。服务端不得把筛选条件当成权限依据。

创建请求：

```json
{
  "organization_id": "org_opaque_id",
  "name": "协作项目",
  "description": "项目说明"
}
```

创建响应必须返回服务端生成的 `project_id`、`status: draft`、规范化名称、`revision`、创建人和时间。`organization_id`、`project_id`、`created_by` 和创建时间创建后不可修改。

编辑、激活和归档请求均必须带当前 `expected_revision` 与 `Idempotency-Key`。只允许 `draft -> active -> archived`；`draft` 不直接归档，`archived` 不可恢复。

### 6.2 项目成员

| 方法 | 路径 | 权限 |
|---|---|---|
| `GET` | `/v1/admin/projects/{project_id}/members` | `admin` 或项目所属组织 `manager` |
| `PUT` | `/v1/admin/projects/{project_id}/members/{user_id}` | 为所属组织 active `member` 建立或更新关系 |
| `DELETE` | `/v1/admin/projects/{project_id}/members/{user_id}` | 移除项目成员关系 |

`PUT` 请求至少包含当前成员关系修订号：

```json
{
  "expected_revision": 5
}
```

当前后台客户端把修订号放在 `If-Match` 请求头，并以空 JSON 对象提交 `PUT`；生产服务必须把 `If-Match` 与等价的 `expected_revision` 请求字段视为同一并发检查，不得只接受其中一种而使已交付客户端失效。

成员写入必须校验目标用户属于项目所属组织、账号 active 且全局角色为 `member`。归档项目拒绝所有成员写入。成员变更与审计记录必须同一服务端操作提交，不产生部分成功。

### 6.3 项目资产关联

| 方法 | 路径 | 权限 |
|---|---|---|
| `GET` | `/v1/admin/projects/{project_id}/assets` | `admin` 或项目所属组织 `manager`，返回授权摘要 |
| `POST` | `/v1/admin/projects/{project_id}/assets` | 新增单条资产关联 |
| `PATCH` | `/v1/admin/projects/{project_id}/assets/{asset_type}/{asset_id}` | 修改单条关系类型 |
| `DELETE` | `/v1/admin/projects/{project_id}/assets/{asset_type}/{asset_id}` | 解除单条关联 |

新增请求至少包含：

```json
{
  "asset_type": "skill",
  "asset_id": "skill_opaque_id",
  "relation_kind": "context",
  "expected_revision": 3
}
```

当前后台客户端对新增关联同时发送 `If-Match` 和 `expected_revision`，对关系修改和解除关联发送 `If-Match`；三种写法都使用 `Idempotency-Key`，服务端应以被采用的修订号执行同一冲突检查。

关系修改请求携带新的 `relation_kind` 和当前关系 `expected_revision`。服务端必须拒绝未知资产类型或关系类型，返回 `422 VALIDATION_ERROR`；不得静默转换、忽略或保存客户端无法解释的类型。

资产关联写入必须同时校验操作者项目治理权限、资产模块管理权限、资产可见范围和项目组织兼容性。归档项目拒绝关联新增、修改和解除。每条关系单独幂等、单独修订和单独审计，不提供批量写接口。

### 6.4 项目审计

项目详情审计页使用统一接口 `GET /v1/admin/authorization-audits?project_id={project_id}`，并支持 `from`、`to`、`actor_user_id`、`action`、`result`、`page_size`、`page_token` 和 `sort`。

当前项目详情页只传 `project_id`，只显示服务端返回的基础审计字段；当前全局“授权审计”页只提供 `action` 筛选。时间、操作者、结果、游标和排序筛选仍是生产服务接口要求，不能从当前内存服务或页面控件缺失推导为可省略的生产能力。

`admin` 可查询全平台；`manager` 的查询自动限制在自己有效组织；`member` 返回 `404` 或 `403`，不得泄露审计存在性。至少记录项目创建、编辑、激活、归档、成员变更、资产关联变更和权限拒绝。

## 7. 写入语义

相同资源、相同 `Idempotency-Key` 和相同请求内容必须返回第一次结果，包括失败结果；相同幂等键提交不同请求内容返回 `409 IDEMPOTENCY_CONFLICT`。

`expected_revision` 或 `If-Match` 过期返回 `409 REVISION_CONFLICT`，响应只返回当前资源可安全公开的修订号和重读提示，不返回隐藏资源数据。服务端不得覆盖较早修改，不得部分提交。

成功写入后服务端先提交资源和审计，再返回最新资源/关系、最新修订号和 `request_id`。后台和插件以响应或重新读取为准，不推断本地成功。

## 8. 错误码

| 错误码 | HTTP | 语义 |
|---|---:|---|
| `AUTH_REQUIRED` | 401 | 缺少访问令牌 |
| `TOKEN_EXPIRED` / `TOKEN_REVOKED` | 401 | 会话不可用 |
| `ACCOUNT_SUSPENDED` | 403 | 账号已停用 |
| `FORBIDDEN` | 403 | 资源可见但当前角色不能操作 |
| `PROJECT_REQUIRED` | 422 | 项目级请求缺少 `project_id` |
| `PROJECT_NOT_MEMBER` | 404 | 当前账号无项目使用关系 |
| `RESOURCE_NOT_FOUND` | 404 | 资源不存在或对当前账号不可见 |
| `REVISION_CONFLICT` | 409 | 修订号过期 |
| `IDEMPOTENCY_CONFLICT` | 409 | 幂等键对应不同请求 |
| `VALIDATION_ERROR` | 422 | 字段、角色、关系或状态转移非法 |
| `SERVICE_UNAVAILABLE` | 503 | 服务依赖未就绪 |

错误详情不得包含隐藏项目、成员、资产、审计或其数量。项目名称重复、组织无效、归档项目写入、未知状态转移和未知资产类型均属于 `VALIDATION_ERROR` 或对应稳定资源错误。

## 9. 审计和安全

项目创建、编辑、激活、归档、成员添加/更新/移除、资产关联添加/修改/解除和权限拒绝必须记录审计。

审计至少包含 `request_id`、幂等键、操作者 ID、组织 ID、项目 ID、目标资源 ID、动作、结果、错误码、变更前后非敏感摘要和 UTC 时间。审计不得保存密码、Token、Cookie、Prompt、代码正文、Git 地址、本机路径、环境变量值或完整请求体。

服务端必须防止通过组织、项目、用户、资产和审计接口枚举无权资源。项目关联不能扩大资产权限，项目成员关系不能替代资产自身授权。

## 10. 联调服务和验收

本地内存服务只需实现插件和后台当前已开发模块所需的认证、用户项目读取、后台项目 CRUD/状态动作、项目成员、项目资产关联、Skill 项目范围和审计最小语义，不要求生产数据库、企业 OIDC、对象存储或部署。

联调验收至少覆盖：admin 创建草稿并激活项目、manager 组织范围、member 项目可见性、项目切换后的 Skill/知识库/记忆过滤、资产双重鉴权、成员撤权、项目归档、`401/403/404`、`409 REVISION_CONFLICT`、`409 IDEMPOTENCY_CONFLICT` 和失败不成功。

### 10.1 当前第一方调用与内存服务映射

- Host 当前调用 `GET /v1/me/projects` 和 `GET /v1/me/projects/{project_id}`，项目列表不传分页、排序或组织筛选参数，直接消费完整 `items`；内存服务的该端点也不实现这些查询参数。
- Host 的项目级 Skill 目录、发布状态和安装请求显式携带 `project_id`；安装请求还带 `Idempotency-Key`，本地卸载只使用 Host 保存的 `local_installation_id`。
- 后台通过同源代理调用 `/v1/admin/projects` 及其成员、资产和审计子路径；项目列表只发送 `organization_id`、`status`、`name` 三类筛选，不提供分页控件，写请求使用 `If-Match` 和 `Idempotency-Key`。
- 当前资产关联页直接提交不透明 `asset_id`，没有资产模块候选查询；服务端仍必须执行操作者项目治理权限、资产管理权限、资产可见范围和组织兼容性检查。
- 当前内存服务的项目列表和成员、资产、审计列表返回完整 `items`，不返回 `next_page_token`；审计只实现 `organization_id`、`action`、`project_id` 筛选，记录字段不包含生产要求的幂等键和变更前后摘要。
- 当前内存服务缺少项目 ID 的 Skill 目录和发布状态请求返回 `422 VALIDATION_ERROR`，安装请求返回 `422 VALIDATION_REQUIRED`；这些是夹具特有的校验码，不能替代生产接口规定的 `PROJECT_REQUIRED`。
- 当前内存服务缺少 `Idempotency-Key` 返回 `400 IDEMPOTENCY_KEY_REQUIRED`，不主动模拟 `503 SERVICE_UNAVAILABLE`；网络错误仍用于验证插件和后台的失败状态。
- 当前内存服务的 `access-summary` 会把账号可见的已发布 Skill 补入每个可访问项目，`GET /v1/team-skills?project_id=...` 在项目鉴权后按 Skill 自身可见性返回目录，未实现显式项目资产关系过滤。生产服务必须按显式项目关联与资产自身授权双重过滤，不能复制该夹具行为。
- 当前内存服务在项目激活和移除成员时没有统一重复检查组织是否已归档；生产服务必须对每次项目治理写请求检查组织状态，并在组织归档后拒绝所有项目成员和资产关系写入。

真实服务端由后端同事按本文实现；插件和后台不得依赖本地 Fixture 绕过真实 HTTP 响应。
