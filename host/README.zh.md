# @deepseek-ai/dsh-ai-coding-platform

[English](README.md) | 中文

第一方 AI Coding 平台的 Host 侧 Team Skill 和知识检索桥接。包读取已认证的服务端目录，为不可变版本申请授权，下载并校验 ZIP 制品，只写入 DSH 原生 Skill 目录，并通过 `teamSkills` Typert Remote 命名空间向浏览器提供能力。包还会把选中的知识库绑定到一个活动 DSH 会话，并在每个模型步骤前检索引用。

## 配置

`apiBaseUrl` 配置 AI Coding 服务。`accessToken` 是可选的 Host 管理静态服务令牌；配置 `credentials` 后，账号登录会把服务端授权记录保存到该凭据服务，目录、版本状态和安装请求均使用这条授权记录。服务端同时拒绝 Access Token 和 Refresh Token 时，Host 会删除该授权记录并返回 `signed-out`；传输失败仍返回明确失败，绝不复用缓存权限。`stateDirectory` 保存 Host 管理的安装记录和隔离副本。`globalSkillRoot` 是 DSH 全局 Skill 发现目录。项目级安装通过 DSH `workspaceRegistry` 将不透明的工作区 id 解析为本地路径；浏览器端不会获得文件路径或访问令牌。

## 语义

Host 会在目录、安装和知识检索请求中携带当前选择的不透明项目 ID，服务端每次请求都会重新校验项目成员关系。目录、版本状态和安装请求共用账号请求的单次刷新：令牌过期只触发一次合并刷新，刷新被拒绝时删除本地授权记录并向浏览器返回 `signed-out`。安装记录是项目授权记录：记录唯一键为 `(skillId, scope, workspaceId, projectId)`，两个项目不会互相覆盖同一本地副本作用域的记录；物理副本在每个作用域根下仍只有一份，第二个项目安装时会显式把先前记录标记为 `uninstalled`。浏览器安装查询只返回服务端重新授权后的当前项目记录。版本状态查询提交记录所属项目 ID；服务端权威响应未返回的版本会被隐藏并隔离。Host 还会向服务端发送安装授权和生命周期事件。写入前校验服务端 SHA-256、文件摘要、ZIP 路径和 `SKILL.md` frontmatter，并使用原子写入。被本地修改的受管副本必须得到明确确认后才能替换或移除。下线版本会移出 DSH 发现目录并标记为 `withdrawn`；卸载会移除受管副本并刷新原生 Skill 发现。知识库选择只保存在一个活动会话的内存中，项目或会话切换会清除选择。

Remote 导出名是 `teamSkills/installSkill` 和 `teamSkills/uninstallSkill`。Host 方法仍命名为 `install` 和 `uninstall`，因为 Typert 命名空间保留了 `install` 与 `uninstall` 服务键。

## 可观测管道

本包承载 AI Coding 遥测采集器：`sessionTelemetry` 服务将白名单内的 DSH 会话事实（绝不包含提示词、回复、工具参数或结果）投影进按账号分区的 SQLite 队列，由后台 Reporter 以单项目批次向服务发送并逐事件确认（accepted/duplicate/retryable/rejected）。采集受授权约束：批次只会从它被 claim 的账号分区发出——发送前会重新解析当前账号，当分区与 `Authorization` 身份不一致时拒绝发送（挂起中的登录/登出只会让批次延后，绝不跨身份发送）。静态访问 Token 仅用于确认无登录态（signed-out）的部署兜底。

认证请求挂起期间采集进入隔离：login、refresh、logout 未完成时，已绑定会话的事件被计为隔离（采集状态中的 `receivedEventCount` / `isolatedEventCount`），既不写入旧分区也不预写新分区。所有失败路径都可恢复且无需等待 claim 租约：send、ACK 应用与账号解析错误会登记重试（`TELEMETRY_SEND_THREW` / `TELEMETRY_ACK_FAILED` / `ACCOUNT_RESOLVE_FAILED`）；恢复操作自身失败时直接释放 claim，队列不可用则以显式 storage error 停机。销毁经构造期注册的 Cordis effect 执行：Reporter 停止、完成最后 drain、队列只关闭一次；关闭后的队列对新事件以 storage failure 拒绝而非静默丢弃。`configureCollectorProject` 在绑定前经服务端授权确认——未授权、已归档或不存在的项目（以及登出账号）会被拒绝且原绑定保持不变。错误摘要在进入队列、状态视图或 fixture 前统一经共享脱敏器处理（Bearer、键值型机密、Cookie、密码、用户目录路径）。

