import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type InstallationChannel = "helm" | "docker" | "desktop" | "server";

export type WarehouseInstallationIntentKind = "connect" | "disconnect" | "install" | "uninstall";

export type WarehouseInstallationIntent =
  | { kind: "connect"; elasticsearchUrl: string; namespace?: string }
  | { kind: "disconnect" }
  | { kind: "install" }
  | { kind: "uninstall"; deleteData?: boolean };

export interface WarehouseBindingState {
  enabled: boolean;
  elasticsearchUrl: string;
  namespace: string;
}

export interface InstallationOperation {
  id: string;
  packageId: "warehouse";
  intent: WarehouseInstallationIntent;
  status: "succeeded" | "blocked" | "failed";
  reason: string;
  guidance: string[];
  createdAt: string;
}

export interface WarehouseInstallationView {
  packageId: "warehouse";
  channel: InstallationChannel;
  platform: {
    installerKind: "installer-agent" | "host-agent" | "electron" | "none";
    installAvailable: boolean;
    notes: string[];
  };
  binding: {
    effective: WarehouseBindingState;
    desired: WarehouseBindingState | null;
    aligned: boolean;
  };
  observed: {
    state: "absent" | "connected" | "pending-restart";
    health: "unknown" | "available" | "unavailable";
  };
  actions: Array<{ kind: WarehouseInstallationIntentKind; available: boolean; reason?: string }>;
  operations: InstallationOperation[];
}

interface InstallationState {
  schemaVersion: 1;
  desired: WarehouseBindingState | null;
  operations: InstallationOperation[];
}

export interface InstallationServiceOptions {
  root: string;
  channel?: InstallationChannel;
  inCluster?: boolean;
  readEffective: () => WarehouseBindingState & { configured: boolean };
}

const MAX_OPERATIONS = 100;
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string") throw new RangeError(`${name} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) throw new RangeError(`${name} 不能为空`);
  if (trimmed.length > max) throw new RangeError(`${name} 过长（最多 ${max} 字符）`);
  return trimmed;
}

export function detectInstallationChannel(env: NodeJS.ProcessEnv = process.env): InstallationChannel {
  const override = (env.ASTRO_INSTALL_CHANNEL ?? "").trim();
  if (override === "helm" || override === "docker" || override === "desktop" || override === "server") return override;
  if (env.KUBERNETES_SERVICE_HOST) return "helm";
  if (env.ASTRO_DESKTOP === "1" || env.ELECTRON_RUN_AS_NODE === "1") return "desktop";
  return "server";
}

function normalizeUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RangeError("Warehouse Elasticsearch 端点必须是合法 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError("Warehouse Elasticsearch 端点仅支持 http/https");
  }
  return parsed;
}

function displayUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return value;
  }
}

function comparableUrl(value: string): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.trim();
  }
}

function normalizeNamespace(value: unknown): string {
  if (value === undefined || value === null || value === "") return "asa-workspace";
  const namespace = text(value, "namespace", 63);
  if (!NAMESPACE_PATTERN.test(namespace)) throw new RangeError("namespace 格式不合法（小写 DNS 标签）");
  return namespace;
}

function bindingsAligned(desired: WarehouseBindingState, effective: WarehouseBindingState): boolean {
  if (desired.enabled !== effective.enabled) return false;
  if (desired.enabled) {
    return comparableUrl(desired.elasticsearchUrl) === comparableUrl(effective.elasticsearchUrl) && desired.namespace === effective.namespace;
  }
  return true;
}

function platformProfile(channel: InstallationChannel): WarehouseInstallationView["platform"] {
  if (channel === "helm") {
    return {
      installerKind: "installer-agent",
      installAvailable: false,
      notes: [
        "完整安装由 Installer Agent 执行（规划中）；当前可在页面记录连接意图，由管理员应用 Helm 配置。",
        "Warehouse 本体使用 atlas-warehouse-infra 与 atlas-warehouse-operator 两个独立 release。",
      ],
    };
  }
  if (channel === "docker") {
    return {
      installerKind: "host-agent",
      installAvailable: false,
      notes: ["本地执行面（gateway/worker）尚未发布；当前渠道仅支持记录连接意图。"],
    };
  }
  if (channel === "desktop") {
    return {
      installerKind: "electron",
      installAvailable: false,
      notes: ["Windows 桌面端当前仅规划支持连接远程 Warehouse；本地安装为低优先级后续项。"],
    };
  }
  return {
    installerKind: "none",
    installAvailable: false,
    notes: ["裸进程部署不支持由 Workspace 安装 Warehouse；请通过部署环境配置。"],
  };
}

