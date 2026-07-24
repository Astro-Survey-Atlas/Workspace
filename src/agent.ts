import { randomUUID } from "node:crypto";

import type { WorkflowEngine } from "./workflow-engine.js";
import { EUCLID_DESI_WORKFLOW_KEY } from "./workflow-engine.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { AgentMessage, AgentSession, WorkflowRun } from "./workflow.js";

export type AgentIntent =
  | { type: "create_run"; input: Record<string, unknown> }
  | { type: "accept_all" }
  | { type: "retry" }
  | { type: "adjust_region"; input: Record<string, unknown> }
  | { type: "filter"; filter: Record<string, unknown> }
  | { type: "unknown" };

function firstNumber(message: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1] !== undefined) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
  }
  return undefined;
}

export function parseAgentIntent(message: string, hasActiveRun = false): AgentIntent {
  const text = message.trim();
  if (/重试|retry/i.test(text)) return { type: "retry" };
  if (/全部保留|保留全部|无需筛选|accept\s+all/i.test(text)) return { type: "accept_all" };
  const separation = firstNumber(text, [/(?:分离角|separation)\s*(?:小于|不超过|<=|<)\s*(\d+(?:\.\d+)?)/i]);
  if (separation !== undefined && hasActiveRun) {
    return { type: "filter", filter: { logic: "and", conditions: [{ field: "separationArcsec", op: "<=", value: separation }] } };
  }
  const ra = firstNumber(text, [/(?:\bRA|赤经)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i]);
  const dec = firstNumber(text, [/(?:\bDEC|赤纬)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i]);
  const pair = text.match(/(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/);
  const raDeg = ra ?? (pair ? Number(pair[1]) : undefined);
  const decDeg = dec ?? (pair ? Number(pair[2]) : undefined);
  const queryRadiusArcsec = firstNumber(text, [/(?:检索|查询|搜索)(?:半径|范围)\s*[:=]?\s*(\d+(?:\.\d+)?)/i, /query\s*radius\s*[:=]?\s*(\d+(?:\.\d+)?)/i]);
  const matchRadiusArcsec = firstNumber(text, [/(?:匹配半径|匹配口径)\s*[:=]?\s*(\d+(?:\.\d+)?)/i, /match(?:ing)?\s*radius\s*[:=]?\s*(\d+(?:\.\d+)?)/i]);
  const limit = firstNumber(text, [/(?:上限|最多|limit)\s*[:=]?\s*(\d+)/i]);
  const input: Record<string, unknown> = {};
  if (raDeg !== undefined) input.raDeg = raDeg;
  if (decDeg !== undefined) input.decDeg = decDeg;
  if (queryRadiusArcsec !== undefined) input.queryRadiusArcsec = queryRadiusArcsec;
  if (matchRadiusArcsec !== undefined) input.matchRadiusArcsec = matchRadiusArcsec;
  if (limit !== undefined) input.limit = limit;
  if (raDeg !== undefined && decDeg !== undefined) return { type: "create_run", input };
  if (hasActiveRun && Object.keys(input).length > 0 && /调整|扩大|缩小|改为|change/i.test(text)) return { type: "adjust_region", input };
  return { type: "unknown" };
}

function message(role: AgentMessage["role"], content: string, runId?: string): AgentMessage {
  return { id: randomUUID(), role, content, createdAt: new Date().toISOString(), runId };
}

export class AgentService {
  constructor(private readonly store: WorkflowStore, private readonly engine: WorkflowEngine) {}

  createSession(workflowKey = EUCLID_DESI_WORKFLOW_KEY): Promise<AgentSession> {
    this.engine.workflows.get(workflowKey);
    return this.store.createSession(workflowKey);
  }

  async sendMessage(sessionId: string, contentValue: unknown): Promise<{ session: AgentSession; run?: WorkflowRun }> {
    const content = String(contentValue ?? "").trim();
    if (!content || content.length > 2_000) throw new RangeError("Agent message must contain between 1 and 2000 characters");
    const session = await this.store.getSession(sessionId);
    let activeRun: WorkflowRun | undefined;
    if (session.activeRunId) activeRun = await this.store.get(session.activeRunId).catch(() => undefined);
    session.messages.push(message("user", content, activeRun?.id));
    const intent = parseAgentIntent(content, Boolean(activeRun));
    let reply: string;
    let run = activeRun;
    if (intent.type === "create_run") {
      run = await this.engine.createRun(session.workflowKey, intent.input);
      session.activeRunId = run.id;
      reply = `已创建 ${run.id}。将查询真实 Euclid 与 DESI 目录，匹配半径 ${run.input.matchRadiusArcsec} 角秒。`;
    } else if (intent.type === "accept_all" && run) {
      run = await this.engine.decide(run.id, { action: "accept_all" });
      reply = "已提交“全部保留”，正在生成受限导出与血缘记录。";
    } else if (intent.type === "filter" && run) {
      run = await this.engine.decide(run.id, { action: "apply_filter", filter: intent.filter });
      reply = "筛选条件已由确定性函数执行，结果和导出已更新。";
    } else if (intent.type === "adjust_region" && run) {
      run = await this.engine.decide(run.id, { action: "adjust_region", input: intent.input });
      reply = "查询区域已调整，正在重新访问真实目录。";
    } else if (intent.type === "retry" && run) {
      run = await this.engine.decide(run.id, { action: "retry" });
      reply = "失败任务已重新进入队列。";
    } else {
      reply = run
        ? "当前任务可继续筛选、全部保留、调整区域或在失败后重试。筛选示例：分离角小于 1.0。"
        : "请给出 RA 与 Dec，例如：RA 150.1 Dec 2.2，匹配半径 1.5，查询半径 600。";
    }
    session.messages.push(message("assistant", reply, run?.id));
    void this.store.saveSession(session).catch((error) => console.error(`Failed to persist agent session ${session.id}`, error));
    return { session, run };
  }
}
