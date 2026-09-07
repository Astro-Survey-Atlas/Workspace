# Workspace ASA Visual Redesign

## Goal

Bring the Workspace viewer into the same visual system as Astro Survey Atlas Assets. The result should feel like one scientific control room: dense, quiet, line-led, easy to scan, and usable for repeated operations. This is a presentation redesign; preserve the existing data flow, API contracts, modes, and workflow semantics.

Use the current Assets public UI as the visual reference:

- `/home/aaron/Repo/Astro-Survey-Atlas-Assets/site/src/public.css`
- `/home/aaron/Repo/Astro-Survey-Atlas-Assets/site/src/styles.css`

## Execution Steps

### 1. Establish the baseline

Inspect `viewer/index.html`, `viewer/src/styles.css`, and the panel modules before editing. Render all six modes (`packages`, `connectors`, `catalog`, `layers`, `workflow`, `system`) at 1440x900 and 390x844. Record any existing overflow, missing empty state, or broken interaction so the redesign does not hide a regression.

Completion criterion: every mode has a known desktop and mobile baseline, and all existing element ids, `data-mode`, `data-theme`, and panel visibility hooks are listed before markup changes.

### 2. Apply the shared ASA visual tokens

Keep the existing theme toggle and local-storage behavior. Consolidate the visual values at the top of `viewer/src/styles.css` so all panels consume the same tokens.

Use this palette as the default mapping:

| Token | Dark | Light |
| --- | --- | --- |
| page/stage | `#030712` / `#070b0f` | `#eef0f2` / `#edf2f4` |
| surface | `#0b0f19` | `#f6f7f8` |
| raised surface | `#111827` | `#ffffff` |
| line | `#1e293b` | `#d8dee5` |
| strong line | `#334155` | `#b9c4ce` |
| text | `#f8fafc` | `#151a21` |
| muted text | `#94a3b8` | `#5f6670` |
| ASA indigo | `#6974d5` | `#2c3792` |
| ASA magenta | `#ff6b8d` | `#f01951` |
| success / warning / error | existing green / amber / coral semantics | same semantic hues with readable contrast |

Typography uses the bundled `Atlas Sans CJK` for UI copy and `Atlas Mono` for kickers, metrics, ids, timestamps, and status codes. Keep `letter-spacing: 0`; use weight and case for hierarchy. Use a 4px maximum radius for controls and row surfaces. Keep the existing 8/12/16/24 spacing rhythm.

Completion criterion: no page-level or component-level color hard-codes remain where a shared token can express the same role; both themes pass a contrast check for body text, labels, active controls, disabled controls, and status text.

### 3. Rework the application chrome

Keep the current three-column desktop shell and its mobile collapse, but make the hierarchy match Assets:

- Topbar: circuit-style ASA mark and `Workspace` wordmark on the left, mode navigation in the center, theme/control actions on the right.
- Mode navigation remains a segmented control, but active state is an indigo or magenta rule/fill with readable text; inactive tabs are quiet line text. Do not change the mode ids or navigation events.
- Sidebars and stage are separated by 1px rules, not floating cards. Use a small monospace kicker, a compact heading, and a thin rule for each section.
- Keep status/notification surfaces close to the edge of the relevant panel. They may be framed individually, but do not place cards inside cards.
- Use Lucide icons for tool actions. Icon-only controls need an accessible label and a tooltip; text commands may use icon plus text.

If the existing Workspace logo asset cannot provide a readable dark-mode mark, add a white circuit-line SVG variant and switch it through the existing theme mechanism. Keep the accessible image/brand name unchanged.

Completion criterion: the topbar, sidebars, stage, and inspector read as one connected grid at both breakpoints; no action or mode loses its existing keyboard or pointer behavior.

### 4. Normalize each mode without changing its semantics

Apply the same composition to every mode: section kicker, title/summary, search or filter row, column header, scrollable result list, and inspector/detail area.

- **Public resources (`packages`)**: present resource packages as dense rows with coverage state, install state, and selection state. Keep sync, settings, and apply actions in the toolbar.
- **Connectors**: keep list/history tabs, filters, create/edit dialog, probe, scan, and delete actions. Use clear status labels (`未检测`, `可用`, `异常`, `已停用`) with a colored rule or small swatch rather than large badges.
- **User assets (`catalog`)**: keep the asset list and registration/editor flow. Make search and add action a single aligned row; keep metadata and access details in the inspector.
- **Coverage (`layers`)**: keep the globe/canvas as the primary stage. Layer rows use visibility, drag handle, survey identity, and counts; panel overlays must remain readable over the scene in both themes.
- **Production (`workflow`)**: keep template selection, parameter editor, run list, progress, retry, cancel, and artifact actions. Use indigo for the active pipeline and magenta only for attention/error or the secondary connection path.
- **System (`system`)**: keep AI Provider and MCP Server tabs and their CRUD/test actions. Use the same settings-row layout and status summary as connectors.

Empty, loading, disabled, failed, and selected states must occupy stable space so lists do not jump. Keep long names, paths, URLs, and ids truncating or wrapping inside their owning column.

Completion criterion: each mode has one coherent list/detail composition, every existing command remains reachable, and all five state classes (loading, empty, selected, disabled, failed) are visibly distinguishable without relying on color alone.

### 5. Responsive and accessibility pass

Use the existing 1040px and 760px behavior as the starting point. On narrow screens:

