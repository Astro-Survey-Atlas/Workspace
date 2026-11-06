# Lightweight deployment contract

Run `npm run verify:chart`. Defaults must render exactly one API, one independent
scanner, one owned Elasticsearch, and retained local state/search PVCs. There
must be no Warehouse configuration, RBAC, initialization Job or PostgreSQL.

The worker must share the state claim, local source mounts and ES endpoint with
the API, require affinity to its node, use `asa-workspace-scanner` telemetry and
have a 1 GiB Node heap within its 1.5 GiB memory limit. The durable scan switch
starts paused. No application Pod mounts a Kubernetes Service Account token.

`replicaCount != 1`, a worker without persistent state, an external search without
an endpoint/Secret, or localData without a source must fail rendering. External
search disables bundled ES. All retained PVCs carry `helm.sh/resource-policy=keep`.

Optional downloader output requires a production-data volume and mounts the same
volume in the API and downloader. Its URL/token use an internal Service/Secret.

Telemetry includes the environment and pod resource identity, disables content
capture and exports only traces/metrics. API and scanner service names differ.
