import type { SkyOverlapSource } from "../../src/sky-overlap.js";

export interface CoverageSourceDisplay {
  surveyName: string;
  releaseLabel?: string;
  color: string;
}

/** Group by source identities, keeping equally named products from different sources. */
export function coverageSourceGroups(sources: readonly SkyOverlapSource[], display: (source: SkyOverlapSource) => CoverageSourceDisplay): HTMLElement {
  const section = document.createElement("section");
  section.className = "coverage-source-groups";
  section.setAttribute("aria-label", "来源");
  const heading = document.createElement("h3");
  heading.textContent = "来源";
  section.append(heading);
  const kinds = new Map<SkyOverlapSource["kind"], { element: HTMLElement; surveys: Map<string, { element: HTMLElement; releases: Map<string, HTMLUListElement> }> }>();
  const seen = new Set<string>();
  for (const source of sources) {
    const identity = JSON.stringify([source.kind, source.id]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    let kind = kinds.get(source.kind);
    if (!kind) {
      const element = document.createElement("div");
      element.className = `coverage-source-kind coverage-source-kind-${source.kind}`;
      element.dataset.sourceKind = source.kind;
      const title = document.createElement("h4");
      title.className = "coverage-source-kind-title";
      title.textContent = source.kind === "public" ? "公开覆盖" : "Workspace 数据";
      const note = document.createElement("p");
      note.className = "coverage-source-kind-note";
      note.textContent = source.kind === "public"
        ? "覆盖证据不代表文件已下载到 Workspace 或完成扫描。"
        : "Workspace 资产或覆盖层；本地文件清单以对应扫描记录为准。";
      element.append(title, note);
      section.append(element);
      kind = { element, surveys: new Map() };
      kinds.set(source.kind, kind);
    }
    const surveyId = source.surveyId ?? source.sourceIdentity?.surveyId;
    const releaseId = source.releaseId ?? source.sourceIdentity?.releaseId;
    const names = display(source);
    const surveyKey = JSON.stringify([source.kind, surveyId ?? source.id]);
    let survey = kind.surveys.get(surveyKey);
    if (!survey) {
      const element = document.createElement("div");
      element.className = "coverage-source-survey";
      element.dataset.surveyId = surveyId ?? "";
      element.style.setProperty("--survey-color", names.color);
      const header = document.createElement("h5");
      header.textContent = names.surveyName;
      if (source.kind === "workspace") {
        const badge = document.createElement("span");
        badge.className = "coverage-source-local";
        badge.textContent = source.assetId ? "本地资产" : "Workspace";
        header.append(badge);
      }
      element.append(header);
      kind.element.append(element);
      survey = { element, releases: new Map() };
      kind.surveys.set(surveyKey, survey);
    }
    const releaseKey = releaseId ?? "";
    let products = survey.releases.get(releaseKey);
    if (!products) {
      const release = document.createElement("div");
      release.className = "coverage-source-release";
      release.dataset.releaseId = releaseKey;
      if (names.releaseLabel) {
        const label = document.createElement("h6");
        label.textContent = names.releaseLabel;
        if (releaseId && names.releaseLabel.toLowerCase() !== releaseId.toLowerCase()) {
          const id = document.createElement("span");
          id.className = "coverage-source-release-id";
          id.textContent = releaseId;
          label.append(id);
        }
        release.append(label);
      }
      products = document.createElement("ul");
      release.append(products);
      survey.element.append(release);
      survey.releases.set(releaseKey, products);
    }
    const repeatedLabels = new Set([names.surveyName, names.releaseLabel, releaseId]
      .filter((value): value is string => Boolean(value))
      .map(value => value.trim().toLocaleLowerCase()));
    const productLabel = [source.label, source.product]
      .find(value => Boolean(value?.trim()) && !repeatedLabels.has(value!.trim().toLocaleLowerCase()));
    if (productLabel) {
      const product = document.createElement("li");
      product.className = "coverage-source-product";
      product.dataset.sourceId = source.id;
      product.textContent = productLabel;
      product.title = source.id;
      products.append(product);
    }
  }
  if (!sources.length) section.append(Object.assign(document.createElement("p"), { textContent: "当前来源未提供身份信息" }));
  return section;
}

/** Only verified HTTP locators become links; the original URI stays in the manifest. */
export function coverageLocator(uri: string, fileName?: string): HTMLElement {
  let url: URL | undefined;
  try {
    const parsed = new URL(uri);
    if (/^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password) url = parsed;
  } catch { /* Non-URL source locators remain text. */ }
  const locator = document.createElement(url ? "a" : "code");
  locator.className = "coverage-locator";
  locator.textContent = url ? fileName || `访问来源 · ${url.hostname}` : uri;
  locator.dataset.fullName = url && fileName ? fileName : uri;
  locator.setAttribute("aria-label", locator.textContent);
  locator.tabIndex = 0;
  if (locator instanceof HTMLAnchorElement) {
    locator.href = uri;
    locator.target = "_blank";
    locator.rel = "noopener noreferrer";
  }
  return locator;
}

/** One delegated tooltip survives streamed rerenders without retaining removed rows. */
export function setupCoverageLocatorTooltip(host: HTMLElement): void {
  const tooltip = document.createElement("div");
  tooltip.className = "status-help-tooltip coverage-locator-tooltip";
  tooltip.id = "coverage-locator-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  document.body.append(tooltip);
  let active: HTMLElement | undefined;
  const close = () => {
    active?.removeAttribute("aria-describedby");
    active = undefined;
    tooltip.classList.remove("is-visible");
    tooltip.setAttribute("aria-hidden", "true");
  };
  const position = () => {
    if (!active?.isConnected || host.hidden) { close(); return; }
    const rect = active.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - bounds.width - 12))}px`;
    tooltip.style.top = `${rect.bottom + bounds.height + 8 <= window.innerHeight - 12 ? rect.bottom + 8 : Math.max(12, rect.top - bounds.height - 8)}px`;
  };
  const open = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".coverage-locator") : null;
    if (!target || !host.contains(target)) return;
    close();
    active = target;
    tooltip.textContent = target.dataset.fullName ?? target.textContent;
    target.setAttribute("aria-describedby", tooltip.id);
    tooltip.classList.add("is-visible");
    tooltip.setAttribute("aria-hidden", "false");
    position();
  };
  host.addEventListener("pointerover", open);
  host.addEventListener("focusin", open);
  host.addEventListener("pointerout", event => {
    if (active && event.target === active && document.activeElement !== active) close();
  });
  host.addEventListener("focusout", close);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !active) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);
  new MutationObserver(() => { if (active && (!active.isConnected || host.hidden)) close(); }).observe(host, { childList: true, attributes: true, attributeFilter: ["hidden"], subtree: true });
}
