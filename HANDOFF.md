# Workspace handoff

Updated: 2026-11-06, Asia/Shanghai.

## Shared sky globe and Apache-2.0 (November 8, branch `feat/hud-globe`, not deployed)

Frontend and licensing only; no API, scan, task or deployment change. Scanning
stays paused.

- License is now Apache-2.0: `LICENSE`, `NOTICE`, `license` in the three
  `package.json` files, README badges, and the desktop copyright line.
- The three.js globe fork is gone (`viewer/src/survey-layer-viewer.ts`,
  `spherical-cell-geometry.ts`, `coordinates.ts`, `layer-order.ts`). The viewer
  uses `@astro-survey-atlas/sky-globe`, the package Assets now ships from
  `packages/sky-globe`, so Workspace renders the v3 HUD globe.
  - Workspace-only fields of coverage layers (MOC status, precision, orders)
    live in a local `WorkspaceCoverageLayer` extension type in `main.ts`.
  - Options passed: `sourceIdForFootprint: publicSourceIdForFootprint`,
    `overlapContextMenu: true`.
- **Dependency:** the release tarball
  `https://codeload.github.com/Astro-Survey-Atlas/sky-globe/tar.gz/refs/tags/v0.1.0`
  (repo `Astro-Survey-Atlas/sky-globe`, public, Apache-2.0). It is an HTTPS
  tarball with an integrity hash, so Docker and CI need no git or SSH key.
  Upgrade by changing the tag in `package.json` and running `npm install`;
  Assets and Workspace move to a new tag together.
- `test/sky-cross-repo.test.ts` was removed: both repos now run the same module.
- `test/e2e/survey-cell-alignment.spec.ts` loads the package through `/@fs/` and
  checks v3 semantics: the selection is a target box on the selection shell, a
  second click collapses the fan-out, the fan-out follows display order.
- Verified: `verify:types`, `npm test` (336 pass, 3 skipped, 0 fail),
  `survey-cell-alignment` e2e 4/4. Other e2e specs were not run: `survey-layers`
  installs resource packages on the Dev API.
- Aladin drill-down (stage C3): the region inspector has an "在 Aladin 中打开"
  button (`data-action="open-aladin"`) and a double-click on a cell
  (`onDrillDown`) both call `enterAladinExplorer`, the same entry as the context
  menu. Aladin outlines the selected cells (`regionOutline`, skipped above
  1,000 cells, `data-region-outline` on the host). Leaving Aladin restores the
  3D camera pose. Entry FOV stays 0.5° (the existing navigation contract).
- Verified after C3: `aladin-initial-navigation` 12/12 (one new test) and
  `survey-cell-alignment` 4/4, `verify:types`, `npm test` 336/3 skipped.
- Next (stage D): HUD shell restyle through a token alias layer. Needs a design
  mockup approved first.

## Current Dev state: lightweight local runtime (November 6)

Workspace has been cut over to its independent local runtime at Helm revision
**150**, status **deployed**, image `0.0.1-dev-20261106-lightweight-r5`. API, the
single scan worker and owned ES are Ready on `zjlab-ubuntu`, with zero restarts.
The existing downloader is retained.
URL: `http://astro.workspace.dev.72602.space:32080`.

Runtime: API + independent scan worker + local SQLite + three scientific ES
indices. Warehouse execution, Kubernetes scan dispatch, PostgreSQL and the large
statistics checkpoint are removed from the active path. Public catalog startup
uses the validated local cache; sync is explicit. Warehouse and Assets code,
deployments and search stores were not changed by this refactor.

**All real scanning remains paused.** `/api/scanning` reports paused and scan
submission returns 409 after API/worker restart. There are no running or queued
local scans; three interrupted records are paused. Both old Scanner Jobs remain
suspended, with total active Jobs=0. Never automatically resume them.

New `local-path` claims: `asa-workspace-state-local` (20 GiB),
`asa-workspace-search-local` (30 GiB). Original state, evidence, production and
search volumes are retained. The three old Helm-managed claims have
`helm.sh/resource-policy: keep`. Configuration/catalog snapshots retain the latest
**three**; scientific evidence and referenced outputs do not rotate with them.

Published science data: **3,019,111 positions**, **1,298,611 file records** and
**1,298,579 image footprints**. SQLite retains 22 Connectors, 23 assets, five
Workflow runs, ten Agent sessions and four production runs. All 746 migrated
evidence files (6,149,925,910 bytes) pass SHA-256 verification; all 264 checked
control/artifact files also match.

Final r5 HTTP acceptance: the original 2,000-point query returns 2,000 points in
157 ms on its first request after API restart (ES already warm); 20 subsequent
requests have p50 **132 ms**, p95 **154 ms**. The earlier measurement immediately
after ES restart was **1.33 s**. Sixty control requests have p95 **13.34 ms**.
W2 HEALPix 2071 returns 2,000 real points. The historical 215-FITS ZIP downloads
in **0.96 s**; all 218 contained file hashes match. Empty selection still succeeds
without an archive. Full attributes load on demand from evidence chunks.

Build/type/service/chart verification passed: 340 tests, 337 passed, three skipped,
zero failures. Isolated CSV/FITS/S3 worker integration also passed against the
container's pinned real science dependencies. Desktop prepare/smoke passed.
All **17 browser regressions passed**. A real Dev browser right-clicked W2
HEALPix 2071 and Aladin completed with **113 points**; the historical 215-FITS ZIP
also downloaded through the visible button. No page/API errors or task mutations
occurred. The temporary migration Pod has been removed; all original claims remain.
See the [implementation and acceptance record](docs/workspace-performance-refactor-20261106.md)
and [migration procedure](docs/workspace-metadata-migration.md) for browser checks,
deployment details and remaining scope.

The original source baseline is `6c99df0`. The old plan's PostgreSQL and
Warehouse changes have been superseded. Runtime changes are now recorded in
`70b5672` (the image was built before this commit, so its build commit label
still points to `5d32886`). Final acceptance/handoff additions follow that commit.
Private operational receipts are in
`/tmp/workspace-lightweight-refactor-20261106/`; do not copy credential values.

## Historical Dev state (November 5; superseded by revision 150)

Workspace is deployed at Helm revision **148**, image
`0.0.1-dev-20261105-download-perf-r3`, registry digest
`sha256:525ae2450dee5c20b91aeb5fdc4f4b17ea36deb7de9231f596aa68f020024b8b`.
Pod `asa-workspace-778fd684b8-srg5p` is Ready with zero restarts. `NO_PROXY` includes the expanded
Kubernetes Service IP; a read-only Connector Secret request returned HTTP 200
in 18 ms.

The two November 3 runs with cutouts enabled remain as failed records. Their
cutout calls timed out while reading Connector Secrets through the configured
HTTP proxy; the Kubernetes API Service IP had not been included in `NO_PROXY`.
This was not an empty-filter failure: each run had 43 selected rows, five
cutout groups and 215 failed targets. Their records were not modified.

New run `wfr_20261105012541_6572797f` completed successfully with 43 filtered
rows, five successful cutout groups, 215/215 FITS artifacts and zero unresolved
targets. Run `wfr_20261105013325_96ffeade` verified the empty-selection path:
zero filtered rows, cutout skipped, zero-row export and overall success. Full
trace and artifact evidence is in the [session handoff](docs/session-handoff-20261103-agent.md).

## FITS downloads and performance release (November 5)

Workflow now exposes per-target FITS downloads and a ZIP containing the FITS,
filtered CSV, cutout index, available run result and checksummed manifest.
Use `GET /api/workflow-runs/:id/cutouts` or `/:id/cutouts.zip`; CLI supports
`workflows cutouts RUN_ID [--output cutouts.zip]`. The result section has a
50-file paginated list. Successful files remain downloadable after partial
failure; empty selections have no archive. ZIP streams, checks files before
headers using bounded concurrency, and aborts reads when the client disconnects.

The user's 2,000-point request now has about 477 KB of JSON and 43–46 KB of
gzip transfer, compared with their previous approximately 1.2 MB sample.
Complete fields are retrieved on demand. Explicit asset/source/HEALPix/bbox
filters and pagination remain. The main bundle is now 988 KB raw / approximately
305 KB over HTTP gzip; Aladin loads on entry. Both local and public survey
directories return full records in one request. Workflow startup does not wait
for public coverage or Agent initialization. DR9 overview reads are validated,
cached for five minutes, deduplicated and warmed in the background.

Dev applies `values-performance.yaml`: Workspace limit 2 CPU / 3 GiB,
Elasticsearch 2 CPU / 4 GiB with a 1 GiB heap. Existing storage, credentials,
downloader and scan configuration were retained. The two W2 Scanner slots
continued processing; no new science scan or cutout run was submitted.

**Remaining:** bounded point-query latency and download throughput are still
variable. Samples include 0.759 s and 4.698 s, cold 16–18 s, and a later 30 s
ES timeout. ES itself reported `took=14050 ms` on an isolated read. All Workspace
and ES volumes use `nfs-data`; the ES node showed I/O pressure
`full avg10=43.50` with low CPU usage. Resource headroom and application fixes
do not resolve this shared-storage bottleneck. PNG/JPEG FITS previews remain
future work. Do not report sustained fast queries or image previews as complete.

Download hashes, browser interactions, measurements and validation limits:
[release notes](docs/workspace-download-performance-20261105.md).
Private receipt: `/tmp/workspace-download-perf-20261105-cv_fv5iz/`;
pointer: `/tmp/workspace-download-perf-receipt-path`. These changes were later
committed as `6c99df0`, following `e22c940`. r1/r2 were full Docker builds; r3 overlays the two
changed compiled server modules and the complete newly built Viewer on r2.

Final revision 148 checks passed: deployed module/Viewer hashes match the local
build; the last Helm upgrade changed only the Workspace image; ES and downloader
remain Ready with zero restarts. UI/CLI/API expose 215 files, and both HTTP and
browser ZIP downloads contain the verified FITS. The final 2,000-point query
took **15.382 s / 45,890 bytes**, W2 **16.310 s**, ZIP **74.136 s**. Warm public
footprints took **0.009 s**. Browser home initialization took **0.333 s**;
Workflow initialized in **11.136 s** while public requests were deliberately
held, with no page/API errors or initial Aladin download. API timings live in
the receipt's `r3/live-verification.json`; browser results are in
`browser-verification.json`. Main-process wait sampling observed
`rpc_wait_bit_killable`; NFS waiting remains unresolved.

The Aladin HEALPix anchor fallback shipped in revision 142; revision 143 added
the Viewer query changes. Revisions 144 and 145 disable exact hit counting by
default on viewport requests, skip it in density searches, and expose a lower
bound when the API does not receive an exact total. Those releases overlaid
only the two compiled query modules on the r1 runtime image.

