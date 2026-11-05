# Session 交接：Workspace Agent 实现与 CSST 扫描

更新时间：2026-11-04，Asia/Shanghai；Workspace Agent/CLI r17 已部署，并完成目录与 MCP 运行核对。

最新只读部署核对：Workspace 当前为 Helm revision **139**、镜像
`0.0.1-dev-20261104-agent-r17`，digest 为
`sha256:782095a75b9793aa6def515e60d125e7e576e4d69338527d79d5a5db964880c1`。
Pod `asa-workspace-7488f57d6c-djqtl` 为 `1/1 Ready`、零重启；最新 Pod 内
`/healthz` 和 Elasticsearch health 均返回 HTTP 200。相邻两次资源采样从 816m CPU、
1566 MiB 降至 660m CPU、1560 MiB（limit 2 GiB）；启动期以及最近一次
readiness/liveness 事件仍有失败记录，需继续观察。
Workspace CLI 可列出 3 个 `euclid-desi-crossmatch@1` run；它们仍等待研究者的
`human_filter`，cutout/export 仍 pending。当前另有一个只读 Astroquery Agent 会话等待
`call_mcp_tool` 人工确认，详见文末 r17 章节。

## 新 session 从这里开始

用户要求以 Workspace 为主实现底部 Agent 和 CLI，并让 Agent 与数据生产
Workflow 遵循相同的确定性步骤。实现已落在当前未提交工作树中；Workspace
基线提交为 `008d1b478a4863f257a5b63ae76ac60b4a8c7a53`。Warehouse 仓库仍有大量
未提交的扫描、WCS 和 Operator 改动，不能假设两个仓库都已提交。

**Scanner 分片摘要阻塞已修复并部署。** 17 个原有成功 Job 已显式重新校验，
保留 34,000 个 accepted 文件；Workspace 已恢复这些 child run 的正常轮询和
自动点位入库。公开 W1 点位查询与影像覆盖检查均已返回有效结果，仍在增量索引。
原有四个全量批次继续执行；不要重复提交全量扫描。下面记录恢复方式和验证边界。

## Agent 实现与 Dev 配置快照

Workflow 对 `euclid_catalog_query` / `desi_catalog_query` 使用专用 MCP 路由，按已发现的
JSON Schema 映射中心、半径和上限；工具不支持该请求形状时回退到 `es_query`。目录响应
兼容 `hits`、`objects`、`rows`、`records` 和数组。另有 `fits.cutout`、Agent 工具调用 ID、
派生坐标 Python 子进程 traceparent 与退出码。服务的 `console` 日志为 JSON 单行；路径和
URL 会脱敏，UUID/长十六进制 ID 会替换，Error 只记录错误类型。

本地 `npm run build` 与 `git diff --check` 通过；没有运行测试或修改 Dev 部署。
只读查询时 Dev Workspace 配有 1 个 AI Provider、0 个已配置的外联 Workspace MCP Server，未设置
`OTEL_EXPORTER_OTLP_ENDPOINT`；当前 Deployment 只有 Workspace 与 Downloader，没有
Workspace Scanner Deployment。这里的 0 个 MCP Server 指系统配置中的外联服务；Workspace
自带 `/mcp` 入口不计入该数量。故该代码不能据此证明真实目录、cutout、TraceQL 或
PromQL 验收通过。

交叉匹配 Workflow 接受 RA/DEC 检索，也可用已登记的本地或 S3 CSV/FITS 星表替换
Euclid 或 DESI 一侧，另一侧仍由远程目录提供。读取受 Workspace Connector 与凭据约束，
支持常见列名自动识别和显式列映射；缺失对象 ID 时生成可复现的行 ID。列映射包括坐标、
测光、分类、Tile/Brick 和 FITS 图像路径。来源资产 ID、格式、SHA-256、字节数、扫描行数
和选中行数进入运行摘要与血缘。FITS 表 HDU 可显式选择，cutout 可以按需关闭。

非标准列映射和缺失 ID 的补齐已实现。Workflow 另接受 `catalogFields`，按 Euclid / DESI
分别映射最多 16 个附加标量字段；本地 CSV/FITS 和远程目录查询都保留所选值，结果按来源
放入 `euclidFields` / `desiFields`，支持 HITL 条件筛选并导出到带目录名前缀的 CSV 列。
缺失坐标仍不能自动补造；字段大小、数组长度有明确上限。新增本地 CSV、FITS 表及模拟 S3
对象存储回归覆盖了读入和字段传递。代码与模拟对象存储测试不能证明生产 S3、远程目录字段
投影、250 角秒查询五分钟性能、真实 MCP 服务可用率、研究者试用或正式 v1.0 发布；这些仍需独立运行证据。

## 底部 Agent 开发入口

| 内容 | 入口 |
| --- | --- |
| 底部面板、输入、会话选择、附加上下文、工具确认 | `viewer/src/agent-dock.ts` 的 `AgentDock` |
| 面板 DOM | `viewer/index.html` 的 `#agent-panel`、`#agent-collapsed-form` |
| 布局和样式 | `viewer/src/styles.css`，搜索 `agent-panel`、`agent-collapsed-form`；存在多处后置覆盖规则 |
| 初始化与页面连接 | `viewer/src/main.ts` 的 `new AgentDock(...)`、`agentDock.initialize()` |
| 前端 API | `viewer/src/api.ts` 的 `workspaceAgent*` 方法 |
| HTTP 接口 | `src/http-server.ts` 的 `/api/agent/workspace-sessions`、`/:id/messages`、`/:id/confirm` |
| 会话、模型调用、工具执行 | `src/workspace-agent.ts` 的 `WorkspaceAgentService` |
| 模型兼容与配置 | `src/ai-provider-client.ts`、`src/system-config.ts` |
| 已有测试 | `test/e2e/agent-dock.spec.ts`、`test/ai-provider-client.test.ts` |

底部 Agent 使用 `WorkspaceAgentService`。另一个 `src/agent.ts` 和
`/api/agent/sessions` 属于原有工作流对话接口，修改前先确认目标接口。
当前消息请求返回整份会话；界面只有底部一个输入框，展开面板会挤压主内容。
Agent 布局 E2E mock 了会话接口，不能把它当成真实模型或工具调用验收。

底部 Agent 现通过 Workspace CLI 操作通用 `/api/...` 路由；内置工具覆盖资产、
Connector、生产任务、Workflow、MCP 调用和只读专业 Agent。写操作与非只读
MCP 工具需界面确认。CLI 支持 JSON、stdin/stdout 和 trace context 透传；Agent
通过 `X-ASA-Agent-Invocation` 标记对话触发的 Workflow，使其 trace 接在
`chat.turn` 下。

Euclid × DESI 使用已注册的 `euclid-desi-crossmatch@1` Workflow。数据生产 Tab
和 Agent 共用 Workflow 定义与步骤：真实目录查询、坐标规范化、球面匹配、人工
筛选、可选 FITS cutout、导出和血缘记录。Agent 和数据生产 Tab 默认开启
cutout；Workflow 通过 Workspace 配置发现 MCP 工具，不把任务状态或产物交给
`astro-code` 管理。`astro-code` 只复用了 tile/source 路径解析与批量 cutout
调用约定。已登记 CSV/FITS 星表可以替换一侧输入，随后仍经过相同的规范化、匹配、人工
筛选、cutout 和导出步骤。

遥测已接入 OTLP/HTTP、GenAI 指标、Agent/CLI/MCP/Workflow/HITL/扫描/下载 span，
MCP HTTP 与 `_meta.traceparent` 同时注入。人工等待不持有长 span；恢复时用保存的
trace context 创建 HITL 与 `workflow.resume` span。部署由 Helm values 控制；
本地与未配置 OTLP endpoint 时 telemetry no-op。

会话文件位于 `<stateRoot>/agent/workspace-agent-sessions.json`。本轮通过
`npm run build`、`npm run verify:chart`、启用遥测的 Helm 渲染检查和
`git diff --check`；本轮重新运行的 `npm run build` 通过，未运行测试或部署。
尚未进行真实天文用户试用或 Grafana/Tempo 验收。Workspace `/mcp` 现在暴露
`euclid_catalog_query`、`desi_catalog_query` 和 `execute_cutout_group`。目录工具复用
Workflow 的查询路由；cutout 对已登记且 ready 的本地 Connector，以及匹配已登记 S3
Connector bucket/prefix 的精确 `s3://bucket/key`，使用 Workspace 内 Astropy/WCS 执行器。
S3 图像按 HTTP Range 分块读取 FITS section；访问密钥保留在 Workspace 主进程，不传入
Python 子进程，并校验对象大小、ETag 和 Range 响应。成功 FITS 文件登记为 Workflow
artifact，可由 `/api/workflow-runs/:id/artifacts/:name` 下载。S3 通配符和其他非本地来源
仍委托给已配置的外部 FITS cutout MCP；Workspace MCP 服务名会从后端候选中排除，防止递归调用。
外部 cutout MCP 仍须同时提供 `execute_cutout_group` 和 `read_cutout_artifacts`：Workspace
分段取回 FITS、校验字节范围后登记到同一 WorkflowRun；缺少读取工具时会在执行前明确失败。

本轮又补上 Workflow/HITL 重启恢复：已提交的人工筛选动作和筛选条件写入
WorkflowRun，服务启动完成后恢复 queued run，并续跑带决策 checkpoint 的 run；未提交
checkpoint 的 running run 仍标记失败。成功完成的 FITS cutout 批次（每批最多 100 个目标）
会先登记结果和 artifact，再保存到 run；恢复或重试时复用这些批次，跳过已持久化的
cutout 调用。远端调用完成但 Workspace 尚未写入该批 checkpoint 时仍可能重试，外部
cutout 服务尚未提供跨系统 exactly-once 契约。等待中的 Workflow 与 Agent 工具确认会话
会在服务启动时重建 `asa.hitl.pending` 计数。Agent MCP 工具发现和 CLI API 执行入口均
屏蔽直接目录查询、`es_query` 与 cutout 调用，要求科学工作经过注册的 Workspace Workflow。

以上重启恢复和工具边界改动已通过 Workspace `npm run build` 与 `git diff --check`；
没有运行测试、重启服务、部署或进行 live MCP/OTel 验收。构建仍报告前端 bundle 大于
500 kB 的提示。

### 外部 MCP 源码契约复核（2026-11-03）

只读检查相邻仓库后，外部实现与一方工具入口需按以下契约理解：

