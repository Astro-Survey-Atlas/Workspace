import { workspaceApi } from "./api";
import type { WorkspaceAgentMessage, WorkspaceAgentSession } from "../../src/workspace-agent";
import { notifyWorkspace } from "./notifications";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing agent element: ${id}`);
  return element as T;
}

export interface AgentDockContext { [key: string]: unknown; }

export class AgentDock {
  private sessions: WorkspaceAgentSession[] = [];
  private session: WorkspaceAgentSession | null = null;
  private attachedContext: AgentDockContext | undefined;
  private initialized = false;
  private sending = false;

  constructor(private readonly onError: (error: unknown) => void) {
    byId<HTMLFormElement>("agent-collapsed-form").addEventListener("submit", (event) => { event.preventDefault(); const input = byId<HTMLInputElement>("agent-collapsed-input"); void this.send(input.value, input).catch((error) => this.fail(error)); });
    byId<HTMLButtonElement>("agent-open").addEventListener("click", () => { void this.openHistory().catch((error) => this.fail(error)); });
    byId<HTMLButtonElement>("agent-collapse").addEventListener("click", () => this.setOpen(false));
    byId<HTMLButtonElement>("agent-new-session").addEventListener("click", () => void this.newSession().catch((error) => this.fail(error)));
    byId<HTMLSelectElement>("agent-session-select").addEventListener("change", () => { const selected = this.sessions.find((session) => session.id === byId<HTMLSelectElement>("agent-session-select").value); if (selected) { this.session = selected; this.render(); } });
    byId<HTMLButtonElement>("agent-collapsed-attach").addEventListener("click", () => this.attachCurrent());
    window.addEventListener("astro:agent-context", (event) => { const context = (event as CustomEvent<AgentDockContext>).detail; if (context) { this.attachedContext = context; this.renderAttachmentState(); } });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.sessions = await workspaceApi.workspaceAgentSessions();
    this.session = this.sessions[0] ?? await workspaceApi.createWorkspaceAgentSession();
    if (!this.sessions.some((candidate) => candidate.id === this.session?.id)) this.sessions.unshift(this.session);
    this.initialized = true;
    this.render();
  }

  debugState(): Record<string, unknown> { return { agentSessionId: this.session?.id, agentMessages: this.session?.messages.length ?? 0, agentOpen: document.querySelector(".workspace-shell")?.classList.contains("agent-open") ?? false }; }

  private setOpen(open: boolean): void {
    const panel = byId("agent-panel");
    panel.hidden = !open;
    document.querySelector(".workspace-shell")?.classList.toggle("agent-open", open);
    if (open) { byId<HTMLInputElement>("agent-collapsed-input").focus(); this.render(); }
  }

  private async openHistory(): Promise<void> {
    if (!this.initialized) await this.initialize();
    this.setOpen(true);
  }

  private attachCurrent(): void {
    if (this.attachedContext) {
      this.attachedContext = undefined;
      notifyWorkspace("已移除 Agent 上下文", "下一条消息不会附加当前对象", { tone: "info", dedupeMs: 2_000 });
    } else {
      this.attachedContext = { source: "workspace", attachedAt: new Date().toISOString() };
      notifyWorkspace("已附加 Workspace 上下文", "Agent 将知道这条消息来自当前工作区", { tone: "info", dedupeMs: 2_000 });
    }
    this.renderAttachmentState();
  }

  private async newSession(): Promise<void> { this.session = await workspaceApi.createWorkspaceAgentSession(); this.sessions = [this.session, ...this.sessions]; this.render(); this.setOpen(true); }

  private async send(value: string, control: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
    const message = value.trim();
    if (!message || this.sending) return;
    if (!this.initialized) await this.initialize();
    if (!this.session) return;
    this.sending = true; control.value = ""; this.setOpen(true); this.renderSending(true);
    try {
      this.session = await workspaceApi.sendWorkspaceAgentMessage(this.session.id, message, this.attachedContext);
      this.sessions = this.sessions.map((session) => session.id === this.session?.id ? this.session! : session);
      this.attachedContext = undefined;
      this.render();
    } finally { this.sending = false; this.renderSending(false); }
  }

  private renderSending(sending: boolean): void { byId<HTMLInputElement>("agent-collapsed-input").disabled = sending; }

  private render(): void {
    if (!this.session) return;
    const select = byId<HTMLSelectElement>("agent-session-select");
    select.replaceChildren(...this.sessions.map((session, index) => new Option(`会话 ${this.sessions.length - index}`, session.id)));
    select.value = this.session.id;
    const messages = byId("agent-messages");
    messages.replaceChildren(...this.session.messages.filter((message) => message.role !== "system").map((message) => this.renderMessage(message)));
    messages.scrollTop = messages.scrollHeight;
    const confirmation = byId("agent-confirmation");
    confirmation.hidden = !this.session.pendingTool;
    confirmation.replaceChildren();
    if (this.session.pendingTool) {
      const copy = document.createElement("p"); copy.textContent = `${this.session.pendingTool.reason}（${this.session.pendingTool.name}）`;
      const approve = document.createElement("button"); approve.type = "button"; approve.className = "primary-command"; approve.textContent = "确认执行"; approve.addEventListener("click", () => void this.confirm(true));
      const reject = document.createElement("button"); reject.type = "button"; reject.className = "command-button secondary"; reject.textContent = "取消"; reject.addEventListener("click", () => void this.confirm(false));
      confirmation.append(copy, approve, reject);
    }
    this.renderAttachmentState();
  }

  private renderMessage(message: WorkspaceAgentMessage): HTMLElement {
    const item = document.createElement("article"); item.className = `agent-message ${message.role}`;
    const role = document.createElement("span"); role.textContent = message.role === "user" ? "YOU" : message.role === "tool" ? "TOOL" : "AGENT";
    const copy = document.createElement("p"); copy.textContent = message.content;
    item.append(role, copy); return item;
  }

  private renderAttachmentState(): void {
    const label = this.attachedContext ? "已附加" : "附加";
    byId<HTMLButtonElement>("agent-collapsed-attach").title = `${label} Workspace 上下文`;
    byId<HTMLButtonElement>("agent-collapsed-attach").classList.toggle("is-attached", Boolean(this.attachedContext));
  }

  private async confirm(approved: boolean): Promise<void> { if (!this.session) return; try { this.session = await workspaceApi.confirmWorkspaceAgentTool(this.session.id, approved); this.sessions = this.sessions.map((session) => session.id === this.session?.id ? this.session! : session); this.render(); } catch (error) { this.fail(error); } }
  private fail(error: unknown): void { const message = error instanceof Error ? error.message : String(error); notifyWorkspace("Agent 操作失败", message, { tone: "error" }); this.onError(error); }
}
