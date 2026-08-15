import { access, constants, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** The container path recommended for a read-only local data mount. */
export const RECOMMENDED_LOCAL_CONNECTOR_ROOT = "/data/local";

export type LocalConnectorPathFailure =
  | "not-configured"
  | "not-absolute"
  | "outside-root"
  | "unavailable"
  | "not-directory"
  | "not-file"
  | "not-readable";

const LOCAL_CONNECTOR_ERROR_MESSAGES: Record<LocalConnectorPathFailure, string> = {
  "not-configured": "Local connectors are unavailable: ASTRO_LOCAL_CONNECTOR_ROOTS is not configured",
  "not-absolute": "Local connector path must be an absolute container path",
  "outside-root": "Local connector path is outside the configured local roots",
  unavailable: "Local connector path is unavailable or inaccessible",
  "not-directory": "Local connector path must be a readable directory",
  "not-file": "SQLite database path must be a readable file",
  "not-readable": "Local connector path is not readable",
};

export class LocalConnectorPolicyError extends Error {
  readonly failure: LocalConnectorPathFailure;
  readonly statusCode: number;

  constructor(failure: LocalConnectorPathFailure) {
    super(LOCAL_CONNECTOR_ERROR_MESSAGES[failure]);
    this.name = "LocalConnectorPolicyError";
    this.failure = failure;
    this.statusCode = failure === "not-configured" ? 503 : 400;
  }
}

export interface LocalConnectorRootDescriptor {
  /** Public container path. Never use this field for host-side error text. */
  containerPath: string;
  /** Optional host-side path used by tests or an explicit composition mapping. */
  hostPath?: string;
  id?: string;
  label?: string;
}

export interface LocalConnectorRootInfo {
  id: string;
  label: string;
  containerPath: string;
  available: boolean;
  readOnly: true;
}

export function publicLocalConnectorRoot(root: LocalConnectorRootInfo): LocalConnectorRootInfo {
  const { id, label, containerPath, available, readOnly } = root;
  return { id, label, containerPath, available, readOnly };
}

export function localConnectorRootsResponse(roots: readonly LocalConnectorRootInfo[]): { roots: LocalConnectorRootInfo[] } {
  return { roots: roots.map(publicLocalConnectorRoot) };
}

interface ResolvedRoot {
  id: string;
  label: string;
  containerPath: string;
  hostPath: string;
}

interface AuthorizedPath {
  root: ResolvedRoot;
  containerPath: string;
  hostPath: string;
}

export interface LocalConnectorPathCheck {
  ok: boolean;
  failure?: LocalConnectorPathFailure;
}

/** Internal filesystem resolution. API responses must never expose fileSystemPath. */
export interface ResolvedLocalConnectorPath {
  containerPath: string;
  fileSystemPath: string;
}

export interface LocalConnectorFileSystem {
  access(path: string, mode?: number): Promise<void>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

const LOCAL_FILE_SYSTEM: LocalConnectorFileSystem = { access, realpath, stat };

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function normalizedAbsolutePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) throw new RangeError(`${label} must be an absolute path`);
  return path.normalize(trimmed);
}

function generatedRootId(containerPath: string): string {
  return `local-root-${createHash("sha256").update(containerPath).digest("hex").slice(0, 16)}`;
}

function generatedRootLabel(containerPath: string): string {
  if (containerPath === RECOMMENDED_LOCAL_CONNECTOR_ROOT) return "Local data";
  const base = path.basename(containerPath);
  return base && base !== path.sep ? base : containerPath;
}

function rootDescriptor(value: string | LocalConnectorRootDescriptor): ResolvedRoot {
  const descriptor = typeof value === "string" ? { containerPath: value } : value;
  if (!descriptor || typeof descriptor.containerPath !== "string" || !descriptor.containerPath.trim()) {
    throw new RangeError("ASTRO_LOCAL_CONNECTOR_ROOTS contains an empty root");
  }
  const containerPath = normalizedAbsolutePath(descriptor.containerPath, "Local connector root");
  const hostPath = normalizedAbsolutePath(descriptor.hostPath ?? containerPath, "Local connector host root");
  return {
    id: descriptor.id?.trim() || generatedRootId(containerPath),
    label: descriptor.label?.trim() || generatedRootLabel(containerPath),
    containerPath,
    hostPath,
  };
}

function pathFromEnvironment(environment: NodeJS.ProcessEnv): string[] {
  const raw = environment.ASTRO_LOCAL_CONNECTOR_ROOTS;
  if (raw === undefined || !raw.trim()) return [];
  return raw.split(path.delimiter).map((value) => value.trim()).filter(Boolean);
}

/**
 * Policy for all local connector filesystem access. The public shape contains
 * container paths only; host paths are kept private to the policy.
 */
export class LocalConnectorRootsPolicy {
  readonly #roots: ResolvedRoot[];
  readonly #fileSystem: LocalConnectorFileSystem;

