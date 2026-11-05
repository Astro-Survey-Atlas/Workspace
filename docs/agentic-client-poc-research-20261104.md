# Agent 客户端 PoC：版本、工具与协议调研

调研日期：2026-11-04，Asia/Shanghai。本文只记录本机版本、官方固定版本源码和 PoC 设计依据；没有执行模型、MCP、n8n 或其他业务服务调用，没有运行部署。网络读取限于官方公开文档和源码。未读取或输出凭据值，也未运行可能展开完整配置的 `opencode debug config`。

结论：OpenCode 可以通过 custom tool 包装 Workspace CLI，但需要固定插件与 SDK 入口，分别限制 primary 和 subagent，并在自定义工具中落实执行前的权限请求。n8n 的 Base URL 可配置，不能由此认定某个 Bridge 已兼容。本文延续 [2026-11-03 技术路线决策](agentic-orchestration-decision-20261103.md)：Workspace 管理 Workflow、运行、人工决策、产物和血缘，外部框架作为客户端或集成入口。

## 版本证据

| 对象 | 本次只读发现 | 证据与解释 |
| --- | --- | --- |
| 本机 OpenCode | `command -v opencode` 返回 `/home/aaron/.opencode/bin/opencode`；`opencode --version` 返回 `1.19.4`。 | 实际本机命令。官方 [v1.19.4 tag][OC-TAG] 指向 `148842ef7cb1bc34192b3fff57d0f9721ab9c801`；下面的源码引用固定到该提交。版本字符串相同不等于验证了二进制与源码的逐字节对应。 |
| astro-code 根 SDK | 已安装 `@opencode-ai/sdk@1.1.14`。 | [本地 package.json](../../astro-code/node_modules/@opencode-ai/sdk/package.json)；官方 [v1.1.14 tag][SDK-OLD-TAG] 指向 `7c6b3f981e56b94b5948619d23e7312a7c7583c0`。 |
| astro-code `.opencode` 插件 | package.json 声明 `@opencode-ai/plugin@1.18.4`，已安装 plugin 和其 SDK 均为 `1.14.48`。 | [声明](../../astro-code/.opencode/package.json)、[已安装 plugin](../../astro-code/.opencode/node_modules/@opencode-ai/plugin/package.json)、[已安装 SDK](../../astro-code/.opencode/node_modules/@opencode-ai/sdk/package.json)。声明与实际安装不同，不能把其中任意一项当作全部运行依赖版本。 |
| Workspace `.opencode` 插件 | 声明并安装 plugin `1.18.26`，其 SDK 为 `1.18.26`。 | [声明](../.opencode/package.json)、[已安装 plugin](../.opencode/node_modules/@opencode-ai/plugin/package.json)、[已安装 SDK](../.opencode/node_modules/@opencode-ai/sdk/package.json)。没有读取相邻的 opencode 配置文件。 |
| 本机 n8n | 当前 Shell 的 `command -v n8n` 无返回，退出码为 1。 | 只能说明 PATH 没有该命令，不能据此判断容器或其他环境是否运行 n8n。本文没有已运行 n8n 的版本证据。 |
| n8n 参考源码 | 固定提交 `250967428f63a254afd9b353f3e0da8578b775c0`；其中 LangChain 节点包版本为 `2.47.0`，OpenAI Chat Model 节点 schema 版本为 `1`、`1.1`、`1.2`、`1.3`。 | [节点包 package.json][N8N-PKG]、[节点源码][N8N-MODEL]。包版本、节点 schema 版本和 n8n 运行时版本是不同对象，本次未选择部署版本。 |

## OpenCode 1.19.4 custom tools

下表以 v1.19.4 的实际加载代码为准。[官方 custom tools 文档][OC-DOC-TOOLS]说明项目 `.opencode/tools/` 和全局工具目录、TS/JS 定义及 Zod 参数；源码补充了具体扫描和导出规则。

