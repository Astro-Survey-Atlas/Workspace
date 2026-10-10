# Workspace Dev：覆盖修复与天空点补建验证

验收日期：2026-10-10。进度快照：13:44:45（Asia/Shanghai）。

CSST 原 Warehouse 扫描已成功：356,112 个文件、7,167,326 条覆盖记录，
零错误，原生 O10。此前页面失败来自 Workspace 把 4,287,359,816-byte
normalized evidence 整体读成 Node Buffer，触发 2 GiB 限制；该报错不是
科学 FITS 文件大小限制。此前 0 objects 还混用了目录对象和影像位置统计。

修复从既有证据流式补建 MOC；历史文件的坐标补建使用原成功扫描的有限清单，
8 路普通 worker 仅读 FITS header，跳过像素数组，无需 Flink。没有提交新的
CSST/HST 覆盖扫描或重新枚举其源目录。新扫描同时保留 header 证据，后续坐标
可直接消费。影像中心、指向和科学目录对象分别统计，影像中心不代表检测出的恒星。

## 已验证结果

| 项目 | 实测结果 |
| --- | --- |
| CSST MOC | `derived-7c11ab92d14b4549a4cd056e` 成功；实际解码 O10，32,250 个 MOC 单元，18,525 个 O8 查询像元，372 个 O4 概览像元，precision=estimated |
| MOC 制品 | FITS、查询投影、概览、统计、provenance 五个文件大小和哈希通过 |
| CSST header 样本 | 64 文件、64 真实影像中心、零错误；7.74 秒、1,105,920 源数据字节、384 次 Range；样本没有写入正式索引 |
| CSST 全量 header 任务 | 原 Job `derived-fb2c156981584665bfc38dbc` 持续运行，已读取 97,300 / 356,112 文件，194,600 条 header，零错误 |
| CSST 索引恢复 | `derived-54cf71e7a197406f8fb82663` 持续运行，已索引 37,356 个影像中心，零坐标错误；复用原 Job 和输出，无新增源读取任务 |
| CSST 区域查询 | 同一有限天区从 98 增加到 531 个匹配影像中心；请求同时限制私有资产、入口 region、当前 bbox，返回 `indexing:true` |
| HST | 一个 `j8ba9ordq_raw.fits` 产生两个真实科学 HDU 中心（HDU 1、4），补建成功 |

全量 CSST 回填**尚未完成**。header Job 先生成证据，索引消费另有进度；
不能把已读 header 文件数称为已索引点数。header 输出已超过 2 GiB，流程继续正常，
索引仍按有界批次消费。瞬时 ES 超时、连接失败和 429/502/503/504 保持 running，
使用持久退避与稳定 ID 重试，整批成功后才更新计数与偏移。原超时失败任务保留。

Aladin 继承外部所选具体图层及冻结入口区域；内部 checkbox 缩小该集合。
所有点请求在真实视野建立后才发出，并同时包含 region、bbox 和显式 scope。
未下载扫描的公开覆盖不生成点；空选择不查询全局。回填期间每 10 秒刷新当前
视野，保留既有点，退出或清空选择后停止。HST 实机浏览器验证两个点可见、
2/2 计数、源文件及科学 HDU 详情；没有页面异常。原首 WCS 覆盖不因此被宣称
为完整两芯片几何。

## 部署与回归

Dev：`http://astro.workspace.dev.72602.space:32080`，release `asa`，
namespace `asa-workspace`，Helm revision **83**。镜像
`0.10.38-dev-20261010-header-repair-r6`，digest
`sha256:c94482ac1e9323de8586307f58c401a0b6081a5fa04c42070ab214acd10e26a0`。
Pod 1/1 Ready、零重启，health HTTP 200。最终状态说明修复基于已验证的不可变
r5 镜像，仅替换编译后的状态模块；其运行时 SHA-256 与本地 verify 构建一致。

`npm run verify` 通过：365 项，363 通过、2 跳过，类型、服务/前端/CLI 构建、
严格 Helm 检查通过。四项 Aladin 浏览器回归通过：冻结选择、Escape、当前视野
查询、回填期间不移动视野也刷新并在清空选择后停止。测试后公开资源包激活集合
恢复到测试前。HST 七项真实 HTTP scope/detail 验证通过。Warehouse 的完整静态
及 Assets/Workspace 本地与远程调用验证已通过，之后没有 Warehouse 代码变更。

原 CSST/HST ScanRequest spec 和 status 精确比较不变；原 CSST MOC 失败元数据
精确比较不变。历史失败保留在运行记录，ready 状态不再回显已修复的历史错误，
当前索引诊断仍保留。Workspace 1 GiB/CPU 1；本地 ES request 1 GiB、limit 2 GiB、
heap 512 MiB/CPU 1；scanner 版本不变。未更改 Assets 公开数据、发布或私有边界。

日志：`/tmp/workspace-verify-header-r6.log`、
`/tmp/workspace-aladin-final-r5-e2e.log`；截图：
`/tmp/workspace-live-header-ui/hst-aladin.png`、
`/tmp/workspace-live-header-ui/hst-inspector.png`。
私有机器验收记录：`/tmp/workspace-header-repair-final-receipt.json`。
后续使用 `GET /api/derived-repairs` 或资产 operational status 取得最新回填进度，
不要提交另一轮覆盖扫描。