## Aladin HEALPix 2071 query and anchor (November 5, revision 145)

The W2 asset `user-b792b28e-aa41-47a8-aed4-a36245951509` includes NESTED
NSIDE 16 pixel 2071. A prior full-region point query found about 13,173 rows;
the initial Aladin viewport query could time out after 30 seconds. Before this
fix, the viewport error path did not proceed to the region anchor lookup, so
the map could remain blank even though the selected asset had indexed points.

Aladin now obtains an anchor on entry and continues to the anchor fallback when
the initial viewport query fails. The anchor response includes the real point
record from the same Elasticsearch request; Aladin renders it and centers on
its coordinates without a second ES detail query. While indexing is active,
temporary query errors clear and retry on the 10-second refresh cycle.

Aladin point viewport requests default to `track_total_hits=false` at the API;
callers must explicitly opt into exact hit totals. They still fetch and paginate
matching point records. Without exact counts, the API reports the number
returned with `totalRelation="gte"`, and the Viewer uses the full loaded point
count. Density requests also skip exact hit totals and derive their total from
the cell aggregation already required to draw the map. The same-bbox Dev
comparison returned one point in **15.1 s** without exact totals; with exact
totals enabled, it took **45.5 s** and timed out.

After revision 145, a bounded pixel 2071 query for RA 78.2-78.3 and Dec
-66.2 to -66.0 returned the known point in **7.05 s** with HTTP 200,
`total=1`, `totalRelation="gte"` and `indexing=true`. `/healthz` returned 200.

These are filtered Elasticsearch searches, not `match_all`: for NSIDE 16
pixel 2071 the region filter projects to native order 8 pixel range
530176-530431, with `healpix_order=8`; the viewport adds RA/Dec ranges and the
selected `asset_id`. Workspace searches both `astro_object_index_v1` and
`astro_data_point_index_v1` so catalog rows and derived FITS points are both
available. At the measurement, those indices held about 1.72M and 1.36M docs.

Remaining latency is attributable to the live environment as well as query
work: Elasticsearch is limited to 1 CPU / 2 GiB and used 1,823 MiB in the
observed sample; two W2 scanner Pods were active. Before each search, the
current FITS quality-batch visibility filter reads all 23 asset records and
669 ingest-run records (the list endpoints took 2.1 s and 2.6 s respectively),
then retains four quality-profile FITS assets. That is a separate app-side
cost and is not a full-table Elasticsearch query.

Read-only Dev evidence: the full-region anchor query can also time out during
the active W2 scan, with `indexing=true`; a narrow bbox inside pixel 2071
returned object `25540a5c5f0c8a9f15c05f0858fd7f484a59adae4a42c4d8f9e93ff6bff990b3`
at RA **78.2502213459592**, Dec **-66.11439829855028**, from the selected W2
asset. This confirms data presence and exposes remaining Elasticsearch load
as the reason a broad query may need retries. The indexed record says release
`csst-simulation-w2` but product `CSST Simulation W1`; that metadata mismatch
was not changed.

Helm revision 143 is Ready with zero restarts; `/healthz` returned 200 and the
deployed HTML referenced the new Viewer bundle. Viewer typecheck/build and
`git diff --check` passed. The browser runtime reported no available browser,
so this turn did not perform a visual Aladin interaction check.

## Historical session context: Workspace Agent workflow and science acceptance

The deployments and next-session instructions below describe earlier sessions.
Use the November 6 current-state section above for runtime and scan control.

Read the [session handoff](docs/session-handoff-20261103-agent.md) for Agent
entry points, current deployment, scan recovery, validation limits and private
evidence locations. The November 4 progress notes below are historical.

The user committed Workspace changes on `main` as
`008d1b478a4863f257a5b63ae76ac60b4a8c7a53`. The Workspace worktree was clean
when the earlier handoff was prepared. The bottom Workspace Agent implementation
is now present as uncommitted Workspace changes; its service is
`src/workspace-agent.ts` and its UI controller is `viewer/src/agent-dock.ts`.
Read the session handoff for current capabilities, validation and live
acceptance requirements. The sibling Warehouse still has uncommitted
implementation changes.

The current Dev release is Helm revision **138**, image
`0.0.1-dev-20261104-agent-r16` (running image digest
`sha256:79393af82c9d47647f8aeae07002794d4aa618ddba577be4a23e56707cbef1c6`).
The Workspace Pod is Ready with zero restarts and `/healthz` returns 200; the
Search initialization Job completed. The Downloader remains on its prior image
and Pod with zero restarts. The new CLI `workflows runs` command lists the
three current runs, all waiting at `human_filter`; `cutout` and `export` are
pending. Two runs have identical inputs with cutouts enabled; the earlier third
run differs only by disabling cutouts. Two Scanner Jobs were active at the
post-deployment check. This is deployment and read-only Workflow evidence, not
full scientific or researcher acceptance; see the latest session-handoff
section.

The earlier r15 release was Helm revision **137**, image
`0.0.1-dev-20261104-agent-r15` (digest
`sha256:388cc6bf3a6258ce92ff51def83b0d70fbf983b868772439c9babec6bc51884d`).
Its bounded Agent access to registered CSV/JSON Workflow artifacts is included
in r16.

All three current runs have 46 crossmatch candidates and are still waiting at
`human_filter`. A read-only check confirmed the matching Euclid tile and DESI
brick image objects are covered by ready S3 Connectors; none of the runs has
executed FITS cutout or export.

The deployed r15 image includes bounded Agent access to registered CSV/JSON
Workflow artifacts through the CLI. The live Agent read `crossmatch.csv` for the
existing run without making a decision; the run remains at `human_filter` and
cutout/export remain pending. The source change passed `npm run verify` before
image publication; see the final section of the session handoff for the live
acceptance details.

**Scanner result-acceptance blocker repaired and deployed on November 3.**
Scanner JSON now includes `partitionVersion`; the Operator reads it and accepts
old JSON only with matching complete legacy evidence. Operator revision **27**
uses `0.2.0-20261103-partition-summary-r2`; its default Scanner has the same tag.
The ScanRequest CRD now retains the single-use recovery audit fields.

Seventeen original successful Jobs were explicitly revalidated, preserving
34,000 accepted files, original request/Job identities and frozen inventories.
Their failed Workspace child runs resumed normal polling and automatic point
integration. Public W1 point queries and image-footprint inspection now return
results (1,370 new points at 14:40); W1 has 18 successful shards / 36,000
accepted files. Incremental integration is still running. Read the handoff for
the latest counters and evidence. All four original batches remain in place.

W1/W2/W3/W4 inventories are now all frozen at 356,112 / 365,472 / 188,136 /
211,824 files. Full scans are ongoing; W2–W4 are waiting for Scanner slots.
After that recovery snapshot, partition `s000018` failed on a real Warehouse
Elasticsearch refresh timeout (`BackoffLimitExceeded`). This is a separate
execution failure; it is retained and is ineligible for summary revalidation.
Full scans continue. Fresh remote Workspace caller smoke passed; the other
live suites did not all pass because of ES timeouts and external MOC TLS.

At the time of the CSST repair snapshot, Workspace was at revision 122 /
`0.0.1-dev-20261103-csst-quality-r3`; that repair changes Warehouse code and
runtime metadata, with no Workspace product-code changes. The later Agent
deployment advanced from revision 137/r15 to revision 138/r16. The Agent
implementation is Workspace-first; live scientific acceptance still depends
on configured AI Provider and scientific MCP services.

## Earlier deployment and progress notes

The CSST quality repair is deployed to Dev at Workspace Helm revision **122**,
image `0.0.1-dev-20261103-csst-quality-r3`, with Warehouse Operator revision
**26** and scanner `0.2.0-20261103-csst-quality-r1`. Read
`docs/csst-w1-w4-quality-rescan-20261103.md` for policy, validation and the four
full-scan root IDs. All Warehouse scans now skip deterministic file errors by
default; transport/runtime/index failures remain explicit. CSST additionally
uses `csst-wcs-v1`: nominal scale tolerance 1%, axis-angle tolerance 1°, missing
nominal scales rejected. Workspace excludes rejected headers and previous
quality generations from all point/bounds/coverage query paths.

The user explicitly authorized full W1–W4 rescans on November 3; this supersedes
the older limited-CSST instructions below. Four uncapped durable batches are
submitted against the actual W1_Phot–W4_Phot sibling sources, with 2,000 files
per shard and at most two Scanner Jobs globally. At 12:40 Asia/Shanghai, W1
had frozen its complete 356,112-file inventory into 179 shards, with two
Scanner Jobs running and no completed or failed shards. Their private writing
checkpoints contained 814 accepted files so far; those are unfinished shard
results, not published points or completed root counters. W2 was enumerating
(45,738 discovered files); W3–W4 remained queued. This is ongoing work, not a
claim that the complete inventories have been scanned. Source listing runs in the
background, allowing already frozen batches to continue scanning and publish
accepted positions while another source enumerates. Restarts resume existing
listing checkpoints and jobs. Aladin reports indexing throughout queued scans
and source enumeration, before the first point task exists, and continues
automatically refreshing. Do not submit duplicate batches.

End-to-end real-source acceptance passed for 32 FITS files: 20 accepted and 12
skipped, producing 20 positions and corresponding bounds; all four private
MOCs are ready. The 12 historical sample IDs now return HTTP 404. Historical
evidence and raw sources remain intact; old derived documents are logically
isolated by the publication filter. Workspace full verify passed with 409
tests, four skipped, zero failures. Warehouse static gates passed; S3/local
and Asset scan assertions passed, and both Workspace caller smoke tests
reported PASSED. The baseline/Asset suites still report the existing external
Gaia MOC `DiscoveryTlsError`, documented separately in the report. Private
receipts and baseline diffs are at the directory named by
`/tmp/csst-quality-implementation-path`.
The private receipt also contains a running read-only first-shard observer,
`monitor-first-shards.py`, which writes `first-shard-live-validation.json`
to check completed shards for queryable points/bounds, matching counters and a
working skip-report download. Require `passed: true`; the initial checks may
still be pending during automatic indexing. Check that receipt before repeating
validation; it does not resubmit scans or index any data.

The selected-coverage loading, selection preservation and Aladin empty-region
UX fixes are deployed to Dev at Helm revision **119**, image
`0.0.1-dev-20261102-coverage-ux-r1`. Coverage loads selected assets first and
cancels unrelated background reads. Aladin distinguishes an empty viewport
from a region without indexed centers; image coverage has an explicit
coordinate inspection action. Entering and leaving Aladin preserves the
external checkbox selection. See the November 2 deployment section below.

The latest Aladin density counts and double-click navigation are deployed to
Dev at Helm revision **118**, image
`0.0.1-dev-20261030-aladin-density-counts-r2`. FOV above 1.5 degrees uses
density cells with survey counts; double-clicking a cell centers it at FOV
0.5 degrees. This includes the earlier viewport loading, cancellation,
Inspector, initial navigation and direction guides. See the final deployment
section for live verification details.

