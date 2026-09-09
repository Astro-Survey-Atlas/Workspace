import { buildProvenance, sourcePermalink } from "./build-metadata.js";
import { PRODUCTION_PIPELINES } from "./production.js";

/**
 * Static registry of production capabilities shipped in this build. The list is
 * surfaced read-only through System Configuration; callers can never register
 * or edit capabilities at runtime.
 */

export type ProductionCapabilityKind = "pipeline" | "resolver" | "transfer" | "handoff";

export type ProductionCapabilityAvailability = "available" | "planned" | "unavailable";

export interface ProductionCapabilityDescriptor {
  kind: ProductionCapabilityKind;
  key: string;
  version: number;
  title: string;
  description: string;
  availability: ProductionCapabilityAvailability;
  responsibility: string;
  sourcePath: string;
  sourceUrl: string | null;
}

export interface ProductionCapabilityOptions {
  warehouseEnabled?: boolean;
}

interface CapabilitySeed {
  kind: ProductionCapabilityKind;
  key: string;
  version: number;
  title: string;
  description: string;
  responsibility: string;
  sourcePath: string;
}

const CAPABILITY_SEEDS: readonly CapabilitySeed[] = [
  {
    kind: "resolver",
    key: "direct-file",
    version: 1,
    title: "直链文件解析器",
    description: "校验单个公开 HTTP(S) 文件 URL，补充大小与校验信息。",
    responsibility: "将已展开的单文件来源单元转换为规范清单条目。",
    sourcePath: "src/source-crawler.ts",
  },
  {
    kind: "resolver",
    key: "http-directory",
    version: 1,
    title: "HTTP 目录解析器",
    description: "读取一层公开目录列表，仅接受同源直接子文件，不递归。",
    responsibility: "将公开目录来源单元展开为目录内直接文件清单。",
    sourcePath: "src/source-crawler.ts",
  },
  {
    kind: "resolver",
    key: "desi-tile",
    version: 1,
    title: "DESI Tile 解析器",
    description: "校验 tiles/cumulative/TILEID/LASTNIGHT 叶子目录并读取官方校验清单。",
    responsibility: "将 DESI tile 目录单元展开为原生层级文件清单并附校验值。",
    sourcePath: "src/source-crawler.ts",
  },
  {
    kind: "transfer",
    key: "builtin-http-download",
    version: 1,
    title: "内置 HTTP 下载执行器",
    description: "流式下载、Range 断点续传、校验与分级暂存。",
    responsibility: "把已审批的清单传输到部署配置的生产数据根目录。",
    sourcePath: "src/coverage-downloads.ts",
  },
  {
    kind: "handoff",
    key: "workspace-local-connector",
    version: 1,
    title: "本地 Connector 交付",
    description: "下载校验完成后注册并检查本地 Connector。",
    responsibility: "将校验通过的下载目录登记为可扫描的 local Connector。",
    sourcePath: "src/coverage-downloads.ts",
  },
  {
    kind: "handoff",
    key: "warehouse-scan",
    version: 1,
    title: "Warehouse 扫描提交",
    description: "为生产输出创建 Warehouse ScanRequest（本地 PVC 或 S3 来源）。",
    responsibility: "把输出 Connector 交给 Warehouse 扫描并跟踪受理结果。",
    sourcePath: "src/warehouse-scan.ts",
  },
];

export function listProductionCapabilities(options: ProductionCapabilityOptions = {}): ProductionCapabilityDescriptor[] {
  const warehouseEnabled = options.warehouseEnabled ?? false;
  const descriptors: ProductionCapabilityDescriptor[] = PRODUCTION_PIPELINES.map((pipeline) => ({
    kind: "pipeline" as const,
    key: pipeline.id,
    version: pipeline.version,
    title: pipeline.title,
    description: pipeline.description,
    availability: pipeline.availability === "available" ? "available" as const : "planned" as const,
    responsibility: "声明式的流水线定义，由 ProductionService 编排执行。",
    sourcePath: "src/production.ts",
    sourceUrl: sourcePermalink("src/production.ts"),
  }));
  CAPABILITY_SEEDS.forEach((seed) => {
    const availability = seed.key === "warehouse-scan" && !warehouseEnabled ? "unavailable" as const : "available" as const;
    descriptors.push({
      ...seed,
      availability,
      sourceUrl: sourcePermalink(seed.sourcePath),
    });
  });
  return descriptors;
}

export function productionBuildProvenance() {
  return buildProvenance();
}
