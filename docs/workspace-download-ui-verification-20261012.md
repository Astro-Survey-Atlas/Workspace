# Workspace Dev：下载恢复与探索 UI 验收

验收日期：2026-10-12（Asia/Shanghai）。用户已授权完整计划、当前 k3s 独立
aria2 服务、共享下载存储、局域网代理配置和现有 Euclid 任务恢复。

## 实际结果

Euclid **5/5 文件下载完成**，共 **7,372,828,800 字节**。独立重新读取磁盘文件
计算 SHA-256，与 worker 校验记录一致；五个文件均具有有效 FITS primary header，
每个文件大小均为 1,474,565,760 字节。原来已完成的三个文件哈希保持不变。
没有提交另一份下载清单，也没有重新读取或枚举 CSST/HST 的源目录。

| 文件波段 | 恢复前 | 最终 SHA-256 |
| --- | --- | --- |
| CFIS-U | 保留 1,411,088,687-byte 断点 | `6856586bc0029312b37e1250a596fabc852199dedc207b39267c662a8b922a1f` |
| WISHES-Z | 已完成，直接复用 | `5fca9c648dac3ad70459b7c136e81d5e27af7b78723f208b76728ace9f3b37fb` |
| PANSTARRS-I | 保留 979,405,103-byte 断点 | `8f634e3de336af831696ea99a80c8c858ec08fc2c00865117f5ae08ddf3f0b4b` |
| CFIS-R | 已完成，直接复用 | `191e882d622c7ec50d142cc6a072cc12361ce2aca750067b52bff563fd2d7258` |
| WISHES-G | 已完成，直接复用 | `a64618c8e3b3ed88452db27479bda0c1934a71cc012de30a11dcce3d00199146` |

这里的 SHA-256 是本地完整文件摘要及重新读取的一致性检查；源清单没有提供的
上游摘要不会被声称已验证。

任务身份保持不变：

- 下载：`coverage-download-48e6840d-6541-4235-aeda-60793190635d`，`completed`。
- Request key：`production:prd_20261010060559_8d1cca8a`。
- Inventory SHA：`820bd646d773d9e5975668fb51a17579b5c632247d6dce2615619a292270c92e`。
- 输出：`/data/production/files/prd_20261010060559_8d1cca8a`。
- Connector：`connector-de8c51e0-f518-40d1-a8c6-ea688d9a3af9`。
- 新生产记录：`prd_20261012042740_a44da7e5`，`succeeded`，failedFiles=0；
  复用原来已批准的清单、审批时间及上述下载任务。

原失败下载 `coverage-download-03ba4df9-7b35-4888-b9d0-37cc1ddbbc80` 和原
ProductionRun `prd_20261010060559_8d1cca8a` 的 API 记录与恢复前精确比较不变。
机器验收记录：`/tmp/workspace-download-recovery-final.json`。

## 失败诊断与实现

旧任务的 `terminated` 表示传输流中断；旧执行器最多尝试四次，耗尽后停止。
恢复前实际数据已经达到 3/5 已校验，另外两份保留部分数据。代理链路的 TLS
不稳定与执行器重试/重启恢复能力不足均有证据，需要同时处理。

Dev 使用 HTTP 代理 `http://10.15.49.212:7890`，支持 HTTPS CONNECT，适合 aria2
原生支持的代理协议。k3s Pod 的 127.0.0.1 指向该 Pod；配置局域网地址后下载
服务可访问 Clash。认证信息单独持久化，不回显密码。

独立 aria2 1.37.0 负责传输；Node supervisor 提供内部认证 API、源站网关和
校验/调度。RPC 只监听 loopback；共享 PVC 保留 `.part`、`.aria2` 控制文件及
每十秒落盘的 session/state。默认同时传输两个文件，每个至多两条连接。
Workspace 负责提交、重连、展示、生产状态及 Connector 登记。

临时 DNS、源站 429/5xx、传输中断和过载持续自动重试，退避 15–300 秒。
持续进展会重置连续失败计数，总重试次数保留。源文件版本变化、非科学响应、
断点范围不匹配及认证等明确错误停止对应文件，保留诊断和已保存数据。
续传校验 Content-Range、预期大小、ETag/Last-Modified；无 validator 的旧部分
文件仅对已明确识别的不可变 Euclid Q1 EAS 文件允许续传。

独立服务最初的心跳访问默认 ESA 首页，在重定向路径超时，代理 TCP 本身可达。
相同下载 Pod 经实际文件 URL 实测：断点 64 KiB 返回正确 HTTP 206，约 2.67 秒；
文件首字节约 1.68 秒。修复为每轮配置同步都提供实际文件源，避免初始化同步
失败后永久停留在默认首页。配置 revision 不一致时页面显示等待同步，防止
回显旧检测结果。实际 heartbeat 约 1 ms 代理连接、1.55–1.63 s 源站响应。
服务端每 30 秒检测；测速读取至多 1 MiB，持续至多 20 秒。

