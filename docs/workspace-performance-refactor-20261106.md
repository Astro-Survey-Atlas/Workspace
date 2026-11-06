# Workspace local lightweight refactor

Updated 2026-11-06. Runtime migrated and deployed at Helm revision **150**,
image `0.0.1-dev-20261106-lightweight-r5`. Source baseline `6c99df0`; the release
includes uncommitted working-tree changes.

## Accepted scope

Workspace API + one local scan worker + owned ES + local SQLite. Local execution
supports local and S3/OSS input, CSV/FITS; Assets public packages stay read-only.
Workflow, Agent, CLI and cutout downloads use the same commands. Remove Warehouse
runtime integration, duplicate scanners, compatibility routes and PostgreSQL.
Warehouse and Assets remain unchanged.

The API stores scan commands. The independent worker freezes inventory, checks
source versions, reads files in bounded batches and checkpoints progress. SQLite
holds control state; full science attributes use compressed evidence chunks.
ES stores positions, files and image footprints. Positions, file references,
MOC and refresh must all succeed before publishing a new generation. Failures or
pauses preserve the prior publication.

Removed active paths include Warehouse submission/evidence ingestion, Kubernetes
scan dispatch, PostgreSQL, duplicate executors, the statistics replay worker,
old browser preference formats and the direct production-file approval bypass.
Historical audit records and the explicit one-time migration are retained.
Public-catalog startup uses the validated local cache; remote sync is explicit.

## Work and acceptance

- [x] Stop Workspace dispatch and suspend the two running Workspace Scanner Jobs.
- [x] Verify old Jobs have active=0; the independent worker remains idle while paused.
- [x] Add durable pause shared between API/worker, tested across restart.
- [x] Stop loading/replaying the 1.2 GB statistics checkpoint for the UI.
- [x] Restore API with pause enforced and verify submissions return 409 after restart.
- [x] Separate API and scanner entrypoints; all enumeration runs in the worker.
- [x] Unify scan submission, status, pause/resume/cancel/retry, with file checkpoints.
- [x] Use local persistent storage for metadata and ES; retain old volumes.
- [x] Consolidate file/position/footprint indexes and committed scan visibility.
- [x] Move mutable control state to SQLite; evidence/artifacts remain referenced.
- [x] Remove Warehouse and obsolete runtime/config/test paths.
- [x] Update UI/CLI, make pause/progress/failure/download outcomes explicit.
- [x] Verify isolated CSV/FITS/S3 fixtures, HEALPix queries and Workflow downloads.
- [x] Run builds, service tests, Docker/Helm validation and desktop smoke.
- [ ] Complete the final browser interaction acceptance and record the result.

Production scanning remains paused. Tests use isolated fixtures. Rotate only
recoverable state/configuration backups, retaining the latest three; retain
scientific evidence and referenced artifacts. Performance targets: control API
p95 <=300 ms, 2,000 point warm query p95 <=1 s and cold <=3 s; report measurements
rather than assuming migration achieved them. The measurements below meet these
targets in the acceptance samples.

## Migration and storage

API, worker and search share node `zjlab-ubuntu`. New `local-path` claims:
`asa-workspace-state-local` (20 GiB), `asa-workspace-search-local` (30 GiB).
The downloader retains its deployment and production-data volume.

| Data | Verified result |
| --- | ---: |
| Positions, `astro_position_index_v2` | 3,019,111 |
| File records, `astro_file_index_v2` | 1,298,611 |
| Image footprints, `astro_image_footprint_index_v2` | 1,298,579 |
| Assets / published assets / Connectors | 23 / 12 / 22 |
| Workflow / Agent / production records | 5 / 10 / 4 |
| Scientific evidence | 746 files; 6,149,925,910 bytes; all SHA-256 match |
| Checked control and artifact files | 264 files; 26,405,504 bytes; all SHA-256 match |
| SQLite after cutover | 12,263,424 bytes |
| Catalog snapshots in the new runtime | 3 |

Original NFS state, evidence, production and ES claims remain. Old Helm-managed
state/evidence/production claims have `helm.sh/resource-policy: keep`. Connector
credential references were migrated to a private local file (0600), with original
Secrets retained. Scientific evidence and Workflow outputs never rotate with
configuration backups. The obsolete statistics checkpoint was not copied.

