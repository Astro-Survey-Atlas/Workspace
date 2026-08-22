# Astro Data Workspace Helm chart

The chart deploys the core workspace API with persistent application metadata.
The default is embedded SQLite on a `ReadWriteOnce` PVC. The data warehouse is
disabled by default, so the core application, installed Assets Resource
Package coverage, Connector metadata, and user assets do not require Flink or
a warehouse service.

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
is mounted at `/data/local` and the Deployment emits
`ASTRO_LOCAL_CONNECTOR_ROOTS=/data/local`. The chart does not create a PV or
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

## Warehouse integration

Set `dataWarehouse.enabled=true` to emit Flink and Elasticsearch environment
variables and create the ServiceAccount, Role, and RoleBinding used to inspect
and manage warehouse resources. Those objects and settings are absent from the
default rendering.
