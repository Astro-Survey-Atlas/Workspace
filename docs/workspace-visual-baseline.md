# Workspace 视觉改造基线

记录时间：2026-09-04（改造前）

本基线使用现有 `viewer/index.html`、`viewer/src/styles.css` 和构建后的 Viewer，在可用的 `ASTRO_E2E_API=http://astro.workspace.dev.72602.space:32080` 下记录。截图暂存于 `/tmp/asa-workspace-baseline-*`，不作为仓库资产提交。

## 运行与布局基线

| 主题 | 视口 | 模式 | 工作台布局 | 根溢出 | 观察 |
| --- | --- | --- | --- | --- | --- |
| dark/light | 1440x900 | 六模式 | 顶栏 58px；Controls 272px；Stage 848px；Inspector 320px；底栏 28px | 无（1440 / 1440，900 / 900） | 六个模式均可切换，Stage 与 Inspector 均落在预期列 |
| dark/light | 390x844 | 六模式 | 顶栏 96px；单列 Stage 390x720（y=96）；Controls/Inspector 默认隐藏 | 无（390 / 390，844 / 844） | 现有移动抽屉保持隐藏，模式导航位于第二行 |

桌面初始模式由运行时配置决定；基线脚本随后逐一点击 `button[data-mode]`，确认 `packages`、`connectors`、`catalog`、`layers`、`workflow`、`system` 都能激活。页面级根节点没有横向溢出，但内容滚动区域会自然超过视口：公开资源列表、用户资产 Inspector、移动端 Connector 列表和 Production DAG 均依靠所属区域滚动。

## 状态与交互观察

- 所有六个主 Stage 都有稳定的 empty 节点；远端数据可用时列表填充，筛选无结果时显示对应空态。
- Catalog 行选择会刷新 Inspector；移动端选择后打开 `.inspector-panel.mobile-open`。
- Controls 使用 `.controls-panel.mobile-open` 抽屉；弹窗使用原生 `<dialog>`，关闭按钮和 Escape 路径存在。
- 主题由 `astro-workspace:theme:v1` 持久化，`html[data-theme]` 与顶栏切换按钮同步。
- 已观察到的既有环境/实现信号：本地未配置 Assets catalog 时会显示 catalog unavailable；未提供 Agent API 时 `/api/agent/workspace-sessions` 返回 404；全局 Lucide 重复 hydration 会输出 icon registry warning。这些不属于本次视觉改造的业务范围，施工和最终验收使用可用 E2E API，并单独记录环境限制。
- `scene-canvas` 也带有 `data-mode="layers"`；基线和后续浏览器检查必须限定为 `button[data-mode]`，避免定位歧义。

## 六模式状态覆盖

下表记录改造前 DOM/运行时已有的状态承载位置；基线采集不执行会写入远端数据的安装、扫描、生产和配置操作，因此“失败”项以现有状态属性、空态和错误通知钩子确认，施工后再用浏览器检查逐项触发可逆的展示路径。

| 模式 | loading | empty | selected | disabled | failed |
| --- | --- | --- | --- | --- | --- |
| packages | `#loading-indicator`、下载进度条 | `#resource-package-empty` | 资源行/Inspector | `#resource-package-apply`、未覆盖选择 | 资源状态 `failed`、Workspace notification |
| connectors | `#loading-indicator`、检测/扫描按钮 busy | `#connector-empty`、`#connector-history-empty` | Connector row、history row、Inspector | 历史视图筛选、停用 Connector 操作 | `connector-run-status[data-status="failed"]`、错误通知 |
| catalog | `#loading-indicator`、本地扫描 fieldset | `#catalog-empty`、Inspector empty | `.catalog-row.selected`、详情编辑 section | 缺少 Connector 时的登记控件、只读输入 | 扫描/登记/删除错误通知 |
| layers | `#loading-indicator`、Canvas 初始化 | 无覆盖/无选择 HUD 与 Inspector empty | 选区、图层 visibility、Inspector | 无选区时的下载/钻取操作 | Coverage query/下载错误通知、failed layer state |
| workflow | `#loading-indicator`、pipeline progress | `#production-template-empty`、`#production-run-empty`、`#production-dag-empty` | template/run/node active | `#workflow-gate`、未满足输入的执行按钮 | `#workflow-status-badge`、step/run failed 状态 |
| system | `#loading-indicator`、test action busy | `#ai-provider-list`、`#mcp-server-list` empty | settings tab、record | 未选中/未配置时的测试与保存条件 | record last-check failed 状态、错误通知 |

## 显示与可见性契约

主模式值：`catalog`、`connectors`、`layers`、`packages`、`system`、`workflow`。

