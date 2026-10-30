export interface ContextMenuAction {
  label: string;
  disabled?: boolean;
  title?: string;
  run: () => void | Promise<void>;
}

let activeMenu: HTMLElement | undefined;

function closeContextMenu(): void {
  activeMenu?.remove();
  activeMenu = undefined;
}

document.addEventListener("pointerdown", (event) => {
  if (activeMenu && !activeMenu.contains(event.target as Node)) closeContextMenu();
}, true);

document.addEventListener("keydown", (event) => {
  if (!activeMenu) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
    return;
  }
  if (event.key === "Tab") {
    closeContextMenu();
    return;
  }
  const items = [...activeMenu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "ArrowDown" ? (current + 1) % items.length
    : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length
      : event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1 : -1;
  if (next >= 0 && items.length) {
    event.preventDefault();
    items[next]?.focus();
  }
}, true);

export function showContextMenu(event: MouseEvent, actions: ContextMenuAction[]): void {
  if (!actions.length) return;
  event.preventDefault();
  event.stopPropagation();
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "workspace-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "对象操作");
  for (const action of actions) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.textContent = action.label;
    item.disabled = Boolean(action.disabled);
    if (action.title) item.title = action.title;
    item.addEventListener("click", () => {
      closeContextMenu();
      void action.run();
    });
    menu.append(item);
  }

  menu.style.visibility = "hidden";
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
  menu.style.visibility = "visible";
  activeMenu = menu;
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}
