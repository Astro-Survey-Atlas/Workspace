# Architecture

> 本仓库本轮边界和实施顺序以
> [`atlas-boundary-plan.md`](atlas-boundary-plan.md) 为准。本文的架构背景若
> 与冻结计划冲突，按冻结计划解释。

## Product boundary

Atlas is the user-facing workspace. It owns:

- user assets, local survey/release labels, connectors, and access metadata;
- local scanning and optional remote user scans through Warehouse;
- its own Elasticsearch search indexes, sky coverage queries, and the viewer;
- user MOC artifacts, scan/task history, and evidence references;
- deterministic Agent/MCP and workflow runs over user data.

Atlas does not own public survey jobs, public connectors, MOC publication, or a
public release catalog. It consumes only the immutable Resource Package v3
published by Astro Survey Atlas Assets. Atlas never registers a user asset with
Assets and never publishes a user record back to Assets. Its Elasticsearch is
independent from Warehouse Elasticsearch; either service may be absent without
turning the other into a shared database.

```text
Assets Resource Package v3
  -> Atlas download, validation, and local snapshot
  -> public coverage/release display and read-only downloads

Atlas local scanner
  -> MOC Core
  -> Workspace Elasticsearch + user MOC artifact store + task history

Atlas + optional Warehouse
  -> namespaced ScanRequest / ScanPlan v2
  -> Warehouse ast_* indices + evidence PVC
  -> Workspace evidence import + MOC Core
  -> Workspace Elasticsearch + user MOC artifact store + task history
```

`surveyId` and `releaseId` on user assets and Connectors are Atlas-local labels.
They may refer to Euclid, CSST W2-W4, or any other source that is not present
in the currently installed public package. A matching public package record is
never required for a user registration.

The HTTP surface keeps these namespaces separate: `/api/surveys` and its
registration routes address Atlas-local labels, while `/api/public-surveys`
only reads metadata from the installed Resource Package v3 catalog for the
public viewer. That display data never becomes a user record and never changes
an existing asset, Connector, run, artifact, or hash.

## Deterministic data plane

The data path is testable without an LLM:

- connector path authorization and canonicalization;
- CSV parsing, type inference, and circular RA/Dec validation;
- nested HEALPix indexing and object/coverage search;
- MOC Core invocation through the stable Assets adapter/CLI contract;
- Resource Package v3 archive, manifest, FITS MOC, and hash validation;
- JSON/SQLite metadata persistence and immutable task snapshots.

MCP and the Agent are adapters over this plane. They can select tools and
interpret results, but they do not implement a second WCS, HEALPix, or MOC
geometry algorithm.

### Assets Core coverage contract

Atlas passes a normalized coverage specification to the pinned
`astro_survey_moc_core` distribution. The Core owns geometry and authoritative
MOC generation. Atlas stores the returned FITS MOC, hash, order projections, and
provenance in its user artifact store and indexes.

- `fits-wcs` reads image headers and produces `image_extent` coverage;
- `catalog-radec` reads ICRS RA/Dec and produces `object_presence` coverage;
- `nested-healpix` reads declared NESTED pixels and their input order;
- `regions` and `tile-table` use the corresponding Core input adapters;
- empty or invalid inputs remain metadata-only or failed and never receive a
  footprint inferred from a filename, path, or survey label.

The normal Core contract is ICRS, NESTED, IVOA FITS MOC, `maxOrder=10`, with
query order 8 and preview order 4 derived from the authoritative output.
`coverageRole`, `dataOrigin`, `sourceTier`, version, and SHA-256 remain attached
to the stored coverage record. Public publication is outside Atlas.

## Resource Package boundary

The public resource path is deliberately narrow:

1. fetch and validate the Assets v3 catalog;
2. keep the verified catalog in `assets-snapshots/<hash>/` and atomically expose
   `assets-current`;
3. download packages on demand, verify archive size and SHA-256, and validate
   every v3 manifest file and FITS MOC;
4. activate selected release layers for the read-only public sky view.

If Assets is unavailable, a previously verified local snapshot remains usable.
With no successful snapshot, public resource endpoints return `503`; user
assets, local scans, indexes, and task history continue to work.

