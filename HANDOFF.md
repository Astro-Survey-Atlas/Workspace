# Workspace handoff

Updated: 2026-10-10, Asia/Shanghai.

## Current work

The user authorized private coverage/MOC repair and FITS coordinate backfill,
scoped Aladin exploration, and Workspace Dev deployment. Do not rescan the
existing coverage sources or enumerate their directories. Header replay uses
the finite inventory of the existing successful Warehouse scan. Flink is not
running or required. Preserve the original successful coverage, failed history,
resource limits, and the substantial unrelated dirty worktree.

Assets public data, evidence and releases are outside this task. Private files,
coordinates, repair inventories and receipts remain in Workspace. The sibling
`Astro-Survey-Atlas-Warehouse` is the active Warehouse repository;
`/home/aaron/Repo/data-warehouse` is frozen legacy code.

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
- Queries indicate ongoing production backfill with `indexing`; Aladin keeps
  existing points and refreshes unchanged viewports every 10 seconds until
  complete. Empty selection and disposal stop refresh. Image centers/pointings
  are excluded from scientific object coincidence markers.
- Operational coverage, catalog object count and header point count are
  independent. ACTIVE Warehouse coverage takes precedence over a failed
  derived artifact for operational coverage status.

## Verification baseline

Workspace `npm run verify` passed: 365 tests, 363 passed and 2 skipped; server,
viewer, CLI and strict Helm checks passed. Four Aladin browser regressions passed,
including viewport-only queries, frozen region/layers, Escape and unchanged-view
refresh during backfill. Public package activation state was restored afterward.
Logs are outside Git under `/tmp/workspace-verify-header-r6.log` and
`/tmp/workspace-aladin-final-r5-e2e.log`. The final r6 change only removes obsolete
run errors from a ready operational status; current diagnostics and historical
records remain. Its regression was observed failing before the fix and passing
afterward.

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
- CSST successful sample: `derived-6a930a34a0094899bcd3f276`.
- Earlier failed MOC repair: `derived-b5c84ec5a2574350a2991432`, retained.
- Successful CSST MOC repair: `derived-7c11ab92d14b4549a4cd056e`.
  Actual decoded native maximum O10, 32,250 MOC cells, 18,525 O8 query pixels,
  unchanged 372 O4 preview pixels, precision estimated. All five artifact
  sizes/hashes verified; receipt `/tmp/workspace-csst-moc-validation.json`.
- Original full CSST header task `derived-fb2c156981584665bfc38dbc` is retained
  as failed after a transient ES indexing timeout. Its metadata-only Job is
  still running and checkpointing; do not start another reader.
- Recovery task `derived-54cf71e7a197406f8fb82663` reuses that exact Job/output
  and indexes committed headers with stable point IDs. At 05:44:45 UTC it remained
  running with 37,356 indexed points, zero header/coordinate errors. The header
  Job had processed 97,300 / 356,112 files. This is incomplete; use the current
  task/checkpoint or operational status API for newer progress.
- CSST original coverage: 356,112 files, 7,167,326 rows, zero errors, ACTIVE O10.
  The original Workspace import failure was the Node 2 GiB whole-buffer limit,
  not a failed Warehouse scientific scan.

Dev URL: `http://astro.workspace.dev.72602.space:32080`.
Use `curl --noproxy '*'` for this local endpoint. Helm release is `asa` in
`asa-workspace`; retain existing values on upgrade. Workspace memory limit is
1 GiB; local ES request/limit is 1/2 GiB with 512 MiB heap. Do not change these
as part of data repair.

A running full replay is not a completed backfill; continue monitoring its
durable task and checkpoints without submitting another coverage scan.
Original CSST/HST ScanRequest spec/status were compared exactly and remained
unchanged. The original CSST failed MOC metadata also compares unchanged.

## Final Dev deployment

Helm revision **83** is deployed and healthy, one ready Workspace Pod and zero
restarts. Image `0.10.38-dev-20261010-header-repair-r6`, registry digest
`sha256:c94482ac1e9323de8586307f58c401a0b6081a5fa04c42070ab214acd10e26a0`.
The final image uses the verified immutable r5 image as its base and replaces
only the compiled operational-status module; its runtime SHA-256 matches the
local verified build. Full source builds remain supported by the repository
Dockerfile. Workspace and ES limits were retained, scanner unchanged.

The CSST header Job retained its original UID and creation time through both
deployments. Its committed header output exceeds 2 GiB and continues normally;
the indexer consumes bounded batches. The tested scoped region increased from
98 to 531 matching image centers and returns `indexing:true`. Operational
status reports ready coverage, ongoing point backfill, and no obsolete import
error. HST reports ready coverage and two points with a succeeded point task.

Private verification record: `docs/workspace-header-repair-verification-20261010.md`.
Machine receipt: `/tmp/workspace-header-repair-final-receipt.json`. Logs,
screenshots and receipts remain outside Assets; no private data was published.