确定性扫描与 gateway/loop 集成套件逐层覆盖上述链路，包括一条故意泄漏门禁：脱敏前必须以原始样本失败、脱敏后通过。


## 云工作空间

- `WorkspaceHost` 先读 REST 快照再打开 SSE，用水位重连维持唯一订阅，在 `resync_required` 时重读项目快照，把 401 `AUTH_REQUIRED`/`TOKEN_EXPIRED` 通过清除共享账号凭据记录映射为 signed-out，并把每个服务错误映射为稳定的 `WorkspaceQueryResult` 失败；它不会伪造本地成功。
- 写操作携带 `Idempotency-Key` 与 `expected_workspace_revision`/`If-Match` revision 守卫。`WorkspaceGateway` 将这些操作以 `cloudWorkspaces` Remote 命名空间投影给浏览器；工作台 UI 与其状态见 `@deepseek-ai/dsh-client-ui-ai-coding-platform`。
- Agent 配置读取（`agentTypes`、`agentProfiles(projectId)`、`agentProfileVersion(versionId)`）只返回项目绑定的 published 版本，携带可直接展示的资产绑定（名称与 readiness 由服务端解析）、含 `write_mode` 的执行策略、通用 `type_extension_config` 值，以及服务端给出的 readiness 结论与原因。`createRun` 把所选版本的执行策略固化到 Run 上；Run 的写入模式只能收紧、不能扩大该策略。所有字段严格解析：字段缺失、类型错误、未知 readiness、非 published 版本都是协议错误而不是默认值；该平面不存在任何凭据内容。
- 配置契约：`apiBaseUrl` 是云工作空间服务端点，可写为带或不带尾部 `/v1`、带或不带尾部斜杠；客户端将其归一化为 origin，每条请求路径自带 `/v1`，因此 REST 读、写与 SSE 流都恰好命中一个 `/v1`。非绝对 http(s) URL 会显式失败，而不会被改写成打向错误主机的请求。身份同样必须显式：`authMode: 'account'`（默认）只使用共享账号凭据记录，凭据缺失、被撤销、不可读或被 401 清除时返回 `signed-out`；静态 Token 是整部署级的身份替代物，仅在 `authMode: 'static-token'` 下可用，在账号部署中携带它会在加载阶段被拒绝。

## 模型体验

### DSH 原生会话

#### 模型可见内容

每个获准的模型步骤前，Host 通过服务端检索所选项目知识库，把 `knowledge-search` 事件追加到 DSH Session，并将带引用的文本作为不受信任上下文注入。当前轮次的 `AbortSignal` 会传给检索；检索被取消时不会写入事件，也不会继续模型请求。安装后的 Skill 在发现刷新后由 DSH 原生 `dsh-skill` provider 提供给模型。

#### Token 影响

安装流程不消耗模型 Token。后续进入请求的项目上下文或 Skill 指令由 DSH 原生 Session 和 Skill consumer 负责并计量。

#### KV Cache 影响

知识引用从 `knowledge-search` 事件重建，因此属于原生 Session 历史；除此之外，本包不改变原生 Session 前缀或服务商缓存行为。

## 已知限制与暂缓事项

- 服务端或 Host 配置缺失时返回 `not-ready`；传输、授权、摘要、ZIP、本地文件系统和 DSH 发现失败时返回稳定的失败结果。
- 本包不执行 Skill 内容，不接受任意 URL，不安装依赖，也不提供浏览器侧文件系统逃逸。
- 内存实现 `apps/team-skill-service` 仅用于本地集成验证，不是生产服务。
