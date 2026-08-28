# Chart render contracts

Build dependencies before running the checks:

```bash
# When Helm is not installed locally, use the pinned validation image instead:
podman run --rm -v "$PWD:/work:ro" -w /work \
  docker.io/alpine/helm:3.18.4 lint charts/astro-data-workspace

helm dependency build charts/astro-data-workspace
helm lint charts/astro-data-workspace
helm template workspace charts/astro-data-workspace --namespace astro-data-workspace
helm template workspace charts/astro-data-workspace --namespace astro-data-workspace \
  --set metadataStore.mode=bundled-postgresql \
  --set postgresql.enabled=true
helm template workspace charts/astro-data-workspace --namespace astro-data-workspace \
  --set metadataStore.mode=external-postgresql \
  --set metadataStore.external.existingSecret=workspace-database
helm template workspace charts/astro-data-workspace --namespace astro-data-workspace \
  --set search.mode=external \
  --set elasticsearch.enabled=false \
  --set search.external.existingSecret=search-secret
helm template workspace charts/astro-data-workspace --namespace astro-data-workspace \
  --set dataWarehouse.enabled=true \
  --set dataWarehouse.elasticsearch.url=http://atlas-warehouse-elasticsearch.atlas-warehouse.svc.cluster.local:9200
helm template workspace charts/astro-data-workspace --namespace astro-data-workspace \
  --set localData.enabled=true \
  --set localData.existingClaim=local-data
helm template workspace charts/astro-data-workspace --namespace astro-data-workspace \
  --set localData.enabled=true \
  --set localData.nfs.server=nas.example.test \
  --set localData.nfs.path=/exports/astro
helm template workspace charts/astro-data-workspace --namespace astro-data-workspace \
  --set localData.enabled=true \
  --set localData.hostPath.path=/srv/astro \
  --set 'localData.nodeSelector.kubernetes\.io/hostname=node-a'
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
`ASTRO_LOCAL_CONNECTOR_ROOTS=/data/local`; disabled output must contain neither.
Invalid local-data source combinations and a hostPath type other than
`Directory` must fail schema validation and template guards. When
`dataWarehouse.enabled=true`, output must contain only namespaced Workspace
RBAC, a shared evidence PVC/mount, and `ASTRO_WAREHOUSE_*` variables; it must
not contain `ASTRO_FLINK_*`, the old metadata CRD, or a Role/RoleBinding in
another namespace.