The coverage overlap order slider and C0x camera navigation shipped to Dev at
Helm revision **109**, image `0.0.1-dev-20261029-overlap-slider-r1`, and remain
included in the latest deployment. Preserve all existing staged and uncommitted
work.

The subsequent scan-visibility fixes are deployed to Dev at Helm revision
**111**, image `0.0.1-dev-20261029-visible-points-r2`. COSMOS now counts its
1,720,500 real catalog rows and exposes their occupied cells as a temporary
preview. **查看数据点** opens Aladin at an actual indexed coordinate. Successful
Warehouse shards immediately generate positions from retained companions;
the interrupted CSST deep v2 and Euclid batches have resumed their existing
frozen manifests, with at most two Scanner Jobs. See
`docs/workspace-visible-points-20261029.md` and the final deployment section.

The earlier read-only audit remains in `docs/workspace-scan-status-20261029.md`.
It is a historical baseline, not the current running/point state. Inventory
growth still does not imply new published coverage or bytes actually read.

The preceding request implements trustworthy capacity statistics and a bounded,
durable Scanner Job queue before considering Flink. The October 15 statistics
and encrypted configuration backup are deployed to dev. The October 26 work is
also deployed and verified on dev at Helm revision 104, image
`0.0.1-dev-20261026-parallel-scan-r9`; see
`docs/scanner-capacity-validation-20261026.md` for the evidence and deployment
receipt. Preserve the substantial uncommitted changes in both active repositories.

The user authorized metadata inventory refresh and two bounded CSST runs of
4,000 files each, with concurrency 1 and 2, on a separate validation asset.
Do not submit a full CSST coverage scan. Original successful CSST evidence has
356,112 files and 63,779,659,200,000 source bytes; it is not transferred bytes.
Independent logical runs accumulate again, while retries of one partition do
not. A 3 PB cumulative goal is supported numerically, not a measured throughput
or a claim that 3 PB has already been scanned. Keep at most two Scanner Jobs,
each requesting 500m CPU / 512 MiB and limited to 1 CPU / 1 GiB.

Assets public data, evidence and releases are outside this task. Private files,
coordinates, repair inventories and receipts remain in Workspace. The sibling
`Astro-Survey-Atlas-Warehouse` is the active Warehouse repository;
`/home/aaron/Repo/data-warehouse` is frozen legacy code.

The user also authorized the complete overlap/UI/download plan, independent
aria2 deployment in the existing k3s cluster, LAN HTTP proxy configuration and
recovery of the existing five-file Euclid download. This work is now complete;
see the October 12 results below. Failed retry records were cleared on October
13; the verified output and Connector remain. Do not start another download of
these files.

Earlier private MOC repair, FITS position indexing, Aladin work, historical
error cleanup, and the v0.0.1 release are complete and documented below. They
are not instructions to start another repair or deployment for those datasets.

## Implementation

- Statistics run in a worker using a local SQLite database and consistent
  sequential snapshots on shared storage. Do not restore direct random SQLite
  I/O or SQLite backup writes on NFS: both caused health failures during dev
  verification. Historical evidence is streamed and validates run/layer/snapshot
  identity; metadata inventory refresh checkpoints each page and exposes partial
  progress without inventing zero totals.
- Warehouse batches freeze checksummed private NDJSON inventories, at most
  2,000 files per shard, and an external roster. Restart adoption and failed
  shard retry reuse these immutable files. Each new logical batch owns a distinct
  Warehouse layer; only a complete successful batch replaces the asset's current
  Warehouse coverage. The merged private MOC keeps the canonical asset identity.
  This fixes Warehouse rejecting an independent rescan as a different immutable
  partition scope. Older successful whole-layer scans remain usable.
- Completed image shards automatically consume retained header companions for
  positions; no second science-source download or manually submitted repair is
  needed. Flink remains disabled. Workspace's own executor remains available
  when Warehouse is disabled or explicitly bypassed.

- `warehouse-evidence-stream.ts` streams individual file/coverage rows with
  bounded 1 MiB input chunks. MOC import validates identities and actual NESTED orders,
  deduplicates native cells through bounded GNU sort, and sends a CSV file to
  pinned MOC Core. It never reads the 4.29 GB normalized evidence as one buffer.
- `derived-repairs.ts` persists independent MOC/position tasks. Repairs preserve
  original records. The MOC caller explicitly supplies the default Core adapter;
  a service-level regression locks down this previously missing call.
- `warehouse-inventory.ts` caches a checksummed finite file inventory. Existing
  scans use plain metadata-only Kubernetes Jobs, 8 workers, ranged FITS headers,
  and durable checkpoints. New scans retain a header companion automatically,
  so their positions can be built without reopening science files.
- Warehouse `FitsHeaderReader`, `PositionReplay`, and `BoundedExtraction` jump
  over image arrays, retain multiple HDUs, resume committed outputs, and preserve
  normal coverage behavior. They do not submit another coverage ScanRequest.
- Astropy converts each qualifying science HDU to a real ICRS image center.
  Auxiliary HDUs are excluded. An explicit header pointing is a fallback;
  missing positions remain errors. Image centers are not detected stars.
- Private points use `astro_data_point_index_v1`. Stable IDs make batch retries
  idempotent. File/HDU, method, frame, original snapshot and raw headers remain
  available through lazy detail requests.
- Transient index writes keep tasks running with durable 10–120 second backoff.
  A new position repair for the same scan/snapshot/sample reuses the existing
  header Job/evidence, preserving the earlier failed task. Counters and byte
  offsets advance only after batch success, including ambiguous partial writes.
- Aladin inherits concrete externally selected public/private layers and the
  frozen entry region. Checkboxes narrow that set. Requests intersect the
  region with the viewport and OR explicit scopes of asset AND optional source.
  Empty selection issues no global query. Undownloaded/unscanned public coverage
  creates no points. Initial field of view follows the entry region.
  Entry creates layer descriptors without querying an entire region first;
  coordinates are requested only once the actual Aladin viewport exists.
- The selected-region legend derives public survey names from the selected,
  visible footprint artifacts. Workspace asset entries are marked separately,
  so a Workspace survey identity cannot add an unchecked public survey to the
  survey list.
- Aladin grid lines use theme-specific red. Its icon handle is integrated with
  the Exploration Deck rail, layer rows are compact, and clicking a data point
  opens a coordinate Inspector grouped by selected layer, with nearby catalog
  matches and indexed images plus an adjustable match radius.
- Overlap computation displays a spinner until the current response arrives,
  distinguishes empty/error states, discards stale responses and automatically
  selects C01. Source cards share the HEALPix Inspector style, grouped by actual
  public source and Workspace asset identity.
- Downloads run in a separate aria2 1.37.0 supervisor with shared production
  storage, authenticated internal API, loopback RPC, persisted engine session,
  Range/version checks and final size/SHA verification. Workspace reattaches
  instead of interrupting transfers on restart. Legacy `.part` files are reused.
- System Settings has download HTTP proxy configuration, masked credentials,
  30-second persistent route heartbeat and a bounded speed probe. Dev uses
  `http://10.15.49.212:7890`. Heartbeat synchronization supplies the actual
  download source on every attempt; ESA homepage redirects are a poor probe.
  Source transport failures/429/5xx, DNS errors and temporary overload retry
  with durable 15–300-second backoff; progress resets consecutive failures
  while preserving the total retry count. File/version/range/auth failures
  retain their diagnostic and partial data for explicit handling.
- Queries indicate ongoing production backfill with `indexing`; Aladin keeps
  existing points and refreshes unchanged viewports every 10 seconds until
  complete. Empty selection and disposal stop refresh. Image centers/pointings
  are excluded from scientific object coincidence markers.
- Operational coverage, catalog object count and header point count are
  independent. ACTIVE Warehouse coverage takes precedence over a failed
  derived artifact for operational coverage status.

## Verification baseline

Workspace `npm run verify` passed after the refinements: 367 tests passed and 2
were skipped; server, viewer, CLI and strict Helm checks passed. Aladin browser
regressions cover viewport-only queries, frozen region/layers, Escape,
unchanged-view refresh during backfill, multi-survey Inspector results, empty
and failed Inspector queries, match-radius changes and mobile drawer layout.
The selected-region legend regression models two visible public surveys and an
unchecked third survey whose identity is also present on a selected Workspace
MOC; it verifies only the two visible public surveys appear. That focused browser
test passed again after the regression was added. `npm run verify:types`,
`npm run build:viewer` and `git diff --check` also passed. Public package
activation state was restored afterward.
Logs are outside Git under `/tmp/workspace-verify-header-r6.log` and
`/tmp/workspace-aladin-final-r5-e2e.log`. At that point the final r6 change only
removed obsolete run errors from a ready operational status; the separate
October 13 maintenance operation later cleared failed history as requested.
The r6 regression was observed failing before the fix and passing afterward.

Warehouse static gate passed in full: Maven test/verify/quality, both Helm
lints/renders, Compose config, mapping sync, shell syntax and diff checks.
Warehouse S3/local/MOC baseline, Assets caller, Workspace local caller and
Workspace remote caller all reported PASSED using synthetic fixtures and the
new scanner. No CSST directory was re-enumerated by those checks. Actual
Workspace namespace is `asa-workspace`; the validation skill's old namespace
default does not match this cluster. For the removed MinIO client tag use
`MC_IMAGE=docker.io/bitnamilegacy/minio-client:2024.3.9-debian-12-r0`.

Real HST HTTP verification passed asset/source and region/viewport scoping,
empty selection, unselected-source exclusion and lazy file/header details.
One file yields exactly two science image centers, HDUs 1 and 4. This does not
claim complete two-chip geometry for the original first-WCS coverage recipe.
The real Dev browser showed both markers, 2/2 counts and translated science HDU
details, with no page errors. Every point query included the actual viewport and
frozen entry region. The browser harness now selects the known covered O4 cell
1002 and opens its context menu synchronously; the former first-edge click could
land in the adjacent public-only cell 725 after camera movement.

CSST 64-file sample passed with 64 image centers and zero header/coordinate
errors. Replay measured 7.74 seconds, 128 headers, 384 Range requests and
1,105,920 scientific-source bytes read. Samples do not populate the production
index. Inventory preparation reads historical normalized evidence once; this
is separate from the header extraction measurement.

## Live tasks

- HST successful positions: `derived-c485b1dc71bd469e8458934a`.
- HST footprint repair `derived-f9a0f22be38f4361b1c75893` succeeded using the
  existing header evidence: 2 footprints, 0 errors.
