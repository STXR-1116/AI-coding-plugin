# 服务API-知识库需求文档

## 1. 文档目的

本文是 AI coding 服务端实现项目知识库能力的接口和数据需求，供后端、插件和 Web 管理后台联调使用。

第 1 至 11 节以及第 13 节描述生产服务必须提供的接口、数据和验收条件；第 12 节单独描述当前本地内存夹具的联调范围和已知差异。

平台服务负责身份、组织、项目成员、项目到知识库映射、平台权限、操作状态和审计；WeKnora 负责正文、Chunk、文件解析、Embedding、BM25/RRF、Rerank、FAQ、Wiki、Graph 和原生异步处理。

平台必须通过 WeKnora 公共 REST 或 MCP/REST 网关调用，不得直接访问 WeKnora 数据库、`internal` 包或复制正文、Chunk、向量和图谱。平台不实现第二套知识检索算法。

插件和后台只接触平台不透明 ID。项目生命周期、项目角色和资产隔离的总规则见 [服务API-项目管理需求文档](服务API-项目管理需求文档.md)；插件交互见 [插件-知识库设计文档](插件-知识库设计文档.md)；后台页面见 [后台管理-知识库设计文档](https://github.com/STXR-1116/AI-coding-manage/blob/main/docs/%E5%90%8E%E5%8F%B0%E7%AE%A1%E7%90%86-%E7%9F%A5%E8%AF%86%E5%BA%93%E8%AE%BE%E8%AE%A1%E6%96%87%E6%A1%A3.md)。

## 2. WeKnora 能力基线

WeKnora 知识库类型为 `document`、`faq` 和 `wiki`。知识内容可以来自文件、URL、手工 Markdown，创建后通过异步任务完成读取、分块、Embedding/BM25、摘要、问题、标签、Graph 或 Wiki 后处理。

WeKnora 原生界面提供知识库列表、设置、文档网格/列表、文件夹、标签、批量删除/重解析、文档预览/下载、FAQ/Wiki/Graph 和聊天知识库选择。平台后台复刻这些管理能力，但以平台 DTO 和平台授权为准。

检索使用 WeKnora hybrid-search，支持向量、关键词、RRF、Rerank、MMR、去重、父子 Chunk 和上下文扩展。多 KB 请求要求 Embedding 能力兼容；不兼容时平台按能力分组并行并执行有限合并。

WeKnora 的访问失败语义由平台转换为平台稳定错误：未认证 `401`、平台无权 `403`、不存在 `404`、依赖异常 `503`。平台不能以本地快照或 Fixture 替代外部成功。

本需求基于 `G:\WeKnora` 的 CodeGraph 和源码核对：知识库实体位于 `internal/types/knowledgebase.go:59`，知识内容实体位于 `internal/types/knowledge.go:124`；统一访问守卫位于 `internal/middleware/kb_access.go:226`，共享权限服务位于 `internal/application/service/kbshare.go:75`，知识路由装配位于 `internal/router/routes_knowledge.go:182`；导入和处理流程位于 `internal/application/service/knowledge_create.go:24` 与 `internal/application/service/knowledge_process.go:3160`；检索和多 KB 组合位于 `internal/application/service/knowledgebase_search.go:93`、`internal/application/service/knowledgebase_search_storegroup.go:198` 和 `internal/application/service/knowledgebase_search_results.go:14`；原生管理界面和选择器位于 `frontend/src/views/knowledge/KnowledgeBase.vue`、`frontend/src/components/KnowledgeBaseSelector.vue` 与 `frontend/src/views/knowledge/components/UploadConfirmDialog.vue`。

这些源码位置用于确认实体、授权、处理和检索职责，不构成平台对 WeKnora `internal` 包的编译依赖。适配器必须使用 WeKnora 公共 REST/MCP 接口，并为外部字段建立平台 DTO 映射。

## 3. 数据模型

### 3.1 组织连接

`OrganizationWeKnoraConnection` 记录一个平台组织对应的 WeKnora 租户和连接：

| 字段 | 要求 |
|---|---|
| `organization_id` | 平台组织不透明 ID，唯一 |
| `weknora_tenant_id` | WeKnora 租户 ID，仅服务端使用 |
| `base_url` | 组织 WeKnora REST/MCP 网关地址，协议和主机名经配置校验 |
| `credential_ref` | 服务端密钥管理系统引用，不返回密钥内容 |
| `status` | `configured`、`unavailable` 或 `unconfigured` |
| `revision` | 单调修订号 |
| `last_checked_at` | 最近连接测试时间 |
| `last_error_code` | 最近外部错误摘要，可为空 |

每个组织只有一个有效连接。只有 `admin` 能创建、修改、测试和轮换连接；manager 和 member 不能读取凭据或租户字段。

### 3.2 平台知识库

`KnowledgeBase` 是平台的组织级资源，至少包含：

| 字段 | 要求 |
|---|---|
| `knowledge_base_id` | 平台生成的不透明 ID |
| `organization_id` | 创建后不可变 |
| `weknora_kb_id` | 服务端映射字段，不向客户端返回 |
| `name`、`description` | 名称和描述由 WeKnora 返回后规范化保存 |
| `type` | `document`、`faq` 或 `wiki` |
| `embedding_model_id`、`summary_model_id` | 外部模型 ID 快照，不由平台固定枚举 |
| `state` | `active`、`unavailable` 或 `deleting` |
| `external_revision` | WeKnora 返回的版本或更新时间快照，可为空 |
| `revision` | 平台并发控制修订号 |
| `created_at`、`updated_at` | UTC ISO 8601 |
| `last_error_code`、`last_checked_at` | 外部异常和确认时间 |

外部删除确认后资源不可恢复；平台不得按名称自动替换 ID。WeKnora 404、连接 5xx、超时或该知识库自身的外部能力不可用会将资源标为 `unavailable`，不删除映射记录。仅因同一检索请求中的多个 KB 能力不兼容时，不改变 KB 状态，按检索规则分组处理。

文档、FAQ 条目和 Wiki 页面也使用平台生成的不透明资源 ID；WeKnora `knowledge_id` 及其他外部资源 ID 只保存在服务端映射中。预览、下载和引用接口接收平台资源 ID，由服务端解析后调用 WeKnora。

### 3.3 项目映射

`ProjectKnowledgeBase` 表示一个项目对组织知识库的使用关系：

| 字段 | 要求 |
|---|---|
| `project_id` | 平台项目不透明 ID |
| `knowledge_base_id` | 平台知识库 ID |
| `status` | `active`、`unavailable` 或 `unlinked` |
| `revision` | 映射自身修订号 |
| `created_by`、`created_at`、`updated_at` | 审计和展示 |

项目与知识库是多对多关系，知识库可以复用到同组织多个项目。只能关联同组织的 draft 或 active 项目；归档项目映射只读。解除映射只删除平台关系，不删除外部 KB。

### 3.4 异步操作

`KnowledgeOperation` 追踪外部长任务：

```text
queued -> running -> succeeded
                 \-> failed
                 \-> cancelled
```

操作至少包含 `operation_id`、`operation_type`、目标平台资源 ID、`status`、外部请求/资源 ID、开始/结束时间、错误摘要、触发者、幂等键指纹和资源 revision。重试创建新操作和新幂等键，原操作不可覆盖。

### 3.5 审计事件

平台审计记录创建、配置更新、导入、重解析、文档删除、标签/文件夹/FAQ/Wiki 变更、项目关联/解除、外部删除、权限拒绝、修订冲突和外部失败。

审计至少包含 `request_id`、操作者、组织、项目、平台资源 ID、动作、结果、错误码、revision、幂等键指纹、外部请求/操作 ID、变更前后非敏感摘要和 UTC 时间。知识检索事件另行记录模型可见查询、选中 KB、每 KB 状态、资源 ID、受限片段和引用元数据，不能把它当作可复用缓存。

## 4. 认证、授权和调用身份

客户端请求使用平台 Bearer Token 或后台 HttpOnly Session 代理。平台每次请求重新鉴权账号、组织、项目状态、项目成员关系、知识库映射和外部可用性；不得信任客户端提交的用户 ID、组织 ID 权限声明、WeKnora 租户或 WeKnora KB ID。

平台能力分为 `knowledge.read` 和 `knowledge.manage`：

| 角色 | 读取/检索 | 管理内容与映射 | 连接/租户 |
|---|---:|---:|---:|
| `admin` | 全平台治理范围 | 全平台 | 配置和轮换 |
| `manager` | 已加入的有效组织 | 其组织/项目范围 | 无 |
| `member` | 仅 active 项目成员关系 | 无 | 无 |

平台使用组织级 WeKnora 集成身份调用外部 API。该身份在 WeKnora 中拥有平台代理所需的最低 owner/admin 能力；平台用户不被同步为 WeKnora 用户，也不修改 WeKnora 原生租户 RBAC。平台服务端先检查 `read/manage`，再决定是否使用集成身份触发外部管理操作。

## 5. API 通用约定

所有平台接口位于 `/api/v1`，使用 JSON DTO；文件上传使用 `multipart/form-data`，URL/Markdown 使用 JSON。响应包含 `request_id`，时间为 UTC ISO 8601。

列表接口使用游标分页和稳定排序：`page_size`、`page_token`、`sort`、过滤字段由资源接口声明。服务端过滤无权资源，不返回隐藏资源数量或名称。

创建、更新、导入、重解析、文档删除、项目关联/解除和外部删除必须同时携带 `Idempotency-Key` 与 `If-Match` 或 `expected_revision`。集合创建使用所属组织集合 revision，初始值为 `0`；资源写入使用目标资源当前 revision。

相同幂等键和相同请求重放第一次响应，包括失败响应；相同键提交不同请求内容返回 `409 IDEMPOTENCY_CONFLICT`。过期 revision 返回 `409 REVISION_CONFLICT`。服务端不得覆盖并发修改或部分提交。

## 6. 组织连接接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/organizations/{organization_id}/weknora-connection` | admin | 返回状态、地址摘要、租户显示名和 revision，不返回凭据/租户 ID |
| `PUT` | `/organizations/{organization_id}/weknora-connection` | admin | 配置或轮换地址和服务端密钥引用 |
| `POST` | `/organizations/{organization_id}/weknora-connection:test` | admin | 测试连接、租户和能力，不改变知识库数据 |
| `GET` | `/organizations/{organization_id}/weknora-capabilities` | admin/manager | 返回模型和部署能力列表 |

连接测试失败返回 `503 SERVICE_UNAVAILABLE` 和可诊断错误摘要，不保存“连接成功”。能力列表必须从 WeKnora 实时读取或明确标记 unavailable，不能维护固定模型枚举。

## 7. 知识库接口

### 7.1 列表、创建和详情

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/organizations/{organization_id}/knowledge-bases` | admin/manager | 组织范围列表，支持类型、状态、名称、游标和稳定排序 |
| `POST` | `/organizations/{organization_id}/knowledge-bases` | admin/manager | 创建 WeKnora KB，返回 `202` 和操作资源 |
| `GET` | `/knowledge-bases/{knowledge_base_id}` | admin/manager | 返回平台 DTO 和实时外部状态 |
| `PATCH` | `/knowledge-bases/{knowledge_base_id}` | admin/manager | 更新名称、描述、模型和平台支持的基础配置 |
| `DELETE` | `/knowledge-bases/{knowledge_base_id}` | admin/manager | 二次确认后异步删除外部 KB，并影响所有项目映射 |
| `GET` | `/knowledge-bases/{knowledge_base_id}/delete-impact` | admin/manager | 返回当前 revision、受影响项目和确认摘要 |

创建请求至少包含 `name`、`description`、`type`、`embedding_model_id`、`summary_model_id` 和支持的基础解析/分块选项。存储、VLM、部署专属向量引擎等高级选项只返回摘要和管理 URL，不由平台复制。

删除请求至少包含 `expected_revision`、`confirm_affected_project_count` 和 `Idempotency-Key`。服务端重新计算影响项目数，变化时返回 `409 REVISION_CONFLICT`；确认后将资源设为 `deleting`，直到 WeKnora 确认完成。

### 7.2 项目关联

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/projects/{project_id}/knowledge-bases` | active 项目可用成员 | 插件选择器读取当前项目可用 KB 摘要 |
| `GET` | `/admin/projects/{project_id}/knowledge-bases` | admin/manager | 后台查看项目映射和状态 |
| `POST` | `/admin/projects/{project_id}/knowledge-bases` | admin/manager | 关联一个同组织 KB |
| `DELETE` | `/admin/projects/{project_id}/knowledge-bases/{knowledge_base_id}` | admin/manager | 解除当前项目映射，不删除外部 KB |

关联请求包含平台 `knowledge_base_id` 和当前项目/映射 `expected_revision`。服务端校验项目组织、项目状态、操作者治理范围、知识库组织和知识库状态；不能接受 WeKnora `kb_id` 替代平台 ID。

### 7.3 文档、文件夹和标签

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/knowledge-bases/{id}/documents` | admin/manager | 游标分页、搜索、类型、标签和文件夹过滤 |
| `GET` | `/knowledge-bases/{id}/documents/{document_id}` | admin/manager | 文档详情和真实处理状态 |
| `GET` | `/knowledge-bases/{id}/documents/{document_id}/preview` | admin/manager | 受授权预览 |
| `GET` | `/knowledge-bases/{id}/documents/{document_id}/download` | admin/manager | 受授权下载 |
| `POST` | `/knowledge-bases/{id}/documents/files` | admin/manager | 文件导入，返回每个文件的异步操作 |
| `POST` | `/knowledge-bases/{id}/documents/urls` | admin/manager | URL 导入 |
| `POST` | `/knowledge-bases/{id}/documents/markdown` | admin/manager | 手工 Markdown 导入 |
| `POST` | `/knowledge-bases/{id}/documents/{document_id}/reparse` | admin/manager | 重解析 |
| `DELETE` | `/knowledge-bases/{id}/documents/{document_id}` | admin/manager | 异步删除文档 |
| `GET/POST/PATCH/DELETE` | `/knowledge-bases/{id}/folders` | admin/manager | 文件夹树和变更 |
| `GET/POST/PATCH/DELETE` | `/knowledge-bases/{id}/tags` | admin/manager | 标签列表和变更 |

文件、URL 和 Markdown 导入必须返回 `202`、平台操作 ID、外部资源 ID（若已创建）和初始状态。批量文件逐个追踪，不能因为部分成功而把整批标记成功。

本地 HTTP 联调夹具实现了上述三种导入的最小 JSON 形态（文件以文件名描述，不模拟 multipart 字节存储），并通过 `GET /operations/{operation_id}` 将 `queued -> running -> succeeded` 推进；生产服务必须由 WeKnora 外部操作确认后再转换文档状态。

### 7.4 FAQ、Wiki 和 Graph

| 方法 | 路径 | 类型 | 说明 |
|---|---|---|---|
| `GET/POST/PATCH/DELETE` | `/knowledge-bases/{id}/faq-items` | faq | FAQ 条目管理 |
| `GET/POST/PATCH/DELETE` | `/knowledge-bases/{id}/wiki-pages` | wiki | Wiki 页面管理 |
| `GET` | `/knowledge-bases/{id}/graph` | wiki/启用图谱 | 图谱节点、关系和来源查询 |

接口必须校验知识库类型和外部能力；类型不匹配返回 `422 VALIDATION_ERROR`。平台只代理资源和状态，不在本地生成 FAQ、Wiki 或 Graph 数据。

### 7.5 操作和审计

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/operations/{operation_id}` | 操作者授权范围 | 查询异步操作状态 |
| `GET` | `/admin/knowledge-audits` | admin/manager | 按组织、项目、KB、动作、结果和时间游标查询 |
| `GET` | `/admin/projects/{project_id}/knowledge-audits` | admin/manager | 项目范围知识库审计 |

操作状态由平台轮询 WeKnora 或消费已认证事件刷新；外部失败原样保留错误摘要。审计查询不得让 member 枚举资源存在性。

## 8. 检索接口

### 8.1 请求

`POST /projects/{project_id}/knowledge-search`

请求体：

```json
{
  "query": "如何发布版本？",
  "knowledge_base_ids": ["platform-kb-opaque-id"],
  "top_k": 8,
  "trace_id": "trace-opaque-id"
}
```

`project_id` 只出现在平台插件资产请求中，不写入 DSH 原生 Session。`knowledge_base_ids` 必须是平台 ID；空列表返回 `422 VALIDATION_ERROR`，不自动使用项目全部 KB。

服务端先校验当前账号能使用 active 项目，再校验每个选中 KB 的 active 映射和组织连接。被撤权、解除映射、归档或外部不可用的 KB 标记 skipped，不得从旧缓存恢复。

### 8.2 响应

```json
{
  "request_id": "req-opaque-id",
  "results": [
    {
      "knowledge_base_id": "platform-kb-opaque-id",
      "knowledge_id": "platform-document-opaque-id",
      "title": "发布流程",
      "snippet": "…",
      "score": 0.87,
      "source_url": "https://platform.example/source/…",
      "citation": { "page": 3, "chunk": "chunk-opaque-id" }
    }
  ],
  "knowledge_bases": [
    {
      "knowledge_base_id": "platform-kb-opaque-id",
      "status": "used",
      "reason": null,
      "external_request_id": "weknora-request-id"
    }
  ]
}
```

每个 KB 的 `status` 只能是 `used`、`no_hits` 或 `skipped`。`skipped` 必须提供稳定原因分类，例如 `processing`、`unavailable`、`forbidden`、`not_found`、`timeout` 或 `external_error`，不能暴露敏感外部响应体。

正常路径使用一次 WeKnora multi-KB hybrid-search。Embedding 或能力不兼容时按能力分组并行，再按平台结果上限做有限合并；平台不重新实现 RRF、Rerank 或 MMR。

平台对每 KB 结果数、片段字符/Token 和总上下文设置服务端限制，超限按分数截断但保留引用元数据。片段作为不可信资料返回，不能被解释为系统指令或工具授权。

至少一个 KB 为 `used` 时返回成功；全部为 `no_hits` 仍返回成功但结果为空；全部为 `skipped` 返回 `503 SERVICE_UNAVAILABLE`，错误响应仍包含 `request_id` 和逐 KB 状态，供插件阻断本轮和展示原因。

## 9. 状态刷新和外部删除

后台详情、文档操作和插件选择器进入时可实时读取 WeKnora；平台只将快照用于展示最近检查时间和诊断，不把快照当作实时成功。外部 404 标记资源/映射 unavailable，保留平台 ID 和审计，支持重新绑定已有 KB 或解除映射。

外部删除的状态顺序为 `active -> deleting -> unavailable`。所有受影响项目映射在确认删除完成后停止检索；删除失败返回 `failed` 操作并保持资源可诊断，不自动恢复为“已成功删除”。

## 10. 错误码和安全

| 错误码 | HTTP | 语义 |
|---|---:|---|
| `AUTH_REQUIRED`、`TOKEN_EXPIRED`、`TOKEN_REVOKED` | 401 | 认证缺失或不可用 |
| `FORBIDDEN` | 403 | 账号可见但无当前操作权 |
| `RESOURCE_NOT_FOUND`、`PROJECT_NOT_MEMBER` | 404 | 资源不存在或对当前账号不可见 |
| `PROJECT_REQUIRED`、`VALIDATION_ERROR` | 422 | 缺少项目、字段/类型/状态非法 |
| `REVISION_CONFLICT`、`IDEMPOTENCY_CONFLICT` | 409 | 并发修订或幂等键冲突 |
| `SERVICE_UNAVAILABLE` | 503 | WeKnora、连接、模型或外部处理依赖不可用 |

错误响应包含 `request_id`、稳定错误码和可行动的非敏感消息，不包含隐藏资源名称、数量、租户凭据、WeKnora Token、完整外部响应、正文、Prompt、代码或本机路径。

## 11. 数据保留与隐私

平台不持久化知识正文、Chunk、向量或可复用检索缓存。平台保留知识库/映射元数据、操作状态、错误摘要、知识检索事件中的受限片段和引用元数据以及审计记录，并按统一审计保留策略清理。

组织连接密钥只通过服务端密钥管理引用读取和轮换，任何 API、浏览器、插件日志和审计事件都不得返回密钥内容。平台不得将项目 ID、WeKnora ID 或凭据注入 DSH 原生会话。

## 12. 本地内存服务联调范围

本地联调服务是 `apps/team-skill-service` 提供的内存 HTTP 夹具。默认 `WeKnoraAdapter` 是基于内存知识库和简单文本匹配的 fixture adapter；只有显式注入 `TeamSkillServiceOptions.weknora` 才会调用外部适配器。当前服务不连接 `G:\WeKnora`，不读取真实 WeKnora REST/MCP 数据，也不提供平台元数据、操作记录或审计的持久化。

本地内存服务只补齐插件和后台已开发流程需要的 HTTP 响应：知识库列表/创建/详情/基础配置、项目映射、文件/URL/Markdown 导入操作状态、文档列表与处理状态、检索的多 KB 状态、401/403/404/409/503 和幂等重放。文件导入接受 JSON 文件名描述，不接受或保存 multipart 字节；FAQ/Wiki 路由只返回空集合，Graph 返回空节点和关系，知识库审计返回空集合；列表没有游标分页、稳定排序或完整审计字段。

内存服务不得扩展为生产数据库、OIDC、对象存储、向量索引、WeKnora 内部实现或未开发的业务模块。Fixture 只能作为明确选择的服务端响应，不能在 HTTP 失败时回退为本地成功。生产交付仍需真实 WeKnora 公共 REST/MCP 适配器、持久化、multipart 字节存储、FAQ/Wiki/Graph 数据、游标分页和知识库审计。

## 13. 生产后端验收

- admin 可以为组织配置连接、创建三种类型 KB、更新基础配置、导入三种内容并查看真实异步状态。
- manager 只能操作自己加入的有效组织，能够在组织/项目范围创建、配置、导入、重解析、关联、解除和删除 KB；不能轮换组织连接。
- member 无后台管理数据，只能在明确 active 项目成员关系成立时通过插件检索。
- 一个项目关联多个 KB、一个 KB 复用到多个项目时，项目映射和外部删除影响范围正确隔离并产生审计。
- multi-KB 正常路径使用 WeKnora 原生检索；模型不兼容时分组并行；部分 KB 失败不影响成功 KB，全部失败返回 503。
- 撤权、解除映射、项目归档、WeKnora 404/5xx、超时、revision 冲突和幂等冲突均不显示本地成功，不返回旧缓存。
- 平台 API 不泄露 Token、租户凭据、外部 KB ID 给客户端，不直接访问 WeKnora 数据库，不修改 WeKnora 原生用户 RBAC。
