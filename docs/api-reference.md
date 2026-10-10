# Workspace API Reference

> 本轮 Workspace 边界、任务 label、历史隔离和统一通知以
> [`atlas-boundary-plan.md`](atlas-boundary-plan.md) 为准。这里的接口只描述
> Workspace 自有 API，不是 Assets 或 Warehouse API。Workspace 服务端可能在
> 明确的重合/下载操作中调用受保护的 Assets scoped query；该调用不是浏览器
> API，也不会把 Assets 的原生索引文件复制到 Workspace。

这是 Astro Data Workspace API 的维护入口。接口实现、请求示例和状态语义发生变化时，必须在同一变更中更新本文和对应测试；`README.md` 只保留入口链接，不再复制完整请求体。

## 约定

- Workspace API 默认返回 JSON；异步任务提交返回 `202`，随后通过查询接口轮询。
- `POST /api/connectors/:id/check` 只检测 Connector 的端点、Bucket、Prefix 或数据库连接，不创建扫描任务。
- Connector 凭据只保存在 Workspace 的受管 Secret 中，不进入请求体、任务快照或公开响应。
- `surveyId`、`releaseId`、`product` 是 Atlas 用户资产的本地标签；`connectorId` 是访问位置。Atlas 不向 Assets 注册这些用户标签，也不把它们写回公共 catalog。
- 浏览器只调用 Workspace 管理 API。普通公开覆盖几何和 native MOC 由已同步、
  已校验的 Astro Survey Atlas Assets Resource Package v3 提供；公共包元数据与
  Atlas 本地 SurveyRegistry 分开读取。需要公开细粒度数据单元时，由 Workspace
  服务端按本次区域调用受保护的 Assets scoped query，浏览器不持有凭据。
- Workspace 自己维护一个独立 Elasticsearch（`ASTRO_ES_URL`），用于用户文件、对象、coverage 和 MOC 投影；Warehouse Elasticsearch（`ASTRO_WAREHOUSE_ES_URL`）只在启用远程执行时使用，二者不共享索引。
- Warehouse 的 `ast_*` 索引没有 caller 字段；Workspace 只接受能由本地用户资产、扫描记录或 MOC artifact 关联出的 layer ID。Assets 公共 layer 不会因为 Warehouse 可达而混入用户天球，公共覆盖仍来自已验证的 Resource Package v3。
- 用户 manifest、normalized scan、任务快照和证据只保存在 Workspace/Warehouse evidence PVC 或对象存储中，不能放入浏览器初始响应。

## Connector

### 检测连接

```http
POST /api/connectors/{connectorId}/check
```

用于验证当前配置和凭据。成功响应包含 `check.status=ok`；它不是扫描完成证据。

### Connector 全量自扫描

```http
POST /api/connectors/{connectorId}/scan-runs
Idempotency-Key: connector-scan-2026-08-20
Content-Type: application/json

{}
```

请求体必须为空对象或省略。该接口扫描 Connector 注册的完整 S3/OSS Prefix，
或受管生产数据卷内的本地目录，创建 namespaced
`atlas.zhejianglab.org/v1alpha1/ScanRequest`（`ScanPlan.version=2`），并返回
Workspace 扫描记录。Connector 必须关联一个已登记的用户资产，扫描参数使用该资产的
FITS 图像或 CSV 坐标配方。空请求不能额外指定子目录或 basename 过滤器。

本地扫描的 `plan.source.location` 仅包含 scanner 容器内的 `rootPath`；
PVC 的相对子路径放在 `scanner.sourceVolume.subPath`，并挂载到同一个
`scanner.sourceVolume.mountPath`。本地来源不创建 source 凭据。新下载生成的
Connector 需要先在「用户资产」登记并关联，才能提交扫描。

一个 Connector 如果关联多个 `origin=user` 资产，Workspace 会以
`ConnectorScanPreconditionError` 拒绝这次无 `assetId` 的自扫描，不会静默选择
其中一个资产。请改用下面的 `/api/data-assets/{assetId}/remote-scan`，明确指定
目标资产；或者先解除多余的资产关联后再重试。