仅 `eas.esac.esa.int` 经代理使用证书校验开启的 TLS 1.2；这是基于实测默认
握手不稳定的部署决定。其他 HTTPS 源继续使用默认 TLS 协商。

## 重启与 UI 验证

真实恢复过程中，暂停在 **7,293,442,560 字节** 后重启 downloader，暂停状态、
保存字节和文件身份一致。恢复后单独重启 Workspace，downloader Pod 保持
`c946f184-b20b-433d-aebe-acc62fad75d6`，继续传输和校验，生产监控自动重连。

Selected 的巡天标签只来自已选且可见的公开覆盖；Workspace 资产单独标注，
不会引入未勾选的第三种公开巡天。重合查询显示旋转状态，空结果和失败有明确
状态，退出后丢弃旧响应，返回列表后自动选中 C01。来源卡片使用 HEALPix
Inspector 的分组、边框和色条样式。

Aladin 使用主题红色网格、紧凑图层行和 Exploration Deck 内的抽屉把手。
点击数据点打开以 RA/Dec 为标题的坐标 Inspector，按所选来源查询附近星表
对象和覆盖影像，保留入口天区、实际视野和具体图层约束。匹配半径可调整。
真实 HST 页面验证两点可见、坐标查询和 HDU 影像结果，浏览器没有 page error。
真实重合页面验证 C01 已自动选中；查询清单准备期间仍显示进度状态。

截图及页面验收记录：`/tmp/workspace-live-download-ui/`，包括
`download-settings.png`、`hst-aladin.png`、`hst-inspector.png`、
`overlap-c01.png` 和 `receipt.json`。测试浏览器需显式绕过代理访问本地 Dev；
默认浏览器代理访问此局域网域名返回空 502，直接访问正常。

## 构建、回归与部署

- 类型检查、server/viewer/CLI 构建、严格 Helm lint、默认及启用下载服务的
  chart 渲染通过；容器 Node 语法检查通过。
- 早期全量单测：369 passed、2 skipped。之后针对最终改动验证 worker 4/4、
  download/production 28/28，全部通过。
- 真实 aria2 回归先观察临时 503 后无法完成，再修正并通过自动重试及最终哈希。
  同时验证 legacy partial、跨重启暂停/续传、Workspace 重连、禁止私有源 URL、
  代理认证隐藏/持久化和畸形设置输入。
- 浏览器：overlap 10/10、download settings 1/1、Aladin 3/3、Selected 1/1。
  Selected 初次失败来自 fixture 未 mock 的慢 operational status 请求；补齐
  mock 后聚焦回归通过。

Dev：`http://astro.workspace.dev.72602.space:32080`。
Helm release `asa`，namespace `asa-workspace`，revision **86**。
Workspace/downloader 镜像：`0.10.38-dev-20261012-download-worker-r2`。
Registry digest：
`sha256:44f5572027ebf4868d54c01a3a5c005d73854991106b4e90bb8b862644b455b1`。

部署保留原 values 和 Workspace/ES 配额。Workspace request 100m/128 MiB，
limit 1 CPU/1 GiB；downloader request 100m/128 MiB，limit 1 CPU/512 MiB。
单副本 Recreate 策略，生产共享 PVC `asa-workspace-production-data`。
两个 Pod 均 Ready，零容器重启。发布使用已验证旧 runtime、当前本地编译产物、
CA bundle 及校验过源码的 aria2 binary；完整源 Dockerfile 也已提供。

日志均在 `/tmp/workspace-download-*`；此记录、私有文件、回执和截图位于
Workspace，没有修改 Assets 公开数据或执行额外覆盖扫描。

## 下载设置与自动覆盖闭环补充（r3）

系统设置只提供已保存的 HTTP 代理地址、凭据掩码与代理可用性/延时波形；
曲线显示最近 24 次代理或直连链路检测。下载任务和历史记录不再放在系统设置中。

自动创建的下载 Connector 原先没有成功连接检查，也没有关联用户图像资产，
所以 Connector 自扫描分别被这两个前置条件拒绝。r3 已部署为 Helm revision
**87**，镜像 `0.10.38-dev-20261012-download-closure-r3`。后续生产下载会根据
已校验且带 image/imaging 身份的 FITS 文件自动登记来源范围的图像资产、关联
Connector、检查目录并提交 Warehouse 扫描；下载文件本身不会因此重复传输。

现场闭环使用既有 Euclid 文件完成，没有重新下载：Connector
`connector-de8c51e0-f518-40d1-a8c6-ea688d9a3af9` 检查成功；资产
`user-6316849e-5111-40b0-9bc0-449486883025` 关联到该 Connector，并记录来源目录
`sources/public-euclid-euclid-q1-euclid-20q1-20co-80100982`。扫描
`ingest-cef3169f-6a5a-4b85-aad7-60f3f89847e8` 最终 `succeeded`，发现并处理
5 个 FITS 文件，产生 525 条 O10 覆盖记录，错误数为 0；Workspace 覆盖状态
为 `ready`、MOC 状态为 `ready`。后续坐标索引处理完 5 个图像中心，状态为
`succeeded`。扫描及生产代码均未触碰现有 CSST/HST 覆盖源。

