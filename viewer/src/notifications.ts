export type WorkspaceNotificationTone = "success" | "info" | "warning" | "error";

export interface WorkspaceNotificationOptions {
  tone?: WorkspaceNotificationTone;
  durationMs?: number;
  dedupeMs?: number;
}

const DEFAULT_DURATION_MS = 10_000;
const FADE_MS = 400;
const DEFAULT_DEDUPE_MS = 1_200;
const MAX_NOTIFICATIONS = 5;

function deck(): HTMLElement | null {
  return document.getElementById("workspace-notification-deck");
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const recent = new Map<string, number>();

/** Show one short-lived message in the single Atlas notification surface. */
export function notifyWorkspace(summary: string, detail = "", options: WorkspaceNotificationOptions = {}): void {
  const normalizedSummary = summary.trim();
  const normalizedDetail = detail.trim();
  if (!normalizedSummary) return;
  const tone = options.tone ?? "info";
  const now = Date.now();
  const key = `${tone}:${normalizedSummary}:${normalizedDetail}`;
  const previous = recent.get(key);
  if (previous !== undefined && now - previous < (options.dedupeMs ?? DEFAULT_DEDUPE_MS)) return;
  recent.set(key, now);
  for (const [entry, timestamp] of recent) {
    if (now - timestamp > DEFAULT_DEDUPE_MS * 2) recent.delete(entry);
  }

  const root = deck();
  if (!root) return;
  const item = document.createElement("div");
  item.className = `workspace-notification workspace-notification-${tone}`;
  item.dataset.tone = tone;
  item.setAttribute("role", tone === "error" ? "alert" : "status");
  const title = document.createElement("strong");
  title.textContent = normalizedSummary;
  const note = document.createElement("small");
  note.textContent = normalizedDetail;
  item.append(title, note);
  root.append(item);
  while (root.children.length > MAX_NOTIFICATIONS) root.firstElementChild?.remove();

  const durationMs = Math.max(FADE_MS, options.durationMs ?? DEFAULT_DURATION_MS);
  const fadeDelay = Math.max(0, durationMs - FADE_MS);
  if (!reducedMotion()) requestAnimationFrame(() => item.classList.add("is-visible"));
  else item.classList.add("is-visible");
  window.setTimeout(() => {
    item.classList.add("is-leaving");
    window.setTimeout(() => item.remove(), reducedMotion() ? 0 : FADE_MS);
  }, fadeDelay);
}

export function notifyWorkspaceError(error: unknown, summary = "请求失败"): void {
  notifyWorkspace(summary, error instanceof Error ? error.message : String(error), { tone: "error" });
}