- Euclid download `coverage-download-48e6840d-6541-4235-aeda-60793190635d`
  completed on October 12: 5/5 verified, 7,372,828,800 bytes. The same request
  key `production:prd_20261010060559_8d1cca8a`, inventory SHA-256
  `820bd646d773d9e5975668fb51a17579b5c632247d6dce2615619a292270c92e`,
  output `/data/production/files/prd_20261010060559_8d1cca8a` and Connector
  `connector-de8c51e0-f518-40d1-a8c6-ea688d9a3af9` were retained.
  CFIS-U and PANSTARRS-I resumed their old partials; the other three hashes
  stayed unchanged. Independent disk hashes and FITS primary headers passed
  for all five. New ProductionRun `prd_20261012042740_a44da7e5` succeeded,
  reusing the original approved inventory and the same download job. Original
  The earlier failed download and ProductionRun records were inspected before
  cleanup; October 13 maintenance removed those two failed history entries.
  The completed download, its successful ProductionRun and Connector remain.
  Receipt: `/tmp/workspace-download-recovery-final.json`.
- CSST successful sample: `derived-6a930a34a0094899bcd3f276`.
- Successful CSST MOC repair: `derived-7c11ab92d14b4549a4cd056e`.
  Actual decoded native maximum O10, 32,250 MOC cells, 18,525 O8 query pixels,
  unchanged 372 O4 preview pixels, precision estimated. All five artifact
  sizes/hashes verified; receipt `/tmp/workspace-csst-moc-validation.json`.
- Full CSST positions replay `derived-54cf71e7a197406f8fb82663` completed on
  October 10 using the existing metadata-only Job and stable point IDs:
  356,112/356,112 files processed, 356,112 points indexed, 10,555,871,904
  bytes indexed, and zero header or coordinate errors. The successful task
  remains available in Workspace.
- CSST original coverage: 356,112 files, 7,167,326 rows, zero errors, ACTIVE O10.
  The original Workspace import failure was the Node 2 GiB whole-buffer limit,
  not a failed Warehouse scientific scan.

Dev URL: `http://astro.workspace.dev.72602.space:32080`.
Use `curl --noproxy '*'` for this local endpoint. Helm release is `asa` in
`asa-workspace`; retain existing values on upgrade. Workspace memory limit is
2 GiB; local ES request/limit is 1/2 GiB with 512 MiB heap. Keep ES sizing
unchanged during data repair.

### Current Dev deployment (October 26)

Release `asa`, namespace `asa-workspace`, revision **104** is deployed. Pod
`asa-workspace-dd64c7d48-fswhp` is ready with zero restarts. Image tag is
`0.0.1-dev-20261026-parallel-scan-r9`, image digest
`sha256:f99fc96f6bafcf5e2707902a1a9f3a617634f13171825b3421f0bdafd4070871`.
The image overlays compiled artifacts onto the previously validated runtime;
dependencies are unchanged. Workspace still requests 100m CPU / 128 MiB and
is limited to 1 CPU / 1 GiB. Warehouse Operator revision 21 and Scanner use
`0.2.0-20261026-inventory-shards-r1`; Flink remains disabled.

The final Workspace gate passed: 382 tests, 378 passed, four optional checks
skipped, zero failures, plus types, server/viewer/CLI builds and Helm checks.
Final dev API/browser checks passed after rollout: coverage ACTIVE, merged MOC
ready, exactly 4,000 validation-asset points with `indexing=false`, all four
automatic header tasks successful, two successful shard rows, logs available,
asset/Connector size displayed, and no browser page errors. The two authorized
4,000-file runs are complete; do not submit another run to repeat acceptance.

Recovered current source capacity is 356,118 files / 63,787,066,372,800 bytes,
including CSST's 356,112 files / 63,779,659,200,000 bytes. Global current capacity
is partial because another linked asset has not been scanned. Cumulative
successful capacity is complete at 364,118 logical files / 65,219,795,029,440
bytes (65.22 TB). Independent rescans count again; retries do not.

Accessible metadata inventory is still running as
`32498ebe-ddd4-41d5-9366-da475771a252`. It resumed the same saved task after the
final rollout, with 216,121 processed files, 1/5 Connectors completed and no
listing errors at 10:21 UTC. At that point 210,121 accessible files / 19.53 TB
were confirmed; this is a partial subtotal, not the final source total. Inspect
`/api/data-statistics` for live progress. Do not start a duplicate refresh or
infer coverage scans from the metadata listing. Private deployment, API and
browser receipts are recorded in the validation document.

The full CSST replay is complete; do not submit another coverage scan. Original
CSST/HST ScanRequest spec/status were compared exactly before history cleanup
and remained unchanged. Failed MOC metadata entries were removed on October
13; successful MOC artifacts and their files remain.

## Previous Dev deployment (October 10)

Helm revision **84** is deployed and healthy, one ready Workspace Pod and zero
restarts. Image `0.10.38-dev-20261010-aladin-inspector-r1`, registry digest
`sha256:10aafc7ab2cbf5b64e819755fd3862f89df02d41c99cc0e39114ebe5b940c748`.
The image is based on the verified immutable r6 runtime layer and includes the
updated service, viewer and coordinate conversion script; container syntax
checks passed. The complete Docker source build did not finish because npm
network access failed in the build environment. Local `npm run verify` passed.
Workspace requests remain 100m CPU / 128 MiB memory and limits remain 1 CPU /
1 GiB; Elasticsearch settings and scanner are unchanged. `/api/capabilities`
and the page's updated JavaScript and CSS were confirmed on Dev.

The CSST header Job retained its original UID and creation time through both
deployments. Its committed header output exceeds 2 GiB and continues normally;
the indexer consumes bounded batches. The tested scoped region increased from
98 to 531 matching image centers and returns `indexing:true`. Operational
status reports ready coverage, ongoing point backfill, and no obsolete import
error. HST reports ready coverage, two points with a succeeded point task, and
the successful two-footprint repair.

Private verification record: `docs/workspace-header-repair-verification-20261010.md`.
Machine receipt: `/tmp/workspace-header-repair-final-receipt.json`. Logs,
screenshots and receipts remain outside Assets; no private data was published.

## Previous Dev deployment (October 12, R2)

Helm revision **86**, image `0.10.38-dev-20261012-download-worker-r2`, digest
`sha256:44f5572027ebf4868d54c01a3a5c005d73854991106b4e90bb8b862644b455b1`.
Workspace and downloader are ready with zero container restarts. The worker
uses `asa-workspace-production-data`; only one worker replica owns transfers.
Workspace and ES limits are unchanged. Downloader requests 100m/128 MiB and
limits 1 CPU/512 MiB. Worker restart preserved a paused task at 7,293,442,560
bytes; after resume, Workspace-only restart retained the same downloader Pod
and downloads completed. Production recovered automatically and succeeded.

Type checks, server/viewer/CLI builds and Helm strict/default/downloads-enabled
rendering passed. Before the final worker refinements, full unit results were
369 passed/2 skipped. Final focused checks: 4/4 worker tests (real aria2 resume,
pause/restart, transient 503 recovery, Workspace reattachment, private URL and
credential handling) and 28/28 related download/production tests passed.
Browser checks passed: overlap 10/10, settings 1/1, Aladin 3/3 and the focused
Selected-source regression 1/1. Its initial fixture failure was corrected by
mocking operational status so unrelated slow live calls cannot stall the test.
The live Dev browser also verified C01 automatic selection, actual HST points
and coordinate Inspector, proxy health and the current styling without page
errors. It needed an explicit browser proxy bypass for the local Dev host.

ESA through the configured proxy currently uses certificate-verified TLS 1.2,
scoped only to `eas.esac.esa.int`, based on observed default handshake failures.
The source Dockerfiles build normally; this release used the verified previous
runtime with fresh local compiled outputs, CA certificates and the pinned
aria2 binary because upstream npm/Docker Hub access was unreliable.

Verification: `docs/workspace-download-ui-verification-20261012.md`.
Screenshots/receipt: `/tmp/workspace-live-download-ui/`.
No further Euclid download work is pending. October 10 CSST/header progress
above is historical; query the existing task for its current status instead
of restarting scans or enumerating directories.

## Previous Dev deployment and download-to-coverage closure (October 12, r3)

Helm revision **87** deploys Workspace and downloader image
`0.10.38-dev-20261012-download-closure-r3`. Both Pods are Ready with zero
restarts. Registry manifest digest:
`sha256:61633a02e40d533913cb0c7b5533f80eb60c38f9297ee3c7cfba8328bcbf6ba0`.
The update used `--reuse-values`; existing resource limits, shared storage,
proxy settings, Warehouse settings, and aria2 configuration were retained.

The scan failure was reproducible: the automatically-created Euclid Connector
had no current successful connection check and no linked user image asset.
Connector self-scan rejected it first for the missing check, then for the
missing asset after the check succeeded. Production now creates a user image
asset for verified image/imaging FITS files, records its survey/release/product
and source-relative directory, checks the local Connector, and submits the
Warehouse coverage scan with an idempotency key. Other FITS files are not
assumed to be images.

The already-downloaded Euclid files were not downloaded again. The existing
Connector `connector-de8c51e0-f518-40d1-a8c6-ea688d9a3af9` was checked, and
asset `user-6316849e-5111-40b0-9bc0-449486883025` was registered for
`euclid/euclid-q1`, product `Euclid Q1 color imaging`, at
`sources/public-euclid-euclid-q1-euclid-20q1-20co-80100982`. Its scan
`ingest-cef3169f-6a5a-4b85-aad7-60f3f89847e8` succeeded: 5 FITS files,
525 coverage records, zero errors, O10 coverage and a ready MOC. The follow-on
position index contains five image centers and reports success. No existing
CSST/HST coverage sources were rescanned or enumerated.

System Settings now contains the saved download proxy endpoint and a plot of
the latest 24 proxy/direct-route latency checks. Download history is not shown
there. The corresponding UI and scan evidence is recorded in
`docs/workspace-download-ui-verification-20261012.md`.

## Previous Dev deployment and Connector discovery (October 12, r4)

Helm revision **88** deploys Workspace and downloader image
`0.10.38-dev-20261012-connector-link-r4`. Both Pods are Ready with zero
restarts. The pulled image digest is
`sha256:e8a7018ce840eef87da3a4f61b5d42be655c9afa531a0514c2ef01572930efdb`.

Workspace's production execution detail resolves `outputConnectorId` and shows
the live Connector name, output path and ID, with a button that opens the same
record in Connector Registry. Connector search accepts the Connector ID and
associated asset metadata. Production record `prd_20261012042740_a44da7e5`
links to Connector `connector-de8c51e0-f518-40d1-a8c6-ea688d9a3af9`. The
download reused its existing request/job and storage directory, so its output
remains `/data/production/files/prd_20261010060559_8d1cca8a`; the older run ID
in the path does not identify a different download or Connector.

