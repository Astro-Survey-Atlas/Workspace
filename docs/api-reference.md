# Workspace API Reference

> 本轮 Workspace 边界、任务 label、历史隔离和统一通知以
> [`atlas-boundary-plan.md`](atlas-boundary-plan.md) 为准。这里的接口只描述
> Workspace 自有 API，不是 Assets 或 Warehouse API。

这是 Astro Data Workspace API 的维护入口。接口实现、请求示例和状态语义发生变化时，必须在同一变更中更新本文和对应测试；`README.md` 只保留入口链接，不再复制完整请求体。

## 约定

- Workspace API 默认返回 JSON；异步任务提交返回 `202`，随后通过查询接口轮询。
- `POST /api/connectors/:id/check` 只检测 Connector 的端点、Bucket、Prefix 或数据库连接，不创建扫描任务。
- Connector 凭据只保存在 Workspace 的受管 Secret 中，不进入请求体、任务快照或公开响应。
- `surveyId`、`releaseId`、`product` 是 Atlas 用户资产的本地标签；`connectorId` 是访问位置。Atlas 不向 Assets 注册这些用户标签，也不把它们写回公共 catalog。
- 浏览器只调用 Workspace 管理 API。审核后的公开覆盖和资源文件由已同步的 Astro Survey Atlas Assets Resource Package v3 提供；公共包元数据与 Atlas 本地 SurveyRegistry 分开读取。
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

请求体必须为空对象或省略。该接口扫描 Connector 注册的完整 S3/OSS Prefix，创建 namespaced `atlas.zhejianglab.org/v1alpha1/ScanRequest`（`ScanPlan.version=2`），并返回 Workspace 扫描记录。它不能表达子目录、basename 过滤器或产品级 coverage 证据。

一个 Connector 如果关联多个 `origin=user` 资产，Workspace 会以
`ConnectorScanPreconditionError` 拒绝这次无 `assetId` 的自扫描，不会静默选择
其中一个资产。请改用下面的 `/api/data-assets/{assetId}/remote-scan`，明确指定
目标资产；或者先解除多余的资产关联后再重试。

返回的扫描记录包含 Connector、位置、任务状态和幂等键快照；它只描述扫描执行状态，不代表某个巡天产品已经产生可发布覆盖。

查询记录（只返回 Atlas 本地历史，并按 Atlas label/本地 taskKind 隔离；历史接口只读）：

```http
GET /api/connectors/{connectorId}/runs
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
API；这些流程只在 Assets 内部完成，Workspace 只通过 Resource Package v3
同步和安装已经发布的结果。

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
app.kubernetes.io/managed-by: astro-data-workspace
atlas.zhejianglab.org/track-caller: workspace
atlas.zhejianglab.org/track-task-kind: user-scan | user-coverage
atlas.zhejianglab.org/track-asset: <asset-id>
atlas.zhejianglab.org/track-connector: <connector-id>
atlas.zhejianglab.org/track-batch: <batch-id>
astro.zhejianglab.org/atlas-task: "true"
astro.zhejianglab.org/atlas-task-kind: user_scan | user_coverage
```

Atlas 不读取 Assets 的任务资源、API 或执行历史。

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
