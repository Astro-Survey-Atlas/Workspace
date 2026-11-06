import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredConnectorCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  sessionToken?: string;
}

export interface ConnectorCredentialStore {
  managedReference(connectorId: string): string;
  isManaged(reference: string): boolean;
  get(reference: string): Promise<StoredConnectorCredentials | undefined>;
  put(reference: string, credentials: StoredConnectorCredentials): Promise<void>;
  remove(reference: string): Promise<void>;
}

const MANAGED_SECRET_PREFIX = "astro-connector-";
function parseReference(reference: string): { namespace: string; name: string } {
  const [namespace, name, ...extra] = reference.split("/");
  if (!namespace || !name || extra.length || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace) || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    throw new RangeError("Invalid internal credential reference");
  }
  return { namespace, name };
}

function managedSecretName(connectorId: string): string {
  const suffix = connectorId.replace(/^connector-/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (!suffix) throw new RangeError("Connector id cannot produce a managed credential name");
  return `${MANAGED_SECRET_PREFIX}${suffix}`.slice(0, 63).replace(/-+$/g, "");
}

export class MemoryConnectorCredentialStore implements ConnectorCredentialStore {
  readonly #namespace: string;
  readonly #values = new Map<string, StoredConnectorCredentials>();

  constructor(namespace = "asa-workspace") {
    this.#namespace = namespace;
  }

  managedReference(connectorId: string): string {
    return `${this.#namespace}/${managedSecretName(connectorId)}`;
  }

  isManaged(reference: string): boolean {
    const parsed = parseReference(reference);
    return parsed.namespace === this.#namespace && parsed.name.startsWith(MANAGED_SECRET_PREFIX);
  }

  async get(reference: string): Promise<StoredConnectorCredentials | undefined> {
    const value = this.#values.get(reference);
    return value ? structuredClone(value) : undefined;
  }

  async put(reference: string, credentials: StoredConnectorCredentials): Promise<void> {
    if (!this.isManaged(reference)) throw new RangeError("Managed credentials must use the workspace namespace and name prefix");
    this.#values.set(reference, structuredClone(credentials));
  }

  async remove(reference: string): Promise<void> {
    if (this.isManaged(reference)) this.#values.delete(reference);
  }
}

interface FileCredentialState {
  version: 1;
  values: Record<string, StoredConnectorCredentials>;
}

export class FileConnectorCredentialStore implements ConnectorCredentialStore {
  readonly #namespace: string;
  readonly #filePath: string;
  #state: FileCredentialState = { version: 1, values: {} };
  #initialized?: Promise<void>;
  #writes: Promise<void> = Promise.resolve();

  constructor(options: { namespace: string; filePath: string }) {
    this.#namespace = options.namespace;
    this.#filePath = path.resolve(options.filePath);
  }

  managedReference(connectorId: string): string {
    return `${this.#namespace}/${managedSecretName(connectorId)}`;
  }

  isManaged(reference: string): boolean {
    const parsed = parseReference(reference);
    return parsed.namespace === this.#namespace && parsed.name.startsWith(MANAGED_SECRET_PREFIX);
  }

  async get(reference: string): Promise<StoredConnectorCredentials | undefined> {
    // The API writes credentials; an already-running worker must see those writes.
    await this.#writes;
    try {
      const record = JSON.parse(await readFile(this.#filePath, "utf8")) as FileCredentialState;
      const value = record.values?.[reference];
      return value ? structuredClone(value) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(reference: string, credentials: StoredConnectorCredentials): Promise<void> {
    await this.#initialize();
    if (!this.isManaged(reference)) throw new RangeError("Managed credentials must use the workspace namespace and name prefix");
    this.#state.values[reference] = structuredClone(credentials);
    await this.#persist();
  }

  async remove(reference: string): Promise<void> {
    await this.#initialize();
    if (!this.isManaged(reference)) return;
    delete this.#state.values[reference];
    await this.#persist();
  }

  async #initialize(): Promise<void> {
    this.#initialized ??= (async () => {
      try {
        const state = JSON.parse(await readFile(this.#filePath, "utf8")) as Partial<FileCredentialState>;
        if (state.version === 1 && state.values && typeof state.values === "object") this.#state = { version: 1, values: state.values };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    })();
    await this.#initialized;
  }

  async #persist(): Promise<void> {
    const state = structuredClone(this.#state);
    const next = this.#writes.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temporary = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, this.#filePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.#writes = next.catch(() => undefined);
    await next;
  }
}

export function createConnectorCredentialStore(stateRoot = process.env.ASTRO_STATE_ROOT ?? "data"): ConnectorCredentialStore {
  return new FileConnectorCredentialStore({ namespace: process.env.POD_NAMESPACE ?? "asa-workspace", filePath: path.join(stateRoot, "connector-credentials.json") });
}
