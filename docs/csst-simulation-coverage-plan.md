# CSST W1 仿真覆盖扫描与 Assets 预览计划

## 目标与语义

将 CSST W1 仿真数据按真实 OSS 内容执行 WCS 覆盖扫描，并在 Workspace 与 Astro Survey Atlas Assets 两个网站展示结果。这里的覆盖范围是当前仿真图像数据提供的范围，不是正式 CSST 巡天 footprint，也不是目录对象分布。

固定产品语义：

- Survey：`csst`
- Release：`csst-sim-w1-20250731`
- Product：`W1 simulated wide-field images`
- 输入：注册 OSS `W1_Phot/` Prefix 下 basename 匹配 `^CSST_MSC_MS_WIDE_.*\\.fits$` 的文件
- 方法：FITS WCS 图像范围（`fits-wcs` / `image_extent`）
- 坐标：ICRS
- 输出：NESTED HEALPix order 8（NSIDE 256）；官网展示由其派生 NSIDE 16 点阵
- 页面必须标注：CSST 尚未发射真实运行；当前覆盖是 W1 仿真数据范围，不代表正式公开巡天完整观测 footprint

## 已有资源

- Connector：`connector-fd599c33-b7c8-4bbd-9377-a7b87133f069`
- Connector 配置哈希：`5df4eb03e453280a1f37c9b67f6b6a38b3fb983295d83da795af99c173060a7f`
- 图像资产：`user-a04202c3-f8a1-4e0f-8f02-41fc8adf9c1e`
- 扫描任务 namespace：`warehouse`
- 默认后端：`backend: job`
- 输出索引：`astro_file_index_v1`、`astro_coverage_index_v1`

不创建新 Connector，不复制或暴露 OSS 凭据。

## 扫描实施

### 线上版本同步

Workspace MCP、`AstroMetadataScanTask` CRD、metadata operator 和 `astro-metadata-scan` scanner 必须同步到支持 `fileNamePattern` 与 FITS WCS image extent 的版本。CRD 必须接受 `spec.fileNamePattern`，operator 必须将其传递给 scanner Job。

scanner 必须支持 FITS IMAGE HDU 字节跨度、Range header 读取、多 HDU 跳转、压缩输入显式处理、WCS 边界多边形填充、RA=0/极区/旋转矩阵和中心别名审计。

### Smoke

通过 `POST /api/surveys/csst/coverage-jobs` 提交，不使用无法表达筛选条件的空 body Connector self-scan。Smoke 目录固定为 `10600000012/`，请求固定包含 connector、asset、release、product、`^CSST_MSC_MS_WIDE_.*\\.fits$`、`fits-wcs`、ICRS、`image_extent` 和中心别名审计字段。

Smoke 只有在任务 `Succeeded`、目标文件过滤正确、`processedHdus`/`coverageDocuments` 非零、WCS 无失败、像元合法去重后才进入 full。

### Full

Smoke 成功后以相同配置提交整个注册 `W1_Phot/` Prefix。保存完整输入 manifest、对象 ETag/大小/修改时间、WCS 摘要、任务 snapshot、版本、配置哈希、异常、NSIDE 256 像元和所有输出 SHA-256。重复规范化请求必须通过幂等键复用同一 run。

### 仿真覆盖审核与发布

Full 成功后检查像元非空、无重复、面积与仿真数据说明和文件分布一致，并由人工确认。审核前 Workspace coverage 为 `pending`，Assets 产品为 `awaiting_geometry`/`review_required`，不加入公开 footprint manifest。审核通过后可发布仿真覆盖像元和 NSIDE 16 展示点阵，但所有页面、API、manifest 和 provenance 必须标注仿真范围，不得称为正式巡天覆盖。

## Assets 在线预览

为 JSON、Markdown、其他文本和 PNG/SVG/WebP 增加安全预览；ZIP、FITS 和其他二进制仅下载。

新增 `GET /api/v1/assets/:id/preview`：JSON 返回两格缩进格式化文本；Markdown 按纯文本展示，不执行 HTML/script；图片以 `inline` 返回；文本大小超过 2 MiB 返回 `413`；ZIP/FITS 返回 `415`；支持 GET/HEAD、Range、ETag、`X-Content-SHA256` 和安全缓存；API 不暴露文件系统路径。

Public asset API 为可预览文件增加 `previewUrl` 与 `previewMode`。前端每个可预览文件增加预览按钮和安全弹窗；ZIP/FITS 只保留下载按钮。CSST 四份 JSON 证据必须同时可预览和下载。

## 测试与验收

运行 scanner、Workspace 和 Assets 测试；验证 CRD/operator/scanner 版本一致、smoke/full 状态、文件过滤、WCS 结果、仿真文案、preview API 的媒体类型/范围/哈希/大小限制，以及页面上预览按钮只出现在可预览文件。

最终验收：Workspace 显示 CSST 真实 smoke/full run；Assets 显示带免责声明的仿真覆盖与证据；JSON/Markdown/图片可预览；ZIP/FITS 只能下载。

