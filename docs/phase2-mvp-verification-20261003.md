# 第二阶段 MVP 桌面验收记录

日期：2026-10-03，Asia/Shanghai。范围为 Euclid、DESI、Legacy Surveys、HST
公开来源与 Workspace 用户覆盖；不据此宣布所有 component 或巡天库存完整。

## 部署与保留状态

Workspace Dev：Helm `asa`、namespace `asa-workspace`、revision **67**，镜像
`0.10.38-dev-20261003-0206-native-selection`。入口：
http://astro.workspace.dev.72602.space:32080/ 。Deployment 1/1 Ready，网站
`/healthz` HTTP 200。Assets 保持 revision **318**，活动原生索引为
`8a7745f69bd2d87156933fe5c39d5407c79e333e533c76900fa68f193ea67e5f`、generation 2。
公开 bundle 和 MOC 没有在本阶段重新发布。

新增专用 `asa-workspace-production-data` PVC：20 GiB、RWX、`nfs-data`、Bound。
Workspace 下载根与 scanner 挂载基准均为 `/data/production`，扫描只读挂载选定
run 的子目录。已有 state/evidence/search PVC 保留。资源包列表 28 项、已安装 6 项；
安装版本与活动发布选择逐项对比部署前基线一致。原有 CSST 用户资产数量和 ID 集合
SHA 一致。验收另外保留了一个 HST 下载资产；原有 CSST 数据未修改。

Warehouse scanner 使用与当前 Operator 配套的已发布镜像 digest：
`sha256:415a731fc768bb40aa75c53085a36c880b8833b7d52abc00785c2cadbdad4198`。
没有改动或部署 Warehouse 仓库代码。原有错误及失败扫描记录保留；后续验收新建扫描
请求，没有覆盖历史请求。

## 已实现的流程

已安装公共图层/MOC 与用户覆盖求交，点击整个有界 component，使用 Workspace
服务端 API Key 反查公开 Tile/brick/target/observation，同时查询本地直接父目录。
沿用 Assets cursor 分页与冻结快照，没有新增查询会话资源。

「预览下载文件」进入生产工作台；默认每巡天选一个已命中的原生分块，可展开增加，
最多从已载入结果的前 128 个分块中选择。预览只读取所选单元的源站文件元数据，所有
文件候选默认不勾选。改变分块选择会清空旧预览及文件勾选，必须重新预览；全部取消时
预览按钮禁用。区域的完整 cells 和图层选择保留，反查分页和 JSON/CSV 来源清单导出
不受这个选择限制。用户选择文件后确认，服务器重新验证同一快照、原生版本和预览摘要，
再创建 `overlap-download@1` 任务。任务下载完整公开 HTTP(S) 文件到 Workspace，
完成后注册 Connector。后续先登记并关联用户资产，再独立提交文件扫描。

默认上限为 128 文件、每文件 512 MiB、合计 2 GiB；预览保留来源不可用与范围限制。
相同物理 URL 只列一次，并保留确定的原生身份。确认后的任务仅保存选中文件清单与
进度；重试沿用审批集合，不追加后续发现的新文件。未选候选和原始反查响应不落库。
CSST 扫描、图层身份、映射和父目录始终只在 Workspace。

## 桌面与导出

1440×900 真实四巡天与 CSST 七-cell component 验收使用 14 个公开产品层：
公开原生记录 **9,056**，其中 Euclid 744、DESI 131、Legacy 5,682、HST 2,499；
直接父目录 **3,893**，`directoriesTruncated=false`。最终页面、JSON、CSV
逐条一致，94 次 cursor 请求包含 3 次配额等待，均续接同一快照。CSV 二次导出
额外分页为 0；普通点击原生请求、浏览器直接 MAST 请求和页面错误均为 0。
此检查完成于 revision 64；本阶段后续修复未改变 Assets 数据或导出契约。

该查询的页链已耗尽，但 `queryExhausted=false`、`truncated=true`。这些数值表示
本次声明范围内返回的记录，不是全巡天文件数或完整库存证明。

revision 67 的 **1024×768 真实文件预览验收通过**。该场景选中 25 个公共产品层，
与用户覆盖相交后点击整个七-cell component：首屏返回 100 个公开原生记录和
3,893 个直接父目录；默认选择包含四巡天各一个原生分块。真实元数据预览约
**15.3 秒**返回 **92 个去重的文件候选**，`unavailable=0`，所选分块、完整区域和
冻结快照保持一致，文件全部未勾选，新增任务数为 0。普通点击没有触发原生反查，
关闭面板后可重置天球；页面错误和浏览器直接 MAST 请求为 0，没有桌面横向溢出。
`selectionTruncated=true`、`inventory.truncated=true` 仍保留，不以此宣布库存完整。
该 25 层文件预览与上面的 14 层完整导出是不同选择，数量不能混用。

revision 66 曾一次解析首屏全部 100 个分块，450 秒内没有返回；只是元数据请求，
没有创建下载任务。revision 67 增加预览前的分块选择以控制默认解析范围，未对
100 个分块的批量解析重新宣称性能通过。源站响应较慢或选择更多单元时仍可能久等。