| 项目 | 固定版本结论 | 对 PoC 的影响 |
| --- | --- | --- |
| 加载位置 | [ConfigPaths.directories][OC-PATHS] 合并全局配置目录、项目工作目录向 worktree 查找的 `.opencode`、用户 home 下的 `.opencode`，以及可选 `OPENCODE_CONFIG_DIR`。 | 仅换 cwd 或设置一段 inline config，不能推定全局配置／工具已经隔离。应在独立 PoC 环境中检查实际发现的工具名，避免读取既有用户配置。 |
| 文件范围 | [ToolRegistry][OC-REGISTRY] 扫描 `{tool,tools}/*.{js,ts}`，等待配置依赖后动态 import。 | 当前扫描是一层 JS/TS 文件；嵌套目录和其他扩展名不能靠这个 glob 自动发现。Python 等程序由 JS/TS 工具定义调用。 |
| 工具名称 | default export 注册为文件名去扩展名；具名 export 注册为 `<文件名>_<导出名>`。[OC-REGISTRY] | `workspace.ts` 的 default 工具名是 `workspace`，具名 `query` 则是 `workspace_query`；权限键必须使用最终注册名。 |
| 工具定义 | loader 的 `isPluginTool` 检查对象是否有 `args`、`description`、`execute`；`tool()` helper 提供 Zod schema 和类型。[OC-REGISTRY][OC-PLUGIN] | 无参数工具仍提供 `args: {}`。优先使用 `tool.schema`；普通 JSON Schema 的兼容路径不等同于 Zod 的参数校验路径。 |
| 执行上下文 | `ToolContext` 提供 `agent`、`sessionID`、`messageID`、`directory`、`worktree`、`abort`、`metadata` 和 `ask`。[OC-PLUGIN] | 解析路径使用会话目录；CLI 子进程应处理取消、退出码和 JSON stdout。需要的关联 ID 保存在 Workspace 侧，不写入高基数指标标签。 |
| 同名工具 | 文档说明 custom tool 可覆盖同名内置工具；源码将内置和 custom 工具按 ID 放入同一工具表。[OC-DOC-TOOLS][OC-TOOLS] | 使用独立工具名，例如 `workspace_cli`；不要依赖覆盖内置 Shell 工具实现边界。 |

### 自定义工具权限需要核对两层

**工具可见性：** [LLMRequestPrep.resolveTools][OC-REQUEST] 用合并后的 Agent／session 权限过滤工具；[Permission.disabled][OC-PERMISSION] 对最后匹配且覆盖 `pattern="*"` 的 deny 规则隐藏工具。权限通配符与规则顺序会影响最终结果。

**执行前请求：** [custom tool 包装器][OC-REGISTRY] 将 `toolCtx.ask` 交给插件，但直接调用 `def.execute`；[普通工具执行路径][OC-TOOLS]同样直接执行工具，没有统一代为调用 `ask`。因此，按所读普通执行路径源码，配置 custom tool 为 `ask` 并不能替代工具实现中的 `context.ask`。

PoC 的 `workspace_action` 现在会在启动 CLI 前调用 `context.ask`，按精确的 `METHOD /api/path` 请求本次授权，并将 `always` 留空，避免授权被保存为后续操作的长期规则。请求摘要会截断并遮盖凭据字段。2026-11-04 在 OpenCode 1.19.4 隔离 PoC 中验证了实际权限对话框、拒绝结果，以及取消时 CLI 子进程关闭请求连接。

等效权限请求形状如下：

```ts
await context.ask({
  permission: "workspace_action",
  patterns: [operation],
  always: [],
  metadata: { operation, request: "redacted request summary" },
})
// 权限请求成功后，调用固定 CLI 可执行文件和固定参数数组。
```

`operation` 来自校验后的 HTTP 方法和归一化 API 路径；Workspace 业务权限、工具执行确认和科学人工筛选仍由相应业务入口承担。外部 Agent 的允许规则不能用来伪造 Workspace 的人工决策。

源码把 Shell 的实现命名为 `ShellTool`，但 [shell/id.ts][OC-SHELL-ID] 明确保留公开工具 ID 和权限键 **`bash`**，以兼容已有插件和权限；配置时不能根据实现变量名改为 `shell`。

## Primary、subagent 与 SDK 差异

[官方 agents 文档][OC-DOC-AGENTS]与 [Agent 配置 schema][OC-AGENT-SCHEMA]支持 JSON 的 `agent` 配置及 Markdown Agent；`mode` 可为 `primary`、`subagent`、`all`。新建 Agent 未指定 mode 时，运行代码默认 `all`。Agent Markdown 在源码中按 `{agent,agents}/**/*.md` 加载。[OC-AGENT][OC-AGENT-LOADER]