- `/home/aaron/Repo/euclid-mcp` 的 `analysis-catalog` 暴露 FITS 文件列表、头信息、字段/分页读取和 tile 解析工具，并支持本地/S3 路径；它没有 RA/DEC 圆锥搜索工具。Workspace 的 Euclid/DESI 坐标查询工具会优先使用配置服务中参数 schema 可适配的同名工具，其次调用 `es_query`，最后使用默认 catalog MCP URL。不能把当前 euclid-mcp 源码当作已提供坐标查询的 Euclid 后端。
- `/home/aaron/Repo/desi-mcp` 现在暴露 `execute_cutout_group` 与 `read_cutout_artifacts`。输出根由 `FITS_CUTOUT_OUTPUT_PREFIX` 固定；读取工具只接受该根下的文件，每个文件最多 5 MiB、每次响应最多 3 MiB 原始字节。Workspace 校验分段偏移与内容长度后，把 FITS 登记为自己的 Workflow artifact，因此默认独立 PVC 也不需要共享挂载；S3 输出仍需在 cutout 服务端配置输出凭据与前缀。
- 两个 MCP 仓库都有部署配置，但本轮未检查实时 MCP health、实际服务版本或服务端 S3 凭据。部署新的 FITS MCP 后，需在 Workspace 刷新该 Server 的工具列表，确保发现 `read_cutout_artifacts`。源码和构建通过不等于 Euclid/DESI 真实查询、远程 S3 读取及完整流程已验收。

本轮重新执行 Workspace 与 fits-cutout MCP 的 `npm run build`、Python `py_compile` 和 staged/unstaged `git diff --check` 均通过；没有运行测试或部署。Vite 构建报告现有主 bundle 超过 500 kB 的提示，不影响构建退出状态。

### 2026-11-04 实施补充

Helm values schema 已补充 `scanner` 与 `telemetry` 参数约束，并限制只有 `environment=dev` 才能启用内容采集。独立 Scanner 的 HTTP 入口仅响应 `GET /healthz`，扫描器 Pod 不再接受 Workspace 业务路由。

本次补丁后没有重新构建或部署。已有 `npm test` 复跑停在 `test/ai-provider-client.test.ts` 的 Agent CLI 确认用例：临时会话已经持久化为 `waiting_for_confirmation`，但确认后的步骤没有完成；进程运行约 8 分钟后已停止，未取得完整测试结果。没有启动第二份测试进程。

#### 2026-11-04 后续回归核验

已新增 `test/workflow-cutout.test.ts`，覆盖目录匹配、HITL 确认、Euclid/DESI
分组 cutout、远程 FITS 分段读取、Workspace artifact 登记、CSV 导出和 lineage。
`npm run verify` 通过：423 项测试中 419 项通过、4 项跳过；类型检查、服务端/UI/CLI
构建及 Helm lint/render 均通过。前端主 bundle 仍有超过 500 kB 的构建提示。

当日只读复核 Dev：Workspace 仍为 Helm revision 122、镜像
`0.0.1-dev-20261103-csst-quality-r3`；Downloader 正常。Workspace
`GET /api/system-config/mcp-servers` 返回 0 个外联 MCP Server，Pod 中
`OTEL_EXPORTER_OTLP_ENDPOINT` 未设置；同集群虽有 `astro-all` 和 OTEL Collector，
当前 Workspace 部署未配置调用它们的 MCP/遥测链路。没有部署本地改动。真实目录查询、
生产 S3 cutout、TraceQL/PromQL 面板验收以及 v1.0 发布仍待配置和线上证据。

完整科学流程仍需要可用的 AI Provider、Euclid/DESI 目录 MCP 或默认目录端点，以及
S3 通配符或未登记远程源 cutout 所需的外部 FITS MCP。此代码不能证明 CSV/FITS/S3 生产端到端、250
角秒候选池耗时、MCP 可用率、真实用户试用或正式 v1.0 发布；这些仍需运行证据。

本地代码修改不影响线上 Scanner Job。Workspace 滚动部署会中断当时的页面和
Agent 请求，Scanner Job 在独立 Pod 中继续；队列从持久化清单恢复。部署包应
包含当前已提交的扫描修复，持久化卷与 Helm 运行配置沿用当前部署。

### 2026-11-04 Dev Agent 发布

更新后的 `scripts/mcp-http-smoke.ts` 检查资产列表/读取、Euclid 查询、DESI 查询和
FITS 分组裁切五项 Workspace MCP 工具，并容许服务暴露额外工具。本地临时状态实例、
容器镜像 `/healthz` 和只读资产列表 smoke 均通过。`npm run build`、
`npm run verify:chart` 与 `git diff --check` 通过；此前本日 `npm run verify` 的
419 通过、4 跳过也适用于本次 smoke 脚本修改之前的源码。未因本次脚本修改重跑全量测试。

已构建并推送 Dev 镜像
`0.0.1-dev-20261104-agent-r1`，Helm release `asa` 升级到 revision **123**。
工作树包含未提交改动，因此镜像 `build.commit` 明确为空，没有指向不匹配的 Git
commit；这不是 v1.0 正式发布。新 Pod Ready 且零重启，独立扫描 Job 未随 Workspace
rollout 重启。

线上只读核验结果：`euclid-desi-crossmatch@1` 已暴露
`parse_input → query_euclid → query_desi → normalize → crossmatch → human_filter → cutout → export`；
`/mcp` 返回五项预期工具；同一镜像中的 Workspace CLI `system runtime` 可调用 API。
`OTEL_EXPORTER_OTLP_ENDPOINT`、HTTP/protobuf、`asa-workspace`、
`parentbased_always_on` 和 15 秒指标间隔均已注入。Collector `8889/metrics` 已出现
`asa-workspace` 的 spanmetrics，Tempo 的 `service.name` 标签能发现该服务，使用
`q={resource.service.name="asa-workspace"}` 可查到实际 trace。

镜像构建时 `npm ci` 报告依赖 advisory；随后 `npm audit --omit=dev` 汇总为 11 条
production advisory（1 critical、5 high、5 moderate），包括 MCP SDK 与 Express 相关
依赖，审计结果显示有可用修复。当前 Dev 镜像尚未升级这些依赖，应在正式 v1.0 前处理。

科学后端仍阻塞真实验收：外联 Workspace MCP Server 数为 0；默认目录 MCP 的工具列表
可访问，但 `list_catalogs` 报其 Elasticsearch `10.103.243.201:9200` connection refused。
集群没有 Euclid、DESI 或 FITS cutout MCP Deployment。Workspace MCP 工具存在不代表
查询和远程 cutout 已可运行。Scanner 仍关闭：当前状态卷为 ReadWriteOnce、元数据为
SQLite，Chart 要求 Scanner 使用 ReadWriteMany 状态卷与 PostgreSQL；需要先完成存储/元数据
迁移再启用。真实 S3 cutout、250 角秒五分钟指标、服务可用率、研究者试用、TraceQL/
PromQL 面板验收与正式 v1.0 仍未完成。

### 2026-11-04 Dev Agent r2 与遥测核验

依赖升级后，`npm audit --omit=dev` 为 0 条 production advisory。Workspace Dev
当前运行镜像 `0.0.1-dev-20261104-agent-r2`，Helm revision **124**，digest 为
`sha256:8dc83acf3a52e3a2b3e9712679078ad3230c0004a2292c3ccfc7a2e7a2a03fcd`；核验时
Pod `asa-workspace-75678877cc-wwlzh` Ready，零重启。此次核对没有修改或重新部署线上服务。

Tempo 查询到 Agent `list_workflows` 请求对应的 trace，`chat.turn` 是根 span，
其 `parentSpanId` 为空；模型请求、Workspace CLI 和工具执行作为它的子 span。此前
`name="chat.turn"` 的搜索未命中不能作为缺少根 span 的证据。当前 `withRootSpan()`
已通过 OTel `root: true` 显式建立根，并把活动 HTTP span 作为 link；无需额外改动代码。

本次对当前工作树执行 `npm run build`、`npm run verify:chart` 和 `git diff --check`；
构建、Helm lint/render 与差异空白检查通过。按本轮约束没有运行测试套件。production
audit 为 0 的结果来自依赖升级后的前序核验。

外部科学后端状态未变：Workspace 外联 MCP Server 数为 0；默认目录 MCP 的
`list_catalogs` 仍因 Elasticsearch `10.103.243.201:9200` connection refused 失败；
集群没有 Euclid、DESI 或 FITS cutout MCP Deployment。Scanner 仍因 RWO 状态卷和
SQLite 元数据不满足其 RWX/PostgreSQL 约束而关闭。真实 S3 cutout、250 角秒五分钟
性能、MCP 可用率、研究者试用、TraceQL/PromQL 面板验收和 v1.0 发布仍未完成。

### 2026-11-04 Agent → CLI 在线只读验收

Dev 当前运行镜像 `0.0.1-dev-20261104-agent-r3`，Helm revision **125**，digest
`sha256:c279ea5c900a407af4fd9d472f2e1a1b2fde1708d7171e3d3268a2aec584b78d`。
Pod `asa-workspace-58d6ff4d46-6cs5x` Ready、零重启。OTLP endpoint、
`OTEL_SERVICE_NAME=asa-workspace` 和 15 秒指标间隔均已注入。

用线上 Workspace CLI 创建可见验收会话
`wag_df476602-34a2-49f0-95cc-7e8a7124d210`，只请求列出 Workflow 名称和版本。
Agent 实际调用 `list_workflows`，返回 `euclid-desi-crossmatch@1`、版本 1，
会话回到 `idle`；没有创建 Workflow run 或修改数据。Tempo trace
`bd07fad4a66e4858ea7577e200f53899` 的根为 `chat.turn`，包含 Agent 工具 span、
`subprocess workspace-cli`（退出码 0）及两个模型请求。Pushgateway 中该会话的
`asa_chat_turns_total`、GenAI token 和 spanmetrics 均有数据。

18:11 UTC 查询到 Workspace 共 **356** 条指标序列：当前 r3 Pod 188 条，旧 r2
Pod 标签仍有 168 条 spanmetrics 序列。总量低于 400；旧序列尚未全部消失，继续
观察 Collector 的 10 分钟过期行为。当前配置模型 `gpt-6-luna` 在指标的有限模型
枚举中未列出，因此 token 指标的 `gen_ai_request_model` 值被折叠为 `other`；trace
仍保留实际模型名。

此验收只证明 Agent → Workspace CLI → Workflow 列表的只读链路和本地遥测；外联
Workspace MCP Server 仍为 0，Euclid、DESI 与 FITS cutout 线上服务未部署，因此
没有验收目录查询、S3 cutout、完整科学 Workflow、8 个 Grafana 面板或 250 角秒
五分钟性能。

### 2026-11-04 Workflow CLI 与 Astroquery MCP 核对

Workspace CLI 新增 `workflow(s) list|get|run|run-get|decide|artifact` 命令，覆盖
Workflow 定义读取、run 创建/读取、提交人工决策和产物落盘下载；下载不会覆盖现有文件。
`get` 和 `run` 使用版本化 Workflow key（例如 `euclid-desi-crossmatch@1`）；通用
`api` 子命令仍覆盖其余 `/api/...` 路由。CLI 构建和 `git diff --check` 通过。
从本地 CLI 对 Dev 做只读 `workflows list` 与 `workflows get euclid-desi-crossmatch@1`，
成功返回定义与八个步骤；没有创建 Workflow run。本轮未运行测试套件。

