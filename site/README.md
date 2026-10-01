<!--
Copyright 2026 Astro Survey Atlas contributors.
Licensed under the Apache License, Version 2.0.
-->

# Workspace Documentation Site

Open `index.html` directly in a browser. No build, server, CDN, or API
connection is required. Repository links need internet access.

This is a static skeleton aligned with the Warehouse and MOC Core docs chrome
(header width, theme toggle, shared ASA mark). Product copy is intentionally
short and limited to landed Workspace boundaries; Doc Bot may expand it.

## GitHub Pages

In repository Settings → Pages, choose **GitHub Actions** as the source.
The `Deploy documentation site` workflow publishes only `site/` on matching
pushes to `main`, or on manual dispatch. Expected URL:
<https://astro-survey-atlas.github.io/Workspace/>.

Relative asset paths support both project Pages and opening the folder locally.