function helmConnectGuidance(binding: WarehouseBindingState): string[] {
  return [
    "helm upgrade asa charts/asa-workspace --reuse-values \\",
    "  --set dataWarehouse.enabled=true \\",
    `  --set dataWarehouse.namespace=${binding.namespace} \\`,
    `  --set dataWarehouse.elasticsearch.url=${displayUrl(binding.elasticsearchUrl)}`,
  ];
}

function helmDisconnectGuidance(): string[] {
  return ["helm upgrade asa charts/asa-workspace --reuse-values --set dataWarehouse.enabled=false"];
}

function envConnectGuidance(binding: WarehouseBindingState): string[] {
  return [
    "ASTRO_DATA_WAREHOUSE_ENABLED=true",
    `ASTRO_WAREHOUSE_ES_URL=${displayUrl(binding.elasticsearchUrl)}`,
    `ASTRO_WAREHOUSE_NAMESPACE=${binding.namespace}`,
    "（修改后需重启 Workspace 进程）",
  ];
}

function envDisconnectGuidance(): string[] {
  return ["ASTRO_DATA_WAREHOUSE_ENABLED=false", "（修改后需重启 Workspace 进程）"];
}

export class InstallationService {
  readonly #root: string;
  readonly #statePath: string;
  readonly #channel: InstallationChannel;
  readonly #inCluster: boolean;
  readonly #readEffective: () => WarehouseBindingState & { configured: boolean };
  #desired: WarehouseBindingState | null = null;
  #operations: InstallationOperation[] = [];
  #writing: Promise<void> = Promise.resolve();
  #initialized = false;

  constructor(options: InstallationServiceOptions) {
    this.#root = options.root;
    this.#statePath = path.join(options.root, "installation-state.json");
    this.#channel = options.channel ?? detectInstallationChannel();
    this.#inCluster = options.inCluster ?? Boolean(process.env.KUBERNETES_SERVICE_HOST);
    this.#readEffective = options.readEffective;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    try {
      const raw = await readFile(this.#statePath, "utf8");
      const parsed = JSON.parse(raw) as InstallationState;
      if (parsed && parsed.schemaVersion === 1) {
        this.#desired = parsed.desired ?? null;
        this.#operations = Array.isArray(parsed.operations) ? parsed.operations.slice(0, MAX_OPERATIONS) : [];
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") console.warn("installation state unreadable; starting empty:", (error as Error).message);
    }
  }

  inspect(): WarehouseInstallationView {
    const effective = this.#readEffective();
    const desired = this.#desired;
    const aligned = desired ? bindingsAligned(desired, effective) : true;
    const state = effective.enabled ? "connected" : desired && !aligned ? "pending-restart" : "absent";
    const health = effective.enabled ? (effective.configured ? "available" : "unavailable") : "unknown";
    const connectAvailable = this.#channel === "helm" || this.#inCluster;
    const actions: WarehouseInstallationView["actions"] = [
      {
        kind: "connect",
        available: connectAvailable,
        reason: connectAvailable ? undefined : "当前渠道缺少 Warehouse 执行适配器，暂不支持连接",
      },
      { kind: "disconnect", available: effective.enabled || Boolean(desired?.enabled) },
      {
        kind: "install",
        available: false,
        reason: "安装器尚未在此部署中提供；可先记录连接意图或由管理员手动安装",
      },
      { kind: "uninstall", available: false, reason: "卸载需要 Installer Agent；数据保留策略需人工确认" },
    ];
    return {
      packageId: "warehouse",
      channel: this.#channel,
      platform: platformProfile(this.#channel),
      binding: { effective: clone(effective), desired: desired ? clone(desired) : null, aligned },
      observed: { state, health },
      actions,
      operations: clone(this.#operations),
    };
  }

  async reconcile(intentValue: unknown): Promise<InstallationOperation> {
    await this.initialize();
    const intent = this.#validateIntent(intentValue);
    const effective = this.#readEffective();
    let operation: InstallationOperation;
    if (intent.kind === "connect") {
      operation = this.#reconcileConnect(intent, effective);
    } else if (intent.kind === "disconnect") {
      operation = this.#reconcileDisconnect(effective);
    } else if (intent.kind === "install") {
      operation = this.#blockedOperation(intent, "安装器尚未部署", this.#installGuidance());
    } else {
      operation = this.#blockedOperation(
        intent,
        "卸载需要 Installer Agent 执行，并确认数据保留策略",
        this.#uninstallGuidance(),
      );
    }
    this.#operations = [operation, ...this.#operations].slice(0, MAX_OPERATIONS);
    await this.#persist();
    return clone(operation);
  }

  #validateIntent(value: unknown): WarehouseInstallationIntent {
    if (!value || typeof value !== "object") throw new RangeError("安装意图必须是对象");
    const intent = value as Record<string, unknown>;
    const kind = intent.kind;
    if (kind === "connect") {
      const raw = text(intent.elasticsearchUrl, "elasticsearchUrl", 2048).trim();
      normalizeUrl(raw);
      return { kind: "connect", elasticsearchUrl: raw, namespace: normalizeNamespace(intent.namespace) };
    }
    if (kind === "disconnect") return { kind: "disconnect" };
    if (kind === "install") return { kind: "install" };
    if (kind === "uninstall") {
      return { kind: "uninstall", deleteData: intent.deleteData === true ? true : undefined };
    }
    throw new RangeError("未知的安装意图类型");
  }

  #reconcileConnect(intent: Extract<WarehouseInstallationIntent, { kind: "connect" }>, effective: WarehouseBindingState): InstallationOperation {
    const base = {
      id: this.#operationId(),
      packageId: "warehouse" as const,
      intent: { ...intent, elasticsearchUrl: displayUrl(intent.elasticsearchUrl) },
      createdAt: now(),
    };
    if (this.#channel !== "helm" && !this.#inCluster) {
      return {
        ...base,
        status: "failed",
        reason: "当前渠道缺少 Warehouse 执行适配器，暂不支持连接",
        guidance: [],
      };
    }
    const desired: WarehouseBindingState = {
      enabled: true,
      elasticsearchUrl: intent.elasticsearchUrl,
      namespace: intent.namespace ?? "asa-workspace",
    };
    this.#desired = desired;
    if (bindingsAligned(desired, effective)) {
      return { ...base, status: "succeeded", reason: "期望配置与当前部署一致，Warehouse 已连接", guidance: [] };
    }
    return {
      ...base,
      status: "blocked",
      reason: "已记录期望配置；需要管理员应用以下配置并重启/滚动更新 Workspace 后生效",
      guidance: this.#channel === "helm" ? helmConnectGuidance(desired) : envConnectGuidance(desired),
    };
  }

