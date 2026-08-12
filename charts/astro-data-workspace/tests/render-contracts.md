# Chart render contracts

Build dependencies before running the checks:

```bash
helm dependency build charts/astro-data-workspace
helm lint charts/astro-data-workspace
helm template workspace charts/astro-data-workspace
helm template workspace charts/astro-data-workspace \
  --set metadataStore.mode=bundled-postgresql \
  --set postgresql.enabled=true
helm template workspace charts/astro-data-workspace \
  --set metadataStore.mode=external-postgresql \
  --set metadataStore.external.existingSecret=workspace-database
helm template workspace charts/astro-data-workspace \
  --set dataWarehouse.enabled=true
```

The default output must include a Deployment, Service, and PVC, with
`ASTRO_METADATA_STORE=sqlite` and `ASTRO_SQLITE_PATH=/state/workspace.sqlite`,
and must not contain Flink environment
variables, warehouse RBAC, or a ServiceAccount. Bundled PostgreSQL output must
include the dependency's resources and construct `ASTRO_DATABASE_URL` from its
Service and generated Secret. External PostgreSQL output must read the complete
`ASTRO_DATABASE_URL` from the configured existing Secret and must not include
the bundled dependency. Invalid mode/dependency combinations must fail schema
validation and the template guards. All modes must retain the legacy JSON paths
on `/state` for one-time migration.