返回的扫描记录包含 Connector、位置、任务状态和幂等键快照；它只描述扫描执行状态，不代表某个巡天产品已经产生可发布覆盖。

查询记录（只返回 Atlas 本地历史，并按 Atlas label/本地 taskKind 隔离；历史接口只读）：

```http
GET /api/connectors/{connectorId}/runs
GET /api/connectors/{connectorId}/ingest-runs
GET /api/connector-ingest-runs?connectorId={connectorId}
```

扫描提交产生的 `ConnectorIngestRun` 包含 `taskKind=user_scan`；用户资产覆盖
远程扫描产生 `taskKind=user_coverage`。客户端不能通过 `POST
/api/connectors/{connectorId}/ingest-runs` 直接写入历史，删除历史的请求也会返回
`405`；记录只能由 Atlas 自己的扫描提交流程创建。

### 本地 Connector 扫描

```http
POST /api/connectors/{connectorId}/local-scan
Content-Type: application/json

{"relativePath":"catalog.csv","maxRows":100000}
```

只适用于 `local` Connector，不与远程 S3/OSS 扫描回退混用。对
`POST /api/data-assets/{assetId}/local-scan`，当请求没有提供
`relativePath` 时，Workspace 使用该资产经过校验的 `sourceRelativePath`；
只有资产没有声明路径时才要求 Connector 根目录恰好包含一个顶层 CSV。请求
显式提供的路径优先，并经过同样的根目录和 CSV 安全校验。扫描过程会写入
Workspace 自有 Elasticsearch 和用户 MOC artifact；服务重启无法续接本地
扫描，未完成任务会在启动时明确标为 `failed`，不会暴露为 ready coverage。

### 用户资产远程扫描（可选插件）

```http
POST /api/data-assets/{assetId}/remote-scan
Idempotency-Key: user-asset-scan-v1
Content-Type: application/json

{
  "surveyId": "my-survey",
  "connectorId": "connector-fd599c33-b7c8-4bbd-9377-a7b87133f069",
  "assetId": "user-asset-123",
  "releaseId": "my-release",
  "product": "Source catalog",
  "path": "catalog/",
  "allowedSuffixes": [".csv"],
  "coverage": {
    "mode": "catalog-radec",
    "coordinateFrame": "ICRS",
    "coverageRole": "object_presence",
    "dataOrigin": "catalog",
    "sourceTier": "user_file_derived",
    "maxOrder": 10,
    "queryOrder": 8,
    "previewOrder": 4,
    "raColumn": "RA",
    "decColumn": "DEC"
  }
}
```

`path` and `allowedSuffixes` are the only file-selection fields representable
by Warehouse `ScanPlan` v2. The legacy `fileNamePattern` basename regular
expression is rejected explicitly because the Warehouse contract has no
include-regex equivalent; narrow the source `path` or use suffix filters
instead of submitting a pattern that would be silently ignored. Omit
`allowedSuffixes` for Warehouse's automatic supported-file detection; the
legacy `"*"` value is normalized to the same empty suffix list.

该接口只允许对 Atlas 中 `origin=user` 的资产调用，并由可选的 Warehouse
执行远程读取。Workspace 会在自己的 namespace 创建 `ScanRequest`、短期
source Secret 和 evidence PVC 目录；Warehouse Operator 必须监听该 namespace。
任务结果写入 Warehouse `ast_layer_index_v1`、`ast_file_index_v1`、
`ast_coverage_index_v1`，完成后 Workspace 导入 evidence 并在本地生成用户
MOC。公共覆盖任务、公共 MOC 计算、manifest 锁定和发布不属于 Workspace
API；这些流程只在 Assets 内部完成，Workspace 通过 Resource Package v3
同步和安装已经发布的几何结果。Workspace 不依赖 Assets catalog/blocks
运行时接口绘制已安装几何；仅在明确的重合详情或下载计划中使用受保护的
Assets scoped query。

