# Workspace handoff

Updated: 2026-10-13, Asia/Shanghai.

## Current work

The user authorized private coverage/MOC repair and FITS coordinate backfill,
scoped Aladin exploration, Workspace Dev deployment, and cleanup of historical
errors. Do not rescan existing coverage sources or enumerate their directories.
Header replay uses the finite inventory of the successful Warehouse scan. Flink
is not running or required. Preserve successful coverage and success records,
resource limits, and the substantial existing worktree changes.

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

## Implementation

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
1 GiB; local ES request/limit is 1/2 GiB with 512 MiB heap. Do not change these
as part of data repair.

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
