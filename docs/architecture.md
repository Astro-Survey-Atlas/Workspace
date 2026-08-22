# Architecture

> 本仓库本轮边界和实施顺序以
> [`atlas-boundary-plan.md`](atlas-boundary-plan.md) 为准。本文的架构背景若
> 与冻结计划冲突，按冻结计划解释。

## Product boundary

Atlas is the user-facing workspace. It owns:

- user assets, local survey/release labels, connectors, and access metadata;
- local scanning and optional remote user scans through the data-warehouse plugin;
- scan/task history, search indexes, sky coverage queries, and the viewer;
- deterministic Agent/MCP and workflow runs over user data.

Atlas does not own public survey jobs, public connectors, MOC publication, or a
public release catalog. It consumes only the immutable Resource Package v3
published by Astro Survey Atlas Assets. Atlas never registers a user asset with
Assets and never publishes a user record back to Assets.

```text
Assets Resource Package v3
  -> Atlas download, validation, and local snapshot
  -> public coverage/release display and read-only downloads

Atlas local scanner
  -> MOC Core
  -> user asset, coverage index, and task history

Atlas + optional data-warehouse plugin
  -> standard AstroDataSource / AstroMetadataScanTask
  -> MOC Core/scanner result
  -> user asset, coverage index, and Atlas task history
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

Atlas passes a normalized coverage specification to `astro_survey_moc_core`.
The Core owns geometry and authoritative MOC generation. Atlas stores the
returned manifest, hash, and projections in its user indexes.

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

Local files use the controlled read-only connector root. An optional
data-warehouse plugin executes standard S3/JDBC scans and reports status back to
Atlas. Both paths retain the Connector, normalized scan specification, Core
result, coverage projection, errors, and history in Atlas. Credentials remain
in the configured secret store and are never written to asset metadata.

Every Atlas standard task carries only Kubernetes metadata labels:
`app.kubernetes.io/managed-by=astro-atlas`,
`astro.zhejianglab.org/atlas-task=true`,
`astro.zhejianglab.org/atlas-task-kind=user_scan|user_coverage`, plus asset,
connector, and batch identifiers. `ConnectorIngestRun.taskKind` is local Atlas
metadata and is never sent as a CRD field. The HTTP history API has no external
run-ingest endpoint; records are created by Atlas submission paths only.

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
  |-- search index: file/object/coverage projections
  |-- package store: verified Assets v3 downloads and active snapshots
  |-- optional data-warehouse: remote S3/JDBC execution
  `-- Agent/workflow store: decisions, runs, and bounded artifacts
```

The optional remote executor is observational and asynchronous. Its outage
does not prevent Atlas from starting, displaying the last local state, or
serving user assets and public coverage from a verified snapshot.

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
- Local data: one controlled read-only mount when enabled
- Public package source: configured Assets v3 catalog URL
- Remote scans: optional data-warehouse service account and secret references

Atlas has no runtime dependency on Assets management APIs, public scan jobs, or
public release mutation endpoints. The only cross-product contract is the
verified Resource Package v3 and the MOC Core adapter used for user scans.
