# Atlas 边界与统一通知实施计划

本文是 Astro Survey Atlas 本轮改造的冻结约定。Atlas 仓库内与本文冲突的
旧描述，以本文为准；本轮不修改 `data-warehouse` 仓库、共享
`AstroMetadataScanTask` CRD schema 或 Assets 的任务/数据库。

## 产品边界

| 组件 | 本轮负责 | 本轮不负责 |
| --- | --- | --- |
| Assets | 公共覆盖统计、公共 Connector、公共覆盖任务、MOC finalizer、Resource Package v3 和公共 catalog | Atlas 用户资产、Atlas 用户任务与历史 |
| Atlas | 用户资产、分析/索引、Agent/MCP、本地扫描，以及用户自己的远程普通扫描和覆盖计算；只读安装 Assets 发布的资源包/catalog | Assets 的 Connector、Secret、任务、执行记录或 API |
| data-warehouse | 标准 `AstroDataSource` / `AstroMetadataScanTask` 的文件读取、scanner 和覆盖计算流程 | 产品身份、Atlas/Assets 的任务历史和数据库 |

Atlas 与 Assets 可以调用 data-warehouse，但不共享数据库、Connector、Secret、
任务历史或 API。Atlas 只读取 Assets 发布的资源包/catalog 结果。

## Atlas 任务隔离

Atlas 的普通扫描和用户覆盖扫描都提交标准 `AstroMetadataScanTask`，只增加
Atlas 自己的 Kubernetes labels，不增加共享 CRD 字段：

```yaml
metadata:
  labels:
    app.kubernetes.io/managed-by: astro-atlas
    astro.zhejianglab.org/atlas-task: "true"
    astro.zhejianglab.org/atlas-task-kind: user_scan | user_coverage
    astro.zhejianglab.org/asset: <asset-id>
    astro.zhejianglab.org/connector: <connector-id>
    astro.zhejianglab.org/batch: <batch-id>
```

Atlas 通过本地保存的 job/task ID 查询任务状态；需要列表查询时只使用
`astro.zhejianglab.org/atlas-task=true` selector。Atlas 不解析、查询或导入
Assets 的任务资源。

`ConnectorIngestRun` 是 Atlas 本地历史模型，包含 `taskKind`：

```ts
taskKind: "user_scan" | "user_coverage";
```

普通扫描（本地、远程和 Connector 全量扫描）使用 `user_scan`；用户资产覆盖
扫描使用 `user_coverage`。现有 run、artifact、source file 和 hash 保持不变。
外部系统不能通过 HTTP 直接写入 Atlas 扫描历史；历史只能由 Atlas 提交流程产生。

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

## 实施顺序

1. 固定本文，并同步更新 Atlas 边界、架构和 API 文档。
2. 增加统一通知模块、唯一 deck 和样式；删除 Aladin 局部 status deck。
3. 为 Atlas 本地 run 增加 `taskKind`，限制历史写入口，并在标准任务上增加
   Atlas labels；查询只返回 Atlas 自己的历史。
4. 将目录、资源包、Connector、扫描、覆盖、Aladin 和初始化/API 临时反馈迁移
   到统一通知，保留持久面板状态。
5. 增加针对标签、历史隔离和通知生命周期的 Atlas 测试，运行构建、单测和
   e2e；不触碰 data-warehouse 代码。

## 验收

- Atlas 普通扫描任务带 `atlas-task-kind=user_scan`，用户覆盖任务带
  `atlas-task-kind=user_coverage`，两者均为标准 `AstroMetadataScanTask`。
- Atlas API/history 不返回没有 Atlas task label 或不属于 Atlas 本地流程的记录。
- 现有用户资产、artifact、run 和 hash 不重算、不覆盖、不删除。
- 页面没有重复通知 deck/id；所有临时消息都显示在右上角并按时消失。

