# Architecture

## Product boundary

Astro Data Workspace is a project-facing astronomy workspace, not a general
data platform or a general-purpose code agent. It has two deliberate entry
points:

- the 3D sky is a project-status view for public coverage, acquired assets,
  processed results, deliverables, and known gaps;
- the data workspace is the production view for registered paths, provenance,
  and reproducible astro-code tasks.

The product owns the astronomy-specific layer between registered data and an
analysis workspace:

```text
connector -> deterministic scan -> astronomy profile -> exploration API
                                                   -> MCP tools
                                                   -> sky / radial volume
                                                   -> workflow runs / Agent
```

The public catalog records what a survey/release covers and where a product can
be obtained. It does not mirror every public archive. Generic connector
scheduling, secrets, and enterprise metadata can be integrated later; they are
not reimplemented in this service.

The workspace is authoritative for its catalog, coverage evidence, ownership
associations, and user-visible query state. `data-warehouse` is an optional,
replaceable execution provider: Flink task submission and status polling must
never gate workspace startup, catalog queries, official coverage rendering, or
inspection of previously recorded local state. When the executor or its
derived Elasticsearch index is unavailable, the workspace reports that local
verification is unavailable or stale; it does not reinterpret official
coverage as absent and does not make unrelated views fail.

Each logical data asset may have several project-stage facets and access
locations. For example, a public Euclid release can be both `public_reference`
and `acquired` when a local or S3 mirror is registered. Official source URLs,
connector locations, and project-side metadata are editable from the asset
detail view; built-in catalog entries use persistent overrides so the bundled
public metadata remains reproducible. Connector registration stores only
S3/OSS, local-path, and JDBC configuration plus a credential reference. Its
normalized scan path is the business identity, so registration upserts an
existing path. The UI can perform a non-enumerating endpoint/path check, while
FlinkIngest scan history is kept separately and associated with that path. Raw
secrets remain outside this service.

## Deterministic data plane

The data plane is testable without an LLM:

- path authorization and canonicalization;
- CSV parsing and type inference;
- circular RA coverage and Dec validation;
- nested HEALPix indexing;
- density-cell geometry and source pagination;
- FITS `SPECZ` filtering and Planck18 comoving-distance conversion;
- versioned radial-volume manifests and a tested binary point format;
- content-addressed scan runs and transitive artifact lineage;
- cached HEALPix-by-radius object lookup with count reconciliation against the sparse index;
- JSON registry persistence.

MCP is an adapter over this plane. Agent reasoning may select tools and interpret
results, but it does not calculate catalog coordinates or indexes.

### Spatial evidence v1

Every scanned file is eligible for the project sky only when the scanner can
explain its position from the file content or explicitly declared catalog
fields. The first stable contract accepts:

- CSV/TSV/TXT catalogs with ICRS RA/Dec columns in degrees, radians, or
  hour-angle units;
- CSV/TSV/TXT catalogs with NESTED HEALPix pixels at the configured order,
  including the standard `hpix` and `healpix_pixel` aliases in automatic mode;
- FITS image headers with a linear or TAN WCS that can be sampled into ICRS
  NESTED HEALPix cells.

These records are written to `astro_file_index_v1` with a method, role, frame,
and HEALPix cells. Files without valid evidence remain searchable metadata with
`spatial_status=unknown` or `failed`; they are never assigned a footprint from
their filename, path, survey label, or asset name. MOC files, FITS binary-table
coordinates, and non-ICRS frames are deliberate later extensions rather than
silent guesses.

## Workflow control plane

`ToolRegistry` contains both local deterministic functions and bounded MCP
adapters. `WorkflowDefinition` validates a versioned acyclic graph before it is
registered. A `WorkflowRun` records step state, duration, tool summaries,
explicit human decisions, and artifact hashes independently from `ScanRun`.
The two run types join through SHA-256 lineage rather than mutable paths.

The first production action, `euclid-desi-crossmatch@1`, queries the real
`euclid-q1-mer-final` and `desi-dr10-tractor` catalogs, normalizes ICRS fields,
performs nearest-neighbor spherical matching, pauses for filtering, and exports
at most 1,000 rows. A failed MCP request or incomplete catalog schema is a
terminal failure; production execution has no synthetic-coordinate fallback.
The Agent entry point uses a deterministic Chinese/English rule interpreter.
LLM capability remains disabled until a namespace-local secret is configured.

## Persistence and service boundaries

The JSON files on the runtime PVC are prototype persistence. They are useful
for a single replica and deterministic tests, but they are not the long-term
source of truth for a multi-user workspace. The production boundary is:

```text
workspace API
  |-- PostgreSQL: assets, public sources, connectors, access locations,
  |               tags, lineage edges, scan/task records, audit timestamps
  |-- MinIO/S3:   MOC/HEALPix artifacts, scan manifests, cutouts, exports,
  |               package bundles, Agent task artifacts
  |-- Elasticsearch: searchable FITS/header/object metadata produced by scans
  |-- data-warehouse: FlinkIngestTask and scan execution
  `-- Agent worker: cross-match/cutout/package orchestration and status updates
