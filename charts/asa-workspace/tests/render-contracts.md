# Chart render contracts

Build dependencies before running the checks:

```bash
# When Helm is not installed locally, use the pinned validation image instead:
podman run --rm -v "$PWD:/work:ro" -w /work \
  docker.io/alpine/helm:3.18.4 lint charts/asa-workspace

helm dependency build charts/asa-workspace
helm lint charts/asa-workspace
helm template workspace charts/asa-workspace --namespace asa-workspace
helm template workspace charts/asa-workspace --namespace asa-workspace \
  --set metadataStore.mode=bundled-postgresql \
  --set postgresql.enabled=true
helm template workspace charts/asa-workspace --namespace asa-workspace \
  --set metadataStore.mode=external-postgresql \
  --set metadataStore.external.existingSecret=workspace-database
helm template workspace charts/asa-workspace --namespace asa-workspace \
  --set search.mode=external \
  --set elasticsearch.enabled=false \
  --set search.external.existingSecret=search-secret
helm template workspace charts/asa-workspace --namespace asa-workspace \
  --set dataWarehouse.enabled=true \
  --set dataWarehouse.elasticsearch.url=http://atlas-warehouse-elasticsearch.atlas-warehouse.svc.cluster.local:9200
helm template workspace charts/asa-workspace --namespace asa-workspace \
  --set localData.enabled=true \
  --set localData.existingClaim=local-data
helm template workspace charts/asa-workspace --namespace asa-workspace \
  --set localData.enabled=true \
  --set localData.nfs.server=nas.example.test \
  --set localData.nfs.path=/exports/astro
helm template workspace charts/asa-workspace --namespace asa-workspace \
  --set localData.enabled=true \
  --set localData.hostPath.path=/srv/astro \
  --set 'localData.nodeSelector.kubernetes\.io/hostname=node-a'
helm template workspace charts/asa-workspace --namespace asa-workspace \
  --set productionData.enabled=true
helm template workspace charts/asa-workspace --namespace asa-workspace \
  --set productionData.enabled=true \
  --set dataWarehouse.enabled=true \
  --set dataWarehouse.elasticsearch.url=http://atlas-warehouse-elasticsearch.atlas-warehouse.svc.cluster.local:9200
helm template workspace charts/asa-workspace --namespace asa-workspace \
  --set productionData.enabled=true \
  --set productionData.existingClaim=shared-production-data
```

The default output must include a Deployment, Service, PVC, and bundled
Workspace Elasticsearch, with `ASTRO_METADATA_STORE=sqlite`,
`ASTRO_SQLITE_PATH=/state/workspace.sqlite`, `ASTRO_ES_URL` pointing at that
bundled service, and `ASTRO_DATA_WAREHOUSE_ENABLED=false`. It must not contain
Warehouse environment variables or Workspace warehouse RBAC. Bundled PostgreSQL output must
include the dependency's resources and construct `ASTRO_DATABASE_URL` from its
Service and generated Secret. External PostgreSQL output must read the complete
`ASTRO_DATABASE_URL` from the configured existing Secret and must not include
the bundled dependency. Invalid mode/dependency combinations must fail schema
validation and the template guards. All modes must retain the legacy JSON paths
on `/state` for one-time migration. Local data output must contain exactly one
source volume at `/data/local`, a read-only mount, and
`ASTRO_LOCAL_CONNECTOR_ROOTS=/data/local:/state/coverage-downloads`; disabled
output must omit the `/data/local` source volume and retain only the writable
`ASTRO_LOCAL_CONNECTOR_ROOTS=/state/coverage-downloads` root for overlap
downloads.
Invalid local-data source combinations and a hostPath type other than
`Directory` must fail schema validation and template guards. When
`dataWarehouse.enabled=true`, output must contain only namespaced Workspace
RBAC, a shared evidence PVC/mount, and `ASTRO_WAREHOUSE_*` variables; it must
not contain `ASTRO_FLINK_*`, the old metadata CRD, or a Role/RoleBinding in
another namespace.
Production-data output must create a PVC named `<release>-production-data`
labelled `atlas.zhejianglab.org/scanner-source=true` with `ReadWriteMany`,
mount it writable at `productionData.mountPath`, and emit
`ASTRO_COVERAGE_DOWNLOAD_ROOT`/`ASTRO_PRODUCTION_DATA_MOUNT` equal to that
mount plus `ASTRO_LOCAL_CONNECTOR_ROOTS` containing it; disabled output must
omit the PVC, mount, and variables. With `dataWarehouse.enabled=true` it must
also emit `ASTRO_WAREHOUSE_LOCAL_CLAIM` and
`ASTRO_WAREHOUSE_LOCAL_SCANNER_MOUNT`; a `mountPath` that is not a strict
subpath of `scannerMountPath`, access modes without `ReadWriteMany`, or
combining `existingClaim` with `storageClass` must fail the guards. The state
PVC must never carry the scanner-source label.
