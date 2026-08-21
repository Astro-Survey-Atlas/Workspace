# 公开巡天覆盖 MOC 的来源与计算方法

本文是 Atlas 历史覆盖制品的来源记录。`src/footprints/survey-footprints.json` 仅作为归档材料保留，Atlas 运行时不读取它，也不再在本仓库生成公共 MOC。它只描述天空覆盖，不包含星表行、图像像素或观测深度模型。

## 证据等级

发布后的产品级台账位于 `Astro-Survey-Atlas-Assets`；Atlas 只信任同步后的 Resource Package v3 快照，不保留公共覆盖生成器或发布校验入口。

Assets 的 `artifacts/public-survey-footprints/sources.json` 是产品级台账。只有存在产品级几何来源、且原始制品已保存并通过校验的记录才标为 `acquired`。本次新增的 CDS 产品直接来自公开的 CDS MocServer/HiPS MOC；Euclid Q1 使用 Euclid Consortium 发布的 DS9 区域文件计算。尚未有产品几何的记录仍是 `overview_only` 或 `awaiting_geometry`，没有用面积、中心点、示意图或相邻产品代填。

## CSST W1 仿真图像覆盖

CSST 条目描述尚未发射运行阶段的 W1 仿真数据，不是正式公开巡天 footprint。输入固定为已登记 OSS Connector 的 `W1_Phot/` Prefix，且只接受 basename 匹配 `^CSST_MSC_MS_WIDE_.*\\.fits$` 的文件。全量 Workspace run `ingest-2789ca60-c9db-46b9-9314-e581c91ab836` 匹配 178,056 个 FITS 文件，逐文件通过 Range 请求读取 FITS header，并从 `IMAGE` HDU 的 ICRS WCS 边界生成 `image_extent` 覆盖；不下载图像像素，也不使用目录对象位置代替图像范围。

WCS 边界使用包容性 NESTED HEALPix polygon rasterization，原生发布分辨率为 order 8（NSIDE 256）。标准 WCS 关键字始终是几何依据；`RA_OBJ/DEC_OBJ`、`RA_PNT0/DEC_PNT0` 和 `RA_PNT1/DEC_PNT1` 仅用于中心一致性审计。一个输入文件的 `CD2_1=0.003676972383887528 deg/pix` 会令 20,000 像素轴跨越约 73 度，明显偏离同批 WIDE 图像，审核后从公开并集中剔除并保留异常证据。

审核后的 178,055 个文件并集包含 6,763 个 order-8 像元，面积为 354.7589326601951 平方度。项目路径中的“1000 平方度”只是仿真项目标签，不能作为当前文件集合的实测覆盖面积。官网使用的 46 个 NSIDE 16 像元是从原生 order-8 MOC 归并父像元所得的 display-resolution reduction，不是重新计算的高精度边界。

完整输入 manifest、任务快照、统计、异常说明、order-8 JSON、FITS NUNIQ MOC、NSIDE 16 展示点阵和各文件 SHA-256 位于 Assets 仓库的 `artifacts/public-survey-footprints/csst/`。OSS ETag 只作为对象版本证据，不冒充内容 SHA-256；静态 Assets 不保存或暴露 OSS 凭据。

## CDS MOC 产品

以下产品的 `geometrySourceUrl` 均是可复核的 CDS 查询，查询参数固定为 `get=smoc&order=4&fmt=json`：

- GALEX GR6/GR7：`color`、`FUV`、`NUV`。
- HSC-SSP PDR2：Wide + Deep 的 `color-i-r-g`，以及 `g/r/i/z/y` 各波段的 Wide + Deep 并集。
- Pan-STARRS1 DR1：`color-i-r-g`，以及 `g/r/i/z/y`。
- 2MASS All-Sky：`J`、`H`、`K`。
- AllWISE：`W1`、`W2`、`W3`、`W4`。

已有的 Legacy Surveys DR10、SDSS DR9、HST HiPS、DES DR2、KiDS DR5 和 NVSS 产品沿用同一证据规则。Assets 流程把每个请求的原生 FITS MOC 和 `record` 元数据保存在 `artifacts/public-survey-footprints/raw/moc/`，`raw/moc/index.json` 记录 URL、抓取时间、字节数和 SHA-256。

