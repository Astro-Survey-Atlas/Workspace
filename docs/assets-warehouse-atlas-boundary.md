# Assets、data-warehouse 与 Atlas 边界

> 本文保留产品背景和共享契约。Atlas 本轮实现细节以
> [`docs/atlas-boundary-plan.md`](atlas-boundary-plan.md) 为准；若本文与该
> 计划冲突，采用计划中的 Atlas label、历史和通知约定。

这份说明是三个组件之间的实现约定。它描述依赖方向，不把任何一个组件
变成另一个组件的内部 API 客户端。

## 三个组件

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| **Assets** | 公共 survey/release/product 覆盖定义；公共 Connector、recipe 和一次性 coverage task；MOC Core 生成、合并、锁定；Resource Package v3、manifest、provenance、catalog 和公共只读下载 API | Atlas 用户资产、用户任务、权限、查询索引、用户扫描历史或常驻远程扫描 |
| **data-warehouse** | 标准 `AstroDataSource` / `AstroMetadataScanTask` 的 S3/OSS/JDBC 文件读取、scanner、覆盖计算和结果回传 | 公共 catalog 激活、公共 Resource Package 发布权限、Atlas/Assets 身份和历史 |
| **Atlas** | 本地文件/PVC scanner；用户普通扫描和用户覆盖扫描；用户资产、查询索引、Atlas 本地任务历史和前端展示；安装并验证公共资源包 | Assets 的 Connector、Secret、Job、数据库、任务历史或管理 API |

## 唯一共享契约

Atlas 与 Assets 只共同稳定以下内容：

- Resource Package v3 目录结构和 `resource-package.json` manifest；
- `layerId`、survey/release/product、`coverageRole`、`dataOrigin`、`sourceTier`；
- IVOA FITS MOC、ICRS、NESTED 约定；
- order 8 查询投影和 order 4 预览；
- 文件大小、SHA-256、provenance、公共 catalog 信任校验；
- conformance fixtures 和安装验证规则。

Atlas 不调用 Assets 的计算接口，也不需要知道 Assets 使用哪个 Connector、
哪个 Job、哪个数据库或哪个 worker。Atlas 只读取 Assets 发布的不可变包，
在安装前验证 manifest、文件大小、SHA-256、MOC 坐标约定和 provenance，
验证失败时拒绝激活该版本。

Atlas 调用 data-warehouse 时仍只提交标准扫描契约。Atlas 任务身份通过
`astro.zhejianglab.org/atlas-task=true` 及 `atlas-task-kind` label 表达，
不进入共享 CRD schema；Atlas 只查询自己提交并在本地保存的任务。

## 公共任务流

```text
Assets 管理页面
  -> 创建公共 coverage task
  -> data-warehouse 执行远程扫描
  -> Assets MOC Core finalizer
  -> locked manifest + MOC + v3 package
  -> Assets catalog 激活
  -> Atlas 只读安装并验证
```

官方已经提供 MOC 的产品直接导入锁定；只有区域文件、tile 表或审核后的
本地数据才创建一次性任务。CSST W2/W3/W4 保持独立任务，CSST W1 的既有
制品和哈希保持不变。任务完成后只发布不可变制品，不保留常驻扫描服务。

## 深度数据

FITS MOC 只表达“哪里有观测”，不表达灵敏度或质量。将来若增加
`depth/<layer-id>-<band>.fits`，必须同时发布 `depthMetric`、单位、波段、
统计方法、HEALPix order/resolution、输入和算法版本以及 depth map SHA-256。
在科学定义确定前，Atlas 不创建或推断虚假的深度数据，也不修改 CSST W1 包。
