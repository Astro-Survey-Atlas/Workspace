# CSST W1–W4 quality validation and full rescan

**Latest status, 2026-11-03:** the partition-summary blocker is repaired and
deployed in Warehouse Operator revision 27 (`partition-summary-r2`). Seventeen
original successful Jobs were revalidated without execution replay, retaining
34,000 accepted files. Workspace resumed their existing child runs and ordinary
automatic point/footprint integration. W1 now has publicly queryable points and
matching image-footprint results; integration and full scans are still running.
All four inventories are frozen (W1 356,112; W2 365,472; W3 188,136; W4 211,824).
Read the [current session handoff](session-handoff-20261103-agent.md) for the
latest snapshot, recovery evidence and live validation limits. The 12:40
snapshot below is historical.

The repair belongs in Warehouse. Malformed WCS in the original CSST FITS
headers generated false coverage; the retained headers matched the source
bytes. Workspace must consume the accepted result, including the selected
science HDU, rather than recover coordinates from a rejected header.

## Implemented policy

- Every Warehouse scan skips deterministic file-format or metadata errors by
  default. A bad catalog row rejects the entire file and discards its earlier
  rows. Transport, permission, snapshot, worker, lease and sink failures still
  fail explicitly after the applicable bounded retries.
- CSST assets use `extraction.fitsQualityProfile: csst-wcs-v1`. Axis scales must
  agree with valid `PIXSCAL1/2` within 1%, and their angle must agree with 90°
  within 1°. Values exactly on a threshold pass. Missing nominal scales fail;
  no assumed 0.074 scale is inserted. Other surveys retain general WCS support.
- Inventory and rejected-header evidence remain private. Normalized files,
  coverage, positions and image bounds contain accepted files only.
  `acceptedFileCount`, `skippedFileCount` and `skipped-files.ndjson` distinguish
  rejection from execution failure. The asset detail provides a download of
  the skip reasons. An entirely rejected batch finishes with no usable files
  and no published MOC.
- Profiled assets publish points and bounds from their latest quality batch.
  All point, density, anchor, inspection and coverage queries exclude previous
  generations. Before the new batch produces results, old invalid coverage is
  hidden. Successful shards index accepted positions incrementally; a final
  MOC publishes after the complete batch succeeds.
- Full scans freeze the complete source inventory, use 2,000-file shards and
  at most two Scanner Jobs globally, and have no `maxFiles` cap. Only one
  source enumerates at a time; enumeration runs independently of polling so
  another source's listing cannot block shard scheduling or position indexing.
  Frozen manifests and listing cursors survive Workspace restarts. Aladin
  keeps its indexing indicator and automatic refresh active while the selected
  image scan is queued or enumerating, before any point task exists.
- W2–W4 use the actual sibling sources validated in the November 3 source
  audit. Registration does not change the browser's checked layer selection.

## Real-file acceptance

The deployed scanner read 32 real source FITS files through namespace-local
ScanRequests, followed by the deployed Workspace coordinate converter and
MOC importer. This specifically checks that a full inventory count may exceed
the number of accepted normalized files.

| Group | Files | Accepted | Skipped | Positions | Image bounds | MOC |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| W1: original 12 plus new 5 | 17 | 6 | 11 | 6 | 6 | ready |
| W2 | 5 | 5 | 0 | 5 | 5 | ready |
| W3 | 5 | 5 | 0 | 5 | 5 | ready |
| W4 | 5 | 4 | 1 | 4 | 4 | ready |

The 12 rejected files produced no positions. All 12 previous-generation
sample point IDs return HTTP 404 after enabling the publication filter. Raw
sources and historical evidence have not been deleted. Old derived index
documents are retained but excluded from current scientific queries.

## Full scan tracking

The four full batches were submitted on November 3. These are durable jobs,
not a claim that their entire inventories have finished scanning.

