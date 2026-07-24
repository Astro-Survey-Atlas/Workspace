export type ToolKind = "local" | "mcp";
export type ToolHealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export interface ToolHealth {
  status: ToolHealthStatus;
  detail: string;
  checkedAt?: string;
}

export interface ToolDescriptor {
  id: string;
  title: string;
  description: string;
  kind: ToolKind;
  version: string;
  inputSchema: Record<string, unknown>;
  health: ToolHealth;
}

export interface ToolInvocationContext {
  runId: string;
  stepId: string;
}

export type ToolHandler = (input: unknown, context: ToolInvocationContext) => Promise<unknown>;

interface RegisteredTool {
  descriptor: ToolDescriptor;
  handler: ToolHandler;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register(descriptor: ToolDescriptor, handler: ToolHandler): void {
    if (this.#tools.has(descriptor.id)) throw new Error(`Tool already registered: ${descriptor.id}`);
    this.#tools.set(descriptor.id, { descriptor: structuredClone(descriptor), handler });
  }

  list(): ToolDescriptor[] {
    return [...this.#tools.values()].map(({ descriptor }) => structuredClone(descriptor));
  }

  get(id: string): ToolDescriptor {
    const registered = this.#tools.get(id);
    if (!registered) throw new Error(`Tool not found: ${id}`);
    return structuredClone(registered.descriptor);
  }

  updateHealth(id: string, health: ToolHealth): void {
    const registered = this.#tools.get(id);
    if (!registered) throw new Error(`Tool not found: ${id}`);
    registered.descriptor.health = structuredClone(health);
  }

  async invoke(id: string, input: unknown, context: ToolInvocationContext): Promise<unknown> {
    const registered = this.#tools.get(id);
    if (!registered) throw new Error(`Tool not found: ${id}`);
    return registered.handler(input, context);
  }
}

export type WorkflowStepKind = "tool" | "human_gate" | "export";

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  kind: WorkflowStepKind;
  toolId?: string;
  dependsOn: string[];
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  key: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  steps: WorkflowStepDefinition[];
  outputs: Array<{ name: string; mediaType: string; maxRows: number }>;
}

export function validateWorkflowDefinition(definition: WorkflowDefinition, tools?: ToolRegistry): void {
  if (definition.key !== `${definition.id}@${definition.version}`) {
    throw new Error(`Workflow key must be ${definition.id}@${definition.version}`);
  }
  const stepById = new Map<string, WorkflowStepDefinition>();
  for (const step of definition.steps) {
    if (stepById.has(step.id)) throw new Error(`Duplicate workflow step: ${step.id}`);
    if (step.kind !== "human_gate" && !step.toolId) throw new Error(`Step ${step.id} requires a tool`);
    if (step.kind === "human_gate" && step.toolId) throw new Error(`Human gate ${step.id} cannot declare a tool`);
    if (step.toolId && tools) tools.get(step.toolId);
    stepById.set(step.id, step);
  }
  for (const step of definition.steps) {
    for (const dependency of step.dependsOn) {
      if (!stepById.has(dependency)) throw new Error(`Step ${step.id} depends on missing step ${dependency}`);
      if (dependency === step.id) throw new Error(`Step ${step.id} cannot depend on itself`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) throw new Error(`Workflow contains a cycle at ${stepId}`);
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const dependency of stepById.get(stepId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of definition.steps) visit(step.id);
}

export class WorkflowRegistry {
  readonly #definitions = new Map<string, WorkflowDefinition>();

  constructor(private readonly tools: ToolRegistry) {}

  register(definition: WorkflowDefinition): void {
    validateWorkflowDefinition(definition, this.tools);
    if (this.#definitions.has(definition.key)) throw new Error(`Workflow already registered: ${definition.key}`);
    this.#definitions.set(definition.key, structuredClone(definition));
  }

  list(): WorkflowDefinition[] {
    return [...this.#definitions.values()].map((definition) => structuredClone(definition));
  }

  get(key: string): WorkflowDefinition {
    const definition = this.#definitions.get(key);
    if (!definition) throw new Error(`Workflow not found: ${key}`);
    return structuredClone(definition);
  }
}

export type WorkflowRunStatus = "queued" | "running" | "waiting_for_input" | "succeeded" | "failed";
export type WorkflowStepStatus = "pending" | "running" | "waiting_for_input" | "succeeded" | "failed" | "skipped";

export interface WorkflowStepRun {
  id: string;
  title: string;
  kind: WorkflowStepKind;
  toolId?: string;
  status: WorkflowStepStatus;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  outputSummary?: Record<string, unknown>;
  error?: string;
}

export interface WorkflowRunEvent {
  at: string;
  type: "status" | "step" | "tool" | "decision";
  stepId?: string;
  message: string;
  durationMs?: number;
}

export interface WorkflowArtifact {
  name: string;
  mediaType: string;
  rowCount: number;
  byteLength: number;
  sha256: string;
  createdAt: string;
}

export interface WorkflowLineage {
  sources: Array<{ catalog: string; querySha256: string; rowCount: number }>;
  artifacts: Array<{ name: string; sha256: string; rowCount: number }>;
  relatedScanRunIds: string[];
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowVersion: number;
  workflowKey: string;
  status: WorkflowRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  input: Record<string, unknown>;
  steps: WorkflowStepRun[];
  events: WorkflowRunEvent[];
  summary: Record<string, unknown>;
  preview: Array<Record<string, unknown>>;
  artifacts: WorkflowArtifact[];
  lineage: WorkflowLineage;
  waiting?: {
    reason: "filter" | "region_adjust";
    stepId: string;
    message: string;
    availableFields: string[];
  };
  error?: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  runId?: string;
}

export interface AgentSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  workflowKey: string;
  activeRunId?: string;
  capabilities: { ruleInterpreter: true; llm: false };
  messages: AgentMessage[];
}
