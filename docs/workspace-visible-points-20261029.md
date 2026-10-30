# Visible indexed points and incremental scan recovery

Date: 2026-10-29 (Asia/Shanghai).

The scan audit found real catalog rows that were queryable through the point
API but absent from the coverage page. COSMOS had 1,720,500 indexed rows while
its card showed zero. Warehouse batches deferred all position indexing until
every partition succeeded; a transient SQLite lock stopped two batches and
left their successful partitions invisible.

## Changes

- Asset counts use the same catalog and image-position indices as Aladin.
  Query failures remain unavailable/error states, rather than invented zeros.
  A real indexed coordinate anchors the new **查看数据点** action.
- When no complete MOC or ACTIVE Warehouse layer exists, a bounded server-side
  aggregation of actual indexed positions supplies occupied HEALPix cells.
  This is explicitly a temporary point preview. It does not publish a complete
  MOC, turn a failed scan into a success, or create scientific objects.
- Asset execution status follows the newest logical scan by creation time.
  A successful child cannot hide a failed or incomplete parent batch.
- Successful FITS shards immediately submit idempotent position work from
  their retained header companions. Restart also adopts successful evidence
  from failed parents. Derived indexing failures do not stop scientific scans.
- Temporary metadata locks retry without terminating a batch. Previously
  interrupted lock failures resume their frozen manifests, preserving their
  inventories, scope identities, successful shards and the two-Job global cap.
- SQLite yields during bounded lock waits for transaction boundaries and pure
  reads. Transaction callbacks are never replayed; DELETE journaling remains.
- Transient Elasticsearch bulk failures retry the identical stable IDs. Local
  scan failures retain the actual per-file error instead of replacing it with
  a generic missing-coverage error.

## Validation

The count and incremental-shard regressions failed before the fixes. Additional
tests cover partial catalog rows without coverage facts, exact asset-scoped
point queries, parent selection, restart adoption, SQLite read/write contention
and idempotent index retries. `npm run verify` passed: 394 passed, four skipped.
Six overlap slider/camera browser regressions passed.

Read-only verification against the real Dev index returned 1,720,500 COSMOS
rows and four NSIDE 16 cells: 1702, 1703, 1708 and 1709. The original failed
scan remains failed, and those real positions are exposed as a preview.

Private deployment and browser evidence is kept outside Git at
`/tmp/workspace-points-dev-20261029-npsob8qq/`. The final deployment receipt and
live browser result in that directory record the deployed revision and actual
rendered point count.

Dev is now Helm revision **111**, image
`0.0.1-dev-20261029-visible-points-r2`, pod
`asa-workspace-5bd474bfb4-vnmjn`, Ready with zero restarts. The image ID is
`sha256:d2fa37618e59a7b86b975df3b0e7c920bb7953f86132215ff2df9b215ad41425`.
The final manifest comparison verified that only the Workspace image changed;
the active Scanner Jobs retain their 500m/512Mi requests and 1 CPU/1Gi limits.

Live browser checks used a port-forward to the deployed Dev service because
the test browser's external host route returned an empty proxy 502. The public
Dev API was independently checked directly. Neither browser check mocks API
data: COSMOS rendered 1,000 real catalog positions in its initial viewport;
CSST deep v2 rendered 110 real image positions, with `indexing=true`. Both
captured actual nonempty marker canvases and no page errors.

The final all-asset point audit returned 18/18 reachable queries, nine assets
with positions and nine without. CSST deep v2 had **3,977** real indexed points
and Euclid shared-data had **626**, both still indexing. The seven previously
queryable assets retain their records. Point counts are snapshots and continue
to increase. CSST deep v2 is still 19/83 successful shards, with two failed;
the Euclid batch is still incomplete and has source-format failures. Their
partial points are usable while the retained batch work continues.

## Remaining source limitations

Metadata inventory totals describe accessible source files and known source
sizes. They do not measure bytes actually read or establish sky positions.
Six inventory-only roots have no scientific scan/coordinate result. Existing
MaNGA, ssy2 and LOFAR source-format failures remain failures; this change does
not invent coordinates or silently retry their unsupported formats.

CSST deep v2 and the Euclid shared-data batch retain failed partitions and
unsubmitted work. Their successful partitions are usable during recovery;
complete replacement coverage still requires a successful complete batch.
