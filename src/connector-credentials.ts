import { readFile } from "node:fs/promises";

export interface StoredConnectorCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
}

export interface ConnectorCredentialStore {
  managedReference(connectorId: string): string;
  isManaged(reference: string): boolean;
  get(reference: string): Promise<StoredConnectorCredentials | undefined>;
  put(reference: string, credentials: StoredConnectorCredentials): Promise<void>;
  remove(reference: string): Promise<void>;
}

const MANAGED_SECRET_PREFIX = "astro-connector-";
const ACCESS_KEY_NAMES = ["access-key", "s3-access-key", "root-user"];
const SECRET_KEY_NAMES = ["secret-key", "s3-access-secret", "root-password"];
const ENDPOINT_NAMES = ["s3-endpoint"];

function parseReference(reference: string): { namespace: string; name: string } {
  const [namespace, name, ...extra] = reference.split("/");
  if (!namespace || !name || extra.length || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace) || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    throw new RangeError("Invalid internal credential reference");
  }
  return { namespace, name };
}

function decodeFirst(data: Record<string, string>, names: readonly string[]): string {
  const encoded = names.map((name) => data[name]).find(Boolean);
  return encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
}

function managedSecretName(connectorId: string): string {
  const suffix = connectorId.replace(/^connector-/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (!suffix) throw new RangeError("Connector id cannot produce a managed credential name");
  return `${MANAGED_SECRET_PREFIX}${suffix}`.slice(0, 63).replace(/-+$/g, "");
}

export class MemoryConnectorCredentialStore implements ConnectorCredentialStore {
  readonly #namespace: string;
  readonly #values = new Map<string, StoredConnectorCredentials>();

  constructor(namespace = "astro-data-workspace") {
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

interface KubernetesSecret {
  data?: Record<string, string>;
}

export class KubernetesConnectorCredentialStore implements ConnectorCredentialStore {
  readonly #namespace: string;
  readonly #apiUrl: string;
  readonly #tokenPath: string;

  constructor(options: { namespace: string; apiUrl?: string; tokenPath?: string }) {
    this.#namespace = options.namespace;
    this.#apiUrl = (options.apiUrl ?? "https://kubernetes.default.svc").replace(/\/+$/, "");
    this.#tokenPath = options.tokenPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/token";
  }

  managedReference(connectorId: string): string {
    return `${this.#namespace}/${managedSecretName(connectorId)}`;
  }

  isManaged(reference: string): boolean {
    const parsed = parseReference(reference);
    return parsed.namespace === this.#namespace && parsed.name.startsWith(MANAGED_SECRET_PREFIX);
  }

  async get(reference: string): Promise<StoredConnectorCredentials | undefined> {
    const { namespace, name } = parseReference(reference);
    const result = await this.#request("GET", `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`);
    if (result.status === 404) return undefined;
    if (!result.ok) throw new Error(`Unable to read saved connector credentials (HTTP ${result.status})`);
    const secret = await result.json() as KubernetesSecret;
    const data = secret.data ?? {};
    const accessKeyId = decodeFirst(data, ACCESS_KEY_NAMES);
    const secretAccessKey = decodeFirst(data, SECRET_KEY_NAMES);
    if (!accessKeyId || !secretAccessKey) return undefined;
    return { accessKeyId, secretAccessKey, endpoint: decodeFirst(data, ENDPOINT_NAMES) };
  }

  async put(reference: string, credentials: StoredConnectorCredentials): Promise<void> {
    if (!this.isManaged(reference)) throw new RangeError("Managed credentials must use the workspace namespace and name prefix");
    const { namespace, name } = parseReference(reference);
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`;
    const current = await this.#request("GET", path);
    const body = {
      metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "astro-data-workspace", "astro.zhejianglab.org/connector-credential": "true" } },
      type: "Opaque",
      stringData: {
        "access-key": credentials.accessKeyId,
        "secret-key": credentials.secretAccessKey,
        "s3-endpoint": credentials.endpoint,
      },
    };
    const result = current.status === 404
      ? await this.#request("POST", `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`, body)
      : await this.#request("PATCH", path, body, "application/merge-patch+json");
    if (!result.ok) throw new Error(`Unable to save connector credentials (HTTP ${result.status})`);
  }

  async remove(reference: string): Promise<void> {
    if (!this.isManaged(reference)) return;
    const { namespace, name } = parseReference(reference);
    const result = await this.#request("DELETE", `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`);
    if (!result.ok && result.status !== 404) throw new Error(`Unable to remove connector credentials (HTTP ${result.status})`);
  }

  async #request(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<Response> {
    const token = (await readFile(this.#tokenPath, "utf8")).trim();
    return fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": contentType }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  }
}

export function createConnectorCredentialStore(): ConnectorCredentialStore {
  const namespace = process.env.POD_NAMESPACE ?? "astro-data-workspace";
  if (!process.env.KUBERNETES_SERVICE_HOST) return new MemoryConnectorCredentialStore(namespace);
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT ?? "443";
  return new KubernetesConnectorCredentialStore({ namespace, apiUrl: `https://${host}:${port}` });
}
