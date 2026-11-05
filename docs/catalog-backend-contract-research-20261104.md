# Euclid Q1 MER 与 DESI DR10 星表后端契约调研

日期：2026-11-04。范围：官方档案、项目文档、Astroquery 源码、公开表结构元数据及受限只读坐标查询；没有写入目录服务、调用 Workspace 科学服务或访问凭据。

已确认可用的官方标识为 **ESA `catalogue.mer_catalogue`** 与 **NOIRLab `ls_dr10.tractor`**。Workspace 的 `euclid-q1-mer-final`、`desi-dr10-tractor` 是[内部逻辑标识](../src/scientific-tools.ts)，不能直接当成官方 TAP 表名。这里的 DESI DR10 指 **DESI Legacy Imaging Surveys 成像数据**，不是 DESI 光谱数据发布。[E1][D1][D2]

## 目录与访问契约

| 项目 | Euclid Q1 MER | Legacy Imaging Surveys DR10 Tractor |
| --- | --- | --- |
| 数据产品 | Q1 `DpdMerFinalCatalog` 主对象表；官方数据产品定义同时描述 morphology、cutouts 等独立表。[E2] | DR10 Tractor 测光／形态拟合目录；DR10 新处理的是 DECam south，北部 BASS/MzLS 数据应查 DR9。[D1] |
| 查询表标识 | ESA PDR：`catalogue.mer_catalogue`；本次 `TAP_SCHEMA.tables` 返回的产品说明链接指向 Q1 DPDD。[E9][E2] | NOIRLab：`ls_dr10.tractor`；本次公开 schema 请求实际返回该表及其列。[D2] |
| 查询入口 | TAP 根 `https://eas.esac.esa.int/tap-server/tap`；ADQL，支持 `/sync` 与 `/async`。本次 `/sync` 元数据查询 HTTP 200。[E1][E3] | 官方 TAP 根 `https://datalab.noirlab.edu/tap`；支持 TAP/ADQL。另有 Data Lab REST Query Manager，见下文。[D3][D4] |
| 坐标列 | `right_ascension`、`declination`，double、单位 deg；元数据描述为源重心的 SExtractor ALPHA_J2000／DELTA_J2000。[E1] | `ra`、`dec`，官方 FITS 格式为 float64、单位 deg、J2000；Data Lab schema 确认同名列。[D2][D5] |
| 对象身份 | `object_id`，TAP 类型 long／FITS K，有符号 64 位整数；南天对象可以为负，跨 release 可能改变。[E1][E2] | 原始唯一键为 `(release, brickid, objid)`；`objid` 仅在一个 brick 内连续编号。Data Lab 另提供 `ls_id`，描述为 Unique LS object ID。[D2][D5] |
| 影像定位字段 | 对象表有 `segmentation_map_id`；本次按名称查找未返回 tile/path/file 列。tile 可按官方规则补全，影像文件另查 `q1.mosaic_product`。[E1][E2] | `brickname`、`brickid`、`brick_primary`，以及像素位置 `bx`／`by`；影像路径由发布版本与官方文件布局解析。[D2][D5][D6] |
| 访问限制 | 公共 PDR 可匿名查询；Astroquery 默认 cone search 行数为 **50**，匿名查询产物 72 小时后删除。个人持久空间等能力需认证。[E3][E4] | 官方手册允许匿名数据库查询／TAP；MyDB、持久存储、Notebook 等完整能力需账户。公开 NERSC 文件下载与协作者本地文件系统入口不同。[D7][D6] |

后端应分别记录 provider、release、官方 table 与逻辑 catalog key。表名和服务别名不是永久不变的发布版本承诺；未来 archive 更新时应重新核对元数据，不能把 Q1 请求静默换成其他发布。

## Euclid：对象到 tile、影像的解析

Q1 DPDD 给出两种 tile 来源：主 catalog FITS 的 `TILE_INDEX` header，或 **`floor(SEGMENTATION_MAP_ID / 10^6)`**。本次 ESA TAP 元数据确认 `catalogue.mer_catalogue.segmentation_map_id` 存在且类型为 long。因此可把它作为官方依据补全 tile，不能要求远端对象行自带内部的 `TILE_INDEX`／`euclid_fits_path` 字段。[E1][E2]