Using Workspace's Connector editor, the record was renamed to
`Euclid Q1 color imaging (Workspace)` and its description now identifies the
production record, linked `euclid/euclid-q1` asset and successful O10 scan. The
existing scan `ingest-cef3169f-6a5a-4b85-aad7-60f3f89847e8` is visible in
Workspace scan history and succeeded with 5 FITS files, 525 coverage records,
zero errors and a ready O10 MOC. Its five image-center index entries also
succeeded.

The production record's Warehouse submission step remains `skipped`: that
execution predates the automatic handoff. The successful coverage scan is a
separate later Workspace record using the already-downloaded files. Scan
history retains the Connector name captured at execution time,
`Coverage download 60793190635d`; it is the same Connector ID above, not a
second Connector. Current details, production-to-Connector navigation and
scan-history lookup were verified in the live Workspace UI. Screenshots are
outside Git under `/tmp/workspace-production-connector-r4-final.png`,
`/tmp/workspace-euclid-connector-final.png` and
`/tmp/workspace-euclid-scan-history-final.png`.

## Previous Dev deployment and product-aware Connector names (October 13, r5)

Helm revision **89** deploys Workspace image
`0.10.38-dev-20261013-product-connector-r5`; the Workspace Pod is Ready with
zero restarts. Its pulled image digest is
`sha256:2f1fc081de089afba2ac8ed9b3926f4906ae33c43a53ec9f12d8c99eb6b3a1e1`.
The downloader remains on `0.10.38-dev-20261012-connector-link-r4`.

New download-created Connectors now use the source product, survey/release,
overlap component and output-directory reference in their name. A single-source
Connector also receives survey and release tags. The live Euclid record is
`Euclid Q1 color imaging · euclid/euclid-q1 · C01 · 8d1cca8a`; its unchanged ID
is `connector-de8c51e0-f518-40d1-a8c6-ea688d9a3af9`, and its directory remains
`/data/production/files/prd_20261010060559_8d1cca8a`.

The existing Euclid Connector was updated through the Workspace Connector
editor to match the automatic naming rule; no download or scan was repeated.
The live `/api/connectors` response includes this name, product description,
`euclid/euclid-q1` tags and successful local path check. The Connector tab
renders this same `name` field in its list row, so the downloaded product is
identifiable directly in the list. The earlier r4 name
`Euclid Q1 color imaging (Workspace)` was an intermediate UI-edited name.
Connector-name code and regression details are in
`docs/workspace-download-ui-verification-20261012.md`.

## Previous Dev deployment and error-history cleanup (October 13, r6)

Helm revision **90** deploys Workspace image
`0.0.1-dev-20261013-cleanup-r1`; the Pod is Ready with zero restarts. The
download worker stayed on its prior image. The upgrade used `--reuse-values`,
preserving existing storage, proxy, Warehouse and resource configuration.

The loopback-only `POST /api/maintenance/failed-history/clear` endpoint was
called from inside the Workspace Pod with its explicit confirmation value.
It removed 10 failed Connector scans, 2 failed downloads, 4 failed Production
runs, 2 failed derived repairs, and 12 failed, unavailable or dangling-pending
MOC metadata entries. It deletes MOC metadata records only; successful MOC
artifacts, downloaded science files and completed records were preserved.
Public Workspace API verification found zero failed/unavailable entries and
retained 4 successful Production runs, 4 completed downloads, 3 successful
Connector scans, 7 successful derived repairs and 3 ready MOC artifacts.
Kubernetes reported no failed Jobs. The maintenance endpoint returned 404
through the public ingress.

Live CSST status was verified through Workspace during this deployment:
356,112 files processed, 356,112 points indexed and zero header/coordinate
errors. `npm run verify:types`, `npm run build`, `npm run verify:chart` and
`git diff --check` passed. The Dockerfile source build hit an npm internal error
in `npm ci`; this Dev image overlays the validated local build outputs on the
currently deployed runtime image. The v0.0.1 release was still pending here;
see the current deployment section below.

## Current Dev deployment and v0.0.1 release (October 13, r7)

Git tag `v0.0.1` and `main` point to commit
`99033ca8e0fa1a20c43ce44cf163116b2d7202c7`. Release workflow run
`38343022050` completed successfully. It published the Workspace image to
GHCR and Aliyun as `0.0.1` and `0.0.1-20261013-034311`; the GHCR OCI Helm
Chart is version `0.0.1`. The public GitHub Release has six assets, including
the Windows setup executable, its blockmap, and `latest.yml`:
`https://github.com/Astro-Survey-Atlas/Workspace/releases/tag/v0.0.1`.

Helm revision **93** deploys the official Aliyun image
`0.0.1-20261013-034311` with digest
`sha256:a979f934f80776761028ae49646498af16da0752a0030876e9c0ba6a7b7d04f8`.
The Workspace Pod and existing downloader Pod are Ready with zero restarts.
The downloader remains on its prior r4 image. The upgrade reused the existing
Helm values, preserving shared storage, proxy, Warehouse and resource settings.
Workspace `/healthz` reports version `0.0.1`.

The first official-image pull hit a transient connection reset at the Aliyun
token endpoint. Workspace was restored on the verified r6 image; after checking
the registry endpoint from the host and a Pod, deployment of the official image
succeeded. Current API checks still show zero failed/unavailable records:
4 successful Production runs, 4 completed downloads, 3 successful Connector
scans, 7 successful derived repairs and 3 ready MOC artifacts.

## Workspace-independent scanning (October 13, worktree)

Workspace asset and Connector scans now use `WorkspaceScanExecutor` for local
directories and S3/OSS. It processes configured CSV catalogs and FITS image or
cube assets directly in Workspace, writes MOCs and data points to the Workspace
indices, checkpoints tasks, and resumes queued/running scans during service
startup. The Warehouse remote scan dialog remains available only as an explicit
optional operation when Warehouse is enabled and configured.

Production download tasks persist `scanExecutor` (`workspace`, `warehouse`, or
`none`), default to Workspace when its local index is configured, and retain
compatibility with stored `warehouseHandoff` choices. A successful download
registers verified FITS image assets and submits their Workspace scans. The
production detail includes the selected executor and resulting scan run IDs.
The asset view reports scan phase/file progress. The standalone user action
"修复 MOC / 补建数据点" was removed; existing derived-repair support remains
available internally for older Warehouse results.

`npm run build:server`, `npm run build:viewer`, and `git diff --check` passed.
Tests were not run in this turn. These changes are only in the local worktree;
the Dev deployment remains Helm revision 93 / Workspace `0.0.1` until a later
deployment is requested.

## Connector statistics and encrypted config transfer (October 15, worktree)

Connector statistics are stored as version-4 metadata snapshots. A user-triggered
refresh enumerates only selected, enabled local/S3 Connectors; successful scan
inventories are recorded after commit and historical successful manifests can be
backfilled. Totals deduplicate physical files. GET and asset views read cached
snapshots and never walk Connector roots. JDBC size totals are explicitly
unsupported. Connector has a Statistics tab alongside list and scan history;
user asset rows/details show asset size and associated Connector total.

System Settings exports Connector credentials, user assets/surveys, system
configuration and referenced secrets, desired Warehouse binding, active public
resource selection, and a whitelist of browser preferences into a scrypt/AES-GCM
encrypted file. Import validates and previews before replacing configuration,
remaps IDs and credentials, supports local-root remapping, retains scan/download/
production history, and records asynchronous public package restoration for
retry. A durable rollback journal is removed before best-effort cleanup of
restore-point files, so cleanup interruption does not invalidate recovery.

Focused tests cover SQLite file deduplication, wrong-password and tamper checks,
Connector/credential/asset remapping, missing local roots, retained history,
rollback cleanup failure, and public package restore retry. The Workspace local
scan HTTP fixture now models its data-point index and the minimal MOC Core
build/merge/project contract. FITS `scanSpec` validation is restricted to image
and cube assets.

Validation on October 15: `npm run verify:types`, `npm run build:server`,
`npm run build:viewer`, and `git diff --check` passed. `npm test` passed with
373 tests, 4 skipped. `npm run build` and `npm run verify:chart` also passed
before deployment. No statistics refresh, scan, production download, or release
was run during deployment.

## Dev deployment (October 15, revision 94)

Helm release `asa` in namespace `asa-workspace` is deployed at revision **94**.
Workspace image:
`crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/asa-workspace:0.0.1-dev-20261015-config-backup-statistics-r1`,
pulled digest `sha256:59a249c476af1fe5b9ebbec1027d101e448fa4595632f7a2140f57bb37b5a9f6`.
The image overlays this worktree's compiled server, Viewer and CLI plus the
coordinate helper onto the verified October 13 runtime base. The Helm upgrade
used `--reuse-values`; shared storage, downloader, Warehouse, proxy and resource
settings were retained.

Workspace, downloader and Elasticsearch are Ready with zero restarts; the
search-init hook Job succeeded. All Workspace, production-data and evidence
PVCs remain Bound. `http://astro.workspace.dev.72602.space:32080/healthz`
reports `ok` / `0.0.1`; `/api/data-statistics` returns successfully and reports
five Connectors and four assets. Its byte totals remain unknown until a user
manually refreshes the Statistics tab. No Connector directory was enumerated
for deployment verification.

The registry endpoint timed out through the configured local HTTP proxy; the
same endpoint responded directly, so only the image push bypassed proxy
variables. The Dev site is available at `http://astro.workspace.dev.72602.space:32080`.

## Dev connector scan continuation (October 28)

Workspace is deployed at Helm revision **108** with image
`0.0.1-dev-20261028-statistics-queue-r1`. The Workspace Pod is Ready with zero
restarts and a 2 GiB memory limit. Leave Elasticsearch sizing unchanged; it was
near its 2 GiB limit during observation, without OOM or circuit-breaker logs.

Inventory refresh `ec424a2e-f122-4ba2-b978-85c1662c7967` is running across 12
Connectors. At 08:47 UTC it had completed 4/12 Connectors and processed
1,129,168 objects; the current deep-v1 listing checkpoint had 128,242 objects.
Global accessible capacity was partial at 1,523,685 files / 180,751,703,589,527
bytes. This is inventory, not scanned data. Current scanned remained partial at
661,182 files / 118,424,028,772,800 bytes (last published 05:24 UTC); cumulative
scanned remained partial at 707,182 logical files / 146,767,937,745,832 bytes
(last published 07:32 UTC). Do not report either accessible inventory or
in-progress shards as completed scan totals.