Controls hooks：`#controls-panel`、`#catalog-controls`、`#resource-package-controls`、`#connector-controls`、`#layer-controls`、`#workflow-controls`、`#system-controls`。

Stage hooks：`#catalog-stage`、`#resource-package-stage`、`#connector-stage`、`#scene-stage`、`#workflow-stage`、`#production-stage`、`#system-stage`。

Inspector/overlay hooks：`#inspector-panel`、`#inspector-empty`、`#inspector-content`、`#coverage-hover`、`#coverage-context-menu`、`#loading-indicator`、`#workspace-notification-deck`、`#agent-panel`。

主题/模式属性：`html[data-theme="dark|light"]`、主导航 `button[data-mode]`；Coverage Canvas 保留自身 `data-mode="layers"` 作为调试属性。

## 完整 DOM id 清单（改造前）

共 299 个 `id`，按 DOM 文档的字母序记录如下。改造只能新增明确的语义钩子，不能删除、重命名或改变现有事件依赖。

```text
agent-collapse
agent-collapsed-attach
agent-collapsed-form
agent-collapsed-input
agent-confirmation
agent-messages
agent-new-session
agent-open
agent-panel
agent-session-select
ai-provider-cancel
ai-provider-default
ai-provider-dialog
ai-provider-dialog-close
ai-provider-form
ai-provider-key
ai-provider-list
ai-provider-model
ai-provider-name
ai-provider-new
ai-provider-test
ai-provider-url
aladin-asset-drawer-toggle
aladin-asset-nav
aladin-cache-state
aladin-cockpit-rail
aladin-controls
aladin-explorer
aladin-fullscreen
aladin-loaded-summary
camera-distance
catalog-asset-list
catalog-connector-list
catalog-controls
catalog-count
catalog-create-dialog
catalog-dec-column
catalog-description
catalog-dialog-close
catalog-empty
catalog-form-cancel
catalog-form-submit
catalog-form-title
catalog-inspect-file
catalog-kind
catalog-kind-filter
catalog-name
catalog-new
catalog-new-connector
catalog-new-survey
catalog-object-id-column
catalog-project-filter
catalog-ra-column
catalog-ready-count
catalog-registration-form
catalog-release
catalog-scan-fieldset
catalog-search
catalog-source-file
catalog-stage
catalog-survey
catalog-user-count
connector-check-form
connector-config-jdbc
connector-config-local
connector-config-s3
connector-controls
connector-count
connector-create-dialog
connector-description
connector-detail
connector-dialog-close
connector-draft-count
connector-empty
connector-filter-count
connector-form-cancel
connector-form-submit
connector-form-title
connector-history-empty
connector-history-list
connector-history-search
connector-history-tab
connector-history-view
connector-jdbc-database
connector-jdbc-schema
connector-jdbc-url
connector-kind
connector-kind-filter
connector-list
connector-list-search
connector-list-tab
connector-list-view
connector-local-root
connector-name
connector-new
connector-ready-count
connector-registration-form
connector-release
connector-run-filter-count
connector-run-kind-filter
connector-run-search
connector-run-status-filter
connector-s3-bucket
connector-s3-endpoint
connector-s3-prefix
connector-s3-region
connector-search
connector-stage
connector-status-filter
connector-survey
connector-survey-filter
context-summary
controls-panel
controls-toggle
coverage-build-crossmatch
coverage-build-download
coverage-context-menu
coverage-enter-flat
coverage-hover
dataset-name
dataset-state
drill-back-button
inspector-content
inspector-empty
inspector-kicker
inspector-panel
inspector-view
layer-controls
layer-selection-count
layer-visible-output
legend-max
legend-min
loading-indicator
mcp-server-cancel
mcp-server-dialog
mcp-server-dialog-close
mcp-server-form
mcp-server-list
mcp-server-name
mcp-server-new
mcp-server-test
mcp-server-token
mcp-server-transport
mcp-server-url
metric-five
metric-five-label
metric-four
metric-four-label
metric-grid
metric-one
metric-one-label
metric-three
metric-three-label
metric-two
metric-two-label
object-status
panel-dataset-name
panel-kicker
pipeline-heading
pipeline-progress
production-action-copy
production-dag-count
production-dag-empty
production-dag-heading
production-dag-list
production-log-detail
production-log-heading
production-run-count
production-run-dialog
production-run-dialog-close
production-run-dialog-content
production-run-dialog-dismiss
production-run-dialog-kicker
production-run-dialog-title
production-run-empty
production-run-list
production-stage
production-status-badge
production-template-count
production-template-empty
production-template-list
region-scene-legend
remote-coverage-catalog-fields
remote-coverage-connector
remote-coverage-coordinate-units
remote-coverage-dec-column
remote-coverage-dialog
remote-coverage-dialog-close
remote-coverage-form
remote-coverage-form-cancel
remote-coverage-form-submit
remote-coverage-healpix-column
remote-coverage-healpix-fields
remote-coverage-healpix-order
remote-coverage-mode
remote-coverage-mode-note
remote-coverage-path
remote-coverage-product
remote-coverage-ra-column
remote-coverage-release
remote-coverage-survey
render-status
reset-button
resource-catalog-admin-token
resource-catalog-settings-cancel
resource-catalog-settings-close
resource-catalog-settings-dialog
resource-catalog-settings-form
resource-catalog-settings-save
resource-catalog-settings-sync
resource-catalog-url
resource-package-active-count
resource-package-apply
resource-package-controls
resource-package-count
resource-package-empty
resource-package-filter-clear
resource-package-filter-summary
resource-package-filters
resource-package-installed-count
resource-package-list
resource-package-search
resource-package-selected-count
resource-package-settings
resource-package-stage
resource-package-sync
results-heading
scene-background-close
scene-background-color
scene-background-color-controls
scene-background-popover
scene-background-reset
scene-background-settings
scene-background-title
scene-badge
scene-camera-readout
scene-canvas
scene-coordinate-readout
scene-frame-label
scene-image-survey-controls
scene-legend
scene-mode-label
scene-mode-value
scene-stage
service-status
settings-ai-view
settings-mcp-view
sky-layer-list
survey-registration-cancel
survey-registration-close
survey-registration-description
survey-registration-dialog
survey-registration-form
survey-registration-modalities
survey-registration-product-description
system-connected-count
system-controls
system-mcp-count
system-provider-count
system-sidebar-connected-count
system-sidebar-mcp-count
system-sidebar-provider-count
system-sidebar-state
system-stage
system-status-badge
theme-toggle
workflow-accept-all
workflow-adjust-region
workflow-apply-filter
workflow-controls
workflow-create-dialog
workflow-dec
workflow-dialog-close
workflow-download
workflow-filter-controls
workflow-filter-field
workflow-filter-op
workflow-filter-value
workflow-form
workflow-gate
workflow-gate-message
workflow-gate-title
workflow-limit
workflow-match-radius
workflow-new
workflow-open-layers
workflow-preview-count
workflow-query-radius
workflow-ra
workflow-region-controls
workflow-result-empty
workflow-result-table
workflow-retry
workflow-select
workflow-stage
workflow-stage-title
workflow-status-badge
workflow-steps
workspace-notification-deck
```