ESA `q1.mosaic_product` 的元数据实际确认了 `tile_index`、`file_name`、`file_path`、`datalabs_path`、`instrument_name`、`filter_name`、`product_type`、`fov`、`ra`、`dec`。官方 Astroquery 示例按天区与 `fov` 相交查询、选择 VIS 产品，然后通过 `Euclid.get_product(file_name=...)` 下载；该适配器还提供 DataLink、SIA 和 cutout 能力。[E7][E3] `q1.mer_final_catalogue` 则含 `file_name_list`、`tile_index_list` 等产品元数据，不能当作主对象表的另一个名称。[E8]

IRSA 官方 Q1 概览同时提供 TAP/SCS、SIA 和公开云访问。其 cloud 文档确认 **`s3://nasa-irsa-euclid-q1`，region `us-east-1`，MER 影像前缀 `q1/MER`，按 tile 组织**。[E5][E6] 应依据 archive 产品元数据或公开文件清单定位具体 key；ESA 的 `file_path`／`datalabs_path` 不能未经映射直接当成本地文件或该 S3 bucket 的对象路径。

`object_id` 应原样作为十进制字符串传过 JS／JSON 边界，并与 Q1 release 关联；不要先转成 JavaScript `number`，也不要根据当前 RA/Dec 重新生成官方 ID。DPDD 明确同一天体在不同 release 可以得到不同 ID。[E2]

## DESI：数据库、brick 与影像版本

NOIRLab 的公开元数据接口已实际返回 `ls_dr10.tractor`：

```text
GET https://datalab.noirlab.edu/query/schema?value=ls_dr10.tractor&format=csv
```

该请求实际响应为可读 schema 文本，确认 `ra`、`dec`、`release`、`brickid`、`brickname`、`objid`、`brick_primary`、`ls_id` 等列；不能仅凭请求中的 format 参数假定返回 CSV。Data Lab 官方 client 的 `query()` 支持 SQL／ADQL、同步／异步和不同输出格式；源码使用 `https://datalab.noirlab.edu/query/query`，参数包括 `sql` 或 `adql`、`ofmt`、`async`。[D2][D4][D8] 官方资料分别确认匿名数据库查询与 TAP/ADQL，但本次没有确认特定 `q3c_radial_query` SQL 扩展的可用性，没有执行对象 cone search；TAP 元数据请求超时，不能据此声称空间查询语法、行查询或吞吐验收通过。[D3][D7]

官方文件根为 `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/`，其 south 文件布局包括：[D6]

```text
south/tractor/<AAA>/tractor-<brick>.fits
south/coadd/<AAA>/<brick>/legacysurvey-<brick>-image-<filter>.fits.fz
```

`<brick>` 使用 `brickname`；`<AAA>` 是 brickname 的前三个字符，表示 brick 中心的整数 RA 分组。Tractor／Tractor-i FITS 是星表，不能作为二维 image 裁切来源；每个波段是否实际有数据应单独核对，不能因 DR10 提供 i 波段就假定每个 brick 均有 griz。[D1][D6]

对象身份应使用服务返回的 `ls_id` 字符串，或保存官方 `(release, brickid, objid)` 组合；不要把 `objid` 或跨发布版本的 `brickname + objid` 当作全局 ID。需要去除重叠 brick 的重复对象时，显式记录 `brick_primary` 选择策略。[D5]

官方 viewer 的 `layer=ls-dr10` 会组合 DR10 south 与 DR9 north；`layer=ls-dr10-south` 才明确限定南部。[D1] 因此在 Euclid 北部场找不到 DR10 south 覆盖时，应报告覆盖限制，或显式登记切换到 DR9 的科学选择；不能静默用 DR9 数据却标成 DR10。内部 S3 镜像 URI 也必须由配置／资产映射提供，公开文件布局不能证明任意内部 bucket 已有对应文件。