Warehouse v1 不提供逐行 catalog object index。这个接口的远程结果是文件、
覆盖像元和 evidence，成功后可生成用户 MOC 并进入 `/api/sky/coverage`；它
不会让 `/api/sky/objects/query` 获得远程目录行。需要对象级探索时，应使用
Workspace 本地扫描（写入自己的 `astro_object_index_v1`），或等待单独版本化
的 Warehouse normalized-object 契约。

如果 `ASTRO_WAREHOUSE_ES_URL` 使用 URL-encoded Basic Auth，Workspace 会在
提交前移除 URL 中的凭据，把它们放入本次扫描的短期 Secret，并仅提交
`usernameEnv/passwordEnv` 引用；凭据不会进入 `ScanRequest`、plan ConfigMap、
evidence 或 HTTP 响应。

远程扫描创建标准 `ScanRequest`，只增加 Workspace tracking labels（旧的
`atlas-task*` labels 仍作为兼容字段保留）：

```yaml
app.kubernetes.io/managed-by: asa-workspace
atlas.zhejianglab.org/track-caller: workspace
atlas.zhejianglab.org/track-task-kind: user-scan | user-coverage
atlas.zhejianglab.org/track-asset: <asset-id>
atlas.zhejianglab.org/track-connector: <connector-id>
atlas.zhejianglab.org/track-batch: <batch-id>
astro.zhejianglab.org/atlas-task: "true"
astro.zhejianglab.org/atlas-task-kind: user_scan | user_coverage
```

Atlas 不读取 Assets 的任务资源、发布管理接口或执行历史，也不把 Assets
catalog/blocks 当作日常绘图数据源。公开数据单元反查如已配置，只能通过
Workspace 服务端的受保护 scoped query 完成，不会返回 Assets 的完整私有索引。

支持的用户资产覆盖 mode：

| mode | coverageRole | 含义 |
| --- | --- | --- |
| `catalog-radec` | `object_presence` | 用目录 RA/Dec 表达对象出现过的像元 |
| `nested-healpix` | `object_presence` | 使用目录声明的 NESTED HEALPix 列 |
| `fits-wcs` | `image_extent` | 使用 FITS IMAGE HDU 的 WCS 图像边界 |

用户资产普通输出固定为 ICRS、NESTED、MOC Core `maxOrder=10`；查询和网站预览分别由权威 MOC 派生为 order 8 和 order 4。输入 HEALPix 的声明 order 只描述输入。任务快照保存 Connector 配置哈希、路径筛选器、coverage 参数、scanner/operator 版本和幂等键输入，便于审计重试。成功的本地或 Warehouse 扫描会在 Workspace 保存 `moc.fits`、`query-order8.json`、`preview-order4.json` 及其 SHA-256；只有状态为 `ready` 的 MOC 才会进入天球覆盖层。

### 用户 MOC

```http
GET /api/user-mocs
GET /api/user-mocs/{layerId}/{scanRunId}/moc.fits
GET /api/user-mocs/{layerId}/{scanRunId}/query-order8.json
GET /api/user-mocs/{layerId}/{scanRunId}/preview-order4.json
```

`/api/user-mocs` 只返回 artifact 元数据（状态、orders、precision、文件
大小和哈希），不返回 FITS、normalized scan 或任务快照内容。文件下载仅限
服务端 allowlist 中的 artifact 名称；`/api/sky/coverage` 会合并 Workspace
本地 ES、Warehouse ACTIVE layer 和已验证的用户 MOC，并把用户 MOC 的
order-4/order-8 投影送入天球展示。

每个用户 MOC 天球层同时返回可渲染 artifact 和最新一次扫描的状态：
`mocStatus`/`artifactId` 是当前用于渲染的 artifact，`latestMocStatus`/
`latestArtifactId` 是该 layer 最新扫描生成的 artifact。如果最新扫描仍为
`pending` 或已 `failed`，上一份 `ready` artifact 继续渲染，但最新状态仍会
返回给客户端；只有没有任何 ready artifact 时，layer 才不产生可见像元。
`maxOrder` 是 MOC Core/Warehouse layer 声明的权威上限，`availableOrders`
只列出源数据实际提供的 order，二者不能互相推导。