```

PostgreSQL is the authoritative metadata store. Elasticsearch is a derived
search index and must be rebuildable from scan manifests; it must not own
Connector or data-card identity. MinIO stores bytes, not mutable card metadata.
Built-in public cards are seeded read-only records with a version, while user
cards and overrides are ordinary PostgreSQL rows. A normalized Connector path
remains unique, so an upsert cannot create duplicate scan targets.

Flink execution status is observational workspace data, not a dependency
health gate. Polling is best-effort and asynchronous. An unreachable Kubernetes
API preserves the last recorded task state, and a failed task affects only its
own scan record. Core asset and coverage APIs continue to use workspace-owned
metadata; optional joint-atlas and radial-volume artifacts likewise cannot
block the project-sky view.

Connector credentials remain Kubernetes Secrets and are referenced by an
internal identifier only. When a scan is submitted, the workspace service
creates or synchronizes a task-scoped Secret in the `warehouse` namespace and
submits a `FlinkIngestTask`; the UI never needs to know the Secret name. The
task record stores the Connector path, requested prefix/MOC, Flink resource
identity, and status, but never stores raw keys.

The existing PostgreSQL instance in the `database` namespace belongs to an
unrelated application and uses its own `n8n` database. It should not be reused
without an explicit owner-approved database and role. The first production
step is therefore a dedicated workspace database (or a separate schema and
role provisioned by its owner), followed by a dual-write migration from the
JSON registry. The workspace API remains the only component allowed to mutate
metadata; Agent, Flink, and indexers report through bounded APIs/events.

The next production actions are intentionally narrow and ordered: `cutout`
reads registered image paths and emits object-centered crops, then `package`
combines the cross-match table, image products, and quality metadata into a
downstream training/evaluation bundle. They are product contracts first and are
not exposed as fake generic workflow steps until the astro-code adapters exist.

## Sky representations

The viewers use one spherical coordinate contract in ICRS:

| Representation | Purpose | Current source |
| --- | --- | --- |
| Coverage | Find where a dataset exists | Circular RA/Dec bounds |
| Density | Compare occupied regions | Nested HEALPix counts |
| Objects | Inspect individual rows | Valid RA/Dec source rows |
| Radial volume | Inspect 3D large-scale structure | RA/Dec plus Planck18 comoving distance |
| Survey layers | Compare registered surveys and modalities | HEALPix occupancy on artificial display radii |
| Joint cells | Drill into angular and radial structure | Sparse NESTED HEALPix x radial intervals |

The default Three.js viewer uses a perspective camera outside the largest shell.
Orbit controls cannot cross the 1.15-radius boundary. Concentric shells expose a
72-degree cutaway around the COSMOS direction, while all 161,518 galaxies are
drawn by one `BufferGeometry` and shader material. The original internal sky
viewer remains available in source but is not the default route.

The default multi-survey shell view uses radii that are semantic display
offsets and never enter scientific distance calculations. The physical mode
uses spherical frustum cells whose volume is `solid_angle / 3 * (r1^3-r0^3)`.
Direction and radius refine independently; child counts must equal the parent
before a replacement is accepted.

## Provenance contract

Offline preprocessors write a `scan-run.json` beside each derived artifact. A
run records SHA-256 source identities, byte sizes and modification times, the
deterministic filter/configuration, producer version and code hash, output
checksums, and explicit `derived_from` edges. Atlas inputs include the redshift
volume manifest and binary hashes, so lineage traversal reaches the original
FITS source without relying on mutable file paths.

## Isolation

- Namespace: `astro-data-workspace`
- Workload node: `eva7028`
- Metadata storage: JSON prototype on a dedicated NFS PVC; PostgreSQL is the planned production store
- Source policy: original FITS/images remain external; runtime stores only compact profiles and indexes
- Runtime state: dedicated NFS PVC
- Public route: dedicated Ingress host
- No dependency on the `dev` namespace or old viewer database

## Next stages

1. Provision an owner-approved workspace PostgreSQL database and migration role.
2. Add repository interfaces and dual-write/read-back for assets, connectors, access locations, and lineage.
3. Connect selected HEALPix/MOC masks to data-warehouse scan and download jobs.
4. Implement the astro-code `cutout` adapter against registered image paths.
5. Implement the astro-code `package` adapter and persist derived asset lineage.
6. Index scan outputs into Elasticsearch and retain rebuildable manifests in MinIO.
7. Complete source fingerprints for the legacy multi-survey atlas.
8. Add selection functions and completeness maps before interpreting occupancy as physical density.
9. Enable optional LLM intent enhancement with a namespace-local secret while retaining the rule interpreter.

The fine HEALPix refinement view remains an advanced retrieval control. It is
useful when a selected region would produce too much data, but it is not the
main project narrative and does not add another visual highlight layer.
