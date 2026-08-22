# Astro Data Workspace

An astronomy-focused data workspace built around a deterministic-first rule:
catalog parsing, coordinate validation, HEALPix indexing, and rendering data are
computed by tested TypeScript. MCP exposes those capabilities to agents; an LLM
is not part of the data-processing path.

Atlas is the user-facing workspace. It can:

1. Register user assets with local, S3/OSS, JDBC, or other access metadata.
2. Scan local files in Atlas and optionally submit remote user scans to the
   data-warehouse plugin.
3. Compute user coverage through the pinned Assets MOC Core adapter.
4. Display and download public coverage only from verified Assets Resource
   Package v3 snapshots.
5. Keep user survey/release labels, assets, connectors, scan history, indexes,
   workflows, and Agent/MCP state local to Atlas.
6. Select sky regions and inspect public package layers alongside user assets.

The shared operator/workspace invocation and troubleshooting runbook is in the
sibling checkout at
`/home/aaron/Repo/data-warehouse/docs/astro-metadata-scan-runbook.md`.

The current Atlas boundary, task-isolation, and notification implementation plan
is frozen in [`docs/atlas-boundary-plan.md`](docs/atlas-boundary-plan.md). It
overrides older Atlas-side descriptions when they differ; this repository does
not modify the data-warehouse checkout or the shared scan CRD schema.

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

## Local deployment

The official Compose configuration runs SQLite with the warehouse disabled.
Application state, workflow runs, and installed resource packages are kept in
the named `state` volume. The container runs as UID/GID `10001`, has a read-only
root filesystem, drops all capabilities, disallows privilege escalation, and
uses a tmpfs for `/tmp`.

The local data contract is one controlled parent directory mounted read-only at
`/data/local`. To enable it, copy the example override and set the host
directory before starting Compose:

```bash
cp compose.local.example.yaml compose.local.yaml
ASTRO_LOCAL_DATA_ROOT=/srv/astro-data docker compose -f compose.yaml -f compose.local.yaml up -d
```

The parent directory must already exist. With Docker on Linux, UID/GID `10001`
needs search (`x`) permission on every parent directory and read/search (`r-x`)
permission on the mounted tree. The application does not write to this mount;
state writes go to the named volume. `create_host_path: false` intentionally
makes a missing host directory a configuration error.

On SELinux-enabled Linux hosts, a bind mount can also require an SELinux label.
Use the Compose `:z` option for a directory shared by containers, or `:Z` for a
private directory, according to the host policy; do not disable SELinux to make
the mount work. The host directory still needs normal Unix permissions.

Docker Desktop on macOS and Windows runs Linux containers in a VM. The selected
host directory must be allowed in Docker Desktop file sharing, and the path
must use the syntax supported by the local Docker client (for example an
absolute macOS path or `C:/data/astro` on Windows). Desktop-managed sharing and
the VM's UID mapping can differ from native Linux, so verify the container's
read-only access with the health and connector checks.

When the Docker daemon is remote, bind sources are resolved on the daemon host,
not on the machine running the Compose command. Set `ASTRO_LOCAL_DATA_ROOT` to
a path on that host, or use a storage export mounted there. The directory must
exist on the daemon host because automatic creation is disabled.

Adding or removing a child directory below the mounted parent does not require
an image rebuild or container recreation. Changing the parent directory does
require recreating the service so the bind source is replaced, for example:

```bash
ASTRO_LOCAL_DATA_ROOT=/new/astro-data docker compose -f compose.yaml -f compose.local.yaml up -d --force-recreate
```

Local connectors support registration, non-enumerating existence/readability
checks, explicit CSV scans, and scan history. The mounted parent remains
read-only; Atlas writes only metadata and derived indexes to its state store.

## Data catalog

The default tab is the data foundation. Public coverage and release metadata
come from the synchronized Assets Resource Package v3 catalog; Atlas no longer
ships a second public catalog. User records are stored at
`ASTRO_DATA_CATALOG_STATE` (default `/state/data-catalog.json`) and support
create, update, and delete without copying source rows into this service.

Each record identifies an optional survey and release, a product, modality,
format, connector kind, logical or physical URI, availability state, and zero
or more footprint references. These survey/release values are Atlas-local user
metadata and may not exist in the installed Assets package. An optional
data-warehouse connector can consume this access description together with a
refined MOC selection; credentials remain outside catalog records. Connector
associations use normalized location keys so a path upsert does not orphan an
asset.

## Survey registry and release footprints

The survey explorer consumes public survey/release metadata from the installed
Assets Resource Package v3 records through a read-only public view. The Atlas
SurveyRegistry remains a separate local namespace for user labels and releases;
an Euclid or CSST label does not need a matching public package.
Each release records modalities, products, availability, and a footprint
provenance status. HST is represented as a MAST archive snapshot rather than a
fictional DR sequence.

Each MOC is attached to one release and product. The explorer renders each
survey union in a separate display-only shell; the shell radius is not a proxy
for redshift, distance, survey depth, photometric limit, magnitude, or
wavelength. A connected selection of `NSIDE 16` cells can be expanded into a
local, per-survey stack for visual comparison. The stack preserves coverage
membership and provenance only; it is not a radial data cube. Hovering a cell
shows its survey, release, product, modalities, geometry quality, and source.
The active package list is whatever the trusted Assets catalog advertises. It
contains geometry artifacts and provenance, never catalog rows or image pixels.
The exact source and processing rules are documented in
[`docs/public-footprint-moc-method.md`](docs/public-footprint-moc-method.md).