### 用户资产运行状态

```http
GET /api/data-assets/status
```

这是覆盖页使用的派生读模型，不会改写资产登记记录。每个用户资产返回：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `coverage` | `not_started` / `pending` / `failed` / `ready` / `empty` / `unavailable` | 覆盖证据和最近一次扫描的综合状态 |
| `objects` | `queryable` / `not_indexed` / `unavailable` | 对象索引是否能查询该资产 |
| `nextAction` | `scan_local` / `scan_remote` / `retry` / `configure_connector` / `configure_index` / `none` | 当前可以执行的下一步 |

`acquired`（界面显示为“已获取”）只表示资产已经登记了数据或访问权，
不代表已经建立空间覆盖；只有 `coverage=ready` 才会把像元显示在用户天球层。
旧资产中已经不存在的 Connector ID/location 不会被当作有效连接，状态会重新给出
配置 Connector 的下一步。

### 天区重合和反查

```http
POST /api/sky/overlap
Content-Type: application/json

{
  "nside": 16,
  "surveyIds": ["desi", "gaia"],
  "assetIds": ["user-asset-123"],
  "includePublic": true,
  "includeWorkspace": true
}
```

接口只对当前可见且已有像元证据的公共/工作区来源求交，返回共同像元和按
HEALPix 四邻接拆分的 `components`（区块 ID、面积、边界和来源 ID）。
Three.js 天球的 `G` 模式使用同一结果绘制动态虚线边界；点击区块可查询：

```http
POST /api/sky/overlap/details
POST /api/sky/reverse-lookup
```

`componentId` 可代替 `pixels`。普通几何重合不要求有文件反查索引。用户来源的
反查使用 Workspace 自有 coverage/MOC/index；公开来源的精确反查应使用服务端
受保护的 Assets scoped query。其请求必须携带 concrete public source identity，
例如 `public:desi:dr1:spectro:sourceId=tile-123`，不能使用 `public:desi` 或
任何仅含 survey 的 ID。返回结果必须保留实际 order、revision、expiry 和状态。

公开反查通过服务端 API Key 临时读取 Assets 的原生分块分页，返回原生身份、
来源 URI 和实际精度；本地部分返回命中文件的直接父目录。
源站文件元数据只在用户操作下面的下载预览时获取，按具体原生单元解析，
不爬取整个巡天根目录。MOC JSON、说明页、S3 入口或没有可验证文件映射的
来源保持 `entrypoint-only` 或 `unavailable`。缺少 API Key 时，公开几何和
本地目录查询仍可用，公开原生反查和下载预览不可用。

### 区域下载预览与确认

```http
POST /api/sky/download-plan/preview
Content-Type: application/json

{
  "layerIds": ["desi-dr1-spectra-footprint"],
  "order": 4,
  "cells": [637,639,725,958,959,1002,1003],
  "querySnapshotId": "<Assets 反查返回的 querySnapshot.id>",
  "nativeUnitIndexRevision": "<Assets 反查返回的 nativeUnitIndexRevision>",
  "units": [{"layerId":"desi-dr1-spectra-footprint","unitKind":"tile","unitId":"406"}]
}
```

示例中的单元身份必须确实出现在所选区域的冻结快照中；不能仅复制示例身份。
请求体直接是公开选择器，成功返回 `200`、`Cache-Control: no-store` 和
`{"preview":{...}}`。预览不会创建任务或传输科学文件，字段含义如下：

