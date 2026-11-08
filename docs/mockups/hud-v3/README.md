# Workspace · v3 tactical HUD 设计稿

静态设计稿，用于确认 Workspace 前端重构的视觉方向。**未接入真实数据**，
页面里的数字与名称都是占位示例。

视觉语言与 Assets 已批准的 v3 稿一致：同一套颜色 token（靛蓝 `#2c3792` /
品红 `#f01951`）、字号、板面结构、方括号制式导航与 HUD 读数。

## 查看

直接用浏览器打开 `index.html`，或起一个静态服务器：

```sh
python3 -m http.server 5190   # 在 docs/mockups/hud-v3 目录下运行
# http://127.0.0.1:5190/index.html
```

主题：所有页面都接受 `?theme=dark|light`，缺省跟随系统。右上角 ◐/◑
按钮可在两者间切换。

## 页面

| 文件 | 内容 |
| --- | --- |
| `index.html` | 总览与入口 |
| `layers.html` | 数据覆盖 —— 三栏驾驶舱：图层 / 天球 + HUD 读数 / 选区检查器 |
| `catalog.html` | 用户资产 —— 分面筛选、资产表格、右侧资产详情 |
| `connectors.html` | 连接器 —— 列表 / 扫描记录 / 数据统计三个视图 |
| `packages.html` | 公开资源集 —— 覆盖质量与服务器状态，应用到天球 |
| `workflow.html` | 数据生产 —— 阶段条、执行步骤、结果预览、人工门 |
| `system.html` | 系统配置 —— AI Provider / MCP / 数据服务 / 下载 / 能力 / 备份 |

## 文件

- `shared.css` —— token 与全部组件样式（板面、行、标签、表格、HUD 读数）。
- `shared.js` —— 主题切换、logo、程序化绘制的天球 SVG。
- `shell.js` —— 顶栏、画面四角标记、图标。
- `icon_without_name_lon_web*.svg` —— logo 副本。字体直接引用 `viewer/public/fonts/`，
  不重复提交（许可证见那里的 `LICENSE.txt`）。

## 实现要点（确认后）

1. 新增 `viewer/src/hud-workspace.css`：先引 `@astro-survey-atlas/sky-globe/theme.css`
   的 token，再用别名层把现有 `--page` / `--panel` / `--border` 等变量接到
   `--hud-*`，最后覆盖壳层（顶栏、板面、方括号导航、表格、标签）。
2. 不改任何元素 id、`data-mode`、`data-*` 钩子与 `activateMode` 的显隐逻辑，
   只加类名。
3. 天球模式直接用包里的 HUD 叠加层；Aladin 侧车、密度标签、方向引导线按同一
   套语言重绘。
4. 其余模式先靠别名层跟上配色，逐个模式重排放在后续轮次。
