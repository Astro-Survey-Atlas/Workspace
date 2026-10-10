# Workspace G 模式来源与原生分块展示验收

日期：2026-10-08，Asia/Shanghai。范围为数据覆盖 tab 的 G 模式右栏。

## 展示变化

总览和重合区块详情共用独立的全宽来源区，按巡天、发布／DR、产品标签展开。
巡天名称、发布标签和颜色来自现有 registry，Workspace 来源标注“本地”。
缺少身份时保留原始来源标签，显示“未标注巡天／未标注发布”，不从描述推断 DR。
区块详情仅列出参与该区块的来源；续页保留初始来源标签，避免被身份回显覆盖。
相同来源 ID 去重，同名但不同身份的来源保留。

原生分块标题改为 11 px，来源、真实 order、精度和访问项为 10 px，统一字体、
间距、颜色和边线。本地目录和折叠的来源依据使用同一组样式；样式限定于
G 模式右栏，通用 inspector 渲染清理上一个视图的样式类。

有文件名的 HTTP(S) 地址只显示一个文件名链接，移除重复的 URL 正文。长名称
默认单行省略，鼠标悬停或键盘聚焦可看到完整名称；Escape 先关闭全名提示。
没有文件名时显示“访问来源”和域名；非 HTTP 定位符保持可聚焦的文本。
提示使用单个委托组件，流式更新移除原记录时同步关闭，避免保留失效节点。

没有修改 API、查询、存储或分页边界。原生 ID、实际 URI、order、精度、访问
限制和目录采样说明继续保留，JSON／CSV 导出包含完整地址和完整元数据。

## 验证

新增独立合成 Playwright 用例，全部拦截 API，不安装资源包或提交真实任务。
首次回归复现来源没有结构化分组；修复后覆盖多巡天／多发布／多产品、同名
不同来源、本地 CSST、缺少身份、文件链接、全名提示、续页、流式进度、空结果、
错误、JSON／CSV 导出和离开 G 模式的样式清理。

`npm run build:viewer` 的类型检查和构建通过，只有既有大 bundle 提示。本地及
部署后的同组 Playwright 均 **23/23 通过**：7 项新覆盖用例、15 项文件预览／
历史记录用例，以及现有数据生产只读检查。四组布局覆盖 light/dark ×1440/1024 px，
验证标题 11 px、元信息 10 px、单行省略、提示不超出视口以及页面无横向溢出。
截图均来自合成数据。

真实目录另做四组只读验收：17 个来源对应 3 个巡天、5 个发布，其中 1 个本地
来源；总览和区块详情的来源 ID 与服务端参与集合一致。实际区块返回 46 条公开
原生分块和 4 条本地目录，四组均通过字号、键盘全名提示和页面宽度检查。
验收只允许 GET 和空间 overlap／reverse-lookup 元数据请求，没有提交下载、
扫描或资源包激活操作。真实响应仅在内存中使用，回执仅保存汇总，未截图或
保存实际路径、身份、cells、查询响应或日志正文。

## Dev 发布

入口：http://astro.workspace.dev.72602.space:32080/ 。
Helm `asa` / namespace `asa-workspace` revision **72**，状态 deployed。
镜像：`0.10.38-dev-20261008-070504-coverage-inspector`。
发布 digest：
`sha256:a56c805ab21f351cf6c67688fc68ce7ee3016b409868c09b629a3545fbf49a23`。

镜像固定 revision 71 的 digest，仅替换 viewer 产物。已安装 chart 的 15 个资源
与发布前 manifest 一致；新渲染的唯一变化为 Workspace Deployment 镜像。
chart lint、server dry-run、Helm upgrade 均通过。容器内 14 个前端文件以及线上
首页、JS、CSS 的 SHA-256 与构建产物一致。

Workspace 1/1 Ready、重启 0 次，`/healthz` HTTP 200。部署前后的 5 条生产任务、
2 条资产、28 个资源包及安装／活动选择、3 条旧下载和 12 条连接器执行记录
逐项 SHA-256 一致；全部 PVC 与 Elasticsearch 的 UID、spec 保留。
原有脏工作树保留，未提交或暂存。

回执：
`/home/aaron/.local/share/astro-workspace-deployments/dev/20261008T064402Z-coverage-inspector/`。
