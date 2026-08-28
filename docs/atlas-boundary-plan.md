# Workspace 边界与统一通知实施计划

本文是 Astro Survey Atlas Workspace 本轮对外契约的冻结说明。它把
Workspace 从旧的 scan 插件契约迁移到 Assets/Warehouse 当前接口；本轮不
修改 `/home/aaron/Repo/Astro-Survey-Atlas-Warehouse`、共享 CRD schema 或
Assets 的任务与数据库。

## 产品边界

| 组件 | 本轮负责 | 本轮不负责 |
| --- | --- | --- |
| Assets | 公共覆盖、MOC、preview、Resource Package v3、catalog 和公共 coverage task | Workspace 用户资产、用户 MOC、用户任务历史和用户 ES |
| Warehouse | `ScanRequest` / `ScanPlan v2` 的远程执行、状态、规范化 `ast_*` 索引和 evidence | 产品发布权限、Workspace 用户记录和用户天球 UI |
| Workspace | 自有 ES；用户资产/Connector；本地扫描；可选 Warehouse 用户扫描；MOC artifact、覆盖 API、任务历史和天球探索；Assets v3 只读同步 | Assets 公共任务与发布；Warehouse scanner/operator；把用户记录写回 Assets |

## 搜索与存储隔离

Workspace 的 Elasticsearch 是必需的数据面，和 Warehouse 完全独立：

- `ASTRO_ES_URL` 指向 Workspace ES，使用 `astro_file_index_v1`、
  `astro_object_index_v1`、`astro_coverage_index_v1`；本地扫描和用户对象、
  coverage 查询只使用这些索引。
- `ASTRO_WAREHOUSE_ES_URL` 只在启用远程执行时配置，读取 Warehouse 的
  `ast_layer_index_v1`、`ast_file_index_v1`、`ast_coverage_index_v1`；它不是
  Workspace 的 fallback，也不是用户元数据数据库。
- Warehouse v1 的 `normalized-scan.json` 和 `ast_*` 索引不提供逐行 catalog
  object。远程用户扫描因此只能提供文件/覆盖证据和用户 MOC；Workspace 不会
  把覆盖像元伪装成对象查询结果。对象级探索需要本地扫描写入
  `astro_object_index_v1`，或未来单独版本化的 normalized-object 契约。
- Warehouse v1 layer 文档没有 caller 字段；Workspace 仅按本地用户 asset、
  run 或 artifact 的 layer ID 读取，不能把可达的 Assets 公共 layer 当成用户
  coverage。公共覆盖仍由已验证的 Resource Package v3 提供。
- Workspace state PVC 保存元数据、任务历史、已验证的 Assets 包和用户 MOC
  artifact；Warehouse evidence PVC/object store 保存 manifest、normalized
  scan、任务快照、错误及原始扫描证据。

`dataWarehouse.enabled=false` 时不创建 Warehouse RBAC/evidence PVC，不注入
远程 endpoint，Workspace 仍能运行本地扫描、查询自己的 ES、显示已安装的
Assets 公共覆盖和生成用户 MOC。启用后也不会把本地结果迁移到 Warehouse。

## Assets Resource Package v3

Workspace 只读取 Assets 已发布的不可变 v3 catalog/package：下载前验证
manifest、大小、SHA-256、MOC 坐标/ordering 和 provenance，验证失败不激活。
公共 survey/release/product 与 Workspace 用户登记是分开的命名空间；用户
可以使用没有公共包记录的 `surveyId`/`releaseId`。Assets 的公共 MOC 会随
package 安装进入只读公共层，不写入用户资产或用户 MOC 历史。

## Warehouse 任务契约

Workspace 的远程普通扫描和 coverage 扫描都提交 namespaced
`atlas.zhejianglab.org/v1alpha1/ScanRequest`，其中 `spec.plan.version` 必须
为 `2`。调用方不创建旧的 `AstroDataSource` 或 `AstroMetadataScanTask`，也
不把 task kind 加进共享 CRD schema。

Workspace 请求使用如下 labels：

```yaml
metadata:
  labels:
    app.kubernetes.io/managed-by: astro-data-workspace
    atlas.zhejianglab.org/track-caller: workspace
    atlas.zhejianglab.org/track-task-kind: user-scan | user-coverage
    atlas.zhejianglab.org/track-asset: <asset-id>
    atlas.zhejianglab.org/track-connector: <connector-id>
    atlas.zhejianglab.org/track-batch: <batch-id>
    # Compatibility only; canonical selectors use track-* labels.
    astro.zhejianglab.org/atlas-task: "true"
    astro.zhejianglab.org/atlas-task-kind: user_scan | user_coverage
```

Assets 使用相同的 `track-*` keys，但 `track-caller=assets`、
`track-task-kind=public-coverage`。Workspace 查询任务时必须同时限制自己的
caller label 和自己的本地 `ConnectorIngestRun`；不得显示 Assets 或
Warehouse 原生历史。

