# Workspace 视觉改造后续清理计划

记录时间：2026-09-07  
审查基点：`fb20613`  当前 HEAD：`ab0df8c`  
状态：计划已确认，代码清理尚未施工。

## 1. 目标与边界

本计划处理 Workspace 视觉改造完成后的真实缺口、级联冗余和验收文档漂移，使后续维护有单一的样式权威和可重复的验收路径。

必须保持不变：

- API、数据 schema、数据语义和服务端行为。
- 六个工作模式及其 `data-mode` 值：`packages`、`connectors`、`catalog`、`layers`、`workflow`、`system`。
- 现有 DOM id、事件监听、ARIA 契约、localStorage key 和 Coverage Canvas 交互。
- Connector 历史视图中筛选器的禁用语义；创建在中栏，检测/扫描/编辑/删除在右栏，运行状态在扫描记录查看。
- 现有部署配置：`.codex/cafe.config.toml`、`Dockerfile`、`deploy/k3s.yaml`。

不在本轮范围：业务流程重设计、接口重命名、删除兼容静态资源、营销式 Hero、覆盖画布改成装饰图片，以及与本清理无关的服务端重构。

显式豁免：Connector 扫描记录列表同样存在“自动选中首条记录并显示 `.selected`”的模式（`viewer/src/connector-panel.ts:105、233、249、443`），本轮保持不变——右栏详情依赖选中上下文；若后续要把“未点击不显示选中态”约定统一应用到 Connector，另立一轮单独处理并补充对应测试。

## 2. 当前结论

ASA 视觉方向已经落地：中性灰底、ASA 靛蓝/洋红、Atlas 字体、细线分区、密集工具型布局和双主题切换均已存在。当前问题主要是实现收尾，而不是重新设计：

| 优先级 | 项目 | 当前证据 | 影响 |
| --- | --- | --- | --- |
| P0 | Drill cells 主题切换后颜色可能过期 | `viewer/src/survey-layer-viewer.ts` 的 `setDrillCells()` 把颜色烘焙进 geometry；`setTheme()` 仅在 overlap 模式重建 | 切换主题后 Coverage G/钻取层可能继续显示旧主题颜色 |
| P0 | Production 首条 run 被伪装成用户选中 | `viewer/src/production-panel.ts` 的 `selectPipeline()` 自动设置首条 `selectedRun`；`renderLogs()` 据此加 `.active` | 用户未点击记录时出现选中边框，和“未点击不显示选中态”的交互约定冲突 |
| P1 | Logo 有三套主题来源且 accessible name 不完整 | `viewer/index.html` 初始 `src/alt`、`styles.css` 的 `content:url()`、`main.ts` 的 `applyThemeLogo()` 同时控制 | 主题来源可能互相覆盖；读屏品牌名丢失 Workspace 语义；删除 CSS 覆盖后若内联启动脚本不同步，深色用户首帧会闪浅色 logo |
| P1 | `styles.css` 末尾存在大段重复覆盖 | 约 7,500 行；`Atlas control-room layer` 之后再次覆盖早期规则，重复涉及 catalog、mode、context menu、production run、agent form 和 light theme | 修改需要追级联，容易引入主题回归；样式权威不清晰 |
| P1 | 无消费者的模式状态 class 和 token | `main.ts` 的 `workflow-active`、`system-active`、`catalog-active`、`connector-active` 未发现 CSS/JS 消费；`--ui-accent` 等 token 未发现有效消费者 | 增加认知负担，误导后续维护者 |
| P1 | 验收文档和截图索引漂移 | 现有文档仍写 2026-09-04；`docs/screenshots/*` 被 `.gitignore` 忽略；部分移动截图仍是旧品牌 | 干净 checkout 无法复现交付物，文档不能作为当前状态证据 |
| P2 | 回归测试缺少上述行为断言 | 现有 E2E 覆盖主题和 Production 基本路径，但没有明确断言“初始无 active、点击后 active”、Logo accessible name、drill 主题重绘 | 未来 CSS/状态清理容易再次回归 |

P0 项必须先修复并通过定向测试；P1 项完成后再更新截图和文档；P2 项作为同一提交序列的验收补强，不单独延后。