Atlas does not scan bootstrap catalogs, parse v1/v2 packages, or keep a second
public footprint generator. Old packages and rollback materials may remain in
an external archive, but they are not startup inputs.

## User scans and task history

Local files use the controlled read-only connector root and write derived
objects/coverage to Workspace Elasticsearch. An optional Warehouse integration
submits a `ScanRequest` with `ScanPlan` version 2 for one bounded S3 source,
reports status, reads only the Warehouse `ast_*` indices, and imports its
evidence into Workspace. Both paths retain the Connector, normalized scan
specification, Core result, coverage projection, errors, and history in Atlas.
Credentials remain in the configured secret store and are never written to
asset metadata.

Every Workspace task carries ownership labels in addition to the legacy
compatibility labels:
`atlas.zhejianglab.org/track-caller=workspace`,
`atlas.zhejianglab.org/track-task-kind=user-scan|user-coverage`, plus asset,
connector, and batch identifiers. `ConnectorIngestRun.taskKind` is local
Workspace metadata and is never sent as a CRD field. The HTTP history API has no
external run-ingest endpoint; records are created by Workspace submission paths
only. Assets uses the same tracking keys with `track-caller=assets` and
`track-task-kind=public-coverage`.

The Connector history API is the task-history surface for scans. Workflow runs
and Agent sessions have their own persistent records and artifact lineage. No
legacy redshift-volume or static survey-atlas run format is part of the runtime.

## Persistence and indexes

The workspace API is the only component that mutates Atlas metadata. SQLite is
the default local store; PostgreSQL is supported by the Helm deployment. Search
indexes are derived from scan records and can be rebuilt. Resource Package bytes
and user artifacts are kept in their configured state/package stores.

```text
Atlas API
  |-- metadata store: user assets, Connectors, survey labels, task history
  |-- Workspace Elasticsearch: file/object/coverage projections
  |-- package store: verified Assets v3 downloads and active snapshots
  |-- user MOC store: FITS MOC, order-8 query, order-4 preview, provenance
  |-- optional Warehouse: remote S3 execution, ast_* indexes, evidence
  `-- Agent/workflow store: decisions, runs, and bounded artifacts
```

Workspace Elasticsearch is required for indexed local/user exploration and is
always deployed or explicitly configured. Warehouse is observational and
asynchronous; its outage does not prevent Workspace from starting, displaying
the last local state, or serving user assets and public coverage from a verified
snapshot. Warehouse evidence is retained on its evidence PVC and never placed
in the browser's initial request.

## Workflows and Agent/MCP

`ToolRegistry` and `WorkflowRegistry` validate deterministic tool contracts and
versioned DAGs. The current Euclid x DESI cross-match workflow is an Atlas
workflow over the configured catalog MCP client; it is not a public coverage
builder and does not publish results to Assets. Agent intent parsing remains
rule-based until an explicitly configured LLM integration is enabled.

## Sky representations

The viewer uses one ICRS sky contract:

| Representation | Purpose | Source |
| --- | --- | --- |
| Coverage | Show where public or user data exists | Assets package or user scan projection |
| Density | Compare occupied regions | Nested HEALPix counts |
| Objects | Inspect rows | Valid user-source coordinates |
| Survey layers | Compare public packages and user assets | Display-only shell offsets |

Shell offsets are visual layout only and never represent distance, depth,
wavelength, magnitude, or completeness. Region selection and Aladin exploration
operate on the same public/user layer set.

## Deployment isolation

- Namespace: `astro-data-workspace`
- Runtime state: dedicated PVC or Compose state volume
- Workspace search: dedicated Elasticsearch service and persistent volume
- Local data: one controlled read-only mount when enabled
- Public package source: configured Assets v3 catalog URL
- Remote scans: optional Warehouse service account, `ScanRequest` namespace, and
  evidence PVC

Atlas has no runtime dependency on Assets management APIs, public scan jobs, or
public release mutation endpoints. The only cross-product contract is the
verified Resource Package v3, the pinned MOC Core contract, and Warehouse's
namespaced `ScanRequest`/`ScanPlan` v2 contract when remote execution is enabled.
