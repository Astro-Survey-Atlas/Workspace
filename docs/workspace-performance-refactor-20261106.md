# Workspace local lightweight refactor

Updated 2026-11-06. Implementation active, baseline `6c99df0`.

## Accepted scope

Workspace API + one local scan worker + owned ES + local SQLite. Local execution
supports local and S3/OSS input, CSV/FITS; Assets public packages stay read-only.
Workflow, Agent, CLI and cutout downloads use the same commands. Remove Warehouse
runtime integration, duplicate scanners, compatibility routes and PostgreSQL.
Warehouse and Assets remain unchanged.

## Work and acceptance

- [x] Stop Workspace dispatch and suspend the two running Workspace Scanner Jobs.
- [x] Verify both Jobs have active=0 and no Workspace scanner Pod is running.
- [x] Add durable pause shared between API/worker, tested across restart.
- [x] Stop loading/replaying the 1.2 GB statistics checkpoint for the UI.
- [ ] Restore API with pause enforced and verify submissions are rejected.
- [ ] Separate API and scanner entrypoints; all enumeration runs in the worker.
- [ ] Unify scan submission, status, pause/resume/cancel/retry, with file checkpoints.
- [ ] Use local persistent storage for metadata and ES; retain old volumes.
- [ ] Consolidate file/position/footprint indexes and committed scan visibility.
- [ ] Move mutable control state to SQLite; evidence/artifacts remain referenced.
- [ ] Remove Warehouse and obsolete runtime/config/test paths.
- [ ] Update UI/CLI, make pause/progress/failure/download outcomes explicit.
- [ ] Verify isolated CSV/FITS/S3 fixtures, HEALPix queries and Workflow downloads.
- [ ] Run builds, service/browser tests and Docker/Helm validation.

Production scanning remains paused. Tests use isolated fixtures. Rotate only
recoverable state/configuration backups, retaining the latest three; retain
scientific evidence and referenced artifacts. Performance targets: control API
p95 <=300 ms, 2,000 point warm query p95 <=1 s and cold <=3 s; report measurements
rather than assuming migration achieved them.

## Operational receipts

Private directory `/tmp/workspace-lightweight-refactor-20261106/` retains the
pre-change Deployment and Job descriptions. User data and evidence must survive
migration. No secret values should be printed or copied into this document.