CDS 返回的是分层 NESTED MOC。显示目录统一到 NSIDE 16（order 4），算法对每个源单元执行：

1. 源 order 不大于 4 时，把源像素 `p` 展开为 `p * 4^(4-order)` 到 `p * 4^(4-order) + 4^(4-order) - 1`。
2. 源 order 大于 4 时，用 `floor(p / 4^(order-4))` 归并到父像素。
3. 对所有结果去重并按像素号排序。

这是一种明确的包容性固定分辨率表示：不会声称比原生 MOC 更高的边界精度，也不会把某波段的覆盖传播到另一个波段。

## Euclid Q1 的多边形计算

输入是官方文件：
`https://www.euclid-ec.org/wp-content/uploads/q1_region_files.zip`。
Assets 流程只接受 ZIP 根目录中的 `q1_edff.reg`、`q1_edfn.reg`、`q1_edfs.reg` 三个文件，并拒绝额外、重复或过大的条目。每个文件必须声明 `icrs`，随后只能包含 DS9 `polygon(...)`；每个坐标都校验为 RA `[0,360)` 度、Dec `[-90,90]` 度。

每个顶点从 ICRS 度数转换为 `theta = (90 - Dec) * pi/180`、`phi = RA * pi/180`，再交给 `healpixjs` 的 `queryPolygonInclusive`。计算参数为 NSIDE 16、`fact = 8`，即用过采样的 HEALPix 多边形查询保留所有与官方边界相交的像素；三份文件的像素集合合并、去重并排序。该结果是由官方边界导出的 MOC，不是由 63.1 deg2 和场中心反推的圆形近似。

原始 ZIP 保存在历史 Assets 制品中，索引记录来源、抓取时间、文件大小、SHA-256、多边形数量和解析器参数。Atlas 不再运行该抓取或发布校验流程；新的公共 MOC 和 Resource Package v3 必须在 `Astro-Survey-Atlas-Assets` 中生成并通过 trust gate。

## DESI EDR 与 DR1 光谱 tile 覆盖

DESI 光谱覆盖使用官方发布的 `TILE_COMPLETENESS` FITS 表，而不是 Legacy Surveys 成像范围：

- EDR：`tiles-fuji.fits`，732 行；
- DR1：`tiles-iron.fits`，6101 行。

Assets 流程只保留 `NEXP > 0` 的实际观测 tile，并读取 `TILERA`、`TILEDEC` 作为 ICRS 圆心。本次两张表的全部行都满足该筛选。每个 tile 使用 DESI 官方焦平面几何所给的 413.4839307227412 mm 半径；通过 `desimodel 0.20.0` 的焦平面到天空换算得到 1.6280324520485583 度角半径，再用 `Healpix.queryDiscInclusive`、NSIDE 16、`fact = 8` 将圆盘并集栅格化为固定分辨率 NESTED 覆盖。

原始 FITS 保存在 `artifacts/public-survey-footprints/raw/geometry/`。`raw/geometry/index.json` 记录官方 URL、行数、筛选条件、坐标列、半径、`desimodel` 版本、字节数和 SHA-256。这个制品表达已观测 tile 的焦平面包络，不表达每根光纤是否成功、目标选择函数、曝光深度或红移成功率。

上述计算和可复现命令属于历史材料；当前 DESI MOC 由 Assets Core 发布流程维护。

## 复现命令

公共几何抓取、MOC 生成、Resource Package v3 构建和发布校验已迁移到
`Astro-Survey-Atlas-Assets`。Atlas 侧只运行：

```bash
npm run validate
```

该命令验证 Atlas 自身构建、测试和本地数据格式，不会抓取或重写公共覆盖制品。

## 未完成产品

SDSS 各版本的完整 release catalog、DESI DR2 science-result tables、Legacy Surveys Tractor/CCD 精确几何、HSC PDR1/PDR3、HST Source Catalog/Advanced Products、GALEX 早期 release 和 Euclid ERO/Q2 等仍没有被本次 MOC 代填。它们继续在台账中明确写出缺少的官方几何和下一步提取方式。
