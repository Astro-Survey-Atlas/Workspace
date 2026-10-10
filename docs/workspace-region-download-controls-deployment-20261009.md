# Workspace 重合区域与下载预览

日期：2026-10-09（Asia/Shanghai）。

## 修改

- G 模式右侧面板增加横向重合区域列表。切换区域会更新球面高亮、来源和反查；反查来源身份优先合并真实响应，缺失身份时显示来源 ID。
- 下载预览的滚动条沿用 Workspace 的悬停、聚焦和滚动反馈样式。
- 文件先按巡天、DR 和产品完整分组。巡天与产品组都能批量勾选，文件仍可单独调整；组状态显示已选数量和部分选中状态。超出每任务 128 个文件时保留当前选择并说明原因。
- 预览增加可选结构化 `notices`，说明库存不完整、覆盖边界为估算、文件元数据未核实和结果截断。原始来源说明收在“清单范围与匹配依据”中。

## 构建与部署

- `npm run build` 通过，包含 server、viewer 和 CLI 类型检查与构建。测试未运行。
- Helm dry-run 对比前后均为 15 个资源，没有新增、删除或非镜像字段变化；只更新 Workspace Deployment 镜像。
- Dev Helm release `asa` / namespace `asa-workspace` 更新至 revision **75**，镜像 `0.10.38-dev-20261009-120008-region-download-controls`。
- Kubernetes runtime image digest：`sha256:7778f3a3bacf824e65d30a3f1070d41b98f72acbb19562b4d4286b5d12aa167d`。
- Workspace Deployment 1/1 Ready，`/healthz` HTTP 200；新 JS/CSS HTTP 200。容器内 server JS、viewer JS/CSS 与本地构建文件的 SHA-256 一致。
- Elasticsearch 1/1 Ready，重启数为 0；现有 PVC 仍 Bound。
- Dev 页面：http://astro.workspace.dev.72602.space:32080/ 。

私有部署回执位于 `/home/aaron/.local/share/astro-workspace-deployments/dev/20261009T120008Z-region-download-controls/`。