只读连接集群内 `astro-sdk/astro-all` Pod 的 `/astroquery/mcp`，从 Pod 环境读取
`API_TOKEN`，只在 Pod 内用于认证，未打印令牌。工具清单包括 SIMBAD 区域搜索、VizieR
目录发现/通用区域搜索和 Gaia 圆锥搜索；未发现名称或 schema 标识 Euclid Q1 MER、
DESI DR10 Tractor 专用查询的工具。VizieR 可接受通用查询，但目标 catalog ID、输出列、
坐标字段和响应契约尚未验证，不能把它接入 Euclid/DESI Workflow 作为已确认后端。
两次只读 VizieR 目录发现调用在客户端约 45 秒后被取消，没有取得结果；没有修改
Workspace 的 MCP 配置，外联 MCP Server 仍为 0。Astroquery 可能作为通用目录能力候选，
但真实目标目录查询仍需已确认的数据源与字段契约。

继续查找默认 `eva24002-entrance` 后端的部署来源：当前 `default` Kubernetes context
没有 Euclid、DESI 或 FITS cutout MCP Deployment/Service；集群内 `astro-sdk/astro-all`
是独立 Astroquery 服务。`euclid-mcp` 仓库的 `analysis-catalog` 部署配置只覆盖 FITS
文件浏览、头信息和分页读取；`desi-mcp` Helm Chart 提供分组 FITS cutout 与产物读取，
不提供 Euclid/DESI 星表坐标查询。仓库搜索没有找到默认 `eva24002-entrance` MCP 的
部署配置。本机另一个 kubeconfig context 的 API 请求超时，无法从那里检查或部署。
因此没有可用于替换当前拒绝连接 Elasticsearch 的 Euclid/DESI 目录后端来源。

同一 Dev 的只读 CLI 清单有 21 个资产，其中唯一 `kind=catalog` 资产是 COSMOS 170W
CSV；Euclid 资产是 FITS 图像。22 个 Connector 中 Euclid 图像 Connector 为 ready，
Legacy Survey DR10 South HDF5 inventory Connector 为 draft；没有已登记的 Euclid Q1
MER 或 DESI DR10 Tractor 星表可供两侧本地替换。

`atlas-warehouse/source-catalog-inventory-20261104` 只读 Job 已完成（1/1）。它检查
挂载的 `/data` 目录（最多三层），并按限定文件名搜索 Tractor、DESI DR10、
`MER_FINAL_CAT`，另按 FITS 扩展名搜索最多五层。日志只列出
`cosmos-parameter-prediction` 子目录，没有命中目标星表文件名或 FITS 文件。此结果
只描述该 Job 可见的 source-catalog 卷和搜索范围，不是集群全局文件清单，也不证明
该目录内不存在其他 CSV；它不能提供 Euclid/DESI Workflow 所需的已确认目录查询契约。
Job 未修改 Workspace 资产、Connector 或科学数据。

本轮重新执行 `npm run build`、`npm test`、`npm run verify:chart`、`git diff --check`
和 `git diff --cached --check` 均通过。测试为 425 项：421 通过、4 跳过、0 失败；
没有部署。Viewer 构建仍提示主 bundle 超过 500 kB。

## Dev 运行版本

- 地址：<http://astro.workspace.dev.72602.space:32080>。
- Workspace：Helm release `asa`，namespace `asa-workspace`，revision **125**；
  镜像 `0.0.1-dev-20261104-agent-r3`。
- Workspace 镜像 digest：
  `sha256:c279ea5c900a407af4fd9d472f2e1a1b2fde1708d7171e3d3268a2aec584b78d`。
- 核对时主 Pod `asa-workspace-58d6ff4d46-6cs5x` Ready，零重启。
- Warehouse Operator：namespace `atlas-system`，release
  `atlas-warehouse-operator`，revision **27**；镜像
  `0.2.0-20261103-partition-summary-r2`。
- 默认 Scanner：`0.2.0-20261103-partition-summary-r2`；原有全量请求显式绑定
  `0.2.0-20261103-csst-quality-r1`，继续使用原镜像，无需修改或重扫。

此前的扫描修复只修改并部署 Warehouse，当时 Workspace 保持 revision 122；随后
Workspace Agent 按上文记录升级到 revision 125。
部署使用私有 receipt 内的运行 chart，
以保留线上探针、Downloader Secret 和 MOC discovery 配置。后续部署先比较
实际 release 的 values/manifest，尤其不要仅按旧提交重新构建 Warehouse。

## CSST 最新现场：摘要恢复已完成，增量入库中

四个全量来源均已冻结清单：

| 分组 | 文件总数 | 总分片 | 当前阶段 |
| --- | ---: | ---: | --- |
| W1 | 356,112 | 179 | 扫描与点位入库并行进行 |
| W2 | 365,472 | 183 | 等待 Scanner 槽位 |
| W3 | 188,136 | 95 | 等待 Scanner 槽位 |
| W4 | 211,824 | 106 | 等待 Scanner 槽位 |

