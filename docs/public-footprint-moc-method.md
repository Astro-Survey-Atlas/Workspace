# 公开巡天覆盖 MOC 的来源与计算方法

本文记录 `src/footprints/survey-footprints.json` 中新增覆盖的来源、坐标处理和可复现计算。它只描述天空覆盖，不包含星表行、图像像素或观测深度模型。

## 证据等级

`artifacts/public-survey-footprints/sources.json` 是产品级台账。只有存在产品级几何来源、且原始制品已保存并通过校验的记录才标为 `acquired`。本次新增的 CDS 产品直接来自公开的 CDS MocServer/HiPS MOC；Euclid Q1 使用 Euclid Consortium 发布的 DS9 区域文件计算。尚未有产品几何的记录仍是 `overview_only` 或 `awaiting_geometry`，没有用面积、中心点、示意图或相邻产品代填。

## CDS MOC 产品

以下产品的 `geometrySourceUrl` 均是可复核的 CDS 查询，查询参数固定为 `get=smoc&order=4&fmt=json`：

- GALEX GR6/GR7：`color`、`FUV`、`NUV`。
- HSC-SSP PDR2：Wide + Deep 的 `color-i-r-g`，以及 `g/r/i/z/y` 各波段的 Wide + Deep 并集。
- Pan-STARRS1 DR1：`color-i-r-g`，以及 `g/r/i/z/y`。
- 2MASS All-Sky：`J`、`H`、`K`。
- AllWISE：`W1`、`W2`、`W3`、`W4`。

已有的 Legacy Surveys DR10、SDSS DR9、HST HiPS、DES DR2、KiDS DR5 和 NVSS 产品沿用同一证据规则。脚本还把每个请求的原生 FITS MOC 和 `record` 元数据保存在 `artifacts/public-survey-footprints/raw/moc/`，`raw/moc/index.json` 记录 URL、抓取时间、字节数和 SHA-256。

CDS 返回的是分层 NESTED MOC。显示目录统一到 NSIDE 16（order 4），算法对每个源单元执行：

1. 源 order 不大于 4 时，把源像素 `p` 展开为 `p * 4^(4-order)` 到 `p * 4^(4-order) + 4^(4-order) - 1`。
2. 源 order 大于 4 时，用 `floor(p / 4^(order-4))` 归并到父像素。
3. 对所有结果去重并按像素号排序。

这是一种明确的包容性固定分辨率表示：不会声称比原生 MOC 更高的边界精度，也不会把某波段的覆盖传播到另一个波段。

## Euclid Q1 的多边形计算

输入是官方文件：
`https://www.euclid-ec.org/wp-content/uploads/q1_region_files.zip`。
脚本只接受 ZIP 根目录中的 `q1_edff.reg`、`q1_edfn.reg`、`q1_edfs.reg` 三个文件，并拒绝额外、重复或过大的条目。每个文件必须声明 `icrs`，随后只能包含 DS9 `polygon(...)`；每个坐标都校验为 RA `[0,360)` 度、Dec `[-90,90]` 度。

每个顶点从 ICRS 度数转换为 `theta = (90 - Dec) * pi/180`、`phi = RA * pi/180`，再交给 `healpixjs` 的 `queryPolygonInclusive`。计算参数为 NSIDE 16、`fact = 8`，即用过采样的 HEALPix 多边形查询保留所有与官方边界相交的像素；三份文件的像素集合合并、去重并排序。该结果是由官方边界导出的 MOC，不是由 63.1 deg2 和场中心反推的圆形近似。

原始 ZIP 保存在 `artifacts/public-survey-footprints/raw/geometry/euclid-q1-region-files.zip`，索引 `raw/geometry/index.json` 记录来源、抓取时间、文件大小、SHA-256、多边形数量和解析器参数。`npm run artifacts:footprints` 会再次校验 ZIP 的大小与哈希；校验失败时不会生成可发布的 provenance。

## DESI EDR 与 DR1 光谱 tile 覆盖

DESI 光谱覆盖使用官方发布的 `TILE_COMPLETENESS` FITS 表，而不是 Legacy Surveys 成像范围：

- EDR：`tiles-fuji.fits`，732 行；
- DR1：`tiles-iron.fits`，6101 行。

生成器 `scripts/build_desi_footprints.ts` 只保留 `NEXP > 0` 的实际观测 tile，并读取 `TILERA`、`TILEDEC` 作为 ICRS 圆心。本次两张表的全部行都满足该筛选。每个 tile 使用 DESI 官方焦平面几何所给的 413.4839307227412 mm 半径；通过 `desimodel 0.20.0` 的焦平面到天空换算得到 1.6280324520485583 度角半径。生成器用 `Healpix.queryDiscInclusive`、NSIDE 16、`fact = 8` 将圆盘并集栅格化为固定分辨率 NESTED 覆盖。

原始 FITS 保存在 `artifacts/public-survey-footprints/raw/geometry/`。`raw/geometry/index.json` 记录官方 URL、行数、筛选条件、坐标列、半径、`desimodel` 版本、字节数和 SHA-256。这个制品表达已观测 tile 的焦平面包络，不表达每根光纤是否成功、目标选择函数、曝光深度或红移成功率。

可复现命令：

```bash
npm run build:desi-footprints -- --edr /path/to/tiles-fuji.fits --dr1 /path/to/tiles-iron.fits
```

## 复现命令

在网络可访问时，从仓库根目录运行：

```bash
npm run build:footprints
npm run build:resource-packages
npm run artifacts:footprints
npm run validate
```

第一步重新抓取官方几何并生成固定 NSIDE 16 manifest；第二步重新生成按巡天拆分的资源包；第三步检查台账、原生 MOC、Euclid ZIP、资源包和 SHA-256 provenance；最后一步运行 TypeScript 构建和测试。生成时间会更新，但输入 URL、算法、文件名和校验规则不变。

## 未完成产品

SDSS 各版本的完整 release catalog、DESI DR2 science-result tables、Legacy Surveys Tractor/CCD 精确几何、HSC PDR1/PDR3、HST Source Catalog/Advanced Products、GALEX 早期 release 和 Euclid ERO/Q2 等仍没有被本次 MOC 代填。它们继续在台账中明确写出缺少的官方几何和下一步提取方式。