`ConnectorIngestRun.taskKind` 是 Workspace 本地字段（`user_scan` 或
`user_coverage`），不是 CRD 字段。提交前必须验证 user asset、Connector
检查状态、coverage recipe、凭据引用和幂等输入；凭据值永远不进入
ScanRequest、plan ConfigMap、evidence、快照或 HTTP 响应。Warehouse ES URL
中的 URL-encoded Basic Auth 会被放入本次扫描的短期 Secret，并通过
`usernameEnv/passwordEnv` 引用注入 scanner。

## 端到端用户 MOC 流程

```text
用户资产/Connector
  -> local scanner 或 ScanRequest(user-scan/user-coverage)
  -> Workspace ES（本地）或 Warehouse ast_*（远程）
  -> evidence 导入 Workspace
  -> pinned MOC Core 生成 ICRS/NESTED IVOA FITS MOC
  -> /state/user-mocs/<layer>/<scan-run>/
  -> /api/user-mocs 元数据 + allowlisted artifact 下载
  -> /api/sky/coverage 合并并展示用户层
```

用户 MOC artifact 至少包含 `moc.fits`、`query-order8.json`、
`preview-order4.json` 和 SHA-256；metadata response 只返回状态、order、
precision、大小和哈希，不返回 normalized scan 或任务快照。输入 HEALPix 的
order 只能原样记录；不能从 order 4 预览制造 order 8 cells。Warehouse 的
evidence 不可用时，任务状态和 MOC 状态必须显式为 `unavailable`/`failed`，
不得伪造 ready 覆盖。

## Namespace 与 Operator 前提

`ScanRequest`、短期 source Secret 和 evidence Claim 必须位于 Workspace 的
release namespace。Workspace ServiceAccount 只拥有该 namespace 的
Secret/ScanRequest 权限；Warehouse Operator 需要以 cluster-scope watch
Workspace namespace（例如 `WATCH_NAMESPACES=atlas-warehouse,astro-data-workspace`）。
Warehouse ES 服务可以位于 `atlas-warehouse`，但不改变上述 namespace-local
资源约束。

## 统一通知

页面只有一个全局 `#workspace-notification-deck`，固定在右上角。每条通知必须是：

```html
<div class="workspace-notification">
  <strong>摘要</strong>
  <small>详细说明</small>
</div>
```

通知支持 `success`、`info`、`warning`、`error`，默认存活 10 秒，最后约
400ms 渐隐后从 DOM 移除；相同短消息去重并限制数量，使用 `aria-live`、移动端
宽度适配和 `prefers-reduced-motion`。目录同步、资源包生命周期、Connector
登记/检测、普通扫描、用户覆盖、本地检查/扫描、Aladin 和全局/API 错误都只能
通过该 deck 报告临时消息。面板只保留连接徽标、安装状态、任务历史和按钮忙碌
等持久状态。

## 实施与验收

1. 用 Assets Resource Package v3 替换旧公共目录读取，保留 manifest/hash/
   provenance 校验和离线 snapshot。
2. 使用 Workspace 自有 ES 作为本地搜索数据面；保留 bundled/external 两种
   Workspace search 配置，并让 Warehouse 仅作为可选远程执行器。
3. 将远程提交/轮询迁移到 `ScanRequest` + `ScanPlan v2`，固定 namespace、
   evidence mount 和 `track-*` labels；保留旧 labels 仅用于兼容读取。
4. 导入 Warehouse evidence，调用 pinned MOC Core，落盘用户 artifact，并
   在 `/api/sky/coverage` 合并本地 ES、Warehouse ACTIVE layer、用户 MOC 与
   公共 Assets 层。
5. 保持统一通知、任务历史隔离和用户数据不重算/不覆盖/不删除。

验收必须同时满足：

- 未安装 Warehouse 时，Workspace 自有 ES、用户资产、本地扫描、公共包和已有
  用户 MOC 可用；远程扫描只返回明确的 disabled/unavailable 错误。
- Workspace 普通远程扫描带 `track-caller=workspace`、
  `track-task-kind=user-scan`，用户 coverage 带 `user-coverage`；Assets 公共
  任务带 `track-caller=assets`、`public-coverage`，三者都使用标准
  `ScanRequest`/`ScanPlan v2`。
- Workspace API/history 只返回自己的本地记录和用户 artifact，不返回另一
  caller 的任务或证据。
- 成功本地或远程用户扫描在 Workspace 生成校验过的 MOC、order-8 query、
  order-4 preview 及 hash；`/api/user-mocs` 可下载 allowlisted artifacts，
  `/api/sky/coverage` 能以用户 layer 展示其像元。
- 两套 ES 索引、PVC、凭据和 evidence 互不混用；所有输入 manifest、normalized
  scan、任务快照和错误不进入浏览器初始请求。
- 没有重复通知 deck/id，临时反馈按统一生命周期显示；现有用户资产、run、
  artifact 和 hash 不被重算、覆盖或删除。