## 3. 清理清单

### 3.1 Coverage 主题重绘

位置：`viewer/src/survey-layer-viewer.ts`，`setTheme()`、`setDrillCells()`。

实施要求：

1. 保留 `#drillCells` 的数据模型和公共方法签名。
2. 将“根据当前主题生成 drill geometry/material”集中到一个私有重建路径，避免复制颜色计算。
3. `setTheme()` 在已有 drill 状态时重建或重染 drill mesh 和 edges；空 drill 状态不创建对象。
4. 保持选择、像素、层顺序、nside、标签和 `state` 输出不变。
5. Overlap 现有重建逻辑继续工作，不能因抽取公共路径改变其透明度或渲染顺序。

验收：先设置 drill cells，再切换 dark/light，检查 canvas 的主题数据和 geometry/material 颜色随主题改变；再清空 drill，确认没有残留对象。

### 3.2 Production run 显式选中态

位置：`viewer/src/production-panel.ts`，`selectPipeline()`、`syncSelectedRun()`、`renderLogs()`、提交/重试/取消路径。

目标状态模型：

- 切换 pipeline 或首次加载：可以展示首条 run 的详情作为上下文，但不把它标记为用户选中，不给对应 `.production-run-chip` 加 `.active`。
- 用户点击某条 run：设置显式选中记录，显示 `.active`，详情和 DAG 跟随该记录。
- 提交、重试、取消：操作成功后将新/变更记录设为显式选中。
- 轮询刷新：若已有显式选中记录，更新同一 id；若该记录消失，回到详情上下文但不凭空产生 active 样式。
- 无 run：保持空态，不创建伪选中项。

建议使用独立的显式选择标记或等价状态，而不是用 `selectedRun !== null` 同时表达“详情上下文”和“用户点击”。不能改变 API 返回结构。

验收：Production 初始加载和切换 pipeline 时所有 run chip 均无 `.active`；点击、提交、重试、取消后仅目标记录有 `.active`；轮询不丢失已点击记录。

### 3.3 Logo 与品牌可访问性

位置：`viewer/index.html`、`viewer/src/main.ts`、`viewer/src/styles.css`。

实施要求：

1. 以 `applyThemeLogo()` 作为唯一运行时主题来源，保留现有 `data-theme-logo` 更新和主题切换行为。
2. 删除 CSS `content:url(...)` 对图片源的覆盖；CSS 只负责尺寸、布局和可见样式。
3. `index.html` 的内联启动脚本目前只设置 `data-theme` 和 theme-color meta，不更新 logo；静态 `src` 只能匹配一个主题，而 `main.ts` 是 module 脚本，晚于首次绘制。因此删除 CSS `content:url()` 的同时，必须扩展同一内联脚本在首次绘制前同步设置 `.brand-logo` 的 `src` 和 `data-theme-logo`，否则深色用户刷新会闪一帧浅色 logo。启动脚本和运行时继续使用同一个 localStorage/system 主题判定。
4. 恢复完整 accessible brand name，例如 `alt="Astro Survey Atlas Workspace"`；可见文案继续为 `Astro Survey Atlas`，副标题为 `公共天空数据 · 工作区`。
5. 保持 light/dark 两个现有 asset 路径。重复 SVG 资源暂不删除，因为旧路径可能被外部静态 URL 使用。

验收：两主题检查 `src`、`data-theme-logo`、`alt` 和可见品牌文案；dark/light 刷新时首次绘制即显示正确主题资源，不得闪现另一主题 logo 或空 alt。

### 3.4 CSS 级联收敛

位置：`viewer/src/styles.css`。

处理顺序：