revision 67 线上 synthetic Playwright **4/4**：1440px/1024px 文件勾选与确认、大小/数量限制、
上下文变化清空预览、提交期间防重复、窄桌面详情关闭/重开，以及原生选择的默认范围、
增加选择后重新预览、全部取消后禁用预览。全部 API 使用
synthetic 拦截，没有额外科学下载。补充关闭入口后，1024px 天球重置按钮可再次操作；
点击 component 会打开详情。

## 真实下载与本地扫描

以下任务各确认一个真实官方文件，均已完成，文件大小、磁盘 SHA 与 transfer ledger
一致，FITS 可读取，Connector 已注册。

| 来源与原生身份 | 文件 | 实际大小 | FITS HDU | 校验依据 |
| --- | --- | --- | --- | --- |
| DESI DR1 Tile 406 | `zmtl-0-406-thru20210406.fits` | 69,120 bytes | 2 | 官方 SHA-256 与磁盘一致 |
| Legacy DR9 brick 2545p667 | `tractor-2545p667.fits` | 8,861,760 bytes | 2 | 磁盘 SHA 与任务记录一致；没有官方 checksum |
| HST observation 23965098 | `j8ba9ordq_raw.fits` | 34,344,000 bytes | 7 | 磁盘 SHA 与任务记录一致；没有官方 checksum |

对应 SHA-256：

- DESI：`e25d0803a4379c25e6f317a1788bbe3e88149ecef8a7f962cd233c236babfa58`。
- Legacy：`28afe97fd17cebc3e9600e2d5d63aea19631aea23f1eb0967371da601ad2a494`。
- HST：`e1536b0f095d3b70b8ae817ba76e6288aeff284da810fb1dbb504fc9e2c72a5c`。

HST 源站实际约 28–30 KB/s；验收脚本的十分钟等待期限先到，服务端任务继续传输，
最终独立复核成功。没有把脚本等待超时当成文件失败，也没有重启中断该传输。
流式字节进度修复有真实受控流回归：单文件未结束时 `downloadedBytes` 已增长，
partial 状态最多每文件 5 秒持久化一次。未知 Content-Length 不当作零字节。

下载的 HST FITS 已登记为用户资产并关联输出 Connector，通过管理 API 提交
真实本地 Warehouse 扫描：**1 文件、4 coverage documents**，扫描 succeeded，
MOC ready，源 `availableOrders=[10]`、`maxOrder=10`、`precision=estimated`。
独立解码生成的 FITS MOC：4 个 NUNIQ cells 均为真实 order 10。
私有来源反查返回 **1 个真实直接父目录**，order 10，`directoriesTruncated=false`；
父目录与已下载文件的直接父路径一致，响应没有 Assets 公开结果。该用户资产可在
Workspace「用户资产」中找到 `MVP phase2 HST local download`，不属于 Assets 发布。

Euclid Q1 Tile 102157301 已解析真实 NISP-J BGSUB URI和大小 **1,474,565,760 bytes**，
超过 512 MiB 单文件上限，未开始科学传输。保留候选身份和限制；没有提高限制、
制造小文件或宣称四巡天下载都通过。ERO C01 `[190]` 的 target 映射缺口仍保留：
M78 的估计 footprint 在 `[1429]`，其余七 target 缺可靠 footprint 关联。

## 修复与检查范围

- 冻结快照可能保留图层的原始排列顺序；预览比较相同成员而不是数组排列。
  不同图层、重复成员、不同像元、过期快照和版本变化仍拒绝。回归先红后绿。
- 本地 ScanPlan 的 `source.location` 只包含 `rootPath`；PVC `subPath` 属于
  `scanner.sourceVolume`，其挂载位置与 plan 根一致。修复已由真实扫描验证。
- 旧 scanner 对 Operator 输出的 `includePattern` 字段报错；部署配置改为配套
  发布 digest。Helm 允许相同挂载基准，仍拒绝不相关或仅字符串前缀相似的路径。
- revision 66 完整测试基线为 **338 tests：336 pass、2 skipped、0 failed**；
  Helm lint/template 与挂载正负检查通过。原生选择 UI 更新后 server/viewer/CLI
  build、本地及 revision 67 线上 Playwright 各 **4/4** 通过；两仓库 `git diff --check` 通过。
- revision 67 发布后再次比较全部资产/任务的身份摘要、资源包安装版本和活动选择：
  2 个资产、5 个任务、28 个包及 6 个安装均保留，活动生产任务为 0；scanner digest
  和相同挂载基准仍与成功本地扫描时一致。Assets 状态 HTTP 200，公开发布与活动
  native group/generation 未变化。
- 保留所有原有暂存/未暂存修改，没有整体暂存、提交、重置或清理数据。

临时汇总证据：`/tmp/workspace-phase2-mixed-desktop.log`、
`/tmp/workspace-phase2-hst-completion.log`、`/tmp/workspace-phase2-local-scan.log`、
`/tmp/workspace-phase2-preview-desktop.log`、`/tmp/workspace-phase2-preview-bulk100.log`、
`/tmp/workspace-phase2-native-selection-build.log`、
`/tmp/workspace-phase2-native-selection-deployed-e2e.log`、
`/tmp/workspace-phase2-native-selection-helm.log`、`/tmp/workspace-phase2-mvp-release-tests.log`。
真实公开/私有反查正文与导出只在内存中
核对，文档不保存 CSST 身份、目录或像元。