## Astroquery 与 VizieR 的确认状态

| 路径 | 本次确认结论 |
| --- | --- |
| `astroquery.esa.euclid` → ESA PDR | **确认精确适配器和表名。** Astroquery 官方源码将 PDR 指向 ESA，默认表为 `catalogue.mer_catalogue`，默认坐标列与上述元数据一致；无需经 VizieR 才能访问 Euclid。[E3][E4] |
| Euclid Q1 MER → VizieR | **未确认精确完整目录条目。** 本次 CDS TAPVizieR 和 VizieR metadata 关键字检索超时，未取得可核实的 catalog ID／table schema；不能由此断言不存在。[V1][V2] |
| DR10 Tractor → VizieR | **未确认精确完整目录条目。** CDS 的 DR10／Legacy／DESI 元数据检索超时；不把 DR8／DR9、论文样本、photo-z 衍生表或光谱目录当作 DR10 Tractor。[V1] |

VizieR／Astroquery 的通用查询能力不能替代精确的发布版本、目录 ID 和 schema 核对。当前已确认的实施依据是 ESA TAP、NOIRLab Data Lab，以及两者官方文件访问契约。

## 可复查的元数据证据与实现边界

本次已成功读取的 ESA 元数据可用以下 ADQL 复查；这些是 schema 检查，没有提取科学对象：

```sql
SELECT table_name, description FROM TAP_SCHEMA.tables
WHERE table_name = 'catalogue.mer_catalogue'

SELECT column_name, datatype, unit, description FROM TAP_SCHEMA.columns
WHERE table_name = 'catalogue.mer_catalogue'
  AND column_name IN ('object_id','right_ascension','declination','segmentation_map_id')
```

查询半径须明确单位，`250 arcsec = 250/3600 deg`。Astroquery 默认 50 行与产品自行设置的 TOP／MAXREC 都可能截断候选池，响应须记录 limit 和截断状态，不能把限制后的样本表示成完整天区。目录可查询也不保证影像覆盖、S3 可读或端到端五分钟指标；这些需分别验收。本次没有改代码、运行科学流程或验证服务可用率。

所有外部来源均为项目／档案维护方、Astroquery 项目或 CDS 本身。Astroquery 引用固定到 `46feb44215a4978512fc04abc16df378897845ff`；其他在线元数据与官方手册反映本次访问时状态。

[E1]: https://eas.esac.esa.int/tap-server/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT%20column_name,datatype,unit,description%20FROM%20TAP_SCHEMA.columns%20WHERE%20table_name%3D%27catalogue.mer_catalogue%27
[E2]: https://euclid.esac.esa.int/dr/q1/dpdd/merdpd/dpcards/mer_finalcatalog.html
[E3]: https://github.com/astropy/astroquery/blob/46feb44215a4978512fc04abc16df378897845ff/docs/esa/euclid/euclid.rst
[E4]: https://github.com/astropy/astroquery/blob/46feb44215a4978512fc04abc16df378897845ff/astroquery/esa/euclid/__init__.py
[E5]: https://irsa.ipac.caltech.edu/data/Euclid/docs/overview_q1.html
[E6]: https://irsa.ipac.caltech.edu/cloud_access/#euclid
[E7]: https://eas.esac.esa.int/tap-server/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT%20column_name,datatype,unit,description%20FROM%20TAP_SCHEMA.columns%20WHERE%20table_name%3D%27q1.mosaic_product%27
[E8]: https://eas.esac.esa.int/tap-server/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT%20column_name,datatype,unit,description%20FROM%20TAP_SCHEMA.columns%20WHERE%20table_name%3D%27q1.mer_final_catalogue%27
[E9]: https://eas.esac.esa.int/tap-server/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT%20table_name,description%20FROM%20TAP_SCHEMA.tables%20WHERE%20table_name%3D%27catalogue.mer_catalogue%27
[D1]: https://www.legacysurvey.org/dr10/description/
[D2]: https://datalab.noirlab.edu/query/schema?value=ls_dr10.tractor&format=csv
[D3]: https://datalab.noirlab.edu/docs/manual/UsingAstroDataLab/DataAccessInterfaces/CatalogDataAccessTAPSCS/CatalogDataAccessTAPSCS.html
[D4]: https://datalab.noirlab.edu/docs/manual/UsingAstroDataLab/ClientInterfaces/QueryClient/QueryClient.html
[D5]: https://www.legacysurvey.org/dr10/catalogs/
[D6]: https://www.legacysurvey.org/dr10/files/
[D7]: https://datalab.noirlab.edu/docs/manual/UsingAstroDataLab/WebPortal/Accounts/Accounts.html
[D8]: https://github.com/astro-datalab/datalab/blob/master/dl/queryClient.py
[V1]: https://tapvizier.cds.unistra.fr/TAPVizieR/tap
[V2]: https://vizier.cds.unistra.fr/viz-bin/votable?-meta=&-words=Euclid%20Q1&-meta.all=1

