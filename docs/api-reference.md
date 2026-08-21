# Workspace API Reference

这是 Astro Data Workspace API 的维护入口。接口实现、请求示例和状态语义发生变化时，必须在同一变更中更新本文和对应测试；`README.md` 只保留入口链接，不再复制完整请求体。

## 约定

- Workspace API 默认返回 JSON；异步任务提交返回 `202`，随后通过查询接口轮询。
- `POST /api/connectors/:id/check` 只检测 Connector 的端点、Bucket、Prefix 或数据库连接，不创建扫描任务。
- Connector 凭据只保存在 Workspace 的受管 Secret 中，不进入请求体、任务快照或公开响应。
- `surveyId`、`releaseId`、`product` 是产品归属；`connectorId` 是访问位置。覆盖任务提交时服务端会校验它们的一致性。
- 浏览器只调用 Workspace 管理 API。审核后的公开覆盖和资源文件由 Astro Survey Atlas Assets 的只读 API 提供。

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

查询记录：

```http
GET /api/connectors/{connectorId}/runs
GET /api/connector-ingest-runs?connectorId={connectorId}
```

### 本地 Connector 扫描

```http
POST /api/connectors/{connectorId}/local-scan
Content-Type: application/json

{"relativePath":"catalog.csv","maxRows":100000}
```

只适用于 `local` Connector，不与远程 S3/OSS 扫描回退混用。

## 产品覆盖任务

### 提交 coverage job

```http
POST /api/surveys/{surveyId}/coverage-jobs
Idempotency-Key: csst-w1-smoke-10600000012-v1
Content-Type: application/json

{
  "connectorId": "connector-fd599c33-b7c8-4bbd-9377-a7b87133f069",
  "assetId": "user-a04202c3-f8a1-4e0f-8f02-41fc8adf9c1e",
  "releaseId": "csst-sim-w1-20250731",
  "product": "W1 simulated wide-field images",
  "path": "10600000012/",
  "fileNamePattern": "^CSST_MSC_MS_WIDE_.*\\.fits$",
  "allowedSuffixes": [".fits"],
  "coverage": {
    "mode": "fits-wcs",
    "coordinateFrame": "ICRS",
    "coverageRole": "image_extent",
    "dataOrigin": "simulated",
    "sourceTier": "user_file_derived",
    "maxOrder": 8,
    "queryOrder": 8,
    "previewOrder": 4,
    "centerRaAliases": ["RA_OBJ", "RA_PNT0", "RA_PNT1"],
    "centerDecAliases": ["DEC_OBJ", "DEC_PNT0", "DEC_PNT1"],
    "centerUnits": "deg",
    "centerFrame": "ICRS"
  }
}
```

支持的 coverage mode：

| mode | coverageRole | 含义 |
| --- | --- | --- |
| `catalog-radec` | `object_presence` | 用目录 RA/Dec 表达对象出现过的像元 |
| `nested-healpix` | `object_presence` | 使用目录声明的 NESTED HEALPix 列 |
| `fits-wcs` | `image_extent` | 使用 FITS IMAGE HDU 的 WCS 图像边界 |

普通用户数据的权威输出固定为 ICRS、NESTED、Assets Core `maxOrder=10`；查询和网站预览分别从权威 MOC 派生为 order 8 和 order 4。输入 HEALPix 的声明 order 只描述输入。CSST 仿真保留 `image_extent/simulated/user_file_derived/maxOrder=8` 的冻结例外。任务快照会保存 Connector 配置哈希、Prefix/path、basename 文件名过滤器、coverage 参数、scanner/operator 版本和幂等键输入，便于审计重试。`GET /api/surveys/{surveyId}/coverage-jobs` 和 `GET /api/surveys/{surveyId}/coverage-jobs/{jobId}` 用于轮询。coverage job 是私有候选结果；只有人工审核后的静态制品才能进入 Assets 公开 manifest。

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

登记巡天只建立用户数据的元数据身份，不代表已有真实观测覆盖，也不会保存 OSS 凭据。公开巡天目录和覆盖制品由 Assets catalog 管理；Connector 只负责随后绑定用户数据的访问位置。

## 维护清单

修改 API 时按以下顺序提交：

1. 更新实现和本文件的请求/响应契约。
2. 更新参数校验、权限/归属校验、幂等和错误状态测试。
3. 更新 `/home/aaron/Repo/data-warehouse/docs/astro-metadata-scan-runbook.md` 中的运维命令（若影响扫描执行）。
4. 更新前端调用方和端到端测试（若影响 UI）。
5. 运行 `npm run build && npm test`；部署后检查对应的 `/api/...` 响应。

实现索引：

- HTTP 路由：`src/http-server.ts`
- coverage 契约：`src/coverage-jobs.ts`
- Kubernetes 任务提交：`src/flink-ingest.ts`
- 扫描运行记录：`src/connector-history.ts`
- scanner/operator 细节：`/home/aaron/Repo/data-warehouse/docs/astro-metadata-scan-runbook.md`
