# Astro Data Workspace

An astronomy-focused data workspace built around a deterministic-first rule:
catalog parsing, coordinate validation, HEALPix indexing, and rendering data are
computed by tested TypeScript. MCP exposes those capabilities to agents; an LLM
is not part of the data-processing path.

The current vertical slice can:

1. Register a local CSV below an explicitly allowed data root.
2. Profile schema, scalar types, nulls, row count, and circular RA/Dec coverage.
3. Build cached nested HEALPix summaries at NSIDE 8, 32, 128, and 512.
4. Build a deterministic DESI-COSMOS redshift volume from a FITS `SPECZ` HDU.
5. Expose catalog and volume artifacts through MCP and a read-only REST API.
6. Explore the full redshift sample in an exterior Three.js cutaway sphere.
7. Maintain a curated telescope/survey/release registry for Euclid, DESI, SDSS, GALEX, Legacy Surveys, HSC-SSP, HST, and user-registered sources.
8. Drill through sparse NESTED HEALPix-by-radius cells with conserving refinement.
9. Record reproducible scan runs, content fingerprints, artifact checksums, and transitive lineage.
10. Register deterministic tools and versioned workflow DAGs with persistent run state.
11. Execute `euclid-desi-crossmatch@1` through a rule-based Agent and an explicit human filter gate.
12. Maintain a deployment-bundled data catalog plus persistent user data registrations for future connectors.

The viewer and API do not depend on `cosmos-data-linkage`, its PostgreSQL
database, or its Aladin viewer. The old service is only a read-only acceptance
reference for the COSMOS catalog.

## Development

The authoritative checkout is:

```text
zjlab-ubuntu:/home/aaron/Repo/astro-data-workspace
```

Run the complete deterministic validation on Linux:

```bash
npm ci --registry=https://registry.npmmirror.com
npm run validate
```

For separate server and viewer development:

```bash
npm run dev
npm run dev:viewer
```

The Vite development server proxies `/api` to `http://127.0.0.1:3000`.

## Redshift volume

The FITS preprocessing step runs offline. It filters high-quality galaxies,
converts `BEST_Z` to Planck18 comoving distance, and writes a versioned
`manifest.json` plus little-endian `points.bin` artifact:

```bash
python3 scripts/build_redshift_volume.py \
  --input /path/to/DESI-COSMOS-v2.0.fits \
  --output /path/to/derived/desi-cosmos-v2
```

Set `ASTRO_VOLUME_ROOT` to the parent derived-data directory. The server only
reads the compact artifacts; it never opens the 1.45 GB FITS file at startup.
Each successful preprocessing run also writes `scan-run.json`. Source identities
use `urn:sha256:` values, so the public API does not disclose absolute server paths.

## Data catalog

The default tab is the data foundation. Built-in catalog metadata lives in
`bootstrap/catalogs.json` and is copied into the application image, so it moves
with the deployment and does not depend on a runtime CDS, OSS, or MCP request.
Built-in records are read-only. User records are stored separately at
`ASTRO_DATA_CATALOG_STATE` (default `/state/data-catalog.json`) and support
create, update, and delete without copying source rows into this service.

Each record identifies an optional survey and release, a product, modality,
format, connector kind, logical or physical URI, availability state, and zero
or more footprint references. A future data-warehouse connector can consume
this access description together with a refined MOC selection; credentials
remain outside catalog records.

## Survey registry and release footprints

The survey explorer is a low-frequency coverage registry, not a live data scan.
Each survey card aggregates its releases (for example, SDSS DR1 through DR19),
and each release records modalities, products, availability, and a footprint
provenance status. HST is represented as a MAST archive snapshot rather than a
fictional DR sequence.

Each MOC is attached to one release and product. The explorer renders each
survey union in a separate display-only shell; the shell radius is not a proxy
for redshift, distance, survey depth, photometric limit, magnitude, or
wavelength. A connected selection of `NSIDE 16` cells can be expanded into a
local, per-survey stack for visual comparison. The stack preserves coverage
membership and provenance only; it is not a radial data cube. Hovering a cell
shows its survey, release, product, modalities, geometry quality, and source.
The bundled compact catalog includes available MOC artifacts for GALEX GR6/GR7,
Legacy Surveys DR10, SDSS DR9 imaging, HSC-SSP PDR2, HST archive discovery, and
an explicitly labelled official Euclid Q1 field overview. It contains no
catalog rows or image pixels.

Only a MOC/HEALPix footprint may drive regional release discovery. Entries
marked `summary_only` retain an official area or field summary, while `pending`
explicitly means that no spatial geometry has been claimed yet. In particular,
the DESI DR1 spectroscopic footprint remains pending until its official
tile/product artifact is ingested; the application does not substitute Legacy
imaging or local COSMOS data for it.

