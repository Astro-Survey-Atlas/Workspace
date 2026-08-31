# Astro Data Workspace Helm chart

The chart deploys the core workspace API with persistent application metadata
and its own Elasticsearch. The default is embedded SQLite plus a bundled
single-node Elasticsearch on persistent volumes. The optional data warehouse is
disabled by default, so the core application, installed Assets Resource
Package coverage, Connector metadata, and user assets do not require a
Warehouse installation.

## Metadata stores

`metadataStore.mode` must be one of `sqlite`, `bundled-postgresql`, or
`external-postgresql`.

```bash
helm install workspace ./charts/astro-data-workspace
helm install workspace ./charts/astro-data-workspace \
  --set metadataStore.mode=bundled-postgresql \
  --set postgresql.enabled=true
helm install workspace ./charts/astro-data-workspace \
  --set metadataStore.mode=external-postgresql \
  --set metadataStore.external.existingSecret=workspace-database
helm install workspace ./charts/astro-data-workspace \
  --set search.mode=external \
  --set elasticsearch.enabled=false \
  --set search.external.existingSecret=workspace-search
```

The external Secret must contain a complete PostgreSQL URL under `database-url`
by default. Set `metadataStore.external.existingSecretKey` to use another key.
The bundled PostgreSQL dependency is installed only when
`postgresql.enabled=true`; its generated application-user password is read from
the dependency Secret and is not stored in chart values.
When supplying `postgresql.auth.existingSecret`, its application-user password
key must match `postgresql.auth.secretKeys.userPasswordKey` (`password` by
default).

The dependency archive and `Chart.lock` are vendored for reproducible source
installs. Run `helm dependency build charts/astro-data-workspace` when updating
or verifying the dependency.

## Controlled local data mount

`localData` is disabled by default. When enabled, exactly one read-only source
is mounted at `/data/local`. The Deployment always reserves the writable
`/state/coverage-downloads` root for files downloaded from a sky-overlap
result, and emits it in `ASTRO_LOCAL_CONNECTOR_ROOTS` alongside `/data/local`.
The chart does not create a PV or
PVC for local data; `existingClaim` must refer to a claim managed separately.

Choose one source in a values file:

```yaml
localData:
  enabled: true
  existingClaim: local-data
  nfs:
    server: ""
    path: ""
  hostPath:
    path: ""
    type: Directory
  nodeSelector: {}
```

For direct NFS use a non-empty `nfs.server` and absolute `nfs.path`, leaving the
other source fields empty. For node-local storage use an absolute
`hostPath.path` and `type: Directory`; `hostPath` cannot be `/`, contain dot
segments, or be combined with another source. `nodeSelector` is copied to the
Pod when supplied, which is required when a host path exists on only selected
nodes. Unknown fields, partial NFS settings, non-string selectors, and source
combinations are rejected by both the values schema and template guards.

The persistent application state remains on `/state`. Workflow runs use
`/state/workflow-runs`, and installed resource packages use
`/state/resource-packages`.

## Workspace search (always on)

Workspace owns the search data plane independently from Warehouse. With the
default `search.mode=bundled`, the chart installs a persistent single-node
Elasticsearch and injects `ASTRO_ES_URL`; the `astro_file_index_v1`,
`astro_object_index_v1`, and `astro_coverage_index_v1` indices are reserved for
Workspace user files, objects, coverage, and MOC projections. Set
`search.mode=external`, `elasticsearch.enabled=false`, and provide
`search.external.existingSecret` when a separately managed Elasticsearch should
be used. This search service remains
required when Warehouse is disabled and is never replaced by Warehouse's
`ast_*` indices.

The post-install/post-upgrade `search-init` hook waits for Elasticsearch,
reconciles the three mappings, and verifies the fields required by the query
adapters. It has `before-hook-creation` cleanup, so a Helm upgrade reruns the
check after a mapping or image change. The one-shot Job in `deploy/k3s.yaml`
has the same reconciliation responsibility; because Kubernetes Job pod
templates are immutable, remove its completed
`astro-data-workspace-search-init` object
before reapplying that static manifest after changing the script or mappings.

## Warehouse integration

Set `dataWarehouse.enabled=true` to let Workspace submit the namespaced
Warehouse `ScanRequest` contract and read the optional Warehouse `ast_*`
indices. The Warehouse endpoint is independent from Workspace's own
`ASTRO_ES_URL`; configure either `dataWarehouse.elasticsearch.url` or an
existing Secret containing the complete URL under `elasticsearch-url` by
default.

If that URL contains URL-encoded Basic Auth credentials, Workspace removes them
from the submitted ScanPlan endpoint and places them in the per-scan Secret;
the scanner receives only `ATLAS_WAREHOUSE_USERNAME` and
`ATLAS_WAREHOUSE_PASSWORD` references. Credentials never appear in the
ScanRequest, plan ConfigMap, evidence, or browser response.

The chart creates a shared `ReadWriteMany` evidence PVC unless
`dataWarehouse.evidence.existingClaim` is supplied. The API Pod mounts this
claim at `dataWarehouse.evidence.mountPath`, and the same claim/mount path is
sent in each ScanRequest so completed evidence can be imported into the
Workspace user-MOC artifact store. The Workspace ServiceAccount can manage only
Secrets and `ScanRequest` resources in its own release namespace; it has no
permissions in the Warehouse namespace.

The Warehouse Operator must watch the Workspace release namespace (for example,
`WATCH_NAMESPACES=atlas-warehouse,astro-data-workspace`). Warehouse may keep its
Elasticsearch in `atlas-warehouse`, but the ScanRequest, source Secret and
evidence Claim are namespace-local to Workspace. The canonical task labels are
`atlas.zhejianglab.org/track-caller=workspace` with
`track-task-kind=user-scan` or `user-coverage`; Assets uses the same keys with
`track-caller=assets` and `track-task-kind=public-coverage`.

On a successful local or remote user scan, Workspace stores a validated
`moc.fits`, `query-order8.json`, `preview-order4.json`, provenance and hashes
under `/state/user-mocs`, then exposes the metadata through `/api/user-mocs` and
merges the ready projection into `/api/sky/coverage`. Evidence and normalized
scan files stay on the evidence PVC/object store and are not included in the
browser's initial request.

Install into the Workspace namespace when enabling the integration:

```bash
helm install workspace ./charts/astro-data-workspace \
  --namespace astro-data-workspace --create-namespace \
  --set dataWarehouse.enabled=true \
  --set dataWarehouse.elasticsearch.url=http://atlas-warehouse-elasticsearch.atlas-warehouse.svc.cluster.local:9200
```
