/*
 * Copyright 2026 Astro Survey Atlas contributors.
 * Licensed under the Apache License, Version 2.0.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "workspace-docs-language";
  const DEFAULT_LANGUAGE = "zh";
  const originalMarkup = new WeakMap();
  const originalAttributes = new WeakMap();
  const originalMeta = new WeakMap();

  const chinese = Object.freeze({
    "a11y.skip": "跳到文档正文",
    "a11y.home": "Workspace 文档首页",
    "a11y.primaryNav": "主导航",
    "a11y.languageToggle": "切换到英文",
    "a11y.themeToggle": "切换主题",
    "a11y.onThisPage": "本页导航",
    "a11y.ecosystem": "Workspace 在 ASA 生态中的位置",
    "meta.description": "Workspace（Atlas）文档：面向用户的天空仪表盘、本地资产、连接器与 Astro Survey Atlas 中的任务编排。",
    "brand.docs": "文档",
    "nav.boundary": "边界",
    "nav.skyViewer": "天空浏览器",
    "nav.quickStart": "快速开始",
    "nav.limits": "边界与限制",
    "nav.github": "GitHub 仓库",
    "sidebar.documentation": "文档目录",
    "sidebar.related": "相关项目",
    "nav.s01": "01 / Workspace 是什么",
    "nav.s02": "02 / 产品边界",
    "nav.s03": "03 / 天空浏览器",
    "nav.s04": "04 / 用户资产注册表",
    "nav.s05": "05 / 连接器",
    "nav.s06": "06 / 本地扫描与用户 MOC",
    "nav.s07": "07 / 可选 Warehouse 扫描",
    "nav.s08": "08 / Resource Package v3",
    "nav.s09": "09 / Agent 与 MCP",
    "nav.s10": "10 / 快速开始",
    "nav.s11": "11 / 限制与非目标",
    "nav.s12": "12 / 仓库权威文档",
    "related.assets": "Assets",
    "related.warehouse": "Warehouse 文档",
    "related.moc": "MOC Core 文档",
    "hero.eyebrow": "Astro Survey Atlas / 用户工作区",
    "hero.title": "Workspace (Atlas)",
    "hero.description": "Workspace 是 Astro Survey Atlas 中面向用户的交互式数据探索界面。它承载 Aladin 天空仪表盘、本地用户资产登记、连接器与凭据、基于 MOC Core 的本地扫描、可选的 Warehouse 远程扫描，以及对<em>用户</em>数据的只读 MCP 表面。公共巡天几何来自 Assets Resource Package v3（单向消费）。在配置启用时，高吞吐远程扫描可委托给 Warehouse。",
    "flow.assets.role": "公共 Resource Package v3",
    "flow.workspace.role": "浏览器 + 用户资产 + MCP",
    "flow.warehouse.role": "可选远程 ScanRequest",
    "flow.moc.role": "几何内核",
    "card.explore.title": "探索天空",
    "card.explore.body": "Aladin Lite v3 浏览器，展示 ICRS 覆盖、密度、天体对象，以及来自已安装公共包与用户扫描的仅显示巡天图层。",
    "card.own.title": "掌管用户数据",
    "card.own.body": "登记私有资产与连接器，运行本地 CSV 扫描，保持 Workspace Elasticsearch 与用户 MOC 产物独立于 Warehouse。",
    "card.deterministic.title": "保持确定性",
    "card.deterministic.body": "解析、HEALPix 索引与 MOC 生成通过固定版本的 MOC Core 在已测试代码中运行。MCP 与 Agent 适配该平面，不会自行发明几何。",
    "boundary.tag": "边界",
    "boundary.title": "产品边界",
    "boundary.lead": "摘自仓库内架构与 atlas-boundary 计划。Atlas 拥有用户侧状态；它不会变成公共巡天目录。",
    "boundary.owns.title": "Workspace 拥有",
    "boundary.owns.1": "用户资产、本地巡天/发布标签、连接器与访问元数据",
    "boundary.owns.2": "本地扫描，以及经 Warehouse 的可选远程用户扫描",
    "boundary.owns.3": "自有的 Elasticsearch 搜索索引、天空覆盖查询与浏览器",
    "boundary.owns.4": "用户 MOC 产物、扫描/任务历史与证据引用",
    "boundary.owns.5": "面向用户数据的确定性 Agent/MCP 与工作流运行",
    "boundary.not.title": "Workspace 不拥有",
    "boundary.not.1": "公共巡天作业、公共连接器、MOC 发布或公共发布目录",
    "boundary.not.2": "将用户资产登记到 Assets，或把用户记录发布回 Assets",
    "boundary.not.3": "把 Warehouse Elasticsearch 当作共享数据库（Workspace ES 保持独立）",
    "boundary.not.4": "Warehouse 扫描器/Operator 运行时或 Assets 管理 API",
    "boundary.callout.title": "普通公共几何",
    "boundary.callout.body": "来自 Assets 发布的不可变 Resource Package v3。细粒度公共区域查询（若使用）保持在服务端并限定范围——浏览器不持有 Assets 凭据。Atlas 从不存储完整的公共 tile/file/shard 索引。",
    "boundary.labels": "<code>surveyId</code> 与 <code>releaseId</code> 在用户资产和连接器上是 Atlas 本地标签。用户登记从不要求匹配的公共包记录。HTTP 命名空间保持分离：<code>/api/surveys</code> 面向 Atlas 本地标签；<code>/api/public-surveys</code> 仅为公共浏览器读取已安装的 Resource Package v3 元数据。",
    "viewer.tag": "浏览器",
    "viewer.title": "天空浏览器",
    "viewer.lead": "前端浏览器（Vite + TypeScript + Aladin Lite v3）是 Atlas 的权威天球探索器。同一套 ICRS 天空契约驱动覆盖、密度、天体对象与巡天图层。",
    "viewer.th.rep": "表示",
    "viewer.th.purpose": "用途",
    "viewer.th.source": "来源",
    "viewer.coverage": "覆盖",
    "viewer.coverage.purpose": "显示公共或用户数据存在的位置",
    "viewer.coverage.source": "Assets 包或用户扫描投影",
    "viewer.density": "密度",
    "viewer.density.purpose": "比较已占用区域",
    "viewer.density.source": "Nested HEALPix 计数",
    "viewer.objects": "天体对象",
    "viewer.objects.purpose": "检查行数据",
    "viewer.objects.source": "有效的用户源坐标（本地索引）",
    "viewer.layers": "巡天图层",
    "viewer.layers.purpose": "比较公共包与用户资产",
    "viewer.layers.source": "仅显示的壳层偏移",
    "viewer.body": "壳层偏移仅用于视觉布局——它们从不表示距离、深度、波长、星等或完备性。区域选择与 Aladin 探索使用同一套公共/用户图层。几何重叠（<code>POST /api/sky/overlap</code>）对已有像元证据的可见公共与 workspace 来源求交；普通几何重叠不需要文件反查索引。",
    "viewer.warn.title": "覆盖 ≠ 下载。",
    "viewer.warn.body": "已验证的公共 MOC 表示巡天识别该区域。它不保证对应科学文件可读或可下载。可用性状态（仅几何、仅入口、候选/不完整、tile 已解析、不可用）在重叠与下载计划流程中保持区分。",
    "assets.tag": "资产",
    "assets.title": "用户资产注册表",
    "assets.lead": "Workspace 是私有数据资产的权威所有者。可添加、查看、过滤、编辑和删除用户资产，并使用规范化的巡天/发布标签——目录、图像、光谱、数据立方、时序以及本地登记的相关模态。",
    "assets.1.title": "仅本地标签。",
    "assets.1.body": "用户 <code>surveyId</code>/<code>releaseId</code>/<code>product</code> 从不写回 Assets，也不必存在于公共包目录中。",
    "assets.2.title": "状态是派生的。",
    "assets.2.body": "<code>GET /api/data-assets/status</code> 报告覆盖（<code>not_started</code> / <code>pending</code> / <code>failed</code> / <code>ready</code> / <code>empty</code> / <code>unavailable</code>）、对象可索引性以及建议的下一步。仅登记（“已获取”）不是天空覆盖。",
    "assets.3.title": "只有 ready 的 MOC 会绘制。",
    "assets.3.body": "当覆盖为 <code>ready</code> 时，用户天空图层上才会出现像元；最新扫描处于 pending 或 failed 时，若存在先前 ready 产物则继续显示它。",
    "connectors.tag": "连接器",
    "connectors.title": "连接器",
    "connectors.lead": "登记数据源并运行结构性连接检查。凭据保留在受管密钥库中——从不出现在资产元数据、ScanRequest 正文、证据或 HTTP 响应中。",
    "conn.local.title": "本地文件系统",
    "conn.local.body": "受控的只读连接器根目录。本地 CSV 扫描将对象与覆盖写入 Workspace Elasticsearch，并生成用户 MOC 产物。",
    "conn.s3.title": "S3 兼容与阿里云 OSS",
    "conn.s3.body": "Amazon S3 与阿里云 OSS 端点（当主机名匹配时，OSS 通过带阿里云 OSS SDK 的 <code>s3</code> 连接器类型处理）。用于连接检查与可选的 Warehouse 远程扫描。",
    "conn.jdbc.title": "JDBC 数据库",
    "conn.jdbc.body": "Workspace 连接器包含 JDBC，用于结构性检查与 Workspace 侧使用。Warehouse ScanPlan v2 尚不接受 JDBC 源——远程 Warehouse 扫描仍仅支持 local/S3/OSS。",
    "conn.check.title": "连接测试",
    "conn.check.body": "<code>POST /api/connectors/:id/check</code> 验证端点、桶、前缀或数据库连通性。检查成功不是扫描完成的证据。",
    "local.tag": "本地扫描",
    "local.title": "本地扫描与用户 MOC",
    "local.lead": "确定性本地扫描器解析本地连接器下的 CSV，校验 RA/Dec，构建 nested HEALPix 索引，并通过固定的 <code>astro_survey_moc_core</code> 适配器生成 IVOA FITS MOC 文件。",
    "local.path.title": "本地路径",
    "local.path.body": "<code>POST /api/connectors/{id}/local-scan</code>（或资产作用域的本地扫描）。写入 Workspace ES 与用户 MOC 存储。未完成的本地扫描在重启时标记为 failed——从不作为 ready 覆盖暴露。",
    "local.moc.title": "MOC Core 契约",
    "local.moc.body": "正常输出：ICRS、NESTED、IVOA FITS MOC、<code>maxOrder=10</code>；查询阶 8 与预览阶 4 由权威 MOC 派生。空或无效输入保持仅元数据或失败——不会从文件名或巡天标签推断 footprint。",
    "local.art.title": "用户 MOC 产物",
    "local.art.body": "至少包含 <code>moc.fits</code>、<code>query-order8.json</code>、<code>preview-order4.json</code> 与 SHA-256。<code>/api/user-mocs</code> 返回元数据；仅允许白名单产物下载。<code>/api/sky/coverage</code> 合并 ready 用户图层与公共包。",
    "local.modes": "支持的用户覆盖模式包括 <code>catalog-radec</code>（天体存在）、<code>nested-healpix</code> 与 <code>fits-wcs</code>（图像范围）。覆盖角色、数据来源、来源等级、版本与 SHA-256 附在已存储的覆盖记录上。用户 MOC 的公开发布不在 Atlas 范围内。",
    "wh.tag": "Warehouse",
    "wh.title": "可选 Warehouse 远程扫描",
    "wh.lead": "启用 Warehouse 时，Workspace 提交带 <code>ScanPlan</code> 版本 2 的命名空间 <code>ScanRequest</code>，针对一个有界 S3/OSS 源，轮询状态，仅读取 Warehouse <code>ast_*</code> 索引，并将证据导入 Workspace 以生成 MOC。",
    "wh.1.title": "可选。",
    "wh.1.body": "Warehouse 禁用或不可用时，Workspace 仍可启动，并提供用户资产、本地扫描、已安装公共包与既有用户 MOC。远程提交返回明确的禁用/不可用错误。",
    "wh.2.title": "跟踪标签。",
    "wh.2.body": "请求使用 <code>track-caller=workspace</code> 与 <code>track-task-kind=user-scan|user-coverage</code>（外加资产/连接器/批次 id）。历史 API 只返回 Workspace 拥有的记录。",
    "wh.3.title": "两套 Elasticsearch 平面。",
    "wh.3.body": "Workspace：通过 <code>ASTRO_ES_URL</code> 使用 <code>astro_*_index_v1</code>。Warehouse：通过 <code>ASTRO_WAREHOUSE_ES_URL</code> 使用 <code>ast_*_index_v1</code>。二者互不为回退。",
    "wh.4.title": "无远程对象行（v1）。",
    "wh.4.body": "Warehouse 证据产生文件/覆盖像元与用户 MOC——不是逐行星表对象。对象级探索需要本地扫描写入 <code>astro_object_index_v1</code>。",
    "wh.links": "ScanPlan 字段与 Operator 行为详见 <a href=\"https://astro-survey-atlas.github.io/Warehouse/\" target=\"_blank\" rel=\"noopener noreferrer\">Warehouse 文档</a>。远程提交与历史的 Workspace HTTP 契约见仓库 <a href=\"https://github.com/Astro-Survey-Atlas/Workspace/blob/main/docs/api-reference.md\" target=\"_blank\" rel=\"noopener noreferrer\"><code>docs/api-reference.md</code></a>。",
    "pkg.tag": "公共包",
    "pkg.title": "消费 Resource Package v3",
    "pkg.lead": "公共几何是单向消费路径。Workspace 下载、验证并激活 Assets 发布的不可变 v3 包。它从不把用户记录或用户 MOC 写回 Assets。",
    "pkg.1": "获取并验证 Assets v3 目录。",
    "pkg.2": "将已验证目录保存在 <code>assets-snapshots/&lt;hash&gt;/</code> 下，并原子地暴露 <code>assets-current</code>。",
    "pkg.3": "按需下载包；校验归档大小与 SHA-256；验证每个 v3 manifest 与 FITS MOC。",
    "pkg.4": "为只读公共天空视图激活所选发布图层。",
    "pkg.body": "若 Assets 不可用，先前已验证的本地快照仍可使用。若从未成功快照，公共资源端点返回 <code>503</code>；用户资产、本地扫描、索引与任务历史继续可用。Atlas 不扫描引导目录、不解析 v1/v2 包，也不保留第二套公共 footprint 生成器。",
    "pkg.callout.title": "限定范围的反查（在配置启用时）。",
    "pkg.callout.body": "显式的重叠详情或下载计划会话可由 Workspace 服务器调用有界、已认证的 Assets 查询。结果按区域限定并带修订/过期；浏览器从不收到凭据。仅几何图层仍可显示并参与重叠，而无需创建可执行下载项。",
    "agent.tag": "Agent",
    "agent.title": "Agent 与 MCP",
    "agent.lead": "MCP 与 Agent 是确定性数据平面上的适配器。它们选择工具并解释结果；不会实现第二套 WCS、HEALPix 或 MOC 算法。",
    "agent.1.title": "MCP 服务器",
    "agent.1.body": "（<code>asa-workspace</code>）：面向 Atlas 拥有的用户资产的只读工具——当前为 <code>list_user_assets</code> 与 <code>get_user_asset</code>。不包含公共 Assets 包。",
    "agent.2.title": "ToolRegistry / WorkflowRegistry",
    "agent.2.body": "：校验确定性工具契约与版本化 DAG。例如：通过配置的星表 MCP 客户端运行 Euclid × DESI 交叉匹配工作流——这是 Atlas 工作流，不是公共覆盖构建器，也不会发布到 Assets。",
    "agent.3.title": "Agent 意图",
    "agent.3.body": "在显式配置启用 LLM 集成之前保持基于规则。",
    "agent.notify": "全局通知甲板（<code>#workspace-notification-deck</code>）以统一生命周期报告包同步、连接检查、扫描与错误的临时进度。",
    "qs.tag": "本地运行",
    "qs.title": "快速开始",
    "qs.lead": "摘自仓库 README 的要点。完整部署契约请优先参阅 README 与 chart 文档。",
    "qs.prereq": "前置条件",
    "qs.prereq.1": "Node.js <code>&gt;= 22.13</code>",
    "qs.prereq.2": "Python <code>3.10+</code>（MOC Core CLI wheel）",
    "qs.prereq.3": "Elasticsearch <code>8.x</code>（Workspace 自有搜索平面）",
    "qs.prereq.4": "SQLite（默认）或 PostgreSQL",
    "qs.codeHeader": "本地开发",
    "qs.other": "其他运行路径",
    "qs.other.1.title": "Docker Compose（发布镜像）：",
    "qs.other.1.body": " <code>docker compose -f compose.release.yaml up -d</code>，然后 <code>curl http://127.0.0.1:8080/healthz</code>。",
    "qs.other.2.title": "Helm：",
    "qs.other.2.body": " chart <code>charts/asa-workspace</code> 位于 GHCR OCI；元数据存储与搜索模式见 chart README。",
    "qs.other.3.title": "Windows 桌面安装包：",
    "qs.other.3.body": " GitHub Releases 的 setup.exe 捆绑 API、浏览器与嵌入式 Python/MOC Core；首次启动配置数据目录与 Elasticsearch（外部或 Docker 托管）。",
    "qs.validate": "可用 <code>npm test</code>、<code>npm run test:e2e</code> 或 <code>npm run validate</code> 校验。完整步骤见 <a href=\"https://github.com/Astro-Survey-Atlas/Workspace/blob/main/README.md\" target=\"_blank\" rel=\"noopener noreferrer\">README.md</a>。",
    "limits.tag": "诚实说明",
    "limits.title": "限制与非目标",
    "limits.lead": "本 Pages 站点仅记录已落地的 Workspace 能力。以下明确超出范围或此处不作宣称。",
    "limits.1.title": "不拥有公共目录。",
    "limits.1.body": " Assets 拥有公共巡天/发布/产品发布；Workspace 消费包。",
    "limits.2.title": "不是科学数组代理。",
    "limits.2.body": " Workspace 不宣称作为通用文件服务器流式传输或代理任意 FITS/科学数组。有界覆盖下载任务（在配置启用时）会验证并将具体公共源单元登记到新的本地连接器——它们不能替代巡天归档。",
    "limits.3.title": "无深度图。",
    "limits.3.body": " FITS MOC 表达数据存在的位置，而非灵敏度或质量。不会推断深度图层。",
    "limits.4.title": "不宣称 TAP/SIA / sky-footprint-mapper / cosmos-explorer-ui",
    "limits.4.body": "，除非且直到它们作为已实现的 Workspace 功能出现在当前仓库文档中。",
    "limits.5.title": "不写回 Assets。",
    "limits.5.body": " 用户资产、用户 MOC 与用户任务历史从不登记或发布到 Assets。",
    "limits.6.title": "不与 Warehouse 共享 ES。",
    "limits.6.body": " 两套独立搜索平面；Warehouse 故障不得阻塞 Workspace 启动。",
    "limits.7.title": "远程扫描 ≠ 对象目录。",
    "limits.7.body": " Warehouse v1 证据是文件/覆盖/MOC，不是逐行对象。",
    "docs.tag": "权威来源",
    "docs.title": "仓库权威文档",
    "docs.lead": "本 Pages 站点汇总已落地架构以便浏览。详细 HTTP 契约、标签与验收规则位于仓库并仍是权威来源——不要把 Pages 当作第二套 API 规范。",
    "docs.arch": " — 产品边界与数据流",
    "docs.api": " — Workspace 自有 HTTP API",
    "docs.boundary": " — 冻结的边界计划",
    "docs.split": " — Assets / Warehouse / Atlas 分工",
    "docs.public": " — 以包为先的公共几何",
    "docs.download": " — 重叠与可执行下载项",
    "docs.readme": " — 功能、本地运行、Compose、Helm、桌面",
    "footer.copy": "Astro Survey Atlas / Workspace<br>静态文档。无实时服务连接。契约以仓库为准。",
    "footer.source": "GitHub 源码",
    "theme.dark": "夜间模式",
    "theme.light": "日间模式"
  });

  function readLanguage() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "en" ? "en" : DEFAULT_LANGUAGE;
    } catch (error) {
      return DEFAULT_LANGUAGE;
    }
  }

  function saveLanguage(language) {
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch (error) {
      // Private browsing can reject storage; the page still works in memory.
    }
  }

  function translate(key, fallback) {
    if (currentLanguage === "zh" && Object.prototype.hasOwnProperty.call(chinese, key)) {
      return chinese[key];
    }
    return fallback === undefined ? key : fallback;
  }

  function isInsideCode(element) {
    return Boolean(element.closest("pre, code, script, style, noscript"));
  }

  function translateText(language) {
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      if (isInsideCode(element)) {
        return;
      }
      if (!originalMarkup.has(element)) {
        originalMarkup.set(element, element.innerHTML);
      }
      const key = element.getAttribute("data-i18n");
      element.innerHTML = language === "zh" && Object.prototype.hasOwnProperty.call(chinese, key)
        ? chinese[key]
        : originalMarkup.get(element);
    });
  }

  function translateAttributes(language) {
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      if (!originalAttributes.has(element)) {
        originalAttributes.set(element, element.getAttribute("aria-label") || "");
      }
      const key = element.getAttribute("data-i18n-aria-label");
      const original = originalAttributes.get(element);
      element.setAttribute(
        "aria-label",
        language === "zh" && Object.prototype.hasOwnProperty.call(chinese, key) ? chinese[key] : original
      );
    });

    document.querySelectorAll("[data-i18n-meta]").forEach((element) => {
      if (!originalMeta.has(element)) {
        originalMeta.set(element, element.getAttribute("content") || "");
      }
      const key = element.getAttribute("data-i18n-meta");
      const original = originalMeta.get(element);
      element.setAttribute(
        "content",
        language === "zh" && Object.prototype.hasOwnProperty.call(chinese, key) ? chinese[key] : original
      );
    });
  }

  function updateLanguageControl(language) {
    const button = document.getElementById("language-toggle");
    if (!button) {
      return;
    }
    button.hidden = false;
    button.textContent = language === "zh" ? "English" : "中文";
    button.setAttribute("aria-label", language === "zh" ? "切换到英文" : "Switch to Chinese");
  }

  function applyLanguage(language, persist) {
    currentLanguage = language === "en" ? "en" : "zh";
    if (persist !== false) {
      saveLanguage(currentLanguage);
    }
    document.documentElement.lang = currentLanguage === "zh" ? "zh-CN" : "en";
    translateText(currentLanguage);
    translateAttributes(currentLanguage);
    updateLanguageControl(currentLanguage);
    window.dispatchEvent(new CustomEvent("workspace-docs-language-change", {
      detail: { language: currentLanguage }
    }));
  }

  let currentLanguage = readLanguage();
  applyLanguage(currentLanguage, false);

  const languageButton = document.getElementById("language-toggle");
  if (languageButton) {
    languageButton.addEventListener("click", () => {
      applyLanguage(currentLanguage === "zh" ? "en" : "zh");
    });
  }

  window.WorkspaceDocsI18n = Object.freeze({
    t: translate,
    applyLanguage,
    getLanguage: () => currentLanguage
  });
})();