## Workspace fallback 实现（2026-11-04）

Workspace 保留已配置 Euclid/DESI MCP 工具与 `ASTRO_CATALOG_MCP_URL` 路径。专用 MCP
工具失败后会尝试配置的 `es_query`；仍失败时转到默认 MCP 客户端，最后尝试官方 TAP。
官方端点可由 `ASTRO_EUCLID_TAP_URL`、`ASTRO_DESI_TAP_URL` 覆盖，查询超时由
`ASTRO_CATALOG_ARCHIVE_TIMEOUT_MS` 控制（默认 30 秒）。所有路径仍由同一个 Workflow
执行坐标规范化、匹配、人工筛选、可选 cutout 和导出。

官方 TAP 查询将结果上限请求为 `limit + 1`，并在多返回一行时记录 `truncated=true`；
星表上限和截断状态进入 Workflow 摘要与 lineage。Euclid `object_id` 保持十进制字符串，
`floor(segmentation_map_id / 10^6)` 映射为 `TILE_INDEX`。DESI 使用 `ls_id` 作为稳定
对象标识，并保留 `release`、`brickid`、`brickname`、`objid`；Workflow 已有 cutout
路径解析据 `brickname` 生成 DR10 south coadd 路径。动态投影限制为最多 16 个简单列标识符，
列名不经过 SQL 拼接转义外的解释。

本次对 ESA TAP 使用 POST 实际查询中心 RA `58.375`、Dec `-51.25`、半径 250 角秒，
返回 `object_id`、坐标、`segmentation_map_id` 和 `extended_flag` 两行，HTTP 200、约
1.55 秒。先前 GET 形式的同一区域查询也返回 5 行、约 1.57 秒。该请求确认 ESA TAP
同步 ADQL 入口和目标表可查询，不代表整套 Workspace Workflow 或影像路径可用。

NOIRLab `ls_dr10.tractor` schema 接口返回了 `ls_id`、坐标、release、brick、类型和
`flux_r` 等字段。当前环境直连官方 `/tap/sync` 的小范围行查询在 18 秒内无响应；经已授权
代理以 RA/Dec 外接矩形及 `brick_primary = 1` 查询则返回 3 行，HTTP 200、`text/csv`、约
4.46 秒，包含 `ls_id` 与 DR10 brick 字段。首次使用标准 `POINT/CIRCLE` 的 ADQL cone
表达式收到数据库不支持三参数 `point()` 的错误；因此实现改用能包住检索圆的 RA/Dec
外接矩形，再由 Workspace 现有球面角距离逻辑执行精确圆内过滤。REST Query Manager
`/query/query` 仍返回 HTTP 401（缺少有效安全 token），当前实现不依赖它。

这确认了 NOIRLab 官方 TAP 的 DR10 行查询和外接矩形谓词可经代理使用，不证明部署环境的
直连可达性、完整 Workspace Workflow、生产图像读取或五分钟性能指标。Workspace 构建通过；
本次没有运行测试、改动线上配置、部署或执行科学 Workflow。
