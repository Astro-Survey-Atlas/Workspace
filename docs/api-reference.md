# Workspace API Reference

> 本轮 Atlas 边界、任务 label、历史隔离和统一通知以
> [`atlas-boundary-plan.md`](atlas-boundary-plan.md) 为准。这里的接口只描述
> Atlas 自有 API，不是 Assets 或 data-warehouse API。

这是 Astro Data Workspace API 的维护入口。接口实现、请求示例和状态语义发生变化时，必须在同一变更中更新本文和对应测试；`README.md` 只保留入口链接，不再复制完整请求体。

## 约定

- Workspace API 默认返回 JSON；异步任务提交返回 `202`，随后通过查询接口轮询。
- `POST /api/connectors/:id/check` 只检测 Connector 的端点、Bucket、Prefix 或数据库连接，不创建扫描任务。
- Connector 凭据只保存在 Workspace 的受管 Secret 中，不进入请求体、任务快照或公开响应。
- `surveyId`、`releaseId`、`product` 是 Atlas 用户资产的本地标签；`connectorId` 是访问位置。Atlas 不向 Assets 注册这些用户标签，也不把它们写回公共 catalog。
- 浏览器只调用 Workspace 管理 API。审核后的公开覆盖和资源文件由已同步的 Astro Survey Atlas Assets Resource Package v3 提供；公共包元数据与 Atlas 本地 SurveyRegistry 分开读取。

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

请求体必须为空对象或省略。该接口扫描 Connector 注册的完整 S3/OSS Prefix，创建通用 `AstroMetadataScanTask`（当前默认 `backend: job`），并返回 Workspace 扫描记录。它不能表达子目录、basename 过滤器或产品级 coverage 证据。

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

只适用于 `local` Connector，不与远程 S3/OSS 扫描回退混用。

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
  "fileNamePattern": "^catalog-.*\\.csv$",
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

该接口只允许对 Atlas 中 `origin=user` 的资产调用，并由可选的
data-warehouse 插件执行远程读取。公共覆盖任务、公共 MOC 计算、manifest
锁定和发布不属于 Atlas API；这些流程只在 Assets 内部完成，Atlas 只通过
Resource Package v3 同步和安装已经发布的结果。

远程扫描创建标准 `AstroMetadataScanTask`，只增加 Atlas labels：

```yaml
app.kubernetes.io/managed-by: astro-atlas
astro.zhejianglab.org/atlas-task: "true"
astro.zhejianglab.org/atlas-task-kind: user_scan | user_coverage
astro.zhejianglab.org/asset: <asset-id>
astro.zhejianglab.org/connector: <connector-id>
astro.zhejianglab.org/batch: <batch-id>
```

Atlas 不读取 Assets 的任务资源、API 或执行历史。

支持的用户资产覆盖 mode：

| mode | coverageRole | 含义 |
| --- | --- | --- |
| `catalog-radec` | `object_presence` | 用目录 RA/Dec 表达对象出现过的像元 |
| `nested-healpix` | `object_presence` | 使用目录声明的 NESTED HEALPix 列 |
| `fits-wcs` | `image_extent` | 使用 FITS IMAGE HDU 的 WCS 图像边界 |

用户资产普通输出固定为 ICRS、NESTED、MOC Core `maxOrder=10`；查询和网站预览分别由权威 MOC 派生为 order 8 和 order 4。输入 HEALPix 的声明 order 只描述输入。任务快照保存 Connector 配置哈希、路径筛选器、coverage 参数、scanner/operator 版本和幂等键输入，便于审计重试。

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
3. 更新 `/home/aaron/Repo/data-warehouse/docs/astro-metadata-scan-runbook.md` 中的运维命令（若影响扫描执行）。
4. 更新前端调用方和端到端测试（若影响 UI）。
5. 运行 `npm run build && npm test`；部署后检查对应的 `/api/...` 响应。

实现索引：

- HTTP 路由：`src/http-server.ts`
- 用户远程扫描 coverage 契约：`src/coverage-jobs.ts`
- Kubernetes 任务提交：`src/flink-ingest.ts`
- 扫描运行记录：`src/connector-history.ts`
- scanner/operator 细节：`/home/aaron/Repo/data-warehouse/docs/astro-metadata-scan-runbook.md`
