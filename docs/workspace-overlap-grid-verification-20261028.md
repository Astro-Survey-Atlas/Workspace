# Overlap order slider and component navigation

Verified locally and deployed to Dev on October 29, 2026, at Helm revision 109.

The initial regressions reproduced a missing granularity control and a C02
button that selected the region without moving the camera from
`1.720000,1.480000,1.560000`. The subsequent slider/O10 regression also failed
before the slider and high-order support were implemented.

The Inspector now offers a HEALPix range slider modeled on Assets' interaction:
pointer/touch dragging previews the order, release submits it, and keyboard
changes debounce for 250 ms. The slider stays attached and focused during
Inspector progress updates. Selecting another visible survey cancels the old
request, refreshes the available range, and keeps the G-mode layers co-registered.
The default is O4 or the highest supported lower order. Available levels run
from O0 through the real shared source maximum, capped at O13.

Native public/package and private FITS MOCs supply higher-order detail. The
NUNIQ/interval projection follows Assets' native-MOC/display implementation;
MOC generation still belongs to MOC Core. Verified source geometry is unioned
within each survey and intersected between surveys. Only the resulting cells
are expanded. This preserves fine boundaries and avoids allocating a high-order
all-sky grid. Queries above O8 permit at most 32,768 final cells; O6–O8 permit
65,536 and O0–O5 permit 200,000. Queries return complete components. When a
query exceeds the budget, the UI retains its successful geometry and reports
that the user can lower the order or reduce selected products.

The previous artificial subdivision design was removed. API requests above a
selected source's shared precision fail explicitly. `coverageOrder` in the
response and JSON/CSV exports records the actual displayed intersection order.
The slider identifies limiting sources. A read-only query of existing Dev
geometry before deployment returned O4, 14 cells and four components; DESI DR1
bright-program redrock and the Legacy DR9 coadded-imaging and Tractor-catalog
overviews limited that selection. Native MOC reading now exposes O6 for the
DESI source, while those Legacy overviews still limit the shared order to O4.

Clicking C0x animates the camera toward that component and fits its spherical
cell boundaries to both viewport dimensions, including regions across RA zero.
Automatic C01 selection and order changes preserve the current camera view.
Pending and failed calculations preserve the previous geometry, component
navigation and manifest export; stale results cannot overwrite a newer order
or source selection. A 40,000-cell regression also verifies that computing
bounds does not overflow the argument stack.

High-order local directory lookup queries O8 parent buckets while preserving
native coverage facts, then filters against the actual selected region.
Public download previews and immutable download snapshots support O13. The
existing local object crossmatch index continues to support O8.

Validation:

- `npm run verify`: 394 tests, 390 passed, four optional checks skipped, zero
  failures; types, server/Viewer/CLI builds and strict Helm checks passed.
- The 18-case coverage/settings browser run passed, including light/dark
  layouts at 1440 and 1024 pixels, streaming, empty/error states, exports,
  pointer release, keyboard changes, O10 selection, camera direction and
  retaining successful geometry and export after errors.
- Six final focused slider/source-selection/navigation checks passed,
  including the newly added source-selection regression (19 distinct browser
  scenarios across the full run and focused final run).
- Isolated HTTP fixtures verify O6 and native O10 overlap, rejection of a
  requested O6 for an O4-only source, and high-order lookup through local O8
  buckets. Native artifact tests cover actual fine gaps, verified file hashes,
  compressed all-sky intersection without expansion, and exact O29-to-O13
  integer coarsening.
- Read-only offline use of existing Assets Euclid ERO VIS and Gaia DR3 MOCs
  produced 3,925 O10 overlap cells in 17 complete components. No upstream
  request, installation or scientific rebuild was needed for this check.

Logs remain outside Git:

- `/tmp/workspace-overlap-slider-verify-final.log`
- `/tmp/workspace-overlap-slider-browser-full.log`
- `/tmp/workspace-overlap-slider-browser-final.log`
- `/tmp/workspace-overlap-slider-http-final.log`
- `/tmp/workspace-overlap-slider-real-moc.log`

After the user requested deployment, Helm release `asa` in `asa-workspace` was
upgraded from revision 108 to **109** with image
`0.0.1-dev-20261029-overlap-slider-r1`. The running Workspace Pod reports digest
`sha256:f823da406381c3abc3e3d18c25030967e63e98b5c1af826d084d135af61d2d8f`.
The image overlays the rebuilt server, Viewer and CLI on the existing verified
runtime. The upgrade reused existing Helm values, and a server-side dry run
verified that only the Workspace image changed.

Deployment checks:

- Helm reports `deployed`; Workspace, downloader and Elasticsearch are Ready.
  The search-init hook completed and all PVCs remain Bound. Workspace has zero
  restarts, and `/healthz` returns `ok` / `0.0.1`.
- Deployed HTML, JavaScript and CSS are byte-identical to this build.
- Six focused browser cases passed against the deployed frontend using API
  fixtures: O10, pointer release, changed source selection, retained geometry
  on errors, C0x camera navigation and cancellation of stale requests.
- Real API queries returned 14 O4 cells in four components and 12 O3 cells in
  five components. Selecting O5 with the O4 Legacy overviews returns HTTP 400.
- Filtering existing sources to DESI EDR spectra and Euclid ERO VIS returned
  **78 native O10 cells in one component**, HTTP 200, in about 1.4 seconds.
- The real Dev browser passed O4 → O3 → O4 slider changes and C02 camera
  navigation, with no page errors. Initial private coverage loads asynchronously
  and enables an existing preview asset; this check waits for it and deselects
  owned layers to keep the three public surveys as the selected source set.
  The camera moved from `1.720000,1.480000,1.560000` to
  `0.616581,1.290725,-0.008007`. Screenshot:
  `/tmp/workspace-overlap-dev-20261029-tta29s1y/dev-overlap-slider.png`.

Deployment logs and receipts are under
`/tmp/workspace-overlap-dev-20261029-tta29s1y/`. Local browser validation must
bypass the configured HTTP proxy for this Dev host.

Existing work and the staging index were preserved. No public release, scan
retry, inventory refresh, download or index rebuild was submitted during the
UI work or deployment.
