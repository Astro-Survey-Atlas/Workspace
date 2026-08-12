# Astro Data Workspace Helm chart

The chart deploys the core workspace API with persistent application metadata.
The default is embedded SQLite on a `ReadWriteOnce` PVC. The data warehouse is
disabled by default, so the core application, public coverage, manual
footprints, connector metadata, and user assets do not require Flink or a
warehouse service.

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

## Warehouse integration

Set `dataWarehouse.enabled=true` to emit Flink and Elasticsearch environment
variables and create the ServiceAccount, Role, and RoleBinding used to inspect
and manage warehouse resources. Those objects and settings are absent from the
default rendering.