四组资产和 root run ID 的完整表见
[质量重扫记录](csst-w1-w4-quality-rescan-20261103.md#full-scan-tracking)。
继续原有批次：均为 `csst-wcs-v1`，无 `maxFiles` 上限，每片最多 2,000 个文件，
最多两个全量 Scanner Job。恢复期间的 child `running` 状态也包含等待正常轮询
的已完成 Job，判断并发应查看实际活动 Scanner Job，不能直接累加 child 状态。
最终 MOC 等完整批次成功再发布，不能据首批点位声称 W1–W4 全部完成。

### 修复与恢复机制

旧 Scanner 的 JSON 摘要漏了 `partitionVersion`，兼容文本有版本；Operator
优先 JSON，且白名单漏了版本，因此成功分片被判为
`ScannerPartitionSummaryMismatch`。这与 FITS 被质量规则跳过不同。

Warehouse 已完成并部署：

- `ScanSummary` 直接序列化版本；Operator 保留该字段。旧 JSON 仅在完整兼容文本
  的所有共同字段完全一致时补回缺失版本，显式错误版本和计数仍严格拒绝。
- 注解 `atlas.zhejianglab.org/revalidate-scanner-summary` 提供单次显式重验。
  仅摘要校验失败可用；校验原 Job 成功、owner UID、请求 generation、计划 hash、
  镜像和完整摘要。重验不创建执行资源，不访问科学来源。
- CRD 已补齐 `summaryRevalidationToken`、`summaryRevalidationPreviousReason`。
  既有集群需要单独更新 CRD，Helm upgrade 不会升级 `crds/` 定义。
- 17 个误判分片均报告 `SUCCEEDED / ScannerSummaryRevalidated`，共 34,000
  accepted、0 skipped；原 Job UID/请求与清单保留，未重放扫描。
- 私有维护脚本先检查 Operator 裁决及完整身份，再只把原失败 child 置为
  `running`。由应用自身轮询确认成功、创建自动 point task；没有直接伪造入库成功。
  首个请求的审计字段曾被旧 CRD 丢弃，补 schema 后仅恢复审计字段，未修改科学裁决。

14:40:33 的快照：W1 已成功扫描 **18 个分片 / 36,000 个文件**，根任务的
processed/accepted 均为 36,000、skipped 为 0、失败分片为 0，18 个分片均已自动
创建点位任务。公开查询已返回 **1,370 个新点**，仍为 `indexing: true`，其余点位
正在补齐；18 个 derived task 当时均无失败。跳过清单 HTTP 200、0 行，与计数一致。
14:42 对首个恢复分片中已有边界的点进行公开坐标检查，返回 **10 个影像覆盖**。
旧 NSIDE 16 / pixel 815 仍为 0；本轮再次核对原来的 12 个错误点 ID，均为 HTTP 404。
完整统计以修复 receipt 的
`recovery-observation.json` 和实时 API 为准。根计数、child 和 derived task
分别刷新；恢复时单次快照可能短暂不同步，不能把已扫描数当成已索引点数。

### 验证与运行限制

实际 Scanner `ScanSummary` 序列化直接送入 parser/validator 的回归先红后绿，
覆盖缺失版本、匹配旧文本、显式错误版本、冲突身份和错误计数。重验覆盖单次 token、
非摘要失败不重试、严格 Job 身份检查。完整 Warehouse 静态 gate 11 项均通过。
公开点位查询、坐标影像覆盖及跳过清单是实际部署的应用路径。

现场还观察到 Workspace Elasticsearch 于 14:32 因 OOM 重启一次，之后恢复 yellow
（单节点副本未分配），点位主分片正常，Workspace 又 Ready，零重启。
NFS/SQLite 和 ES 写入较慢，部分查询曾超时。本轮未改变基础设施资源配置。
本轮新跑的 live gate：Workspace remote MinIO caller **PASSED**；baseline
和 Asset suite 因 ES 超时及外部 Gaia MOC `DiscoveryTlsError` 失败；Workspace
local caller 等待 180 秒仍未完成。完整 Kubernetes gate 未通过。结果见修复
receipt 的 `live-validation.json`，与之前样本验收结果分开解读。

**后续新增执行问题：** 14:46 之后，W1 的 `s000018` 报
`FAILED / BackoffLimitExceeded`。原 Job 日志是 `finishLayerUpdate` 调用 ES
`_refresh` 时 `HttpTimeoutException`，属于实际索引执行失败，不能通过摘要重验
恢复。保留原失败请求、Job 和证据；后续分片仍继续扫描。完成整批后可通过现有
根批次 retry 接口只重试失败分片，成功分片与冻结清单保持。当前 retry 入口只
接受已经 `failed` 的根批次；不要把仍运行的 batch 或执行失败伪装成摘要错误。
摘要协议阻塞已解除，不等于 ES 容量/延迟问题已修复，最终 MOC 仍需全部分片成功。


## 已完成的实现与历史验证

- 所有 Warehouse 扫描默认跳过确定的文件格式/元数据错误；坏星表行拒绝整文件，
  丢弃该文件之前的中间结果。传输、权限、snapshot、worker、lease、索引错误
  仍需明确失败，不能伪装为文件跳过。
- CSST 使用 `csst-wcs-v1`：相对合法 `PIXSCAL1/2` 的尺度偏差大于 1%，或轴夹角
  偏离 90° 大于 1°，拒绝文件；恰好等于阈值通过；缺少标称尺度拒绝，不默认填 0.074。
- Workspace 只使用通过校验的所选 science HDU，隔离旧质量批次，阻止被拒绝头
  通过 pointing fallback 再生成点。旧索引文档是逻辑隔离，尚未物理清理。
- 真实样本 32 文件：20 accepted、12 skipped，生成 20 个位置/影像边界，四个私有
  MOC ready；被拒绝文件没有生成点。原有 12 个样本点 ID 返回 404。
- Workspace `npm run verify`：409 passed、4 skipped、0 failed；此前 Aladin
  浏览器场景 11 个通过。Warehouse 完整静态 gate 已通过。
- Warehouse S3/local、Asset scan 验收通过，Workspace 两种 caller smoke 通过。
  baseline/Asset **整套**仍因外部 Gaia MOC 的 `DiscoveryTlsError` 失败。
  这些验证没有覆盖上述真实分片 JSON 验收缺口，不能据此声称全量链路通过。

原始问题和样本证据另见 `docs/workspace-fits-position-audit-20261103.md`、
`docs/csst-w1-w4-header-sample-audit-20261103.md`。

## 继续核对的命令和证据

先获取 Ready 的 Workspace Pod 名，避免依赖旧 Pod 名。只读扫描快照可运行：

```bash
kubectl -n asa-workspace get pods -l app.kubernetes.io/name=asa-workspace
kubectl -n asa-workspace exec <ready-workspace-pod> -- \
  node /tmp/csst-quality-observe-full-scans.mjs
```

脚本若因 Pod 更新而消失，可从私有 receipt 的 `observe-full-scans.mjs` 复制到
新 Pod 的 `/tmp/csst-quality-observe-full-scans.mjs`。脚本只观察现有任务。
`register-and-scan.mjs` 只运行 `status`，不要重复运行 `register` 或 `submit`。

原始实现 receipt：`/tmp/csst-quality-implementation-20261103-ih175mv8`；指针：
`/tmp/csst-quality-implementation-path`。其中保存原始差异、镜像/deploy receipts、
验证日志和观察器；最新固定快照为 `handoff-status-20261103.json`。
完整 run 现场另保存在证据卷的
`csst-quality-preflight-20261103/handoff-runs-20261103.json`。

`monitor-first-shards.py` 是有两小时时限的只读观察器，不能修复协议失败。
该观察器曾生成 `passed: false` 的中间结果；它已到时退出，不能将其当成修复后的通过证明。
观察器退出不代表 Scanner Job 停止。

本轮修复 receipt：`/tmp/csst-partition-summary-fix-20261103-2b0z9xj3`；指针
`/tmp/csst-partition-summary-fix-path`。其中包含回归红/绿日志、最终静态 gate、
镜像/Helm/CRD 差异、17 个请求重验前后状态、恢复脚本、公开查询快照与 live smoke。
`recovery-validation.json` 记录摘要恢复验收通过；`original-job-retention-proof.json`
记录 16 个基线 Job UID 比较，以及全部 17 个 Job 的创建/完成早于原失败裁决，
并核对原请求、计划和 owner。新出现的 ES 执行失败也单独记录在恢复验收 JSON 中。
恢复前的 child 记录也已私有备份至证据卷的
`csst-quality-preflight-20261103/summary-recovery-20261103/`。
恢复验收、最新 smoke 与 ES 失败证据也持久化在该目录的 `validation/` 下。
不要重复运行维护脚本或再次提交扫描；后续工作主要是观察增量索引与原批次完成。

集群持久化 tracking 位于证据卷的 `csst-quality-preflight-20261103/`，
冻结批次位于 `workspace-batches/<root-run>/batch.json`。恢复时保留这些清单、
原始文件和历史证据。冻结的 `/home/aaron/Repo/data-warehouse` 不参与修改或运行。
私有 source 路径、原始 FITS 头和凭据不写入公开文档或终端输出。

Workspace 开发校验使用 `package.json` 的现有 verify/test 命令；Warehouse 改动
遵循其 `AGENTS.md` 和 `warehouse-validation` 技能。用户已允许下载使用代理
`http://10.15.49.212:7890`。Dev 的直接 HTTP 核对用 `curl --noproxy '*'`，
避免本机代理将正常站点请求变成 502。

### 2026-11-04 Dev Agent r7 发布与 FITS 星表复验

将已推送的 `0.0.1-dev-20261104-agent-r7` 部署到 Helm release `asa`，namespace
`asa-workspace`，revision **129**。保留现有 values，只覆盖镜像 tag。Pod
`asa-workspace-598557859d-j89wb` Ready，零重启；镜像 digest
`sha256:4390f3982b9de856807466021a38138a28aad25d2184a97d8cc4198b04a2b108`。
集群内与 Dev ingress 的 `/healthz` 均返回 200。部署包含 Recreate 短暂中断；
没有重启 Downloader 或独立扫描任务。

通过 Workspace CLI 创建复验 run
`wfr_20261103193329_f932665a`，Workflow `euclid-desi-crossmatch@1`。输入沿用
r6 的 RA `58.375`、Dec `-51.25`、`queryRadiusArcsec=250`、
`matchRadiusArcsec=1.5`、`limit=500` 和两份 S3 FITS catalog asset：

- Euclid asset `user-2c65d8d9-d05f-45cb-adf6-1d43b8f1a168`：扫描 465 行，选中
  214 行，SHA-256 `56593180cb28d502d21799a35b73ace4cd6cef3630efedf09c87c711cbd19ed0`。
- DESI asset `user-eae0d087-5532-42ec-af3a-991816b2f99e`：扫描 10,142 行，选中
  500 行，SHA-256 `2414213119d6f31a2039dbc80873269811eeecefab3cb0914e8dfcbc6e8b01fa`。

两个资产均从 Workspace catalog 读取；来源文件名推断 tile `102018211` 与 brick
`0583m512`。两边读取、坐标规范化和最近邻球面匹配均成功，得到 46 个候选；
从 run 开始到匹配完成约 26 秒，到达 `waiting_for_input` 人审闸门约 31 秒。候选
artifact `crossmatch.json` 为 16,092 字节，SHA-256
`495e5d3739eeee2448c79a94140ee28cedc1ca4838a6bff7067629d62a90e1b1`。46 条候选含
39 个不同 DESI 源行 ID；其中 6 个 DESI 源行关联多个 Euclid 候选，这是当前最近邻
匹配允许的多对一结果，不代表源行 ID 冲突。所有候选均带有预期 tile/brick，未发现
缺失 ID、tile 或 brick。

Tempo 按 `asa.workflow.run_id=wfr_20261103193329_f932665a` 搜索到 trace
`35b4101f9d1d91f3e3e07e96a7b415b2`：根 span `workflow.run` 带
`asa.workflow.key=euclid-desi-crossmatch@1` 与 `asa.workflow.outcome=waiting`，共
17 个 span，包含目录源读取、`parse_input` 至 `crossmatch` 的 Workflow step 和
`crossmatch.nearest_spherical` 工具调用。该次 trace 验证了运行级埋点；Grafana 八个
Agent & LLM 面板及完整 PromQL/TraceQL 验收仍未完成。

run 仍是 `waiting_for_input`；`human_filter` 等待研究者，`cutout` 与 `export`
尚未执行。未代替用户确认或拒绝候选，因此本次验证不能作为 FITS cutout 端到端通过
证据。Dev `/api/system-config/mcp-servers` 仍返回空列表；这次成功读取的是已登记的
S3 FITS 资产，不是实时外联 Euclid/DESI 目录 MCP 查询。真实 MCP 服务可用率、生产
S3 图像裁切、研究者试用、面板验收和 v1.0 发布仍待完成。

OpenCode CLI PoC 已提供只读查询和写操作工具；写操作会在启动 Workspace CLI 前通过
`context.ask` 按 HTTP 方法与 API 路径申请本次确认，不提供持久化的 `always` 规则，且
会将取消信号传给 CLI 子进程。PoC TypeScript 严格类型检查通过；真实权限提示、拒绝及
取消交互尚未验收。n8n/Bridge 运行 PoC 仍待固定 Bridge 仓库、版本和协议方向。

### 2026-11-04 Dev Agent r11 MCP 埋点部署

`WorkflowEngine.queryCatalogForMcp()` 现在在输入解析和工具调用外创建有界 root span；
直接 Workspace MCP cutout 调用也创建工具 root span，Workflow-run cutout 保留原有
`fits.cutout` span。`npm run build` 与 `git diff --check` 通过；未运行测试套件。

已构建并推送 `0.0.1-dev-20261104-agent-r11`，部署到 Helm release `asa`、namespace
`asa-workspace` 的 revision **133**，只覆盖 image tag 并复用原 values。Pod
`asa-workspace-7ddcb499b5-96rn7` Ready、零重启，镜像 digest
`sha256:7a29b3e63a1eeaa5b1622663c23a982351e0a59f5c804d163894b2f3966fd38f`；`/healthz`
返回 200。

只读 `/mcp` smoke 列出五项预期工具、读取 23 个资产，并从已登记 S3 FITS 资产得到
Euclid 214 行、DESI 500 行。等待超过 30 秒尾采样窗口后，Tempo 没有找到这些真实
MCP 调用对应的 `mcp.server.tool euclid_catalog_query`／`desi_catalog_query` trace；
Collector 的预采样 spanmetrics 也未见它们。Collector 当前 `asa-workspace` 全量采样
规则生效。另在隔离 Node 进程中直接调用查询 service method（一次验证错误路径、一次
使用 fake catalog 验证成功路径），两条 root span 均出现在 spanmetrics 与 Tempo；这
只验证 helper、exporter 和查询接口本身，不证明真实 MCP transport 已产生对应 span。
真实 MCP handler 到 OTel span 的关联仍待定位，不能将本次 smoke 记为 MCP trace 验收通过。

交叉匹配 run `wfr_20261103193329_f932665a` 保持 `waiting_for_input`，46 个候选仍待
研究者筛选；本轮没有提交决策，没有执行 cutout 或 export。

### 2026-11-04 Dev Agent r12 MCP trace 修复验收

根因是 HTTP instrumentation 对 `Accept: text/event-stream` 请求调用 `suppressTracing()`；
Streamable HTTP MCP 使用该 Accept 类型。`root: true` 只删除活动 parent span，不会清除
suppression 标记，因此 MCP handler 中的 `withRootSpan()` 曾返回 no-op span。现在
`withRootSpan()` 先对活动 context 调用 `unsuppressTracing()`，并在该 context 中启动 root
span；其余 context 值仍保留。`test/telemetry.test.ts` 新增 suppressed context 回归，确认
root 和 nested span 都被记录。`npx tsx --test test/telemetry.test.ts` 与 `npm run build`
通过。

已构建并推送镜像 `0.0.1-dev-20261104-agent-r12`，部署到 Helm release `asa`、namespace
`asa-workspace` 的 revision **134**。Pod `asa-workspace-6f64c5d5b-6ng8s` Ready、零重启，
镜像 digest `sha256:c67c9015d24e69b274bd19f016b1b055457114f83acdee25f6f746e7d8cc99b0`；
`/healthz` 返回 200。

部署后通过真实 Streamable HTTP `/mcp` transport 执行只读 smoke：列出五项预期工具和
23 个资产；对已登记 Euclid/DESI S3 FITS 星表在 `radiusArcsec=250` 查询，分别返回
214 和 500 行。该验证覆盖 Workspace MCP transport 与本地注册资产查询，不代表外部
Euclid/DESI MCP 服务查询或图像 cutout 验收。

等待超过 30 秒尾采样窗口后，Tempo 仍可查到查询 trace：Euclid
`db2f2c5bc8b72af54ba72eb061af1bc5` 和 DESI `330bb47bff77476cd9954e2b7b0544bb`，各含
5 个 span：MCP tool root、catalog source read、catalog query tool 和两个 HTTP client
span。Collector 预采样 spanmetrics 中，每个工具各有两组 `count=1`：不带 step ID 的
handler root，以及带 `query_euclid`／`query_desi` step ID 的查询 service root。路由层和
查询 service 层目前都会创建同名 root；每次查询因此还各有一个单 span handler trace，
service trace 通过 1 个 span link 关联 handler root。MCP transport 埋点现已有真实运行
证据；双 root 导致的额外 trace/指标维度仍可单独收敛。

原交叉匹配 run `wfr_20261103193329_f932665a` 仍是 `waiting_for_input`；没有提交人工
决策，没有触发 cutout 或 export。

### 2026-11-04 Dev Agent r13 MCP root 去重

HTTP route 与目录/cutout service 曾对同一调用分别创建同名 root，导致独立 trace 和重复
spanmetrics 维度。`/mcp` 现在只为 `list_user_assets` 和 `get_user_asset` 等没有 service
root 的工具创建 route root；Euclid/DESI 查询和 `execute_cutout_group` 使用 service 层
root。`withRootSpan()` 保留 suppressed request context 的修复。

全量 `npm test` 通过：427 项中 423 passed、4 skipped、0 failed；`npm run build`、
`npm run verify:chart` 通过。已构建并推送 `0.0.1-dev-20261104-agent-r13`，部署到 Helm
release `asa`、namespace `asa-workspace` 的 revision **135**。Pod
`asa-workspace-7dcb8c6cff-7xjqs` Ready、零重启，镜像 digest
`sha256:8c181ec8ee9dff42ac2158122b491210eed3e25dc13699e7d81edbeeb0d5e05b`；`/healthz`
返回 200。

真实 Streamable HTTP `/mcp` smoke 再次列出五项工具、23 个资产；使用已登记 Euclid/DESI
S3 FITS 星表、`radiusArcsec=250` 查询，分别返回 214 和 500 行。等待超过 30 秒尾采样
窗口后，Tempo 查到 Euclid trace `e8d480377d812cba35ee3741135c58b6` 与 DESI trace
`39bcd2b977b47d19200720d699f9cd9`，每条各含 5 个 span：MCP tool root、catalog source
read、catalog query tool 和两个 HTTP client span。Collector 预采样 spanmetrics 每侧只有
一条带 `query_euclid`／`query_desi` 的工具序列，count=1；route/service 双 root 已消失。
该运行证据仍只覆盖 Workspace 对已登记 S3 星表的 MCP 查询，不代表外部目录 MCP 服务、
生产图像 cutout、服务可用率或研究者试用完成。

原交叉匹配 run `wfr_20261103193329_f932665a` 仍为 `waiting_for_input`；
`human_filter` 等待研究者，`cutout` 与 `export` 仍 pending。本次没有提交人工决策。

### 2026-11-04 CLI 打包与本地验收补充

当前工作树补齐了桌面发行包中的 Workspace CLI：`prepare:server` 将 CLI 入口和
`type: module` 元数据放入 `build/packages/cli`，electron-builder 将该目录放入
应用资源。桌面 smoke 不只检查文件存在，还会启动打包服务并运行 CLI 查询
`system runtime`。本地 `npm run dev` 若没有已编译 CLI，则用 `tsx` 执行 CLI 源码；
生产仍走编译入口。

最终 `npm run verify` 通过：427 项中 423 passed、4 skipped、0 failed；类型检查、
服务端/Viewer/CLI 构建和 Helm lint/render 均通过。`desktop/npm run prepare:server`
及 `node desktop/scripts/smoke-main.cjs` 通过，后者实际调用打包 CLI；启用遥测的
Helm render 与 staged/unstaged `git diff --check` 也通过。Viewer bundle 仍大于
500 kB 的 Vite 提示。

本轮未构建/推送镜像或升级 Helm。Dev 的最后已知版本仍是 Agent r13、Helm revision
135；工作树中的当前实现和桌面打包补丁尚未部署。真实 Euclid/DESI 外联服务、FITS
远程 cutout、Scanner 的 PostgreSQL/RWX 存储前置条件、Grafana 完整面板验收、研究者
试用与 v1.0 发布仍按前文列为外部验收项。

### 2026-11-04 Grafana、Tempo 与 OpenCode 运行复验

Dev 仍为 Agent r13、Helm revision 135。通过 Workspace CLI 建立只读 Agent 会话
`wag_75fb825e-c0fe-4cc4-ac2b-74771af716ad`，两轮均调用 `list_workflows` 并返回
`euclid-desi-crossmatch@1`；会话结束时为 `idle`。没有创建 Workflow run 或提交人工决策。
新 `chat.turn` trace 在 Tempo 可查，根服务为 `asa-workspace`。

按 `.tmp/WORKSPACE_REQUIREMENTS.md` §9 检查最近 24 小时数据：T1/T2 为 0，T3 有数据，
T4 命中 4 条 trace（其中包含 selftest）；T5/T6 为 0。N1/N2 均为 0。T1/T2 缺少
已配置的外部 `astro-sdk-services` 调用；T5 缺少人工决策后的 HITL span；T6 缺少独立
Scanner trace，Scanner 仍关闭。

Grafana `asa-agent-llm` 面板的 8 个 PromQL 查询目标中，Tokens range、LLM calls range、
Tokens by model/type 和 LLM latency p95 有数值，其余 4 个目标（Task p95、Workflow p50/p95
两个目标、Step p95）为空。P3 spanmetrics 有数据；P4 的非空 workflow key 序列为 0，
步骤查询当前只有 `query_euclid` / `query_desi`，不是完整 Workflow run 的指标。P5 服务图
为空，P6 chat-turn 有数据。PromQL B1 返回 287 条序列，低于 400。原始 B2 序列标签还出现
`service_name` 以及 `container`、`endpoint`、`namespace`、`pod`、`service`；需区分
spanmetrics 默认维度与 Prometheus scrape 标签后，才能判定严格标签白名单是否通过。
面板标题仍显示 “waiting on Workspace”，即使部分查询已有数据。

OpenCode 1.19.4 PoC 已在真实运行时完成只读 `/api/workflows` 调用，并通过主 Agent 的
`task` 委派给 `workflow-operator` 子 Agent 完成只读查询。TUI 展示了 `Allow once`、
`Allow always`、`Reject`；选择拒绝后导出的工具状态为
`The user rejected permission to use this specific tool call.`，没有执行 Workspace CLI。
取消路径用本机延迟 API 验证：取消 OpenCode 调用后，测试服务记录到响应在完成前中止。
这验证了提示、拒绝、只读子 Agent 和 CLI 子进程取消路径，不代表 n8n/Bridge 兼容性通过。

本轮未部署工作树中的新改动。外联 Euclid/DESI 查询服务与 FITS MCP 仍未部署；已有
Workflow 仍停在人审闸门，未执行 cutout/export。Scanner 的状态 PVC 仍为 RWO，元数据仍是
SQLite；在 PostgreSQL 数据迁移和 RWX 状态卷切换前不要启用 Scanner。真实研究者试用、
完整 cutout、服务可用率、全部 Grafana 面板与正式 v1.0 仍未验收。

### 2026-11-04 Dev Agent r14 启动状态

Helm revision **136** 使用镜像 `0.0.1-dev-20261104-agent-r14`，镜像 digest
`sha256:3569cf6c0fe1cbf95affa97dd83cff6c8174bd40f9f2eced305787cb9b02a472`。
Pod `asa-workspace-787f98bdc4-vgv7s` Ready、零重启，Service endpoint 已更新，
Pod 内 `GET /healthz` 返回 HTTP 200。容器在 07:30:42 启动，应用日志于 07:31:41
记录开始监听，约 59 秒；启动探针在初始化期间出现 connection refused，随后恢复，
没有触发容器重启。该时间与 startup probe 允许的启动窗口相符。

本次只读核对没有触发 Agent 对话、Workflow 写操作或人工筛选。它只证明 r14
进程已启动且健康，不验证 Agent CLI 的线上工具调用、真实 Euclid/DESI 服务、生产
FITS cutout、服务可用率、完整面板、真实研究者试用或 v1.0 发布。r14 后续只读
Agent/CLI 与 MCP 验收记录见下一节；完整科学流程和人审后的 cutout/export 仍未验收。

### 2026-11-04 Dev r14 Agent/CLI 与 MCP 只读验收

通过 Agent 会话 `wag_bbd894c0-dc65-46af-944f-1c8741970c69` 请求列出可用
Workflow。Agent 调用 Workspace CLI 并返回 `euclid-desi-crossmatch@1`；Tempo trace
`93ae2deb06f2c850e74914e4f7cfb22c` 包含 `chat.turn`、模型请求、
`execute_tool list_workflows` 和 `subprocess workspace-cli`。

同一 Dev revision 的 Workspace `/mcp` 列出预期五个工具。使用已登记的 Euclid 与
DESI S3 FITS 星表，在 `radiusArcsec=250` 下分别读到 214 行和 500 行；两次只读查询
合计约 16.47 秒。该耗时只描述已登记 S3 资产的查询 smoke，不是完整匹配候选池的
性能样本，也不代表实时 Euclid/DESI 目录 MCP 或图像 cutout 已验收。

外联 Workspace MCP Server 仍为 0。默认目录 MCP 可以列工具，但 `list_catalogs` 因
Elasticsearch `10.103.243.201:9200` connection refused 失败；集群内通用 Astroquery
工具清单仍没有已确认的 Euclid Q1 或 DESI DR10 专用查询契约。交叉匹配 run
`wfr_20261103193329_f932665a` 仍等待研究者筛选；没有代替研究者提交决策，因此
cutout/export 未运行。Scanner 继续保持关闭，直到 SQLite 元数据和 RWO 状态卷迁移完成。

本轮只读复核当前 `default` Kubernetes context：集群没有指向 `10.103.243.201` 的
Service/Endpoint。可用的 Workspace 与 Warehouse Elasticsearch 服务分别位于
`asa-workspace`、`atlas-warehouse` namespace，索引名为 `astro_*` 与 `ast_*`；现有证据
没有证明其中包含 Euclid Q1 MER 或 DESI DR10 Tractor 的目标目录及字段契约。因此不将
目录 MCP 静默改指向任一现有集群 Elasticsearch。

本次证据补齐 Agent → CLI 的 r14 只读调用和 Workspace `/mcp` 对登记星表的查询，
不改变完整科学流程、性能指标、MCP 可用率、研究者试用、Grafana 面板或 v1.0
发布的验收状态。

只读查看 r14 的 Tempo trace 和 Collector `8889/metrics` 预采样输出：Tempo 中该
trace 共 10 个 span，`chat.turn` 为无 parent 的根；两个 `chat gpt-6-luna` span
分别带 input/output usage（1312/15 和 2849/45 token）。`gen_ai.input.messages`、
`gen_ai.output.messages`、`gen_ai.tool.call.arguments`、`gen_ai.tool.call.result` 均未
出现。Collector 中 `asa_chat_turns_total=1`、LLM 调用 count=2，token sum 为 input
4161、output 60；当前线上镜像的指标模型标签仍是 `other`。工作树已把
`gpt-6-luna` 加入有限模型枚举，但本轮没有部署该本地修正。

Collector 的 servicegraph 只有 Workspace → `asa-llm-gateway` 两次调用，没有
Workspace → `astro-sdk-services`；`asa.workflow.key` 维度暂无记录，step 维度只有
`query_euclid` 与 `query_desi`。`asa_hitl_pending{asa_hitl_gate="human_filter"}=3` 是当前
等待闸门数，不是决策 span。此处检查的是 Collector 原始预采样指标，不是完整
Prometheus §9 PromQL 或 Grafana 八个面板验收；T1/T2、T4/T5、P4/P5 仍未通过完整验收。

本轮未部署工作树中的遥测修正：新增 `gpt-6-luna` 指标枚举、将 `waiting` 保留为
`asa.task.outcome` 的有界值，并让结构化日志继承当前 span 的 `asa.component`。
`test/telemetry.test.ts` 增加了 `waiting` 标签与日志组件继承断言。

本轮 `npm run build`、`npm test`、`npm run verify:chart` 和 staged/unstaged
`git diff --check` 均通过。全量测试 428 项中 424 通过、4 跳过、0 失败；Helm
lint/render 通过。Viewer 构建仍报告主 bundle 超过 500 kB。

Docker 默认网络构建在 `npm ci` 报 npm `Exit handler never called` 后失败；使用
Podman host network 和 `NPM_REGISTRY=https://registry.npmmirror.com` 重试成功，构建
本地镜像 `asa-workspace:plan-20261104`（image ID
`cef41816f237c045a5c20b0855401a7fc311f2e8a366cfbf619f0387d929f8ec`）。容器
`/healthz` 返回 200，镜像内 CLI 成功读取 `euclid-desi-crossmatch@1`。临时容器已停止
并清理；镜像未推送或部署，Dev 仍为 r14。

目录后端现场核对也确认：当前集群没有指向 `10.103.243.201` 的 Service/Endpoint。
Workspace 与 Warehouse 的 Elasticsearch 索引尚无证据满足 Euclid Q1 MER / DESI DR10
查询契约，不能直接替换默认 MCP 的目标地址。

### 2026-11-04 PostgreSQL 元数据迁移准备

新增 `scripts/migrate_metadata_sqlite_to_postgres.ts` 和
`docs/workspace-metadata-migration.md`。迁移脚本默认只预览；`--prepare-target`
只初始化 PostgreSQL schema，`--apply` 才会向空 schema 复制。修正了迁移事务持有
唯一 `PoolClient` 时又从连接池请求连接造成的等待：复制、表计数和导入标记均复用
同一事务 client。迁移源要求 SQLite schema v4、`quick_check=ok`，并且没有 WAL sidecar；
复制后按表校验行数并写入来源 hash 标记。

当前只完成工具与操作 runbook，没有运行 `--prepare-target` / `--apply`，没有连接或写入
Dev PostgreSQL，也没有部署或切换元数据后端。SQLite 仍是当前状态；Scanner 保持关闭，
直到迁移实际完成且状态卷具备 RWX。静态 TypeScript 检查与 `git diff --check` 通过；
本轮未运行测试。

### 2026-11-04 本机迁移 smoke 与 live 可观测性复核

在本机临时目录解压 Ubuntu 仓库的 PostgreSQL 18.6 运行包并启动仅监听
`127.0.0.1` 的临时实例，没有安装系统包、使用容器镜像或连接 Dev 数据库。用
SQLite schema v4 fixture 为七张迁移表各写入一行；`--prepare-target` 成功，dry-run
返回 `targetEmpty=true`、`readyToApply=true`，首次 `--apply` 在约 1 秒内完成，七张表
的目标行数均为 1。`import_markers` 共两行（fixture marker 与迁移 marker）；再次
`--apply` 返回 `already-applied`。第一次 smoke 发现 apply JSON 的 `targetCounts` 仍显示
复制前的零行数；现已让 `copyAll()` 返回事务内已校验的目标计数，并重跑验证 apply JSON
正确显示每表一行。`npm run verify:types` 与 `git diff --check` 通过。临时服务停止，数据
目录和解压运行时均已清理。这证明本机 schema 初始化、单连接事务复制、计数校验及 marker
路径可运行，不代表真实 Dev SQLite 数据已迁移。

当前 live Helm/Pod 仍使用 `ASTRO_METADATA_STORE=sqlite`，`scanner.enabled=false`；
`asa-workspace-state` PVC 为 `ReadWriteOnce`。本地 Helm 默认值也保持 SQLite、Scanner
关闭和 RWO。没有启用 Scanner、切换元数据后端、升级 Helm 或发布镜像。已有本地候选
`asa-workspace:plan-20261104` 的健康与 CLI smoke 证据仍见前节，候选未推送或部署。

按 `.tmp/WORKSPACE_REQUIREMENTS.md` §9 查询当前最近 24 小时 Tempo 数据：T1/T2 为 0，
T3 返回 7 条含有 chat/usage 的 trace，T4 返回 4 条，其中一条来自
`asa-workspace-selftest`；T5/T6 为 0，N1/N2 均为 0。工作流 TraceQL 有命中不等于完整
工作流验收；仍缺真实 astro-sdk 调用链、HITL 决策 span 和独立 Scanner trace。

通过 Collector 的只读 `8889/metrics` 端口复核预采样指标：`asa_chat_turns_total=1`，
LLM 调用 count=2，input/output token sum 为 4161/60，但 `gen_ai_request_model` 仍为
`other`。spanmetrics 没有 `asa_workflow_key` 序列，step 维度只有 `query_desi` 和
`query_euclid`（各 count=1）。servicegraph 没有预期的
`client="asa-workspace", server="astro-sdk-services"` 序列；当前主要出现
`server="unknown"`，另有 `client="user"` 到 `astro-sdk-services` 的序列。Collector
原始指标不能替代 PromQL 验收。

当前 observability namespace 只有 Tempo 和 Collector Service；`grafana-mini` Deployment
为 0/0，Prometheus Service/Ingress 不存在，已配置的 Grafana datasource 只有 Tempo。
Collector 配置的 Pushgateway 地址从本机 GET 返回 HTTP 502。因此本轮无法重查 P1/P2、
B1/B2、PromQL P4-P6 或 Grafana 的 8 个 Agent & LLM panel，旧 handoff 中的 Prometheus
数字不作为本轮结果。一次经 pusher 容器读取 Pushgateway 的请求与其 OOM 时间接近：
pusher 于 01:24:20 以 `OOMKilled`/137 退出，内存限制为 32 MiB，01:24:26 自动重启，且
01:24:33 与 01:34:27 的日志显示推送已恢复。该请求可能促成内存超限，因果尚不能确定；
Collector 主容器重启数仍为 0。后续读取 metrics 应经 Collector/Grafana 查询入口，不要
从低内存 pusher 容器抓取完整 Pushgateway 指标集。

`astro-all` Deployment 的 `API_TOKEN` 环境变量引用 Secret `astro-api-token` 的 `token`
键；只核对了引用，没有读取凭据。未认证请求 `/astroquery/mcp` 返回 401，`/all/mcp` 与
`/euclid/mcp` 返回 404，因此实际 MCP 工具清单仍未验收，也没有为 Workspace 配置外联
MCP Server。交叉匹配 run `wfr_20261103193329_f932665a` 仍等待研究者筛选；没有代替研究者
提交决策，cutout/export 仍未执行。外联目录、完整 PromQL/Grafana、Bridge 契约与 PoC、
真实研究者试用、服务可用率、Scanner 的 PostgreSQL/RWX 前置条件和正式 v1.0 仍待完成。

### 2026-11-04 S3 cutout 来源覆盖只读核验

当前 Dev 仍运行 revision 136、镜像 `0.0.1-dev-20261104-agent-r14`。通过容器内 Workspace
CLI 只读列出 Connector 元数据：Euclid 图像 S3 Connector `connector-1f8faeed-6d2a-400e-9487-d0b3b95bd6f0`
为 `ready`，其配置前缀覆盖 `projects/CSST/shared-data/euclid/`；CSST shared-data S3
Connector `connector-287154e5-1c48-4424-8371-e2732faa01ae` 为 `ready`，覆盖
`projects/CSST/shared-data/`。未读取或输出任何凭据。

用两个 Connector 的对象列表端点按目标前缀只读检查：Euclid tile `102018211` 的
`.../102018211/VIS/` 下有一份符合 `EUC_MER_BGSUB-MOSAIC-VIS_TILE102018211-*.fits`
规则的图像；DESI brick `0583m512` 的 `.../058/0583m512/` 下存在
`legacysurvey-0583m512-image-{g,r,i,z}.fits.fz`。因此现有 Workflow 的 Euclid 单对象
通配符解析和 DESI 精确 S3 key 均有已登记 Connector 与实际对象作为来源；这只是来源
授权和对象存在性证据，不是 FITS range 读取、cutout 产物或科学质量验收。

随后只读查询 run `wfr_20261103193329_f932665a`：状态仍为 `waiting_for_input`，等待原因
为 `human_filter`；`parse_input`、两侧查询、规范化和交叉匹配均成功，46 行 CSV/JSON
候选产物已登记；`cutout` 与 `export` 仍为 `pending`。没有执行任何写操作或提交筛选。
下一步仍需研究者查看完整 `crossmatch.csv` 并提交 Workspace 决策；提交后才能验证
本次确认的 S3 来源是否能完整产出 FITS artifacts 和 lineage。

### 2026-11-04 Agent 通过 CLI 读取文本产物

Agent 工具集新增只读 `read_workflow_artifact`：先经 Workspace CLI 查询 run，确认产物
已登记，再调用 CLI `workflows artifact-read` 读取 `text/*` 或 JSON 内容。默认最多返回
32 KiB，可由调用者提高到 128 KiB；CLI 流式读取并在达到字节上限后取消响应。FITS 等
二进制只返回产物元数据和下载提示，不读入模型上下文。CLI 对 run ID、artifact name
进行路径编码；Agent 只允许读取该 run 返回的已登记 artifact。没有增加直连 Workflow
Store 或 MCP 的旁路。

新增回归覆盖 CLI 完整/截断文本读取和二进制拒绝，以及 Agent 通过 CLI 读取已登记 CSV。
当前源码执行 `npm run verify` 通过：430 项中 426 通过、4 跳过；类型检查、服务端、
Viewer、CLI 构建和 Helm lint/render 通过。Vite 仍报告主 bundle 超过 500 kB。
此变更尚未构建为新镜像或部署；Dev 仍为 r14、revision 136。线上 run
`wfr_20261103193329_f932665a` 的人审筛选状态没有变化。

### 2026-11-04 Dev Agent r15 发布与只读验收

以 Helm release 当前 values 升级 Workspace 至 revision **137**，镜像
`0.0.1-dev-20261104-agent-r15`，运行 digest
`sha256:388cc6bf3a6258ce92ff51def83b0d70fbf983b868772439c9babec6bc51884d`。
Search 初始化 hook 成功；Workspace Pod Ready、零重启，容器内 `/healthz`
返回 200。发布前确认 coverage download 的 4 个历史任务均已完成且没有活动任务。
Downloader 保持原镜像 `0.10.38-dev-20261012-connector-link-r4`、原 Pod
`asa-workspace-downloader-9856d9555-5whxk` 和零重启。没有启用 Scanner、切换
SQLite 元数据或修改扫描任务。

在 r15 Pod 内调用打包的 Workspace CLI：`workflows list` 返回
`euclid-desi-crossmatch@1`；`workflows run-get` 查询到 run
`wfr_20261103193329_f932665a`；`workflows artifact-read ... crossmatch.csv`
返回 HTTP 200、`text/csv`、7,311 字节、未截断，共 46 条数据行。

另创建 Agent 只读验收会话
`wag_fe65464b-59e3-4e90-b412-3678edd94a03`。事件记录确认 Agent 经 Workspace
CLI 调用了 `get_workflow_run` 和 `read_workflow_artifact`，随后报告 46 条记录、
17 个字段，以及 `waiting_for_input` / `human_filter`。Agent 没有调用科学任务写工具，
也没有替研究者接受或拒绝候选。
run 仍等待研究者筛选，`cutout` 和 `export` 仍未执行；CSV 可读不等于候选已验收，
S3 FITS Range 读取及产物血缘仍待研究者提交决策后验证。

发布后单次资源采样为约 339m CPU、1,522 MiB / 2 GiB 内存；之前记录过一次
liveness 相关 137 重启，后续应继续观察内存和启动稳定性。上述上线验证不代表
外部 Euclid/DESI 目录服务、FITS MCP、用户试用、Prometheus/Grafana 面板、可用率
或 v1.0 发布已验收。

### 2026-11-04 Workspace Agent 共用 Workflow 与 r16 发布

本轮按 Workspace 为权威来源完成 Agent 与数据生产 Workflow 的连接。数据生产 Tab
默认进入星表 Workflow，其他既有生产流水线仍可切换；底部 Agent 经 Workspace CLI
创建、查询与恢复 Workflow run，不维护第二份科学任务状态机。两种入口执行同一
`euclid-desi-crossmatch@1` 定义和步骤，包括目录查询、规范化、球面交叉匹配、人工筛选、
可选 FITS cutout、导出和产物血缘。Agent 会先查询活动 run，并对照规范化输入复用同一
待处理任务，避免重复创建。Agent 提示和工具权限都要求由研究者作出筛选决定。

Workflow 面板新增执行历史，等待人工处理的 run 优先显示；研究者可打开完整 run 并继续
人工筛选。历史刷新会发现 Agent 新建的 run。新增 `GET /api/workflow-runs` 安全摘要列表，
并由 CLI `workflows runs --limit N` 调用。Workflow 状态、artifact 登记和恢复仍由 Workspace
负责；`astro-code` 仅用于参考 tile/source 路径解析、分组 cutout 调用约定和专业领域知识，
没有迁移其独立 run 文件存储或任务状态机。

监控埋点覆盖 Agent 对话和模型调用、CLI/工具、Workflow/step、MCP CLIENT、HITL 决策与恢复、
扫描和下载进程；人工等待时结束活动 span，并在恢复时继续传递 trace context。代码已提供
实际执行点，不代表线上监控验收完成。`.tmp/WORKSPACE_REQUIREMENTS.md` 要求的 TraceQL、
PromQL、servicegraph 和 Grafana panel 仍需在可用的 Collector/Prometheus/Grafana 环境保存
查询结果。

实现回归：`npm run verify:types`、`npm run build`、`npm run verify:chart` 通过；`npm test`
共 432 项，428 passed、4 skipped；`npx playwright test test/e2e/workflow-panel.spec.ts`
通过；`git diff --check` 通过。Vite 仍报告主 bundle 超过 500 kB。

发布到 Dev：候选镜像 `asa-workspace:0.0.1-dev-20261104-agent-r16` 已推送到当前镜像仓库，
沿用 release values 执行 Helm upgrade，`asa` 从 revision 137 升至 **138**。新镜像
`crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/asa-workspace:0.0.1-dev-20261104-agent-r16`
的运行 digest 为
`sha256:79393af82c9d47647f8aeae07002794d4aa618ddba577be4a23e56707cbef1c6`。Workspace Pod
`asa-workspace-5bb44d544-vpwzx` Ready、零重启，Pod 内 `/healthz` 为 HTTP 200；Search
初始化 Job 成功。Downloader 保持镜像 `0.10.38-dev-20261012-connector-link-r4`、原 Pod
和零重启。发布后观测到两个 Scanner Job active，Job 与持久化队列继续运行；没有启用
Scanner Deployment、切换 SQLite 元数据或提交新的扫描。

部署后直接在 Pod 内运行打包 CLI：`workflows runs --limit 100` 返回 3 个 run，其中
`wfr_20261103193329_f932665a` 仍为 `waiting_for_input`；完整 run 显示
`human_filter=waiting_for_input`、`cutout=pending`、`export=pending`。没有提交人工决定。
该 run 有 46 条候选数据行；此前 r15 已通过 CLI 读取已登记的 `crossmatch.csv`。API/CLI
历史与运行恢复入口通过线上只读验收。

本轮仍不能据此声称完成全部绩效验收：未完成研究者的筛选决定，因此本 run 尚未验证真实
远程 S3 FITS Range cutout、裁切产物与完整 lineage；真实 Euclid/DESI 外部目录 MCP 服务和
实际 FITS MCP health/工具调用仍未验收；`radiusArcsec=250` 的代表性候选池五分钟指标、
服务可用率统计、至少两位真实研究者的试用反馈、完整 OTel 面板和正式 v1.0 发布均需单独
记录运行证据。不要代替研究者提交该 run 的人工筛选决定。

### 2026-11-04 Workspace CLI Workflow 写入边界

Agent 的通用 `workspace_api` 现在拒绝直接修改 `/api/workflow-runs` 下的状态，避免
绕过 `create_workflow_run` 的活动 run 去重检查；`POST /decisions` 也会被拒绝，即使
用户确认了该通用 API 调用。研究者仍通过 Workflow 的专用人工决策入口提交筛选。
专用 `create_workflow_run` 仅在检查并复用相同输入的活动 run 后，才可创建新 run。
CLI API 路径会先解析 URL 和百分号编码，再应用上述约束。

Agent 回归覆盖了通用 API 创建 run 和提交人工决定的拒绝路径、无活动 run 时经专用工具
创建，以及相同待处理输入的复用。`npx tsx --test test/ai-provider-client.test.ts` 的
9 项测试通过，`npm run verify:types` 和针对改动文件的 `git diff --check` 通过。
此次改动尚未构建或部署；Dev 仍为 Helm revision 138 / image
`0.0.1-dev-20261104-agent-r16`。线上 run `wfr_20261103193329_f932665a` 仍等待
研究者筛选，本次没有调用线上写接口或修改其状态。

### 2026-11-04 当前验收快照

只读复核 Dev 后，Workspace 仍运行 Helm revision **138** / r16，Pod Ready、零重启；
Workspace state PVC 是 `ReadWriteOnce`，production-data 与 evidence PVC 是 `ReadWriteMany`。
当前只有 Workspace 和 Downloader Deployment，没有独立 Workspace Scanner Deployment。
集群 `observability` namespace 暴露 OTEL Collector 与 Tempo；本次集群 Service 查询没有找到
Prometheus、Grafana 或 Pushgateway，因此不能从这里完成 PromQL 和 Grafana panel 验收。
Workspace 系统配置中已登记的外联 MCP Server 数为 **0**。

CLI 只读检查发现 3 个 `euclid-desi-crossmatch@1` run 均等待 `human_filter`，各有 46 个候选，
`cutout` 和 `export` 都是 pending：

| Run | 创建时间 UTC | Cutout | 输入关系 | 创建到人工筛选等待 |
| --- | --- | --- | --- | ---: |
| `wfr_20261103193329_f932665a` | 19:33:29 | enabled | 与下一项输入相同 | 31.2 s |
| `wfr_20261103192550_84e0cabc` | 19:25:50 | enabled | 与上一项输入相同 | 36.4 s |
| `wfr_20261103191656_dbf83928` | 19:16:56 | disabled | 仅 cutout 设置不同 | 48.3 s |

三者使用同一 RA/Dec、250 角秒检索半径、1.5 角秒匹配半径及同一对已登记 FITS catalog
资产。时间来自 Workflow 创建时间和 `human_filter.startedAt`；因此它证明该输入组合的三次
候选池均在五分钟内生成，但属于同一坐标和数据源，不能代替其他场景的代表性性能样本。
没有查看后替研究者提交筛选、删除 run 或触发 cutout。

从当前 Tempo 对最近 24 小时执行 WORKSPACE_REQUIREMENTS v0.3 的 TraceQL 检查：T3 LLM usage
命中 8 条，T4 Workflow/step 命中 4 条；N2 内容采集查询为 0 条。T1 完整 Workspace→
astro-sdk trace、T2 MCP CLIENT/服务端父子链、T5 HITL 决策 span、T6 独立 Scanner trace 均为
0 条命中。当前没有 Prometheus/Grafana Service，故 P1–P6、B1–B2 和 8 个面板仍未验收。

本次无线上写操作。Workspace CLI Workflow 写入边界改动仍只在本地源码，尚未进入 r16/r17
镜像。下一步应先由研究者检查这 3 个待处理 run 并只提交一次预期决策，再验收 S3 FITS
cutout/export；其余依赖仍包括可确认的外部 Euclid/DESI 与 FITS MCP、Prometheus/Grafana
运行环境，以及停机维护窗口内的 SQLite→PostgreSQL 与 state PVC RWX 迁移。

### 2026-11-04 官方目录 TAP fallback

Workspace 目录查询默认路由新增官方 TAP fallback：已配置的专用 Workspace MCP 和 `es_query`
优先；失败后走可配置的默认 MCP 客户端，之后才走官方档案。官方 endpoint 可由
`ASTRO_EUCLID_TAP_URL`、`ASTRO_DESI_TAP_URL` 覆盖，超时由
`ASTRO_CATALOG_ARCHIVE_TIMEOUT_MS` 控制。DESI 采用 NOIRLab Data Lab `ls_dr10.tractor`，
Euclid 采用 ESA `catalogue.mer_catalogue`，没有以本地 Elasticsearch 索引替代官方目录。

结果继续进入现有 Workflow。Euclid 的有符号 `object_id` 保留字符串格式，
`segmentation_map_id` 依官方规则换算成 `TILE_INDEX`；DESI 使用 `ls_id`，并把 `release`、
`brickid`、`brickname`、`objid` 带入候选 CSV 和预览，以 `flux_r` 计算 AB magnitude。
最多查询 1,000 个结果，另请求一行检测截断；provider、
release、table、limit 和截断状态进入运行摘要与 lineage。附加列投影限制为最多 16 个且
必须是简单字段标识符。专用 MCP 工具失败后也会退回同一默认路径。人工筛选和 cutout
工作流边界没有改变。

只读外部验证：ESA TAP 对 `58.375, -51.25`、250 角秒 POST 查询返回两行，HTTP 200，约
1.55 秒；包括负 `object_id` 与 `segmentation_map_id`。NOIRLab schema 请求可读；直连
`/tap/sync` 小查询 18 秒无响应，经已授权代理使用 RA/Dec 外接矩形和
`brick_primary = 1` 查询返回 3 行，HTTP 200、`text/csv`、约 4.46 秒，包含 `ls_id`、
`release`、`brickid`、`brickname`、`objid`。标准 `POINT/CIRCLE` 在该 TAP 实例报函数不支持，
故 Workspace 使用外接矩形取候选，再以已有球面距离逻辑做精确圆内过滤；REST Query Manager
仍需安全 token。此证据不等于 Workspace 服务部署、直连网络、生产 S3 cutout 或完整流程验收。

本轮本地 `npm run verify:types` 和 `npm run build` 通过，`git diff --check` 通过；Viewer
构建仍提示主 bundle 超过 500 kB。未运行测试、改动 Dev 或处理三条等待中的
`human_filter` run。已配置的 MCP 源、运行中的服务可用率和用户试用依赖仍未完成。

### 2026-11-04 Pod 出站网络复核

当前 Kubernetes context `default` 指向本地 k3s；Dev 实际 namespace 是
`asa-workspace`，不是 `asa`。Workspace 仍为 Helm revision **138** / r16，Pod
`asa-workspace-5bb44d544-vpwzx` Ready、零重启。两项 Scanner Job 正在运行：
`workspace-coverage-user-b792b28e-aa41-47a8-aed4-scan-4974102b38` 与
`workspace-coverage-user-b792b28e-aa41-47a8-aed4-scan-eab3c0b190`。不要在发布前假设 namespace
为空或扫描队列已停止。

Node v22.22.1 支持 `NODE_USE_ENV_PROXY=1` / `--use-env-proxy`，但当前 Workspace Pod
没有 proxy 环境变量；Pod 到环境代理 `10.15.49.212:7890` 的 TCP 连接成功。临时启用
Node 环境代理后，ESA TAP 小范围查询返回 HTTP 200、3 行，约 7.3 秒；NOIRLab
`/query/schema` 返回 HTTP 200，约 3.2 秒。通过相同代理对 NOIRLab `/tap/sync` 执行
小范围目录查询（GET 与 POST）分别等待 20 秒、20 秒后超时；Pod 内相同 TAP 行查询等待
60 秒仍无响应，`TAP_SCHEMA.tables` 查询 15 秒也无响应。由此不能确认当前集群路径可用
NOIRLab TAP 行服务。代理地址不得写死进业务代码；即使后续选择 Helm 环境变量配置，仍需先
复验 TAP 响应和 Workspace 运行时查询。

Workspace CLI 再次只读列出三个 `euclid-desi-crossmatch@1` run：
`wfr_20261103193329_f932665a`、`wfr_20261103192550_84e0cabc`、
`wfr_20261103191656_dbf83928`，均仍为 `waiting_for_input`。没有提交人工筛选、触发
cutout/export 或修改集群。官方 TAP fallback 仍只在本地工作树；没有发布 r17。若继续，先
恢复/验证 NOIRLab TAP 出站查询，再决定是否发布；真实筛选、S3 FITS cutout 与 lineage 仍需
研究者在 Workflow 中提交决策后验收。

### 2026-11-04 MCP HTTP trace parent 回归修复

针对 T2 的本地修复已加入 `src/system-config.ts`：MCP transport 自定义 fetch 在
`tools/call {tool}` CLIENT span 活动时显式注入当前 W3C trace context，再用
`suppressTracing` 发出 HTTP 请求，防止 Undici 额外创建一层 HTTP CLIENT span。MCP
`params._meta.traceparent` 继续由同一个 `tools/call` span 生成。这样远端 HTTP SERVER
span 可直接以 Workspace `tools/call` 为父，满足 servicegraph 与 T2 的父子关系。

新增 `test/system-config-mcp-tracing.test.ts`，验证 `chat.turn → tools/call` 的本地层级、
请求 HTTP `traceparent` 与 `_meta.traceparent` 均精确指向该 CLIENT span，且没有额外的
Undici POST/GET CLIENT span。该本地 fixture 不启用真实远端 HTTP SERVER 自动埋点，因此它
验证传播头和调用端 span 形状，不替代 Dev Tempo 的 T2 实际查询。

验证结果：`npm run verify:types` 通过；`npm test` 通过，436 passed、4 skipped、0 failed。
修复仍在本地工作树，未构建、推送或部署。此前 Pod 侧 NOIRLab TAP 行查询仍超时，当前
工作树还包含未发布的官方 TAP fallback；发布前应先解决或复验该运行时路径，再在 Dev
配置可用的外部 MCP 后检查 T1/T2。人工筛选、S3 FITS cutout/export、独立 Scanner 和
Prometheus/Grafana 验收状态不变。

### 2026-11-04 Dev Agent r17 运行核验

Helm release `asa` 已升至 revision **139**，镜像为
`0.0.1-dev-20261104-agent-r17`，本地 manifest digest 为
`sha256:782095a75b9793aa6def515e60d125e7e576e4d69338527d79d5a5db964880c1`。
Pod `asa-workspace-7488f57d6c-djqtl` 的 container imageID 为
`sha256:c13bfceb151ceefd4244c5fff2a717f0dfd09866288fd629de546773e0e6f831`。
本次核对时 Pod 已运行约 25 分钟，Ready、零重启；Pod 内 Workspace `/healthz` 与
Elasticsearch cluster health 当前均返回 HTTP 200。上一轮 12 次探针采样也均返回 200，
但 Kubernetes Events 仍记录启动期连接拒绝/超时、readiness 失败以及本次检查约 10 分钟前的
readiness 失败汇总，不能据此认定探针已长期稳定。相邻两次 `kubectl top` 读数从 816m CPU、
1566 MiB 变为 660m CPU、1560 MiB；容器 limit 为 1 CPU / 2 GiB，这些短时读数不能代表
资源趋势，仍需继续观察。

Helm 默认关闭的 `networkProxy` 已用于 Dev，为 Node 配置环境代理和内部服务 bypass；
代理地址只存在于 Helm 运行配置，没有进入业务代码。Pod 内小范围 ESA TAP 和 NOIRLab
TAP 查询分别返回 2 行，耗时约 3.3 秒和 3.0 秒。Workspace `/mcp` 的
`euclid_catalog_query`、`desi_catalog_query` 在同一坐标、250 角秒、limit=10 下各返回
10 行，均标记 `truncated=true`，耗时约 24.6 秒和 27.4 秒；这些调用没有创建 Workflow
run 或产物，也不是完整候选池性能样本。

Astroquery MCP 的只读调用成功。Tempo trace
`e88497443f6f9b89bee5e4d21db72f38` 中，Workspace `tools/call
astroquery_mpc_get_observatory_location` 直接作为远端 `POST /astroquery/mcp` SERVER span
的父；MCP CLIENT span 没有额外 Undici HTTP span，TraceQL T2 命中 1 条。该调用由直接
Workspace MCP 请求发起，不是 Agent `chat.turn`，所以不能据此验收 T1。

系统 Provider 测试接口返回 `lastCheck=ok`。Collector `/metrics` 随后出现 Workspace 的
`asa_gen_ai_client_token_usage_sum` 两条序列和
`asa_gen_ai_client_operation_duration_seconds_count` 一条序列；本次 Provider 检查没有
生成 Agent 会话或 `chat.turn`，因此没有 `asa_chat_turns_total` 序列。最近 24 小时
TraceQL 快照为：T1=0、T2=1、T3=8、T4=3、T5=0、T6=0，N1=0、N2=0。集群当前没有
Prometheus、Grafana 或 Pushgateway Service，因此 PromQL、序列预算及八个面板仍未验收。

为取得真实 Agent → Astroquery trace，本次通过已部署 Workspace CLI 新建会话
`wag_6a812eb7-8e19-4aa9-b6a3-6705fbd81c24`，请求一次 `code="500"` 的
`astroquery_mpc_get_observatory_location`。该 MCP Server 将工具标记为 `readOnly=false`，
所以 Agent 正按既有策略等待 `call_mcp_tool` 的人工确认；目前没有调用远端工具，也没有
替用户确认。研究者/用户在 Agent 面板确认后，才能继续检查 T1/T5；此会话与那 3 个等待
`human_filter` 的 Workflow run 相互独立。

#### r17 Agent 与指标补充核对

上述待确认 Agent 会话已生成 `chat.turn` 和模型调用。Collector 当前可见
`asa_chat_turns_total{asa_chat_outcome="ok"}=1`、LLM operation duration count=2、
input/output token sum=6264/49，以及 `asa_hitl_pending{asa_hitl_gate="confirm_tool"}=1`
和 `asa_hitl_pending{asa_hitl_gate="human_filter"}=3`。这证明 Agent 对话和待处理闸门
指标进入 OTLP Collector；MCP 工具仍未执行，因此不证明 T1。

从 Collector `:8889/metrics` 按 Pushgateway `pusher.py` 的白名单、标签剔除和去重规则
统计，当前共有 **3803 条指标样本**，其中 `asa-workspace` **295 条**、`astro-all` 863 条、
`otelcol` 28 条、其余 2617 条没有 `asa_service`。Workspace 子预算 `<400` 目前满足；
全局预算 `≤3000` 不满足。Pushgateway 最近一次成功记录为 862498 bytes；其 `series=3995`
实际是 `data.count(b"\n")` 的行数，包含 192 行 HELP/TYPE 注释，不能直接当样本数。

去掉 Pusher 指定的高基数标签后，Workspace spanmetrics 仍带有重复的
`service_name="asa-workspace"` 标签；它不在 v0.3 §5.2 白名单内，且与 `asa_service` 重复。
当前 Collector ConfigMap 不在 Workspace 或已检查的相邻仓库中找到受版本控制的源文件；
不应只在线上改 ConfigMap 而不建立其配置源。`grafana-mini` 当前 replicas=0，配置中只有
Tempo datasource；本集群没有 Prometheus Service。因此 Collector/Pushgateway 收到指标，
仍不能替代 PromQL、B1/B2 或八个 Grafana 面板验收。需先由 observability 配置 owner
修复全局序列预算与 `service_name` 标签，再提供可查询的 Prometheus/Grafana 数据源。