Deep-v2 batch `ingest-e9da7d49-f9fb-475b-9706-72ac1e8fe316` covers 164,304 FITS
files in 83 immutable shards. At 08:44 UTC, 16 shards had succeeded, 2 were
active and 2 had failed, with 32,000 files processed. The two failures logged
Elasticsearch request timeouts during layer finalization, not a source-format
error. Keep at most two Scanner Jobs. Let the roster finish; after the parent
batch becomes failed, retry its failed shards through the batch retry path so
successful shards and frozen inventories are preserved. The current scanned
total publishes the new batch only after all shards succeed.

COSMOS CSV scan `ingest-1ad4d83e-0424-4384-96bf-b29f33f430ec` is still running
for one 109 MB file; its task reports zero completed files and the private MOC
scratch file was about 12 MB. Do not submit it again. MaNGA ssy2 already had a
53-shard attempt that failed on explicit RA/DEC WCS requirements, object-store
Range support and gzip FITS limitations. MaNGA DRP also has WCS/header failures,
including files with more than 64 HDUs. Euclid has many WCS/header failures;
LOFAR HEALPix projection is unsupported. HSC/Legacy Survey inventory prefixes
include HDF5, Arrow and Parquet data, which the current scientific scanner does
not process. Do not count these metadata listings as scanned content.

Workspace logs showed intermittent `database is locked` errors at 07:53, 08:02,
08:21 and 08:38 UTC. These are distinct from the deep-v2 Elasticsearch timeouts;
root cause is not established. No lock was observed in one intervening 10-minute
window. Continue monitoring rather than treating the lock as resolved.

## Overlap order slider and C0x navigation (October 29)

The coverage Inspector now has an Assets-style HEALPix slider. It previews
changes during pointer/touch dragging, submits the released order, and
debounces keyboard changes by 250 ms. The range follows the selected sources'
real shared precision, from O0 through at most O13. Initial/source-selection
queries use O4 or the highest supported lower order. Changing visible surveys
refreshes the range and cancels the previous selection's request.

Overlap uses verified public/package and private native FITS MOC intervals.
Survey products are unioned before surveys are intersected, and cells are
expanded only after intersection. High-resolution native boundaries survive;
the former coarse-mask subdivision design was removed. Queries above O8 have
a 32,768-cell budget and preserve the last successful result on errors. Other
orders also have bounded output. Original MOCs and scientific indexes remain
unchanged. Before this deployment, a read-only Dev query showed an O4 limit
from DESI DR1 bright-program redrock and two Legacy DR9 overviews. Native MOC
reading now exposes O6 for the DESI source; the Legacy overviews still limit
the complete source selection to O4.

Clicking an Inspector C0x button animates and frames its region using spherical
cell boundaries. Automatic initial C01 selection preserves the camera view.
Superseded geometry responses cannot replace a newer selection; the displayed
geometry and its inspection/export stay usable during loading and failures.
Large component bounds no longer overflow the argument stack; a 40,000-cell
regression covers that failure. High-order reverse lookup queries the existing
O8 local buckets and filters the returned native facts against the fine region.
Public download previews and immutable download region snapshots accept O13;
object crossmatching retains its existing O8 index limit.

Both reported symptoms and the missing slider/high-order support were
reproduced before the fixes. `npm run verify` passed: 394 tests, 390 passed,
four optional checks skipped, zero failures, plus types, all builds and Helm
checks. The 18-case coverage/settings browser run and six final focused slider,
source-selection and navigation checks passed (19 distinct browser scenarios). Offline projection
of the existing Assets Euclid ERO VIS and Gaia DR3 MOCs at O10 returned 3,925
overlap cells in 17 complete components. See
`docs/workspace-overlap-grid-verification-20261028.md` for evidence.

The user subsequently requested Dev deployment. Helm release `asa` in namespace
`asa-workspace` is now deployed at revision **109**, image
`crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/asa-workspace:0.0.1-dev-20261029-overlap-slider-r1`.
The running Pod reports image digest
`sha256:f823da406381c3abc3e3d18c25030967e63e98b5c1af826d084d135af61d2d8f`.
The image overlays the rebuilt server, Viewer and CLI on the verified revision
108 runtime. `helm upgrade --reuse-values --wait --rollback-on-failure`
changed only the Workspace image; server-side rendering confirmed the same
resources, credentials and configuration. Workspace, downloader and
Elasticsearch are Ready, the search-init hook succeeded, and all PVCs are Bound.
`/healthz` returns `ok` / `0.0.1`.

All six focused browser regressions passed against the deployed frontend using
API fixtures. Read-only real API checks verified O3/O4 queries, rejection of O5
for the Legacy O4 selection, and native O10 overlap between DESI EDR spectra and
Euclid ERO VIS: **78 cells in one component**. Deployed HTML, JavaScript and CSS
match the local build byte for byte. The real Dev browser also passed O4 → O3
→ O4 slider changes and C02 camera navigation with no page errors, after
waiting for initial private coverage to load and selecting the three public
surveys. Deployment evidence is stored under
`/tmp/workspace-overlap-dev-20261029-tta29s1y`.

Changes remain uncommitted and the staging index is preserved. No new scan,
scan retry, inventory refresh, download, public release or index rebuild was
submitted during the UI work or deployment.

## Dev scan status audit (October 29, read-only)

Around 10:25 Asia/Shanghai, accessible inventory grew to 1,903,122 files and
219,702,175,490,700 known source bytes, still partial. Inventory refresh is
running at 7/12 Connectors. Published scans remain 661,182 files /
118,424,028,772,800 source bytes; cumulative logical workload remains 725,182
files / 149,991,880,432,552 source bytes. There are zero active Scanner Jobs or
queued/running Connector runs. Inventory growth does not mean point extraction
is continuing.

Six of 18 assets have ready coverage and published point records: CSST W1
356,112, CSST deep v1 246,456, CSST wide v2 58,608, validation asset 4,000,
downloaded Euclid Q1 five, HST two. Six assets are inventory-only registrations.
MaNGA, LOFAR, Euclid shared-data and COSMOS have failed scientific scans.

CSST deep v2 parent `ingest-e9da7d49-f9fb-475b-9706-72ac1e8fe316` failed with
`database is locked`. Its durable manifest has 83 shards, 21 submitted and 62
unsubmitted. Latest child per partition shows 19 successes / 38,000 files and
two failures; the parent's 17-success/two-active counter is stale. Euclid's
failed batch similarly has nine successful partitions / 18,000 files, 39
failed and two unsubmitted. Neither submitted point extraction. Preserve the
immutable rosters and successful shards for any later authorized recovery.

Read-only point queries found a status inconsistency: COSMOS has 1,720,500
queryable object-index records while its card reports zero data points. The
status route counts only the sky-point index, while the actual query reads
both object and sky-point indices. Its scan failed generating coverage, so
these records are not evidence of a successful completed scan. The actual
point query returns nonzero counts for seven assets, zero for 11.

See `docs/workspace-scan-status-20261029.md` for source-specific errors and
evidence. This audit submitted no new scans, retries, refreshes, repairs,
downloads or deployments; it made no runtime/code changes.


## October 29: visible data points and durable shard recovery

Deployed Dev revision **111**, image
`0.0.1-dev-20261029-visible-points-r2`. Pod
`asa-workspace-5bd474bfb4-vnmjn` is Ready, zero restarts; image ID
`sha256:d2fa37618e59a7b86b975df3b0e7c920bb7953f86132215ff2df9b215ad41425`.
The manifest comparison confirmed an image-only update, with existing storage
and Secrets retained. At most two Scanner Jobs remain active, each requesting
500m CPU / 512Mi and limited to 1 CPU / 1Gi.

The real catalog/image point union now drives card counts and queryability.
An unavailable query is not displayed as a fabricated zero. Actual indexed
positions provide a bounded occupied-cell preview when complete scientific
coverage is unavailable; no complete MOC or success status is fabricated.
**查看数据点** opens Aladin at a real indexed coordinate and inherits only the
chosen asset's explicit scope. Logical parent scans remain authoritative over
partition success.

The two lock-interrupted batches resume their existing frozen manifests:
CSST deep v2 `ingest-e9da7d49-f9fb-475b-9706-72ac1e8fe316`, and Euclid
`ingest-37cf1ed7-f94f-4660-a843-dffaf0db6594`. Successful retained companions
now submit point indexing immediately, including from failed parents. This
does not resubmit any full CSST scan or republish partial replacement MOCs.
Transient queue metadata failures, SQLite boundary/read locks and stable-ID
Elasticsearch bulk retries have regressions; transaction callbacks never replay.

Final live audit: 18/18 point queries reachable, **9 assets with points**,
9 without. COSMOS has **1,720,500**, CSST deep v2 **3,977**, and Euclid
shared-data **626** at this snapshot. The latter two remain indexing; all
previously queryable assets retain their counts. CSST and Euclid parents are
running and preserve failed partitions. Remaining metadata-only roots and
MaNGA/ssy2/LOFAR format failures remain explicit limitations.

`npm run verify`: **394 passed, 4 skipped**. Six overlap slider/camera browser
regressions passed. Actual Dev browser tests rendered **1,000 COSMOS catalog
positions** and **110 CSST deep v2 image positions** in their initial viewports;
both canvases contained markers and had no page errors. Browser validation
used a service port-forward due to the test browser's external proxy route;
the public Dev API was verified directly.

Evidence: `/tmp/workspace-points-dev-20261029-npsob8qq/`, including deployment
receipt, final run/repair/point snapshots, real browser receipts and screenshots.
See `docs/workspace-visible-points-20261029.md`. The preceding read-only audit
is historical. Statistics are reconciling successful history after restart;
source inventory growth remains separate from scientific scans and points.

## Aladin performance and fullscreen Inspector (October 30)

Deployed Dev at Helm revision **114**, image
`0.0.1-dev-20261030-aladin-density-r1`, digest
`sha256:c1a5909762c53157074ac058e37529b6b4b12bd06cbd50097c5bf0370d16dd43`.
Pod `asa-workspace-7489f5f95-hb9xs` is Ready with zero restarts, and `/healthz`
is healthy. Deployed HTML, JavaScript and CSS hashes match the local build.

Aladin now opens at 0.5-degree FOV. Above 0.75 degrees it uses per-layer
HEALPix density rendering; standard zoomed-in points use Aladin circle markers.
The layer drawer can be collapsed and reopened. Selecting a point while
fullscreen opens its Inspector docked on the right.

`npm run build`, `npm run verify:types`, and `npm run verify:chart` passed in
the deployment build worktree. Focused service tests passed 21/21. Inspector
and density browser regressions passed against deployed Dev. Live COSMOS checks
returned 1,720,500 queryable positions; a bounded density query returned
264,912 points across two NSIDE 32 cells with `indexing=false`.

## Aladin initial navigation and direction guides (October 30)