All real scanning stays paused: zero queued/running scans, three paused records,
both old Jobs suspended. The r4→r5 API/worker restart retained this state. Old
Jobs remain history; the worker does not dispatch them. Old-format tasks require
a new explicitly submitted local scan rather than replay of the old executor.

## Measured query and download behavior

Measurements use the public Dev URL and existing science data. Earlier samples
come from revision 148; these short acceptance runs do not establish sustained
load capacity or long-duration availability.

| Operation | Before, revision 148 | After, local runtime |
| --- | ---: | ---: |
| Original 2,000-point COSMOS request | 15.382 s | 0.157 s first after API restart; ES warm |
| Same request, 20 warm samples | Variable, including timeouts | p50 132.21 ms; p95 153.74 ms |
| Same request after ES restart | Earlier cold samples 16–18 s | 1.334 s, measured on r4 |
| Control APIs, 60 requests | No comparable p95 recorded | p95 13.34 ms |
| W2 HEALPix 2071 region query | 16.310 s W2 sample | 0.294 s; 2,000 real points |
| W2 real-point anchor | Could time out | 24.4 ms |
| 215-FITS ZIP, 19,355,601 bytes | 74.136 s | 0.960 s |
| Single historical FITS | — | 6.3 ms |

The 2,000-point payload is 620,598 bytes JSON / 125,431 bytes gzip, with cursor
pagination and `totalRelation="gte"`; exact totals remain opt-in. References and
identity/provenance account for part of this payload. The cutover establishes
latency improvement, not a further payload reduction from November 5's compact
response. Full point attributes are retrieved on demand from evidence chunks.

Published user coverage derives from cells containing real points, including W2
pixel 2071. Original image-extent MOCs remain evidence. Empty-filter history still
succeeds with cutout skipped; ZIP download returns 400 because no archive exists.
The successful historical ZIP has 215 FITS and 219 total entries; all 218 file
checksums match.

An idle/query sample: API 9 millicores / 128 MiB, worker 1 millicore / 46 MiB,
ES 12 millicores / 1,767 MiB, downloader 12 millicores / 206 MiB. This is not a
peak-load capacity claim. API/worker control state no longer uses NFS; historical
source/output files can still reside on retained remote volumes.

## Validation and monitoring

`npm run verify` passed: 340 tests, 337 passed, three skipped, zero failures;
server, Viewer and CLI builds, types, Helm lint and templates passed. The isolated
worker integration also passed using the image's fixed real Python/MOC Core
dependencies: CSV, FITS table/image, S3, source changes, failures, retry, pause,
restart, PIXSCAL quality skips and all-rejected runs preserving publication.
Desktop `prepare:server` and `smoke` passed. Catalog-cache startup tests verify
zero startup requests against a stalled remote endpoint.

Telemetry follows `.tmp/WORKSPACE_REQUIREMENTS.md`: API `asa-workspace`, worker
`asa-workspace-scanner`, OTLP HTTP/protobuf, `parentbased_always_on`, logs to
stdout. Accepted/skipped/failed file counts and bytes are recorded at committed
batch boundaries, including failed runs. IDs/science contents are not metric
labels. Exporters are configured; inspected startup logs contain no export errors.
No real scans or LLM calls were created just for monitoring acceptance.

## Operational receipts

Private directory `/tmp/workspace-lightweight-refactor-20261106/` retains the
pre-change Deployment and Job descriptions. User data and evidence must survive
migration. It also contains final values, rollout, tests and live measurements.
Search and evidence-copy receipts also live in
`/home/aaron/.cache/workspace-refactor-20261106/`. No secret values belong in this
document. See [migration procedure](workspace-metadata-migration.md) for retained
claims and the Helm 4 cutover detail.

The cutover does not claim the separate year-end goals of two real researcher
trials, long-duration availability, a published v1.0 release, or FITS PNG/JPEG
previews. Scanning remains paused until explicitly resumed. Local-path storage
uses one node; retained old volumes provide audit/recovery, not a live replica.
