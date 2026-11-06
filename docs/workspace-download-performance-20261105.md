# Workflow FITS 下载与性能改进（2026-11-05）

本轮为数据生产中的星表 Workflow 增加 FITS 文件列表、单文件下载和 ZIP 下载，
同时缩小点位响应、减少启动请求和元数据准备工作，并调整 Dev 资源配置。

## 下载入口

在「数据生产 → 星表 Workflow」打开有切割产物的执行记录，结果下方的
「FITS 切割产物」显示目标、巡天、波段、文件大小和下载按钮；每页 50 个文件。
「下载全部 FITS（ZIP）」包含已登记 FITS、筛选结果、切割索引、已有的运行结果
和包含大小及 SHA-256 的 `manifest.json`。部分切割失败时仍可下载成功产物。
空筛选不显示 ZIP 下载入口。

共用 API：

```text
GET /api/workflow-runs/:id/cutouts
GET /api/workflow-runs/:id/cutouts.zip
GET /api/workflow-runs/:id/artifacts/:name
```

CLI：

```bash
astro-workspace workflows cutouts RUN_ID
astro-workspace workflows cutouts RUN_ID --output cutouts.zip
```

ZIP 使用流式传输，开始响应前检查所有文件的存在性、类型和大小。文件检查
每组最多并发 16 项，避免在 NFS 上串行检查数百个文件。浏览器断开会中止文件读取。
本轮提供 FITS 科学文件下载；PNG/JPEG 预览仍为后续工作。

## 加速改动

- 点位接口默认精简响应，只返回绘图、图层身份、点类型和来源标记；完整属性通过
  点详情接口读取。保留区域、asset/source 过滤和分页；精确总命中数仅显式请求时计算。
- JSON 与静态资源启用 gzip；SSE、MCP 流继续使用原有传输行为。
- 质量批次检查和扫描状态读取限制在选中资产，扫描状态与 ES 查询并行执行。
- 本地、公开巡天均支持一次获取 cards 与完整 records，移除启动时逐个查询详情的请求。
  公共元数据投影复用缓存，未变化的目录同步跳过写入。
- DR9 覆盖补充数据通过校验后缓存 5 分钟，并合并同时发生的请求；读取时仍检查当前
  API key，key 变化后重新获取。启动时在后台预热。过期后的首次刷新仍可能等待远端。
- Aladin 改为进入探索时加载；Workflow 等页面独立于公开目录初始化，Agent 初始化在后台进行。
- 可选 Helm profile `charts/asa-workspace/values-performance.yaml` 将 Workspace limit
  调整为 2 CPU / 3 GiB，ES 调整为 2 CPU / 4 GiB，JVM heap 1 GiB。

## 实测证据及限制

使用已有成功记录 `wfr_20261105012541_6572797f` 验证，没有重新查询科学目录或重新切割。
215 个 FITS 对应 43 个目标；ZIP 有 219 个条目，218 个科学文件及配套文件逐项通过
大小和 SHA-256 校验，另一个条目是 manifest。单文件以 `SIMPLE = T` 开头。
空记录 `wfr_20261105013325_96ffeade` 的文件列表为空，ZIP 请求返回 400。

| 项目 | 变更前证据 | 变更后证据 |
| --- | --- | --- |
| 2,000 点响应 | 用户样本约 1.2 MB | 原始 JSON 约 477 KB；gzip 实际传输约 43–46 KB |
| 首屏主 JS | 约 3.41 MB，未压缩 | 约 988 KB；线上 gzip 约 305 KB，Aladin 独立加载 |
| 公开巡天列表 | 本轮基线 2.494 秒 | 预热后样本 0.005 秒 |
| 公开覆盖列表 | 未缓存补充请求样本 9.267 秒 | 缓存后样本 1.062 秒；最终预热样本 0.009 秒 |

点位延迟**尚未稳定解决**。相同限定范围的请求测到过 0.759 秒、4.698 秒，也有
重启后的 16–18 秒样本和 30 秒 ES 超时。单独调用 ES 曾记录 `took=14050 ms`；
这些请求始终带 HEALPix、RA/Dec 与选中资产条件，没有改为无范围查询。
ZIP 曾分别耗时 5.571 秒和 101.045 秒；后一轮暴露出串行文件检查与共享存储等待问题，
最终版本增加了并发检查，但不能据此保证持续的下载吞吐。

Workspace 状态、生产数据、evidence 和 ES 的 PVC 都使用 `nfs-data`。
ES 所在节点的 `/proc/pressure/io` 样本 `full avg10=43.50`，同时节点 CPU 使用约 7%，
ES 容器约 20m CPU。剩余存储等待需要单独处理；增加 CPU/内存没有消除该瓶颈。
本轮没有迁移卷、删除数据、重新扫描或停止原有 W2 Scanner。

最终 revision 148 复验再次通过全部下载与内容校验。该轮 2,000 点耗时 **15.382 秒**，
传输 **45,890 字节**；W2 小范围查询 **16.310 秒**；ZIP **74.136 秒**。
健康检查出现过 **17.682 秒**，随后复查 **0.025 秒**；Pod 内主线程等待状态采样为
`rpc_wait_bit_killable`，与 NFS 等待一致。浏览器实测默认首页初始化 **0.333 秒**，
故意挂起公开目录请求的 Workflow 初始化 **11.136 秒**。这些结果证明功能和响应体优化，
不能证明查询与下载持续提速。最终 API 测量见私有 receipt 的 `r3/live-verification.json`，
浏览器测量见 `browser-verification.json`。

本地构建、定向回归、Helm lint/template 和差异检查通过；Postgres 合约测试因
没有 `ASTRO_TEST_DATABASE_URL` 跳过。独立 headless 浏览器验证了文件列表、五页分页、
单 FITS 与完整 ZIP 下载、空结果状态；故意挂起公开目录请求时，Workflow 仍可加载，
没有加载 Aladin chunk，也没有页面或 Workspace API 错误。

部署版本、最终复验和私有 receipt 路径见 [session handoff](session-handoff-20261103-agent.md)。