Deployed Dev at Helm revision **115**, image
`0.0.1-dev-20261030-aladin-navigation-r1`. Ready Pod
`asa-workspace-7bfb98659c-pnnj8` reports image digest
`sha256:1e23b15ccd2158efd0bb70a87353e6cc6667396fdece40eb4b1c967399e03e80`
and zero restarts. `/healthz` is healthy; deployed HTML, JS and CSS match
the rebuilt local frontend byte for byte. Deployment evidence is private at
`/tmp/workspace-navigation-dev-20261030-d3i8bi_f/`.

The viewer reads both actual Aladin FOV axes and compensates the current
Aladin Lite AIT scalar so entry remains approximately 0.5 degrees. Empty
entry viewports wait for independently retained real point anchors, restricted
to each selected layer and the frozen entry HEALPix region. One anchor per
selected layer supplies clickable offscreen direction guides with layer color,
label and distance. Clicking a guide centers its real anchor and narrows to
the layer's default FOV. This is not a global nearest-point search. Guide
requests survive viewport cancellation and stop on disposal. Density stays
visible while replacement density or zoomed-in point results are loading.

`npm run verify:types`, `npm run build:viewer` and `git diff --check` passed.
The focused empty-entry/anchor/marker/zoom/direction-guide browser regression
passed locally and against the deployed frontend with API fixtures. The
existing per-layer density regression passed after waiting for wheel zoom
and its density response to settle before hovering; the original failure
hovered during the animated viewport transition. Real Dev browser verification
used a service port-forward because the browser's route to the public Dev
hostname did not load the application; direct LAN HTTP verification succeeded.

With real COSMOS data, **查看数据点** opened at RA 149.999342, Dec 1.391676,
displayed FOV 0.4625 degrees, and rendered 2,000 real catalog records before
the verification browser closed. Canvas markers were present, every observed
point request included viewport/region/layer scopes, the drawer reopened, and
there were no page errors. This is initial-render verification, not a claim
that all COSMOS records or the full initial viewport finished loading. COSMOS
still reports 1,720,500 queryable records and its earlier coverage scan failure.

The image overlays only rebuilt `dist/viewer` on the revision 114 runtime;
server code and dependencies are unchanged. The checked server-side Helm
proposal and live deployment spec differ only in the Workspace image.
The repository chart's readiness/liveness probes differ from revision 114,
so the deployment used a private chart copy retaining those deployed probes.
Existing resources, storage, credentials, downloader and Elasticsearch settings
were preserved. The repository chart remains unchanged; future deployments
must inspect its probe differences before upgrading from it directly.

Changes remain uncommitted. No scan, retry, inventory refresh, repair, download
or index rebuild was submitted. The existing density suite temporarily selected
its baseline public resource packages and restored the preceding activation
state afterward.

## Aladin viewport loading and Inspector styling (October 30)

Deployed Dev at Helm revision **116**, image
`0.0.1-dev-20261030-aladin-viewport-r1`. Pod
`asa-workspace-6f6b79b957-c4hbs` is Ready with zero restarts, running digest
`sha256:5e817135fbd289068f654f674e46a17668764b2353593846a3ca2e4c7010c2e3`.
`/healthz` is healthy. Deployed HTML, JS, CSS and the changed server modules
match the local build. Private evidence:
`/tmp/workspace-viewport-dev-20261030-rzael_e7/`.

The stale viewport had several confirmed causes. Aladin can return a
`Float64Array` for its center and projected point coordinates; rejecting those
values froze the readout and misplaced direction guides. Its cached vertical
FOV can also remain 180 degrees after fullscreen resizing, incorrectly
selecting density mode. The viewer now derives center and angular spans from
the rendered projection. Programmatic FOV settings are calibrated against
those spans, replacing the fixed pi/2 compensation from revision 115, so the
larger viewport axis opens at approximately 0.5 degrees across layouts.

Dragging and wheel interaction immediately abort stale point pagination,
density, point detail, coordinate inspection and pending optional anchor
requests. A debounced query then loads the current viewport; optional
direction anchors resume afterward and reuse successful results. Cancelled
pending rectangles are removed before replacement queries calculate missing
coverage. Completed cached areas remain reusable. The response disconnect
signal now reaches the Elasticsearch fetch for point, density, anchor and
inspection routes; cancelling only the browser request previously left that
upstream work running. Loading status takes precedence over retained-cache
status. Initial layout changes no longer consume the only auto-anchor
attempt, and a confirmed anchor invalidates an earlier empty entry cache.

The fullscreen Coordinate Inspector uses the Aladin deck's raised surface,
border, small radius, clipped corner, accent and compact header. It is 320px
wide with an independently scrolling body and compact record cards; shared
theme variables replace undefined sidebar variables. Desktop, fullscreen and
mobile behaviours remain covered by the existing browser case.

`npm run verify:types`, `npm run build` and `git diff --check` passed. The
focused object-index/cache suite passed **25/25**, including a real HTTP
disconnect closing the upstream Elasticsearch socket. Five browser cases
passed: empty entry with anchor/marker/direction-guide return, cancelling old
pagination on pan, fullscreen zoom then pan into uncached sky, Inspector
layouts and per-layer density transitions. The fullscreen test deliberately
exposes uncached sky; moving within a completely loaded area correctly reuses
the cache without another request.

Real COSMOS verification against the deployed service opened at RA 149.999342,
Dec 1.391676 and FOV **0.5000** degrees, with 2,000 initial records. After
fullscreen zoom and pan, the center moved to Dec 1.616845 at FOV 0.4323;
new scoped point queries returned further 2,000-record pages. Old point and
density requests were observed as aborted. Real painted markers were clicked
to open the themed Inspector, and the layer drawer closed and reopened.
Every observed point query included viewport, frozen HEALPix region and only
the COSMOS layer scope. The final check observed no API failures or page
errors. This verifies incremental loading and navigation, not completion of
every viewport page or availability of the external CDS HiPS imagery.

The runtime image overlays rebuilt server and viewer files on revision 115;
existing Python runtime and dependencies are retained. The Helm manifest and
live Deployment spec differ only in the Workspace image. As with revision
115, the private chart copy retains the deployed probes; repository chart,
resources, mounts, Secrets, downloader and Elasticsearch settings are unchanged.
No scan, retry, inventory refresh, repair, download or index rebuild was
submitted. Changes remain uncommitted.

## Density cell counts and double-click navigation (October 30)

Deployed Dev at Helm revision **118**, image
`0.0.1-dev-20261030-aladin-density-counts-r2`. Pod
`asa-workspace-6cb754c859-cqvjf` is Ready with zero restarts, running digest
`sha256:74828396ffb212cb57fdceb4440c5080262fa3f4259c98e008972a13c5ba3dfe`.
`/healthz` is healthy; deployed frontend and server module hashes match the
local build. Private evidence:
`/tmp/workspace-density-counts-dev-20261030-t40sfkpg/`.

Density mode now starts strictly above **1.5 degrees**. Each occupied cell has
a projected label with its total and a separate count for each indexed survey.
The aggregation reads the union of the selected layer scopes, so overlapping
layer filters do not double the survey counts. Counts remain restricted to
the frozen entry HEALPix region and current viewport bounds. The hover panel
shows the same survey breakdown and the double-click hint; the layer deck
shows current density totals instead of stale point-cache progress.

COSMOS currently has the placeholder survey `user`, not a registered COSMOS
survey tag. Empty, missing, `user` and `__unassigned__` tags are therefore
counted separately by source asset and labelled with the asset name plus
**未标注巡天**. Formal survey tags still combine across selected assets.
This avoids merging unrelated unassigned assets into a fictitious `user`
survey and does not rewrite indexed metadata. Survey/source aggregation
buckets share a bounded budget with cell/layer buckets; truncated or
inconsistent breakdowns return an explicit error instead of partial counts.

Labels follow projected HEALPix geometry and let pointer events reach the
sky canvas. Double-click handling intercepts Aladin's default recentering,
identifies the occupied cell under the pointer, centers its actual ICRS
HEALPix center and applies calibrated FOV **0.5 degrees**. The existing
viewport cancellation path interrupts obsolete work; selected layers and
the entry region remain scoped when point loading resumes.

`npm run build` and `git diff --check` passed. The object-index, viewport-cache
and isolated HTTP scan fixture suites passed **29/29**. Five focused browser
scenarios passed across the navigation and density runs. The final mixed
survey/unassigned-source test confirms separate per-cell numbers, point mode
between 0.75 and 1.5 degrees, the higher density threshold and exact cell-center
double-click navigation; it was rerun after adding unassigned source labels.

Live COSMOS opened at FOV 0.5000 degrees, stayed in point mode at 0.8743 and
switched to density at 2.8905. All **62 cells / 1,062,464 scoped records** had
matching API and rendered counts. Double-clicking NSIDE 256 pixel 436096
centered RA 150.468750, Dec 1.342993 at FOV 0.5000 and returned a fresh
2,000-record page. Old point/density requests were observed as aborted; all
queries preserved the COSMOS scope and no Workspace API failures occurred.
The remote CDS 2MASS backdrop failed to fetch during this check; indexed
positions, density labels and navigation were verified independently.

The runtime overlays rebuilt server and viewer files on the existing runtime.
Manifest and Deployment comparisons confirmed an image-only upgrade with
deployed probes, resources, mounts, Secrets, downloader and Elasticsearch
settings retained. The density browser suite restored prior public package
activation after its fixtures. No real scan, repair, download or reindexing
was submitted. Changes remain uncommitted.

## Selected coverage and Aladin region state (November 2, revision 119)

Dev is deployed at Helm revision **119**, image
`0.0.1-dev-20261102-coverage-ux-r1`, digest
`sha256:13de52cd77a76a213a4e4bbe999512061bf001842884ae0fb8ca7060e6349703`.
The private receipt is `/tmp/workspace-coverage-ux-20261102-a8xt8t2n/`;
`/tmp/workspace-coverage-ux-receipt-path` points to it. Its baseline preserves
all work already present before this task. Changes remain uncommitted.

The old coverage refresh automatically selected every preview asset and
waited for global coverage/status work before publishing geometry. It now
preserves the exact selected set, paints each completed layer incrementally,
and exposes compact loading/error/retry states plus per-card progress.
Selected and inspected assets have two foreground request slots; unselected
work gets one background slot after a paint opportunity. Selecting pending
coverage preempts unrelated work. Returning from Aladin reuses completed
coverage for up to 60 seconds without reselecting previews.

`/api/data-assets/status` accepts an optional `assetIds` filter and preserves
its existing all-assets behavior without that parameter. Coverage, status
and overview requests carry browser cancellation through the HTTP response
to the Workspace Elasticsearch/Warehouse clients, including paginated reads.
Warehouse geometry caches completed results only, so one cancelled request
cannot cancel another caller or cache its aborted promise. No sibling
Warehouse or Assets repository was changed.