- collapse controls and inspector into the existing mobile drawers;
- keep the topbar controls reachable without horizontal scrolling;
- let segmented mode navigation wrap or scroll within its own row;
- make tables become stacked rows with explicit labels rather than clipped columns;
- keep dialogs within the viewport with safe-area padding and internal scrolling.

Preserve `aria-label`, `role="tablist"`, `role="tabpanel"`, focus order, visible focus rings, and keyboard operation. Do not introduce hover-only information that has no focus/touch equivalent.

Completion criterion: at 390x844 there is no horizontal overflow, no text or control overlap, every interactive element is focusable, and the active drawer/dialog can be closed and operated with keyboard only.

### 6. Verify and hand off

Run the repository's viewer build and test gates after the visual changes. At minimum use `npm run build:viewer`, `npm run build`, and `npm test`; run `npm run test:e2e` when the local browser/API fixtures are available. Capture screenshots for all modes at 1440x900 and representative catalog, coverage, and dialog states at 390x844.

Completion criterion: build and tests pass, screenshots show the shared ASA visual language in both themes, and the diff contains no API/schema or unrelated server changes.

## Guardrails

- Keep the existing mode names, element ids, event listeners, API calls, local-storage keys, and domain terminology.
- Do not add a marketing hero, decorative gradient background, oversized illustration, or nested card hierarchy to the Workspace tool surface.
- Do not turn the coverage canvas into a decorative image; it remains an interactive scientific view.
- Prefer CSS and existing DOM hooks. If a markup hook is genuinely missing, add the smallest semantic element and preserve the surrounding accessibility contract.
- Keep animations limited to feedback already required by the interaction. Static line/dot treatments are preferred for the shared visual language.

## Acceptance Checklist

- [x] Desktop and mobile baselines captured before editing.
- [x] Shared dark/light tokens are used by all Workspace panels.
- [x] Topbar, mode tabs, sidebars, stage, and inspector match the Assets control-room style.
- [x] All six modes retain their current commands and data semantics.
- [x] Lists, forms, dialogs, status states, and notifications have stable, readable geometry.
- [x] Coverage canvas remains the primary interactive surface and is readable in both themes.
- [x] No horizontal overflow or overlapping text at 390x844.
- [x] Viewer build, full build, tests, and available browser checks pass.
- [x] Final screenshots and a short change summary are attached to the handoff.

## Implementation Handoff

验收时间：2026-09-04。施工范围限定为 Viewer presentation layer：`viewer/src/styles.css`、主题色同步（`viewer/index.html`、`viewer/src/main.ts`）、深色 Workspace mark、Atlas 字体资源，以及本计划要求的基线和截图文档。未改动 API、数据 schema、DOM id、事件监听、localStorage key、六个工作模式或 Coverage Canvas 交互。

### Screenshot Index

截图使用 `ASTRO_API_URL=http://astro.workspace.dev.72602.space:32080` 的 Vite preview 采集，所有 PNG 保持浏览器视口原尺寸。

| Theme | Desktop 1440x900 | Mobile 390x844 |
| --- | --- | --- |
| Dark | [packages](screenshots/workspace/dark-desktop-packages.png) · [connectors](screenshots/workspace/dark-desktop-connectors.png) · [catalog](screenshots/workspace/dark-desktop-catalog.png) · [layers](screenshots/workspace/dark-desktop-layers.png) · [workflow](screenshots/workspace/dark-desktop-workflow.png) · [system](screenshots/workspace/dark-desktop-system.png) | [catalog detail](screenshots/workspace/dark-mobile-catalog-detail.png) · [coverage](screenshots/workspace/dark-mobile-layers.png) · [registration dialog](screenshots/workspace/dark-mobile-catalog-dialog.png) |
| Light | [packages](screenshots/workspace/light-desktop-packages.png) · [connectors](screenshots/workspace/light-desktop-connectors.png) · [catalog](screenshots/workspace/light-desktop-catalog.png) · [layers](screenshots/workspace/light-desktop-layers.png) · [workflow](screenshots/workspace/light-desktop-workflow.png) · [system](screenshots/workspace/light-desktop-system.png) | [catalog detail](screenshots/workspace/light-mobile-catalog-detail.png) · [coverage](screenshots/workspace/light-mobile-layers.png) · [registration dialog](screenshots/workspace/light-mobile-catalog-dialog.png) |

### Verification Notes

- 两主题的 1440x900 截图逐一激活 `button[data-mode]` 的 `packages`、`connectors`、`catalog`、`layers`、`workflow`、`system`；移动截图覆盖资产详情、Coverage 主画布和登记弹窗。
- 390x844 两主题均报告 `document.documentElement.scrollWidth === 390`，弹窗在视口内并保留内部滚动；顶栏、模式导航、抽屉入口和 Agent dock 没有横向溢出。
- 浅色 token 明确定义 `--text`、`--text-strong`、`--text-soft`，避免标题/品牌/Inspector 继承深色白字；暗色仍保留 `#030712` 页面底色和 `#25282d` 场景默认底色。
- 活动分段控件使用 `--on-accent`：暗色靛蓝底为近黑字，浅色靛蓝底为白字；正文、状态和禁用控件保持主题级可读对比度。
- 原生 `dialog[open]` 优先接管 `Escape` 的 cancel 行为，Workspace 的覆盖层/Aladin 快捷键仅在没有弹窗时处理 Escape。
- 既有环境信号仍可能出现：没有 Agent API 时 `/api/agent/workspace-sessions` 返回 404，Lucide 重复 hydration 可能输出 registry warning；这两项不影响本次视觉验收。
