import { createIcons, X } from "lucide";

export type WorkspaceNotificationTone = "success" | "info" | "warning" | "error";

export interface WorkspaceNotificationOptions {
  tone?: WorkspaceNotificationTone;
  durationMs?: number;
  dedupeMs?: number;
}

const DEFAULT_DURATION_MS = 5_000;
const FADE_MS = 400;
const DEFAULT_DEDUPE_MS = 1_200;
const MAX_NOTIFICATIONS = 5;

let deckHostObserver: MutationObserver | undefined;

function deck(): HTMLElement | null {
  const root = document.getElementById("workspace-notification-deck");
  if (!root) return null;
  if (!deckHostObserver && document.body) {
    deckHostObserver = new MutationObserver(() => syncDeckHost(root));
    deckHostObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
  }
  syncDeckHost(root);
  return root;
}

function syncDeckHost(root: HTMLElement): void {
  const openDialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
  const host = openDialogs.at(-1);
  if (host && root.parentElement !== host) {
    host.append(root);
  } else if (!host && root.parentElement !== document.body && document.body) {
    document.body.append(root);
  }
}

function hideEmptyDeck(root: HTMLElement): void {
  if (root.childElementCount) return;
  syncDeckHost(root);
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
  const close = document.createElement("button");
  close.type = "button";
  close.className = "workspace-notification-close";
  close.setAttribute("aria-label", "关闭通知");
  close.title = "关闭";
  const closeIcon = document.createElement("i");
  closeIcon.dataset.lucide = "x";
  close.append(closeIcon);
  item.append(title, note, close);
  root.append(item);
  createIcons({ icons: { X }, attrs: { "aria-hidden": "true" } });
  while (root.children.length > MAX_NOTIFICATIONS) root.firstElementChild?.remove();

  const durationMs = Math.max(FADE_MS, options.durationMs ?? DEFAULT_DURATION_MS);
  const fadeDelay = Math.max(0, durationMs - FADE_MS);
  let removeTimer: number | undefined;
  let dismissed = false;
  const remove = (): void => {
    item.remove();
    hideEmptyDeck(root);
  };
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    window.clearTimeout(fadeTimer);
    item.classList.add("is-leaving");
    removeTimer = window.setTimeout(remove, reducedMotion() ? 0 : FADE_MS);
  };
  close.addEventListener("click", dismiss);
  if (!reducedMotion()) requestAnimationFrame(() => item.classList.add("is-visible"));
  else item.classList.add("is-visible");
  const fadeTimer = window.setTimeout(dismiss, fadeDelay);
  item.addEventListener("transitionend", (event) => {
    if (event.target !== item || event.propertyName !== "opacity" || !dismissed) return;
    if (dismissed && removeTimer !== undefined) window.clearTimeout(removeTimer);
    remove();
  });
}

export function notifyWorkspaceError(error: unknown, summary = "请求失败"): void {
  notifyWorkspace(summary, error instanceof Error ? error.message : String(error), { tone: "error" });
}