| 字段 | 含义 |
| --- | --- |
| `selection` | 规范化后的公开图层、ICRS/NESTED order/cells、快照和明确原生单元；用于后续确认 |
| `querySnapshotId`、`nativeUnitIndexRevision`、`expiresAt` | Assets 冻结查询及有效期限；确认时重新核对 |
| `inventory.files` | 当前候选文件：真实 URL、相对目标路径、大小/校验信息、来源和原生单元身份；相同物理 URL 去重 |
| `unavailable`、`notes` | 文件或来源不可用的原因、访问与范围限制；不能据此创造文件 |
| `selectionTruncated`、`inventory.truncated` | 原生选择或文件解析受到限制；分页耗尽不代表库存完整 |
| `limits` | 确认上限：最多 128 个文件；文件大小与任务总量没有字节配额 |
| `planSha256` | 绑定本次选择、版本和候选清单的摘要；确认字段名为 `previewSha256` |

同一端点支持 `Accept: text/event-stream`。响应保留 `Cache-Control: no-store`，
设置 `X-Accel-Buffering: no`，等待期间每 10 秒发送心跳注释。事件如下：

| 事件 | `data` 内容 |
| --- | --- |
| `progress` | `stage: lookup / metadata`、`completed`、可选 `total`、`files`、`unavailable` 计数 |
| `batch` | `files` 和 `unavailable` 增量；相同 URL 可更新归属，客户端按 URL 合并 |
| `complete` | `{"preview":{...}}`，最终校验后的完整预览及摘要 |
| `error` | `error` 消息；已分类错误附带 `statusCode` 和可选 `retryAfterSeconds`，随后结束连接 |

流开始前的参数错误仍返回普通 HTTP 错误。收到 `complete` 前，文件仅供查看，
不能勾选或确认。停止后保留已发现文件，但必须重新预览才能确认。关闭预览、
切换天区/模板或离开数据生产会中止当前源站请求并停止后续排队请求。
未声明流式响应的客户端继续接收原有 JSON。预览不创建持久化 session。

桌面默认从已载入结果中每巡天选择一个原生分块，用户可以展开增加（最多 128 个），
再请求文件预览；区域的完整 `order/cells` 和图层选择仍保留。改变分块选择会清空
旧预览及文件勾选，必须重新预览。预览完成后，最多 128 个候选默认勾选，文件大小
不影响选择；创建下载任务仍需用户确认。执行器按流分块写入 `.part` 文件，并在源站
提供强校验器时用 HTTP Range 续传。这个选择只控制源站元数据
解析范围，不限制区块反查分页或 JSON/CSV 来源清单导出。

确认使用现有 `POST /api/production-runs`、`pipelineKey=overlap-download@1`：
传入相同天区 `region`，`publicDownload.selection=preview.selection`、
`publicDownload.previewSha256=preview.planSha256`，以及用户勾选的
`publicDownload.selectedFileUrls`。服务器在创建任务前重新校验同一快照和候选清单；
默认并发 4，允许 1–16。桌面流程使用 `warehouseHandoff=none`，下载后登记资产并
单独扫描。完整请求示例见 [下载流程](download-plan-workflow.md)。

成功创建返回 `202` 和 `{run}`。任务仅持久化选中文件的最小清单、审批引用和进度；
不保存原始公开反查或未选候选。重试复用已经批准的文件集合，后续发现新文件不会追加。
下载写入 Workspace 运行端，完成后注册 Connector；Assets 不下载科学文件。

参数错误返回 `400`；Key 缺失或鉴权失败返回 `401`；快照过期、版本或清单变化
返回 `409`；Assets 配额限制返回 `429` 并携带 `Retry-After`。源站单项不可用通过
预览的 `unavailable` 表达。

### 重合来源下载闭环

```http
POST /api/coverage-downloads
Content-Type: application/json

{
  "componentId": "C01",
  "sourceIds": ["public:desi:dr1:spectro:sourceId=tile-123"],
  "files": [{
    "url": "https://example.org/catalog.fits",
    "name": "catalog.fits",
    "sizeBytes": 1048576,
    "sha256": "<sha256>"
  }]
}
```