- primary 是主会话入口，subagent 可由 `task` 调用，也能由用户直接 `@` 指定；`description` 用于说明调用时机。`default_agent` 必须指向存在、可见且不是 subagent 的 Agent。[OC-DOC-AGENTS][OC-AGENT]
- `permission.task` 按目标 Agent 名称匹配，最后匹配规则优先；被 deny 的目标会从 task 描述中移除。`hidden` 影响 `@` 菜单显示，不构成权限隔离；官方文档明确用户直接指定 subagent 与主 Agent 的 task 规则不同。[OC-DOC-AGENTS][OC-REGISTRY][OC-PERMISSION]
- 主 Agent 自身的权限不自动成为子 Agent 的全部限制。[deriveSubagentSessionPermission][OC-SUBAGENT]只从父 **session** 传递 deny 和 external_directory 规则，子 Agent 自身配置决定其能力；[TaskTool][OC-TASK]还处理子会话与深度限制。因此应为每个专业 Agent 显式设置只读工具范围，不能仅限制 orchestrator。
- 新配置使用 `permission` 与 `steps`；`tools` 和 `maxSteps` 已标记 deprecated，但源码仍提供转换兼容。[OC-AGENT-SCHEMA]

### SDK 1.1.14 不能混用默认与 `/v2` 入口

本地 SDK 1.1.14 的 [exports](../../astro-code/node_modules/@opencode-ai/sdk/package.json) 同时提供默认、`/client`、`/server` 与 `/v2` 等入口。下表只陈述已读到的类型／客户端源码差异，不据此宣称旧 SDK 全部不可用。

| 项目 | SDK 1.1.14 默认入口 | 同包 `/v2` 入口或 1.19.4 资料 | PoC 选择依据 |
| --- | --- | --- | --- |
| prompt 路径参数 | `session.prompt({ path: { id }, body })`，模板 `/session/{id}/message`。 | `/v2` 类型使用 `path.sessionID` 和 `/session/{sessionID}/message`。 | 按实际 import 的入口构造参数，不从另一入口复制示例。[本地默认类型](../../astro-code/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts)、[本地 v2 类型](../../astro-code/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts) |
| Agent 权限类型 | `AgentConfig.permission` 显式列出 edit、bash、webfetch、doom_loop、external_directory 等旧字段。 | `/v2` 有 `PermissionConfig`，包含 task、read、skill 等扩展形式和自定义键；1.19.4 schema 也支持自定义权限键。 | 旧类型覆盖面不是新服务端能力清单；Agent 配置以固定服务端 schema 为准。[本地默认类型](../../astro-code/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts)、[本地 v2 类型](../../astro-code/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts)、[1.19.4 schema][OC-PERMISSION-SCHEMA] |
| Agent 选项 | 默认类型显式提供 `maxSteps`，没有单列 `hidden`／`steps`。 | `/v2` 类型包含 hidden、steps、废弃标记；1.19.4 推荐 permission／steps。 | 不把类型断言或额外键通过编译当成实际生效证明。[本地 v2 类型](../../astro-code/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts)、[1.19.4 schema][OC-AGENT-SCHEMA] |
| 权限回复接口 | 默认客户端有 `postSessionIdPermissionsPermissionId`。 | 同包 v2 有 `permission` 客户端；[官方 SDK 文档][OC-DOC-SDK]示例还使用另一种长方法拼写。 | 从本地实际入口导出的客户端和固定服务端契约核对方法，不仅照抄文档字符串。[默认 SDK 声明](../../astro-code/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts)、[v2 SDK 声明](../../astro-code/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts) |
| 会话目录传递 | 默认 client 原样写入 `x-opencode-directory`；同包 v2 对非 ASCII 目录编码。 | 1.19.4 默认 client 对目录调用 `encodeURIComponent`，并将 GET/HEAD 的目录头改写成 query。 | 初次 PoC 可使用 ASCII 绝对目录；目录参数与工具发现仍须实际核对。[本地默认 client](../../astro-code/node_modules/@opencode-ai/sdk/dist/client.js)、[本地 v2 client](../../astro-code/node_modules/@opencode-ai/sdk/dist/v2/client.js)、[1.19.4 client][OC-CLIENT] |

本地 SDK 的 [createOpencodeServer](../../astro-code/node_modules/@opencode-ai/sdk/dist/server.js) 启动 PATH 上的 `opencode` 子进程，并通过 `OPENCODE_CONFIG_CONTENT` 传入配置；SDK 1.1.14 不会因此把本机二进制降级为 1.1.14。官方 SDK 文档也说明 inline config 仍会叠加现有配置。[OC-DOC-SDK] PoC 应记录运行二进制、SDK、插件、import 入口、会话目录和最终工具名，分别验证连接成功与权限生效。

## n8n 自定义 Base URL、工具、流式与 usage

本次访问 n8n 文档站得到 HTTP 403，因此使用其官方 n8n-docs 仓库固定提交 `88484fc1cb4512111f64f15a610381502290de08` 的文档源码；不是第三方转述。[N8N-DOC-MODEL][N8N-DOC-AGENT]