## Connector 可发现性与生产记录关联（r4）

Helm revision **88** 当前部署 Workspace 和 downloader 镜像
`0.10.38-dev-20261012-connector-link-r4`，两个 Pod Ready、零重启。Pod 拉取的
镜像 digest 为
`sha256:e8a7018ce840eef87da3a4f61b5d42be655c9afa531a0514c2ef01572930efdb`。

在 Workspace 的 `prd_20261012042740_a44da7e5` 执行详情中，下载结果区域显示
Connector 当前名称、输出路径和 Connector ID；按钮可直接打开 Connector 列表
中的该记录。按 Connector ID、关联资产名或来源路径搜索，均能在列表找到该记录。
Connector 编辑通过 Workspace 完成，当前名称为
`Euclid Q1 color imaging (Workspace)`，说明为：

> 对应生产记录 prd_20261012042740_a44da7e5 的 Euclid Q1 图像数据目录。关联 euclid/euclid-q1 资产；5 个 FITS 已完成 O10 覆盖扫描，0 错误，MOC ready。

其 ID 为 `connector-de8c51e0-f518-40d1-a8c6-ea688d9a3af9`，实际输出目录仍为
`/data/production/files/prd_20261010060559_8d1cca8a`。下载恢复复用了之前批准的
request/job 和存储目录，因此目录使用先前的 ProductionRun ID；新旧运行记录指向
同一个下载结果和 Connector。

Workspace “扫描记录”按扫描 ID
`ingest-cef3169f-6a5a-4b85-aad7-60f3f89847e8` 可找到后续扫描：成功、5 个 FITS、
525 条覆盖记录、0 错误、O10，MOC ready。关联资产为
`user-6316849e-5111-40b0-9bc0-449486883025`，其 5 个图像中心也已完成坐标索引。
扫描历史显示执行时保存的旧 Connector 名称 `Coverage download 60793190635d`；
这是同一 Connector 的历史快照。

生产详情中 Warehouse 扫描提交节点显示“已跳过”，这是该 ProductionRun 执行时
自动 handoff 尚未部署的准确历史状态。成功覆盖扫描是后来通过 Workspace 对既有
下载文件提交的单独扫描记录；没有重下文件。现场 UI 截图保存在 `/tmp/`：
`workspace-production-connector-r4-final.png`、`workspace-euclid-connector-final.png`、
`workspace-euclid-scan-history-final.png`。

## Connector 名称可在连接器列表识别（r5，2026-10-13）

用户指出，只有生产详情能关联 Connector ID 不够；下载产生的 Connector 必须用
可辨认的数据产品名直接出现在 Workspace「连接器」tab 中。Connector 创建逻辑现从
下载任务的公开来源 ID 解析产品、巡天与发布，并组合重合区块和输出目录后缀生成
列表名称。单一来源同时写入 `surveyId`、`releaseId`。例如本次 Euclid 下载：

`Euclid Q1 color imaging · euclid/euclid-q1 · C01 · 8d1cca8a`

该规则由本地下载和独立 aria2 下载共用。回归覆盖精确名称、巡天/发布标签和说明。
回归结果 16/16 通过；`npm run verify:types` 与 `npm run build:server` 通过。
完整容器源构建在 `npm ci` 因 `npm` `Exit handler never called!` 停止；发布使用
已验证 r4 runtime overlay 替换已编译的 `coverage-downloads.js`，容器内
`node --check` 通过。

Helm revision **89** 已部署 Workspace 镜像
`0.10.38-dev-20261013-product-connector-r5`，digest
`sha256:2f1fc081de089afba2ac8ed9b3926f4906ae33c43a53ec9f12d8c99eb6b3a1e1`。
Pod Ready、零重启。通过 Workspace Connector 编辑界面把既有 Euclid Connector 名称
更新为上面的自动命名格式；Connector ID、资产关联、成功扫描和下载目录均保留，
没有再次下载或扫描。现场 Workspace API 当前也返回该精确名称及 `euclid/euclid-q1`
标签，列表组件直接以 Connector `name` 字段渲染行标题。截图位于
`/tmp/workspace-euclid-autonamed-connector-r5.png`。

当前 Connector 为 `connector-de8c51e0-f518-40d1-a8c6-ea688d9a3af9`，目录仍为
`/data/production/files/prd_20261010060559_8d1cca8a`。它对应生产记录
`prd_20261012042740_a44da7e5`；此前 r4 手工设置的
`Euclid Q1 color imaging (Workspace)` 已由产品名替换。更早生成的其他下载
Connector 仍保留其历史名称，不影响这条 Euclid 下载结果的识别。