1. 先按组件建立 canonical 规则：shell/topbar、mode tabs、controls、catalog/connectors、coverage、production、system、agent、responsive。
2. 把末尾 `Atlas control-room layer` 中仍有效的规则并回对应组件；删除同一 selector 的重复覆盖。
3. 保留必要的主题差异、Canvas 专用颜色、科学巡天颜色、状态色和响应式规则；不以机械合并破坏视觉对比度。
4. 统一使用现有 ASA token：`--asa-indigo`、`--asa-magenta`、`--border`、`--line-strong`、`--surface`、`--stage` 等。
5. 删除确认无消费者的 `--ui-accent`、`--ui-accent-strong`、`--surface-alt`、`--magenta`；`--cyan` 实际是全局 UI 强调色（`.mode-button.active`、连接器 tabs、scene tools 等 30+ 处消费），必须保留，不得按科学巡天专用色处理。
6. 任何新增规则必须放入对应组件段落，不再继续追加无边界的末尾 override。

重点去重 selector：`.catalog-row`、`.mode-button.active`、`.coverage-context-menu`、`.production-run-chip`、`.agent-collapsed-form` 及多组 `html[data-theme="light"]` 规则。

验收：删除冗余后 `rg` 检查无误导性 token/class；双主题六模式截图与清理前基线比较，列表、弹窗、footer、Production run 和移动抽屉无布局变化。

### 3.5 无消费者逻辑与兼容项

可删除：`main.ts` 中仅写入、没有 CSS/JS 消费者的 `workflow-active`、`system-active`、`catalog-active`、`connector-active` class toggles。

必须保留：

- `#service-status`、`#render-status`、`#object-status` 等隐藏 legacy DOM 节点；它们仍被生产代码和 E2E 使用。
- 现有 DOM id、事件、主题 localStorage key 和截图/自动化定位钩子。
- 两组内容相同的 logo SVG；如未来要删除，必须先确认外部静态 URL 无依赖并提供兼容重定向。

## 4. 实施顺序

### 阶段 A：冻结基线

- 保存当前 `git status`、commit SHA 和 `git diff fb20613...HEAD --stat`。
- 记录 1440x900 与 390x844 双主题的六模式可达性、根节点溢出和关键状态。
- 不把临时截图当作仓库交付物；先确认最终截图的存储策略。

### 阶段 B：修复行为回归

- 完成 Coverage drill 主题重建。
- 完成 Production “详情上下文”和“显式用户选择”分离。
- 只增加与上述行为直接相关的 E2E 断言。

### 阶段 C：收敛样式与入口

- 统一 Logo 主题来源和 accessible name。
- 合并 CSS canonical 规则，删除无消费者 token/class。
- 运行 TypeScript 构建，确认没有被误删的选择器或 id。

### 阶段 D：文档、截图和交付

- 更新 `docs/assets-style-workspace-redesign.md` 与 `docs/workspace-visual-baseline.md` 的日期和当前验收说明。
- 取消 `docs/screenshots/*` 的忽略规则，并提交最新截图，或在无法提交二进制时明确改用外部 artifact 存储，不保留失效链接。
- 重新生成双主题截图：1440x900 六模式；390x844 的 catalog detail、coverage、registration dialog。
- 将本计划中的完成项改为带日期的事实记录，并保留失败/环境限制说明。

## 5. 验收门禁

### 自动化

```bash
npm run build:viewer
npm run build
npm test
npm run test:e2e
```

`npm run test:e2e` 仅在本地浏览器和 API fixture 可用时运行；若远端资源包 checksum 过期，记录具体资源和错误，不将环境失败归因于前端代码，也不要重复启动长时间命令。

### 浏览器矩阵

| 主题 | 视口 | 必查内容 |
| --- | --- | --- |
| dark/light | 1440x900 | 六个 `button[data-mode]` 可切换；shell 三列；footer/分区线；列表和 inspector 无重叠 |
| dark/light | 390x844 | catalog detail、coverage、registration dialog；无横向溢出；抽屉和弹窗可关闭 |
| dark/light | 任意 | Logo `src`/`alt`/`data-theme-logo`；theme localStorage；焦点环；禁用控件 |
| dark/light | 任意（layers 模式） | drill cells 切换主题后颜色更新；Coverage G/overlap 不退回黄色/绿色 |
| dark/light | 任意（workflow 模式） | 初始 run 无 active；点击后 active；提交/重试/取消后状态正确 |

### 交付前检查

