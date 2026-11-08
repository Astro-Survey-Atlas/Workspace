/* Workspace v3 HUD mockup — shared chrome.
   Static only: no API calls, no app code. Theme follows ?theme=, else the
   stored preference, else the OS setting. */

const THEME_KEY = "asa-mock-theme";
const params = new URLSearchParams(location.search);

export const theme = (() => {
  const asked = params.get("theme");
  if (asked === "dark" || asked === "light") return asked;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {}
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
})();
document.documentElement.dataset.theme = theme;

/** Link to the same page in the other theme. */
export function themeLink(target = theme === "dark" ? "light" : "dark") {
  const next = new URLSearchParams(params);
  next.set("theme", target);
  return `?${next.toString()}`;
}

/** Wire the [data-theme-toggle] control and the logo for the current theme. */
export function applyChrome(page) {
  document.querySelectorAll("[data-theme-toggle]").forEach((node) => {
    node.href = themeLink();
    node.textContent = theme === "dark" ? "◑ DAY" : "◐ NIGHT";
  });
  const logo = document.querySelector("[data-logo]");
  if (logo) logo.src = theme === "dark" ? "icon_without_name_lon_web_dark.svg" : "icon_without_name_lon_web.svg";
  document.querySelectorAll(`[data-page="${page}"]`).forEach((node) => node.classList.add("on"));
}

/** The coverage globe, drawn as SVG so the mockup needs no WebGL or binary art.
    `cells` are deterministic pseudo-random patches; `mode` picks the palette. */
export function coverageGlobe({ size = 900, patches = 7, targeted = true } = {}) {
  const cx = size / 2, cy = size / 2, r = size * 0.46;
  let seed = 20261108;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const surveyColors = ["#ff2e63", "#8592ff", "#5be3a4", "#ffc35c", "#c78bff"];
  const cells = [];
  for (let p = 0; p < patches; p += 1) {
    const ra = rand() * Math.PI * 2, dec = (rand() - 0.4) * 1.1;
    const spread = 0.16 + rand() * 0.28;
    const color = surveyColors[p % surveyColors.length];
    for (let n = 0; n < 260; n += 1) {
      const t = ra + (rand() - 0.5) * spread, d = dec + (rand() - 0.5) * spread;
      if (d < -Math.PI / 2 || d > Math.PI / 2) continue;
      const x = Math.cos(d) * Math.cos(t), y = Math.sin(d), z = Math.cos(d) * Math.sin(t);
      if (z < -0.35) continue;
      cells.push({ x: cx + x * r, y: cy - y * r, s: 9 + rand() * 7, color, o: 0.1 + rand() * 0.45 });
    }
  }
  const grid = [];
  for (let i = 1; i <= 7; i += 1) grid.push(`<ellipse cx="${cx}" cy="${cy}" rx="${(r * i) / 7}" ry="${(r * i) / 7}" />`);
  for (let i = -2; i <= 2; i += 1) {
    const y = cy + (i * r) / 3;
    const half = Math.sqrt(Math.max(0, r * r - (y - cy) ** 2));
    grid.push(`<line x1="${cx - half}" y1="${y}" x2="${cx + half}" y2="${y}" />`);
  }
  for (let i = 0; i < 6; i += 1) {
    const a = (i * Math.PI) / 6;
    grid.push(`<line x1="${cx - Math.cos(a) * r}" y1="${cy - Math.sin(a) * r}" x2="${cx + Math.cos(a) * r}" y2="${cy + Math.sin(a) * r}" />`);
  }
  const target = { x: cx + r * 0.18, y: cy - r * 0.26 };
  return `<svg class="scene" viewBox="0 0 ${size} ${size}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="body" cx="42%" cy="36%" r="70%">
      <stop offset="0%" stop-color="var(--globe-core)" /><stop offset="70%" stop-color="var(--globe-mid)" /><stop offset="100%" stop-color="var(--globe-edge)" />
    </radialGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%">
      <stop offset="78%" stop-color="var(--globe-halo)" stop-opacity="0" />
      <stop offset="96%" stop-color="var(--globe-halo)" stop-opacity=".35" />
      <stop offset="100%" stop-color="var(--globe-halo)" stop-opacity="0" />
    </radialGradient>
    <clipPath id="disc"><circle cx="${cx}" cy="${cy}" r="${r}" /></clipPath>
    <filter id="soft"><feGaussianBlur stdDeviation=".6" /></filter>
  </defs>
  <circle cx="${cx}" cy="${cy}" r="${r * 1.1}" fill="url(#halo)" />
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#body)" />
  <g clip-path="url(#disc)" fill="none" stroke="var(--globe-grid)" stroke-width=".7" opacity=".55">${grid.join("")}</g>
  <g clip-path="url(#disc)" filter="url(#soft)">
    ${cells.map((c) => `<rect x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}" width="${c.s.toFixed(1)}" height="${c.s.toFixed(1)}" fill="${c.color}" opacity="${c.o.toFixed(2)}" transform="rotate(18 ${c.x.toFixed(1)} ${c.y.toFixed(1)})" />`).join("\n    ")}
  </g>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--globe-limb)" stroke-width="1.4" opacity=".8" />
  ${targeted ? `<g stroke="var(--hot)" fill="none" stroke-width="1.5">
    <rect x="${target.x - 26}" y="${target.y - 22}" width="52" height="44" opacity=".9" />
    <line x1="${target.x - 40}" y1="${target.y}" x2="${target.x - 30}" y2="${target.y}" />
    <line x1="${target.x + 30}" y1="${target.y}" x2="${target.x + 40}" y2="${target.y}" />
    <line x1="${target.x}" y1="${target.y - 34}" x2="${target.x}" y2="${target.y - 26}" />
    <line x1="${target.x}" y1="${target.y + 26}" x2="${target.x}" y2="${target.y + 34}" />
  </g>` : ""}
</svg>`;
}

/** Star/scanline backdrop tokens used by the stage. */
export const sceneTokens = `
:root[data-theme="dark"]{--globe-core:#1b1640;--globe-mid:#0d0b26;--globe-edge:#04030f;--globe-halo:#8592ff;--globe-grid:rgba(160,168,255,.5);--globe-limb:rgba(133,146,255,.5)}
:root[data-theme="light"]{--globe-core:#fbfbff;--globe-mid:#eef0f8;--globe-edge:#dfe3ef;--globe-halo:#2c3792;--globe-grid:rgba(44,55,146,.35);--globe-limb:rgba(44,55,146,.3)}
`;
const style = document.createElement("style");
style.textContent = sceneTokens;
document.head.append(style);