提交返回 `202` 和任务 ID。Workspace 会校验文件名、目标路径和 URL 协议；
单文件与任务总字节数不设上限。服务器逐个下载文件并校验大小和 SHA-256，
失败文件重试耗尽后会跳过，继续下载其余文件。至少一个文件通过校验时，
成功文件会放到受管本地目录并自动登记一个新的 `local` Connector；全成功为
`completed`，部分成功为 `partial`，任务的 `outputConnectorId`/`outputPath`
指向结果。全文件失败时状态为 `failed`，不会登记空 Connector。可用下面的
接口轮询或取消任务：

下载计划的 public item 只能来自 concrete public source identity 对应的受控
结果；`public:<survey>`、缺少 release/DR/product/sourceId/layerId 或身份与
返回结果不一致时，在创建/执行前拒绝。用户资产和 MOC 只作为区域快照与空间
约束，不会进入 public item 列表。几何-only、entrypoint-only 和
candidate/incomplete 结果必须先以对应状态展示；未确认的候选不执行。

```http
GET  /api/coverage-downloads
GET  /api/coverage-downloads/{jobId}
POST /api/coverage-downloads/{jobId}/cancel
```

任务状态为 `queued`、`running`、`completed`、`partial`、`failed` 或 `cancelled`，并带有
`downloading`、`verifying`、`registering`、`partial` 等阶段。`downloadedFiles`
只统计通过完整下载与校验的文件；逐文件错误保存在 `transfer[].error`。下载任务始终创建新的 Connector；
旧版的 `targetConnectorId` 参数会被明确拒绝，不会静默写入已有位置。

### Assets 原生 MOC

```http
GET /api/resource-packages/{packageId}/mocs
GET /api/resource-packages/{packageId}/mocs/{layerId}
```

这两个只读接口只针对已安装并通过校验的 Assets Resource Package v3；列表
返回 manifest 声明的 layer、release、coverage 语义和 SHA-256，第二个接口
下载对应的原生 IVOA FITS MOC。请求不能指定任意包内路径，也不返回 package
evidence；公共天球默认仍使用已激活 footprint 的展示投影。

## Survey 登记

```http
POST /api/surveys/registrations
Content-Type: application/json

{
  "id": "csst",
  "name": "CSST",
  "sourceUrl": "https://nadc.china-vo.org/data/",
  "modalities": ["imaging", "photometry", "catalog"],
  "releases": [{
    "id": "csst-sim-w1-20250731",
    "label": "CSST W1 Simulation 2025-07-31",
    "kind": "early_release",
    "availability": "metadata_only",
    "modalities": ["imaging", "photometry", "catalog"],
    "products": [{
      "name": "W1 simulated wide-field images",
      "modality": "imaging",
      "description": "W1_Phot 下 _WIDE_*.fits 的仿真图像"
    }]
  }]
}
```

登记巡天只建立 Atlas 用户数据的元数据身份，不代表已有真实观测覆盖，也不会保存 OSS 凭据。公开巡天目录和覆盖制品由 Assets Resource Package v3 管理；Connector 只负责随后记录用户数据的访问位置。

公共包元数据只读接口：

```http
GET /api/public-surveys
GET /api/public-surveys/{surveyId}
```

这两个接口只读取已同步的 v3 包元数据，不写入 Atlas SurveyRegistry，也不能用于登记、修改或删除用户标签。
没有成功同步过的本地 Assets 快照时，它们返回 `503`；这不影响
`/api/surveys`、用户资产、Connector 或用户扫描接口。

## 维护清单

修改 API 时按以下顺序提交：

1. 更新实现和本文件的请求/响应契约。
2. 更新参数校验、权限、幂等和错误状态测试。
3. 更新 `/home/aaron/Repo/Astro-Survey-Atlas-Warehouse/docs/scan-plan.md` 和
   `docs/operator.md` 中的运维命令（若影响 ScanRequest 执行）。
4. 更新前端调用方和端到端测试（若影响 UI）。
5. 运行 `npm run build && npm test`；部署后检查对应的 `/api/...` 响应。

实现索引：