## 基线结论

桌面三列网格和移动单列/抽屉机制可作为改造起点；主要视觉问题是青色/深黑主题与 Assets ASA 系统不一致、列表和详情仍以局部卡片/硬编码颜色组织、深色品牌 mark 对比度不足。移动端不做专项视觉重排，但 Production DAG 的内容边界和所有弹窗仍需作为兼容性回归项。

## 改造后验收

记录时间：2026-09-04。视觉施工完成后，以同一套 E2E API 和 Vite preview 重新采集截图；截图索引和改动说明见 [`assets-style-workspace-redesign.md`](assets-style-workspace-redesign.md#implementation-handoff)。

复查时间：2026-09-07（workspace cleanup）。2026-09-04 的视觉验收在 cleanup（drill 主题重绘、Production run 显式选中态、Logo 首帧主题源、CSS 级联收敛、删除无消费者 class toggle）之后按同一矩阵全量复验通过；截图随仓库提交，忽略规则 `docs/screenshots/*` 已移除。

| 主题 | 视口 | 覆盖范围 | 结果 |
| --- | --- | --- | --- |
| dark / light | 1440x900 | 六个 `button[data-mode]`：packages、connectors、catalog、layers、workflow、system | 每个模式均能激活；三列 shell、左右侧栏、Stage、Inspector 和状态/列表区域保持稳定 |
| dark / light | 390x844 | catalog detail、layers Coverage、catalog registration dialog | 根节点宽度等于视口，无横向溢出；弹窗边界在安全区内，移动抽屉入口可达 |

最终截图位于 `docs/screenshots/workspace/`，文件名以 `<theme>-<viewport>-<state>.png` 命名，均为浏览器视口原尺寸。最终门禁：`npm run build:viewer`、`npm run build`、`npm test` 和可用的 Playwright 浏览器检查均通过；仅保留既有 Vite 大 chunk 提示及环境级 Agent API 404 / Lucide registry warning 记录。