| Group | Asset | Root ingest run |
| --- | --- | --- |
| W1 | `user-d4639a71-b684-4789-977f-75e1e150c641` | `ingest-5c356a3d-17f0-4d68-a698-bc2fec449f51` |
| W2 | `user-b792b28e-aa41-47a8-aed4-a36245951509` | `ingest-7190aaba-58c9-4866-ad73-2f717a3a91b7` |
| W3 | `user-28207345-9c05-4f6a-b867-1ff0c1f3148a` | `ingest-c2499f5f-3aa3-4ae0-a6bf-4ac100f36842` |
| W4 | `user-8b42e2fb-5bb5-4560-8a3e-c795dd20a52e` | `ingest-f24c1088-392b-4db1-9c9d-b0a92e49ee77` |

Snapshot at **2026-11-03 12:40 Asia/Shanghai**: W1 finished enumerating all
**356,112 files**, frozen into **179 shards**. Two Scanner Jobs were running;
no shards had finished or failed. Their private writing checkpoints showed
355 and 459 accepted files respectively, with zero skipped files or execution
errors so far. These 814 files are unfinished shard output, not yet published
positions. W2 had discovered 45,738 files and was still enumerating; W3 and W4
remained queued. All four durable manifests carry `csst-wcs-v1` and omit
`maxFiles`. Current point APIs correctly return `indexing: true` for all four
assets, including those still queued. The old pixel 815 returns zero points.

Use asset details or `/api/connector-ingest-runs` to inspect current progress.
Inventory growth is source discovery; accepted/skipped counts advance as
Scanner shards finish. No repeat submission or manual point-repair request is
required. Physical removal of obsolete derived index generations can follow
completion; publication filtering already isolates the former false coverage.

## Partition summary repair validation

At 14:40:33 Asia/Shanghai, W1 had 18 successful shards / 36,000 accepted
files, zero skipped files and zero failed shards. All 18 automatic position
tasks existed; the public query returned 1,370 new points with indexing still
active. Root processed/accepted counters agreed. The skip-report endpoint
returned HTTP 200 and zero rows, matching the counters. At 14:42 an indexed
point from the first recovered shard returned 10 covering images through the
public inspection API. Old pixel 815 remained empty.

The 17 historical summary failures were revalidated with original successful
Jobs; no execution was replayed. New completions pass automatically. Scanner
and Operator serialization/identity regressions, single-use revalidation,
CRD status retention, and all 11 Warehouse static commands passed.
The current fix receipt is `/tmp/csst-partition-summary-fix-20261103-2b0z9xj3`,
pointed to by `/tmp/csst-partition-summary-fix-path`. Read its
`recovery-observation.json`, `positive-footprint-proof.json`, and
`live-validation.json` for evidence and live gate limits. The fresh Workspace
remote caller passed. Baseline/Asset suites failed on ES timeouts and external
MOC TLS, and the local Workspace caller timed out. After the recovery snapshot,
W1 partition `s000018` also failed on a real ES refresh timeout. Its evidence
is retained; it is a separate execution failure, not eligible for summary
revalidation. Original full batches continue; the ES latency issue remains.

### Commands run for this repair

| Static command | Result |
| --- | --- |
| `mvn -B -q test` | passed |
| `mvn -B -q verify` | passed |
| `mvn -B -q -Pquality verify` | passed |
| `helm lint deploy/helm/atlas-warehouse-infra` | passed |
| `helm lint deploy/helm/atlas-warehouse-operator` | passed |
| `helm template atlas-warehouse deploy/helm/atlas-warehouse-infra` | passed |
| `helm template atlas-warehouse-operator deploy/helm/atlas-warehouse-operator --include-crds` | passed |
| `docker compose -f deploy/compose/compose.yaml config -q` | passed |
| `scripts/sync-index-mappings.sh --check` | passed |
| `bash -n scripts/warehouse-smoke-test.sh scripts/warehouse-caller-smoke-test.sh` | passed |
| `git diff --check` | passed in both active repositories |

