# Scanner capacity validation, 2026-10-26

## Behavior

Connector statistics distinguish accessible source capacity, current successful
source capacity, and cumulative successful scan capacity. Accessible capacity
uses file metadata, without reading science arrays. Historical successful scans
are recovered from validated private evidence. Unmeasured and incomplete sources
remain explicitly unknown or partial; available subtotals stay visible.

Cumulative capacity uses decimal byte strings and BigInt arithmetic. An
independent logical run counts again. Retries, duplicate receipts, parent batch
rollups and restarted workers do not count a logical partition twice. A 3 PB
value is supported; no 3 PB real scan or throughput claim is made.

The durable queue freezes private checksummed NDJSON inventories of at most
2,000 files and an external roster. It starts at most two Scanner Jobs, requesting
500m CPU / 512 MiB each and limited to 1 CPU / 1 GiB. Restart recovery adopts
existing tasks. Explicit retry submits only failed shards, retaining successful
shards and frozen selection. Each logical batch uses a separate Warehouse layer
because Warehouse pins a layer to one immutable partition scope. The asset keeps
its previous complete layer until the replacement batch succeeds. Native-order
coverage is merged into a canonical private MOC, then retained image headers
automatically generate positions and footprints.

Statistics SQLite random I/O runs in a local temporary directory. Consistent
local backups are copied, fsynced and atomically renamed onto shared storage.
Opening SQLite or performing SQLite backup directly on NFS caused repeated
health failures in earlier dev candidates. Local work plus sequential durable
snapshots fixes that failure without increasing Workspace's 1 CPU / 1 GiB limit.
Idle reconciliation runs only when the successful-run set changes.

Single-snapshot totals skip a redundant window sort, complete snapshot totals
are cached by immutable snapshot IDs, and partial totals are shared only within
one published view. The same 356,112-file local snapshot produced unchanged
counts and bytes; three queries took 2.06–2.17 seconds with the former window
query and 1.00–1.07 seconds with the direct aggregate, using the same 64 MiB
SQLite cache. This is a query microbenchmark, not an end-to-end refresh speedup.

## Real evidence

Original CSST scan `ingest-ab449ed6-362d-40cc-bd73-23feb4ce0fb8`:

- 356,112 source files, 63,779,659,200,000 bytes (63.78 TB).
- The private 4.29 GB normalized evidence is streamed, never loaded as a buffer.
- An isolated local replay took 11.42 seconds with 248,422,400 bytes RSS.
  Dev recovery includes slower shared-storage snapshots and is not this timing.

Validation uses asset `user-68f0791e-b9d4-4169-9e5a-ce13096566e0`, named
`CSST bounded Scanner validation · 4000 files`, linked to the existing CSST
Connector. The original full asset and its coverage are preserved. This is a
visible validation asset; callers scanning a Connector with multiple assets must
select the intended asset explicitly.

Concurrency 1 parent `ingest-4e48d16f-d745-444e-b16c-e2063fbfe058` succeeded:

- Two shards of 2,000 files; merged private MOC ready.
- Both automatic position tasks succeeded with 2,000 points each, zero header,
  coordinate or footprint errors. Stable point IDs prevent duplicates on rescan.
- Scanner Pod intervals: 09:30:56–09:35:25 UTC (269 seconds) and
  09:36:44–09:39:41 UTC (177 seconds).
- Observed maximum Scanner metrics: 349m CPU and 146 MiB. These are sampled
  observations, not process lifetime peaks.
- Total orchestration included image pulls and Workspace upgrades; it is not a
  controlled speed comparison against the warm concurrency 2 run.

Concurrency 2 parent `ingest-342ce24b-5e04-4c58-b552-3e02883eeb20` initially
failed before reading source files because the former Workspace implementation
reused the first batch's layer with a different scope ID. Failed attempts remain
as evidence. The final implementation assigns a distinct layer and allows retry
through the Workspace API without changing the frozen inventory.

The user-facing retry button was exercised in the live browser: it returned
HTTP 202 for the same parent run. Both retry Jobs succeeded, 4,000/4,000 files,
79,068 coverage records and zero scan errors. The frozen shard hashes are
identical across the first run, failed second-run attempts and their retries.
Successful retry children are `ingest-c7e9b179-fce6-409d-b9ab-61d009ed5b0c`
and `ingest-550f8244-69c8-42a1-b3fe-1b1160bfa5f0`. Their Scanner Pod intervals
are 09:56:45–10:03:02 and 09:56:48–10:03:02 UTC, overlapping for 374 seconds.
Observed Scanner maxima were 295m CPU and 141 MiB per Pod. The shared storage,
index commits and inventory refresh were active, so this is not a controlled
concurrency speed comparison and does not demonstrate a 2x speedup.