Aladin region navigation records loading/available/empty/indexing/error
states separately from viewport results. Empty views wait for the frozen
region anchor lookup before explaining absence; available anchors provide
manual direction guides. Automatic entry movement runs at most once and
stops on user movement. Following a confirmed guide rechecks its destination
even if an older empty viewport was cached. Image/cube layers explain that
image extent can cross a region while its indexed center lies outside it.
The inline action inspects the frozen entry coordinate with the same region
and selected layer scopes; it labels this as a coordinate, not an unnamed
object. Status panels use the Aladin palette and fit fullscreen/mobile
layouts. The existing FOV > 1.5 degree density threshold, per-survey counts
and double-click-to-cell-center at 0.5 degrees remain intact.

Read-only diagnosis confirmed that CSST Simulation W1, asset
`user-d4639a71-b684-4789-977f-75e1e150c641`, has coarse image coverage in
NSIDE 16 / NESTED pixel 815 but no indexed point/center inside that frozen
region. This is not only an initially small viewport. An independent Astropy
check agrees with the indexed WCS footprints, but some original FITS WCS
matrices have suspicious degree-per-pixel scales and large pointing/center
disagreements. Six bounded Range reads totaling 17,280 header bytes confirmed
the critical CD cards for one example, not whole-header byte equality.
Some normal files share the same CRS filename category, so the category must
not be treated as uniformly invalid. Scientific validation/calibration,
quarantine and any reindexing remain separate work; no FITS/WCS, source
coverage, point index, scan, repair or download was changed or submitted.

Validation: server/viewer/CLI builds, strict chart checks and diff checks
passed. The complete service suite passed **407 tests**, with **4 skipped**.
Coverage scheduling, abort isolation and real HTTP disconnect regressions
passed. All **11 unique Aladin/coverage browser scenarios** passed; the final
mobile test was rerun after fixing its fullscreen-resize test setup. The
other ten passed together in the final suite. Fixtures mock the APIs and do
not change public package activation. The browser plugin reported no
connected browser, so live checks used the existing standalone Playwright
workflow.

Live W1 verification selected the reported RA 303.47878 / Dec 28.75541 in
pixel 815, entered at region center RA 303.75 / Dec 27.309956 and FOV 0.5,
showed the image-coverage/no-indexed-center explanation, and offered no false
point-direction guide. Coordinate inspection at the entry center returned
**10 covering images / 0 nearby objects** inside the same region/layer scope.
The earlier diagnostic at the original clicked coordinate returned 11 images;
these are different coordinates. Fullscreen displayed the coordinate drawer;
returning to the sphere kept only W1 checked. The first geometry request was
scoped to W1, and no Workspace API failure or unexpected write occurred.

Live COSMOS entered at RA 149.999342 / Dec 1.391676 and FOV 0.5 with a
2,000-point page, stayed in point mode at FOV 0.8743, and displayed **62 density
cells / 1,062,464 scoped records** at FOV 2.8905. All cell/survey labels matched
the API. Double-clicking pixel 436096 at NSIDE 256 centered RA 150.46875 /
Dec 1.342993 at FOV 0.5 and returned fresh points. Obsolete point requests were
aborted. No Workspace API failures occurred; the external CDS 2MASS backdrop
reported fetch/HiPS errors independently of these verified data layers.

Post-deployment comparisons confirm both the Helm manifest and live
Deployment changed only the Workspace image. Deployed server/frontend hashes
match the build. Pod `asa-workspace-58895bb9bc-7bq6q` is ready with zero
restarts; the public `/healthz` is healthy. Existing deployed probes, Secrets,
resources, storage, downloader and Elasticsearch settings were retained using
the private runtime chart copy. The repository chart remains unchanged.

## FITS observation-position audit (November 3)

The user clarified that FITS-header RA/Dec should represent a file/HDU
observation position, with image/spectrum/etc. classified from file content.
They requested diagnosis of scan/index versus rendering before implementation.
No image-pixel preview or source detection is requested. This audit changed no
running code or deployment and submitted no scan, repair or index write.

See `docs/workspace-fits-position-audit-20261103.md` for the reproducible API,
header, HEALPix, Warehouse-worker and browser checks. Private evidence:
`/tmp/workspace-w1-coordinate-audit-20261103-ohnzmc0k/`; pointer:
`/tmp/workspace-w1-coordinate-audit-path`.

Confirmed: W1 pixel 815 returns zero points even without a viewport filter,
while coordinate inspection at the original click returns 11 images. All 11
stored centers reproduce from their retained WCS; none belongs to pixel 815.
The first file's WCS center is 123.345843 / 11.555288 (pixel 288), while its
explicit RA_OBJ/DEC_OBJ and RA_PNT0/DEC_PNT0 are 269.061405 / 75.945966
(pixel 735). Neither coordinate is the user's clicked RA 303.47877 /
Dec 28.75543 in pixel 815. Its indexed O8 pixel 73787 is correct, and the
point is retrievable at its stored coordinate. Do not attribute this case to
the initial FOV or fix it by placing a marker at the selected HEALPix center.

The primary cards are retained but the direct-coordinate extractor ignores
CSST RA_OBJ/DEC_OBJ and RA_PNT keys. It only tries its three supported primary
coordinate pairs when no WCS center exists. The science CD matrix has
suspicious degree/pixel scales; both Workspace and Warehouse accept it and
reproduce a very broad footprint and displaced center. A header-only replay
confirms that Warehouse labels it usable. Scientific validity remains separate
from the fact that the current calculations reproduce stored evidence.

A fresh standalone browser check of real Dev W1 data returned and painted an
image-center marker at FOV 0.5, with no API/page errors or unexpected writes.
This excludes a general failure to draw FITS image positions. Inspector
**附近星表对象 0** excludes image centers/pointings by design and does not mean
there are no observation files. Product typing also needs correction:
`pointDocument` derives modality from position_role, and a spectral-axis
header control is stored as pointing. Local Workspace FITS scans additionally
discard direct-coordinate-only rows by filtering to image_center; this is a
separate path from the already-indexed W1 example.

The abandoned November 3 image-preview wording assertions were restored to
their task-baseline version; no production UI fix was made for that mistaken
direction. Next work should address coordinate-key support, explicit provenance,
WCS/pointing validation and content-based product typing before any existing
scientific data correction.

## Source FITS attribution follow-up (November 3)

The user requested a firm distinction between source-file errors, Warehouse
scanning and Workspace processing. The follow-up compared original source
ASCII headers for all 11 reported W1 files and one normal CRS control. Both
primary and science headers match their retained counterparts byte for byte
through END in all 12 files. The bounded source reads totaled 207,360 bytes
across 72 Range requests, without reading scientific arrays. ETags and offsets
were checked; no credentials were emitted, scan submitted or index changed.

There is now source-internal evidence rather than only a suspicious-looking
matrix. All 11 reported files declare PIXSCAL1/2 = 0.074 arcsec/pixel, but
their CD column norms imply scales 12,326 to 417,045 times larger. The first
file implies 1,645.424364 and 20,862.741893 arcsec/pixel. A normal CRS control
from the same asset implies 0.073999285 and 0.073998909, matching its declared
scale. This is a source WCS-metadata inconsistency; do not generalize it to
all CRS files, all W1 files, or FITS payload corruption.

A handwritten TAN inverse, independent of all project code and Astropy,
reproduces the stored centers for all 12 files within 1e-9 degrees. For this
case, source metadata is the origin of the anomalous coverage and displaced
center; Warehouse did not corrupt the saved cards and Workspace did not
numerically mistransform them. Both stages lack appropriate WCS plausibility
validation. Workspace's omitted RA_OBJ/RA_PNT extraction, modality and Inspector
limitations remain separate findings. This sharpens and supersedes the
earlier broad attribution to Workspace interpretation as the primary cause.

The durable audit is updated in
`docs/workspace-fits-position-audit-20261103.md`. Private raw headers, source
comparison hashes, scripts and numeric receipts are at
`/tmp/workspace-fits-source-triage-20261103-cxuhzvxp/`; pointer:
`/tmp/workspace-fits-source-triage-path`. Run `verify-source-triage.py` there
for the standard-library-only comparison. No runtime implementation or
deployment changed, and no source-coordinate replacement was attempted.

## Independent W1–W4 header samples (November 3)

The user requested fresh W1 samples and five files each from W2, W3 and W4
before deciding whether to retain CSST for MVP. The actual source directories
are sibling W1_Phot/W2_Phot/W3_Phot/W4_Phot under the existing simulation
output. Do not conflate them with the separate wide-v2/deep-v1/deep-v2 assets.

Five new files per group, each from a different exposure, were selected before
quality inspection using fixed seed `csst-w1-w4-20261103-fixed-v1`. Complete
delimiter listings found 9,892 / 10,152 / 10,452 / 11,768 exposure directories;
W1 excluded the 12 previously inspected exposures. No suspect file was swapped
out after inspection. Source-header reads totaled 120 Range requests and
345,600 bytes; ETags/sizes matched the frozen selection. No image arrays,
scan/repair/download tasks, deployments or scientific index writes were made.

Results: W1 5/5, W2 5/5 and W3 5/5 passed the header consistency checks; W4
4/5 passed and 1/5 needs review. None of these 20 reproduced the earlier
many-orders-of-magnitude scale problem. All 20 provide finite ICRS/TAN centers
that agree with an independent handwritten TAN inverse within 1e-9 degrees.
The 19 passing samples have maximum scale discrepancy below 0.006%.

The W4 review file is
`CSST_MSC_MS_WIDE_20221030195240_20221030195510_10600030723_23_L0_V01.fits`.
Declared scale: 0.074 arcsec/pixel; CD axis scales: 0.073850741 / 0.080765926
(axis 2 +9.143%); CD axis angle: 93.314025 degrees. Center:
359.691598 / -41.376078; target separation: 0.198030 degrees; maximum corner
radius: 0.214738 degrees. This merits metadata review, not a claim of whole-file
corruption or the severe geometry expansion seen in the original 815 cases.
The 1% scale / 1-degree axis-angle screens are diagnostic thresholds for these
CSST samples, not universal FITS/WCS validity rules.

The sampling supports retaining header-checked CSST examples for MVP with a
WCS quality gate. Five per group cannot establish population failure rates;
do not merge the deliberately problem-selected earlier 11 with this independent
sample to estimate a global rate. No runtime quality-gate fix has been made.

Detailed Chinese report and all 20 filenames/coordinates:
`docs/csst-w1-w4-header-sample-audit-20261103.md`. Private evidence:
`/tmp/workspace-csst-w1-w4-samples-20261103-jcfk5gzz/`; pointer:
`/tmp/workspace-csst-w1-w4-samples-path`. The receipt contains selection scripts,
raw source headers, `analyze-samples.py`, `summary.json`, `file-results.json`
and a CSV of the 19 candidate files; none has been imported into the system.