The Operator, MOC controller, Warehouse Elasticsearch and MinIO rollout checks
passed. Actual Workspace namespace is `asa-workspace`; the old
`astro-data-workspace` namespace is absent. Live fixtures used their existing
namespace-local evidence/source PVCs and approved Secret references.

| Live command | Result |
| --- | --- |
| `bash scripts/warehouse-smoke-test.sh` | failed: ES request timeouts; external MOC `DiscoveryTlsError` |
| `CALLER=asset bash scripts/warehouse-caller-smoke-test.sh` | failed: scan wait timeout; external MOC `DiscoveryTlsError` |
| `CALLER=workspace bash scripts/warehouse-caller-smoke-test.sh` | failed: scan still running after 180-second wait |
| `CALLER=workspace-remote bash scripts/warehouse-caller-smoke-test.sh` | **PASSED**: SUCCEEDED summary, evidence, snapshot, positive file/coverage counts, zero errors and ACTIVE layer |

These fixture results do not replace the actual CSST recovery checks in
`recovery-validation.json`: original Job retention, guarded run resumption,
root counts, automatically submitted position tasks, public points and
footprints, skip report, original invalid point exclusion and bounded Scanner
concurrency. Remaining indexing and the subsequent real ES execution timeout
are recorded explicitly.

## Earlier implementation validation and deployment evidence

Dev Workspace Helm revision **122** runs
`0.0.1-dev-20261103-csst-quality-r3`. Warehouse Operator revision **26** ran
`0.2.0-20261103-file-skip-r1`, with scanner
`0.2.0-20261103-csst-quality-r1`. Both rollouts and the Dev health check passed.
The deployed queue and coordinate module hashes match the verified build.
The r3 runtime digest is
`sha256:0bf2af99ce00fba6f8f2ca35e2f74907563dde9b2ea3854f1c7f588ffe482219`;
the Workspace Pod is Ready with zero restarts, and the public `/healthz`
responds successfully. `workspace-r3-runtime.json` and
`full-status-observed.json` in the private receipt record the runtime and scan
snapshot. Re-run the receipt's `observe-full-scans.mjs` inside the Workspace
Pod to check accepted/skipped counts, automatic position tasks, public point
and image inspection, and the root skip-report download as shards complete.
The receipt's `monitor-first-shards.py` was started as a bounded,
read-only observer and has since reached its two-hour limit. It follows the current Workspace Pod across rollouts and
records the first successful shard's publication checks in
`first-shard-live-validation.json`; require `passed: true`. Its last result was a failed intermediate check; it is not the validation
result for this repair.
At the 13:53 handoff, no validation result file existed because of the
partition-summary failure described above. The observer cannot fix that
failure and stops after its two-hour limit. It does not submit scans or change
derived indices. Its log,
PID and latest progress snapshot are retained in the same receipt.

Warehouse Maven test, verify and quality gates, both Helm charts, Compose
validation, mapping synchronization, shell syntax and diff checks passed.
Workspace `npm run verify` passed: 409 tests, 4 skipped, zero failures, including
a held S3 listing that must not block a completed shard's points or the next
Scanner Job. The earlier Aladin browser suite passed all 11 scenarios.

Warehouse S3/local fixture scans and the Asset scan all succeeded and wrote
ACTIVE layers. Workspace local FITS and remote MinIO caller smoke tests both
reported PASSED. The fixture and Asset smoke suites as a whole retain their
existing external Gaia MOC discovery failure, `DiscoveryTlsError` against CDS
through the configured proxy. This does not prevent the four real CSST MOCs
above from being generated locally.

The private implementation receipt is
`/tmp/csst-quality-implementation-20261103-ih175mv8`; its pointer is
`/tmp/csst-quality-implementation-path`. It contains the original worktree
diffs, image and deployment receipts, source-sample identities, validation
logs, private manifests and progress snapshots. Never print credential data,
raw headers or complete source object paths from that receipt.
