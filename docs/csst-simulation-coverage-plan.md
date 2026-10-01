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