| 核对项 | 官方证据 | PoC 注意点 |
| --- | --- | --- |
| Base URL | [OpenAI credentials][N8N-CREDENTIAL]提供 Base URL，默认 `https://api.openai.com/v1`，凭据检查请求 `/models`；[节点源码][N8N-MODEL]优先使用 `options.baseURL`，其次 `credentials.url`。节点上的旧 Base URL UI 对较新节点版本隐藏。 | 必须记录配置实际来源和最终请求路径。模型发现成功不能替代工具调用、流式或 usage 验证。 |
| API 模式 | [文档][N8N-DOC-MODEL]说明 Responses 开关与 Chat Completions；源码节点 1.3 的开关 UI 默认 true，读取缺失参数的 fallback 为 false，只在启用时显式设置 `fields.useResponsesApi=true`。[N8N-MODEL] | 固定节点 schema 版本并显式记录开关。不要仅按文档中的默认描述推定实际协议；还需观察请求是否为预期模式和路径。源码没有在关闭分支显式写 `useResponsesApi=false`。 |
| 工具调用兼容性 | 节点源码明确提示自定义 Base URL 的模型不一定支持 chat、tool calling 或 JSON response format；并设置 `supportsStrictToolCalling=false`，注释说明部分兼容后端拒绝 `strict:null`。[N8N-MODEL] | 地址可设置不代表 OpenAI 兼容包装已通过验证。PoC 应覆盖工具 schema、调用 ID、参数、工具结果回传、多次调用和错误返回。 |
| Agent 工具执行 | Tools Agent 使用 LangChain tool calling 接口，向模型提供工具及 schema；支持调用 Workflow、HTTP Request 等工具。[N8N-DOC-AGENT] | 远端 n8n 作为模型适配器，和 n8n 直接负责业务编排，是不同调用方向。先固定职责，避免两边各执行一次科学任务。 |
| 流式输出 | Tools Agent 文档要求 Chat Trigger 或 Webhook 等支持流式的 trigger，且 Response Mode 设为 Streaming；单独打开 Agent streaming 不足。[N8N-DOC-AGENT] | 区分模型到 n8n 的流与 n8n 到调用者的流。若 Bridge 对外提供兼容流，需单独验证事件格式、分片、工具参数累计、结束信号、取消和错误；n8n 工作流能流式显示不等于其 Webhook 已实现目标模型协议。 |
| usage 的来源 | [N8nLlmTracing][N8N-TRACING]默认读取 LangChain 结果的 `llmOutput.tokenUsage`，在 `completionTokens > 0` 时记为实际值，否则回退 `tokenUsageEstimate`，并设置 `llm.tokens.estimated=true`。 | n8n 出现 token 数不代表 Bridge 回传了真实 usage；工具轮次、流式终止、缺失字段和真实零值应分别保留证据。估算值不能直接伪装为 Workspace 的实际 usage。 |
| 依赖与流式 usage | [catalog][N8N-CATALOG]将 `@langchain/openai` 固定为 1.4.4，并有项目补丁；所读节点的 `ChatOpenAIFields` 没有显式设置 `streamUsage`。 | 不能仅从节点 UI 推定底层是否请求或收到流式 usage。PoC 应记录实际请求中的 streaming／usage 选项及末尾响应，不预先假定任意兼容服务都接受它们。 |

对 Workspace 当前客户端，[ai-provider-client.ts](../src/ai-provider-client.ts) 使用 `/chat/completions`、`choices[].message.tool_calls`、`tool_call_id` 和 `usage.prompt_tokens/completion_tokens`。若所谓 Bridge 要作为它的模型服务，至少必须满足这些实际消费字段；若还需流式或 Responses，则应明确为额外协议范围并独立验证。该描述是本地源码观察，不代表所有 OpenAI 客户端的完整协议定义。

## Bridge 的本地边界与待验证项

对 Workspace 的 README、CONTEXT、docs、src、packages，以及 astro-code 的 README、src、docs、ops 和工具文件名进行了定向检索，没有识别到 **n8n 的 OpenAI 兼容 Bridge 实现或其版本契约**。检索没有读取 opencode 配置、凭据文件或 Secret 内容，因此该结论只覆盖上述范围。Workspace 存在 S3 range bridge 和 Assets reverse-lookup bridge，其用途见 [workflow-fits-cutout.ts](../src/workflow-fits-cutout.ts) 与 [assets-region-client.ts](../src/assets-region-client.ts)，它们不是本次讨论的 n8n 模型包装器。

