# CSST 仿真资源在 Atlas 中的边界

本阶段 CSST 是用户的私有数据。CSST 扫描、覆盖、MOC、天空分块映射、文件
路径和任务记录由 Workspace 持有，不进入 Assets Git、后端存储、证据归档或
公开资源包。此前“CSST 公共覆盖属于 Assets”的方向已被此边界取代。

Atlas 只做以下事情：

- 同步 Euclid、DESI、Legacy Surveys、HST 的公开 MOC 和图层元数据，并校验
  manifest、文件大小、SHA-256 和 FITS MOC 合同；
- 在 Workspace 内与用户扫描得到的 CSST 图层求交，保留实际可用 order；
- 使用 Workspace 服务端保存的 Assets API Key 请求重合区域的公开分块；请求
  仅含公开 layer IDs、order/cells 和游标，不传 CSST 身份、路径或扫描证据；
- 公开反查响应只存在请求和浏览器内存，允许临时浏览器导出，不写入 Workspace
  存储、缓存、制品、配方或日志正文；没有有效 Key 时不做匿名或爬虫回退；
- 将用户自己注册的 CSST 文件作为 `origin=user` 资产处理，用户扫描结果只
  写入 Workspace 的索引和任务历史；重合反查返回命中文件的直接父目录，去重
  后展示和导出，不返回逐文件清单，不用扫描根目录替代缺失映射。

现有 CSST W1-W4 用户资产、任务记录、MOC 像元和 SHA-256 是历史数据，清理
代码时不得修改、重算或覆盖。CSST release 保留为 Workspace 本地用户标签，
不会自动成为公开资源。本轮不新增扫描，不读取科学内容、文件头或预览。

本文件不记录公共 CSST 扫描或发布命令。公开巡天与私有 CSST 的所有权契约见
[public-coverage-boundary.md](public-coverage-boundary.md)。

## 2026-09-30 实际验收

Workspace Dev revision 53 / Assets revision 294 已部署。桌面浏览器实际选中四个
公开巡天与现有 CSST 图层，在重合模式点击整个有界 component。现有五方重合
共有 3 个 O8 像元；本次检查的单像元 component 返回 54 个去重父目录，仍标为
原生 O10 / estimated。JSON、CSV 与展示内容一致，没有新增扫描或读取科学文件。

该私有场景的四巡天覆盖依据及官方入口均保留，但不能称四巡天原生分块齐全：
锁定的 Legacy DR10 South 清单在该区域无 brick 命中；HST 在本次浏览器请求中
超时。导出含 25 个可用 DESI/Euclid 分块，并保留 `truncated=true`、
`queryExhausted=false` 与各来源说明。公开 C04 场景已单独验证四巡天原生分块齐全。

随后同版本服务端复验返回 32 个公开分块，其中 HST 为 7 个观测；私有父目录
仍为 54 个，Legacy 仍无 brick 命中。无 Key 的客户端未发起任何公开请求，
错误 Key 被拒绝且没有回退。仅查询私有图层时返回原生 O10 父目录且没有
Assets 响应；来源缺失、成功与超时结果均有实际接口证据。

公开响应继续只在请求与浏览器内存使用。此处只记数量和精度，不保存私有目录
值、扫描身份、像元编号或公开反查响应。后续优先核实公开库存范围及元数据查询
稳定性，再优化既有私有几何读取耗时；不通过改写覆盖或路径伪造可用结果。

## 2026-10-01 来源续验

Assets Dev revision 298 使用 SHA 锁定的 MAST CAOM snapshot 和本地 SQLite v4
索引处理 HST observation 反查；请求期间不查询 MAST。revision 294 浏览器中达到
45 秒期限的问题来自请求时查询 CAOM 元数据。当前 v4 仍有 18 条 `GSC1`/`OTHER`
坐标框架未核实，因此 HST inventory 继续标记不完整。Assets Dev 的公开 C04
order-8 HST 接口返回 HTTP 200、158 条 observation、`queryExhausted=true`、
`truncated=true` 和 18 条排除记录；没有展开科学文件产品。MAST 仍是公开元数据
snapshot 来源和用户查看当前产品及访问策略的入口。

Workspace revision 53 已通过服务端 Assets API Key 路径复验 Assets revision 298，
请求范围为四个公开巡天与当前 Workspace CSST survey set。结果为 3 个 O8 像元、
2 个 component，两个 component 都完全位于 Dec 32.375 度以北；因此 DR10 South
返回 0 个 brick 是发布范围结果，不是 South roster 漏索引。锁定的 South roster
有 366,912 个成员并完成与全天天空 brick 几何的本地 join；官方 DR10 文件页没有
North roster 或 North Coadd/Tractor 产品树，不能从 all-sky 几何造出 DR10 North ID。
当前天区若要返回 Legacy 链接，应启用独立的 DR9 North 身份；Assets 的 DR9 matcher
可用阶数为 O4、精度为 estimated，启用后共同重合阶数会降至 O4。