  constructor(roots: readonly (string | LocalConnectorRootDescriptor)[] = [], fileSystem: LocalConnectorFileSystem = LOCAL_FILE_SYSTEM) {
    this.#fileSystem = fileSystem;
    const seen = new Set<string>();
    this.#roots = [];
    for (const value of roots) {
      const root = rootDescriptor(value);
      if (seen.has(root.containerPath)) continue;
      seen.add(root.containerPath);
      this.#roots.push(root);
    }
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): LocalConnectorRootsPolicy {
    return new LocalConnectorRootsPolicy(pathFromEnvironment(environment));
  }

  get configured(): boolean {
    return this.#roots.length > 0;
  }

  /** Return the public root status without listing or enumerating any directory. */
  async list(): Promise<LocalConnectorRootInfo[]> {
    return Promise.all(this.#roots.map(async (root) => ({
      id: root.id,
      label: root.label,
      containerPath: root.containerPath,
      available: await this.#rootAvailable(root),
      readOnly: true as const,
    })));
  }

  /** Validate only the lexical container-path boundary for registration. */
  assertConfiguredPath(containerPath: string): string {
    const authorized = this.#authorize(containerPath);
    return authorized.containerPath;
  }

  async checkDirectory(containerPath: string): Promise<LocalConnectorPathCheck> {
    return this.#check(containerPath, "directory");
  }

  async checkFile(containerPath: string): Promise<LocalConnectorPathCheck> {
    return this.#check(containerPath, "file");
  }

  async resolveReadableDirectory(containerPath: string): Promise<ResolvedLocalConnectorPath> {
    return this.#resolveReadable(containerPath, "directory");
  }

  async resolveReadableFile(containerPath: string): Promise<ResolvedLocalConnectorPath> {
    return this.#resolveReadable(containerPath, "file");
  }

  #authorize(containerPath: string): AuthorizedPath {
    if (!this.configured) throw new LocalConnectorPolicyError("not-configured");
    if (typeof containerPath !== "string" || !path.isAbsolute(containerPath.trim())) {
      throw new LocalConnectorPolicyError("not-absolute");
    }
    const normalized = path.normalize(containerPath.trim());
    // Prefer the most specific root when roots overlap.
    const root = [...this.#roots]
      .filter((candidate) => isWithinRoot(normalized, candidate.containerPath))
      .sort((left, right) => right.containerPath.length - left.containerPath.length)[0];
    if (!root) throw new LocalConnectorPolicyError("outside-root");
    const relative = path.relative(root.containerPath, normalized);
    const hostPath = relative ? path.join(root.hostPath, relative) : root.hostPath;
    return { root, containerPath: normalized, hostPath };
  }

  async #check(containerPath: string, expected: "directory" | "file"): Promise<LocalConnectorPathCheck> {
    try {
      await this.#resolveReadable(containerPath, expected);
      return { ok: true };
    } catch (error) {
      if (error instanceof LocalConnectorPolicyError) return { ok: false, failure: error.failure };
      return { ok: false, failure: "unavailable" };
    }
  }

  async #resolveReadable(containerPath: string, expected: "directory" | "file"): Promise<ResolvedLocalConnectorPath> {
    const authorized = this.#authorize(containerPath);
    try {
      const [canonicalRoot, canonicalTarget] = await Promise.all([
        this.#fileSystem.realpath(authorized.root.hostPath),
        this.#fileSystem.realpath(authorized.hostPath),
      ]);
      if (!isWithinRoot(canonicalTarget, canonicalRoot)) throw new LocalConnectorPolicyError("outside-root");
      await this.#fileSystem.access(canonicalRoot, constants.R_OK | constants.X_OK);

      const target = await this.#fileSystem.stat(canonicalTarget);
      if (expected === "directory" && !target.isDirectory()) throw new LocalConnectorPolicyError("not-directory");
      if (expected === "file" && !target.isFile()) throw new LocalConnectorPolicyError("not-file");

      const mode = expected === "directory" ? constants.R_OK | constants.X_OK : constants.R_OK;
      await this.#fileSystem.access(canonicalTarget, mode);
      if (expected === "file") await this.#fileSystem.access(path.dirname(canonicalTarget), constants.X_OK);
      return { containerPath: authorized.containerPath, fileSystemPath: canonicalTarget };
    } catch (error) {
      if (error instanceof LocalConnectorPolicyError) throw error;
      // Deliberately collapse ENOENT, EACCES, invalid symlinks, and other host
      // errors so clients never receive host paths or platform-specific errno.
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined;
      if (code === "EACCES" || code === "EPERM") throw new LocalConnectorPolicyError("not-readable");
      throw new LocalConnectorPolicyError("unavailable");
    }
  }

  async #rootAvailable(root: ResolvedRoot): Promise<boolean> {
    try {
      const canonicalRoot = await this.#fileSystem.realpath(root.hostPath);
      const details = await this.#fileSystem.stat(canonicalRoot);
      if (!details.isDirectory()) return false;
      await this.#fileSystem.access(canonicalRoot, constants.R_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export function localConnectorPolicyMessage(failure: LocalConnectorPathFailure | undefined): string {
  return LOCAL_CONNECTOR_ERROR_MESSAGES[failure ?? "unavailable"];
}
