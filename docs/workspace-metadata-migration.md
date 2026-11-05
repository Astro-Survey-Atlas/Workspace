# Workspace Metadata Migration

This runbook moves the Workspace metadata tables from SQLite to PostgreSQL.
It does not move files or state stored under `/state`, including Workflow runs,
artifacts, resource packages, user MOCs, or connector payloads. Keep the existing
state volume mounted after switching databases. Scanner enablement also requires
the shared state volume to provide `ReadWriteMany`; PostgreSQL alone is not
sufficient.

The migration tool copies `connectors`, `data_assets`, `connector_ingest_runs`,
`survey_identities`, `statistics_snapshots`, `statistics_entries`, and
`import_markers`. It checks the SQLite schema version and integrity, refuses a
source with SQLite WAL sidecars, copies in batches inside one PostgreSQL
transaction, checks row counts, and records the source hash and counts to prevent
accidental imports from a different source.

## Before the Window

1. Provision an empty PostgreSQL database and a Workspace database URL. Keep the
   URL in the approved secret manager or a restricted process environment; do
   not place it in shell arguments, values files, logs, or tickets.
2. Take a recoverable snapshot of the Workspace state volume and PostgreSQL
   storage. Record the current Helm values and SQLite database path.
3. Keep `scanner.enabled=false`. Confirm the planned PostgreSQL schema is not
   already used by a live Workspace deployment.
4. Run the commands from a Workspace checkout with Node.js 22.15 or later and
   the repository dependencies installed. The SQLite file must be readable from
   that host, such as through a maintenance mount of the existing state PVC.

## Maintenance Window

1. Stop all Workspace processes that can write metadata, including the API and
   any scanner process. Do not start another Workspace instance against either
   store during the copy.
2. Checkpoint SQLite after writers have stopped. If `workspace.sqlite-wal` or
   `workspace.sqlite-shm` remains, do not remove it by hand; use SQLite's
   checkpoint/journal-mode tools, close all SQLite handles, and confirm the
   sidecars are gone. The migration script intentionally stops when either file
   exists.
3. Set `ASTRO_DATABASE_URL` and optionally `ASTRO_DATABASE_SCHEMA` in the
   restricted environment. The default schema is `astro_workspace`. Set
   `ASTRO_SQLITE_PATH` to the stopped source database before previewing and
   applying the copy.
4. Create the target schema and tables without copying application records:

   ```bash
   npm run migrate:metadata:postgres -- --prepare-target
   ```

5. Preview the source hash and row counts, and confirm the target is empty and
   ready:

   ```bash
   npm run migrate:metadata:postgres
   ```

   Proceed only when the output has `readyToApply: true` and the source counts
   match the expected maintenance snapshot. A non-empty target is not merged.
6. Apply the copy:

   ```bash
   npm run migrate:metadata:postgres -- --apply
   ```

   The command prints the schema, source hash, and row counts, but never the
   database URL or record contents. A successful apply verifies all table counts
   before committing the transaction.
7. Configure Helm with `metadataStore.mode=external-postgresql` or
   `metadataStore.mode=bundled-postgresql`, keep the previous state PVC mounted,
   and start one Workspace instance. Check readiness and read-only access to
   Connectors, assets, and statistics before restoring normal writes.
8. Enable Scanner only after the PostgreSQL-backed Workspace is accepted and
   the configured state PVC is confirmed `ReadWriteMany`.

If the copy fails, its data transaction rolls back. Keep Workspace stopped and
inspect the error and target counts before retrying. If the marker says the same
source was already applied, the copy completed previously. A different source
hash is rejected and needs a deliberate new empty schema.

## Rollback

Before allowing writes to the PostgreSQL-backed Workspace, a failed cutover can
be rolled back by stopping Workspace and restoring the previous SQLite mode and
state volume. Keep the original SQLite file unchanged through acceptance.

After PostgreSQL has accepted new writes, switching back to SQLite would lose
those writes. Stop and preserve both stores, then reconcile or take a new
planned migration; do not treat a Helm rollback as a data rollback.
