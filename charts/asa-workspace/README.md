# Workspace deployment

The chart installs one API, one scan worker, and one single-node Elasticsearch.
The API and worker share local SQLite state on the same node. No Kubernetes API
permissions, PostgreSQL, Warehouse operator or external scanner are required.

```bash
helm install asa ./charts/asa-workspace -n asa-workspace --create-namespace
```

`scanner.paused=true` initializes the durable global pause. Restarting a worker
never resumes an interrupted run; resume the global switch and the chosen run
explicitly in Connectors or with the CLI. API submissions only create queued
records. The worker handles inventory enumeration, source version validation,
CSV/FITS processing, MOC generation, checkpoints and index writes.

Use `persistence.storageClass=local-path` and
`search.bundled.persistence.storageClass=local-path` for k3s. SQLite WAL requires
a local filesystem. The worker has required affinity to the API node. For an
existing installation, use `persistence.existingClaim` and
`search.bundled.persistence.existingClaim`; migrate before changing claims.
State and search PVCs created by this chart are retained on uninstall.

External owned search is supported using `search.mode=external` and either
`search.external.url` or `search.external.existingSecret` (key
`elasticsearch-url`). The URL may include URL-encoded basic-auth credentials;
keep credentials in the Secret. Never use Warehouse's indices as the target of
a Workspace migration.

`localData` mounts one read-only source at `/data/local`, from `existingClaim`,
`nfs`, or `hostPath`. Use top-level `nodeSelector` for node-specific data.
`productionData` optionally mounts writable download storage. The separate
aria2 downloader is enabled by `downloads.enabled=true` and shares that storage.
API and scanner must see sources at the same container paths.

Telemetry uses OTLP/HTTP to `telemetry.endpoint`. Service names are
`asa-workspace`, `asa-workspace-scanner` and `asa-workspace-downloader`.
Scientific contents are never captured by default. Scanner root spans are
`scan.run`; task trace context is linked across the queue.

See [migration instructions](../../docs/workspace-metadata-migration.md) before
upgrading an older installation. Changing `scanner.paused` does not overwrite a
pause/resume decision already stored in SQLite.
