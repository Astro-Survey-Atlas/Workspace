# Architecture

## Product boundary

Astro Data Workspace is not a general data catalog and is not a general-purpose
code agent. It owns the astronomy-specific layer between registered data and an
analysis workspace:

```text
connector -> deterministic scan -> astronomy profile -> exploration API
                                                   -> MCP tools
                                                   -> sky / radial volume
                                                   -> workflow runs / Agent
```

Generic connector scheduling, secrets, and enterprise metadata can be integrated
later. They are not reimplemented in this service.

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

## Workflow control plane

`ToolRegistry` contains both local deterministic functions and bounded MCP
adapters. `WorkflowDefinition` validates a versioned acyclic graph before it is
registered. A `WorkflowRun` records step state, duration, tool summaries,
explicit human decisions, and artifact hashes independently from `ScanRun`.
The two run types join through SHA-256 lineage rather than mutable paths.

The first plugin, `euclid-desi-crossmatch@1`, queries the real
`euclid-q1-mer-final` and `desi-dr10-tractor` catalogs, normalizes ICRS fields,
performs nearest-neighbor spherical matching, pauses for filtering, and exports
at most 1,000 rows. A failed MCP request or incomplete catalog schema is a
terminal failure; production execution has no synthetic-coordinate fallback.
The Agent entry point uses a deterministic Chinese/English rule interpreter.
LLM capability remains disabled until a namespace-local secret is configured.

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
- Metadata storage: dedicated NFS PVC backed by `/mnt/data`, read-only in the service Pod
- Source policy: original FITS/images remain external; runtime stores only compact profiles and indexes
- Runtime state: dedicated NFS PVC
- Public route: dedicated Ingress host
- No dependency on the `dev` namespace or old viewer database

## Next stages

1. Register deterministic dataset scanning and volume drill-down as workflow tools.
2. Add a connector contract for FITS tables, Parquet, TAP, HTTP, and object storage.
3. Complete source fingerprints for the legacy multi-survey atlas.
4. Replace the fixed sparse levels with a revisioned adaptive active frontier.
5. Add selection functions and completeness maps before interpreting occupancy as physical density.
6. Enable optional LLM intent enhancement with a namespace-local secret while retaining the rule interpreter.