- `git diff --check` 通过。
- `rg` 确认 API/schema、DOM id、事件名和 localStorage key 没有非计划变更。
- `git diff --stat` 只包含 Viewer、测试和本计划/验收文档；部署配置不应被视觉清理回退。
- 生成并检查双主题截图后，再构建镜像、部署开发环境、检查 rollout、`/healthz` 和开发地址 smoke。

## 6. 回滚与风险

- CSS 合并若造成视觉回归，按组件逐段回退，不回滚 API 或数据文件。
- Production 状态改动若影响详情加载，优先恢复“详情上下文”路径，再保留显式 active 的测试断言定位问题。
- Drill 重建必须避免重复创建 Three.js 对象；检查旧 geometry/material 是否被清理，防止 GPU 内存增长。
- 截图提交策略变化不得删除用户或外部依赖的 logo 资源。

## 7. 完成定义

只有同时满足以下条件才可把本计划标记为完成：行为回归已修复；CSS 无已确认的重复权威和无消费者 token/class；Logo 双主题和 accessible name 通过；自动化与可用浏览器门禁通过；最新双主题截图可从干净 checkout 取得；文档日期、限制和部署地址与实际结果一致。

## 8. 完成记录（2026-09-07）

- 3.1（2026-09-07）：`survey-layer-viewer.ts` 的 drill 网格重建抽为 `#rebuildDrillCells()`，`setTheme()` 在存在 drill cell 时重建并重渲染；旧 mesh 通过 `clearGroup()` 的 disposeObject 释放，无 GPU 泄漏。
- 3.2（2026-09-07）：`production-panel.ts` 引入 `explicitSelectedRunId`；初始/切换 pipeline/轮询回退只作详情上下文，不加 `.active`；点击 run、提交、重试、取消设置为显式选中；选中记录消失时清除显式态。connector-panel 同类模式按计划边界保留（见 §1 豁免）。
- 3.3（2026-09-07）：`index.html` 末尾内联 boot 脚本在首帧前按 `data-theme` 设置 `.brand-logo` src 与 `data-theme-logo`；`main.ts` 的 `applyThemeLogo()` 保持唯一运行时来源；styles.css 删除两处 `content: url()`；img alt 与 E2E 断言更新为「Astro Survey Atlas Workspace」。
- 3.4（2026-09-07）：删除 8 行无消费者 token（`--ui-accent`、`--ui-accent-strong`、`--magenta` 双主题与 tail 两处 `--surface-alt`）；`--cyan`、`--asa-magenta`、`--focus-ring`、`--line-subtle` 按计划保留。无重复合并 10 条整规则删除、11 组选择器列表收缩；命名关键选择器（`.mode-button.active` 组、`.coverage-context-menu`、`.catalog-row`、`.production-run-chip` 含 light 主题透明边框陷阱）已按 tail 胜出折叠进 canonical 规则。styles.css 由 7525 行降至 7373 行，花括号 1277/1277 平衡；其余约 200 条 tail 规则按计划判定为有意覆盖层，保留。
- 3.5（2026-09-07）：删除 `main.ts` 写入 `.workspace-shell` 的 `workflow-active`/`system-active`/`catalog-active`/`connector-active` 四行；`rg` 确认全库无消费者。
- E2E（2026-09-07）：`data-catalog.spec.ts` 的 production 流程新增断言——初始 run chip 无 `.active`、点击后获得 `.active`、切换 pipeline 后重置。
- 门禁（2026-09-07）：`npm run build:viewer`、`npm run build` 通过；`npm test` 219 项中 218 通过、0 失败、1 跳过（环境性跳过，与本次改动无关）；`npm run test:e2e` 31 项中 30 通过，`survey-layers` 的 Aladin 返回断言在全量并行下偶发超时，单独重跑通过，判定为环境抖动而非回归。
- 阶段 D（2026-09-07）：`.gitignore` 移除 `docs/screenshots/*`；以 Vite preview + 同一 E2E API 全量重采 18 张双主题截图（1440x900 六模式 ×2、390x844 catalog detail/coverage/registration dialog ×2）；`assets-style-workspace-redesign.md` 与 `workspace-visual-baseline.md` 追加 2026-09-07 复查记录。截图入库依赖下一次提交。
