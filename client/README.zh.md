# @deepseek-ai/dsh-client-ui-ai-coding-platform

[English](README.md) | 中文

统一第一方 AI Coding 编程协作台插件。插件通过 `sidebar.footer.action` 在原生 DSH 侧边栏提供“协作台”按钮，默认不自动打开；点击按钮后才通过 `shell.overlay` 显示协作台。协作台展示账号登录、项目选择和只读项目详情、团队 Skill、知识库、记忆库、数据采集和云端 Coding Agent 配置，会话继续使用 DSH 原生界面。

账号登录、强制改密、组织选择、项目选择和按项目返回的资源 ID 使用 Host 管理的 `teamSkills` Remote。Host 把 Access Token 和 Refresh Token 保存在 DSH 凭据中；浏览器只接收账号和访问摘要。项目选择器按组织分组显示服务端授权的 active 项目，按服务地址和账号只持久化不透明 `project_id`，恢复前重新鉴权。切换项目会先清空旧项目资产，再读取新项目详情；授权、传输和服务失败都显示明确的失败状态，不以本地结果冒充成功。团队 Skill 按服务端返回原样展示 Host 管理的 Remote 目录和本地安装记录；服务端的组织与项目资产授权是唯一过滤，任何 Skill 请求返回 `signed-out` 时都会走账号刷新路径恢复会话。知识库由服务端提供：Client 列出已授权摘要，把显式选择绑定到当前 DSH 会话，并显示服务端返回的检索结果和预览。记忆库同样由服务端提供：Client 搜索和按游标读取当前项目的权威记录，并使用服务端 revision 执行详情、编辑和删除。服务端或 Host 配置缺失时显示明确的 `not-ready` 或失败状态，不能将本地结果当作成功。安装和卸载由 Host 执行，Host 校验不可变 ZIP 并写入 DSH 原生 Skill 目录。

Agent 配置页是通过 `cloudWorkspaces` Remote 读取当前项目 published Agent Profile Version 的只读消费方：卡片包含名称、描述、Agent 类型与 readiness、published 版本与更新时间、带不可用资产标记的有序 Skill 绑定、知识库数量、单个记忆库或“未使用记忆库”、服务端 readiness 结论与原因，以及项目默认标记。详情页重新读取单个版本，展示基本信息、模型参数、团队资产（有序 Skill、知识库集合、单个记忆库或无）、执行策略摘要，以及通用类型扩展值（无法识别的值显示为“服务端扩展字段”）。页面不提供任何治理操作，区分账号退出 / 服务未就绪 / 未授权 / 协议错误与“项目暂无配置”，并在项目或账号切换时清空上一项目的卡片、详情与选择。

`/client` 导出插件的 `apply`、`inject`、`PlatformEntry`、`PlatformSurface` 和 `PlatformDemoController`。Web Bundle 在 `cordis.patch.yml` 中以 `ui-ai-coding-platform` 行加载该插件。


## 云工作空间工作台

- 协作台的云工作空间入口打开 `CloudWorkspacesView` 三栏工作台：左栏为项目/Workspace/分支与远程文件树，中栏为当前 DSH Session 绑定，右栏为 `Preview`/`Changes`/`Run` 面板；960px 以下两侧收为抽屉。静态 HTML 预览在带服务端 CSP 声明的 sandbox iframe 中渲染，视图对 workspace busy、revision 冲突、signed-out 与流状态（live/重连/重同步）给出明确提示。所有数据来自 `cloudWorkspaces` Remote 命名空间，视图不持有本地 fixture 对象。

## 模型体验

### DSH 原生会话

#### 模型可见内容

本浏览器 UI 不添加任何模型可见内容，也不调用 DSH 会话；会话级知识检索由 Host 包负责。“返回 DSH 会话”只关闭协作台；提示词组装和经授权的项目或任务上下文仍由 DSH 原生会话负责。

#### Token 影响

demo 不消耗模型 Token。团队 Skill 安装不会进入模型请求；生产版本通过原生 Session 请求承载经授权的项目上下文，采集器上报实际用量。

#### KV Cache 影响

UI 不改变原生 Session 前缀或服务商缓存行为；Host 注入的知识引用由 Host 包写入会话事件。

## 已知限制与暂缓事项

- 项目元数据和访问范围由服务端提供；任务、Run、Git、Workspace、代码源和项目治理不属于本插件范围。数据采集和 Agent 配置仍保留浏览器本地演示说明，没有服务端持久化或治理流程。记忆库和知识库的列表、检索、预览以及记忆变更使用 Host Remote，本地 UI 不保存知识或记忆正文，也不保存令牌。
- 团队 Skill 操作依赖 Host `teamSkills` Remote 和可用服务端；Client 会明确报告 `not-ready` 或失败，不会推断本地成功。
- 本地 UI 不执行 Skill 内容，也不暴露文件路径和访问令牌；安装与隔离仍由 Host 负责。