- HTTP 路由：`src/http-server.ts`
- 用户远程扫描 coverage 契约：`src/coverage-jobs.ts`
- Kubernetes 任务提交：`src/warehouse-scan.ts`
- 用户 MOC artifact：`src/user-moc-artifacts.ts`
- Warehouse `ast_*` 读取：`src/warehouse-index.ts`
- 扫描运行记录：`src/connector-history.ts`
- scanner/operator 细节：`/home/aaron/Repo/Astro-Survey-Atlas-Warehouse/docs/scan-plan.md`

## 私有制品修复与天空数据点

`POST /api/data-assets/{assetId}/derived-repairs` 接受
`{"mode":"moc"|"positions"|"both","scanRunId":"可选的成功扫描 ID","maxFiles":100}`。
`maxFiles` 可选，1–1000，只用于 header 样本验证；样本不会写入正式数据点索引。
任务返回 202，状态由 `GET /api/derived-repairs` 查询。任务独立保存，关联原扫描
和输入快照哈希，不覆盖原始扫描、MOC 失败历史或 Warehouse 当前覆盖。
MOC 从既有 normalized evidence 流式导入并在磁盘排序去重。坐标补建消费同一份
有限文件清单，默认 8 路读取未压缩 FITS 的 2880-byte header Range，跳过像素数组；
每 100 文件提交可恢复 checkpoint。新覆盖扫描同时保留 header 证据，成功后直接
补建坐标，不再次读取科学文件。失败文件与坐标错误保留为私有证据，成功批次可查询。

天空数据点在独立的 `astro_data_point_index_v1`；科学目录对象仍在既有对象索引。
影像中心使用科学 HDU 的 Astropy celestial WCS 转到 ICRS，保留 HDU、原始 WCS
header、方法和源文件；无影像 WCS 时可使用明确的目标指向。影像中心、指向和
目录行是不同的位置类型，影像中心不代表检测出的恒星，不能作为科学对象匹配输入。
缺少真实坐标不产生 HEALPix 中心替代点。辅助 DQ/ERR 等 HDU 不产生影像中心。

`POST /api/sky/points/query` 必须提供 ICRS/NESTED `region` 和显式
`layerScopes: [{"assetId":"...","sourceId":"可选的具体公开来源"}]`；`bbox` 与区域
取交集。作用域是 asset AND source，多个作用域之间 OR，空数组严格返回空结果。
`includeAttributes:false` 只返回位置和少量位置类型/来源标记，完整文件与 header
由 `GET /api/sky/points/{id}` 按需读取。分页延续原有 cursor/search_after 契约。
响应的 `indexing` 表示所选私有资产仍有正式坐标补建任务；样本和 MOC-only
任务不计入。Aladin 在此期间保留已显示点，每 10 秒按冻结入口天区和当前视野
重新查询，完成后恢复视野缓存。取消所有可查询图层或退出 Aladin 会停止刷新。

索引写入遇到超时、连接失败或 HTTP 429/502/503/504 时，任务保持 `running`，
保留最后提交偏移，以 10–120 秒退避重试。`retryAttempts` / `nextRetryAt`
说明当前等待；成功后清除。超时可能已经写入部分文档，稳定点 ID 保证重试幂等，
统计只在整批成功后前移。为同一扫描、源快照和样本范围创建新的坐标补建时，
复用已有 header Job/证据，从已提交的 header 重建索引，保留之前的失败任务。
`POST /api/sky/points/scopes` 接受具体 `sourceIds`，只通过已校验下载文件的来源
以及输出 Connector 与私有资产的真实关联解析 scope，不按巡天名称猜测。

Aladin 冻结外部选择的具体图层与进入区域，默认启用所有继承图层；内部 checkbox
只能缩小此集合。公开 coverage-only 图层明确提示下载扫描后才有数据点。缓存包含
进入区域、具体来源与内部选择，取消所有图层不退回全局查询。资产状态独立报告
`dataPointCount`、`dataPointStatus` 与补建文件进度，覆盖成功不等于目录对象已索引。