  #reconcileDisconnect(effective: WarehouseBindingState): InstallationOperation {
    const base = { id: this.#operationId(), packageId: "warehouse" as const, intent: { kind: "disconnect" } as const, createdAt: now() };
    const desired: WarehouseBindingState = { enabled: false, elasticsearchUrl: "", namespace: "asa-workspace" };
    this.#desired = desired;
    if (bindingsAligned(desired, effective)) {
      return { ...base, status: "succeeded", reason: "Warehouse 已处于停用状态", guidance: [] };
    }
    return {
      ...base,
      status: "blocked",
      reason: "已记录停用意图；需要管理员应用以下配置并重启/滚动更新 Workspace 后生效",
      guidance: this.#channel === "helm" ? helmDisconnectGuidance() : envDisconnectGuidance(),
    };
  }

  #installGuidance(): string[] {
    if (this.#channel === "helm") {
      return [
        "helm upgrade --install atlas-warehouse oci://ghcr.io/astro-survey-atlas/charts/atlas-warehouse-infra --namespace atlas-warehouse --create-namespace --wait",
        "helm upgrade --install atlas-warehouse-operator oci://ghcr.io/astro-survey-atlas/charts/atlas-warehouse-operator --namespace atlas-system --create-namespace --set 'watchNamespaces[0]=asa-workspace' --wait",
        "随后在 Workspace Chart 中启用 dataWarehouse 并滚动更新。",
      ];
    }
    if (this.#channel === "docker") return ["等待本地执行面（gateway/worker）发布后支持一键安装。"];
    if (this.#channel === "desktop") return ["Windows 桌面端当前仅支持连接远程 Warehouse。"];
    return ["裸进程部署请参照 Warehouse 仓库文档手动安装。"];
  }

  #uninstallGuidance(): string[] {
    if (this.#channel !== "helm") return ["请联系管理员在宿主机/集群执行卸载。"];
    return [
      "helm uninstall atlas-warehouse-operator --namespace atlas-system",
      "helm uninstall atlas-warehouse --namespace atlas-warehouse",
      "注意：默认保留 PVC 与索引数据；如需清除数据请单独人工确认。",
    ];
  }

  #blockedOperation(intent: WarehouseInstallationIntent, reason: string, guidance: string[]): InstallationOperation {
    return { id: this.#operationId(), packageId: "warehouse", intent, status: "blocked", reason, guidance, createdAt: now() };
  }

  #operationId(): string {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `inst_${stamp}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }

  async #persist(): Promise<void> {
    const state: InstallationState = { schemaVersion: 1, desired: this.#desired, operations: this.#operations };
    await mkdir(this.#root, { recursive: true });
    const tmp = `${this.#statePath}.tmp`;
    const run = (async () => {
      await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.#statePath);
    })();
    this.#writing = this.#writing.then(() => run, () => run);
    await this.#writing;
  }
}