官方 n8n 与 OpenCode 资料能说明各自扩展点，无法定义本地这个名称所指的服务。应先固定 Bridge 仓库／提交、调用方向、支持的 API 模式、输入输出、工具执行责任、usage 来源和 HITL 恢复契约，再运行真实兼容性 PoC。当前不能写“Bridge 已实现”“完整 OpenAI 兼容”或“n8n 与 OpenCode 的科学端到端均通过”。

OpenCode 隔离 PoC 已验证只读工具发现和 JSON 调用、`workspace_action` 权限拒绝、取消路径，以及 primary 通过 `task` 委派给只读 `workflow-operator` 子 Agent。拒绝测试使用不存在的 `/api/__codex_permission_probe` 路由，并在 CLI 启动前拒绝，因此没有修改 Workspace。n8n 仍需先固定 Bridge 仓库、版本和协议方向，再用受控本地协议替身验证所需字段、API 路径、流式和 usage；这些运行验证尚未完成。

### Dev 环境核对补充（2026-11-04）

在当前集群的 Pod、Service、Deployment 和 Ingress 清单中，没有名称匹配 n8n、Bridge 或
OpenAI proxy 的工作负载/入口；对 `/home/aaron/Repo` 的隐藏及普通文件路径搜索也没有找到
名称包含 `n8n` 或 `bridge` 的源码路径。该快照不排除以其他名称部署或存放的服务，但目前
没有可据以固定 Bridge 仓库、版本或运行 endpoint 的证据。故不能把 OpenAI-compatible
Base URL 的官方支持或本地 OpenCode PoC 当作 n8n/Bridge 兼容性通过。取得 Bridge 的源码
仓库与提交、实际 endpoint 及调用方向后，才可继续按上表执行协议 PoC。

上文的 OpenCode 与 n8n 源码链接均固定到所列提交；本地链接反映本次工作目录的安装状态，不代表仓库发布依赖已经锁定为这些版本。

[OC-TAG]: https://github.com/anomalyco/opencode/tree/v1.19.4
[SDK-OLD-TAG]: https://github.com/anomalyco/opencode/tree/v1.1.14
[OC-DOC-TOOLS]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/web/src/content/docs/custom-tools.mdx
[OC-DOC-AGENTS]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/web/src/content/docs/agents.mdx
[OC-DOC-SDK]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/web/src/content/docs/sdk.mdx
[OC-PATHS]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/config/paths.ts
[OC-REGISTRY]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/tool/registry.ts
[OC-PLUGIN]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/plugin/src/tool.ts
[OC-TOOLS]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/session/tools.ts
[OC-REQUEST]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/session/llm/request.ts
[OC-PERMISSION]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/permission/index.ts
[OC-SHELL-ID]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/tool/shell/id.ts
[OC-AGENT-SCHEMA]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/core/src/v1/config/agent.ts
[OC-AGENT]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/agent/agent.ts
[OC-AGENT-LOADER]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/config/agent.ts
[OC-SUBAGENT]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/agent/subagent-permissions.ts
[OC-TASK]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/tool/task.ts
[OC-PERMISSION-SCHEMA]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/core/src/v1/config/permission.ts
[OC-CLIENT]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/sdk/js/src/client.ts
[N8N-PKG]: https://github.com/n8n-io/n8n/blob/250967428f63a254afd9b353f3e0da8578b775c0/packages/%40n8n/nodes-langchain/package.json
[N8N-MODEL]: https://github.com/n8n-io/n8n/blob/250967428f63a254afd9b353f3e0da8578b775c0/packages/%40n8n/nodes-langchain/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts
[N8N-CREDENTIAL]: https://github.com/n8n-io/n8n/blob/250967428f63a254afd9b353f3e0da8578b775c0/packages/nodes-base/credentials/OpenAiApi.credentials.ts
[N8N-DOC-MODEL]: https://github.com/n8n-io/n8n-docs/blob/88484fc1cb4512111f64f15a610381502290de08/docs/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/README.md
[N8N-DOC-AGENT]: https://github.com/n8n-io/n8n-docs/blob/88484fc1cb4512111f64f15a610381502290de08/docs/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent.md
[N8N-TRACING]: https://github.com/n8n-io/n8n/blob/250967428f63a254afd9b353f3e0da8578b775c0/packages/%40n8n/ai-utilities/src/utils/n8n-llm-tracing.ts
[N8N-CATALOG]: https://github.com/n8n-io/n8n/blob/250967428f63a254afd9b353f3e0da8578b775c0/pnpm-workspace.yaml