Rebuild the bundled metadata artifact explicitly when sources change:

```bash
npm run build:footprints
```

The existing atlas remains a local COSMOS reference and the DESI radial-index
input for the joint-volume prototype. It is not a global survey-footprint
registry.

The legacy atlas preprocessor creates a local COSMOS angular reference plus a
DESI redshift volume index. It is retained for the joint-volume prototype and
must not be used to infer release-level global coverage:

```bash
npm run build:atlas -- \
  --output /path/to/derived/cosmos-multisurvey-v1 \
  --membership-csv /path/to/hst_acs_selected.csv \
  --desi-csv /path/to/desi_cosmos_ra_dec_id.csv \
  --volume-manifest /path/to/desi-cosmos-v2/manifest.json \
  --volume-points /path/to/desi-cosmos-v2/points.bin
```

Run the reproducible point-scan versus sparse-index benchmark with
`npm run benchmark:atlas`. Set `ASTRO_ATLAS_ROOT` to the derived-data parent;
it may be the same directory as `ASTRO_VOLUME_ROOT`.

## Interfaces

MCP tools:

- `register_local_csv`
- `list_datasets`
- `get_dataset_profile`

REST endpoints:

- `GET /api/datasets`
- `GET /api/data-assets`
- `GET /api/data-assets/:id`
- `POST /api/data-assets`
- `PUT /api/data-assets/:id`
- `DELETE /api/data-assets/:id`
- `GET /api/surveys`
- `GET /api/surveys/:id`
- `GET /api/survey-footprints`
- `POST /api/surveys/registrations`
- `GET /api/datasets/:id/sky/summary`
- `GET /api/datasets/:id/sky/cells?nside=128`
- `GET /api/datasets/:id/sky/objects?offset=0&limit=50000`
- `GET /api/volumes`
- `GET /api/volumes/:id`
- `GET /api/volumes/:id/points.bin`
- `GET /api/atlases`
- `GET /api/atlases/:id`
- `GET /api/atlases/:id/angular-cells.bin`
- `GET /api/atlases/:id/joint?survey=desi&nside=32&radialBins=8`
- `GET /api/atlases/:id/refinement?survey=desi&nside=32&radialBins=8&pixel=6814&radialBin=1`
- `GET /api/atlases/:id/objects?survey=desi&nside=32&pixel=6814&radialBins=8&radialBin=1&offset=0&limit=500`
- `GET /api/scan-runs`
- `GET /api/scan-runs/:id`
- `GET /api/lineage/:artifactId`
- `GET /api/tools`
- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflow-runs`
- `GET /api/workflow-runs/:id`
- `POST /api/workflow-runs/:id/decisions`
- `GET /api/workflow-runs/:id/artifacts/:name`
- `POST /api/agent/sessions`
- `POST /api/agent/sessions/:id/messages`

The cell-object endpoint lazily builds and reuses a server-side index for the
requested angular/radial level. The REST representation never exposes a source
filesystem path.

## k3s deployment

`deploy/k3s.yaml` deploys version `0.9.1` into the isolated
`astro-data-workspace` namespace. The Pod is pinned to `eva7028`; compact catalog
metadata and derived indexes live in a 128 MiB `nfs-data` PVC backed by
`/mnt/data`, mounted read-only by the service. Registry state uses a separate
256 MiB NFS PVC. Workflow metadata, 20-row previews, and exports capped at
1,000 rows use the same state PVC. Runtime operation does not require an
OSS/rclone mount.

The Ingress host is:

```text
astro.agent.dev.72602.online
```

The cluster ingress controller is currently exposed through NodePort `32080`, so
the LAN URL is:

```text
http://astro.agent.dev.72602.online:32080/
```

The DNS and Ingress route are active. This deployment does not modify the `dev`
namespace, its services, or the cluster Ingress controller.

Build and apply:

```bash
docker build \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t docker.io/library/astro-data-workspace-mcp:0.9.1 .

kubectl apply -f deploy/k3s.yaml
kubectl -n astro-data-workspace rollout status deployment/astro-data-workspace-mcp
```

Run a real-catalog acceptance check when the catalog MCP and its Elasticsearch
backend are healthy:

```bash
npm run smoke:workflow-real
```

The check discovers coordinates from the real Euclid index unless
`ASTRO_SMOKE_RA` and `ASTRO_SMOKE_DEC` are supplied. It fails explicitly on
zero matches or external service errors and never inserts fixture coordinates.

See [docs/architecture.md](docs/architecture.md) for boundaries and the next
implementation stages.
