# Assets、Warehouse 与 Workspace 边界

本文记录三个姊妹项目之间的稳定契约。Workspace 是面向用户的数据探索
环境，Assets 是公共发布与 MOC 资源的所有者，Warehouse 是可选的远程扫描
执行器和状态服务。实现细节以
[`docs/atlas-boundary-plan.md`](atlas-boundary-plan.md)、Assets 的覆盖流程和
Warehouse 的 `ScanPlan v2` 文档为准。

## 三个组件

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| **Assets** | 公共 survey/release/product 元数据；公共 coverage task；公共 MOC、preview、Resource Package v3、manifest、provenance、catalog 和发布下载 | Workspace 用户资产、用户任务与历史；Workspace 的搜索索引；用户 MOC |
| **Warehouse** | namespaced `atlas.zhejianglab.org/v1alpha1/ScanRequest`；校验并执行 `ScanPlan` v2；远程文件读取、覆盖计算、状态回报；`ast_layer_index_v1`、`ast_file_index_v1`、`ast_coverage_index_v1` 和 evidence | 公共 catalog 激活和发布权限；Workspace 用户身份、权限、任务历史或 MOC 展示 |
| **Workspace** | 用户资产、Connector、用户任务历史；本地扫描；自己的 Elasticsearch；可选 Warehouse 远程扫描；用户 MOC artifact、覆盖合并和天球探索；只读安装 Assets Resource Package v3 | Assets 公共发布流程；Warehouse 的 scanner/operator；把用户数据或用户 MOC 写回 Assets |

## 两套 Elasticsearch

Workspace 始终拥有自己的搜索服务，即使用户没有安装或连接 Warehouse：

| 数据面 | Endpoint | 索引 | 所有者 |
| --- | --- | --- | --- |
| Workspace 用户数据 | `ASTRO_ES_URL` | `astro_file_index_v1`、`astro_object_index_v1`、`astro_coverage_index_v1` | Workspace |
| Warehouse 扫描结果 | `ASTRO_WAREHOUSE_ES_URL` | `ast_layer_index_v1`、`ast_file_index_v1`、`ast_coverage_index_v1` | Warehouse |

两套 ES 不共享索引，也不互相作为运行时 fallback。Workspace 本地扫描和
用户数据探索只写 Workspace ES；远程扫描的 scanner 只写 Warehouse ES。
Workspace 在扫描完成后读取 Warehouse 的规范化结果和 evidence，在自己的
MOC artifact store 中落盘，并把可查询的用户层合并到天球响应。Warehouse
不可用时，Workspace 仍可启动、读取本地数据、展示已安装的公共包和已有的
用户 MOC。

## 共享契约

三个项目只共享这些稳定接口：

- Assets Resource Package v3 的目录结构、`resource-package.json` manifest、
  文件 hash/大小和 provenance；
- ICRS 坐标、NESTED `order/ipix`、IVOA FITS MOC，以及显式的
  `coverageRole`、`dataOrigin`、`sourceTier` 和 precision；
- Warehouse `atlas.zhejianglab.org/v1alpha1/ScanRequest` 中的
  `ScanPlan.version=2`；
- pinned `astro_survey_moc_core` 的输入/输出契约。

`catalog-radec` 的边界转换也属于共享契约：先计算
`theta=(90-Dec)*pi/180`、`phi=RA*pi/180`，再以 `z=cos(theta)` 执行 NESTED
查找。不能用 `sin(Dec)` 替代；两者在赤道精确边界上的浮点归属不同，会让
Warehouse evidence 和本地 MOC 的 cell 不一致。

Workspace 不调用 Assets 的计算或管理 API。它只下载、验证并激活 Assets
发布的不可变 v3 包；公共包记录与 Workspace 的用户 survey/release 标签是
两个命名空间。用户 manifest、normalized scan、任务快照、错误和原始 MOC
属于 evidence，保存在 evidence PVC/object store 或 Workspace 用户 MOC
store，不放进浏览器初始请求。

## 任务标识

Assets 和 Workspace 都可以创建标准 `ScanRequest`，因此 caller 和 task kind
必须使用同一组 canonical labels 区分：

```yaml
atlas.zhejianglab.org/track-caller: assets | workspace
atlas.zhejianglab.org/track-task-kind: public-coverage | user-scan | user-coverage
atlas.zhejianglab.org/track-asset: <asset-id>
atlas.zhejianglab.org/track-connector: <connector-id>
atlas.zhejianglab.org/track-batch: <batch-id>
```

Workspace 的 `user-scan` 表示普通用户远程扫描，`user-coverage` 表示带产品
coverage recipe 的用户扫描；Assets 使用 `public-coverage`。旧的
`astro.zhejianglab.org/atlas-task*` labels 只为迁移兼容保留，不能替代
`track-*` labels。调用方只列出自己 caller 的任务，不能通过标签读取另一方
的历史。

每个 `ScanRequest`、source Secret 和 evidence PVC 都在提交方 namespace 内。
Warehouse Operator 必须 watch Workspace namespace 才能执行 Workspace 请求；
Workspace ServiceAccount 只管理自己 namespace 的这些资源，不拥有
`atlas-warehouse` 的写权限。

## 数据流

公共发布路径：

```text
Assets 公共 recipe
  -> ScanRequest(public-coverage)
  -> Warehouse scanner / ast_* indices / evidence
  -> Assets MOC Core 与 release manifest
  -> Resource Package v3
  -> Workspace 验证、安装并显示公共 MOC
```

Workspace 本地路径：

```text
用户本地文件
  -> Workspace local scanner
  -> Workspace ES + MOC Core
  -> /api/user-mocs + /api/sky/coverage
  -> Workspace 天球
```

Workspace 远程路径（Warehouse 是可选的）：

```text
用户 Connector/S3
  -> ScanRequest(user-scan | user-coverage)
  -> Warehouse scanner / ast_* indices / evidence PVC
  -> Workspace evidence import + MOC Core
  -> Workspace ES/user-mocs
  -> /api/sky/coverage 合并用户 MOC 与公共层
```

远程成功后 Workspace 必须保存 `moc.fits`、order-8 query、order-4 preview、
provenance 和 SHA-256；只有 `ready` artifact 才进入天球覆盖层。没有
Warehouse 时，用户仍可通过本地 Connector 扫描生成完全相同的 MOC artifact
和天球层。

## 深度数据

FITS MOC 只表达“哪里有数据”，不表达灵敏度或质量。若未来增加
`depth/<layer-id>-<band>.fits`，必须同时发布 metric、单位、波段、统计方法、
HEALPix order/resolution、输入和算法版本以及 map SHA-256。在科学定义确定
前，Workspace 不推断虚假深度，也不修改 Assets 已发布包。
