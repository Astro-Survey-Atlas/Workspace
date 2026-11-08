/* Workspace v3 HUD mockup — shared shell pieces (top bar, frame, footer).
   Every page calls topbar(pageKey) so the chrome stays identical. */

const PAGES = [
  ["packages", "公开资源集"],
  ["connectors", "连接器"],
  ["catalog", "用户资产"],
  ["layers", "数据覆盖"],
  ["workflow", "数据生产"],
  ["system", "系统配置"],
];

const ICONS = {
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.2 5.2l1.9 1.9M16.9 16.9l1.9 1.9M18.8 5.2l-1.9 1.9M7.1 16.9l-1.9 1.9"/></svg>',
  sliders: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg>',
  reset: '<svg viewBox="0 0 24 24"><path d="M4 5v5h5"/><path d="M4.7 14a8 8 0 1 0 1.6-7.2L4 10"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 0 14h-1"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 11 12 15.5 16.5 11"/><path d="M4 19h16"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 4 5.3 4 8.5s-1.4 6.1-4 8.5c-2.6-2.4-4-5.3-4-8.5s1.4-6.1 4-8.5Z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-.8 4.3"/><path d="M20 5v6h-6"/></svg>',
};

export const icon = (name) => ICONS[name] ?? "";

/** Return the top bar markup for a page key. */
export function topbar(page) {
  const nav = PAGES.map(([key, label]) =>
    `<a href="${key}.html" data-page="${key}">${label}</a>`).join("");
  return `<header class="top">
  <a class="brand" href="index.html">
    <img data-logo alt="Astro Survey Atlas Workspace" width="72" height="30" />
    <span><strong>Astro Survey Atlas</strong><small>ASA · 用户数据工作区</small></span>
  </a>
  <span class="mode-marker"><i></i>WORKSPACE</span>
  <nav class="nav">${nav}</nav>
  <span class="statechip live"><i></i>API ONLINE</span>
  <a class="statechip" data-theme-toggle href="#">◐ NIGHT</a>
</header>`;
}

/** Screen-corner frame marks. */
export const frame = '<i class="frame-c tl"></i><i class="frame-c tr"></i><i class="frame-c bl"></i><i class="frame-c br"></i>';

/** The review label shown on every mockup page. */
export const note = '<div class="mock-note">MOCKUP · 静态设计稿 · 未接入真实数据</div>';

/** Bottom status strip shared by the data pages. */
export function footer(left, right) {
  return `<footer class="foot"><span>${left}</span><b>${right}</b></footer>`;
}
