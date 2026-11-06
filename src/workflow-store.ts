import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { LocalState } from "./local-state.js";
import type { AgentSession, WorkflowArtifact, WorkflowDefinition, WorkflowRun } from "./workflow.js";

const MAX_PREVIEW_ROWS = 20;
const MAX_ARTIFACT_ROWS = 5_000;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

function now(): string {
  return new Date().toISOString();
}

function assertId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new RangeError(`Invalid ${label}: ${value}`);
}

function mergeArtifacts(...collections: WorkflowArtifact[][]): WorkflowArtifact[] {
  const artifacts = new Map<string, WorkflowArtifact>();
  for (const collection of collections) {
    for (const artifact of collection) {
      const current = artifacts.get(artifact.name);
      if (!current || artifact.createdAt >= current.createdAt) artifacts.set(artifact.name, structuredClone(artifact));
    }
  }
  return [...artifacts.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export class WorkflowStore {
  readonly sessionsRoot: string;
  readonly #runs = new Map<string, WorkflowRun>();
  readonly #sessions = new Map<string, AgentSession>();
  readonly #writes = new Map<string, Promise<void>>();
  readonly #artifactWrites = new Map<string, Promise<void>>();

  readonly #state: LocalState;
  constructor(readonly root: string, state?: LocalState) {
    this.#state = state ?? new LocalState(path.join(root, "control.sqlite"));
    this.sessionsRoot = path.join(root, "_agent-sessions");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.#state.initialize();
    const runs = await this.list();
    for (const run of runs) this.#runs.set(run.id, structuredClone(run));
    for (const run of runs) {
      if (run.status === "running" && run.resume?.kind !== "human_filter") {
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
  }

  async create(definition: WorkflowDefinition, input: Record<string, unknown>, traceparent?: string, agentInitiated = false): Promise<WorkflowRun> {
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
      ...(traceparent ? { traceparent } : {}),
      ...(agentInitiated ? { agentInitiated: true } : {}),
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
    await this.save(run);
    return structuredClone(run);
  }

  async save(run: WorkflowRun): Promise<void> {
    assertId(run.id, "workflow run id");
    if (run.preview.length > MAX_PREVIEW_ROWS) throw new RangeError(`Workflow preview cannot exceed ${MAX_PREVIEW_ROWS} rows`);
    const latest = this.#runs.get(run.id);
    run.artifacts = mergeArtifacts(run.artifacts, latest?.artifacts ?? []);
    run.lineage.artifacts = run.artifacts.map((candidate) => ({
      name: candidate.name,
      sha256: candidate.sha256,
      rowCount: candidate.rowCount,
    }));
    run.updatedAt = now();
    run.events = run.events.slice(-200);
    const snapshot = structuredClone(run);
    this.#runs.set(run.id, snapshot);
    this.#state.put("workflow-runs", run.id, snapshot);
  }

  async get(id: string): Promise<WorkflowRun> {
    assertId(id, "workflow run id");
    const run = this.#state.get<WorkflowRun>("workflow-runs", id);
    if (!run) throw new Error(`Workflow run not found: ${id}`);
    return run;
  }

  async list(): Promise<WorkflowRun[]> {
    return this.#state.list<WorkflowRun>("workflow-runs", 100_000)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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

  async writeArtifactForRun(
    runId: string,
    name: string,
    mediaType: string,
    rowCount: number,
    content: string | Buffer,
  ): Promise<WorkflowArtifact> {
    const [artifact] = await this.writeArtifactsForRun(runId, [{ name, mediaType, rowCount, content }]);
    if (!artifact) throw new Error("Workflow artifact was not written");
    return artifact;
  }

  async writeArtifactsForRun(
    runId: string,
    inputs: Array<{ name: string; mediaType: string; rowCount: number; content: string | Buffer }>,
  ): Promise<WorkflowArtifact[]> {
    const previous = this.#artifactWrites.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#artifactWrites.set(runId, current);
    await previous.catch(() => undefined);
    try {
      const run = await this.get(runId);
      const artifacts: WorkflowArtifact[] = [];
      for (const input of inputs) {
        artifacts.push(await this.writeArtifact(run, input.name, input.mediaType, input.rowCount, input.content, false));
      }
      const latest = this.#runs.get(runId) ?? run;
      const snapshot = structuredClone(latest);
      snapshot.artifacts = mergeArtifacts(snapshot.artifacts, artifacts);
      snapshot.lineage.artifacts = snapshot.artifacts.map((candidate) => ({
        name: candidate.name,
        sha256: candidate.sha256,
        rowCount: candidate.rowCount,
      }));
      snapshot.updatedAt = now();
      this.#runs.set(runId, snapshot);
      this.#state.put("workflow-runs", runId, snapshot);
      return artifacts;
    } finally {
      if (this.#artifactWrites.get(runId) === current) this.#artifactWrites.delete(runId);
      release();
    }
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

  async artifactPaths(runId: string, names: readonly string[]): Promise<Array<{ artifact: WorkflowArtifact; filePath: string }>> {
    const run = await this.get(runId);
    const byName = new Map(run.artifacts.map(artifact => [artifact.name, artifact]));
    const files: Array<{ artifact: WorkflowArtifact; filePath: string }> = [];
    for (const name of names) {
      assertId(name, "artifact name");
      const artifact = byName.get(name);
      if (!artifact) throw new Error(`Workflow artifact not found: ${runId}/${name}`);
      const filePath = path.join(this.root, run.id, name);
      files.push({ artifact, filePath });
    }
    for (let offset = 0; offset < files.length; offset += 16) {
      await Promise.all(files.slice(offset, offset + 16).map(async ({ artifact, filePath }) => {
        const details = await stat(filePath);
        if (!details.isFile() || details.size !== artifact.byteLength) throw new Error(`Workflow artifact size mismatch: ${artifact.name}`);
      }));
    }
    return files;
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
    await this.saveSession(session);
    return structuredClone(session);
  }

  async saveSession(session: AgentSession): Promise<void> {
    assertId(session.id, "agent session id");
    session.updatedAt = now();
    session.messages = session.messages.slice(-100);
    const snapshot = structuredClone(session);
    this.#sessions.set(session.id, snapshot);
    this.#state.put("workflow-sessions", session.id, snapshot);
  }

  async getSession(id: string): Promise<AgentSession> {
    assertId(id, "agent session id");
    const session = this.#state.get<AgentSession>("workflow-sessions", id);
    if (!session) throw new Error(`Agent session not found: ${id}`);
    return session;
  }

  async flush(): Promise<void> {}
  close(): void { this.#state.close(); }
}
