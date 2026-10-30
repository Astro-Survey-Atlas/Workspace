# Dev scan status audit, October 29

Read-only observations around 10:20–10:27 Asia/Shanghai. Workspace is Helm
revision 109, with one Ready Pod and zero restarts. No new scan, retry, inventory
refresh, repair, index write or deployment was submitted for this audit.

## Inventory growth and published scans

Two reads of `/api/data-statistics` distinguish the counters:

| Counter | First read, 02:20 UTC | Second read, 02:25 UTC |
| --- | --- | --- |
| Accessible files | 1,900,163 | 1,903,122 |
| Accessible known source bytes | 219,422,595,782,403 | 219,702,175,490,700 |
| Published scanned files | 661,182 | 661,182 |
| Published scanned known source bytes | 118,424,028,772,800 | 118,424,028,772,800 |
| Cumulative logical workload files | 725,182 | 725,182 |
| Cumulative logical workload source bytes | 149,991,880,432,552 | 149,991,880,432,552 |

Accessible and current scanned totals are partial. Source file sizes are not
transferred or physically read bytes. The cumulative workload counts logical
work and is not a unique published data total.

Inventory refresh `ec424a2e-f122-4ba2-b978-85c1662c7967` is running at 7/12
Connectors, listing CSST deep v1 metadata. It reached 1,694,515 processed objects
at the second read. Current scanned was last published October 28 at 05:24 UTC;
cumulative workload last changed October 28 at 09:01 UTC.

All 310 historical Connector runs are terminal: 193 succeeded and 117 failed,
including parent batches, child partitions and previous attempts. There are
zero queued/running runs and zero active Scanner Jobs. Retained Kubernetes Jobs
contain 20 successes and 10 failures; these are not the full historical roster.

## Assets and actual data point queries

`/api/data-assets/status` reports 18 assets: six ready, six not started, five
failed and one empty. Direct read-only `/api/sky/points/query` calls used an
explicit asset scope, all 12 O0 cells and `limit: 1` for each asset. All 18
queries returned HTTP 200 with a reachable index; seven returned records and
11 returned zero. No point indexing task is active.

| Asset | Point records returned by the query count | Publication state |
| --- | ---: | --- |
| CSST Simulation W1 | 356,112 | Ready |
| CSST deep v1 | 246,456 | Ready |
| CSST wide v2 | 58,608 | Ready |
| Bounded CSST validation asset | 4,000 | Ready; overlaps existing validation source files |
| Downloaded Euclid Q1 color imaging | 5 | Ready |
| HST local download | 2 | Ready |
| COSMOS 170W CSV | 1,720,500 | Failed scan; partial indexing evidence, no published coverage |

Image points represent image centers/pointings, not detected catalog sources.

COSMOS exposes a read-model inconsistency: the asset status reports
`dataPointCount: 0` and `dataPointStatus: failed`, while the point query returns
1,720,500 objects. The status endpoint counts only `skyDataPoints`; the query
endpoint reads both the object index and sky data point index. The Workspace
CSV scan failed October 28 at 11:22 UTC with
`No usable coverage geometry was found in the selected source files`.
Existing indexed rows must not be described as a successfully published scan.

## Incomplete scans

| Asset | Evidence |
| --- | --- |
| CSST deep v2 | Parent batch failed with `database is locked`; 83 frozen shards, 21 submitted, 62 unsubmitted. Latest child per partition: 19 succeeded, two failed, totaling 38,000 successful files out of 164,304. No point extraction was submitted. |
| Euclid shared-data FITS | Parent batch failed with `database is locked`; 50 frozen shards, 48 submitted, two unsubmitted. Nine latest child partitions succeeded (18,000 files), 39 failed. Errors include more than 64 HDUs, missing spatial position and missing explicit RA/DEC axes. No point extraction was submitted. |
| MaNGA ssy DRP | All six partitions failed; gzip FITS WCS extraction unsupported by the deployed scanner. |
| MaNGA ssy2 | All 53 partitions failed; explicit celestial axes, header extraction and gzip FITS errors. |
| LOFAR HEALPix mosaics | All six partitions failed; deployed WCS reader supports TAN and rejects this projection. |
| COSMOS CSV | Existing rows indexed, coverage generation failed; see the count mismatch above. |

The deep v2 parent progress is stale (`17 completed`, `two active`); children
subsequently finished after the parent failed. The table uses latest child
records and the durable `batch.json` manifest, not that stale counter. The
latest child can make the asset status appear `empty`/`succeeded` despite its
failed parent. Root cause of SQLite locking is not established by this audit.

Six assets are metadata inventory registrations, including HDF5/Arrow archives
and shared archive roots. They have no submitted scientific scan and zero
points. Public Resource Packages supply public coverage geometry; their
activation does not ingest full survey catalogs into Workspace.

Priority follow-up is to diagnose SQLite locking and preserve/reuse successful
shards when recovering deep v2, address format-specific scanner failures, and
reconcile asset point counts and parent-batch status with the query model.

## Evidence

Private receipts remain outside Git under
`/tmp/workspace-scan-audit-20261029-rw404kv9/`:

- `statistics.json` and `statistics-after.json`
- `assets.json`, `statuses.json`, `runs.json`, `mocs.json`
- `check-points.py` and `point-query-receipt.json`

Kubernetes snapshots are
`/tmp/workspace-scan-status-jobs-20261029.json` and
`/tmp/workspace-scan-status-pods-20261029.json`.
