import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentSession, WorkflowArtifact, WorkflowDefinition, WorkflowRun } from "./workflow.js";

const MAX_PREVIEW_ROWS = 20;
const MAX_ARTIFACT_ROWS = 1_000;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_RUNS = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function now(): string {
  return new Date().toISOString();
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EACCES") || attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 8 * (attempt + 1)));
    }
  }
}

function assertId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new RangeError(`Invalid ${label}: ${value}`);
}

export class WorkflowStore {
  readonly sessionsRoot: string;
  readonly #runs = new Map<string, WorkflowRun>();
  readonly #sessions = new Map<string, AgentSession>();
  readonly #writes = new Map<string, Promise<void>>();

  constructor(readonly root: string) {
    this.sessionsRoot = path.join(root, "_agent-sessions");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.sessionsRoot, { recursive: true });
    const runs = await this.loadRunsFromDisk();
    for (const run of runs) this.#runs.set(run.id, structuredClone(run));
    for (const run of runs) {
      if (run.status === "queued" || run.status === "running") {
        run.status = "failed";
        run.error = "Service restarted before the workflow completed";
        run.completedAt = now();
        run.events.push({ at: run.completedAt, type: "status", message: "运行因服务重启而中断" });
        for (const step of run.steps) {
          if (step.status === "running") {
            step.status = "failed";
            step.error = run.error;
            step.completedAt = run.completedAt;
          }
        }
        await this.save(run);
      }
    }
    await this.prune();
  }

  async create(definition: WorkflowDefinition, input: Record<string, unknown>): Promise<WorkflowRun> {
    const createdAt = now();
    const run: WorkflowRun = {
      id: `wfr_${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`,
      workflowId: definition.id,
      workflowVersion: definition.version,
      workflowKey: definition.key,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      input: structuredClone(input),
      steps: definition.steps.map((step) => ({
        id: step.id,
        title: step.title,
        kind: step.kind,
        toolId: step.toolId,
        status: "pending",
        attempts: 0,
      })),
      events: [{ at: createdAt, type: "status", message: "运行已进入队列" }],
      summary: {},
      preview: [],
      artifacts: [],
      lineage: { sources: [], artifacts: [], relatedScanRunIds: [] },
    };
    void this.save(run).catch((error) => console.error(`Failed to persist new workflow run ${run.id}`, error));
    void this.prune().catch((error) => console.error("Failed to prune workflow runs", error));
    return structuredClone(run);
  }

  async save(run: WorkflowRun): Promise<void> {
    assertId(run.id, "workflow run id");
    if (run.preview.length > MAX_PREVIEW_ROWS) throw new RangeError(`Workflow preview cannot exceed ${MAX_PREVIEW_ROWS} rows`);
    run.updatedAt = now();
    run.events = run.events.slice(-200);
    const snapshot = structuredClone(run);
    this.#runs.set(run.id, snapshot);
    await this.serializedJsonWrite(`run:${run.id}`, path.join(this.root, `${run.id}.json`), snapshot);
  }

  async get(id: string): Promise<WorkflowRun> {
    assertId(id, "workflow run id");
    const cached = this.#runs.get(id);
    if (cached) return structuredClone(cached);
    try {
      const run = JSON.parse(await readFile(path.join(this.root, `${id}.json`), "utf8")) as WorkflowRun;
      this.#runs.set(id, structuredClone(run));
      return run;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Workflow run not found: ${id}`);
      throw error;
    }
  }

  async list(): Promise<WorkflowRun[]> {
    return [...this.#runs.values()]
      .map((run) => structuredClone(run))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async loadRunsFromDisk(): Promise<WorkflowRun[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const runs: WorkflowRun[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      runs.push(JSON.parse(await readFile(path.join(this.root, entry.name), "utf8")) as WorkflowRun);
    }
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async writeArtifact(
    run: WorkflowRun,
    name: string,
    mediaType: string,
    rowCount: number,
    content: string | Buffer,
    persist = true,
  ): Promise<WorkflowArtifact> {
    assertId(run.id, "workflow run id");
    assertId(name, "artifact name");
    if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > MAX_ARTIFACT_ROWS) {
      throw new RangeError(`Artifact rows must be between 0 and ${MAX_ARTIFACT_ROWS}`);
    }
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    if (buffer.byteLength > MAX_ARTIFACT_BYTES) throw new RangeError(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    await mkdir(path.join(this.root, run.id), { recursive: true });
    const filePath = path.join(this.root, run.id, name);
    await writeFile(filePath, buffer);
    const artifact: WorkflowArtifact = {
      name,
      mediaType,
      rowCount,
      byteLength: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      createdAt: now(),
    };
    run.artifacts = [...run.artifacts.filter((candidate) => candidate.name !== name), artifact];
    run.lineage.artifacts = run.artifacts.map((candidate) => ({
      name: candidate.name,
      sha256: candidate.sha256,
      rowCount: candidate.rowCount,
    }));
    if (persist) await this.save(run);
    return artifact;
  }

  async artifactPath(runId: string, name: string): Promise<{ run: WorkflowRun; artifact: WorkflowArtifact; filePath: string }> {
    assertId(name, "artifact name");
    const run = await this.get(runId);
    const artifact = run.artifacts.find((candidate) => candidate.name === name);
    if (!artifact) throw new Error(`Workflow artifact not found: ${runId}/${name}`);
    const filePath = path.join(this.root, run.id, name);
    const details = await stat(filePath);
    if (details.size !== artifact.byteLength) throw new Error(`Workflow artifact size mismatch: ${name}`);
    return { run, artifact, filePath };
  }

  async readArtifact(runId: string, name: string): Promise<string> {
    const artifact = await this.artifactPath(runId, name);
    return readFile(artifact.filePath, "utf8");
  }

  async createSession(workflowKey: string): Promise<AgentSession> {
    const createdAt = now();
    const session: AgentSession = {
      id: `ags_${randomUUID()}`,
      createdAt,
      updatedAt: createdAt,
      workflowKey,
      capabilities: { ruleInterpreter: true, llm: false },
      messages: [{
        id: randomUUID(),
        role: "assistant",
        content: "已连接确定性工作流。请给出 RA、Dec；匹配半径默认 1.5 角秒。",
        createdAt,
      }],
    };
    void this.saveSession(session).catch((error) => console.error(`Failed to persist new agent session ${session.id}`, error));
    return structuredClone(session);
  }

  async saveSession(session: AgentSession): Promise<void> {
    assertId(session.id, "agent session id");
    session.updatedAt = now();
    session.messages = session.messages.slice(-100);
    const snapshot = structuredClone(session);
    this.#sessions.set(session.id, snapshot);
    await this.serializedJsonWrite(`session:${session.id}`, path.join(this.sessionsRoot, `${session.id}.json`), snapshot);
  }

  async getSession(id: string): Promise<AgentSession> {
    assertId(id, "agent session id");
    const cached = this.#sessions.get(id);
    if (cached) return structuredClone(cached);
    try {
      const session = JSON.parse(await readFile(path.join(this.sessionsRoot, `${id}.json`), "utf8")) as AgentSession;
      this.#sessions.set(id, structuredClone(session));
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Agent session not found: ${id}`);
      throw error;
    }
  }

  async flush(): Promise<void> {
    while (this.#writes.size > 0) {
      await Promise.allSettled([...this.#writes.values()]);
    }
  }

  private async prune(): Promise<void> {
    const runs = await this.list();
    const cutoff = Date.now() - MAX_AGE_MS;
    const expired = runs.filter((run, index) => index >= MAX_RUNS || Date.parse(run.createdAt) < cutoff);
    for (const run of expired) {
      this.#runs.delete(run.id);
      await rm(path.join(this.root, `${run.id}.json`), { force: true });
      await rm(path.join(this.root, run.id), { recursive: true, force: true });
    }
  }

  private async serializedJsonWrite(key: string, filePath: string, value: unknown): Promise<void> {
    const previous = this.#writes.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => atomicJson(filePath, value));
    this.#writes.set(key, current);
    try {
      await current;
    } finally {
      if (this.#writes.get(key) === current) this.#writes.delete(key);
    }
  }
}