Only a MOC/HEALPix footprint may drive regional release discovery. Entries
marked `summary_only` retain an official area or field summary, while `pending`
explicitly means that no spatial geometry has been claimed yet. In particular,
the DESI DR1 spectroscopic footprint remains pending until its official
tile/product artifact is ingested; the application does not substitute Legacy
imaging or local COSMOS data for it.

### Public footprint artifacts

The public-footprint release is owned by the sibling `Astro-Survey-Atlas-Assets`
repository. Atlas runtime reads only a verified Assets Resource Package v3
catalog and its local `assets-current` snapshot. Atlas does not retain a second
public footprint ledger or a fallback package set. Old generated packages and
rollback material are not startup inputs, are not scanned, and are not part of
the active catalog.

Public package generation, geometry extraction, trust validation, and release
publication are performed in `Astro-Survey-Atlas-Assets`. Atlas only downloads,
verifies, installs, and displays the resulting v3 packages.

## Interfaces

The maintained request and response contract is in
[`docs/api-reference.md`](docs/api-reference.md). Update it together with the
route implementation and tests whenever an API changes.

MCP tools:

- `list_user_assets`
- `get_user_asset`

REST endpoints:

- `GET /api/data-assets`
- `GET /api/data-assets/:id`
- `POST /api/data-assets`
- `PUT /api/data-assets/:id`
- `DELETE /api/data-assets/:id`
- `GET /api/surveys`
- `GET /api/surveys/:id`
- `GET /api/public-surveys`
- `GET /api/public-surveys/:id`
- `GET /api/survey-footprints`
- `GET /api/sky/overview?survey=euclid&release=euclid-q1&nside=16&cells=...`
- `POST /api/sky/query`
- `GET /api/sky/coverage?nside=16&assetIds=...` (generic scanned-asset coverage)
- `POST /api/surveys/registrations`
- `GET /api/connectors/:id/scan-runs`
- `GET /api/connectors/scan-runs`
- `GET /api/tools`
- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflow-runs`
- `GET /api/workflow-runs/:id`
- `POST /api/workflow-runs/:id/decisions`
- `GET /api/workflow-runs/:id/artifacts/:name`
- `POST /api/agent/sessions`
- `POST /api/agent/sessions/:id/messages`

Local scans run in Atlas and use the pinned Assets MOC Core adapter for
authoritative coverage. An optional data-warehouse plugin handles remote S3/JDBC
reads; it remains a user-asset execution path and never publishes public
coverage. Remote requests can point at a connector prefix or child path and
declare catalog coordinates without exposing credentials:

```json
{
  "assetId": "my-user-catalog",
  "path": "projects/astro/catalogs/sample.csv",
  "allowedSuffixes": [".csv"],
  "spatial": {
    "mode": "catalog",
    "raColumn": "ra",
    "decColumn": "dec",
    "frame": "ICRS",
    "units": "deg"
  }
}
```

The scanner records files without valid coordinates as metadata-only; it does
not invent a footprint from the path or filename. `backend: flink` is an
optional data-warehouse execution detail and is not a public coverage API.

Catalogs that already carry NESTED HEALPix pixels can instead use
`"mode": "healpix"` with `"healpixColumn": "hpix"`. The resulting document
uses `coverage_method=catalog_healpix_nested` and is eligible for the generic
project-sky coverage layer. `"mode": "auto"` tries RA/Dec first and then
falls back to `hpix` / `healpix_pixel` aliases when those coordinates are not
present.

The user-asset coverage endpoints return only indexed Atlas data and never
expose a source filesystem path.

## k3s deployment

`deploy/k3s.yaml` deploys the current image tag into the isolated
`astro-data-workspace` namespace. The Pod is pinned to `eva7028`; compact catalog
metadata and derived indexes live in a 128 MiB `nfs-data` PVC backed by
`/mnt/data`, mounted read-only by the service. Workspace state uses a separate
256 MiB NFS PVC. Workflow metadata, 20-row previews, and exports capped at
1,000 rows use the same state PVC. Runtime operation does not require an
OSS/rclone mount.

The Ingress host is:

```text
astro.workspace.dev.72602.space
```

The cluster ingress controller is currently exposed through NodePort `32080`, so
the LAN URL is:

```text
http://astro.workspace.dev.72602.space:32080/
```

The application Service is also exposed directly through NodePort `32082` for
VSCode port forwarding or direct node access. It maps node port `32082` to the
container's HTTP port `3000`:

```bash
kubectl -n astro-data-workspace get svc astro-data-workspace-mcp
kubectl -n astro-data-workspace port-forward svc/astro-data-workspace-mcp 32082:3000
```

When forwarding from a remote VSCode session, forward local port `32082` to
`astro-data-workspace-mcp` in namespace `astro-data-workspace` on service port
`3000`. The Ingress NodePort `32080` remains available separately.

The Ingress rule is configured for the new host. The DNS record for
`astro.workspace.dev.72602.space` must point at the reachable node address;
this deployment does not modify the `dev` namespace, its services, or the
cluster Ingress controller.

Build and apply:

```bash
docker build \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-data-workspace-mcp:0.10.38-20260821-atlas-cleanup4 .

podman push \
  crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-data-workspace-mcp:0.10.38-20260821-atlas-cleanup4

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