The second merged MOC is ready, its batch layer is ACTIVE, and O8 projection has
491 cells. The real Warehouse `PARTITIONED` marker is now resolved through all
expected committed candidate pointers before being published as ACTIVE. A
regression observed the old UNKNOWN/pending mismatch before the fix. Region
reverse lookup returns the source directory through the new batch lineage,
without truncation or warnings. Both second-run automatic position tasks also
succeeded with 2,000 points and footprints each, zero header/coordinate errors.
The Workspace point query still returns exactly 4,000 points and `indexing=false`.

Cumulative successful capacity is 65,219,795,029,440 bytes / 364,118 logical
files (65.22 TB), while current physical files remain 356,118 / 63,787,066,372,800
bytes. Each independent 4,000-file scan adds 716,364,328,320 bytes; failed/retried
physical attempts add nothing. CSST current capacity remains its original
356,112 / 63,779,659,200,000 bytes. A separate linked asset with no successful
scan keeps the global current value partial, with its known subtotal visible.

## Validation and deployment

Workspace `npm run verify` passed: 382 tests, 378 passed, 4 skipped, zero failed;
server/viewer/CLI builds, type checks and Helm lint/render passed. The 42 focused
queue, submission and Warehouse query checks also passed. Browser fixtures cover
executor selection, run logs, unknown statistics, TB and PB formatting. The live
dev browser shows CSST's 63.78 TB, cumulative 65.22 TB, running inventory progress,
two successful partition records, batch logs, asset size and Connector size,
without page errors. Header Connector counters update in the statistics tab as
well. The four skips are opt-in aria2/live Assets/PostgreSQL integration checks.

Warehouse Maven test/verify/quality, both Helm lints/renders, Compose config,
mapping sync, shell syntax and diff checks passed. S3/local/MOC baseline, Assets
caller, Workspace local caller and Workspace remote caller all reported PASSED.
The actual Workspace namespace is `asa-workspace`. The first baseline fixture
used the wrong read-only claim and failed before scanning; the dedicated
self-test claim passed. No science-source permissions were changed.

Warehouse dev Operator revision 21 and Scanner use
`0.2.0-20261026-inventory-shards-r1`; Operator and MOC controller are ready.
The CRDs were upgraded with `scripts/upgrade-operator-crds.sh`.

Workspace dev release `asa` in `asa-workspace` is deployed at Helm revision
**104**, image `0.0.1-dev-20261026-parallel-scan-r9`, digest
`sha256:f99fc96f6bafcf5e2707902a1a9f3a617634f13171825b3421f0bdafd4070871`.
Pod `asa-workspace-dd64c7d48-fswhp` is ready with zero restarts; limits remain
1 CPU / 1 GiB. The image overlays compiled artifacts on the previously
validated runtime, preserving its dependencies; this is not a clean Docker
source build. Registry push and Helm rollout exited zero. Source work remains
uncommitted.

After final rollout `/healthz` returned 200 in 3 ms. The API closure check
confirmed ACTIVE coverage, 491 O8 cells, a ready merged MOC, 4,000 points,
`indexing=false`, and successful automatic header tasks with zero header or
coordinate errors. The real browser again confirmed the statistics, two
successful shards, task logs, asset and Connector sizes, and no page errors.
Recovered current and cumulative byte counts were unchanged across rollout.

The metadata inventory resumed the same refresh ID,
`32498ebe-ddd4-41d5-9366-da475771a252`, rather than starting again. At 10:21 UTC
it had processed 216,121 files with 1/5 Connectors completed and no listing
errors. Accessible capacity was 210,121 files / 19,530,643,398,923 bytes
(19.53 TB), explicitly partial. Full accessible capacity remains a background
listing; do not describe this subtotal as the source total. The recorded
processed count also includes historical reconciliation work. Sampling after
rollout observed 203–299m CPU and 342–377 MiB Pod memory while inventory was active;
these are not lifetime peaks or a controlled refresh benchmark.

Final receipts:

- `/tmp/workspace-parallel-r9-{build,push,rollout}.log` and
  `/tmp/workspace-parallel-r9-pod-receipt.log`.
- `/tmp/workspace-parallel-final-r9-verify.log` and
  `/tmp/warehouse-final-r2-static-gate.log`.
- `/tmp/workspace-csst-api-final-r9.log`,
  `/tmp/workspace-csst-final-api-receipt.json`, and
  `/tmp/workspace-r9-statistics-acceptance.json`.
- `/tmp/workspace-parallel-final-browser-r9.log` and
  `/tmp/workspace-parallel-live-ui/final-browser-receipt.json`, with screenshots
  `statistics-final.png`, `scan-batch-final.png`, `scan-logs-final.png` and
  `asset-final.png` in the same directory.
- `/tmp/workspace-accessible-statistics-final-monitor.log` for later progress;
  query `/api/data-statistics` for the current authoritative state.

Private logs, API receipts, measurements and screenshots remain under `/tmp`
and `.tmp`, outside public Assets artifacts. No Euclid download was repeated,
no full CSST coverage scan was submitted, and frozen legacy Warehouse code was
not changed.