两个 component 的 HST observation 均由本地 SQLite 索引返回，分别为 5 和 8 条，
请求期间没有访问 MAST 或超时。每个 component 一页即结束，但由于 HST snapshot
仍排除 18 条坐标 frame 未核实的记录，aggregate 状态保持 `queryExhausted=false`、
`truncated=true`、`precision=truncated`。JSON/CSV 内容逐条一致：公开分块分别为
30 和 45 行，Workspace 直接父目录分别为 54 和 63 行。这里只记录计数和精度；
不记录私有目录值、身份或像元编号。

本次只确认本地反查与导出状态，没有新增 CSST 扫描或读取科学文件。私有直接
父目录仍只在 Workspace 响应与浏览器会话中处理；此处不记录目录值、扫描身份
或空间分块编号。

## 2026-10-01 Dev revision 300/54 续验

在当前 Dev 上使用四个公开巡天与现有 CSST 图层计算 O8 重合，得到 3 个 cells、
2 个 components。选择单 cell component 后，Assets API Key 路径返回 30 个公开
空间单位：DESI DR1 1、Euclid Q1 24、HST 5；Legacy DR10 South 在该区域无 brick
候选，但四个巡天的覆盖证据均保留。公开分块有 78 个 URI 条目。Workspace 返回
54 个去重直接父目录，没有目录截断。

使用 Workspace 的 JSON/CSV manifest 生成器对同一内存响应逐项比较：30 个公开
空间单位及全部 URI payload 相等，54 个私有目录行也相等。页面没有后续 Assets
页，但总状态仍为 `queryExhausted=false`、`truncated=true`，原因是 HST 锁定快照
排除 18 条无法确认坐标 frame 的记录；请求没有超时或调用 MAST。

公开 Assets 请求只带公开 layer IDs、当前 component 的 order/cells 和分页游标；
没有 CSST asset/layer ID、路径、scan identity 或文件级 metadata。CSST 完整覆盖
映射和父目录仍留在 Workspace。文档只保留计数和精度，没有写入私有 cells、目录
值或身份；未新增扫描，也未读取科学文件。

额外检查了一个 7-cell O4 component。它的公开 Assets 请求达到配置 deadline，
Workspace 本地父目录候选也触发 scope/limit incomplete 状态。因此宽 O4 查询
不能按“零命中”展示，应先缩小用户选区或改进候选分页与查询成本。该失败结果不
包含任何持久化输出。

## 2026-10-01 Dev revision 305/58：完整组件与桌面导出

四巡天和 CSST 的主流程已在完整 O4、7 cells、约 94 deg² component 上实测，
没有缩为单 cell。Workspace revision 58 以 ES composite aggregation 归并匹配文件
身份与原生 order，再批量 join locator、流式合并父目录；旧逐 edge 流程约 98.7 秒
仍触及 50,000-file 上限，新只读目录探针约 33.9 秒返回 3,893 个目录记录，未遗漏
父目录，证据仍为原生 O10。容器保持 1 CPU / 1 GiB。

`matchingCellsTruncated` 表示目录所列 native cells 是代表性证据样本，每个目录
最多保留 4,096 个，不等同于 `directoriesTruncated` 的父目录遗漏状态。页面和
JSON/CSV 分别保留实际阶数、最保守精度及这个 sampling 标记。

桌面实际加载并选择四个公开巡天和 CSST asset，点击完整 component、导出 JSON 和
CSV 已通过：3,893 个直接父目录未截断，9,056 条四巡天原生记录（Euclid 744、DESI
131、Legacy 5,682、HST 2,499）的所有 URI / HST `s_region` / 模态 / 精度与显示列表
及导出一致。分页跨两次 Key 限流仍沿用同一个 Assets snapshot；续页不再重复读取
私有目录。普通点击没有 native 请求，page errors=0、direct MAST requests=0。
页面把关联 Warehouse 图层合并进 CSST asset card，不重复选择同一层身份。

Assets 桌面也已通过同一完整公开组件的验收：20 个产品层导出 22,772 条原生记录，
JSON/CSV 的全部 URI、HST `s_region`、模态、实际阶数及精度一致，展示数量相同。
Workspace 此场景选择 14 个公开产品层，因此其 9,056 条公开记录与 Assets 的数量
差异来自图层选择。Assets 的 11 种巡天组合、匿名预览导出和 API Key 解锁均通过；
两端普通点击都不发起原生反查，浏览器均无直接 MAST 请求。

private-only API 返回同样的目录清单且没有 Assets 结果；无 Key client 的公开请求
数为 0。公共 native index 和 snapshot 仍只在 Assets，Workspace 临时结果仅在请求
和浏览器内存；验证没有保存真实私有路径、像元或 source/scan identity，没有扫描
或读取科学文件。HST 的 18 条坐标 frame 未核实记录仍标记 inventory incomplete，
即使公开分页已经耗尽也不修改该状态。构建、类型、Helm 检查和 306 tests（304
通过、2 跳过）均通过；原有数据、包选择和未提交修改保留。
